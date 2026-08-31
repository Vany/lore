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

  // lore-ok[6253e066]: found by lore's own review, HIGH — an absolute path or one
  // escaping the repository (onto the shared reposRoot every tenant's mirror lives
  // under) used to reach the fan-out prompt with only a NUL-byte check standing in
  // the way. Same functions `review_start`'s own `path` is checked with.
  it("refuses a folder that escapes the repository, same as review_start's path", async () => {
    for (const bad of ["../secret", "/etc/passwd", "../../other-repo"]) {
      const { isError, body } = await callTool("refactor_start", { commit: "abc1234", folder: bad });
      expect(isError, `${bad} should have been refused`).toBe(true);
      expect(JSON.stringify(body)).toContain("must stay inside the repository");
    }
  });

  it("normalizes the stored folder the same way review_start's path is", async () => {
    const { body } = await callTool("refactor_start", { commit: "abc1234", folder: "src//store/" });
    const row = store.refactorRun(body["run_id"] as string);
    expect(row?.folder).toBe("src/store");
  });

  // lore-ok[43ba939c]: found by lore's own review, MEDIUM — no admission bound at all,
  // while RefactorWorker.dispatch fires every claimed run concurrently through the one
  // shared model-call gate. Inserted directly rather than via 16 real HTTP round trips.
  it("refuses once MAX_OPEN_REFACTOR_RUNS are already open", async () => {
    for (let i = 0; i < 16; i++) {
      store.createRefactorRun({ id: `refactor_fill_${String(i)}`, repoId, principal: "alice", commitSha: "a", folder: "." });
    }
    const { isError, body } = await callTool("refactor_start", { commit: "abc1234", folder: "." });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain("lore is full");
  });
});

describe("refactor_list", () => {
  it("lists this repository's runs, newest first, without the full suggestions", async () => {
    const { body: a } = await callTool("refactor_start", { commit: "abc1234", folder: "src" });
    const { body: b } = await callTool("refactor_start", { commit: "def5678", folder: "." });

    const { body } = await callTool("refactor_list", {});
    const runs = body["runs"] as Record<string, unknown>[];
    expect(runs.map((r) => r["run_id"])).toStrictEqual([b["run_id"], a["run_id"]]);
    expect(runs.every((r) => !("suggestions" in r))).toBe(true);
    expect(body["notShown"]).toBe(0);
  });

  // lore-ok[e6387cc0]: found by lore's own review — this used to pass raw store rows
  // straight through, so the wire spoke `id`/`commitSha` while the docs (and
  // refactor_poll's own real response) promise `run_id`/`commit`. Asserts the actual
  // field names, not just that SOME shape came back.
  it("speaks the same wire field names its own docs and refactor_poll promise", async () => {
    const { body: started } = await callTool("refactor_start", { commit: "abc1234", folder: "src/store" });
    const { body } = await callTool("refactor_list", {});
    const run = (body["runs"] as Record<string, unknown>[])[0];
    expect(run).toMatchObject({
      run_id: started["run_id"],
      commit: "abc1234",
      folder: "src/store",
      state: "queued",
      principal: "alice",
    });
    expect(run).not.toHaveProperty("id");
    expect(run).not.toHaveProperty("commitSha");
  });

  it("does not list another repository's runs", async () => {
    await callTool("refactor_start", { commit: "abc1234", folder: "." });

    const otherRepo = store.upsertRepo("other", "git@x:other.git");
    const otherToken = grantToken(store, otherRepo.id, "bob");
    const { body } = await callTool("refactor_list", {}, otherToken);
    expect(body["runs"]).toStrictEqual([]);
    expect(body["notShown"]).toBe(0);
  });

  it("maps a settled run's combiner_note and a failed run's error the same way refactor_poll does", async () => {
    const { body: started } = await callTool("refactor_start", { commit: "abc1234", folder: "." });
    const runId = started["run_id"] as string;
    store.claimRefactorRun();
    store.finishRefactorRun(runId, {
      state: "done",
      combined: false,
      combinerNote: "no usable t1 tier is configured to combine — showing the uncombined sets",
      sources: [],
    });

    const { body: started2 } = await callTool("refactor_start", { commit: "abc1234", folder: "." });
    const runId2 = started2["run_id"] as string;
    store.claimRefactorRun();
    store.finishRefactorRun(runId2, { state: "failed", lastError: "every tier failed: t2: quota exhausted" });

    const { body } = await callTool("refactor_list", {});
    const runs = body["runs"] as Record<string, unknown>[];
    const done = runs.find((r) => r["run_id"] === runId);
    const failed = runs.find((r) => r["run_id"] === runId2);
    expect(done?.["combiner_note"]).toBe("no usable t1 tier is configured to combine — showing the uncombined sets");
    expect(done).not.toHaveProperty("combinerNote");
    expect(failed?.["error"]).toBe("every tier failed: t2: quota exhausted");
    expect(failed).not.toHaveProperty("lastError");
  });

  // lore-ok[f60ebe42,c892422d]: found by lore's own review, twice — the cap used to
  // be silent while every doc claimed "every run". Inserted directly rather than via
  // 25 real HTTP round trips.
  it("says how many older runs were not shown, rather than truncating silently", async () => {
    for (let i = 0; i < 25; i++) {
      store.createRefactorRun({ id: `refactor_hist_${String(i)}`, repoId, principal: "alice", commitSha: "a", folder: "." });
    }
    const { body } = await callTool("refactor_list", {});
    expect((body["runs"] as unknown[]).length).toBe(20);
    expect(body["notShown"]).toBe(5);
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
