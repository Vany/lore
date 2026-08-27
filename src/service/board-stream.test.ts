/**
 * The stream's one promise: a message means the picture actually moved.
 *
 * It was false when written. `board()` stamps `at` on every call, so the string comparison
 * never matched and a full snapshot went out every two seconds for ever — while the
 * docblock promised an idle board transfers nothing, and the page rebuilt its DOM on each
 * one, destroying whatever the reader had selected. Raised by lore's own t2 against the
 * change that made the promise.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { startBoardStream } from "./board-stream.ts";

let dir: string;
let store: Store;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "lore-stream-"));
  store = new Store(join(dir, "lore.db"));
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A response that records what was written to it, and nothing else. */
const fakeRes = () => {
  const written: string[] = [];
  const res = {
    writeHead: () => res,
    write: (s: string) => { written.push(s); return true; },
    end: () => undefined,
    on: () => res,
  } as unknown as ServerResponse;
  return { res, written, frames: () => written.filter((w) => w.startsWith("data:")) };
};

describe("an idle board transfers nothing", () => {
  it("sends one frame on attach and none while nothing changes", () => {
    const s = startBoardStream(store, 2_000, 15_000);
    const w = fakeRes();
    s.add(w.res);
    expect(w.frames().length, "the picture, immediately — a stream carries no history").toBe(1);

    // Ten ticks, twenty seconds of wall clock, nothing happening.
    vi.advanceTimersByTime(20_000);
    expect(w.frames().length, "`at` moving is not the picture moving").toBe(1);
    // The heartbeat still proves the socket is ours, and is not a data frame.
    expect(w.written.some((x) => x.startsWith(":")), "still-alive comment").toBe(true);
    s.close();
  });

  it("sends a frame the moment something really changes", () => {
    const s = startBoardStream(store, 2_000, 15_000);
    const w = fakeRes();
    s.add(w.res);

    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id: "r1", repoId, principal: "p", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });

    vi.advanceTimersByTime(2_000);
    expect(w.frames().length).toBe(2);
    expect(w.frames()[1]).toContain("feat/x");
    s.close();
  });
});

// lore-ok[9a9dc489]: found by lore's own review. A raw `setInterval` callback
// has nothing catching it by default — unlike `add`'s own `snapshot()` call,
// which runs inside http.ts's request handler and is already caught there. A
// throwing tick used to become an UNCAUGHT EXCEPTION (tick is synchronous, so
// there is no promise for `unhandledRejection` to name), which by Node's
// default kills the whole process. Real timers here, not the file's usual
// fake ones: only a real event loop actually emits `uncaughtException`.
describe("a tick that throws does not crash the process", () => {
  it("does not let a snapshot fault escape as an uncaught exception", async () => {
    vi.useRealTimers();
    let calls = 0;
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "boardReviews") {
          // The FIRST call is `add`'s own — let it through so the stream
          // actually starts. Every call after that is a `tick`, and that is
          // the one this test is about.
          return (...args: unknown[]) => {
            calls += 1;
            if (calls > 1) throw new Error("simulated: SQLITE_CORRUPT");
            return target.boardReviews(...(args as Parameters<typeof target.boardReviews>));
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const s = startBoardStream(flaky, 10, 15_000);
    const w = fakeRes();
    const exceptions: unknown[] = [];
    const onException = (e: unknown) => exceptions.push(e);
    process.on("uncaughtException", onException);
    try {
      s.add(w.res);
      // Several ticks, every one after the first throwing inside snapshot().
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("uncaughtException", onException);
      s.close();
    }
    expect(calls, "the flaky tick must actually have been reached").toBeGreaterThan(1);
    expect(exceptions, "a throwing tick must not crash the process").toStrictEqual([]);
  });
});
