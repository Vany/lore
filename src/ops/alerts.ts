/**
 * Telling devops when the service itself is sick.
 *
 * Two audiences, two channels, never blended (D-41/D-42). Developers are alerted
 * by their own client — `lore` returns information and the client decides what
 * deserves an alarm. That used to be the only implementable design too, on the
 * grounds that MCP servers cannot initiate requests; since D-80 lore *can* wake a
 * subscribed client, and the split survives on its own merit: waking a client is not
 * the same as declaring something urgent, and urgency is the client's call. This file
 * is the *other* channel: about the service, never about a review.
 *
 * One review failing is a log line. Reviews failing **as a class** is an alert.
 *
 * SPEC: spec/operations.md
 */

export type Severity = "page" | "ticket" | "log";

export interface Alert {
  readonly severity: Severity;
  readonly condition: string;
  readonly detail: string;
}

export interface AlertConfig {
  /** Generic outbound webhook: Slack, Alertmanager, Plane, or a shell script. */
  readonly webhookUrl?: string;
  readonly timeoutMs: number;
}

export class Alerter {
  private readonly cfg: AlertConfig;

  constructor(cfg: AlertConfig) {
    this.cfg = cfg;
  }

  async send(alert: Alert): Promise<void> {
    // Always local first. If the webhook is unreachable this is the only record —
    // and the far end notices anyway, because the heartbeat stops arriving.
    const line = `[lore:${alert.severity}] ${alert.condition} — ${alert.detail}`;
    if (alert.severity === "page") console.error(line);
    else console.warn(line);

    if (this.cfg.webhookUrl === undefined || alert.severity === "log") return;

    try {
      await fetch(this.cfg.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...alert, service: "lore", at: new Date().toISOString() }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      // Never throw from alerting: a broken alerter must not also break the thing
      // it was watching. Its own silence is what the deadman detects.
      console.error(`[lore:log] alert webhook failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * The routing table from spec/operations.md §2, as data.
 *
 * Every member here must have a caller. Three of them did not for the whole of this
 * service's life — `backupStale`, `providerAuthFailed` and `needsHumanAgeing` — while
 * `spec/operations.md` §2.1 listed two of them under *page, someone should look now*.
 * `one-definition.test.ts` passed throughout, because it asks whether the exported
 * CONTAINER is read and `CONDITIONS` is read by three modules. It checks members now.
 */
export const CONDITIONS = {
  /**
   * Measured as BEHIND THE DATABASE, never as "not written recently" (D-59).
   *
   * The freshness form is what this used to be, and it is why the host-side check was
   * rewritten: litestream writes only when there is something to replicate, so an idle
   * database and a dead replicator are identical under a freshness test. It cried wolf
   * the first time it mattered — the newest replica file and the last write to
   * `lore.db` carried the same timestamp to the second, and the monitor called it
   * stale. A page that fires on a healthy service gets muted, and this one guards the
   * product.
   */
  backupBehind: (minutes: number): Alert => ({
    severity: "page",
    condition: "backup replica behind the database",
    detail:
      `the database has changed and the replica has not, for ${minutes}m — the knowledge base IS ` +
      "the product, and this device has no redundancy",
  }),
  /**
   * A worker loop stopped, and the process did not.
   *
   * The per-job guard catches everything a round can throw; `isDraining()` and
   * `claimJob()` sit outside it, so a store-layer fault — a locked database, a full
   * disk — killed the loop, and its rejection went to a discarded `allSettled`.
   * Concurrency then falls silently from N to N-1 to zero while `/healthz` answers ok
   * and `/status` reports `ok: true`: a service that has stopped working and says it is
   * fine. Pages, because nothing else in the system can notice it.
   */
  workerLoopDied: (remaining: number, detail: string): Alert => ({
    severity: "page",
    condition: "a worker loop stopped claiming work",
    detail:
      `${remaining} loop(s) still running. The process is alive and healthy-looking, so nothing else will ` +
      `report this — at zero, reviews queue for ever and every client waits on a service that answers ok. ${detail}`,
  }),
  /**
   * A review the client was told is `queued`, which no worker will ever claim.
   *
   * `review_start` writes the row, answers `state: "queued"`, and enqueues afterwards —
   * so a throw between those two leaves a review with NO JOB, and nothing reconciles
   * that: `reclaimOrphanedJobs` frees jobs stuck `running`, not reviews that never got
   * one. The client polls something no worker can see, until the sweep calls it
   * `expired` two days later, which reads as *nobody came back*.
   *
   * Pages, for the same reason `workerLoopDied` does: the service is alive, `/status`
   * says `ok: true`, and nothing else in the system can notice one missing job.
   */
  reviewNotQueued: (reviewId: string, stage: string, why: string): Alert => ({
    severity: "page",
    condition: "review accepted but not queued",
    detail:
      `${reviewId} (${stage}) was answered 'queued' and could not be enqueued: ${why}. It is marked failed ` +
      "rather than left waiting, so the client's next poll says so — but a review that cannot be queued at " +
      "all usually means the database is refusing writes, and the next one will fail the same way.",
  }),
  /**
   * A configured quota fallback that opencode cannot reach (D-93).
   *
   * `ticket`, not `page`: nothing is broken yet, and the ladder without a fallback is the
   * one lore ran for its whole life — an exhausted tier is skipped and its work promoted
   * (D-48). What is broken is a PLAN. Somebody configured this so an exhausted
   * subscription would not cost a tier, and it will not do that; the discovery would
   * otherwise happen at the moment the subscription runs out, look like the provider
   * being down, and be diagnosed as anything but a typo in a tiers file.
   */
  fallbackUnavailable: (missing: readonly string[]): Alert => ({
    severity: "ticket",
    condition: "a configured quota fallback is not available",
    detail:
      `opencode cannot reach ${missing.join(", ")}. The ladder still works — an exhausted tier is skipped and ` +
      "its work promoted — but the fallback that was configured to prevent that will not happen. Check the " +
      "model id against `/config/providers`, and that the provider has credentials.",
  }),
  /** No replica at all is worse than a late one: there is nothing to restore from. */
  backupAbsent: (): Alert => ({
    severity: "page",
    condition: "backup replica missing",
    detail: "replication has never written anything — a restore is impossible right now",
  }),
  // `diskCritical`, `diskWarning` and `footprintOverBudget` all lived here and are all
  // gone. The host's disk went first, on the argument in D-71: a full disk belongs to
  // whoever owns the machine, exactly as a failing test suite belongs to whoever owns the
  // repository — lore was alerting, repeatedly and in red, about somebody else's problem
  // that it could neither cause nor fix.
  //
  // The self-footprint budget replaced it and was removed for the same reason on
  // 2026-08-12, on Vany's call: *"it is not lore's responsibility."* The argument that
  // kept it — that lore's own growth IS lore's to watch — is true about the growth and
  // false about the alert. Disk on this machine is the operator's to size and the
  // operator's to act on, and lore knowing a number does not make it the one who acts.
  // What it produced instead was a ticket firing on every beat for a threshold nobody
  // had agreed to, which is how a channel that should carry real faults gets ignored.
  //
  // What ACTUALLY bounds the growth stays, and it is not an alert: the retention sweep
  // collects unused worktrees and caches on a schedule. A number that nobody is going to
  // act on is not monitoring.
  providerAuthFailed: (provider: string): Alert => ({
    severity: "page",
    condition: "provider auth failed",
    detail: `${provider} rejected our credentials — every review stops at once`,
  }),
  spendCeiling: (spent: number, ceiling: number): Alert => ({
    severity: "page",
    condition: "daily spend ceiling hit",
    detail: `$${spent.toFixed(2)} of $${ceiling.toFixed(2)} — no new reviews will start`,
  }),
  spendAnomaly: (spent: number, typical: number): Alert => ({
    severity: "ticket",
    condition: "spend anomaly",
    detail: `$${spent.toFixed(2)} today against a typical $${typical.toFixed(2)}`,
  }),
  reviewsFailingAsAClass: (failed: number, total: number): Alert => ({
    severity: "page",
    condition: "reviews failing as a class",
    detail: `${failed} of the last ${total} failed — this is systematic, not one bad branch`,
  }),
  queueBacked: (depth: number): Alert => ({
    severity: "ticket",
    condition: "queue depth sustained",
    detail: `${depth} reviews waiting — T0 is CPU-bound on this host and is the bottleneck`,
  }),
  /**
   * The database cannot be read, so lore is serving a refusal and nothing else.
   *
   * The one fault that ends the service outright, and the one that had no alert. It went
   * unnoticed for twenty minutes on 2026-08-07 because `make mirror` happened to fail,
   * and on 2026-08-08 it crash-looped the process — so the heartbeat that had just been
   * taught to check integrity never got a beat in. Pages, and pages FIRST: every review
   * handle in the system is unreachable, and none of them passed.
   */
  databaseUnreadable: (fault: string): Alert => ({
    severity: "page",
    condition: "database unreadable — lore is refusing to serve",
    detail:
      `${fault}. No review is running and none can start; the worker, heartbeat and sweep are stopped ` +
      "so nothing writes further into a damaged file. Restore it: `make backup-check`, then `make restore`. " +
      "This does not clear by itself and lore will not retry.",
  }),
  needsHumanAgeing: (count: number, hours: number): Alert => ({
    severity: "ticket",
    condition: "needs_human findings ageing",
    detail: `${count} unresolved for over ${hours}h — these block their reviews from ever passing`,
  }),
} as const;
