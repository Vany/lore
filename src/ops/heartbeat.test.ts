/**
 * The alerting path had no test at all, which is why three of its nine conditions
 * were dead for the service's whole life while `spec/operations.md` §2.1 listed two
 * of them under *page, someone should look now*.
 *
 * These assert the CONSEQUENCE — that an alert is sent, that `ok` can be false —
 * rather than that the condition table contains an entry. A test named for a property
 * it does not test is worse than no test (PROG.md), and the check that was supposed to
 * catch this asked whether `CONDITIONS` had a reader, which it did.
 */

import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { Alerter, type Alert } from "./alerts.ts";
import {
  DEFAULT_HEARTBEAT,
  REPLICA_BEHIND_SEC,
  checkHealth,
  startHeartbeat,
} from "./heartbeat.ts";

let store: Store;
let dir: string;
let sent: Alert[];
let alerter: Alerter;

/**
 * Wait for an alert to arrive, rather than racing a fixed sleep.
 *
 * These tests started the heartbeat, slept 20ms and asserted. That held while a beat was
 * a couple of SQL reads — and stopped holding the moment the beat grew an integrity
 * check (a fresh connection) and a footprint walk (the whole data directory). One test
 * went flaky under full-suite load on the same day those landed: green alone, green on
 * a re-run, red once in a while, which is the shape that teaches people to re-run
 * instead of read.
 *
 * A timeout that is generous and a condition that is exact: the assertion still fails
 * if the alert never comes, and it no longer fails because the machine was busy.
 */
const until = async (ready: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
};

/** Captures what would have gone to the webhook. No network, no config to forget. */
class Capturing extends Alerter {
  override async send(a: Alert): Promise<boolean> {
    sent.push(a);
    return Promise.resolve(true);
  }
}

beforeEach(() => {
  store = new Store(":memory:");
  dir = mkdtempSync(join(tmpdir(), "lore-beat-"));
  writeFileSync(join(dir, "lore.db"), "x");
  sent = [];
  alerter = new Capturing({ timeoutMs: 10 });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function cfg(over: Partial<typeof DEFAULT_HEARTBEAT> = {}) {
  return { ...DEFAULT_HEARTBEAT, dataDir: dir, ...over };
}

/**
 * Record a write in the store, at a given age.
 *
 * The predicate reads lore's OWN timestamps rather than file mtimes (see
 * `Store.lastWriteAt`), because SQLite touches `lore.db-wal` on open and on checkpoint
 * and a restart therefore looked like fourteen minutes of replication lag on a replica
 * litestream reported level at the same second.
 */
const wroteAgo = (agoSec: number) => {
  const at = new Date(Date.now() - agoSec * 1000).toISOString();
  // `usage` rather than `job` or `review`: no foreign keys, so a write can be recorded
  // without inventing a repository and a review to hang it from.
  store.db
    .prepare("INSERT INTO usage(tier, model, input_tokens, cached_tokens, output_tokens, cost_usd, outcome, at) VALUES('t1','m',0,0,0,0,'clean',?)")
    .run(at);
};

/** A replica folder whose newest file is `agoSec` older than the database. */
function replicaAt(agoSec: number): string {
  const backup = join(dir, "backup");
  mkdirSync(backup, { recursive: true });
  const f = join(backup, "generations", "0001", "segment");
  mkdirSync(join(backup, "generations", "0001"), { recursive: true });
  writeFileSync(f, "seg");
  const when = new Date(Date.now() - agoSec * 1000);
  utimesSync(f, when, when);
  const now = new Date();
  utimesSync(join(dir, "lore.db"), now, now);
  return backup;
}

describe("health.ok is computed, never a literal", () => {
  // It was `ok: true` unconditionally, including on the beat that paged for a
  // critical disk. A health field that cannot say no is decoration a reader believes.
  it("is true on a healthy service, with nothing in problems", async () => {
    const h = await checkHealth(store, cfg());
    expect(h.ok).toBe(true);
    expect(h.problems).toStrictEqual([]);
  });

  it("is FALSE when the replica is behind, and names why", async () => {
    const backupDir = replicaAt(REPLICA_BEHIND_SEC + 600);
    wroteAgo(0);
    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.ok).toBe(false);
    expect(h.problems.join(" ")).toMatch(/replica/);
  });

  it("is FALSE when the replica has never been written", async () => {
    const backupDir = join(dir, "empty-backup");
    mkdirSync(backupDir, { recursive: true });
    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.ok).toBe(false);
    expect(h.replica).toBe("absent");
  });

});

// THE ONE FAULT THAT ENDS THE SERVICE, and the health check had no opinion about it.
//
// On 2026-08-07 this database became unreadable — every statement, `sqlite_master`
// included, answering `database disk image is malformed`. Nothing noticed for twenty
// minutes; it surfaced because `make mirror` happened to fail. `/status` was answering
// throughout, said `ok: false` for an unrelated and WRONG reason, and reported nothing
// about the data being gone. A health check that watches the queue and the replica
// while never asking whether the database is there is INV-1 at the top of the stack.
describe("a database nobody can read is not a healthy service", () => {
  /**
   * A store whose file rots UNDERNEATH IT, which is the case this guards.
   *
   * Corruption present at startup is a different event and needs no watching: the Store
   * constructor reads `sqlite_master` and `meta`, so lore fails to boot, loudly. What
   * happened on 2026-08-07 is this one — a process running happily against a file that
   * had become unreadable, answering `/status` all the while.
   *
   * DAMAGE A DATA PAGE, NOT THE HEADER. Zeroing the header makes SQLite refuse to open
   * the file at all ("file is not a database"), which is neither case: the live failure
   * opened cleanly and then failed every statement.
   */
  const rotUnderneath = (): Store => {
    const path = join(dir, "corrupt.db");
    const s = new Store(path);
    const repoId = s.upsertRepo("demo", "git@x:demo.git").id;
    // Enough rows to spill well past page 1, so there is a data page to break.
    for (let i = 0; i < 400; i++) {
      s.addKnowledge({
        repoId, kind: "rule", source: "ingested", statement: `rule number ${String(i)} `.repeat(8),
        why: undefined, path: undefined, cwe: undefined, provenance: "PROG.md",
        sourceBlob: "b", confidence: 0.8,
      });
    }
    // Still open, still serving — and the file beneath it is now wrong.
    const fd = openSync(path, "r+");
    writeSync(fd, Buffer.alloc(16384, 0x7a), 0, 16384, 4096);
    closeSync(fd);
    return s;
  };

  /**
   * THE ORDER IS THE PROPERTY, and the test above cannot see it.
   *
   * `rotUnderneath` damages pages the live handle already has CACHED, so its queries keep
   * answering and only a fresh reader notices — which is why `integrityFault` opens one.
   * That means the check happened to run before anything threw, and the assertion held for
   * a reason unrelated to ordering.
   *
   * On a database whose damage the live handle DOES hit, every other reader in
   * `checkHealth` throws: `replicaState` calls `lastWriteAt`, and `needsHumanOlderThan`
   * and `queueDepth` are ordinary queries. Written third under a comment saying FIRST, the
   * integrity check was never reached — the caller got an exception where it should have
   * got the one report that names the cause. A health check that dies while assembling
   * itself tells nobody anything, which is INV-1 wearing a stack trace.
   *
   * A stub rather than a fixture, because the point is exactly that NOTHING ELSE IS
   * CALLED — and no arrangement of bytes can assert that.
   */
  it("asks about integrity before anything that would throw", async () => {
    const calls: string[] = [];
    const refuses = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "integrityFault") return () => "database disk image is malformed";
          return (...args: unknown[]) => {
            calls.push(prop);
            void args;
            throw new Error(`database disk image is malformed (via ${prop})`);
          };
        },
      },
    ) as unknown as Store;

    const h = await checkHealth(refuses, cfg());
    expect(h.ok).toBe(false);
    expect(h.problems.join(" ")).toMatch(/DATABASE UNREADABLE/);
    expect(calls, "nothing else may be asked: on this path every one of them throws").toStrictEqual([]);
  });

  // `CONDITIONS.databaseUnreadable` lived only on the startup-refusal path, so a database
  // that went bad WHILE RUNNING put the words in `/status` and paged nobody — and
  // `/status` is a thing a person has to think to look at. Saying it unprompted is the
  // beat's entire purpose.
  // ONCE. A corrupt database does not heal, so an unlatched beat re-sends the same page
  // for ever and fills the alert channel with the one condition it exists for — until
  // whoever is on the other end mutes it, which is the failure every wolf-crying guard in
  // this file was written to avoid.
  it("pages ONCE, not on every beat", async () => {
    const broken = rotUnderneath();
    try {
      const stop = startHeartbeat(broken, cfg({ intervalMs: 20 }), alerter);
      await until(() => sent.some((x) => x.condition.startsWith("database unreadable")));
      // Long enough for many more beats at 20ms.
      await new Promise((r) => setTimeout(r, 300));
      stop();
      expect(sent.filter((x) => x.condition.startsWith("database unreadable"))).toHaveLength(1);
    } finally {
      try {
        broken.close();
      } catch {
        // Closing a corrupt database can itself fail; the test is about the alert.
      }
    }
  });

  it("pages, rather than only recording it in /status", async () => {
    const broken = rotUnderneath();
    try {
      const stop = startHeartbeat(broken, cfg({ intervalMs: 3_600_000 }), alerter);
      await until(() => sent.some((x) => x.condition.startsWith("database unreadable")));
      stop();
      const a = sent.find((x) => x.condition.startsWith("database unreadable"));
      expect(a?.severity).toBe("page");
      expect(a?.detail).toMatch(/make restore/);
    } finally {
      try {
        broken.close();
      } catch {
        // Closing a corrupt database can itself fail; the test is about the alert.
      }
    }
  });

  it("says the database is unreadable, rather than reporting on the queue", async () => {
    const broken = rotUnderneath();
    try {
      const h = await checkHealth(broken, cfg());
      expect(h.ok).toBe(false);
      expect(h.problems.join(" ")).toMatch(/DATABASE UNREADABLE/);
    } finally {
      try {
        broken.close();
      } catch {
        // Closing a corrupt database can itself fail; the test is about the report.
      }
    }
  });

  // It must REPORT the fault, never throw it. A corrupt database makes every statement
  // fail including the check itself, and a health endpoint that dies instead of
  // answering is the failure it exists to catch, wearing a different hat.
  it("answers rather than dying, when the check itself cannot run", () => {
    const broken = rotUnderneath();
    try {
      expect(broken.integrityFault()).toBeDefined();
    } finally {
      try {
        broken.close();
      } catch {
        // as above
      }
    }
  });

  it("says nothing about integrity when the database is fine", async () => {
    expect((await checkHealth(store, cfg())).problems.join(" ")).not.toMatch(/UNREADABLE/);
  });
});

describe("replica state", () => {
  // Four answers, not two. A deployment that does not mount the folder cannot be
  // asked, and answering "fine" would be a claim about something nobody looked at.
  it("is unconfigured when no folder is mounted", async () => {
    expect((await checkHealth(store, cfg())).replica).toBe("unconfigured");
  });

  // THE ONE THAT CRIED WOLF (D-59). litestream writes only when there is something
  // to replicate, so an idle database and a dead replicator are identical under a
  // freshness test — the old host-side check called a perfectly level replica stale
  // because its newest file was an hour old. Level is fine at ANY age.
  it("is level when the replica is older than the threshold but the database has not moved", async () => {
    const backupDir = replicaAt(REPLICA_BEHIND_SEC + 600);
    wroteAgo(REPLICA_BEHIND_SEC + 900); // the last write is OLDER than the replica
    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.replica).toBe("level");
    expect(h.ok).toBe(true);
  });

  it("is behind when the database has changed and the replica has not", async () => {
    const backupDir = replicaAt(REPLICA_BEHIND_SEC + 600);
    wroteAgo(0); // written just now, replica far older
    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.replica).toBe("behind");
    expect(h.replicaBehindSec ?? 0).toBeGreaterThan(REPLICA_BEHIND_SEC);
  });

  // A DATABASE NOBODY HAS WRITTEN TO IS NOT A BACKUP EMERGENCY. A fresh deployment has
  // no timestamps to compare, and calling that "behind" would page on the first minute
  // of every new install — training the operator to mute the one alert guarding the
  // product, which is the whole of D-59's lesson.
  it("is level when nothing has ever been written", async () => {
    const backupDir = replicaAt(REPLICA_BEHIND_SEC + 600);
    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.replica).toBe("level");
    expect(h.ok).toBe(true);
  });

  // THE WAL IS WHERE WRITES GO. The store is in WAL mode, so `lore.db`'s mtime only
  // advances on checkpoint — and with small rows that can be hours. Reading the main
  // file alone made this blind in exactly the case it exists for: litestream dies,
  // writes continue into an unflushed WAL, both watched timestamps freeze, `behindSec`
  // clamps to zero, and it reports `level, ok: true, no page` while knowledge is
  // written and replicated nowhere. Observed
  // live: lore.db stamped 18:56 against a newest replica segment of 22:58 — four
  // hours apart, in the wrong direction, reported as level.
  it("sees a write that is still only in the WAL", async () => {
    const backupDir = replicaAt(REPLICA_BEHIND_SEC + 600);
    // Both files stale on disk: a checkpoint long ago, and nothing touched since.
    const checkpointed = new Date(Date.now() - (REPLICA_BEHIND_SEC + 1200) * 1000);
    utimesSync(join(dir, "lore.db"), checkpointed, checkpointed);
    // ...and a write that has NOT been checkpointed, so no file mtime moves for it.
    wroteAgo(0);

    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.replica).toBe("behind");
    expect(h.ok).toBe(false);
  });

  // THE FALSE ALARM THAT POINTED AWAY FROM THE FIRE. A restart touches `lore.db-wal`
  // without committing anything, and the mtime predicate read that as fourteen minutes
  // of lag — while litestream's own log said `txid.replica == txid.db` on every sync,
  // and while the DATABASE was in fact unreadable. An operator following `ok: false`
  // would have gone to the replicator, which was perfectly healthy.
  it("is not fooled by a WAL touched without a write", async () => {
    const backupDir = replicaAt(60);
    wroteAgo(600); // last real write, well before the replica's newest segment
    writeFileSync(join(dir, "lore.db-wal"), "touched by an open, no commit behind it");

    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.replica).toBe("level");
    expect(h.ok).toBe(true);
  });

  // -shm is coordination, rewritten for reasons that are not writes. Counting it
  // would report change where there was none — the opposite error, equally blind.
  it("ignores the -shm file, which moves without a write", async () => {
    const backupDir = replicaAt(60);
    const old = new Date(Date.now() - (REPLICA_BEHIND_SEC + 1200) * 1000);
    utimesSync(join(dir, "lore.db"), old, old);
    writeFileSync(join(dir, "lore.db-wal"), "w");
    utimesSync(join(dir, "lore.db-wal"), old, old);
    writeFileSync(join(dir, "lore.db-shm"), "now");
    wroteAgo(REPLICA_BEHIND_SEC + 1200);

    expect((await checkHealth(store, cfg({ backupDir }))).replica).toBe("level");
  });
});

describe("needs_human ageing", () => {
  function parked(id: string, hoursAgo: number): void {
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id, repoId, principal: "p", branch: `b-${id}`, intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
    const when = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    store.db.prepare("UPDATE review SET state = 'needs_human', updated_at = ? WHERE id = ?").run(when, id);
  }

  it("counts only those past the age", () => {
    parked("old", 48);
    parked("fresh", 1);
    expect(store.needsHumanOlderThan(24)).toBe(1);
  });

  // A question nobody answers is a review that can never pass (spec/knowledge.md
  // §7.2), and the only thing that moves it is a person who does not know they are
  // needed.
  it("sends the ticket that was never wired", async () => {
    parked("old", 48);
    const stop = startHeartbeat(store, cfg({ intervalMs: 3_600_000 }), alerter);
    await until(() => sent.some((a) => a.condition === "needs_human findings ageing"));
    stop();
    expect(sent.map((a) => a.condition)).toContain("needs_human findings ageing");
  });

  // eb3d53ea, found by lore's own review: the IDENTICAL defect toldUncollected was
  // latched to fix, unfixed one condition over. A parked review stands for as long
  // as nobody resolves it — once for days, until the sweep took it — so this was
  // unlatched, sending the same ticket on every single beat.
  it("sends the ticket ONCE, not on every beat, while the count is unchanged", async () => {
    parked("old", 48);
    const stop = startHeartbeat(store, cfg({ intervalMs: 20 }), alerter);
    await until(() => sent.some((a) => a.condition === "needs_human findings ageing"));
    // Long enough for many more beats at 20ms.
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(sent.filter((a) => a.condition === "needs_human findings ageing")).toHaveLength(1);
  });

  // Latched on the COUNT, not on a boolean, exactly like toldUncollected: a second
  // review ageing past the threshold is new information and must speak again.
  it("speaks again when a SECOND review ages past the threshold", async () => {
    parked("first", 48);
    const stop = startHeartbeat(store, cfg({ intervalMs: 20 }), alerter);
    await until(() => sent.filter((a) => a.condition === "needs_human findings ageing").length >= 1);
    parked("second", 48);
    await until(() => sent.filter((a) => a.condition === "needs_human findings ageing").length >= 2);
    stop();
    expect(sent.filter((a) => a.condition === "needs_human findings ageing")).toHaveLength(2);
  });
});

describe("the beat sends the conditions that had no caller", () => {
  it("pages when the replica is behind", async () => {
    const backupDir = replicaAt(REPLICA_BEHIND_SEC + 600);
    wroteAgo(0);
    const stop = startHeartbeat(store, cfg({ backupDir, intervalMs: 3_600_000 }), alerter);
    await until(() => sent.some((x) => x.condition === "backup replica behind the database"));
    stop();
    const a = sent.find((x) => x.condition === "backup replica behind the database");
    expect(a?.severity).toBe("page");
  });

  // litestream is a sibling that starts AFTER lore and syncs on its own schedule, and
  // Docker creates the bind path if it is missing — so an empty replica folder is the
  // normal first seconds of every deploy. Paging on that would train the operator to
  // mute the one alert guarding the product, which is D-59's whole lesson earned back
  // in the check written to avoid it.
  // PROVING AN ABSENCE NEEDS A BARRIER, not a sleep. "Nothing arrived in 20ms" is a
  // statement about the machine, and it passes just as well when the beat never ran at
  // all — so the same test would go green against a heartbeat that had stopped working
  // entirely. Something else from the SAME beat is made to fire, and its arrival is the
  // proof the beat happened; only then is the absence a claim about behaviour.
  it("does not page for a missing replica during the startup grace", async () => {
    const backupDir = join(dir, "empty-backup");
    mkdirSync(backupDir, { recursive: true });
    // THE BARRIER — `queueWarnDepth: 0` makes the same beat emit a queue ticket whatever
    // the queue holds. It used to be the footprint ticket, which was removed with the rest
    // of the disk watching on 2026-08-12; the barrier is the part that had to survive,
    // because without it this test passes against a heartbeat that never ran.
    const stop = startHeartbeat(store, cfg({ backupDir, intervalMs: 3_600_000, queueWarnDepth: 0 }), alerter);
    await until(() => sent.some((x) => x.condition === "queue depth sustained"));
    stop();
    expect(sent.filter((x) => x.condition === "backup replica missing")).toStrictEqual([]);
  });

  // ...but /status must say so immediately, because a person reading it is asking now.
  // Only the unsolicited page waits.
  it("still reports the replica missing in health while the page is held back", async () => {
    const backupDir = join(dir, "empty-backup");
    mkdirSync(backupDir, { recursive: true });
    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.replica).toBe("absent");
    expect(h.ok).toBe(false);
  });

  it("pages when there is no replica after the grace has passed", async () => {
    const backupDir = join(dir, "empty-backup");
    mkdirSync(backupDir, { recursive: true });
    // A deployment that has been up long enough for litestream to have written.
    const stop = startHeartbeat(store, cfg({ backupDir, intervalMs: 3_600_000, replicaGraceMs: 0 }), alerter);
    await until(() => sent.some((x) => x.condition === "backup replica missing"));
    stop();
    expect(sent.find((x) => x.condition === "backup replica missing")?.severity).toBe("page");
  });

  it("stays quiet about a replica it was never given", async () => {
    const stop = startHeartbeat(store, cfg({ intervalMs: 3_600_000, queueWarnDepth: 0 }), alerter);
    await until(() => sent.some((x) => x.condition === "queue depth sustained")); // the barrier — see above
    stop();
    expect(sent.filter((x) => x.condition.startsWith("backup"))).toStrictEqual([]);
  });
});

// THE HALF OF THE DISK QUESTION THAT IS OURS.
//
// The host-percentage alerts were removed on the right argument — a full disk belongs to
// whoever owns the machine (D-71) — and the comment replacing them recorded "lore's
// whole footprint is under 5 GB" as if that were stable. It was 6.8 GB two days later:
// the sandbox npm cache is keyed by lockfile and grows with every distinct one, and
// nothing noticed, because the only thing watching had been deleted along with what was
// wrong about it. A budget lore sets for ITSELF is a claim it can be held to.
/**
 * A STALE MIRROR REFUSES EVERY REVIEW, and the beat did not know.
 *
 * `assertFresh` refuses a review cut from a mirror older than MAX_MIRROR_AGE_MS (D-65):
 * reviewing a stale tree describes code nobody is merging. The refresher is a HOST
 * process lore cannot see or start, so when it stops, every review stops — and `/status`
 * went on answering `ok: true`, because it only ever asked about the queue, the replica
 * and the database.
 *
 * Seventeen hours of it on 2026-08-08: the registry moved into a volume, the refresher
 * kept reading the old path, and a customer's review was refused for a mirror 1026
 * minutes old while the service called itself healthy.
 */
describe("a mirror too stale to review is not a healthy service", () => {
  const mirror = (name: string, fetchedMsAgo: number | undefined): string => {
    const repo = store.upsertRepo(name, `git@example.com:${name}.git`);
    const bare = join(dir, "repos", repo.id, "bare.git");
    mkdirSync(bare, { recursive: true });
    // `mirrorFreshness` wants a remote AND a FETCH_HEAD; without the remote it answers
    // `no-remote`, which is a different state and deliberately not stale.
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", bare, "remote", "add", "origin", `git@example.com:${name}.git`]);
    if (fetchedMsAgo !== undefined) {
      const head = join(bare, "FETCH_HEAD");
      writeFileSync(head, "");
      const at = new Date(Date.now() - fetchedMsAgo);
      utimesSync(head, at, at);
    }
    return repo.id;
  };

  it("says which repository is stale, and that its reviews are refused", async () => {
    mirror("stale-repo", 90 * 60_000);
    const h = await checkHealth(store, cfg());
    expect(h.ok).toBe(false);
    expect(h.problems.join(" ")).toContain("stale-repo");
    expect(h.problems.join(" "), "the consequence, not just the age").toMatch(/REFUSED/);
  });

  it("is quiet about a mirror inside the window", async () => {
    mirror("fresh-repo", 60_000);
    const h = await checkHealth(store, cfg());
    expect(h.problems.filter((p) => p.startsWith("mirror stale"))).toStrictEqual([]);
  });

  // A repository provisioned a minute ago has no mirror yet. That is an ordinary state
  // with its own message at review time, and paging about it would fire on every `make new`.
  it("does not call a never-fetched mirror stale", async () => {
    mirror("brand-new", undefined);
    const h = await checkHealth(store, cfg());
    expect(h.problems.filter((p) => p.startsWith("mirror stale"))).toStrictEqual([]);
  });
});

