/**
 * The background worker: one job, one round.
 *
 * Reviews outlive an MCP request and there is no way to push a result — MCP
 * servers cannot initiate requests — so work happens here and clients poll. That
 * is not a workaround; it is the only correct shape.
 *
 * A job runs exactly one round and re-enqueues itself if the ladder should
 * continue. Keeping rounds separate means a crash loses one round rather than a
 * whole review, and the state on disk is always a real point in the ladder.
 *
 * SPEC: spec/mcp-api.md §2.4, §5
 */


import { Exhausted, LoreError } from "../core/errors.ts";
import { reviewType } from "../core/review-type.ts";
import { repoPaths, worktreeFor } from "../git/repo.ts";
import { bootstrap } from "../knowledge/bootstrap.ts";
import type { Store } from "../store/store.ts";
import { Alerter, CONDITIONS } from "../ops/alerts.ts";
import { Reviewer, type ReviewerLike } from "../reviewer/opencode.ts";
import { runRound } from "../reviewer/review.ts";

export interface WorkerConfig {
  readonly reposRoot: string;
  readonly runTests: boolean;
  /** How many rounds may run concurrently. CPU-bound on the deployment host. */
  readonly concurrency: number;
  readonly pollMs: number;
}

export const DEFAULT_WORKER: WorkerConfig = {
  reposRoot: "/var/lib/lore/repos",
  runTests: false,
  // T0 is the throughput bottleneck on an ARM SBC (D-37), and it is CPU-bound —
  // so this is set by cores, not by memory.
  concurrency: 2,
  pollMs: 2_000,
};

export class Worker {
  private readonly store: Store;
  private readonly cfg: WorkerConfig;
  private readonly alerter: Alerter;
  private readonly reviewer: ReviewerLike;
  private running = false;
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
    this.running = true;
    const loops = Array.from({ length: this.cfg.concurrency }, () => this.loop());
    void Promise.allSettled(loops);
    return () => {
      this.running = false;
    };
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const job = this.store.claimJob();
      if (job === undefined) {
        await sleep(this.cfg.pollMs);
        continue;
      }
      try {
        await this.runJob(job.reviewId);
        this.store.finishJob(job.id, "done");
        this.note(true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.store.finishJob(job.id, "failed", message);
        // A review that did not run is not a review that found nothing. The state
        // says so, and the client is told so.
        this.store.updateReview(job.reviewId, { state: e instanceof Exhausted ? "failed" : "failed" });
        this.note(false);
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
    const owner = this.store.db
      .prepare("SELECT principal FROM review WHERE id = ?")
      .get(reviewId) as Record<string, string> | undefined;
    const principal = owner?.["principal"] ?? "";
    const review = this.store.getReview(reviewId, principal);
    if (review === undefined) throw new LoreError(`review ${reviewId} vanished`, 70);

    const repo = this.store.db
      .prepare("SELECT git_url FROM repo WHERE id = ?")
      .get(review.repoId) as Record<string, string> | undefined;
    const paths = repoPaths(this.cfg.reposRoot, review.repoId);
    // Cutting a base checks the mirror is present and fresh; reusing one only checks
    // it is present (D-40, D-63). That decision lives in one place because when it
    // lived in two, they disagreed and the disagreement was reachable.
    const worktree = await worktreeFor(paths, reviewId, review.branch, repo?.["git_url"] ?? "");

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
      runTests: this.cfg.runTests,
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
