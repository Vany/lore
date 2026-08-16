/**
 * WHAT A REVIEW IS A REVIEW OF, and that it stops being a moving target (D-113).
 *
 * The defect these pin down was found by driving lore, not by reading it, and it had
 * already produced a review that looked ready to continue and could only have continued
 * into a `passed` over nothing:
 *
 *   * `intoRef` is a branch NAME, re-resolved on every round.
 *   * When the base branch advances to CONTAIN the branch under review — which is exactly
 *     what a batch gate does when it pushes its own commits before the ladder has ruled,
 *     and what any branch does the moment it merges — `merge-base(into, HEAD)` returns
 *     HEAD itself.
 *   * `git diff HEAD` from a worktree at HEAD is empty. Every tier is then shown nothing,
 *     raises nothing, and the merge cannot tell that apart from a tier that looked and was
 *     satisfied.
 *
 * These run real git rather than a fake, because the whole claim is about what
 * `merge-base` does when refs move, and a fixture that models merge-base has already
 * assumed the answer.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseCommitFor, computeDiff } from "./diff.ts";

let root: string;
let repo: string;

const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString().trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-basepin-"));
  repo = join(root, "r");
  mkdirSync(repo, { recursive: true });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  g("checkout", "-q", "-b", "work");
  writeFileSync(join(repo, "b.txt"), "b\n");
  g("add", "-A");
  g("commit", "-qm", "the work");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the base a review measures from", () => {
  it("is the merge-base at pin time", async () => {
    const mainSha = g("rev-parse", "main");
    expect(await baseCommitFor(repo, "main")).toBe(mainSha);
  });

  it("is undefined for a base ref that does not exist, rather than a guess", async () => {
    expect(await baseCommitFor(repo, "no-such-branch")).toBeUndefined();
  });

  /**
   * THE DEFECT ITSELF. `main` fast-forwards to contain `work`, which is what happens the
   * moment the work merges — or, for lore's own batch gate, the moment a commit reaches
   * `origin/main` before the ladder has ruled on it.
   */
  it("collapses onto HEAD once the base contains the branch, when recomputed", async () => {
    const pinned = await baseCommitFor(repo, "main");
    g("checkout", "-q", "main");
    g("merge", "-q", "--ff-only", "work");
    g("checkout", "-q", "work");

    // The live answer is now HEAD, so a fresh diff would be empty...
    expect(await baseCommitFor(repo, "main")).toBe(g("rev-parse", "HEAD"));
    const recomputed = await computeDiff(repo, "main");
    expect(recomputed.changedFiles, "the change-set vanished when the base moved").toStrictEqual([]);
    expect(recomputed.patch.trim()).toBe("");

    // ...while the pinned base still describes the same change it always did.
    const held = await computeDiff(repo, "main", pinned);
    expect(held.changedFiles).toStrictEqual(["b.txt"]);
    expect(held.mergeBase).toBe(pinned);
  });

  /**
   * A pin that no longer resolves must not become `git diff <missing-sha>`, which fails
   * with raw git vocabulary at the one moment a client needs a reason. Falling back to the
   * live merge-base puts the review exactly where it would have been without the column.
   */
  it("falls back to the live merge-base when the pinned commit is gone", async () => {
    const held = await computeDiff(repo, "main", "0".repeat(40));
    expect(held.mergeBase).toBe(g("rev-parse", "main"));
    expect(held.changedFiles).toStrictEqual(["b.txt"]);
  });

  /**
   * A PIN OUTLIVES THE REF IT WAS CUT FROM. Created by this project's own batch
   * procedure: a batch reviews `into: review-base/<sha>`, both scratch refs are deleted as
   * documented cleanup, and the mirror's `fetch --prune` drops them within five minutes.
   * An open review — and D-112 reviews stay open for days — then hit "the base branch does
   * not exist" on its next round and died with every ratified justification, while the pin
   * held everything the measurement needed.
   */
  it("survives the base ref being deleted, when a pin resolves", async () => {
    const pinned = await baseCommitFor(repo, "main");
    g("branch", "-q", "-D", "main");

    const held = await computeDiff(repo, "main", pinned);
    expect(held.mergeBase).toBe(pinned);
    expect(held.changedFiles).toStrictEqual(["b.txt"]);
    // The staleness questions were never asked, and say so rather than guessing.
    expect(held.behindBy, "nothing knowable to be behind").toBe(0);
    expect(held.mergesClean, "not 'clean' — unasked").toBeUndefined();
    expect(held.overlap).toStrictEqual([]);
  });

  it("still refuses when the base ref is gone and there is no pin", async () => {
    g("branch", "-q", "-D", "main");
    await expect(computeDiff(repo, "main")).rejects.toThrow(/does not exist/);
  });

  /**
   * OVERLAP IS "WHAT DID BOTH SIDES TOUCH", so it must be measured from the LIVE
   * merge-base. From the pin it degenerates exactly where D-113 matters most: once `into`
   * contains the branch, `diff(pin, into)` covers the branch's own change-set and every
   * file it touched is reported as changed by both sides — sending a deep tier to hunt for
   * conflicts between the branch and its own merged work, every round.
   */
  it("does not report the branch's own files as touched by both sides", async () => {
    const pinned = await baseCommitFor(repo, "main");
    g("checkout", "-q", "main");
    g("merge", "-q", "--ff-only", "work");
    writeFileSync(join(repo, "c.txt"), "c\n");
    g("add", "-A");
    g("commit", "-qm", "the base moves on after absorbing the work");
    g("checkout", "-q", "work");

    const held = await computeDiff(repo, "main", pinned);
    expect(held.changedFiles, "still measured from the pin").toStrictEqual(["b.txt"]);
    expect(held.overlap, "b.txt is the branch's OWN work, not a collision").toStrictEqual([]);
  });

  /**
   * `mergesClean`, `behindBy` and the overlap analysis ask about `into` AS IT IS NOW —
   * that is the whole point of those three, and pinning the base must not freeze them
   * too. Here the base moves ahead independently, which is the ordinary stale-branch case.
   */
  it("still measures staleness against the base as it stands now", async () => {
    const pinned = await baseCommitFor(repo, "main");
    g("checkout", "-q", "main");
    writeFileSync(join(repo, "c.txt"), "c\n");
    g("add", "-A");
    g("commit", "-qm", "the base moved on");
    g("checkout", "-q", "work");

    const held = await computeDiff(repo, "main", pinned);
    expect(held.mergeBase, "the measurement is still from the pin").toBe(pinned);
    expect(held.behindBy, "but staleness is against the base's tip").toBe(1);
    expect(held.changedFiles).toStrictEqual(["b.txt"]);
  });
});
