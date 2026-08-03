/**
 * Telling devops when the service itself is sick.
 *
 * Two audiences, two channels, never blended (D-41/D-42). Developers are alerted
 * by their own client — `lore` returns information and the client decides what
 * deserves an alarm, which is also the only implementable design since MCP servers
 * cannot initiate requests. This file is the *other* channel: about the service,
 * never about a review.
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

/** The routing table from spec/operations.md §2, as data. */
export const CONDITIONS = {
  backupStale: (hours: number): Alert => ({
    severity: "page",
    condition: "backup replication stale",
    detail: `no replication for ${hours}h — the knowledge base IS the product, and this device has no redundancy`,
  }),
  diskCritical: (pct: number): Alert => ({
    severity: "page",
    condition: "disk critical",
    detail: `${pct}% used — worktrees and node_modules caches grow without bound`,
  }),
  diskWarning: (pct: number): Alert => ({
    severity: "ticket",
    condition: "disk filling",
    detail: `${pct}% used`,
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
