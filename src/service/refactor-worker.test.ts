/**
 * `RefactorWorker`'s own dispatch loop — narrow on purpose. The fan-out/combine logic
 * is `src/refactor/run.test.ts`'s job; this file is what the claim loop itself does
 * around that call, the same split `worker.ts` (untested directly) and `drain.test.ts`
 * (its own dispatch behavior) already have.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewerLike } from "../reviewer/opencode.ts";
import type { RefactorSuggestion } from "../refactor/suggestion.ts";
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

/**
 * lore-ok[7565fe66]: found by lore's own review — `finishRefactorRun(done)` used to
 * run BEFORE `recordRefactorSuggestions`, so a crash (or store fault) between the two
 * left a TERMINAL `done` row — `reclaimOrphanedRefactorRuns` only revisits `running` —
 * whose `sources` claimed real counts while zero suggestions existed to back them,
 * indistinguishable from a genuine "nothing worth changing" answer. A real worktree is
 * needed here (`execute` must actually reach the write pair), mirrored on
 * `drain.test.ts`'s own `makeRepo`/`withMirror` fixtures.
 */
describe("suggestions are written before the state that announces them", () => {
  let root: string;
  let savedTiers: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lore-refactor-worker-"));
    savedTiers = process.env["LORE_TIERS"];
    // ONE tier marked suitable, and no t1 — `execute` only needs to REACH the write
    // pair this test is about; the "no usable t1 to combine" fallback still produces
    // a real, non-empty `result.suggestions` (the raw union), which is all this needs.
    process.env["LORE_TIERS"] = JSON.stringify([
      { id: "t2", kind: "model", model: "kimi-for-coding/k3", stage: "deep", refactor: true },
    ]);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedTiers === undefined) delete process.env["LORE_TIERS"];
    else process.env["LORE_TIERS"] = savedTiers;
  });

  const withMirror = (repo: string) => {
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    const g = (...a: string[]) => execFileSync("git", a, { cwd: src, stdio: "ignore" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@e.com");
    g("config", "user.name", "t");
    writeFileSync(join(src, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "x");
    const bare = join(root, "repos", repo, "bare.git");
    mkdirSync(join(bare, ".."), { recursive: true });
    execFileSync("git", ["clone", "--bare", src, bare], { stdio: "ignore" });
    // A remote with no FETCH_HEAD is a clone whose fetch failed — `make mirror` always
    // leaves one behind, and `worktreeFor` refuses a mirror without it (D-65).
    writeFileSync(join(bare, "FETCH_HEAD"), "");
  };

  const ONE_SUGGESTION = [{ title: "t", area: ["a.txt"], rationale: "r" }];

  it("keeps recorded suggestions even when the write that announces them fails", async () => {
    withMirror(repoId);
    store.createRefactorRun({ id: "refactor_r1", repoId, principal: "alice", commitSha: "main", folder: "." });

    const reviewer: ReviewerLike = {
      review: () => {
        throw new Error("not used here");
      },
      askFor: async <T>() => ({
        items: ONE_SUGGESTION as unknown as readonly T[],
        raw: "",
        inputTokens: 1,
        cachedTokens: 0,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        retried: false,
        steps: 1,
        rejected: [],
      }),
    };

    let sawSuggestionsBeforeFinish: readonly RefactorSuggestion[] | undefined;
    const faultingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "finishRefactorRun") {
          // The exact moment the pre-fix code would already have written `done` —
          // read what recordRefactorSuggestions left behind BEFORE letting this throw.
          sawSuggestionsBeforeFinish = target.refactorRun("refactor_r1")?.suggestions;
          return () => {
            throw new Error("simulated: fault writing the terminal state");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const worker = new RefactorWorker(faultingStore, { reposRoot: join(root, "repos"), pollMs: 10 }, reviewer);
    const stop = worker.start();
    try {
      // WAIT FOR THE CONDITION, NOT FOR A DURATION.
      //
      // This slept a fixed 300ms and then asserted. In that window the worker has to
      // poll, claim the run, `git worktree add` off a bare clone and reach the reviewer
      // before `finishRefactorRun` is ever touched — comfortably inside 300ms alone, and
      // not inside it with the suite running eighty files. It then failed as
      // `expected undefined to equal [...]`, which reads as "the fix regressed" rather
      // than "the worker had not got there yet", on a test whose whole subject is the
      // ORDER of two writes.
      //
      // Exactly the signature `drain.test.ts` carried until 2026-08-11 — its third
      // occurrence — and the same remedy: faster in the normal case, correct in the slow
      // one, and it names what it was waiting for when it genuinely does not happen.
      const deadline = Date.now() + 10_000;
      while (sawSuggestionsBeforeFinish === undefined) {
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for: the worker to reach finishRefactorRun");
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      stop();
    }

    expect(sawSuggestionsBeforeFinish, "recordRefactorSuggestions must have already committed").toStrictEqual(ONE_SUGGESTION);
  }, 20_000);
});
