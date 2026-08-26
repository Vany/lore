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
import { MAX_MIRROR_AGE_MS, mirrorFreshness } from "../git/repo.ts";
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
  /**
   * How long a HIGH finding may sit uncollected before somebody is told.
   *
   * TWENTY-FOUR, the same as `needsHumanAgeHours`, because the two are the same failure
   * seen from opposite ends — a review waiting on a person, and a person who stopped
   * waiting on a review. Shorter would fire over a weekend; much longer and the review
   * is already dimming toward `findings_stale` at 48h, which is the point of no return
   * this is meant to come before.
   */
  readonly uncollectedAgeHours: number;
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
  uncollectedAgeHours: 24,
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
  /** Reviews holding a HIGH finding no client has collected (see `uncollectedAgeHours`). */
  readonly uncollectedOverAge: number;
  readonly at: string;
}

/**
 * Registered repositories whose mirror is too old for a review to be cut from it.
 *
 * The same `mirrorFreshness` and `MAX_MIRROR_AGE_MS` the refusal uses — a monitor that
 * reimplements the predicate it monitors ends up disagreeing with it, which is how a
 * "stale" that refuses nothing and a "fresh" that refuses everything both become
 * possible.
 *
 * Never-fetched is NOT stale: a repository provisioned a minute ago has no mirror yet and
 * that is an ordinary state with its own message at review time.
 */
async function staleMirrorNames(store: Store, dataDir: string): Promise<readonly string[]> {
  const out: string[] = [];
  for (const repo of store.repos()) {
    const fresh = await mirrorFreshness(join(dataDir, "repos", repo.id, "bare.git")).catch(() => undefined);
    if (fresh?.kind !== "fetched") continue;
    if (Date.now() - fresh.at.getTime() > MAX_MIRROR_AGE_MS) out.push(repo.name);
  }
  return out;
}

export async function checkHealth(store: Store, cfg: HeartbeatConfig): Promise<Health> {
  // FIRST, AND ACTUALLY FIRST. On 2026-08-07 this database became unreadable — every
  // statement, including `sqlite_master`, answering `database disk image is malformed` —
  // and nothing noticed for twenty minutes. It surfaced because `make mirror` happened
  // to fail. `/status` was answering at the time, said `ok: false` for an unrelated and
  // WRONG reason, and had no opinion at all about the one fault that ends the service.
  //
  // A health check that reports on the queue and the replica while never asking whether
  // the data is there is INV-1 at the top of the stack: the thing that did not run
  // reported as the thing that found nothing. It costs 7ms against the live file.
  //
  // It was written third, under a comment saying FIRST, and the comment was the part that
  // mattered: `replicaState` calls `store.lastWriteAt()` and `needsHumanOlderThan` runs a
  // query, both on the LIVE handle, and both throw on a malformed database. So mid-run
  // corruption made `checkHealth` reject before ever reaching the one check that would
  // have named the cause — the caller got an exception where it should have got
  // `ok: false, problems: ["DATABASE UNREADABLE: …"]`.
  //
  // `integrityFault` opens a FRESH read-only connection and returns rather than throwing,
  // which is exactly why it can go first and why everything after it may assume nothing.
  const fault = store.integrityFault();
  if (fault !== undefined) {
    // RETURNED HERE, not merely recorded. Every remaining reader touches the live handle
    // and would throw; a report that dies while assembling itself tells nobody anything.
    return {
      ok: false,
      problems: [`DATABASE UNREADABLE: ${fault}`],
      queueDepth: 0,
      spendToday: 0,
      replica: "unconfigured",
      needsHumanOverAge: 0,
      uncollectedOverAge: 0,
      at: new Date().toISOString(),
    };
  }

  const midnight = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const replica = await replicaState(store, cfg);
  const needsHumanOverAge = store.needsHumanOlderThan(cfg.needsHumanAgeHours);
  const uncollectedOverAge = store.uncollectedHighOlderThan(cfg.uncollectedAgeHours);

  const problems: string[] = [];
  // A STALE MIRROR REFUSES EVERY REVIEW, and nothing here knew.
  //
  // `assertFresh` refuses a review cut from a mirror older than MAX_MIRROR_AGE_MS (D-65),
  // because reviewing a stale tree describes code nobody is merging. The refresher is a
  // HOST process lore cannot see or start — so when it stops, every review stops, and
  // `/status` went on answering `ok: true` because it only ever asked about the queue,
  // the replica and the database.
  //
  // That happened for seventeen hours on 2026-08-08: the registry moved into a volume,
  // the refresher went on reading the old path, and a customer's review was refused for
  // a mirror 1026 minutes old while the service called itself healthy. `make status`
  // showed it in red the whole time — but that is a command a person runs, and the whole
  // point of the beat is to say it unprompted.
  const staleMirrors = await staleMirrorNames(store, cfg.dataDir);
  if (staleMirrors.length > 0) {
    problems.push(
      `mirror stale: ${staleMirrors.join(", ")} — every review of these is REFUSED until the host ` +
        "refresher runs again",
    );
  }
  // Read from cache; a stale one refreshes in the background. Never awaited — see the
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
    uncollectedOverAge,
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

/** How long a `newestMtime` result may be reused before a fresh walk is required. */
const MTIME_CACHE_MS = 15_000;
let mtimeCache: { dir: string; at: number; value: number | undefined } | undefined;

/**
 * Newest mtime anywhere under a directory, or undefined if it holds no files.
 *
 * CACHED for MTIME_CACHE_MS — found by lore's own review, fingerprint 29321591: this
 * walk stats every file under the directory, uncached, and runs on every 60s beat AND
 * every incoming /status request (service/http.ts calls `checkHealth` directly).
 * litestream's replica is configured to grow for 30 days at a 10s sync cadence
 * (deploy/litestream.yml's own retention and sync-interval), and spec/operations.md
 * §2.5 already records this shape of cost taking a status endpoint down once. An
 * operator's own /status call during an outage — the worst possible moment to make the
 * health check itself slow — now reuses whatever the periodic beat already found
 * seconds earlier instead of re-walking. Keyed by directory rather than unconditional:
 * a real deployment has exactly one backupDir, but every test builds its own fresh
 * temp directory, so one test's cached value can never be read by another.
 */
async function newestMtime(dir: string): Promise<number | undefined> {
  const now = Date.now();
  if (mtimeCache !== undefined && mtimeCache.dir === dir && now - mtimeCache.at < MTIME_CACHE_MS) {
    return mtimeCache.value;
  }
  let newest: number | undefined;
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => undefined);
  if (entries !== undefined) {
    for (const e of entries) {
      if (!e.isFile()) continue;
      const s = await stat(join(e.parentPath, e.name)).catch(() => undefined);
      if (s !== undefined && (newest === undefined || s.mtimeMs > newest)) newest = s.mtimeMs;
    }
  }
  mtimeCache = { dir, at: now, value: newest };
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
  /** Latched so the one permanent fault pages once, not on every beat. */
  let pagedUnreadable = false;
  /**
   * `ae4dc75d`: found by lore's own review, the SAME shape as `pagedUnreadable` a line
   * up, unfixed on the two conditions right beside it. A replica outage can last hours
   * — this is the channel guarding the product itself, and a page a minute for the life
   * of the outage is the exact wolf-crying `pagedUnreadable`'s own comment exists to
   * name. Two latches, not one: `absent` and `behind` are different facts (`ReplicaState`
   * is a single value, so they cannot both hold at once, but the transition between them
   * is still worth a fresh page), and each resets the moment its own condition stops
   * holding, so a NEW outage of either kind speaks again.
   */
  let pagedReplicaAbsent = false;
  let pagedReplicaBehind = false;
  /**
   * Latched for the same reason, and it was NOT and that was a defect worth the comment.
   *
   * The beat runs every 60s and this condition stands until a person acts, so an unlatched
   * ticket meant one abandoned review posting to the webhook every minute for as long as it
   * lasted. A channel that repeats itself 1,400 times a day is a channel nobody reads,
   * which is the failure mode this whole alerting table is written to avoid.
   *
   * Latched on the COUNT, not on a boolean: going from one uncollected review to two is
   * new information and should speak; the same one for the ninth hour is not.
   */
  let toldUncollected = 0;
  /**
   * `eb3d53ea`: found by lore's own review — the IDENTICAL defect `toldUncollected`
   * just above was fixed for, unfixed one condition over. `needsHumanOverAge` stands
   * for as long as nobody resolves the conflict — a review once sat parked until it
   * was swept as `expired`, which is 24h past this threshold before the sweep even
   * starts the clock (`staleHours`) — so the unlatched send below posted the same
   * ticket on every 60s beat for as long as it lasted: up to 1,440 copies of one
   * alert in a day, the exact wolf-crying this file's comment names as the failure
   * this whole table exists to avoid. Same count-based latch, same reasoning.
   */
  let toldNeedsHumanAgeing = 0;
  /**
   * `452c4a7a`: found by lore's own review — the same shape a third time in this one
   * function. `queueWarnDepth` is a threshold a genuine CPU-bound backlog can sit
   * above for hours (the condition's own words: "T0 is the bottleneck"), so this
   * ticket repeated itself on every beat for the life of the backlog. Count-based,
   * same as `toldUncollected`: a backlog getting WORSE is new information and should
   * speak again; the same depth on the ninth minute is not. Reset once it clears
   * below the threshold, so a later backlog is not suppressed by a stale high-water
   * mark from hours earlier.
   */
  let toldQueueDepth = 0;
  let stopped = false;
  const startedAt = Date.now();

  const beat = async (): Promise<void> => {
    if (stopped) return;
    // 8fe4d3ee: EVERYTHING BELOW, WRAPPED — found by lore's own review. This used to
    // run with nothing catching it, called as `void beat().finally(schedule)` with no
    // `.catch` anywhere in the chain: `.finally` runs on rejection too but does not
    // swallow it, so a throw from any store read below (a closed handle during
    // shutdown, SQLITE_BUSY past the write lock) escaped as an unhandled rejection —
    // which by default takes the WHOLE PROCESS down, every in-flight review round
    // with it. `service/worker.ts`'s `round` documents fixing the identical shape:
    // "Detached, an escaping rejection is an unhandled one... the honest unit is the
    // ROUND". The honest unit here is the BEAT. Swallowed rather than re-thrown,
    // matching the design already stated a few lines down for the fetch step alone
    // ("a failed beat is exactly what the far end is watching for") — a beat that
    // cannot complete is not fatal, it is silence, and silence is the ONE signal this
    // whole file exists to make someone notice (the deadman, §3): a beat that fails
    // the same way every time stops reaching the fetch below, which is exactly the
    // missed-heartbeat page already designed to catch it, at no risk to the process
    // that everything else in this service depends on staying up.
    try {
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

      // THE FAULT THAT ENDS THE SERVICE, PAGED FROM THE BEAT TOO — AND ONCE.
      //
      // `CONDITIONS.databaseUnreadable` existed only on the startup-refusal path, so a
      // database that went bad WHILE RUNNING put the words in `/status` and paged nobody —
      // and `/status` is a thing a person has to think to look at. This is the beat's whole
      // purpose: to say it unprompted. First, and returning, because everything below reads
      // a health report whose other fields are placeholders on this path.
      //
      // ONCE, because the startup path says "pages once" and a beat repeats for ever. A
      // corrupt database does not heal, so every subsequent beat would re-send the same
      // page — the alert channel filled by the one condition it exists for, until whoever
      // is on the other end mutes it. Latched rather than rate-limited: the condition is
      // binary and permanent until a person restores, so "again" carries no information.
      // The latch clears if the database becomes readable, so a restore re-arms it.
      if (health.problems.some((p) => p.startsWith("DATABASE UNREADABLE"))) {
        if (!pagedUnreadable) {
          pagedUnreadable = true;
          await alerter.send(CONDITIONS.databaseUnreadable(health.problems[0] ?? "unreadable"));
        }
        return;
      }
      pagedUnreadable = false;

      if (health.queueDepth >= cfg.queueWarnDepth) {
        if (health.queueDepth > toldQueueDepth) {
          toldQueueDepth = health.queueDepth;
          await alerter.send(CONDITIONS.queueBacked(health.queueDepth));
        }
      } else if (toldQueueDepth > 0) {
        // The backlog cleared. Re-arm, so a fresh one speaks again.
        toldQueueDepth = 0;
      }

      // The knowledge base IS the product and this device has no redundancy, so these
      // are pages. Both were dead conditions until now: `spec/operations.md` §2.1 has
      // listed the replica under "someone should look now" the whole time, and nothing
      // ever sent it — the only replica check lived in `make status`, which is a command
      // a human runs, and a page nobody is paged by is not a page.
      if (health.replica === "absent" && !replicaGrace) {
        if (!pagedReplicaAbsent) {
          pagedReplicaAbsent = true;
          await alerter.send(CONDITIONS.backupAbsent());
        }
      } else {
        pagedReplicaAbsent = false;
      }
      if (health.replica === "behind") {
        if (!pagedReplicaBehind) {
          pagedReplicaBehind = true;
          await alerter.send(CONDITIONS.backupBehind(Math.round((health.replicaBehindSec ?? 0) / 60)));
        }
      } else {
        pagedReplicaBehind = false;
      }

      // A ticket, not a page: one review parked on a question is normal, a pile of them
      // ageing means nobody is answering, and every one of them blocks a review from
      // ever passing (spec/knowledge.md §7.2).
      if (health.needsHumanOverAge > toldNeedsHumanAgeing) {
        toldNeedsHumanAgeing = health.needsHumanOverAge;
        await alerter.send(CONDITIONS.needsHumanAgeing(health.needsHumanOverAge, cfg.needsHumanAgeHours));
      } else if (health.needsHumanOverAge < toldNeedsHumanAgeing) {
        // Somebody decided, or a document re-ingest closed the conflict (D-20). Re-arm,
        // so the next one to age past the threshold speaks.
        toldNeedsHumanAgeing = health.needsHumanOverAge;
      }

      // THE SAME FAILURE FROM THE OTHER END. `needs_human` is a review waiting on a person;
      // this is a person who stopped waiting on a review. Both end with a paid deep tier's
      // work concluding nothing, and until now only the first had a channel — the second was
      // on the operator board, which is read by the one party who cannot act on it.
      if (health.uncollectedOverAge > toldUncollected) {
        toldUncollected = health.uncollectedOverAge;
        await alerter.send(CONDITIONS.findingsUncollected(health.uncollectedOverAge, cfg.uncollectedAgeHours));
      } else if (health.uncollectedOverAge < toldUncollected) {
        // Somebody collected, or the sweep took it. Re-arm, so the next one speaks.
        toldUncollected = health.uncollectedOverAge;
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
    } catch (e) {
      console.error(`[lore:log] heartbeat: a beat could not complete: ${e instanceof Error ? e.message : String(e)}`);
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
