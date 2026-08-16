/**
 * A SUBMIT ONLY COUNTS AS WORK IF IT MOVED THE TREE (D-114), asserted through the tool.
 *
 * D-114 restarts the round bounds when the client delivers work, so a review that is
 * being fed can outlive twelve rounds. The gate is one comparison in `review_submit` —
 * `applied !== before` — and getting it wrong removes lore's only bound: a client whose
 * submits change nothing could refill the budget for ever, each nudge buying t0 plus a
 * model tier on the shared subscriptions.
 *
 * **A NO-OP PATCH IS REAL, WHICH IS WHY THIS FILE EXISTS.** The first version of the test
 * for this lived in `ladder.test.ts` and called `clientDeliveredWork` directly — it
 * asserted the reducer and left the gate covered by nothing, which is the shape this
 * project calls worse than no test. The reachability was checked rather than assumed:
 * `git apply --recount` accepts `-a` / `+a` on a file containing `a`, exits 0, and leaves
 * the tree byte-identical. So the schema's `diff.min(1)` does not close this, and the
 * gate is load-bearing rather than defensive.
 *
 * Runs over HTTP against a REAL worktree, because the whole subject is what git did to a
 * tree — a fake `worktreeFor` would be asserting the fixture.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { grantToken } from "../mcp/auth.ts";
import { DEFAULT_HEARTBEAT } from "../ops/heartbeat.ts";
import { Store } from "../store/store.ts";
import { startHttp } from "./http.ts";

let store: Store;
let close: () => void;
let base: string;
let root: string;
let worktree: string;
let token: string;
let portSeq = 41_811;

const g = (...a: string[]) => execFileSync("git", a, { cwd: worktree, stdio: "pipe" }).toString().trim();

/**
 * The tree the WORKING TREE stands at right now.
 *
 * `write-tree` hashes the INDEX, so it must be staged first — without the `add` this
 * returned the tree as it was before any edit and the fixture, not the code, was what
 * failed. lore's own `treeHash` stages for the same reason.
 */
const treeNow = () => {
  g("add", "-A");
  return g("write-tree");
};

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await res.text();
  // The transport may answer as SSE; the payload is the last `data:` line either way.
  const line = body.includes("data:") ? (body.split("data:").pop() ?? "") : body;
  const parsed = JSON.parse(line.trim()) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (parsed.error !== undefined) throw new Error(parsed.error.message ?? "tool error");
  const text = parsed.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-submit-gate-"));
  worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: worktree, stdio: "pipe" });
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
  writeFileSync(join(worktree, "f.txt"), "a\n");
  g("add", "-A");
  g("commit", "-qm", "base");

  store = new Store(":memory:");
  const repo = store.upsertRepo("demo", "git@x:demo.git");
  token = grantToken(store, repo.id, "alice");
  store.createReview({
    id: "revGate",
    repoId: repo.id,
    principal: "alice",
    branch: "feat/x",
    intoRef: "main",
    ticket: "t",
    type: "code-arch",
    // Parked, so the submit takes the SYNCHRONOUS path and applies immediately — the
    // held path is a different seam with its own reset, at the emission boundary.
    state: "findings_ready",
    ladder: { ...initialState(), round: 5 },
  });

  const port = ++portSeq;
  base = `http://127.0.0.1:${port}`;
  ({ close } = startHttp(
    store,
    { store, worktreeFor: async () => worktree, enqueue: () => undefined, attest: async () => "lore: attested" },
    { port, host: "127.0.0.1", heartbeat: { ...DEFAULT_HEARTBEAT, dataDir: "/tmp" }, allowMetered: false },
  ));
});

afterEach(() => {
  close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * What the NEXT round would make of the ladder, which is where the signal is applied.
 *
 * `review_submit` records client work as a durable flag rather than writing the ladder,
 * because the ladder has one legitimate writer per round and three earlier versions of
 * this were each clobbered or missed in a different window. So the observable consequence
 * of a submit is what the next round takes, and this asks exactly that. It consumes, so
 * each test calls it once.
 */
const nextRoundFloor = () => {
  const ladder = store.getReview("revGate", "alice")?.ladder;
  if (ladder === undefined) return undefined;
  return store.withClientWork("revGate", ladder).workRound;
};

describe("review_submit counts work by what it did to the tree", () => {
  it("restarts the bounds when the diff actually changes something", async () => {
    writeFileSync(join(worktree, "f.txt"), "b\n");
    const after = treeNow();
    // Put it back — index and all: lore applies, lore hashes (D-40), so the worktree must
    // stand at the pre-patch state when the submit arrives and the hash the client sends
    // is the one it expects to see afterwards.
    writeFileSync(join(worktree, "f.txt"), "a\n");
    g("add", "-A");

    const out = await callTool("review_submit", {
      review_id: "revGate",
      diff: "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+b\n",
      tree_hash: after,
    });

    expect(out["status"], String(out["note"] ?? out["error"] ?? "")).not.toBe("refused");
    expect(nextRoundFloor(), "real work refills the budget at the next round").toBe(5);
  });

  /**
   * THE DEFECT THIS GATE EXISTS FOR. `git apply` takes this patch, exits 0, and leaves
   * the tree exactly as it was — so without the gate every one of these would wipe the
   * per-tier counters, advance the floor and enqueue a full round, with nothing in lore
   * left to stop it.
   */
  it("does not restart the bounds when the diff leaves the tree identical", async () => {
    const unchanged = treeNow();

    const out = await callTool("review_submit", {
      review_id: "revGate",
      diff: "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+a\n",
      tree_hash: unchanged,
    });

    expect(out["status"], String(out["note"] ?? out["error"] ?? "")).not.toBe("refused");
    expect(treeNow(), "the patch really did apply and really changed nothing").toBe(unchanged);
    expect(nextRoundFloor(), "a submit with no material must not refill the budget").toBeUndefined();
  });
});
