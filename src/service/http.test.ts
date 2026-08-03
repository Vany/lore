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
});
