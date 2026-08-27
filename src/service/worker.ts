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
import { decidedByPersonOrClock, isTerminal } from "../core/review-state.ts";
import { reviewType } from "../core/review-type.ts";
import { removeWorktree, repoPaths, worktreeFor } from "../git/repo.ts";
import { bootstrap } from "../knowledge/bootstrap.ts";
import type { Store } from "../store/store.ts";
import { Alerter, CONDITIONS } from "../ops/alerts.ts";
import { Reviewer, type ReviewerLike } from "../reviewer/opencode.ts";
import { CancelledByLore, ServiceUnreachable } from "../core/errors.ts";
import { consumeHeldDiffs, runRound } from "../reviewer/review.ts";
export interface WorkerConfig {
  readonly reposRoot: string;
  readonly pollMs: number;
  /**
   * Whether a fallback chain may walk onto a route that bills per call (D-117).
   *
   * Passed to every round because that is where the chain is walked. Absent means NO —
   * a deployment that has not said yes to spending money does not spend money.
   */
  readonly allowMetered?: boolean;
}

export const DEFAULT_WORKER: WorkerConfig = {
  reposRoot: "/var/lib/lore/repos",
  pollMs: 2_000,
};

/**
 * How often kept model sessions are reconciled against review state (D-80).
 *
 * A minute is chosen against what it is cleaning up: a session that outlives its review by
 * up to sixty seconds costs nothing, and the sweep it backstops runs hourly. Making it
 * tighter would mean a store query per kept review per tick for no benefit; making it
 * looser would let a burst of expiries sit.
 *
 * Zero at construction, deliberately, so the FIRST tick after a start reconciles — a
 * restart is exactly when the map and reality can disagree.
 */
const RECONCILE_EVERY_MS = 60_000;

export class Worker {
  private readonly store: Store;
  private readonly cfg: WorkerConfig;
  private readonly alerter: Alerter;
  private readonly reviewer: ReviewerLike;
  private running = false;
  /** Rounds started and not yet finished. There is no ceiling on it but admission (D-101). */
  private active = 0;
  private recent: boolean[] = [];
  /** When the session reconcile last finished, and whether one is in flight (D-80). */
  private reconciledAt = 0;
  private reconciling = false;

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
      // ON A CLOCK, NOT ON IDLENESS (D-80). The first version of this ran only in the
      // branch `claimJob` takes when it finds NOTHING — and a busy service never finds
      // nothing, which is exactly when sessions pile up: reviews expire while other
      // reviews keep the queue full, the idle branch is never reached, and the backstop
      // built for the retention sweep silently never runs. A backstop that only works
      // when nothing is happening is not a backstop.
      //
      // NOT AWAITED, for the same reason a round is not: this loop's job is to claim work,
      // and it must never wait on network I/O to do it. `reconcileSessions` guards against
      // overlapping itself.
      void this.maybeReconcile();

      let job;
      try {
        // Draining: finish what is in flight, take nothing new. Checked before claiming
        // rather than inside `claimJob`, so the store stays a store and the policy of
        // when to stop working lives with the thing that works.
        if (this.store.isDraining()) {
          await sleep(this.cfg.pollMs);
          continue;
        }
        // DRAINING IS THE ONLY REASON THIS LOOP DECLINES WORK (D-121).
        //
        // A spend ceiling used to sit here too, and it stopped claiming for the rest of
        // the UTC day once a total crossed $100 — which meant one batch's bill suspended
        // the gate for everybody. Money no longer decides what runs; what a metered route
        // may do is settled per call, before the call, in `core/metered.ts` (D-117).
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
        // THE STORE IS GONE — STOP, rather than pick through it write by write.
        //
        // `88ca976` guarded three WRITES and missed that everything around them READS:
        // `repoAndStateOf` below, `stateOf` in the catch, `heldDiffs`, `hasOpenJob`. A
        // closed handle throws on those exactly as it did on the writes, so the crash it
        // was written to remove survived it — and on the failure path the throw comes
        // from INSIDE the catch, escaping a promise that is detached by `void this.round`
        // with no `unhandledRejection` handler anywhere. A guard per call site was the
        // wrong shape: the honest unit is the ROUND, which has nothing left to do once
        // the process is going down. The job row stays `running` and startup requeues it.
        if (this.store.isClosed()) return;
        this.store.finishJob(job.id, "done");
        // A SUBMIT CAN DECIDE TO HOLD AT ANY INSTANT UP TO THE LINE ABOVE — it sees
        // this job still `running` right until finishJob commits — so a diff can land
        // in the gap after runJob's own sweep and sit orphaned for ever behind a
        // "held — you do not need to resubmit" promise. Checked after the row closes,
        // because SQLite gives the ordering for free: a hold written before that
        // commit is visible to this read; one written after takes the synchronous
        // path and needs nothing from us. NOT CONSUMED HERE — the job row was the
        // one-writer mutex over the worktree and it is gone, so a claimed next round
        // or a sync-path submit may already be writing (raised by lore's own t2, with
        // history: the second time this file has grown that exact race). A ROUND is
        // the consumer: enqueue one and its first boundary applies the diff under its
        // own job. Skipped when a job is already queued or running — that round will
        // do the consuming itself.
        {
          const st = this.store.repoAndStateOf(job.reviewId);
          if (
            st !== undefined &&
            !decidedByPersonOrClock(st.state) &&
            this.store.heldDiffs(job.reviewId).length > 0 &&
            !this.store.hasOpenJob(job.reviewId)
          ) {
            this.store.updateReview(job.reviewId, { state: "queued" });
            this.store.enqueue(job.reviewId, "fast");
          }
        }
        await this.releaseIfFinished(job.reviewId);
        this.note(true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Same reason as the success path, and this one is sharper: every read below
        // runs INSIDE a catch, so a throw here escapes `round()` itself rather than
        // being handled — an unhandled rejection out of a detached promise, in exactly
        // the deploy window this whole guard exists for.
        if (this.store.isClosed()) return;

        // lore-ok[441a6bc1]: EVERYTHING BELOW, WRAPPED AGAIN — found by lore's
        // own review. `isClosed()` above catches only the CLOSED flavour of
        // this window (a flag `close()` sets); a database that is merely
        // CORRUPTED — SQLITE_CORRUPT mid-life, the same event this file's own
        // history names above — still reports `isClosed() === false` and every
        // one of `requeueJob`/`repoAndStateOf`/`finishJob`/`stateOf`/
        // `setFailureReason` below throws on it exactly as the success path's
        // reads did before `88ca976`/this comment's own fix. A second store
        // fault while already handling the first is the identical unhandled-
        // rejection shape out of the same detached `void this.round(...)`
        // (line 189) — swallowed here rather than escaping, on the same
        // reasoning `isClosed()` already accepts: the job row stays `running`
        // and startup requeues it.
        try {
        // LORE WENT AWAY MID-ROUND — requeue, do not end the review (D-104).
        //
        // "Drop the sessions and restore after restart" only restored half of them. A
        // round whose job was left `running` is requeued at startup by
        // `reclaimOrphanedJobs`; a round far enough along to CATCH the error wrote
        // `failed` and stayed there. A deploy — and then my own crash loop — ended two of
        // the team's reviews that way, with `socket hang up` and `could not reach
        // opencode`, and both had to be revived by hand.
        //
        // Bounded, because a sidecar that is genuinely down rather than restarting would
        // otherwise loop for ever. Past the bound it fails like anything else, saying why.
        if (e instanceof ServiceUnreachable && this.store.requeueJob(job.id, message)) {
          console.error(`[lore:log] ${job.reviewId}: requeued — lore's own opencode went away mid-round: ${message}`);
          return;
        }

        // A STOP LORE CAUSED IS NOT A ROUND OUTCOME. A cancel or a superseding restart
        // aborts the session mid-read; the review that ends that way already has its
        // ending (cancelled — somebody decided), and writing "failed" over it — or
        // booking the abort as the tier's shortfall — manufactures evidence about a
        // provider that did nothing. Ended review: the job closes quietly. Live review
        // (a shutdown window, a release that overshot): requeued, nothing was learned.
        if (e instanceof CancelledByLore) {
          const st = this.store.repoAndStateOf(job.reviewId);
          if (st === undefined || isTerminal(st.state)) {
            this.store.finishJob(job.id, "done", `stopped by lore because the review ended: ${message}`);
            console.error(`[lore:log] ${job.reviewId}: round stopped with the review — not a failure`);
          } else if (this.store.requeueJob(job.id, message)) {
            console.error(`[lore:log] ${job.reviewId}: requeued — lore stopped its own call on a live review`);
          } else {
            this.store.finishJob(job.id, "failed", message);
          }
          return;
        }

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
          // AND WHY, on the channel the client actually reads.
          //
          // This wrote `failed` and nothing else: the reason went to `job.last_error`,
          // a column no client can reach, so `failed_because` stayed NULL and a poll
          // returned a dead review with no account of itself. Every LADDER stop is
          // explained (`stoppedBecause` writes one) while every CRASH — the case a
          // client can least guess at — was silent, which is backwards. Found when a
          // review died on a base branch that did not exist and the only way to learn
          // that was a SQL query against the job table.
          //
          // Written BEFORE the state, so a subscriber woken by the change can already
          // read it; translated at the MCP boundary by `forClient`, which is where the
          // raw operator text is turned into something a client can act on.
          this.store.setFailureReason(job.reviewId, message);
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
        } catch (inner) {
          console.error(
            `[lore:log] ${job.reviewId}: round's own failure handling faulted, leaving the job for startup reclaim: ` +
              (inner instanceof Error ? inner.message : String(inner)),
          );
        }
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
        // lore-ok[c5df90ef]: was omitted — found by lore's own review. `review.intoRef`
        // is already on the row loaded above; bootstrap needs it for the same reason
        // every ordinary round does (D-10 via ingestDocs, `53969ab8`).
        intoRef: review.intoRef,
        // lore-ok[96ce9a48]: also omitted — found by lore's own review, against
        // spec/knowledge.md §2.2's explicit requirement that a screen session
        // started by a review can be cancelled with it, "still true of the
        // provisioning screen". Same shape as `runRound`'s own `stillWanted` below.
        reviewId,
        stillWanted: () => !isTerminal(this.store.getReview(reviewId, principal)?.state ?? review.state),
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
      ...(this.cfg.allowMetered === undefined ? {} : { allowMetered: this.cfg.allowMetered }),
      // SO A PAID ROUTE CAN REACH A PERSON. The round writes the per-call figure to the
      // log either way; this is the channel somebody who is not watching the log reads,
      // and it fires once a day at most (D-117).
      alerter: this.alerter,
    });

    // A DIFF HELD DURING THE ROUND'S LAST TURN (D-107). The stream consumes holds at
    // every emission boundary, but one can land after the final boundary — the model
    // declared done while the client was still typing. Consumed HERE, while this job
    // still holds the review: the `running` row is the one-writer mutex over the
    // worktree, and consuming after finishJob raced the very round the decision
    // switch below enqueues — claimable the instant the row closes, reading a tree
    // mid-patch (raised by lore's own t2, twice, against two versions of this).
    // Tracks whether the mismatch branch just below already wrote a decision this job's
    // own ending must not override — see the `rungStillStale` block that follows it.
    let mismatchHandled = false;
    {
      const st = this.store.repoAndStateOf(reviewId);
      if (st !== undefined && !decidedByPersonOrClock(st.state) && this.store.heldDiffs(reviewId).length > 0) {
        const consumed = await consumeHeldDiffs(this.store, reviewId, worktree);
        if (consumed.mismatch !== undefined) {
          this.store.setFailureReason(reviewId, consumed.mismatch);
          this.store.updateReview(reviewId, { state: "awaiting_diff" });
          mismatchHandled = true;
        } else if (consumed.applied > 0) {
          // The client-work signal for this diff was recorded inside `consumeHeldDiffs`,
          // which every held diff passes through — this sweep no longer has to remember
          // to do it, which is exactly how it was missed the first time (D-114).
          this.store.updateReview(reviewId, { state: "queued" });
          this.store.enqueue(reviewId, "fast");
          // AND NOTHING ELSE ENQUEUES THIS ROUND. The decision switch below would add a
          // SECOND job for the same review — `fastClean` a deep one, `escalate` the next
          // tier's — so a late-landing diff bought two queued rounds where the client
          // asked for one: both claimable, both spending, and the ladder advanced by
          // whichever finished last. The diff just applied is the newer truth and the
          // round it enqueues reads it; the decision computed against the PRE-diff tree
          // is stale by construction.
          return;
        }
      }
    }

    // A RUNG MEMBER'S SESSION STILL TRAILS THE TREE (D-109, fingerprint 83d84e62). The
    // catch-up loop's own pass cap can leave this true with `heldDiffs` already EMPTY —
    // the hold that left a member behind was consumed by a SIBLING's own boundary mid
    // pass, so the sweep above finds nothing to apply and never fires. Requeued the
    // identical way: a silent next round, reading whatever tree everyone is caught up to
    // from a fresh pass 0, rather than the verdict this round just wrote standing over a
    // tree one member never actually read. Skipped when the mismatch branch above already
    // wrote `awaiting_diff` — that decision is the more urgent one and must not be
    // overwritten by a staleness check that ran against the same stale round.
    if (!mismatchHandled && result.rungStillStale) {
      const st = this.store.repoAndStateOf(reviewId);
      if (st !== undefined && !decidedByPersonOrClock(st.state)) {
        this.store.updateReview(reviewId, { state: "queued" });
        this.store.enqueue(reviewId, "fast");
        return;
      }
    }

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
   * Run the reconcile if it is due, and never more than one at a time (D-80).
   *
   * The interval is the whole reason this is separate from the loop: the reconcile is a
   * store query per kept review plus a network DELETE for each orphan, and the claim loop
   * runs every couple of seconds.
   */
  private async maybeReconcile(): Promise<void> {
    if (this.reconciling || Date.now() - this.reconciledAt < RECONCILE_EVERY_MS) return;
    this.reconciling = true;
    try {
      await this.reconcileSessions();
    } catch (e) {
      // lore-ok[f487b406]: found by lore's own review. The call site (dispatch,
      // above) is `void this.maybeReconcile()` with no `.catch` — reconcileSessions
      // reads and writes the store synchronously (keptSessionKeys by way of
      // reviewer.keptReviews, repoAndStateOf, clearSessionTrees), and any of them
      // throwing on a closed or corrupted database used to escape as an unhandled
      // rejection and take the whole process down, the same shape already fixed
      // this round for round()'s own catch block one function above and for
      // board-stream's tick. `finally` below already reschedules the next
      // attempt RECONCILE_EVERY_MS out regardless of success, so skipping here
      // costs one cycle, not the backstop itself.
      console.error(
        `[lore:log] session reconcile faulted, skipping this cycle: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      // STAMPED AFTER, not before: a reconcile that took longer than the interval would
      // otherwise be eligible again the moment it finished, and under a slow opencode
      // this loop would do nothing else.
      this.reconciledAt = Date.now();
      this.reconciling = false;
    }
  }

  /**
   * End kept sessions belonging to reviews that are no longer open (D-80).
   *
   * **A BACKSTOP FOR THE PATHS THAT DO NOT COME THROUGH HERE.** `releaseIfFinished` runs
   * when a JOB finishes, and `cancel` releases its own — but a review can go terminal with
   * no job running at all, and the 48-hour retention sweep is exactly that: it marks
   * abandoned reviews `expired` in SQL, and nothing in that path has ever heard of a model
   * session. A review left in `findings_ready` therefore held its sessions until opencode
   * restarted.
   *
   * Written as a reconcile rather than a call added to the expiry path because the next
   * terminal path nobody thinks of gets collected too. That is not hypothetical here: the
   * session map is new, and every existing way a review can end predates it.
   *
   * A review that has VANISHED — deleted by retention — releases as well: `repoAndStateOf`
   * returns undefined, which is not "still open".
   */
  private async reconcileSessions(): Promise<void> {
    for (const reviewId of this.reviewer.keptReviews?.() ?? []) {
      const at = this.store.repoAndStateOf(reviewId);
      if (at !== undefined && !isTerminal(at.state)) continue;
      // lore-ok[63846152]: right that this was the ONLY caller, and fixed at the two
      // endings it could never see rather than here. `releaseIfFinished` now clears
      // before it releases, and `review_cancel` clears after it aborts — so the common
      // paths sweep themselves. This call stays as the backstop it was always meant to
      // be: the ending with no job and no cancel, which is the retention sweep marking a
      // findings_ready review `expired` in SQL, and which neither of those two reaches.
      // lore-ok[7b5a314a]: the same finding at a lower severity. Same answer.
      // RELEASE FIRST, CLEAR SECOND — the order matters now and did not before.
      //
      // `clearSessionTrees` deletes the `session-id:` rows as well (D-122), and after a
      // restart those rows are the ONLY record of which opencode sessions this review
      // holds: the in-memory map is empty by design. Clearing first therefore deleted the
      // ids and left `release` enumerating nothing, so no DELETE ever reached opencode and
      // the sessions lived until opencode itself restarted — the exact accumulation
      // `release` exists to prevent, on the one path this reconcile is the backstop for.
      await this.reviewer.release?.(reviewId).catch((e: unknown) => {
        void this.alerter.send({
          severity: "log",
          condition: "orphaned model session not released",
          detail: `${reviewId}: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
      // AND ONLY NOW the rows go, once `release` has read the ids out of them.
      this.store.clearSessionTrees(reviewId);
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
  // lore-ok[b6e3f0e8]: the finding is real and is fixed, but not here — this method is
  // only ONE of the three things that release a session, and the other two are where the
  // gap was. `Reviewer.cancel` now releases before it aborts, which covers `review_cancel`
  // on a review with no job in flight (the case its early `return false` used to skip);
  // and `reconcileSessions` above runs on a timer in the claim loop, which covers the
  // retention sweep marking a review `expired` in SQL and anything else that ends a review
  // without a job. On a TIMER rather than on the loop's idle branch, because a service
  // with a full queue never goes idle and that is exactly when expiries pile up.
  // Deliberately NOT fixed at this call site: this one is correct as it stands — it
  // releases when a job reaches a terminal state — and widening it could not have reached
  // either path, because neither runs a job at all.
  private async releaseIfFinished(reviewId: string): Promise<void> {
    const at = this.store.repoAndStateOf(reviewId);
    if (at === undefined || !isTerminal(at.state)) return;

    // THE SESSION-TREE RECORDS GO WITH THE SESSIONS THEY DESCRIBE (D-108). They were
    // cleared only by `reconcileSessions`, which iterates the sessions opencode still
    // holds — but `release` below empties that map, and `Reviewer.cancel` empties it
    // too, so the reconcile 60s later sees nothing and the meta rows are never swept
    // for the two endings that account for almost every review. One row-set per
    // (review, tier) left behind for the life of the database, by the function whose
    // whole job is housekeeping for a review that ended. Cleared HERE, where the
    // review's ending is already known, and left in the reconcile as the backstop for
    // endings that never reach a job at all.
    // RELEASE BEFORE CLEARING, because `clearSessionTrees` now deletes the `session-id:`
    // rows too (D-122) and after a restart those are the only record of which sessions
    // this review holds — the in-memory map is empty by design. Clearing first left
    // `release` with nothing to enumerate and the opencode sessions alive for ever.
    //
    // THE MODEL SESSIONS TOO, and they are new (D-80). A tier with `conversation` on keeps
    // one session for the whole review and nothing clears it per round — that is the
    // point. So this is the only thing that ends them, and without it admission's 128 open
    // reviews become up to 384 sessions opencode holds for work that finished hours ago.
    //
    // Beside the worktree rather than anywhere else, because it is the same fact: this
    // review is over, and everything it was holding goes back.
    await this.reviewer.release?.(reviewId).catch((e: unknown) => {
      void this.alerter.send({
        severity: "log",
        condition: "model session not released",
        detail: `${reviewId}: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
    // AND ONLY NOW the rows go — see above.
    this.store.clearSessionTrees(reviewId);

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
