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
