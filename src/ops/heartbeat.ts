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
  readonly at: string;
}

export async function checkHealth(store: Store, cfg: HeartbeatConfig): Promise<Health> {
  const midnight = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const replica = await replicaState(cfg);
  const needsHumanOverAge = store.needsHumanOlderThan(cfg.needsHumanAgeHours);

  const problems: string[] = [];
  if (replica.state === "absent") problems.push("replica missing");
  if (replica.state === "behind") problems.push(`replica ${Math.round((replica.behindSec ?? 0) / 60)}m behind`);

  return {
    ok: problems.length === 0,
    problems,
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
async function replicaState(cfg: HeartbeatConfig): Promise<{ state: ReplicaState; behindSec?: number }> {
  if (cfg.backupDir === undefined) return { state: "unconfigured" };

  const newest = await newestMtime(cfg.backupDir);
  if (newest === undefined) return { state: "absent" };

  const changed = await databaseChangedAt(cfg.dataDir);
  if (changed === undefined) return { state: "unconfigured" };

  const behindSec = Math.max(0, Math.round((changed - newest) / 1000));
  return behindSec > REPLICA_BEHIND_SEC ? { state: "behind", behindSec } : { state: "level", behindSec };
}

/**
 * When the database last changed — **the WAL counts, and it is usually the only
 * thing that moves.**
 *
 * The store runs in WAL mode (`store/schema.ts`), so a write lands in `lore.db-wal`
 * and `lore.db`'s own mtime advances only on CHECKPOINT. Reading the main file alone
 * made this monitor blind in precisely the case it was built for: litestream dies,
 * writes continue into a WAL that has not reached SQLite's ~1000-page autocheckpoint
 * threshold — and knowledge rows are small, so that is the ordinary case — the
 * replica's newest segment freezes, `lore.db`'s mtime is older still, `behindSec`
 * clamps to zero, and every beat reports `level, ok: true, no page` for hours while
 * knowledge is written and replicated nowhere.
 *
 * Raised by Kimi on its first review round, against the commit that introduced the
 * monitor. Observed on the live deployment while confirming it: `lore.db` stamped
 * 18:56 against a newest replica segment of 22:58 — four hours apart, in the wrong
 * direction, reported as level. It was *correct* only because litestream was alive;
 * the arithmetic could not tell either way.
 *
 * `-shm` is deliberately not consulted: it is shared-memory coordination, rewritten
 * for reasons that are not writes, so including it would report change where there
 * was none — the opposite error, and just as blind.
 */
async function databaseChangedAt(dataDir: string): Promise<number | undefined> {
  const db = await stat(join(dataDir, "lore.db")).catch(() => undefined);
  if (db === undefined) return undefined;
  const wal = await stat(join(dataDir, "lore.db-wal")).catch(() => undefined);
  return Math.max(db.mtimeMs, wal?.mtimeMs ?? 0);
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

  void beat();
  const timer = setInterval(() => void beat(), cfg.intervalMs);
  // Do not hold the process open for a heartbeat.
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
