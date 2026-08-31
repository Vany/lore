/**
 * `RefactorWorker`'s own dispatch loop — narrow on purpose. The fan-out/combine logic
 * is `src/refactor/run.test.ts`'s job; this file is what the claim loop itself does
 * around that call, the same split `worker.ts` (untested directly) and `drain.test.ts`
 * (its own dispatch behavior) already have.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewerLike } from "../reviewer/opencode.ts";
import { Store } from "../store/store.ts";
import { RefactorWorker } from "./refactor-worker.ts";

let store: Store;
let repoId: string;

const FAKE_REVIEWER: ReviewerLike = {
  review: () => {
    throw new Error("not used here");
  },
  askFor: async () => {
    throw new Error("draining must stop the claim before this is ever called");
  },
};

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
});

afterEach(() => store.close());

/** lore-ok[9d364d2a]: found by lore's own review — `Worker.dispatch` respects
 * `isDraining` and this dispatcher did not, so a drained deploy still claimed and paid
 * for fresh refactor runs. */
describe("draining (D-121, applied to the refactor dispatcher)", () => {
  it("does not claim a queued run while the service is draining", async () => {
    store.createRefactorRun({ id: "refactor_r1", repoId, principal: "alice", commitSha: "a", folder: "." });
    store.setDraining(true);

    const worker = new RefactorWorker(store, { reposRoot: "/tmp/does-not-matter", pollMs: 10 }, FAKE_REVIEWER);
    const stop = worker.start();
    try {
      // Asserting something did NOT happen — elapsed time is the point, not a
      // condition to poll for (drain.test.ts's own reasoning for when a fixed sleep,
      // rather than waiting for a condition, is the right tool). Several poll
      // intervals (pollMs: 10), so this proves the loop kept declining, not that it
      // merely had not gotten to its first tick yet.
      await new Promise((r) => setTimeout(r, 80));
      expect(store.refactorRun("refactor_r1")?.state).toBe("queued");
    } finally {
      stop();
    }
  });
});

/**
 * lore-ok[5348bfb3,bebf7a5b]: found by lore's own review, twice — `execute` is called
 * through a detached `void this.execute(run)` with no process-level
 * `unhandledRejection` handler anywhere in this service, so a store fault reaching
 * either `gitUrlOf` (which used to sit outside any try) or the catch's own
 * `finishRefactorRun` (which was bare) would have taken the whole process down.
 * A Proxy stands in for "the store faults, truthfully reporting it is not closed" —
 * the same technique `drain.test.ts`'s own `lore-ok[441a6bc1]` test uses for
 * `Worker.round`'s identical shape.
 */
describe("a store fault must not escape the detached execute() as an unhandled rejection", () => {
  it("logs and stops quietly when the failure-handling write itself throws", async () => {
    store.createRefactorRun({ id: "refactor_r1", repoId, principal: "alice", commitSha: "a", folder: "." });

    const faultingStore = new Proxy(store, {
      get(target, prop, receiver) {
        // `gitUrlOf` throws — simulating a store fault reached from OUTSIDE the
        // inner try in the pre-fix code — and the catch's own `finishRefactorRun`
        // throws too, so BOTH halves this fix guards are exercised in one run.
        if (prop === "gitUrlOf") return () => {
          throw new Error("simulated: SQLITE_CORRUPT reading repo");
        };
        if (prop === "finishRefactorRun") return () => {
          throw new Error("simulated: SQLITE_CORRUPT writing the failure");
        };
        return Reflect.get(target, prop, receiver);
      },
    });

    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);

    const worker = new RefactorWorker(faultingStore, { reposRoot: "/tmp/does-not-matter", pollMs: 10 }, FAKE_REVIEWER);
    const stop = worker.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      stop();
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections, "a second store fault while handling the first must not crash the process").toStrictEqual([]);
    // The row is left exactly where the real crash-mid-write case leaves it — startup
    // reclaim is what recovers this, not this call, which is the whole point of
    // logging rather than throwing.
    expect(store.refactorRun("refactor_r1")?.state).toBe("running");
  });
});
