/**
 * A model session outlives the review only until somebody notices (D-80).
 *
 * Since 2026-08-12 a tier with `conversation` keeps ONE opencode session for the whole
 * review, and nothing clears it per round — that is the point of it. So every path a
 * review can end by has to end its sessions too, and the design note that specified this
 * put that first among the things to get right: admission allows 128 open reviews, which
 * across three tiers is 384 sessions opencode would hold for work that finished hours ago.
 *
 * Two of those paths do not go through the worker at all, and both were live holes:
 *
 *  - `review_cancel` on a review sitting in `findings_ready` runs with NO job in flight,
 *    so `releaseIfFinished` never fires (covered in `reviewer/opencode.test.ts`, where
 *    `cancel` is);
 *  - the retention sweep marks abandoned reviews `expired` in SQL after 48 hours, and
 *    nothing in that path has ever heard of a model session.
 *
 * This file is the second one, and it is written as a RECONCILE rather than as a call
 * bolted onto the expiry path, so the next terminal path nobody thinks of is collected
 * too. That is not hypothetical: the session map is new and every way a review can end
 * predates it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Alerter } from "../ops/alerts.ts";
import type { ReviewerLike } from "../reviewer/opencode.ts";
import { Store } from "../store/store.ts";
import { DEFAULT_WORKER, Worker } from "./worker.ts";

let store: Store;
let root: string;

/** A reviewer that only models the session bookkeeping — the rest is never reached. */
class Keeping implements ReviewerLike {
  readonly released: string[] = [];
  private readonly holding: string[];

  constructor(holding: string[]) {
    this.holding = holding;
  }

  review(): never {
    throw new Error("no round should run in these tests");
  }

  keptReviews(): readonly string[] {
    return [...this.holding];
  }

  async release(reviewId: string): Promise<void> {
    this.released.push(reviewId);
    const i = this.holding.indexOf(reviewId);
    if (i >= 0) this.holding.splice(i, 1);
    return Promise.resolve();
  }
}

const review = (id: string, state: "running" | "findings_ready" | "expired" | "passed") => {
  const repoId = store.upsertRepo("r", "git@x:r.git").id;
  store.createReview({
    id, repoId, principal: "p", branch: "b", intoRef: "main",
    ticket: "t", type: "code-arch", state, ladder: initialState(),
  });
};

/** Run the worker until it has been idle at least once, then stop it. */
const idleOnce = async (reviewer: ReviewerLike): Promise<void> => {
  root = mkdtempSync(join(tmpdir(), "lore-reconcile-"));
  const worker = new Worker(
    store,
    { ...DEFAULT_WORKER, pollMs: 5, reposRoot: join(root, "repos") },
    new Alerter({ timeoutMs: 10 }),
    reviewer,
  );
  const stop = worker.start();
  try {
    // There is no work at all in these tests, so the very first tick is an idle one.
    // Waiting for the CONDITION rather than a fixed sleep, for the reason written at
    // length in `drain.test.ts`: a fixed sleep is a race whenever it waits for work.
    const deadline = Date.now() + 10_000;
    while ((reviewer as Keeping).released.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    stop();
  }
};

beforeEach(() => {
  store = new Store(":memory:");
  root = "";
});
afterEach(() => {
  store.close();
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("sessions kept by a review that ended without a job", () => {
  /**
   * A BUSY SERVICE IS WHEN THIS MATTERS, and the first version only worked when idle.
   *
   * The reconcile was called in the branch `claimJob` takes when it finds NOTHING — so a
   * service with a steady queue never reached it, and the expiries it exists to catch
   * piled up precisely while the machine was busy. The evidence was the shape of this file
   * rather than the code: every test here exercised an idle worker, so none of them could
   * have caught it.
   *
   * **The discriminator is ORDER, not elapsed time**, and that is what makes this test
   * hard to write honestly. Both versions release `rev1` within milliseconds — the
   * difference is whether the queue had to run dry first. My first attempt enqueued one
   * job and called that "busy"; it drained instantly, the worker went idle, and the test
   * passed against BOTH versions. So this one records whether the queue had ever been
   * empty at the moment the release happened, which is exactly the property in dispute.
   */
  it("are released before the queue has ever been empty", async () => {
    review("rev1", "expired");

    // A queue that stays full for the first twenty claims. The ids name no review, so each
    // round fails at once — `runJob` throws `vanished` before it touches git — which keeps
    // the loop claiming without doing real work.
    let busy = 20;
    let everIdle = false;
    store.claimJob = () => {
      if (busy > 0) {
        busy -= 1;
        return { id: 900 + busy, reviewId: "rev_ghost", stage: "fast" as const };
      }
      everIdle = true;
      return undefined;
    };

    const reviewer = new Keeping(["rev1"]);
    // What `everIdle` was at the instant rev1 was let go — captured then, because by the
    // time the assertion runs the queue has drained and it would always read true.
    let idleWhenReleased: boolean | undefined;
    const release = reviewer.release.bind(reviewer);
    reviewer.release = async (id: string) => {
      if (id === "rev1" && idleWhenReleased === undefined) idleWhenReleased = everIdle;
      return release(id);
    };

    root = mkdtempSync(join(tmpdir(), "lore-reconcile-"));
    const worker = new Worker(
      store,
      { ...DEFAULT_WORKER, pollMs: 5, reposRoot: join(root, "repos") },
      new Alerter({ timeoutMs: 10 }),
      reviewer,
    );
    const stop = worker.start();
    try {
      const deadline = Date.now() + 10_000;
      while (idleWhenReleased === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      stop();
    }

    expect(idleWhenReleased, "rev1 was never released at all").toBeDefined();
    expect(idleWhenReleased, "a full queue must not starve the backstop").toBe(false);
  });

  it("are released once the review is expired", async () => {
    review("rev1", "expired");
    const reviewer = new Keeping(["rev1"]);

    await idleOnce(reviewer);

    expect(reviewer.released).toStrictEqual(["rev1"]);
  });

  /**
   * A REVIEW THAT IS STILL OPEN KEEPS ITS SESSION, which is the whole feature. Releasing
   * on a reconcile tick would compact nothing and save nothing — it would just make every
   * round after the first a cold start again, silently, while the flag still said the
   * session was being kept.
   */
  /**
   * THE ROWS MUST OUTLIVE THE RELEASE THAT READS THEM.
   *
   * `clearSessionTrees` deletes the durable `session-id:` rows (D-122), and after a
   * restart those rows are the ONLY record of which opencode sessions a review holds —
   * the in-memory map is empty by design, which is the whole reason they exist. Clearing
   * before releasing therefore deleted the ids and left `release` enumerating nothing:
   * no DELETE reached opencode, and the sessions lived until opencode itself restarted.
   * That is the accumulation `release` exists to prevent, on the one path this reconcile
   * is the designated backstop for.
   *
   * Asserted by having the fake reviewer READ the store at release time, which is exactly
   * what the real one does through its port. A test that only checked "release was
   * called" passed against the broken order.
   */
  it("still has the durable session rows when release runs", async () => {
    review("rev1", "expired");
    const key = "rev1:t2:openrouter/moonshotai/kimi-k3";
    store.setKeptSession(key, "ses_kept");
    let sawAtRelease: readonly string[] = [];
    // A `Keeping` rather than a bare object, because `idleOnce` waits on `.released` —
    // the harness's own signal that the reconcile has happened.
    class Watching extends Keeping {
      override async release(id: string): Promise<void> {
        // WHAT THE REAL ONE DOES: it reads the durable keys to find the sessions to
        // delete. If the rows are already gone, it deletes nothing and says nothing.
        sawAtRelease = store.keptSessionKeys();
        await super.release(id);
      }
    }
    const spy = new Watching(["rev1"]);

    await idleOnce(spy);

    expect(sawAtRelease, "release could still see what to delete").toContain(key);
    // WAITED FOR, not asserted immediately: `idleOnce` returns the moment `release` is
    // ENTERED, and the clear is the statement after it returns. Asserting straight away
    // reads the store mid-sequence and fails against the correct implementation — the
    // same race the comment at the top of this file describes for the release itself.
    const deadline = Date.now() + 10_000;
    while (store.keptSessionKeys().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(store.keptSessionKeys(), "and only then are the rows cleared").toStrictEqual([]);
  });

  it("are left alone while the review is still open", async () => {
    review("rev1", "findings_ready");
    review("rev2", "running");
    const reviewer = new Keeping(["rev1", "rev2"]);

    root = mkdtempSync(join(tmpdir(), "lore-reconcile-"));
    const worker = new Worker(
      store,
      { ...DEFAULT_WORKER, pollMs: 5, reposRoot: join(root, "repos") },
      new Alerter({ timeoutMs: 10 }),
      reviewer,
    );
    const stop = worker.start();
    // Nothing to wait FOR here — the assertion is that nothing happens — so this is the
    // other kind of sleep, where elapsed time is the point. Many poll intervals.
    await new Promise((r) => setTimeout(r, 120));
    stop();

    expect(reviewer.released).toStrictEqual([]);
  });

  /**
   * A REVIEW THAT NO LONGER EXISTS is not a review that is still open. Retention deletes
   * old rows outright, and reading "no such review" as "leave its sessions alone" would
   * make deletion the one way to leak them permanently.
   */
  it("are released when the review row has been deleted", async () => {
    const reviewer = new Keeping(["rev_gone"]);

    await idleOnce(reviewer);

    expect(reviewer.released).toStrictEqual(["rev_gone"]);
  });

  it("are released for a review that finished with a verdict", async () => {
    review("rev1", "passed");
    const reviewer = new Keeping(["rev1"]);

    await idleOnce(reviewer);

    expect(reviewer.released).toStrictEqual(["rev1"]);
  });
});

// lore-ok[f487b406]: found by lore's own review. dispatch()'s own call site is
// `void this.maybeReconcile()` with no `.catch` — the exact detached-promise
// shape already fixed this round for round()'s own catch block, one function
// above worker.ts's own maybeReconcile. A database that is merely CORRUPTED,
// not closed, still answers isClosed() === false, and repoAndStateOf throws on
// it exactly as finishJob did in that other fix. A Proxy stands in: nothing was
// actually closed, but the very first store read a reconcile makes faults as
// if it hit SQLITE_CORRUPT.
describe("a store read that faults during reconcile does not crash the process", () => {
  it("stops quietly instead of throwing out of the detached maybeReconcile call", async () => {
    review("rev1", "expired");
    const reviewer = new Keeping(["rev1"]);

    let calls = 0;
    const corrupted = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "repoAndStateOf") {
          return () => {
            calls += 1;
            throw new Error("simulated: SQLITE_CORRUPT");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    root = mkdtempSync(join(tmpdir(), "lore-reconcile-"));
    const worker = new Worker(
      corrupted,
      { ...DEFAULT_WORKER, pollMs: 5, reposRoot: join(root, "repos") },
      new Alerter({ timeoutMs: 10 }),
      reviewer,
    );

    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    const stop = worker.start();
    try {
      const deadline = Date.now() + 10_000;
      while (calls === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      // Long enough for a rejection to surface if it escapes past maybeReconcile's own catch.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      stop();
      process.off("unhandledRejection", onRejection);
    }

    expect(calls, "the corrupted read must actually have been reached").toBeGreaterThan(0);
    expect(reviewer.released, "release must never be reached past a faulted read").toStrictEqual([]);
    expect(rejections, "a corrupted reconcile read must not crash the process").toStrictEqual([]);
  });
});
