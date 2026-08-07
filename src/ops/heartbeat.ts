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

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "../store/store.ts";
import { Alerter, CONDITIONS } from "./alerts.ts";

export interface HeartbeatConfig {
  /** Where the beat is sent. Whatever consumes it must alert when it stops. */
  readonly url?: string;
  readonly intervalMs: number;
  readonly dataDir: string;
  /** Litestream's replica folder, if this deployment mounts it. See `replicaState`. */
  readonly backupDir?: string;
  readonly queueWarnDepth: number;
  readonly needsHumanAgeHours: number;
  /** Grace before an empty replica folder pages. See `REPLICA_GRACE_MS`. */
  readonly replicaGraceMs: number;
  /**
   * How much disk lore may use for itself before it says so.
   *
   * **The half of the disk question that IS ours.** The host-percentage alerts were
   * removed on the right argument — a full disk belongs to whoever owns the machine
   * (D-71) — and the comment that replaced them recorded "lore's whole footprint is
   * under 5 GB" as though that were stable. It was 6.8 GB two days later, because the
   * sandbox npm cache is keyed by lockfile and grows with every distinct one, and
   * nothing noticed: the only thing watching had been deleted along with what was wrong
   * about it.
   *
   * Ten gigabytes is a budget rather than a limit, chosen against the 6.8 GB observed
   * and the fourteen-day collection now in the sweep. It warns; it never refuses a
   * review, because running out of disk is the operator's to act on and a review
   * stopped by a guess is worse than one that runs.
   */
  readonly footprintBudgetBytes: number;
}

/**
 * How far the replica may trail the database before it is called behind.
 *
 * `deploy/Makefile`'s `replica-state` implements the same predicate in shell, because
 * `make status` has to answer while the service is DOWN — which is exactly when a dead
 * replicator would otherwise go unnoticed, so it cannot be a call into this process.
 * Two implementations, one number: `one-definition.test.ts` reads the Makefile and
 * fails if the two disagree.
 */
export const REPLICA_BEHIND_SEC = 300;

/**
 * How long after startup an empty replica folder is not yet an emergency.
 *
 * litestream starts after lore and syncs on its own schedule, and Docker creates the
 * bind path if it is missing — so "no replica yet" is the normal first seconds of
 * every deploy. Paging on that would train the operator to mute the one alert that
 * guards the product, which is the whole of D-59's lesson.
 *
 * `ok`/`problems` are NOT held back by this: `/status` should say the replica is
 * missing the moment it is, because a person reading it is asking right now. Only the
 * unsolicited page waits.
 */
const REPLICA_GRACE_MS = 5 * 60_000;

export const DEFAULT_HEARTBEAT: HeartbeatConfig = {
  intervalMs: 60_000,
  dataDir: "/var/lib/lore",
  queueWarnDepth: 50,
  needsHumanAgeHours: 24,
  replicaGraceMs: REPLICA_GRACE_MS,
  footprintBudgetBytes: 10 * 1e9,
};

/** Four answers, not two — see `replicaState`. */
export type ReplicaState = "unconfigured" | "absent" | "behind" | "level";

export interface Health {
  /**
   * COMPUTED, never a literal.
   *
   * It was `true` unconditionally for this service's whole life, including on the same
   * beat that paged for a critical disk — and the comment beside `/status`'s build
   * stamp complains that this endpoint "said ok: true" while the deployment ran 21
   * commits behind. That fix added the stamp and left the constant. A health field
   * that cannot say no is decoration a reader believes.
   *
   * False when any PAGE-severity condition holds. `problems` names them, because
   * `ok: false` with nothing beside it is the same ambiguity pointing the other way.
   */
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly queueDepth: number;
  readonly spendToday: number;
  readonly replica: ReplicaState;
  /** Seconds the database is ahead of the replica. Absent when there is nothing to compare. */
  readonly replicaBehindSec?: number;
  readonly needsHumanOverAge: number;
  /** What lore is using for itself, and whether that is more than it budgeted. */
  readonly footprintBytes?: number;
  readonly footprintOverBudget: boolean;
  readonly at: string;
}

/**
 * Bytes under lore's own data directory.
 *
 * Best-effort and NOT counted as a problem when it cannot be read: a footprint nobody
 * could measure must not read as a footprint of zero, which is how the previous disk
 * check managed to be both noisy and blind.
 */
async function footprintBytes(dataDir: string): Promise<number | undefined> {
  const entries = await readdir(dataDir, { withFileTypes: true, recursive: true }).catch(() => undefined);
  if (entries === undefined) return undefined;
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const s = await stat(join(e.parentPath, e.name)).catch(() => undefined);
    total += s?.size ?? 0;
  }
  return total;
}

export async function checkHealth(store: Store, cfg: HeartbeatConfig): Promise<Health> {
  const midnight = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const replica = await replicaState(store, cfg);
  const needsHumanOverAge = store.needsHumanOlderThan(cfg.needsHumanAgeHours);

  const problems: string[] = [];
  // FIRST, AND ON EVERY BEAT. On 2026-08-07 this database became unreadable — every
  // statement, including `sqlite_master`, answering `database disk image is malformed` —
  // and nothing noticed for twenty minutes. It surfaced because `make mirror` happened
  // to fail. `/status` was answering at the time, said `ok: false` for an unrelated and
  // WRONG reason, and had no opinion at all about the one fault that ends the service.
  //
  // A health check that reports on the queue and the replica while never asking whether
  // the data is there is INV-1 at the top of the stack: the thing that did not run
  // reported as the thing that found nothing. It cost 7ms against the live file.
  const fault = store.integrityFault();
  if (fault !== undefined) problems.push(`DATABASE UNREADABLE: ${fault}`);
  const footprint = await footprintBytes(cfg.dataDir);
  const overBudget = footprint !== undefined && footprint > cfg.footprintBudgetBytes;
  if (replica.state === "absent") problems.push("replica missing");
  if (replica.state === "behind") problems.push(`replica ${Math.round((replica.behindSec ?? 0) / 60)}m behind`);

  return {
    ok: problems.length === 0,
    problems,
    ...(footprint === undefined ? {} : { footprintBytes: footprint }),
    footprintOverBudget: overBudget,
    queueDepth: store.queueDepth(),
    spendToday: store.spendSince(midnight),
    replica: replica.state,
    ...(replica.behindSec === undefined ? {} : { replicaBehindSec: replica.behindSec }),
    needsHumanOverAge,
    at: new Date().toISOString(),
  };
}

/**
 * Is the replica caught up with the database?
 *
 * **Behind, never "not written recently"** (D-59). litestream writes only when there is
 * something to replicate, so an idle database and a dead replicator look identical
 * under a freshness test — and the freshness form cried wolf the first time it
 * mattered, on a replica that was perfectly level.
 *
 * `unconfigured` is honest rather than green: a deployment that does not mount the
 * replica folder cannot be asked this question, and answering "fine" would be a claim
 * about something nobody looked at.
 */
async function replicaState(store: Store, cfg: HeartbeatConfig): Promise<{ state: ReplicaState; behindSec?: number }> {
  if (cfg.backupDir === undefined) return { state: "unconfigured" };

  const newest = await newestMtime(cfg.backupDir);
  if (newest === undefined) return { state: "absent" };

  // WHEN LORE LAST WROTE, not when the files were last touched. See `lastWriteAt`: a
  // restart moves `lore.db-wal`'s mtime with no transaction behind it, and that read as
  // fourteen minutes behind on a replica litestream reported level at the same second.
  // Nothing to compare means nothing has ever been written, which is level by any
  // reading — a fresh deployment is not a backup emergency.
  const wrote = store.lastWriteAt();
  if (wrote === undefined) return { state: "level", behindSec: 0 };
  const changed = Date.parse(wrote);
  if (!Number.isFinite(changed)) return { state: "unconfigured" };

  const behindSec = Math.max(0, Math.round((changed - newest) / 1000));
  return behindSec > REPLICA_BEHIND_SEC ? { state: "behind", behindSec } : { state: "level", behindSec };
}

/** Newest mtime anywhere under a directory, or undefined if it holds no files. */
async function newestMtime(dir: string): Promise<number | undefined> {
  let newest: number | undefined;
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => undefined);
  if (entries === undefined) return undefined;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const s = await stat(join(e.parentPath, e.name)).catch(() => undefined);
    if (s !== undefined && (newest === undefined || s.mtimeMs > newest)) newest = s.mtimeMs;
  }
  return newest;
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
  const startedAt = Date.now();

  const beat = async (): Promise<void> => {
    if (stopped) return;
    const health = await checkHealth(store, cfg);
    // litestream is a SIBLING container that starts after this one and syncs on its
    // own interval, so on a fresh deployment the replica folder is legitimately empty
    // for the first moments — Docker creates it if the host path does not exist. A
    // page on the first beat of every deploy is the wolf-crying failure D-59 is about,
    // earned back in the very check written to avoid it.
    //
    // Only `absent` is held back. `behind` already requires a replica to exist and to
    // have fallen behind, which cannot describe a service that has just started.
    const replicaGrace = Date.now() - startedAt < cfg.replicaGraceMs;

    if (health.queueDepth >= cfg.queueWarnDepth) {
      await alerter.send(CONDITIONS.queueBacked(health.queueDepth));
    }

    // The knowledge base IS the product and this device has no redundancy, so these
    // are pages. Both were dead conditions until now: `spec/operations.md` §2.1 has
    // listed the replica under "someone should look now" the whole time, and nothing
    // ever sent it — the only replica check lived in `make status`, which is a command
    // a human runs, and a page nobody is paged by is not a page.
    // The half of the disk question that is ours. See `footprintBudgetBytes`.
    if (health.footprintOverBudget) {
      await alerter.send(CONDITIONS.footprintOverBudget(health.footprintBytes ?? 0, cfg.footprintBudgetBytes));
    }
    if (health.replica === "absent" && !replicaGrace) await alerter.send(CONDITIONS.backupAbsent());
    else if (health.replica === "behind") {
      await alerter.send(CONDITIONS.backupBehind(Math.round((health.replicaBehindSec ?? 0) / 60)));
    }

    // A ticket, not a page: one review parked on a question is normal, a pile of them
    // ageing means nobody is answering, and every one of them blocks a review from
    // ever passing (spec/knowledge.md §7.2).
    if (health.needsHumanOverAge > 0) {
      await alerter.send(CONDITIONS.needsHumanAgeing(health.needsHumanOverAge, cfg.needsHumanAgeHours));
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

  // SINGLE-FLIGHT, not an interval. `setInterval(() => void beat())` fires again
  // whether or not the last beat finished — and a beat does I/O: it reads the replica
  // state off disk and POSTs to a deadman with a 10s timeout. On a slow disk or a
  // hanging endpoint, beats pile up, each holding its own timeout, and the far end
  // receives a burst that says nothing about the interval it was meant to measure.
  // Awaiting each one and scheduling the next from its completion makes the period a
  // floor rather than a promise, which is the honest shape for a health signal.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void beat().finally(schedule);
    }, cfg.intervalMs);
    // Do not hold the process open for a heartbeat.
    timer.unref?.();
  };
  void beat().finally(schedule);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
