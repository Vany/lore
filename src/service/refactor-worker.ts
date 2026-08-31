/**
 * The refactor dispatcher: one run, start to finish, no rounds (D-136).
 *
 * Deliberately its own loop, not a job kind inside `Worker`'s: `job`/`claimJob` are
 * review-shaped — one row per ROUND, a `review_id` foreign key, fast/deep stage
 * escalation — and a refactor run has none of that. It is claimed once, runs the
 * fan-out and the combine step, and ends. This shares the PROCESS and `Worker.start`'s
 * own dispatch shape (claim, fire without awaiting, poll when nothing is queued)
 * without sharing the review-shaped table or its state machine.
 *
 * SPEC: spec/refactor.md
 */

import { loadTiers } from "../core/ladder.ts";
import { git } from "../git/exec.ts";
import { removeWorktree, repoPaths, worktreeFor } from "../git/repo.ts";
import type { ReviewerLike } from "../reviewer/opencode.ts";
import { suggestRefactors } from "../refactor/run.ts";
import type { Store } from "../store/store.ts";

export interface RefactorWorkerConfig {
  readonly reposRoot: string;
  readonly pollMs: number;
}

export class RefactorWorker {
  private readonly store: Store;
  private readonly cfg: RefactorWorkerConfig;
  private readonly ask: NonNullable<ReviewerLike["askFor"]>;
  private running = false;

  constructor(store: Store, cfg: RefactorWorkerConfig, reviewer: ReviewerLike) {
    // FAIL AT CONSTRUCTION, not on the first claimed run — a dispatcher that cannot ask
    // a tier anything is useless, and finding that out only after a customer's first
    // `refactor_start` is exactly the silent-until-used shape this project refuses.
    if (reviewer.askFor === undefined) {
      throw new Error("RefactorWorker needs a reviewer that implements askFor — the plain Reviewer class always does");
    }
    this.store = store;
    this.cfg = cfg;
    this.ask = reviewer.askFor.bind(reviewer);
  }

  start(): () => void {
    // lore-ok[54aff246]: found by lore's own review — whatever is still marked
    // `running` belongs to a process that is gone (mirrors `Worker.start`'s own
    // reclaim). A refactor run has no rounds, so `running` at startup can only mean
    // "interrupted", never "resumable" — reclaimed as `failed`, and its worktree
    // (which was mid-cut or mid-read and will never be finished or cleaned by the
    // `finally` in `execute` that died with the process) removed here instead.
    const reclaimed = this.store.reclaimOrphanedRefactorRuns();
    if (reclaimed.length > 0) {
      console.error(`[lore:log] startup: ${String(reclaimed.length)} refactor run(s) failed — left mid-run by a worker that stopped`);
      for (const r of reclaimed) {
        void removeWorktree(repoPaths(this.cfg.reposRoot, r.repoId), r.id).catch((e: unknown) => {
          console.error(`[lore:log] ${r.id}: reclaimed refactor worktree not removed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }
    this.running = true;
    void this.dispatch().catch((e: unknown) => {
      console.error(`[lore:log] the refactor dispatcher stopped: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    });
    return () => {
      this.running = false;
    };
  }

  private async dispatch(): Promise<void> {
    while (this.running) {
      // lore-ok[9d364d2a,99512285]: found by lore's own review (the second fingerprint
      // a stale re-raise of the same tree, same finding) — `Worker.dispatch` declines
      // to claim while draining (D-121: "DRAINING IS THE ONLY REASON THIS LOOP
      // DECLINES WORK"), and this dispatcher never asked. A deploy that believed a
      // drain had quieted the service would still see fresh refactor runs claimed,
      // paid for and written to the store straight through it. Checked before
      // claiming, same as there — draining is policy about when to accept new work,
      // not the store's. The other half of the promise — waiting for one already in
      // flight — is `deploy/Makefile`'s own fix, lore-ok[49519bd1] there.
      if (this.store.isDraining()) {
        await sleep(this.cfg.pollMs);
        continue;
      }
      let run;
      try {
        run = this.store.claimRefactorRun();
      } catch (e) {
        console.error(`[lore:log] could not claim a refactor run: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(this.cfg.pollMs);
        continue;
      }
      if (run === undefined) {
        await sleep(this.cfg.pollMs);
        continue;
      }
      // NOT AWAITED, same reasoning as `Worker.dispatch`: the loop's job is to keep
      // claiming, and a burst of requests must start every run at once rather than
      // queue behind whichever was claimed first.
      void this.execute(run);
    }
  }

  /**
   * One run, start to finish, with nothing allowed to escape — mirrors `Worker.round`'s
   * own header exactly, for the identical reason.
   *
   * lore-ok[5348bfb3,bebf7a5b]: found by lore's own review, twice (a stale re-raise
   * and the live one — same code, same finding) — `gitUrlOf` used to sit OUTSIDE any
   * try, and the catch's own `finishRefactorRun` was bare. `execute` is called through
   * `void this.execute(run)` (dispatch, above), detached, with no process-level
   * `unhandledRejection` handler anywhere in this service — so a store fault reaching
   * either (SQLITE_CORRUPT mid-life, or `store.close()` racing a run during shutdown,
   * the exact two `Worker.round`'s own `lore-ok[441a6bc1]` was written against) would
   * have taken the whole process down, every open review included. One outer try
   * around everything; the catch checks `isClosed()` first and wraps its own write
   * again, so a SECOND fault while already handling the first is logged, not thrown.
   */
  private async execute(run: { readonly id: string; readonly repoId: string; readonly commitSha: string; readonly folder: string }): Promise<void> {
    const paths = repoPaths(this.cfg.reposRoot, run.repoId);
    try {
      const gitUrl = this.store.gitUrlOf(run.repoId);
      // `run.id` doubles as the worktree key — unique by construction (`refactor_`
      // prefix, minted once at `refactor_start`), so it cannot collide with a review's
      // own worktree even though both live under the same `paths.worktrees` root.
      const worktree = await worktreeFor(paths, run.id, run.commitSha, gitUrl ?? "");
      try {
        // lore-ok[2f329d31]: found by lore's own review — `worktreeFor` resolves
        // `run.commitSha` (a branch name, routinely) to a real SHA to cut the worktree,
        // then discards it; read back here and stored, so the row says what was
        // actually read rather than what it was asked for.
        const resolvedSha = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
        if (resolvedSha !== "") this.store.setRefactorRunCommit(run.id, resolvedSha);
        const result = await suggestRefactors(
          { store: this.store, repoId: run.repoId, ask: this.ask },
          { folder: run.folder, commit: resolvedSha === "" ? run.commitSha : resolvedSha, worktree, tiers: loadTiers() },
        );
        // lore-ok[7565fe66]: found by lore's own review — `finishRefactorRun(done)`
        // used to run BEFORE `recordRefactorSuggestions`, inverting this codebase's
        // own stated invariant (review.ts: data written before the state that
        // announces it, so a reader woken by the state change can already read what
        // it describes). A crash (or a store fault) between the two writes left a
        // TERMINAL `done` row — `reclaimOrphanedRefactorRuns` only touches
        // `running` — whose `sources` claimed real counts while zero suggestions
        // existed to back them: indistinguishable from the genuine "every tier
        // looked and found nothing" answer `spec/mcp-api.md` §8 defines for an
        // empty list. Suggestions land first now; the state that says they exist
        // is the last write, not the first.
        this.store.recordRefactorSuggestions(run.id, result.suggestions);
        this.store.finishRefactorRun(run.id, {
          state: "done",
          combined: result.combined,
          ...(result.combinerNote === undefined ? {} : { combinerNote: result.combinerNote }),
          sources: result.sources.map((s) => ({
            tier: s.tier,
            ok: s.ok,
            ...(s.error === undefined ? {} : { error: s.error }),
            count: s.suggestions.length,
          })),
        });
      } finally {
        await removeWorktree(paths, run.id).catch((e: unknown) => {
          console.error(`[lore:log] ${run.id}: refactor worktree not released: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (this.store.isClosed()) return;
      try {
        this.store.finishRefactorRun(run.id, { state: "failed", lastError: message });
      } catch (inner) {
        console.error(
          `[lore:log] ${run.id}: refactor run's own failure handling faulted, leaving it 'running' for startup reclaim: ` +
            (inner instanceof Error ? inner.message : String(inner)),
        );
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
