/**
 * Continue the SAME review on the branch as origin now has it (D-108).
 *
 * Vany: *"pull fresh — it must tell us to pull the new branch for review, and rename the
 * worktree — but continue the same review, not creating a new one."* The client models
 * were doing the opposite: pushing more commits and reaching for `restart: true`, which
 * abandons every finding and every ratified justification to re-review a branch they
 * never stopped working on. This is the middle path both texts now point at: the pin
 * advances, the review does not reset.
 *
 * The worktree is REMOVED AND RECUT rather than pulled into: a checkout that moved by
 * fetch would be a second way for the tree to change, and the review's whole hash
 * discipline (D-40) rests on there being exactly one — lore applies, lore hashes. The
 * recut lands at the review's own id, so every path in the system that knows the
 * worktree by review id keeps being right.
 *
 * THE SYNC COMES FIRST, EXPLICITLY. The branch already resolves — at its OLD tip — so
 * the missing-branch path that normally requests a sync would never fire, and a client
 * that pushed thirty seconds ago would silently get a five-minute-old tree: the exact
 * trap D-100 closed for new branches, reopened for moved ones. The wait is the fixed
 * one: completion, not pickup.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { removeWorktree, repoPaths, treeHash, worktreeFor } from "../git/repo.ts";
import { requestMirrorRefresh } from "../git/mirror-request.ts";
import type { Store } from "../store/store.ts";

const run = promisify(execFile);

export interface RepinResult {
  readonly worktree: string;
  readonly treeHash: string;
  /** What the sync said, for the caller's message when the tree did not move. */
  readonly synced: boolean;
}

/**
 * What origin's branch points at RIGHT NOW, read from the mirror without touching the
 * worktree — the question `pull_fresh` has to answer before it is allowed to destroy
 * anything. `undefined` when neither ref resolves, which the caller reads as "cannot
 * tell" and proceeds with the ordinary recut rather than guessing.
 *
 * `origin/<branch>` FIRST, `<branch>` only as the fallback — `addWorktree`'s own order,
 * and the order is the whole correctness of this function. The mirror is configured
 * `+refs/heads/*:refs/remotes/origin/*` (`mirror-refresh.sh`), so every fetch advances
 * `refs/remotes/origin/*` and the local `refs/heads/*` stay FROZEN at clone time.
 * Reading the local head therefore answered a different question than the one the review
 * was pinned by, and wrongly in both directions: on a branch that had moved since the
 * clone the trees never matched, so the guard never fired and the destructive recut ran
 * anyway; on a branch still at the clone-time tip they always matched, so a client that
 * HAD pushed was told "origin has nothing newer — push your commits, then call again",
 * for ever. The fallback stays for the mirror shape that has no remotes yet, which is
 * exactly when the local head is the only truth there is.
 */
async function originTree(bare: string, branch: string): Promise<string | undefined> {
  for (const ref of [`origin/${branch}^{tree}`, `refs/heads/${branch}^{tree}`]) {
    const tree = await run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: bare })
      .then((r) => r.stdout.trim())
      .catch(() => undefined);
    if (tree !== undefined && tree !== "") return tree;
  }
  return undefined;
}

export async function repinReview(
  store: Store,
  reposRoot: string,
  dataDir: string,
  reviewId: string,
  /**
   * The tree this review was last pinned to at ORIGIN. When origin still points there,
   * nothing is re-pinned and the worktree is left exactly as it stands — see below.
   */
  expectTree?: string,
): Promise<RepinResult> {
  const at = store.reviewLocation(reviewId);
  if (at === undefined) throw new Error(`review ${reviewId} has no repository on record`);
  const paths = repoPaths(reposRoot, at.repoId);
  const refreshed = await requestMirrorRefresh(dataDir);
  // RE-CHECKED HERE, not only by the caller before this was called. The sync above can
  // wait up to 45s (REFRESH_TIMEOUT_MS), and `review_submit`'s synchronous path only
  // holds a diff for a round that is ALREADY pending — at the caller's upfront check
  // there was none, so a submit landing during this wait applies straight to the
  // worktree we are about to destroy and enqueues a round that will never read what it
  // wrote. `removeWorktree` below is the one irreversible step; this is the last
  // possible moment to refuse instead of silently discarding that diff. The residual
  // window between this check and the fs-level remove is synchronous and the same kind
  // of gap `review_submit`'s own double hold-check already accepts as good enough.
  if (store.hasPendingRound(reviewId)) {
    throw new Error(
      `a round started for ${reviewId} while lore was syncing with origin — nothing was re-pinned. Poll it, ` +
        `and call pull_fresh again once it parks.`,
    );
  }
  // NOTHING IS DESTROYED UNTIL WE KNOW ORIGIN ACTUALLY MOVED.
  //
  // The recut was unconditional and the caller compared afterwards — so on the
  // "origin has nothing newer" path, which is the ordinary answer to a mistaken
  // pull_fresh, the worktree had ALREADY been removed and cut fresh from origin by the
  // time anyone noticed. Every fix the client had submitted lived only in that worktree
  // (a submit is applied there and never committed, D-40), so the reply "push your
  // commits, then call again" was handed back over a tree that had just silently lost
  // the author's work. The review then carried on against pre-fix code with its
  // findings still settled as fixed.
  //
  // Resolved from the MIRROR instead: no worktree involved, so the question is free and
  // the answer cannot cost anything. `undefined` means the ref would not resolve, which
  // is not a licence to skip — it falls through to the recut, exactly as before.
  const atOrigin = expectTree === undefined ? undefined : await originTree(paths.bare, at.branch);
  if (expectTree !== undefined && atOrigin === expectTree) {
    return {
      worktree: await worktreeFor(paths, reviewId, at.branch, at.gitUrl),
      treeHash: expectTree,
      synced: refreshed.fetched,
    };
  }
  await removeWorktree(paths, reviewId);
  const worktree = await worktreeFor(paths, reviewId, at.branch, at.gitUrl);
  return { worktree, treeHash: await treeHash(worktree), synced: refreshed.fetched };
}
