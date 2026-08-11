/**
 * When a session is compacted, and when it is left alone.
 *
 * The threshold is Vany's — two thirds of the tier's context window — and both of its
 * refusals matter more than the arithmetic. Compacting on a guess would throw away the
 * model's reasoning, which is the whole thing continuity exists to keep; and measuring
 * against the wrong number would compact on the first turn and every turn after.
 */

import { describe, expect, it } from "vitest";
import { COMPACT_AT, sessionKey, shouldCompact } from "./continuity.ts";

describe("the 2/3 rule", () => {
  const WINDOW = 262_144;

  it("leaves a session alone below the threshold", () => {
    expect(shouldCompact(WINDOW / 2, WINDOW)).toBe(false);
    expect(shouldCompact(Math.floor(WINDOW * COMPACT_AT) - 1, WINDOW)).toBe(false);
  });

  it("compacts at the threshold and above", () => {
    expect(shouldCompact(Math.ceil(WINDOW * COMPACT_AT), WINDOW)).toBe(true);
    expect(shouldCompact(WINDOW, WINDOW)).toBe(true);
  });

  /**
   * A tier whose window we cannot read gets the behaviour it had before this existed.
   * Guessing a window and compacting against it would discard reasoning on a false alarm —
   * the same reasoning `settledBlock` already fails to reconstruct.
   */
  it("refuses to compact on an unknown window, rather than guessing one", () => {
    expect(shouldCompact(200_000, undefined)).toBe(false);
    expect(shouldCompact(undefined, WINDOW)).toBe(false);
    expect(shouldCompact(undefined, undefined)).toBe(false);
  });

  // A window of zero is a measurement that failed, not a window. Multiplying it gives a
  // threshold of zero, which would compact every session on every turn for ever.
  it("treats a zero window as no measurement", () => {
    expect(shouldCompact(1, 0)).toBe(false);
    expect(shouldCompact(1, -5)).toBe(false);
  });
});

describe("session addressing", () => {
  /**
   * One session per REVIEW and TIER. Not per review — t1's conversation and t2's are
   * different models with different judgement, and merging them is exactly the failure the
   * ladder exists to prevent (D-1, D-49). Not per tier — two reviews share nothing.
   */
  it("separates tiers within a review, and reviews within a tier", () => {
    expect(sessionKey("rev1", "t1")).not.toBe(sessionKey("rev1", "t2"));
    expect(sessionKey("rev1", "t2")).not.toBe(sessionKey("rev2", "t2"));
    expect(sessionKey("rev1", "t2")).toBe(sessionKey("rev1", "t2"));
  });

  // `release` finds a review's sessions by prefix, so the separator has to be one that
  // cannot appear in a review id — otherwise releasing `rev1` could match `rev10`.
  it("is prefixed by the review id, which is what release matches on", () => {
    expect(sessionKey("rev1", "t2").startsWith("rev1:")).toBe(true);
    expect(sessionKey("rev10", "t2").startsWith("rev1:")).toBe(false);
  });
});
