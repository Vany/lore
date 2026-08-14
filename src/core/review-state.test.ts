/**
 * `decidedByPersonOrClock` is the one predicate three late-held-diff call sites share
 * (worker.ts ×2, review.ts's rungMismatch override) — pinned here directly because the
 * bug it fixes is entirely IN the predicate: `isTerminal` treated `passed` exactly like
 * `cancelled`, so a diff that genuinely landed in the store just before a round's own
 * conclusion was orphaned behind a state a client reads as final and never rechecks.
 */

import { describe, expect, it } from "vitest";
import { decidedByPersonOrClock, isTerminal, REVIEW_STATES } from "./review-state.ts";

describe("decidedByPersonOrClock", () => {
  it("is true only for the endings nobody but a person or the sweep chooses", () => {
    expect(decidedByPersonOrClock("cancelled")).toBe(true);
    expect(decidedByPersonOrClock("expired")).toBe(true);
  });

  // The whole point: a round's OWN conclusion must still be reopenable by a diff that
  // was genuinely in the store the instant before it concluded.
  it("is false for every terminal state a round reaches on its own", () => {
    expect(decidedByPersonOrClock("passed")).toBe(false);
    expect(decidedByPersonOrClock("passed_partial")).toBe(false);
    expect(decidedByPersonOrClock("failed")).toBe(false);
  });

  // And false for everything non-terminal, where the question does not even arise.
  it("is false for every state that is not terminal at all", () => {
    for (const s of REVIEW_STATES) {
      if (isTerminal(s)) continue;
      expect(decidedByPersonOrClock(s)).toBe(false);
    }
  });

  // Exactly the two states, never more — a state added to TERMINAL later without an
  // opinion here would silently fall on the "reopenable" side, which is the safe
  // direction (INV-1 prefers a stale-looking reopen over a silently dropped diff), but
  // worth pinning so a future state is a deliberate choice rather than a default.
  it("agrees with TERMINAL_SQL's two person-or-clock members and no others", () => {
    const decided = REVIEW_STATES.filter((s) => decidedByPersonOrClock(s));
    expect(decided.sort()).toStrictEqual(["cancelled", "expired"].sort());
  });
});
