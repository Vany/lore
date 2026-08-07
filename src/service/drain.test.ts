/**
 * Draining: stop claiming rounds, keep serving, then swap containers (D-72).
 *
 * A restart loses no state — it is all in SQLite — but it throws away MODEL TIME.
 * `reclaimOrphanedJobs` requeues an interrupted round and it runs again from scratch,
 * paid for twice. One morning that cost 109 minutes of t2 work in a container that
 * could have been drained first.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Alerter, CONDITIONS, type Alert } from "../ops/alerts.ts";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { DEFAULT_WORKER, Worker } from "./worker.ts";

let store: Store;

const queuedReview = (id: string) => {
  const repoId = store.upsertRepo("r", "git@x:r.git").id;
  store.createReview({
    id, repoId, principal: "p", branch: "b", intoRef: "main",
    ticket: "t", type: "code-arch", state: "queued", ladder: initialState(),
  });
  store.enqueue(id, "fast");
};

beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

describe("a draining worker takes nothing new", () => {
  // The behaviour, not the flag. Set AFTER start, because start clears it.
  it("leaves queued work alone for the next process", async () => {
    const worker = new Worker(store, { ...DEFAULT_WORKER, concurrency: 2, pollMs: 5 }, new Alerter({ timeoutMs: 10 }));
    const stop = worker.start();
    try {
      store.setDraining(true);
      queuedReview("rev1");
      await new Promise((r) => setTimeout(r, 80)); // many poll intervals

      const job = store.db.prepare("SELECT state FROM job WHERE review_id = 'rev1'").get() as { state: string };
      expect(job.state).toBe("queued");
    } finally {
      stop();
    }
  });

  // And the same worker takes it the moment draining stops — otherwise "drained"
  // would be indistinguishable from "wedged", which is the whole hazard.
  it("resumes claiming when the drain is lifted", async () => {
    const worker = new Worker(store, { ...DEFAULT_WORKER, concurrency: 2, pollMs: 5 }, new Alerter({ timeoutMs: 10 }));
    const stop = worker.start();
    try {
      store.setDraining(true);
      queuedReview("rev2");
      await new Promise((r) => setTimeout(r, 40));
      expect((store.db.prepare("SELECT state FROM job WHERE review_id = 'rev2'").get() as { state: string }).state).toBe("queued");

      store.setDraining(false);
      await new Promise((r) => setTimeout(r, 80));
      expect((store.db.prepare("SELECT state FROM job WHERE review_id = 'rev2'").get() as { state: string }).state).not.toBe("queued");
    } finally {
      stop();
    }
  });

  it("is off unless it has been turned on", () => {
    expect(store.isDraining()).toBe(false);
    store.setDraining(true);
    expect(store.isDraining()).toBe(true);
    store.setDraining(false);
    expect(store.isDraining()).toBe(false);
  });
});

// THE PROPERTY THAT MATTERS MOST.
//
// If the flag outlived the restart it was for, the new container would start, claim
// nothing, and answer /status with ok:true while the queue grew for ever — healthy
// and doing nothing, which is the failure this project exists to refuse.
describe("a drain does not survive the restart it was for", () => {
  it("is cleared by the process that starts after it", () => {
    store.setDraining(true);

    const worker = new Worker(store, { ...DEFAULT_WORKER, concurrency: 1, pollMs: 10 }, new Alerter({ timeoutMs: 10 }));
    const stop = worker.start();
    try {
      expect(store.isDraining()).toBe(false);
    } finally {
      stop();
    }
  });

  it("leaves a clean start alone", () => {
    const worker = new Worker(store, { ...DEFAULT_WORKER, concurrency: 1, pollMs: 10 }, new Alerter({ timeoutMs: 10 }));
    const stop = worker.start();
    try {
      expect(store.isDraining()).toBe(false);
    } finally {
      stop();
    }
  });
});

// A SERVICE THAT HAS STOPPED WORKING AND SAYS IT IS FINE.
//
// The per-job guard catches everything a round can throw. `isDraining()` and
// `claimJob()` sat outside it, so a store-layer fault — a locked database, a full disk
// — killed the loop, and `void Promise.allSettled(loops)` collected the rejection and
// discarded it. Concurrency fell from N to N-1 to zero while `/healthz` answered ok and
// `/status` reported `ok: true`, and nothing anywhere could notice.
describe("a store fault does not silently cost the service its capacity", () => {
  /** An alerter that records rather than sends, so the page is observable. */
  const recorder = () => {
    const sent: Alert[] = [];
    const a = new Alerter({ timeoutMs: 10 });
    a.send = async (alert: Alert) => {
      sent.push(alert);
    };
    return { alerter: a, sent };
  };

  it("keeps the loop alive when claiming throws, and pages", async () => {
    const { alerter, sent } = recorder();
    let thrown = 0;
    const original = store.claimJob.bind(store);
    store.claimJob = () => {
      if (thrown++ < 2) throw new Error("database is locked");
      return original();
    };

    const worker = new Worker(store, { ...DEFAULT_WORKER, concurrency: 1, pollMs: 1 }, alerter);
    const stop = worker.start();
    await new Promise((r) => setTimeout(r, 60));
    stop();

    // It threw twice and carried on: the loop is still claiming afterwards.
    expect(thrown).toBeGreaterThan(2);
    expect(sent.some((a) => a.severity === "page" && a.condition.includes("stopped claiming work"))).toBe(true);
  });

  it("says how much capacity is left, because zero is the number that matters", () => {
    const { alerter, sent } = recorder();
    void alerter;
    void sent;
    // The detail names the remaining loop count; at zero, reviews queue for ever.
    const a = CONDITIONS.workerLoopDied(0, "disk full");
    expect(a.severity).toBe("page");
    expect(a.detail).toContain("0 loop(s)");
    expect(a.detail).toContain("queue for ever");
  });
});
