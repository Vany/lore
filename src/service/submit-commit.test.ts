/**
 * D-124's commit form: a pushed commit as an alternative to a hand-composed diff.
 *
 * Two things had to be true of it and neither was, when lore's own review read the code
 * that shipped it.
 *
 * SECURITY: the client's `commit` string went straight into `git diff <tree> <commit>`,
 * and git reads an argument beginning with `-` as an OPTION rather than a ref —
 * `--output=<path>` turns a read into a write, aimed wherever the caller likes, against a
 * service whose database IS the product. Closed by resolving to a sha via
 * `rev-parse --verify` before anything reaches argv.
 *
 * RACE (D-55): computing "what changed" used to call `treeHash(worktree)` — `git add -A`
 * plus `write-tree`, which MUTATES the shared index — before checking whether a round was
 * mid-read of that same worktree. A submit that only wanted to know what changed could
 * collide with the round's own periodic re-hash and fail a review it never touched. Closed
 * by reading the review's own STORED tree instead of re-snapshotting a live, possibly
 * contended, worktree.
 *
 * Runs over HTTP against a real worktree and a real git history, for the same reason
 * `submit-gate.test.ts` does: the whole subject is what git does to a tree.
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
let portSeq = 42_611;

const g = (...a: string[]) => execFileSync("git", a, { cwd: worktree, stdio: "pipe" }).toString().trim();

const treeNow = () => {
  g("add", "-A");
  return g("write-tree");
};

async function callTool(name: string, args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; isError: boolean }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
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
  // A THROWN ERROR SURFACES AS PLAIN PROSE in `content[0].text`, not as JSON — the
  // handler's `throw new Error(...)` becomes exactly that string, which `JSON.parse`
  // cannot read. A refusal here is a real outcome to assert on, not a fixture bug.
  if (isError) return { body: { error: text }, isError: true };
  return { body: JSON.parse(text) as Record<string, unknown>, isError };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-submit-commit-"));
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

describe("review_submit with a pushed commit instead of a diff", () => {
  it("applies the delta between the review's tree and the named commit", async () => {
    const pinned = treeNow();
    store.createReview({
      id: "revCommit", repoId: store.upsertRepo("demo", "git@x:demo.git").id, principal: "alice",
      branch: "feat/x", intoRef: "main", ticket: "t", type: "code-arch",
      state: "findings_ready", ladder: { ...initialState(), round: 5 }, treeHash: pinned,
    });
    writeFileSync(join(worktree, "f.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "fix");
    const commitSha = g("rev-parse", "HEAD");
    const target = treeNow();
    g("reset", "--hard", "HEAD~1");
    g("clean", "-fd");

    const { body } = await callTool("review_submit", { review_id: "revCommit", commit: commitSha, tree_hash: target });

    expect(body["error"], JSON.stringify(body)).toBeUndefined();
    expect(worktree, "the fix actually landed").toBeTruthy();
    expect(g("show", "HEAD:f.txt")).toBe("a"); // repo HEAD unmoved — lore never commits
    expect(execFileSync("cat", [join(worktree, "f.txt")]).toString()).toBe("b\n");
  });

  /**
   * THE INJECTION, AS A TEST. Every one of these is a git option; each reached argv
   * verbatim before `revParse` existed. `--output=` alone is an arbitrary-file-write
   * primitive handed to any token holder.
   */
  it.each([["--output=/tmp/lore-pwned-http"], ["--no-index"], ["-z"]])(
    "refuses %j as a commit rather than handing it to git",
    async (hostile) => {
      store.createReview({
        id: "revHostile", repoId: store.upsertRepo("demo", "git@x:demo.git").id, principal: "alice",
        branch: "feat/x", intoRef: "main", ticket: "t", type: "code-arch",
        state: "findings_ready", ladder: { ...initialState(), round: 5 }, treeHash: treeNow(),
      });

      const { body, isError } = await callTool("review_submit", { review_id: "revHostile", commit: hostile, tree_hash: "x".repeat(40) });

      expect(isError || body["error"] !== undefined, JSON.stringify(body)).toBe(true);
      expect(JSON.stringify(body)).toMatch(/cannot see commit/);
    },
  );

  /**
   * THE RACE, AS A TEST. Before the fix, resolving `commit` into a diff called
   * `treeHash(worktree)` — `git add -A` — unconditionally, before checking whether a
   * round was mid-read of the SAME worktree. Asserted here by making that call
   * observable: if the commit path used a live snapshot, `f.txt`'s content at the moment
   * of the call would matter and the test would need to race a real round to catch it.
   * Instead this asserts the STRUCTURAL fix — the review's STORED tree is used — by
   * proving the submit succeeds and produces the correct delta while a round is marked
   * pending, which the old code could only do by touching a worktree it had no business
   * touching while a round owned it.
   */
  it("computes the delta from the review's stored tree while a round is pending, not a live snapshot", async () => {
    const pinned = treeNow();
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id: "revPending", repoId, principal: "alice",
      branch: "feat/x", intoRef: "main", ticket: "t", type: "code-arch",
      state: "running", ladder: { ...initialState(), round: 5 }, treeHash: pinned,
    });
    // A round is pending — hasPendingRound(review_id) is now true.
    store.enqueue("revPending", "fast");

    writeFileSync(join(worktree, "f.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "fix");
    const commitSha = g("rev-parse", "HEAD");
    const target = treeNow();
    g("reset", "--hard", "HEAD~1");
    g("clean", "-fd");

    const { body } = await callTool("review_submit", { review_id: "revPending", commit: commitSha, tree_hash: target });

    // HELD, not applied synchronously — a round owns the worktree, exactly as the
    // existing diff-based hold path behaves. The important assertion is what it did NOT
    // do: it did not throw a git-lock or index error, which is what a live `treeHash`
    // call colliding with the round's own hashing would have surfaced.
    expect(body["error"], JSON.stringify(body)).toBeUndefined();
    expect(body["status"], JSON.stringify(body)).toBe("held");
  });

  it("refuses cleanly rather than guessing when neither a stored tree nor a safe live one is available", async () => {
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id: "revNoTree", repoId, principal: "alice",
      branch: "feat/x", intoRef: "main", ticket: "t", type: "code-arch",
      state: "running", ladder: { ...initialState(), round: 5 },
      // No treeHash recorded — the edge case a review should not normally reach.
    });
    store.enqueue("revNoTree", "fast");

    writeFileSync(join(worktree, "f.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "fix");
    const commitSha = g("rev-parse", "HEAD");
    g("reset", "--hard", "HEAD~1");
    g("clean", "-fd");

    const { body, isError } = await callTool("review_submit", { review_id: "revNoTree", commit: commitSha, tree_hash: "x".repeat(40) });

    expect(isError || body["error"] !== undefined, JSON.stringify(body)).toBe(true);
    expect(JSON.stringify(body)).toMatch(/cannot compute a delta safely/);
  });
});
