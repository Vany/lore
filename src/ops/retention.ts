/**
 * Cleaning up after finished reviews.
 *
 * At 30 PRs a day a worktree per review fills 4 TB eventually, and a disk that
 * fills stops every review at once. But the asymmetry here matters more than the
 * space:
 *
 * **Reviews are re-runnable; knowledge is not.** A deleted review costs one re-run.
 * Deleted knowledge costs everything the workgroup ever taught the service. So this
 * removes worktrees and old review rows, and **never touches the knowledge tables**.
 *
 * SPEC: spec/operations.md
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isTerminal, type ReviewState } from "../core/review-state.ts";
import { repoPaths } from "../git/repo.ts";
import type { Store } from "../store/store.ts";

export interface RetentionConfig {
  /** Days a finished review's worktree survives. */
  readonly worktreeDays: number;
  /** Days a finished review's rows survive. Longer: they are the audit trail. */
  readonly reviewDays: number;
  /** Hours before an untouched, unfinished review is called expired. */
  readonly staleHours: number;
  readonly reposRoot: string;
  /**
   * Carried only because `repoPaths` describes a repository completely and this
   * sweep asks it for one. Nothing here fetches, so no key is ever read — but a
   * layout defined in two places is a layout that eventually disagrees, which is
   * worse than one unused field.
   */
  readonly keysDir: string;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  worktreeDays: 7,
  reviewDays: 90,
  staleHours: 48,
  reposRoot: "/var/lib/lore/repos",
  keysDir: "/var/lib/lore/keys",
};

export interface RetentionResult {
  readonly worktreesRemoved: number;
  readonly reviewsDeleted: number;
  readonly reviewsExpired: number;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/**
 * Mark abandoned reviews expired.
 *
 * `expired` is a distinct state, never `passed` and never silently deleted: a
 * review the developer walked away from told us nothing about the code, and it must
 * not read as though it did (INV-1).
 */
export function expireStale(store: Store, cfg: RetentionConfig): number {
  const cutoff = new Date(Date.now() - cfg.staleHours * 3_600_000).toISOString();
  const res = store.db
    .prepare(
      `UPDATE review SET state = 'expired', updated_at = ?
       WHERE updated_at < ? AND state NOT IN ('passed', 'failed', 'expired')`,
    )
    .run(new Date().toISOString(), cutoff);
  return Number(res.changes);
}

export async function collect(store: Store, cfg: RetentionConfig = DEFAULT_RETENTION): Promise<RetentionResult> {
  const reviewsExpired = expireStale(store, cfg);

  // Worktrees for finished reviews.
  const finished = store.db
    .prepare(
      `SELECT id, repo_id, state FROM review
       WHERE state IN ('passed', 'failed', 'expired') AND updated_at < ?`,
    )
    .all(daysAgo(cfg.worktreeDays)) as Record<string, string>[];

  let worktreesRemoved = 0;
  for (const row of finished) {
    const state = (row["state"] ?? "failed") as ReviewState;
    if (!isTerminal(state)) continue;
    const paths = repoPaths(cfg.reposRoot, row["repo_id"] ?? "", cfg.keysDir);
    const dir = join(paths.worktrees, row["id"] ?? "");
    // Best-effort: a worktree that is already gone is the desired state, and
    // failing the sweep over one directory would leave every later one uncollected.
    const removed = await rm(dir, { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
    if (removed) worktreesRemoved++;
  }

  // Old review rows. Findings and verdicts cascade; knowledge does not — it has no
  // foreign key to a review precisely so that it outlives one.
  const deleted = store.db
    .prepare("DELETE FROM review WHERE state IN ('passed', 'failed', 'expired') AND updated_at < ?")
    .run(daysAgo(cfg.reviewDays));

  return { worktreesRemoved, reviewsDeleted: Number(deleted.changes), reviewsExpired };
}
