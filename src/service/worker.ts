/**
 * The background worker: one job, one round.
 *
 * Reviews outlive an MCP request, so the work happens here rather than inside one.
 * That much was never in question. What was — and was wrong — is the sentence that
 * used to follow it: *"there is no way to push a result, so clients poll"*. There is;
 * `store.updateReview` wakes every subscriber of that review when the STATE changes,
 * and nothing else does — `recordFinding` deliberately publishes nothing (D-80). This
 * loop publishes nothing itself and should not start: it changes reviews through the
 * store, which is the one place that knows about every mutation.
 *
 * A job runs exactly one round and re-enqueues itself if the ladder should
 * continue. Keeping rounds separate means a crash loses one round rather than a
 * whole review, and the state on disk is always a real point in the ladder.
 *
 * SPEC: spec/mcp-api.md §2.4, §5
 */


import { LoreError, ProviderAuthFailed } from "../core/errors.ts";
import { isTerminal } from "../core/review-state.ts";
import { reviewType } from "../core/review-type.ts";
import { removeWorktree, repoPaths, worktreeFor } from "../git/repo.ts";
import { bootstrap } from "../knowledge/bootstrap.ts";
import type { Store } from "../store/store.ts";
import { Alerter, CONDITIONS } from "../ops/alerts.ts";
import { Reviewer, type ReviewerLike } from "../reviewer/opencode.ts";
import { runRound } from "../reviewer/review.ts";

export interface WorkerConfig {
  readonly reposRoot: string;
  readonly pollMs: number;
  /**
   * The day's spend ceiling, passed to every round so it is checked at round boundaries
   * and not only at enqueue (D-93). Absent means unbounded, which is what a CLI wants.
   */
  readonly dailyCeilingUsd?: number;
}

export const DEFAULT_WORKER: WorkerConfig = {
  reposRoot: "/var/lib/lore/repos",
  pollMs: 2_000,
};

export class Worker {
  private readonly store: Store;
  private readonly cfg: WorkerConfig;
  private readonly alerter: Alerter;
  private readonly reviewer: ReviewerLike;
  private running = false;
  /** Rounds started and not yet finished. There is no ceiling on it but admission (D-101). */
  private active = 0;
  private recent: boolean[] = [];

  constructor(store: Store, cfg: WorkerConfig, alerter: Alerter, reviewer: ReviewerLike = new Reviewer()) {
    this.store = store;
    this.cfg = cfg;
    this.alerter = alerter;
    this.reviewer = reviewer;
  }

  start(): () => void {
    // Before any loop claims anything: whatever is still marked `running` belongs to
    // a process that is gone, and left alone it would sit there for ever while the
    // queue looked empty (see `reclaimOrphanedJobs`). Said out loud rather than done
    // quietly — a restart that silently resurrects work is exactly as confusing as
    // one that silently loses it.
    const reclaimed = this.store.reclaimOrphanedJobs();
    if (reclaimed.requeued > 0 || reclaimed.failed > 0) {
      console.error(
        `[lore:log] startup: ${reclaimed.requeued} job(s) requeued and ${reclaimed.failed} failed —` +
          " they were left mid-round by a worker that stopped",
      );
    }
    // A DRAIN MUST NOT SURVIVE THE RESTART IT WAS FOR (D-72).
    //
    // This process is the one the drain was waiting for. If the flag persisted, the
    // new container would start, claim nothing, and answer `/status` with ok: true
    // while the queue grew for ever — healthy and doing nothing, which is the failure
    // this project exists to refuse. Cleared here rather than in the Makefile so that
    // every start path is safe, including a plain `docker compose up`.
    if (this.store.isDraining()) {
      this.store.setDraining(false);
      console.error("[lore:log] startup: cleared a drain flag — this process is the one it was waiting for");
    }
    this.running = true;
    // ONE DISPATCHER, AND EVERY CLAIMED JOB STARTS AT ONCE (D-101).
    //
    // There used to be a fixed pool of loops, each claiming one job and AWAITING the
    // whole round before claiming another — so the Nth+1 review sat in `queued` until
    // somebody finished, however idle the machine was. Vany, twice: *"a job must be
    // picked immediately"*, and then, of the knob that set the pool size, *"there is no
    // such thing as LORE_CONCURRENCY"*.
    //
    // So there is no pool. The dispatcher claims as fast as jobs exist and starts each
    // round without waiting for it, which is what makes `queued` a state a review passes
    // THROUGH rather than one it sits in. The only bound left is admission: 128 open
    // reviews, refused at the door where a client can see it (D-98).
    //
    // ITS DEATH IS A PAGE, and that matters more now than it did with a pool. A pool
    // degraded — N loops to N-1 to zero, with `/healthz` still answering ok. This is
    // one thread of control, so losing it stops ALL claiming at once; the body below
    // therefore catches everything it can, and this catch is the last resort rather
    // than the expected path.
    void this.dispatch().catch((e: unknown) => {
      const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(`[lore:log] the dispatcher stopped: ${detail}`);
      if (this.running) void this.alerter.send(CONDITIONS.workerLoopDied(0, detail));
    });
    return () => {
      this.running = false;
    };
  }

  /** Rounds running right now — for `/status`, and for knowing the dispatcher is alive. */
  inFlight(): number {
    return this.active;
  }

  private async dispatch(): Promise<void> {
    while (this.running) {
      // THE CLAIM ITSELF CAN THROW, and it used to take the loop with it. The guard
      // below covers everything a round does; `isDraining()` and `claimJob()` are store
      // calls that sit outside it, so a locked database or a full disk killed this loop
      // — and the capacity it represented — without stopping the process. A fault here
      // is reported and slept through, because the alternative is a service that
      // quietly runs at reduced concurrency and eventually at none.
      let job;
      try {
        // Draining: finish what is in flight, take nothing new. Checked before claiming
        // rather than inside `claimJob`, so the store stays a store and the policy of
        // when to stop working lives with the thing that works.
        if (this.store.isDraining()) {
          await sleep(this.cfg.pollMs);
          continue;
        }
        job = this.store.claimJob();
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error(`[lore:log] could not claim work: ${detail}`);
        await this.alerter.send(CONDITIONS.workerLoopDied(0, detail));
        await sleep(this.cfg.pollMs);
        continue;
      }
      if (job === undefined) {
        await sleep(this.cfg.pollMs);
        continue;
      }
      // NOT AWAITED — that is the whole change. Awaiting here is what made a queue.
      // The loop goes straight back to claiming, so a burst of ten reviews starts ten
      // rounds rather than one and nine waits.
      this.active += 1;
      void this.round(job).finally(() => {
        this.active -= 1;
      });
    }
  }

  /**
   * One round, start to finish, with nothing allowed to escape.
   *
   * Everything here used to run inline in the loop, where a throw would have been caught
   * by the loop's own guard. Detached, an escaping rejection is an unhandled one — it
   * would take the process down, or worse be swallowed by a handler that logs and
   * continues while this review is left `running` for ever.
   */
  private async round(job: { id: number; reviewId: string }): Promise<void> {
    {
      try {
        await this.runJob(job.reviewId);
        this.store.finishJob(job.id, "done");
        await this.releaseIfFinished(job.reviewId);
        this.note(true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.store.finishJob(job.id, "failed", message);
        // A review that did not run is not a review that found nothing. The state
        // says so, and the client is told so.
        //
        // One state, not a choice. This read `e instanceof Exhausted ? "failed" :
        // "failed"` — a ternary whose arms are identical, which looks like a
        // distinction being drawn and draws none. Quota is handled where it can be
        // acted on: the ladder marks that tier unpayable and steps over it (D-48), so
        // an `Exhausted` reaching HERE means nothing was left that could read the code,
        // and that is a plain failure like any other.
        //
        // A REVIEW THAT ALREADY ENDED KEEPS THE ENDING IT WAS GIVEN. Some of what lands
        // here is the round refusing to spend on a review somebody stopped — the terminal
        // check before the tier, and the gate guard when a queued call finally gets its
        // slot. Both throw, and writing `failed` over `cancelled` would replace a person's
        // decision, and their recorded reason, with a word that means the opposite: not
        // "we stopped this" but "we could not read the code". The client is then told the
        // review did not run and to consider retrying, about a review it deliberately
        // ended. `failed` is for a review that was still wanted.
        const current = this.store.stateOf(job.reviewId);
        if (current === undefined || !isTerminal(current)) {
          this.store.updateReview(job.reviewId, { state: "failed" });
        }
        await this.releaseIfFinished(job.reviewId);
        this.note(false);

        // One review failing is a log line; a rejected credential is not one review.
        // It stops every review at that tier until a person replaces the key, so it
        // pages rather than waiting for the failing-as-a-class window to fill — by
        // which time ten more reviews have been spent proving the same thing.
        if (e instanceof ProviderAuthFailed) {
          await this.alerter.send(CONDITIONS.providerAuthFailed(e.provider));
        }
        await this.alerter.send({
          severity: "log",
          condition: "review round failed",
          detail: `${job.reviewId}: ${message}`,
        });
      }
    }
  }

  private async runJob(reviewId: string): Promise<void> {
    // The principal is on the row; the worker acts for whoever owns the review.
    const principal = this.store.principalOf(reviewId) ?? "";
    const review = this.store.getReview(reviewId, principal);
    if (review === undefined) throw new LoreError(`review ${reviewId} vanished`, 70);

    const gitUrl = this.store.gitUrlOf(review.repoId);
    const paths = repoPaths(this.cfg.reposRoot, review.repoId);
    // Cutting a base checks the mirror is present and fresh; reusing one only checks
    // it is present (D-40, D-63). That decision lives in one place because when it
    // lived in two, they disagreed and the disagreement was reachable.
    const worktree = await worktreeFor(paths, reviewId, review.branch, gitUrl ?? "");

    this.store.updateReview(reviewId, { state: "running" });

    // Bootstrap on first mirror, not at provisioning (D-35).
    //
    // `make new` records the repo and mints a token; it does not fetch, because lore
    // holds no credentials for a remote (D-63). The mirror arrives later, when a
    // human runs `make mirror`, so at provisioning time there is nothing to read.
    // The first review is the first moment the code is actually readable, and a
    // repo with no knowledge is exactly the one that most needs it.
    //
    // The reason outlived two rewordings of how the mirror arrives. What has never
    // changed is that it is not here at provisioning time.
    if (this.store.knowledgeFor(review.repoId, undefined, 1).length === 0) {
      const summary = await bootstrap({
        store: this.store,
        repoId: review.repoId,
        worktree,
        reviewer: this.reviewer,
      }).catch((e: unknown) => {
        // Never fatal: a review without a bootstrapped memory is a worse review,
        // not an impossible one. But it is said out loud rather than swallowed.
        void this.alerter.send({
          severity: "ticket",
          condition: "bootstrap failed",
          detail: `${review.repoId}: ${e instanceof Error ? e.message : String(e)}`,
        });
        return undefined;
      });
      if (summary !== undefined) {
        console.error(
          `lore: bootstrapped ${review.repoId} — ${summary.rulesFromDocs} rules from ${summary.documents} docs, ${summary.factsFromCode} facts from code`,
        );
      }
    }

    const type = reviewType(review.type);
    const result = await runRound({
      store: this.store,
      reviewer: this.reviewer,
      reviewId,
      principal,
      worktree,
      type,
      ...(this.cfg.dailyCeilingUsd === undefined ? {} : { dailyCeilingUsd: this.cfg.dailyCeilingUsd }),
    });

    switch (result.decision.kind) {
      case "fastClean":
        // Cheap tiers clean. The deep tiers continue asynchronously, and the client
        // collects them later — but `fast_clean` is never reported as a pass.
        this.store.enqueue(reviewId, "deep");
        break;
      case "escalate":
        // The decision carries the tier we are moving to; its stage decides which
        // queue. (This previously looked up a tier whose id equalled the decision
        // KIND, which never matched and only worked by falling through to "deep".)
        this.store.enqueue(reviewId, result.decision.next.stage);
        break;
      default:
        // findings / passed / needsHuman / stopped all wait for the client.
        break;
    }
  }

  /**
   * Give back a finished review's worktree, now rather than in a week (D-70).
   *
   * A terminal review's worktree serves nothing: the tree hash is already recorded,
   * attestation reads only the store, and `review_submit` refuses a finished review
   * outright. It was held for seven days by the retention sweep — so on 2026-08-05,
   * sixteen finished reviews were still holding worktrees, the oldest for two days,
   * on a disk at 88%.
   *
   * Here rather than only in the sweep because an hour of lag is an hour of disk, and
   * a failing review is exactly when they arrive in bursts. The sweep stays as the
   * backstop for anything this misses — a crash between the state write and this
   * line, or a review that reached a terminal state by another path.
   *
   * Never fatal. A worktree that cannot be removed is a disk problem to report, not a
   * reason to fail a review that has already finished.
   */
  private async releaseIfFinished(reviewId: string): Promise<void> {
    const at = this.store.repoAndStateOf(reviewId);
    if (at === undefined || !isTerminal(at.state)) return;

    const paths = repoPaths(this.cfg.reposRoot, at.repoId);
    await removeWorktree(paths, reviewId).catch((e: unknown) => {
      void this.alerter.send({
        severity: "log",
        condition: "worktree not released",
        detail: `${reviewId}: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
  }

  /** Reviews failing as a class is systematic, not one bad branch. */
  private note(ok: boolean): void {
    this.recent.push(ok);
    if (this.recent.length > 20) this.recent.shift();
    const failed = this.recent.filter((r) => !r).length;
    if (this.recent.length >= 10 && failed >= this.recent.length / 2) {
      void this.alerter.send(CONDITIONS.reviewsFailingAsAClass(failed, this.recent.length));
      this.recent = [];
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
