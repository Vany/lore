/**
 * The HTTP surface, started for real.
 *
 * Proves the service binds, authenticates, and answers — the wiring I could not
 * otherwise claim anything about. It does not prove a review runs; that needs a
 * model and a repository.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HEARTBEAT } from "../ops/heartbeat.ts";
import { grantToken } from "../mcp/auth.ts";
import { Store } from "../store/store.ts";
import { startHttp } from "./http.ts";

let store: Store;
let close: () => void;
let base: string;
let token: string;
let otherToken: string;

const PORT = 39_517;

beforeEach(() => {
  store = new Store(":memory:");
  const repo = store.upsertRepo("demo", "git@x:demo.git");
  const other = store.upsertRepo("other", "git@x:other.git");
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
      "knowledge_query",
      "knowledge_teach",
    ]) {
      expect(text).toContain(name);
    }
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
