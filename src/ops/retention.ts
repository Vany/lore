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

import { TERMINAL_SQL, isTerminal, type ReviewState } from "../core/review-state.ts";
import { pruneWorktrees, removeWorktree, repoPaths } from "../git/repo.ts";
import type { Store } from "../store/store.ts";

export interface RetentionConfig {
  /**
   * Days a finished review's worktree survives the sweep.
   *
   * **Zero, deliberately (D-70).** A terminal review's worktree serves nothing: its
   * tree hash is recorded, attestation reads only the store, and `review_submit`
   * refuses a finished review. Seven days meant sixteen finished reviews were still
   * holding worktrees two days on, and the worker now releases them the moment a
   * review finishes — so anything reaching this sweep is already something that path
   * missed, and holding it longer only hides that.
   */
  readonly worktreeDays: number;
  /** Days a finished review's rows survive. Longer: they are the audit trail. */
  readonly reviewDays: number;
  /** Hours before an untouched, unfinished review is called expired. */
  readonly staleHours: number;
  readonly reposRoot: string;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  worktreeDays: 0,
  reviewDays: 90,
  staleHours: 48,
  reposRoot: "/var/lib/lore/repos",
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
      // The terminal set comes from ONE place. Spelled out here, it omitted
      // `passed_partial` — so a review that reached a partial pass would be
      // overwritten with `expired` two days later, a verdict destroyed by a sweep.
      `UPDATE review SET state = 'expired', updated_at = ?
       WHERE updated_at < ? AND state NOT IN (${TERMINAL_SQL})`,
    )
    .run(new Date().toISOString(), cutoff);
  return Number(res.changes);
}

export async function collect(store: Store, cfg: RetentionConfig = DEFAULT_RETENTION): Promise<RetentionResult> {
  const reviewsExpired = expireStale(store, cfg);

  // Worktrees for finished reviews. `passed_partial` is in this set now; spelled
  // out, it was missing, so a partial pass held its worktree for ever.
  const finished = store.db
    .prepare(
      // `<=`, not `<`. With `worktreeDays: 0` the cutoff IS now, and a review that
      // finished in the same millisecond as the sweep would fall outside a strict
      // comparison — harmless, since the worker already released it and the next pass
      // would catch it, but it makes "zero days" mean something other than "all of
      // them" for no reason.
      `SELECT id, repo_id, state FROM review
       WHERE state IN (${TERMINAL_SQL}) AND updated_at <= ?`,
    )
    .all(daysAgo(cfg.worktreeDays)) as Record<string, string>[];

  let worktreesRemoved = 0;
  for (const row of finished) {
    const state = (row["state"] ?? "failed") as ReviewState;
    if (!isTerminal(state)) continue;
    // `removeWorktree`, NOT a bare `rm`.
    //
    // git keeps its own record of every worktree under `bare.git/worktrees/<id>`,
    // and deleting the directory leaves that behind: `git worktree list` grows for
    // ever with entries pointing at nothing, and the bare repo accumulates
    // administrative files nobody collects. It had never shown up because the sweep
    // had never removed anything — the seven-day window meant nothing was ever old
    // enough. Setting that window to zero would have started the leak on the next
    // hourly pass, which is how this was found.
    const removed = await removeWorktree(repoPaths(cfg.reposRoot, row["repo_id"] ?? ""), row["id"] ?? "").then(
      () => true,
      // Best-effort: failing the sweep over one directory would leave every later
      // one uncollected.
      () => false,
    );
    if (removed) worktreesRemoved++;
  }

  // Whatever the careful path could not reach: records naming a directory that is
  // gone. `git worktree remove` cannot collect those, so they accumulate silently —
  // twelve were found on the deployment, left over from a data directory that moved.
  // Per repository, once, because that is the scope git prunes at.
  const repos = store.db.prepare("SELECT id FROM repo").all() as Record<string, string>[];
  for (const r of repos) {
    await pruneWorktrees(repoPaths(cfg.reposRoot, r["id"] ?? "")).catch(() => undefined);
  }

  // Old review rows. Findings and verdicts cascade; knowledge does not — it has no
  // foreign key to a review precisely so that it outlives one.
  const deleted = store.db
    .prepare(`DELETE FROM review WHERE state IN (${TERMINAL_SQL}) AND updated_at < ?`)
    .run(daysAgo(cfg.reviewDays));

  return { worktreesRemoved, reviewsDeleted: Number(deleted.changes), reviewsExpired };
}
