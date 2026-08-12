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
