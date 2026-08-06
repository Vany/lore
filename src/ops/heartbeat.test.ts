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

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { Alerter, type Alert } from "./alerts.ts";
import { DEFAULT_HEARTBEAT, REPLICA_BEHIND_SEC, checkHealth, startHeartbeat } from "./heartbeat.ts";

let store: Store;
let dir: string;
let sent: Alert[];
let alerter: Alerter;

/** Captures what would have gone to the webhook. No network, no config to forget. */
class Capturing extends Alerter {
  override async send(a: Alert): Promise<void> {
    sent.push(a);
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
    const old = new Date(Date.now() - (REPLICA_BEHIND_SEC + 900) * 1000);
    utimesSync(join(dir, "lore.db"), old, old);
    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.replica).toBe("level");
    expect(h.ok).toBe(true);
  });

  it("is behind when the database has changed and the replica has not", async () => {
    const backupDir = replicaAt(REPLICA_BEHIND_SEC + 600);
    const h = await checkHealth(store, cfg({ backupDir }));
    expect(h.replica).toBe("behind");
    expect(h.replicaBehindSec ?? 0).toBeGreaterThan(REPLICA_BEHIND_SEC);
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
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(sent.map((a) => a.condition)).toContain("needs_human findings ageing");
  });
});

describe("the beat sends the conditions that had no caller", () => {
  it("pages when the replica is behind", async () => {
    const backupDir = replicaAt(REPLICA_BEHIND_SEC + 600);
    const stop = startHeartbeat(store, cfg({ backupDir, intervalMs: 3_600_000 }), alerter);
    await new Promise((r) => setTimeout(r, 20));
    stop();
    const a = sent.find((x) => x.condition === "backup replica behind the database");
    expect(a?.severity).toBe("page");
  });

  // litestream is a sibling that starts AFTER lore and syncs on its own schedule, and
  // Docker creates the bind path if it is missing — so an empty replica folder is the
  // normal first seconds of every deploy. Paging on that would train the operator to
  // mute the one alert guarding the product, which is D-59's whole lesson earned back
  // in the check written to avoid it.
  it("does not page for a missing replica during the startup grace", async () => {
    const backupDir = join(dir, "empty-backup");
    mkdirSync(backupDir, { recursive: true });
    const stop = startHeartbeat(store, cfg({ backupDir, intervalMs: 3_600_000 }), alerter);
    await new Promise((r) => setTimeout(r, 20));
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
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(sent.find((x) => x.condition === "backup replica missing")?.severity).toBe("page");
  });

  it("stays quiet about a replica it was never given", async () => {
    const stop = startHeartbeat(store, cfg({ intervalMs: 3_600_000 }), alerter);
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(sent.filter((x) => x.condition.startsWith("backup"))).toStrictEqual([]);
  });
});
