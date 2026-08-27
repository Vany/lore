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
import { applyPatch } from "../git/repo.ts";
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
let priorDataDir: string | undefined;

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
  // PINNED TO A DIRECTORY WITH NO HEARTBEAT FILE, deliberately (found by lore's own t2
  // against D-127's batch). `commit`'s resolve-failure path now calls
  // `requestMirrorRefresh(dataDir())`, and unpinned that reads the REAL `LORE_DATA_DIR`
  // (or `~/.lore`) — on a machine running an actual `mirror-daemon`, the heartbeat is
  // fresh, so this test would write a real mirror-request into a live deployment's data
  // directory and race its own assertion against whatever that daemon does. `root` is
  // fresh per test and has no heartbeat, so `requestMirrorRefresh` answers `fetched:
  // false` immediately regardless of what else is running on the machine.
  priorDataDir = process.env["LORE_DATA_DIR"];
  process.env["LORE_DATA_DIR"] = root;
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
  if (priorDataDir === undefined) delete process.env["LORE_DATA_DIR"];
  else process.env["LORE_DATA_DIR"] = priorDataDir;
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
   * THE CLAIM, WRONG — AND A ROUND PENDING, so this submit is HELD rather than applied.
   * Found by lore's own review, fingerprint 109d9211: a commit-form submit's `tree_hash`
   * used to be trusted uncritically into the held row here, discovered wrong only much
   * later at consume time (`consumeHeldDiffs`, review.ts) — which drops the WHOLE tail
   * of the chain queued behind it, not just the one bad entry. The immediate-apply path
   * (no round pending) already had a downstream safety net — apply, re-hash, compare,
   * roll back on mismatch — so it was never the dangerous case; this one had none. The
   * commit form can check this immediately instead of waiting to apply anything, because
   * `resolved`'s own tree is not a claim, it is something lore can compute directly.
   */
  it("refuses a commit-form submit whose tree_hash does not match the commit's own tree, rather than holding it", async () => {
    const pinned = treeNow();
    store.createReview({
      id: "revWrongTree", repoId: store.upsertRepo("demo", "git@x:demo.git").id, principal: "alice",
      branch: "feat/x", intoRef: "main", ticket: "t", type: "code-arch",
      state: "running", ladder: { ...initialState(), round: 5 }, treeHash: pinned,
    });
    // A round is pending — hasPendingRound(review_id) is true, so a correct submit here
    // would be HELD, not applied. The wrong claim must be refused before that happens.
    store.enqueue("revWrongTree", "fast");

    writeFileSync(join(worktree, "f.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "fix");
    const commitSha = g("rev-parse", "HEAD");
    g("reset", "--hard", "HEAD~1");
    g("clean", "-fd");

    const { body, isError } = await callTool("review_submit", {
      review_id: "revWrongTree",
      commit: commitSha,
      tree_hash: "b".repeat(40),
    });

    expect(isError || body["error"] !== undefined, JSON.stringify(body)).toBe(true);
    expect(JSON.stringify(body)).toMatch(/tree_hash mismatch/);
    // Nothing was held on the strength of the wrong claim.
    expect(store.heldDiffs("revWrongTree")).toEqual([]);
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
      // D-100's pattern (found by lore's own t1 against D-127's batch): a resolve failure
      // is retried once against a fresh mirror before refusing, and — since `beforeEach`
      // pins `LORE_DATA_DIR` to a fresh directory with no heartbeat file — the retry
      // itself cannot run, which must be SAID rather than folded into the same sentence
      // a confirmed-absent commit gets.
      expect(JSON.stringify(body)).toMatch(/could not confirm a fresh sync/);
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

  /**
   * A SECOND HELD COMMIT MUST CHAIN ONTO THE FIRST, not restate it. Found live rather
   * than by a tier: a fix submitted while an earlier one was still held silently never
   * landed, because `at` was computed from `review.treeHash` — the last APPLIED tree,
   * which `holdDiff` deliberately never advances — instead of the held chain's own
   * head. `heldDiffs`' own docblock states the assumption this violated: "each was
   * built by the client on top of the one before", true for the raw-`diff` form where
   * the client computes it, false here where lore computes it FOR the commit form.
   * Two held diffs built from the same stale base, applied in sequence, land on a tree
   * neither of them actually diffed against — `awaiting_diff`, silently, an hour later.
   */
  it("bases a second held commit-form diff on the first's claimed tree, not the review's last-applied one", async () => {
    const pinned = treeNow();
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id: "revChain", repoId, principal: "alice",
      branch: "feat/x", intoRef: "main", ticket: "t", type: "code-arch",
      state: "running", ladder: { ...initialState(), round: 5 }, treeHash: pinned,
    });
    store.enqueue("revChain", "fast");

    // Two REAL, connected commits — fix 2 builds on fix 1's own result, exactly as a
    // client's second submit would after seeing "held" for the first.
    writeFileSync(join(worktree, "f.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "fix 1");
    const commit1 = g("rev-parse", "HEAD");
    const tree1 = treeNow();

    writeFileSync(join(worktree, "f.txt"), "c\n");
    g("add", "-A");
    g("commit", "-qm", "fix 2");
    const commit2 = g("rev-parse", "HEAD");
    const tree2 = treeNow();

    // Back to the review's own recorded base — the worktree state before either fix,
    // matching `pinned`, since neither has actually been APPLIED to it yet.
    g("reset", "--hard", "HEAD~2");
    g("clean", "-fd");

    const first = await callTool("review_submit", { review_id: "revChain", commit: commit1, tree_hash: tree1 });
    expect(first.body["status"], JSON.stringify(first.body)).toBe("held");

    const second = await callTool("review_submit", { review_id: "revChain", commit: commit2, tree_hash: tree2 });
    expect(second.body["status"], JSON.stringify(second.body)).toBe("held");

    const held = store.heldDiffs("revChain");
    expect(held, "both held, in arrival order").toHaveLength(2);
    expect(held[0]?.treeHash).toBe(tree1);
    expect(held[1]?.treeHash).toBe(tree2);

    // THE ACTUAL CLAIM: fix 2's own diff is against fix 1's RESULT (b -> c), not
    // against the original base (which would restate fix 1's own a -> b change too,
    // or — worse — collapse to a -> c and silently drop the base git-apply expects).
    expect(held[1]?.diff, "diffed against fix 1's own result").toContain("-b");
    expect(held[1]?.diff).toContain("+c");
    expect(held[1]?.diff, "must not restate fix 1's own change too").not.toMatch(/^-a$/m);
  });

  /**
   * TWO OVERLAPPING SUBMITS, not just two sequential ones — the narrower race the
   * test above cannot see (found by lore's own review, fingerprint 015cd8d0).
   * Reading the held chain's head and inserting the new hold are separated by real
   * async work (`revParse`, `treeDelta`); without serializing commit-form submits
   * per review, two requests that both start before either has held anything would
   * both read an empty chain and both build from the same stale base — the
   * identical silently-dropped-chain shape, reopened through concurrency instead
   * of sequencing.
   */
  it("still chains correctly when two commit-form submits for the same review overlap", async () => {
    const pinned = treeNow();
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id: "revRace", repoId, principal: "alice",
      branch: "feat/x", intoRef: "main", ticket: "t", type: "code-arch",
      state: "running", ladder: { ...initialState(), round: 5 }, treeHash: pinned,
    });
    store.enqueue("revRace", "fast");

    // Two REAL, connected commits, kept linear exactly like the sequential test
    // above — a chained hold only makes sense that way. What THIS test adds is
    // firing both requests together, neither awaited before the other starts.
    writeFileSync(join(worktree, "f.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "fix 1");
    const commit1 = g("rev-parse", "HEAD");
    const tree1 = treeNow();

    writeFileSync(join(worktree, "f.txt"), "c\n");
    g("add", "-A");
    g("commit", "-qm", "fix 2");
    const commit2 = g("rev-parse", "HEAD");
    const tree2 = treeNow();

    g("reset", "--hard", "HEAD~2");
    g("clean", "-fd");

    const [respA, respB] = await Promise.all([
      callTool("review_submit", { review_id: "revRace", commit: commit1, tree_hash: tree1 }),
      callTool("review_submit", { review_id: "revRace", commit: commit2, tree_hash: tree2 }),
    ]);
    expect(respA.body["status"], JSON.stringify(respA.body)).toBe("held");
    expect(respB.body["status"], JSON.stringify(respB.body)).toBe("held");

    const held = store.heldDiffs("revRace");
    expect(held, "both held").toHaveLength(2);
    const [row0, row1] = held;
    if (row0 === undefined || row1 === undefined) throw new Error("unreachable: asserted length 2 above");

    // THE CHAINING INVARIANT ITSELF, verified directly rather than assumed to hold
    // in whichever order the lock actually processed the two requests: applying
    // the SECOND row's own diff to a tree checked out at the FIRST row's own
    // claimed tree must reproduce the second row's own claimed tree exactly. An
    // unserialized race could not guarantee this regardless of which commit
    // happened to reach the lock first.
    g("read-tree", "--reset", "-u", row0.treeHash);
    await applyPatch(worktree, row1.diff);
    const resultTree = treeNow();
    expect(resultTree, "row 2's diff, applied to row 1's own tree, reproduces row 2's own claimed tree").toBe(row1.treeHash);
  });

  /**
   * A RAW-DIFF HOLD'S TREE IS A CLAIM, NOT AN OBJECT LORE CAN DIFF AGAINST (found by
   * lore's own review, fingerprint 2889d85b). Its `tree_hash` is the CALLER's own
   * local `git write-tree`, never pushed anywhere lore's repository can see — using
   * it as a later commit-form submit's base would send `git diff` an object that does
   * not exist, "fatal: bad object", which — unhandled — surfaces as the IDENTICAL
   * "cannot see commit" message a genuinely-unpushed commit gets: a client told to
   * push something that is already pushed, which it will retry forever.
   */
  it("refuses a commit-form submit rather than diffing against an unverified raw hold", async () => {
    const pinned = treeNow();
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id: "revMixed", repoId, principal: "alice",
      branch: "feat/x", intoRef: "main", ticket: "t", type: "code-arch",
      state: "running", ladder: { ...initialState(), round: 5 }, treeHash: pinned,
    });
    store.enqueue("revMixed", "fast");

    // A RAW diff, with a CLAIMED tree lore's own repository has genuinely never
    // seen — matching a real client's `write-tree` on their OWN separate clone. NOT
    // `treeNow()`: that runs `git write-tree` in this SAME repository the service
    // itself reads, which would actually CREATE the object here and defeat the
    // point — a syntactically valid hash (the right length, `OBJECT_ID`) that
    // nothing in this test ever writes is what a genuinely unseen claim looks like.
    writeFileSync(join(worktree, "f.txt"), "b\n");
    const rawDiff = g("diff");
    g("checkout", "--", "f.txt");
    const rawTree = "b".repeat(40);

    const heldRaw = await callTool("review_submit", { review_id: "revMixed", diff: rawDiff, tree_hash: rawTree });
    expect(heldRaw.body["status"], JSON.stringify(heldRaw.body)).toBe("held");

    // A commit-form submit arrives next, while the raw hold above is still unapplied.
    writeFileSync(join(worktree, "g.txt"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "fix 2");
    const commit2 = g("rev-parse", "HEAD");
    const tree2 = treeNow();
    g("reset", "--hard", "HEAD~1");
    g("clean", "-fd");

    const { body, isError } = await callTool("review_submit", { review_id: "revMixed", commit: commit2, tree_hash: tree2 });

    expect(isError || body["error"] !== undefined, JSON.stringify(body)).toBe(true);
    expect(JSON.stringify(body)).toMatch(/HELD raw diff whose claimed tree lore has never fetched/);
    // NEVER the misleading "push it to origin" message a genuinely-missing commit
    // gets — commit2 IS reachable; the problem is what it would have to be diffed
    // against, not whether lore can see commit2 itself.
    expect(JSON.stringify(body)).not.toMatch(/Push it to origin/);
  });

  /**
   * THE SAME LOCK MUST COVER THE ACTUAL MUTATION, NOT ONLY THE HOLD DECISION (found
   * by lore's own review, fingerprint 13339892). The ORDINARY submit window — no
   * round pending, `findings_ready` — never holds anything, so two overlapping
   * commit-form submits both skip the hold branch entirely and go straight to
   * applying. Without serializing THAT too, a losing submit's own `restoreTree`
   * could rewind the worktree PAST a winning submit's already-recorded result:
   * `review.treeHash` naming a tree the worktree no longer holds, silently — no
   * console output, no `awaiting_diff`, D-40's authoritative record just stops
   * describing reality.
   */
  it("keeps the record and the worktree in agreement when two commit-form submits overlap with no round pending", async () => {
    const pinned = treeNow();
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id: "revApplyRace", repoId, principal: "alice",
      branch: "feat/x", intoRef: "main", ticket: "t", type: "code-arch",
      state: "findings_ready", ladder: { ...initialState(), round: 5 }, treeHash: pinned,
    });
    // NO store.enqueue — this is the ORDINARY window, nothing pending, so neither
    // submit below ever reaches the hold branch at all.

    // Two REAL, connected commits — fix 2 builds on fix 1's own result, so whichever
    // order the lock actually processes them in, each one's OWN hash check still
    // passes (treeDelta and git apply are exact inverses for any two real trees);
    // what is at risk is only whether the RECORD ends up agreeing with whichever
    // tree actually won.
    writeFileSync(join(worktree, "f.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "fix 1");
    const commit1 = g("rev-parse", "HEAD");
    const tree1 = treeNow();

    writeFileSync(join(worktree, "f.txt"), "c\n");
    g("add", "-A");
    g("commit", "-qm", "fix 2");
    const commit2 = g("rev-parse", "HEAD");
    const tree2 = treeNow();

    g("reset", "--hard", "HEAD~2");
    g("clean", "-fd");

    const [respA, respB] = await Promise.all([
      callTool("review_submit", { review_id: "revApplyRace", commit: commit1, tree_hash: tree1 }),
      callTool("review_submit", { review_id: "revApplyRace", commit: commit2, tree_hash: tree2 }),
    ]);

    const bodies = [respA.body, respB.body];
    expect(bodies.filter((b) => b["error"] !== undefined), JSON.stringify(bodies)).toHaveLength(0);

    // THE RECORD AND THE WORKTREE MUST AGREE, whichever order actually won — the
    // property an unserialized race could not guarantee.
    const recordedTree = store.getReview("revApplyRace", "alice")?.treeHash;
    const actualTree = treeNow();
    expect(actualTree, "the worktree must match whatever review.treeHash claims").toBe(recordedTree);
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
    // The commit's REAL tree, not a placeholder — a wrong tree_hash now gets refused
    // earlier, by the tree_hash-mismatch check itself (see the dedicated test for
    // that). This fixture is after it: a CORRECT claim, still refused, because
    // nothing safe to diff against is on record at all.
    const commitTree = g("rev-parse", `${commitSha}^{tree}`);
    g("reset", "--hard", "HEAD~1");
    g("clean", "-fd");

    const { body, isError } = await callTool("review_submit", { review_id: "revNoTree", commit: commitSha, tree_hash: commitTree });

    expect(isError || body["error"] !== undefined, JSON.stringify(body)).toBe(true);
    expect(JSON.stringify(body)).toMatch(/cannot compute a delta safely/);
  });
});
