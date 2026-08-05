/**
 * The HTTP surface, started for real.
 *
 * Proves the service binds, authenticates, and answers — the wiring I could not
 * otherwise claim anything about. It does not prove a review runs; that needs a
 * model and a repository.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { DEFAULT_HEARTBEAT } from "../ops/heartbeat.ts";
import { grantToken } from "../mcp/auth.ts";
import { Store } from "../store/store.ts";
import { TOOL_DOCS } from "../mcp/docs.ts";
import { startHttp } from "./http.ts";

let store: Store;
let close: () => void;
let base: string;
let token: string;
let otherToken: string;
let repoId: string;

const PORT = 39_517;

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
    { port: PORT, host: "127.0.0.1", heartbeat: { ...DEFAULT_HEARTBEAT, dataDir: "/tmp" } },
  );
  close = server.close;
  base = `http://127.0.0.1:${PORT}`;
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

describe("MCP surface", () => {
  it("lists the tools an agent needs to drive a review", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, token);
    const text = await res.text();

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
      expect(text).toContain(name);
    }
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
    store.enqueue("revF", "fast");
    const job = store.claimJob();
    store.finishJob(job?.id ?? 0, "failed", "the clone was last fetched 43 minutes ago — run `make mirror`");

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
