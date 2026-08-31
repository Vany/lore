/**
 * `refactor_start`/`refactor_poll` (D-136), over real HTTP — same reasoning as
 * `fixed-elsewhere.test.ts`: an MCP tool's contract is checked through the transport a
 * real client actually uses, not by calling the handler function directly.
 *
 * `RefactorWorker` itself is not run here — its own claim/execute logic is what
 * `store.claimRefactorRun`/`finishRefactorRun`/`recordRefactorSuggestions` already do,
 * called directly to simulate "the dispatcher finished this" without spending a real
 * model call, the same shape `fixed-elsewhere.test.ts` uses to simulate an applied diff.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantToken } from "../mcp/auth.ts";
import { DEFAULT_HEARTBEAT } from "../ops/heartbeat.ts";
import { Store } from "../store/store.ts";
import { startHttp } from "./http.ts";

let store: Store;
let close: () => void;
let base: string;
let token: string;
let repoId: string;
let portSeq = 44_811;
let savedTiers: string | undefined;

/** A config with t2/t3 marked refactor-suitable — every test here needs one to pass the door check. */
const TIERS_WITH_REFACTOR = JSON.stringify([
  { id: "t0", kind: "deterministic", stage: "fast" },
  { id: "t1", kind: "model", model: "zai-coding-plan/glm-5-turbo", stage: "fast" },
  { id: "t2", kind: "model", model: "kimi-for-coding/k3", stage: "deep", refactor: true },
  { id: "t3", kind: "model", model: "openai/gpt-5.6-terra", stage: "deep", refactor: true },
]);

const TIERS_WITHOUT_REFACTOR = JSON.stringify([
  { id: "t0", kind: "deterministic", stage: "fast" },
  { id: "t1", kind: "model", model: "zai-coding-plan/glm-5-turbo", stage: "fast" },
]);

/**
 * A thrown `Error` from a tool handler surfaces as `isError: true` with the message as
 * plain prose in `content[0].text`, not JSON — mirrors `fixed-elsewhere.test.ts`'s own
 * helper exactly, with an optional token override for the cross-repo scoping test.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  bearer = token,
): Promise<{ body: Record<string, unknown>; isError: boolean }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.includes("data:") ? (raw.split("data:").pop() ?? "") : raw;
  const parsed = JSON.parse(line.trim()) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (parsed.error !== undefined) return { body: { error: parsed.error.message ?? "tool error" }, isError: true };
  const text = parsed.result?.content?.[0]?.text ?? "{}";
  const isError = parsed.result?.isError === true;
  if (isError) return { body: { error: text }, isError: true };
  return { body: JSON.parse(text) as Record<string, unknown>, isError };
}

beforeEach(() => {
  savedTiers = process.env["LORE_TIERS"];
  process.env["LORE_TIERS"] = TIERS_WITH_REFACTOR;

  store = new Store(":memory:");
  const repo = store.upsertRepo("demo", "git@x:demo.git");
  repoId = repo.id;
  token = grantToken(store, repo.id, "alice");

  const port = ++portSeq;
  base = `http://127.0.0.1:${port}`;
  ({ close } = startHttp(
    store,
    { store, worktreeFor: async () => "/tmp", enqueue: () => undefined, attest: async () => "lore: attested" },
    { port, host: "127.0.0.1", heartbeat: { ...DEFAULT_HEARTBEAT, dataDir: "/tmp" }, allowMetered: false },
  ));
});

afterEach(() => {
  close();
  store.close();
  if (savedTiers === undefined) delete process.env["LORE_TIERS"];
  else process.env["LORE_TIERS"] = savedTiers;
});

describe("refactor_start", () => {
  it("queues a run and returns its id immediately", async () => {
    const { body, isError } = await callTool("refactor_start", { commit: "abc1234", folder: "src/store" });
    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body["state"]).toBe("queued");
    const runId = body["run_id"] as string;
    expect(runId).toMatch(/^refactor_/);

    const row = store.refactorRun(runId);
    expect(row?.repoId).toBe(repoId);
    expect(row?.principal).toBe("alice");
    expect(row?.commitSha).toBe("abc1234");
    expect(row?.folder).toBe("src/store");
    expect(row?.state).toBe("queued");
  });

  it("refuses a commit or folder containing a NUL byte, before anything is created", async () => {
    const { isError, body } = await callTool("refactor_start", { commit: "abc\x00123", folder: "src" });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain("NUL byte");
  });

  it("refuses at the door when no tier is configured for refactor suggestions", async () => {
    process.env["LORE_TIERS"] = TIERS_WITHOUT_REFACTOR;
    const { isError, body } = await callTool("refactor_start", { commit: "abc1234", folder: "." });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain("no tier is configured");
  });
});

describe("refactor_poll", () => {
  it("reports queued, then the combined result once the run finishes", async () => {
    const { body: started } = await callTool("refactor_start", { commit: "abc1234", folder: "." });
    const runId = started["run_id"] as string;

    const queued = await callTool("refactor_poll", { run_id: runId });
    expect(queued.body["state"]).toBe("queued");
    expect(queued.body["suggestions"]).toBeUndefined();

    // What RefactorWorker would do, without spending a real model call.
    store.claimRefactorRun();
    store.finishRefactorRun(runId, {
      state: "done",
      combined: true,
      sources: [{ tier: "t2", ok: true, count: 1 }, { tier: "t3", ok: true, count: 1 }],
    });
    store.recordRefactorSuggestions(runId, [
      { title: "Split the store's query surface", area: ["src/store/store.ts"], rationale: "read by different callers" },
    ]);

    const done = await callTool("refactor_poll", { run_id: runId });
    expect(done.body["state"]).toBe("done");
    expect(done.body["combined"]).toBe(true);
    expect(done.body["suggestions"]).toStrictEqual([
      { title: "Split the store's query surface", area: ["src/store/store.ts"], rationale: "read by different callers" },
    ]);
    expect(done.body["sources"]).toStrictEqual([{ tier: "t2", ok: true, count: 1 }, { tier: "t3", ok: true, count: 1 }]);
  });

  it("says why when the run did not combine, rather than leaving it ambiguous", async () => {
    const { body: started } = await callTool("refactor_start", { commit: "abc1234", folder: "." });
    const runId = started["run_id"] as string;
    store.claimRefactorRun();
    store.finishRefactorRun(runId, {
      state: "done",
      combined: false,
      combinerNote: "no usable t1 tier is configured to combine — showing the uncombined sets",
      sources: [{ tier: "t2", ok: true, count: 2 }],
    });
    store.recordRefactorSuggestions(runId, [
      { title: "a", area: ["a.ts"], rationale: "r" },
      { title: "b", area: ["b.ts"], rationale: "r" },
    ]);

    const { body } = await callTool("refactor_poll", { run_id: runId });
    expect(body["combined"]).toBe(false);
    expect(body["combiner_note"]).toContain("no usable t1");
  });

  it("carries the error when every tier failed", async () => {
    const { body: started } = await callTool("refactor_start", { commit: "abc1234", folder: "." });
    const runId = started["run_id"] as string;
    store.claimRefactorRun();
    store.finishRefactorRun(runId, { state: "failed", lastError: "every tier failed: t2: quota exhausted" });

    const { body } = await callTool("refactor_poll", { run_id: runId });
    expect(body["state"]).toBe("failed");
    expect(body["error"]).toBe("every tier failed: t2: quota exhausted");
  });

  it("refuses a run from another repository's token, same as a guessed id", async () => {
    const { body: started } = await callTool("refactor_start", { commit: "abc1234", folder: "." });
    const runId = started["run_id"] as string;

    const otherRepo = store.upsertRepo("other", "git@x:other.git");
    const otherToken = grantToken(store, otherRepo.id, "bob");

    const { body, isError } = await callTool("refactor_poll", { run_id: runId }, otherToken);
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain("not found");
  });

  it("refuses an id that was never created, the same way", async () => {
    const { body, isError } = await callTool("refactor_poll", { run_id: "refactor_nope" });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain("not found");
  });
});
