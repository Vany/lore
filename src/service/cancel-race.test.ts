/**
 * A cancel landing while the worktree is being cut must not be un-done by the write
 * that follows it.
 *
 * `runJob` calls `worktreeFor` — a real git operation with nothing holding the review
 * row for the whole time it runs — and used to write the review into `running`
 * unconditionally right after. A `review_cancel` landing in that window wrote
 * `cancelled`, and that write overwrote it right back, one write before `runRound`'s
 * own TOCTOU check (`review.ts`, "closed at the last moment before anything is
 * spent") ever got a chance to see it — the check that exists specifically to catch a
 * cancel landing microseconds after `claimJob`, defeated by a write between it and the
 * thing it protects. Fingerprint 1b056160, found by lore's own review.
 *
 * `worktreeFor` for a small test repo resolves in low single-digit milliseconds — too
 * fast to race honestly against a real `review_cancel` call and a real sleep, the same
 * lesson `drain.test.ts` already draws for its own cancel tests ("the only faithful
 * shape is the one that happens in production"). `../git/repo.ts` is mocked so the
 * exact instant `worktreeFor` resolves — and only that instant — can fire the cancel
 * deterministically, in place of hoping a sleep lands inside a window this small.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Alerter } from "../ops/alerts.ts";
import { Store } from "../store/store.ts";
import { DEFAULT_WORKER, Worker } from "./worker.ts";

const race = vi.hoisted(() => ({ fn: undefined as (() => void) | undefined }));
vi.mock("../git/repo.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/repo.ts")>();
  return {
    ...actual,
    worktreeFor: async (...args: Parameters<typeof actual.worktreeFor>) => {
      const path = await actual.worktreeFor(...args);
      race.fn?.();
      return path;
    },
  };
});

let store: Store;
let root: string;

// A BRANCH WITH A REAL COMMIT ON IT, not `main` reviewed into `main` — an empty
// change-set is refused before any tier is asked anything (INV-1), which would make
// `reviewerCalled` below stay false regardless of whether this file's own fix exists,
// proving nothing about the race it is here to catch.
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

beforeEach(() => {
  store = new Store(":memory:");
  root = mkdtempSync(join(tmpdir(), "lore-cancel-race-"));
  race.fn = undefined;
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const WAITING = 20_000;

const until = async (what: string, ok: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const jobState = (reviewId: string): string | undefined =>
  (store.db.prepare("SELECT state FROM job WHERE review_id = ?").get(reviewId) as { state?: string } | undefined)?.state;

describe("a cancel that lands while the worktree is being cut", () => {
  it("stays cancelled instead of being resurrected by runJob's own write", async () => {
    const repoId = store.upsertRepo("r", join(root, "src")).id;
    const src = join(root, "src");
    makeRepo(src);
    const bare = join(root, "repos", repoId, "bare.git");
    mkdirSync(join(bare, ".."), { recursive: true });
    execFileSync("git", ["clone", "--bare", src, bare], { stdio: "ignore" });
    writeFileSync(join(bare, "FETCH_HEAD"), "");
    store.createReview({
      id: "rev1", repoId, principal: "p", branch: "work", intoRef: "main",
      ticket: "t", type: "code-arch", state: "queued", ladder: initialState(),
    });
    store.enqueue("rev1", "fast");

    // Fires exactly once, the instant worktreeFor resolves — the real window a
    // review_cancel call lands in, made deterministic instead of raced with a sleep.
    race.fn = () => {
      race.fn = undefined;
      store.updateReview("rev1", { state: "cancelled" });
      store.setFailureReason("rev1", "cancelled by alice: testing the race");
    };

    let reviewerCalled = false;
    const worker = new Worker(
      store,
      { ...DEFAULT_WORKER, pollMs: 5, reposRoot: join(root, "repos") },
      new Alerter({ timeoutMs: 10 }),
      {
        review: () => {
          reviewerCalled = true;
          return Promise.reject(new Error("must never be reached — the review was already cancelled"));
        },
      },
    );
    const stop = worker.start();
    try {
      await until("the job to finish, whichever way", () => {
        const s = jobState("rev1");
        return s === "done" || s === "failed";
      });
    } finally {
      stop();
      await until("the round to leave the reviewer alone", () => worker.inFlight() === 0);
    }

    expect(store.stateOf("rev1"), "the cancel must win, not be clobbered back to running").toBe("cancelled");
    expect(store.failureReason("rev1")).toContain("testing the race");
    expect(reviewerCalled, "a cancelled review must never reach a paid tier").toBe(false);
  }, WAITING);
});
