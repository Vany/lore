/**
 * The deadman.
 *
 * **Push-only alerting cannot detect its own death.** If the alerter breaks, "no
 * alerts" and "everything is fine" become the same observation — which is INV-1 at
 * the operations layer, and this project exists because four reviews once failed
 * silently in one day.
 *
 * So the service emits a heartbeat on a fixed interval and devops alerts on its
 * **absence**. That inverts the failure mode: a dead service, a dead network, a
 * dead alerter and a full disk then all produce the same *visible* symptom —
 * silence where a beat should be — instead of the same invisible one.
 *
 * SPEC: spec/operations.md §3
 */

import { statfs } from "node:fs/promises";
import type { Store } from "../store/store.ts";
import { Alerter, CONDITIONS } from "./alerts.ts";

export interface HeartbeatConfig {
  /** Where the beat is sent. Whatever consumes it must alert when it stops. */
  readonly url?: string;
  readonly intervalMs: number;
  readonly dataDir: string;
  readonly diskWarnPct: number;
  readonly diskPagePct: number;
  readonly queueWarnDepth: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatConfig = {
  intervalMs: 60_000,
  dataDir: "/var/lib/lore",
  diskWarnPct: 75,
  diskPagePct: 90,
  queueWarnDepth: 50,
};

export interface Health {
  readonly ok: boolean;
  readonly queueDepth: number;
  readonly diskUsedPct: number;
  readonly spendToday: number;
  readonly at: string;
}

export async function checkHealth(store: Store, cfg: HeartbeatConfig): Promise<Health> {
  const midnight = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  return {
    ok: true,
    queueDepth: store.queueDepth(),
    diskUsedPct: await diskUsedPct(cfg.dataDir),
    spendToday: store.spendSince(midnight),
    at: new Date().toISOString(),
  };
}

async function diskUsedPct(dir: string): Promise<number> {
  try {
    const s = await statfs(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return total === 0 ? 0 : Math.round(((total - free) / total) * 100);
  } catch {
    return 0;
  }
}

/**
 * Start beating. Returns a stop function.
 *
 * The beat itself carries the health snapshot, so a consumer can alert on *content*
 * as well as on silence — but silence is the signal that matters, because it is the
 * only one that survives the alerter being broken.
 */
export function startHeartbeat(store: Store, cfg: HeartbeatConfig, alerter: Alerter): () => void {
  let stopped = false;

  const beat = async (): Promise<void> => {
    if (stopped) return;
    const health = await checkHealth(store, cfg);

    if (health.diskUsedPct >= cfg.diskPagePct) {
      await alerter.send(CONDITIONS.diskCritical(health.diskUsedPct));
    } else if (health.diskUsedPct >= cfg.diskWarnPct) {
      await alerter.send(CONDITIONS.diskWarning(health.diskUsedPct));
    }
    if (health.queueDepth >= cfg.queueWarnDepth) {
      await alerter.send(CONDITIONS.queueBacked(health.queueDepth));
    }

    if (cfg.url !== undefined) {
      await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(health),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {
        // Deliberately silent here. A failed beat is exactly what the far end is
        // watching for; shouting about it locally adds nothing it can act on.
      });
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), cfg.intervalMs);
  // Do not hold the process open for a heartbeat.
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
