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

  private async execute(run: { readonly id: string; readonly repoId: string; readonly commitSha: string; readonly folder: string }): Promise<void> {
    const gitUrl = this.store.gitUrlOf(run.repoId);
    const paths = repoPaths(this.cfg.reposRoot, run.repoId);
    try {
      // `run.id` doubles as the worktree key — unique by construction (`refactor_`
      // prefix, minted once at `refactor_start`), so it cannot collide with a review's
      // own worktree even though both live under the same `paths.worktrees` root.
      const worktree = await worktreeFor(paths, run.id, run.commitSha, gitUrl ?? "");
      try {
        const result = await suggestRefactors(
          { store: this.store, repoId: run.repoId, ask: this.ask },
          { folder: run.folder, commit: run.commitSha, worktree, tiers: loadTiers() },
        );
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
        this.store.recordRefactorSuggestions(run.id, result.suggestions);
      } finally {
        await removeWorktree(paths, run.id).catch((e: unknown) => {
          console.error(`[lore:log] ${run.id}: refactor worktree not released: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } catch (e) {
      this.store.finishRefactorRun(run.id, { state: "failed", lastError: e instanceof Error ? e.message : String(e) });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
