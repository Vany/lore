/**
 * The memory door, and the two ways it can be wrong.
 *
 * It can refuse a healthy machine — which is what a rule written against `MemFree` does
 * on any box that has read a file, and the reason the live numbers below are a fixture
 * rather than an invention. And it can pass a machine it never looked at, which is the
 * more dangerous one: an `allowed` that proves nothing must be distinguishable from an
 * `allowed` that was measured, or the guard is decoration.
 */

import { describe, expect, it } from "vitest";
import { RETRY_AFTER_MS, floorBytes, mayStart, parseMeminfo, readMemory } from "./memory.ts";

const GIB = 1024 * 1024 * 1024;

/**
 * Taken from the deployment on 2026-09-16, while ONE ordinary t0 sandbox was running and
 * nothing was wrong. It is the whole argument for reading MemAvailable: MemFree is under
 * a gigabyte here, and the machine is fine.
 */
const LIVE = [
  "MemTotal:        8124000 kB",
  "MemFree:         1018128 kB",
  "MemAvailable:    2522140 kB",
  "Cached:          1513292 kB",
  "SwapTotal:       1048572 kB",
].join("\n");

describe("reading the machine", () => {
  it("takes MemAvailable, not MemFree — the live reading that would have refused a healthy host", () => {
    const state = parseMeminfo(LIVE);
    expect(state.kind).toBe("measured");
    const verdict = mayStart(state, GIB);
    expect(verdict.availableBytes).toBe(2522140 * 1024);
    // MemFree was 1018128 kB — under the same floor a hair, and on the wrong side of it
    // within seconds of any I/O. The rule must not be reading that number.
    expect(verdict.allowed).toBe(true);
  });

  it("says it could not look, rather than reporting a zero", () => {
    const state = parseMeminfo("MemTotal:        8124000 kB");
    expect(state).toStrictEqual({
      kind: "unmeasurable",
      why: "no MemAvailable/MemTotal line in the meminfo read",
    });
  });

  it("does not throw when the file is absent — the CLI runs off a Linux box", () => {
    const state = readMemory("/definitely/not/here/meminfo");
    expect(state.kind).toBe("unmeasurable");
  });
});

describe("the verdict", () => {
  it("refuses below the floor and names what it saw", () => {
    const verdict = mayStart(parseMeminfo("MemTotal: 8124000 kB\nMemAvailable: 700000 kB"), GIB);
    expect(verdict.allowed).toBe(false);
    expect(verdict.measured).toBe(true);
    expect(verdict.retryAfterMs).toBe(RETRY_AFTER_MS);
  });

  it("admits exactly at the floor: the floor is what must remain, not what must be beaten", () => {
    expect(mayStart(parseMeminfo(`MemTotal: 8124000 kB\nMemAvailable: ${GIB / 1024} kB`), GIB).allowed).toBe(true);
  });

  it("ADMITS when it cannot measure, and marks that the guard did not fire on evidence", () => {
    const verdict = mayStart({ kind: "unmeasurable", why: "no /proc here" }, GIB);
    // Allowed, because refusing every review over a protection that cannot see is a worse
    // outage than the one it prevents...
    expect(verdict.allowed).toBe(true);
    // ...and `measured` is the field that stops a caller reporting this as a healthy box.
    expect(verdict.measured).toBe(false);
    expect(verdict.availableBytes).toBeUndefined();
  });
});

describe("the floor", () => {
  it("defaults to a gigabyte", () => {
    expect(floorBytes({})).toBe(GIB);
    expect(floorBytes({ LORE_MIN_AVAILABLE_MB: "" })).toBe(GIB);
  });

  it("reads megabytes from the environment", () => {
    expect(floorBytes({ LORE_MIN_AVAILABLE_MB: "2048" })).toBe(2 * GIB);
  });

  it("REFUSES a value it cannot parse rather than falling back to the default", () => {
    // `Number("2g")` is NaN, and every comparison against NaN is false — so a unit-suffixed
    // value would leave the door permanently open while looking configured.
    expect(() => floorBytes({ LORE_MIN_AVAILABLE_MB: "2g" })).toThrow(/megabytes/);
    expect(() => floorBytes({ LORE_MIN_AVAILABLE_MB: "-1" })).toThrow(/megabytes/);
  });
});
