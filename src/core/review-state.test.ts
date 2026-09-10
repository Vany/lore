/**
 * `decidedByPersonOrClock` is the one predicate three late-held-diff call sites share
 * (worker.ts ×2, review.ts's rungMismatch override) — pinned here directly because the
 * bug it fixes is entirely IN the predicate: `isTerminal` treated `passed` exactly like
 * `cancelled`, so a diff that genuinely landed in the store just before a round's own
 * conclusion was orphaned behind a state a client reads as final and never rechecks.
 */

import { describe, expect, it } from "vitest";
import { decidedByPersonOrClock, evidenceOf, isCleared, isTerminal, REVIEW_STATES } from "./review-state.ts";

describe("decidedByPersonOrClock", () => {
  it("is true only for the endings nobody but a person or the sweep chooses", () => {
    expect(decidedByPersonOrClock("cancelled")).toBe(true);
    expect(decidedByPersonOrClock("expired")).toBe(true);
  });

  // The whole point: a round's OWN conclusion must still be reopenable by a diff that
  // was genuinely in the store the instant before it concluded.
  it("is false for every terminal state a round reaches on its own", () => {
    expect(decidedByPersonOrClock("passed")).toBe(false);
    expect(decidedByPersonOrClock("passed_thin_ladder")).toBe(false);
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

/**
 * D-147. `clean` and `attestable` were two predicates asking one question and answering
 * it differently, and the wire shipped the stricter of the two — so lore told a client
 * that the state it signs an attestation for was not clean, on 89% of the reviews that
 * concluded cleanly. These pin the merged pair.
 */
describe("isCleared", () => {
  it("is exactly the two states the ladder concludes clean on", () => {
    expect(REVIEW_STATES.filter(isCleared)).toStrictEqual(["passed", "passed_thin_ladder"]);
  });

  // THE REGRESSION THIS EXISTS FOR: the thin ladder falling back out of the set. It has
  // been left off a hand-written state list four times in this codebase, and every one of
  // those was a list that read as complete.
  it("includes the thin ladder, which is the ordinary ending here and not an exception", () => {
    expect(isCleared("passed_thin_ladder")).toBe(true);
  });

  it("is false for every ending that concluded nothing, and for fast_clean", () => {
    for (const s of ["failed", "expired", "cancelled", "fast_clean", "needs_human"] as const) {
      expect(isCleared(s), s).toBe(false);
    }
  });
});

describe("evidenceOf", () => {
  it("separates how much read it from whether you may proceed", () => {
    expect(evidenceOf("passed")).toBe("full");
    expect(evidenceOf("passed_thin_ladder")).toBe("thin");
  });

  // ABSENT IS NOT "full", and this is the pin that says so in code rather than only in
  // the docs. A caller defaulting a missing `evidence` would invent a reading nobody
  // took — INV-1 in the smallest possible form.
  it("is undefined wherever there was no clearing at all", () => {
    for (const s of REVIEW_STATES) {
      if (isCleared(s)) continue;
      expect(evidenceOf(s), s).toBeUndefined();
    }
  });

  // The two fields must agree by construction: every cleared state has a strength, and
  // no uncleared state has one. Written as a sweep so a state added later cannot land in
  // one and not the other.
  it("is defined for exactly the states isCleared accepts", () => {
    const withEvidence = REVIEW_STATES.filter((s) => evidenceOf(s) !== undefined);
    expect(withEvidence).toStrictEqual(REVIEW_STATES.filter(isCleared));
  });
});
