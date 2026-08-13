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

import { removeWorktree, repoPaths, treeHash, worktreeFor } from "../git/repo.ts";
import { requestMirrorRefresh } from "../git/mirror-request.ts";
import type { Store } from "../store/store.ts";

export interface RepinResult {
  readonly worktree: string;
  readonly treeHash: string;
  /** What the sync said, for the caller's message when the tree did not move. */
  readonly synced: boolean;
}

export async function repinReview(
  store: Store,
  reposRoot: string,
  dataDir: string,
  reviewId: string,
): Promise<RepinResult> {
  const at = store.reviewLocation(reviewId);
  if (at === undefined) throw new Error(`review ${reviewId} has no repository on record`);
  const paths = repoPaths(reposRoot, at.repoId);
  const refreshed = await requestMirrorRefresh(dataDir);
  await removeWorktree(paths, reviewId);
  const worktree = await worktreeFor(paths, reviewId, at.branch, at.gitUrl);
  return { worktree, treeHash: await treeHash(worktree), synced: refreshed.fetched };
}
