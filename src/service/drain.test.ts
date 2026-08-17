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
import { DidNotRun, ServiceUnreachable } from "../core/errors.ts";
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
/**
 * A BUDGET LARGER THAN `until`'s, on every test that waits on one.
 *
 * These tests drive a real worker over a real bare clone: each round is a `git worktree
 * add`, an ingest and a t0 sweep, and the retried one does all of that twice. Comfortably
 * inside vitest's 5s default alone, not inside it when the suite is running fifty files —
 * measured, about one full-suite run in eight timed out here.
 *
 * The failure that mattered was not the slowness but the REPORT: vitest killed the test at
 * 5s while `until` was still waiting on its own 10s deadline, so the error said "test timed
 * out" and never said what it was waiting for. Same signature as the fixed-400ms-sleep race
 * in this file on 2026-08-11 — an assumption about timing that holds alone and fails under
 * load. Now `until` always expires first and names the condition.
 */
const WAITING = 20_000;

const until = async (what: string, ok: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

/**
 * Stop claiming AND wait out the round in flight, before `afterEach` closes the store.
 *
 * `stop()` alone only stops the dispatcher; a round already claimed keeps running, and
 * closing the store under it turns the round's own bookkeeping into an unhandled
 * "database is not open" rejection. That window was theoretical for months and became a
 * every-run failure the day the round gained awaits (D-109's allSettled merge) — the
 * signature of a test waiting for the FIRST observable effect of a round rather than
 * for the round.
 */
const stopAndDrain = async (w: Worker, stop: () => void): Promise<void> => {
  stop();
  await until("in-flight rounds to finish", () => w.inFlight() === 0);
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
      await stopAndDrain(worker, stop);
    }
  }, WAITING);

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

  // lore-ok[c4fb3911]: the fixture IS main-into-main and the test passes anyway — the
  // empty-change-set refusal never gates it. `cancelsThenRefuses` is reached through the
  // knowledge BOOTSTRAP, which runs before any round, so the review is already
  // `cancelled` when runRound is claimed and stops on the terminal check instead. 13 of
  // 13 pass in 2.8s. The reviewer reached the same conclusion from source and retracted.
  // lore-ok[f76a571b]: the retraction, accepted and kept — see above.
  //
  // KEPT AS A COMMENT because the weaker true thing inside the wrong claim is worth
  // knowing: this test reaches its mock by a path its NAME does not mention, so a change
  // to bootstrap could silence it without failing it. That fragility is real; the
  // timeout was not.
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
      await stopAndDrain(worker, stop);
    }

    expect(store.stateOf("rev1")).toBe("cancelled");
    expect(store.failureReason("rev1")).toContain("superseded by a rebase");
  }, WAITING);

  it("still fails a review that was still wanted", async () => {
    queuedReview("rev2");
    const worker = new Worker(store, { ...DEFAULT_WORKER, pollMs: 5 }, new Alerter({ timeoutMs: 10 }));
    const stop = worker.start();
    try {
      await until("the round to run and fail", () => store.stateOf("rev2") === "failed");
    } finally {
      await stopAndDrain(worker, stop);
    }
    expect(store.stateOf("rev2")).toBe("failed");
  }, WAITING);
});

/**
 * THE DEPLOY WINDOW, DRIVEN THROUGH `Worker.round` RATHER THAN THE STORE.
 *
 * The first attempt at this guarded three store WRITES and was proven useless by lore's
 * own review: everything around them READS — `repoAndStateOf`, `stateOf`, `heldDiffs`,
 * `hasOpenJob` — and a closed handle throws on those exactly as it did on the writes. On
 * the failure path the throw comes from INSIDE the catch, so it escapes a promise that is
 * detached by `void this.round(job)` with no `unhandledRejection` handler anywhere: an
 * unhandled rejection, in exactly the window the guard existed for.
 *
 * The test that missed it called the three store methods directly and never drove a
 * round. This one closes the store UNDER a live round, which is the actual shape.
 */
describe("a round whose store closes under it", () => {
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

  let root2: string;
  beforeEach(() => { root2 = mkdtempSync(join(tmpdir(), "lore-close-")); });
  afterEach(() => rmSync(root2, { recursive: true, force: true }));

  // lore-ok[3e13f71d]: same mechanism, same answer. The mock that closes the store is
  // invoked by the knowledge bootstrap BEFORE runRound, so the store really is closed
  // under a live round and the guard really is exercised; the empty-change-set refusal is
  // never reached. Verified by running the file, and the log line naming the bootstrap is
  // in the verbose output. The reviewer retracted this independently.
  // lore-ok[b74c7bff]: the retraction, accepted and kept — see above.
  it("stops quietly instead of throwing out of a detached promise", async () => {
    const repoId = store.upsertRepo("r", join(root2, "src")).id;
    const src = join(root2, "src");
    makeRepo(src);
    const bare = join(root2, "repos", repoId, "bare.git");
    mkdirSync(join(bare, ".."), { recursive: true });
    execFileSync("git", ["clone", "--bare", src, bare], { stdio: "ignore" });
    writeFileSync(join(bare, "FETCH_HEAD"), "");
    store.createReview({
      id: "revX", repoId, principal: "p", branch: "main", intoRef: "main",
      ticket: "t", type: "code-arch", state: "queued", ladder: initialState(),
    });
    store.enqueue("revX", "fast");

    // The reviewer closes the store mid-round — a deploy landing on a live round.
    const w = new Worker(
      store,
      { ...DEFAULT_WORKER, pollMs: 5, reposRoot: join(root2, "repos") },
      new Alerter({ timeoutMs: 10 }),
      { review: () => { store.close(); return Promise.reject(new DidNotRun("tier t1 failed: provider 500")); } },
    );

    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    const stop = w.start();
    try {
      await until("the round to run against the closed store", () => store.isClosed());
      // Long enough for a rejection to surface if the round throws past its own catch.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      stop();
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections, "a closed store must not crash the process").toStrictEqual([]);
  }, WAITING);
});

// A SERVICE THAT HAS STOPPED WORKING AND SAYS IT IS FINE.
//
// The per-job guard catches everything a round can throw. `isDraining()` and
// `claimJob()` sat outside it, so a store-layer fault — a locked database, a full disk
// — killed the loop, and `void Promise.allSettled(loops)` collected the rejection and
// discarded it. Concurrency fell from N to N-1 to zero while `/healthz` answered ok and
// `/status` reported `ok: true`, and nothing anywhere could notice.
/**
 * A FROZEN SERVICE TAKES NOTHING AND BREAKS NOTHING (D-119).
 *
 * The ceiling used to be checked inside the round, which meant the job was CLAIMED first
 * and the review then written `failed` — and on 2026-08-16 that destroyed eight reviews
 * across three people's branches, all at round 0 having read nothing, because lore was out
 * of money for a few hours.
 *
 * Gating the CLAIM is what makes "do not restart, wait till unfreeze" true rather than
 * aspirational, and it is what this pins: the job stays queued, the review stays exactly
 * as it was, and the reviewer is never asked anything.
 */
/**
 * DRAINING IS THE ONLY REASON THIS DISPATCHER DECLINES WORK (D-121).
 *
 * A spend ceiling used to sit beside the drain check and stop claiming for the rest of the
 * UTC day once a total crossed $100 — so a bill run up by one batch suspended the gate for
 * everybody, and on 2026-08-16 that was eight reviews on three colleagues' branches. This
 * pins the inversion: money is recorded, and the queue does not read it.
 */
describe("the dispatcher does not read the day's spend", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lore-spend-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("claims and runs a queued review however much has been spent today", async () => {
    const repoId = store.upsertRepo("r", join(root, "src")).id;
    store.recordUsage({
      repoId, reviewId: "revFrozen", tier: "t2", model: "openrouter/twin",
      inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 12, outcome: "ok",
    });
    store.createReview({
      id: "revFrozen", repoId, principal: "p", branch: "work", intoRef: "main",
      ticket: "t", type: "code-arch", state: "queued", ladder: initialState(),
    });
    store.enqueue("revFrozen", "fast");

    let asked = 0;
    const w = new Worker(
      store,
      { ...DEFAULT_WORKER, pollMs: 5, reposRoot: join(root, "repos"), allowMetered: false },
      new Alerter({ timeoutMs: 10 }),
      { review: () => { asked++; return Promise.reject(new DidNotRun("should never be asked")); } },
    );
    const stop = w.start();
    try {
      // Long enough that an ungated dispatcher would have claimed and failed it many
      // times over at a 5ms poll.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await stopAndDrain(w, stop);
    }

    // CLAIMED — which is the fact this dispatcher decides, and the whole of what the
    // ceiling used to override. The $12 above exceeds the ceiling this test once proved
    // was enforced; nothing consults it now, so the job leaves the queue.
    //
    // Asserted on the STATE and not on `asked`, because this fixture has no mirror for its
    // repo: the round is claimed and then dies at the worktree, before any tier. That is
    // still a claim, and a claim is the thing under test. Asserting `asked > 0` here
    // passed only if a second, unrelated subsystem worked — the shape that makes a green
    // suite mean less than it looks.
    expect(store.stateOf("revFrozen"), "it left `queued` — nobody waits on a bill").not.toBe("queued");
  }, WAITING);
});

describe("a store fault does not silently cost the service its capacity", () => {
  /** An alerter that records rather than sends, so the page is observable. */
  const recorder = () => {
    const sent: Alert[] = [];
    const a = new Alerter({ timeoutMs: 10 });
    a.send = async (alert: Alert) => {
      sent.push(alert);
      return Promise.resolve(true);
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
  }, WAITING);

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

/**
 * A RESTART IS NOT A VERDICT ABOUT THE CODE (D-104).
 *
 * `make deploy` no longer drains — it restarts, and the rounds in flight are dropped and
 * restored. That restored only half of them. A round whose job was left `running` is
 * requeued at startup by `reclaimOrphanedJobs`; a round far enough along to CATCH the
 * error wrote `failed` and stayed there. A deploy, and then a crash loop of my own making,
 * ended two of the team's reviews that way — `socket hang up` and `could not reach
 * opencode (getaddrinfo)` — and both had to be revived by hand.
 *
 * THE SETUP IS REAL GIT, for the same reason the cancel tests above need it: without a
 * mirror the round dies in `worktreeFor` and the reviewer is never called at all. The
 * first version of these tests had no mirror, so one timed out and the other passed on
 * the wrong error entirely — proving nothing about the branch it was written for.
 */
describe("a round interrupted by lore itself is requeued, not failed", () => {
  let root: string;

  // A BRANCH WITH A COMMIT ON IT, not `main` reviewed into `main`.
  //
  // This fixture used to do the latter, which is an EMPTY change-set — and a round over
  // an empty change-set is now refused before any tier is asked anything (INV-1: a review
  // that read nothing is not a review that found nothing). The test then timed out
  // waiting for a second round that could never come, which is the right refusal
  // reporting a fixture that was never a review. What it is here to observe — a round
  // dying mid-flight and being retried — needs a round that actually starts.
  const makeRepo = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@e.com");
    g("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "x");
    g("checkout", "-q", "-b", "work");
    writeFileSync(join(dir, "b.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "the change under review");
    g("checkout", "-q", "main");
  };

  const mirrored = (id: string) => {
    const repoId = store.upsertRepo("r", join(root, "src")).id;
    const src = join(root, "src");
    makeRepo(src);
    const bare = join(root, "repos", repoId, "bare.git");
    mkdirSync(join(bare, ".."), { recursive: true });
    execFileSync("git", ["clone", "--bare", src, bare], { stdio: "ignore" });
    writeFileSync(join(bare, "FETCH_HEAD"), "");
    store.createReview({
      id, repoId, principal: "p", branch: "work", intoRef: "main",
      ticket: "t", type: "code-arch", state: "queued", ladder: initialState(),
    });
    store.enqueue(id, "fast");
  };

  const worker = (reviewer: ReviewerLike) =>
    new Worker(
      store,
      { ...DEFAULT_WORKER, pollMs: 5, reposRoot: join(root, "repos") },
      new Alerter({ timeoutMs: 10 }),
      reviewer,
    );

  const ok = () =>
    Promise.resolve({
      findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0,
      outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lore-restart-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("survives the interruption and finishes on the next attempt", async () => {
    mirrored("rev1");
    // The shape of a real restart: the round in flight dies, and the service is back for
    // the next one. A reviewer that ALWAYS throws would requeue and re-claim within
    // milliseconds until the bound, which observes nothing about the property.
    let calls = 0;
    const w = worker({
      review: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ServiceUnreachable("tier t1 could not reach opencode (getaddrinfo ENOTFOUND)"))
          : ok();
      },
    });
    const stop = w.start();
    try {
      // A LONGER WAIT THAN THE OTHERS, because this one waits for TWO full rounds: the
      // interrupted one and the retry, each a `git worktree add` off a bare clone plus an
      // ingest and a t0 sweep. Measured across full-suite runs, the machine's own load
      // moves the suite between 21s and 60s, and this test with it — 10s was inside that
      // spread. Fifteen sits under the 20s test budget, so `until` still expires first and
      // names what it was waiting for instead of vitest reporting a bare timeout.
      await until("the round to be retried after the interruption", () => calls >= 2, 15_000);
    } finally {
      await stopAndDrain(w, stop);
    }

    // Nothing was learned about the code when lore went away, so nothing is concluded.
    expect(store.stateOf("rev1"), "a restart is not a verdict").not.toBe("failed");
  }, WAITING);

  /**
   * BOUNDED. A sidecar that is genuinely down rather than restarting would otherwise
   * requeue for ever, and a review looping in silence is the shape this project refuses
   * above all others.
   */
  it("gives up after enough attempts and fails honestly", () => {
    mirrored("rev2");
    const job = store.claimJob();
    expect(job).toBeDefined();
    store.db.prepare("UPDATE job SET attempts = 3 WHERE id = ?").run(job?.id ?? 0);

    expect(store.requeueJob(job?.id ?? 0, "opencode is gone"), "past the bound").toBe(false);
  });

  // A PROVIDER hanging up is a real failure of that tier and must stay one — retrying
  // somebody else's outage for ever would spend our quota proving it.
  it("does not requeue an ordinary tier failure", async () => {
    mirrored("rev3");
    const w = worker({
      review: () => Promise.reject(new DidNotRun("tier t1 (glm-5) failed: the provider returned 500")),
    });
    const stop = w.start();
    try {
      await until("the review to fail", () => store.stateOf("rev3") === "failed");
    } finally {
      await stopAndDrain(w, stop);
    }
    expect(store.stateOf("rev3")).toBe("failed");
  }, WAITING);
});
