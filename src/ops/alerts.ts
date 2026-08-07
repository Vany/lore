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
  /** No replica at all is worse than a late one: there is nothing to restore from. */
  backupAbsent: (): Alert => ({
    severity: "page",
    condition: "backup replica missing",
    detail: "replication has never written anything — a restore is impossible right now",
  }),
  // `diskCritical` and `diskWarning` lived here and are gone. A full disk belongs to
  // whoever owns the machine, exactly as a failing test suite belongs to whoever owns
  // the repository (D-71). lore's whole footprint is under 5 GB against a host at
  // 826 GB used — so it was alerting, repeatedly and in red, about somebody else's
  // problem that it could neither cause nor fix.
  //
  // WHAT REPLACES THEM IS THE HALF THAT IS OURS. "under 5 GB" was measured once and
  // written down; it was 6.8 GB two days later, and nothing had noticed because the
  // only thing watching had been deleted along with the thing that was wrong about it.
  // A budget lore sets for itself is a claim it can be held to; the host's percentage
  // never was.
  footprintOverBudget: (bytes: number, budget: number): Alert => ({
    // `ticket`, not `page`: growing past a self-set budget is something to go and look
    // at, not something to wake anybody for. The sweep collects, so this fires when
    // collection is losing rather than when anything has broken.
    severity: "ticket",
    condition: "lore's own footprint is over its budget",
    detail:
      `lore is using ${(bytes / 1e9).toFixed(1)} GB against a ${(budget / 1e9).toFixed(1)} GB budget it sets for ` +
      "itself. The sandbox npm cache is keyed by lockfile so it grows with every distinct one; the retention " +
      "sweep collects what is unused, and this fires when collection is not keeping up. Not the host's disk — " +
      "that belongs to whoever owns the machine.",
  }),
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
  needsHumanAgeing: (count: number, hours: number): Alert => ({
    severity: "ticket",
    condition: "needs_human findings ageing",
    detail: `${count} unresolved for over ${hours}h — these block their reviews from ever passing`,
  }),
} as const;
