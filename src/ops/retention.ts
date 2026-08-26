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
 * SPEC: spec/operations.md §5
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../core/paths.ts";
import { isTerminal, type ReviewState } from "../core/review-state.ts";
import { pruneWorktrees, removeWorktree, repoPaths } from "../git/repo.ts";
import { isInstalling } from "../t0/runner.ts";
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
  /**
   * Days an unused sandbox cache or scratch directory survives.
   *
   * **The one disk fact that is ours, and nothing was collecting it.** The npm cache is
   * keyed by lockfile hash so every distinct lockfile leaves a directory for ever;
   * scratch gets one per review and the review goes away. Measured 2026-08-07: 5.7 GB of
   * cache and 1.1 GB of scratch, against 4.4 GB recorded a day earlier — a curve with no
   * ceiling, in a data directory that also holds the knowledge base.
   *
   * Fourteen days rather than zero: the cache exists to make an install cheap, and a
   * repository reviewed fortnightly should still find its dependencies warm. What it
   * must not do is keep every lockfile any branch has ever had.
   */
  readonly cacheDays: number;
  /** Where the sandbox keeps its npm cache and per-review scratch, if this deployment has one. */
  readonly cacheRoot?: string | undefined;
  readonly scratchRoot?: string | undefined;
}

/**
 * How long an unanswered review survives — named, because two places now say it.
 *
 * The sweep enforces it; `review_inbox` QUOTES it, telling a client when the review it
 * is looking at will be taken away. Two literals would drift, and the direction of the
 * drift is a client told it has longer than it has.
 */
export const STALE_HOURS = 48;
/**
 * How long `findings_stale` lasts before the sweep calls it `expired` (D-106).
 *
 * Vany: *"happens after ready STALE_HOURS, lasts a week, and the same as ready, but
 * gray."* The week counts from GRAYING — the transition writes `updated_at` — so the
 * whole life of an unanswered review is 48 hours bright, seven days gray, then gone.
 */
export const STALE_GRACE_DAYS = 7;

export const DEFAULT_RETENTION: RetentionConfig = {
  worktreeDays: 0,
  reviewDays: 90,
  staleHours: STALE_HOURS,
  cacheDays: 14,
  reposRoot: join(dataDir(), "repos"),
  cacheRoot: join(dataDir(), "npm-cache"),
  scratchRoot: join(dataDir(), "scratch"),
};

export interface RetentionResult {
  readonly worktreesRemoved: number;
  readonly reviewsDeleted: number;
  readonly reviewsExpired: number;
  /** Sandbox cache and scratch directories collected, and roughly what they held. */
  readonly cacheDirsRemoved: number;
  readonly cacheBytesFreed: number;
  /** Queued jobs closed because the review they belonged to had already ended. */
  readonly deadJobsClosed: number;
}

/**
 * Collect sandbox directories nothing has touched lately.
 *
 * Best-effort throughout: a permissions fault on one directory must not stop the rest,
 * and this is housekeeping — the sweep it runs inside collects worktrees and rows that
 * matter more. It reports what it freed so the number is visible rather than assumed;
 * an uncollected cache announced itself as 5.7 GB only because somebody ran `du`.
 */
async function collectSandbox(cfg: RetentionConfig): Promise<{ dirs: number; bytes: number }> {
  const cutoff = Date.now() - cfg.cacheDays * 86_400_000;
  let dirs = 0;
  let bytes = 0;

  for (const root of [cfg.cacheRoot, cfg.scratchRoot]) {
    if (root === undefined) continue;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(root, e.name);
      // NEVER A DIRECTORY AN INSTALL IS USING RIGHT NOW — found by lore's own
      // review, fingerprint ffbda1f7: `t0/runner.ts`'s own comment on this same
      // failure — "a half-written node_modules makes tsc and eslint report errors that are not
      // real... cost two rounds of confident false claims about someone else's
      // branch" — described exactly what an uncoordinated `rm` here can cause,
      // reopened one caller over. `withInstallLock`'s lock covers readers too, not
      // only the install itself, so a long cold install (or a burst of reviews
      // queued behind one on the same lockfile hash) can leave a cache mid-use for
      // minutes — old enough, on a quiet deployment, to be the oldest thing this
      // sweep sees. Both run in the same process; `isInstalling` is the check that
      // was already reachable and simply never asked.
      if (isInstalling(path)) continue;
      const s = await stat(path).catch(() => undefined);
      // mtime, not atime: many filesystems mount `noatime`, so a read leaves no trace
      // and an actively-used cache would look abandoned. An npm cache is WRITTEN on
      // every install that adds a package, which is the event worth keeping it for.
      // A WARM pnpm/yarn install may not touch it at all — `t0/runner.ts` now
      // touches `cacheDir` itself on every use, unconditionally, for exactly that
      // reason: recording use directly, rather than inferring it from a side
      // effect that varies by package manager.
      if (s === undefined || s.mtimeMs > cutoff) continue;
      const size = await dirSize(path);
      const gone = await rm(path, { recursive: true, force: true }).then(() => true, () => false);
      if (!gone) continue;
      dirs++;
      bytes += size;
    }
  }
  return { dirs, bytes };
}

/** Bytes under a directory, best-effort — a size nobody can read is reported as zero. */
async function dirSize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => undefined);
  if (entries === undefined) return 0;
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const s = await stat(join(e.parentPath, e.name)).catch(() => undefined);
    total += s?.size ?? 0;
  }
  return total;
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
  const staleCutoff = new Date(Date.now() - STALE_GRACE_DAYS * 86_400_000).toISOString();
  // The SQL lives in the store, not here. It used to be written inline — the terminal
  // set spelled out (it omitted `passed_partial`, and a partial pass was overwritten
  // with `expired` two days later, a verdict destroyed by a sweep), and the state
  // column written directly, which made this the one review-state change that woke no
  // subscriber. Both faults are the same fault: a mutation that knows the schema
  // better than the invariants.
  //
  // EXPIRE FIRST, GRAY SECOND (D-106). Run the other way, a review graying in this
  // sweep would carry a fresh `updated_at` into the expiry query and could never be
  // taken in the same pass — harmless, but the order makes the reasoning checkable:
  // what dies today was gray for the whole week, not gray since this morning.
  const expired = store.expireStaleReviews(cutoff, staleCutoff).length;
  store.grayStaleFindings(cutoff);
  return expired;
}

export async function collect(store: Store, cfg: RetentionConfig = DEFAULT_RETENTION): Promise<RetentionResult> {
  const reviewsExpired = expireStale(store, cfg);

  // Worktrees for finished reviews. `passed_partial` is in this set now; spelled
  // out, it was missing, so a partial pass held its worktree for ever.
  // `<=`, not `<`. With `worktreeDays: 0` the cutoff IS now, and a review that
  // finished in the same millisecond as the sweep would fall outside a strict
  // comparison — harmless, since the worker already released it and the next pass would
  // catch it, but it makes "zero days" mean something other than "all of them".
  const finished = store.finishedBefore(daysAgo(cfg.worktreeDays));

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
  for (const repo of store.repos()) {
    await pruneWorktrees(repoPaths(cfg.reposRoot, repo.id)).catch(() => undefined);
  }

  // Old review rows. Findings and verdicts cascade; knowledge does not — it has no
  // foreign key to a review precisely so that it outlives one.
  const reviewsDeleted = store.deleteReviewsBefore(daysAgo(cfg.reviewDays));

  // QUEUED JOBS BELONGING TO REVIEWS THAT HAVE ALREADY ENDED.
  //
  // The cause is fixed where reviews become terminal, so in a healthy service this finds
  // nothing. It is here for the rows that leaked before that fix — three of them, one
  // nineteen hours old — and because this class of leak announces itself as the opposite
  // of what it is: a growing queue depth on an idle service, which reads as "we are
  // behind" and is really "these will never run". Counted rather than silent, so a
  // non-zero number after the cause is fixed is a question rather than housekeeping.
  const deadJobsClosed = store.closeJobsOfEndedReviews();

  const sandbox = await collectSandbox(cfg);
  return {
    worktreesRemoved,
    reviewsDeleted,
    reviewsExpired,
    cacheDirsRemoved: sandbox.dirs,
    cacheBytesFreed: sandbox.bytes,
    deadJobsClosed,
  };
}
