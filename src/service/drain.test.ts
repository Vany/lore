/**
 * Draining: stop claiming rounds, keep serving, then swap containers (D-72).
 *
 * A restart loses no state — it is all in SQLite — but it throws away MODEL TIME.
 * `reclaimOrphanedJobs` requeues an interrupted round and it runs again from scratch,
 * paid for twice. One morning that cost 109 minutes of t2 work in a container that
 * could have been drained first.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Alerter } from "../ops/alerts.ts";
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
