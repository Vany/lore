/**
 * Draining: stop claiming rounds, keep serving, then swap containers (D-72).
 *
 * A restart loses no state — it is all in SQLite — but it throws away MODEL TIME.
 * `reclaimOrphanedJobs` requeues an interrupted round and it runs again from scratch,
 * paid for twice. One morning that cost 109 minutes of t2 work in a container that
 * could have been drained first.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DidNotRun } from "../core/errors.ts";
import type { ReviewerLike } from "../reviewer/opencode.ts";
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

/**
 * Wait for something to become true, rather than for a number of milliseconds.
 *
 * A FIXED SLEEP IS A RACE WHENEVER IT IS WAITING FOR WORK TO HAPPEN, and this file had
 * four. The worst was 400ms for a worker to poll, claim a job, and `git worktree add` off
 * a bare clone before its reviewer is even reached — comfortably under 400ms alone, and
 * not under a full suite running fifty files at once. It failed three times over two days
 * and never once when run by itself, which is exactly the signature.
 *
 * A test that sometimes does not exercise its subject is the same defect as a review that
 * did not run: it reports success for work nobody did. Waiting for the CONDITION is both
 * faster in the normal case and correct in the slow one.
 *
 * The sleeps that remain in this file are the other kind — asserting that something did
 * NOT happen, where elapsed time is the whole point and there is nothing to wait for.
 */
const until = async (what: string, ok: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("a draining worker takes nothing new", () => {
  // The behaviour, not the flag. Set AFTER start, because start clears it.
  it("leaves queued work alone for the next process", async () => {
    const worker = new Worker(store, { ...DEFAULT_WORKER, pollMs: 5 }, new Alerter({ timeoutMs: 10 }));
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
    const worker = new Worker(store, { ...DEFAULT_WORKER, pollMs: 5 }, new Alerter({ timeoutMs: 10 }));
    const stop = worker.start();
    try {
      store.setDraining(true);
      queuedReview("rev2");
      await new Promise((r) => setTimeout(r, 40));
      expect((store.db.prepare("SELECT state FROM job WHERE review_id = 'rev2'").get() as { state: string }).state).toBe("queued");

      store.setDraining(false);
      const claimed = () =>
        (store.db.prepare("SELECT state FROM job WHERE review_id = 'rev2'").get() as { state: string }).state !== "queued";
      await until("the job to be claimed once draining stops", claimed);
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

    const worker = new Worker(store, { ...DEFAULT_WORKER, pollMs: 10 }, new Alerter({ timeoutMs: 10 }));
    const stop = worker.start();
    try {
      expect(store.isDraining()).toBe(false);
    } finally {
      stop();
    }
  });

  it("leaves a clean start alone", () => {
    const worker = new Worker(store, { ...DEFAULT_WORKER, pollMs: 10 }, new Alerter({ timeoutMs: 10 }));
    const stop = worker.start();
    try {
      expect(store.isDraining()).toBe(false);
    } finally {
      stop();
    }
  });
});

// A REVIEW THAT ALREADY ENDED KEEPS THE ENDING IT WAS GIVEN.
//
// The round refuses to spend on a review somebody cancelled — before the tier, and again
// when a call queued at the provider gate finally gets a slot. Both refusals THROW, and
// the worker's catch wrote `failed` over whatever the state was. So a cancel would be
// replaced by a word meaning the opposite: not "we stopped this" but "we could not read
// the code", losing the reason `review_cancel` had just recorded and telling the client
// to consider retrying a review it deliberately ended.
//
// THE SETUP IS REAL GIT, and it has to be. Two shorter versions of this test passed
// against the unfixed code: cancelling BEFORE the worker starts means `claimJob` refuses
// the job and the catch is never reached at all, and with no mirror `worktreeFor` throws
// while the review is still `queued`. The only faithful shape is the one that happens in
// production — the job is claimed, the round begins, and the cancel lands while a model
// call is in flight.
describe("a worker does not overwrite an ending somebody chose", () => {
  let root: string;

  const makeRepo = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@e.com");
    g("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "x");
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lore-worker-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A repo the worker can actually cut a worktree from, mirrored as `make mirror` leaves it. */
  const withMirror = (repoId: string) => {
    const src = join(root, "src");
    makeRepo(src);
    const bare = join(root, "repos", repoId, "bare.git");
    mkdirSync(join(bare, ".."), { recursive: true });
    execFileSync("git", ["clone", "--bare", src, bare], { stdio: "ignore" });
    // A bare clone alone is the DANGEROUS shape lore refuses: a remote with no
    // FETCH_HEAD is a clone whose fetch failed, and reviewing it would review the
    // commit it was cloned at rather than the branch being merged. `make mirror`
    // leaves this behind, and freshness is read from its mtime.
    writeFileSync(join(bare, "FETCH_HEAD"), "");
    return src;
  };

  /** Cancels the review the moment it is asked, then refuses — exactly what the gate guard does. */
  const cancelsThenRefuses = (reviewId: string): ReviewerLike => ({
    review: () => {
      store.updateReview(reviewId, { state: "cancelled" });
      store.setFailureReason(reviewId, "cancelled by alice: superseded by a rebase");
      return Promise.reject(new DidNotRun("was ended while this call waited for a provider slot"));
    },
  });

  it("leaves a cancelled review cancelled when the round refuses mid-flight", async () => {
    const repoId = store.upsertRepo("r", join(root, "src")).id;
    withMirror(repoId);
    store.createReview({
      id: "rev1", repoId, principal: "p", branch: "main", intoRef: "main",
      ticket: "t", type: "code-arch", state: "queued", ladder: initialState(),
    });
    store.enqueue("rev1", "fast");

    const worker = new Worker(
      store,
      { ...DEFAULT_WORKER, pollMs: 5, reposRoot: join(root, "repos") },
      new Alerter({ timeoutMs: 10 }),
      cancelsThenRefuses("rev1"),
    );
    const stop = worker.start();
    try {
      // The worker has to poll, claim, and cut a worktree from a bare clone before its
      // reviewer is reached. That is fast alone and not fast under a loaded suite.
      await until("the round to reach the reviewer and be cancelled", () => store.stateOf("rev1") === "cancelled");
    } finally {
      stop();
    }

    expect(store.stateOf("rev1")).toBe("cancelled");
    expect(store.failureReason("rev1")).toContain("superseded by a rebase");
  });

  it("still fails a review that was still wanted", async () => {
    queuedReview("rev2");
    const worker = new Worker(store, { ...DEFAULT_WORKER, pollMs: 5 }, new Alerter({ timeoutMs: 10 }));
    const stop = worker.start();
    try {
      await until("the round to run and fail", () => store.stateOf("rev2") === "failed");
    } finally {
      stop();
    }
    expect(store.stateOf("rev2")).toBe("failed");
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

    const worker = new Worker(store, { ...DEFAULT_WORKER, pollMs: 1 }, alerter);
    const stop = worker.start();
    await until("the loop to survive both throws and claim again", () => thrown > 2);
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
