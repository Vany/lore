/**
 * The states a review can be in, and which of them mean "clean".
 *
 * Exactly one state means the branch is reviewed and clean. Everything else is
 * some flavour of not-that, and the distinctions are load-bearing: `failed`,
 * `expired` and `fast_clean` are all ways a caller could wrongly conclude nothing
 * was found (INV-1).
 *
 * SPEC: spec/mcp-api.md §3
 */

export const REVIEW_STATES = [
  "queued",
  "running",
  "findings_ready",
  "awaiting_diff",
  /** Fast tiers clean; the deep tiers are still running. NOT a pass. */
  "fast_clean",
  /** A question only a person can answer is open. Blocks passing and attesting. */
  "needs_human",
  /** The only state that means reviewed and clean. */
  "passed",
  /** Every AVAILABLE tier agreed; others could not be paid for (D-48). */
  "passed_partial",
  /** Did not complete. Never "found nothing". */
  "failed",
  /** Abandoned or timed out. Also never "found nothing". */
  "expired",
  /**
   * Stopped on purpose, by whoever started it.
   *
   * Its own state rather than `expired`, because the two mean opposite things about
   * the person: `expired` is nobody came back, `cancelled` is somebody decided. Both
   * are terminal, neither is a pass, and neither says anything about the code — but
   * collapsing them would lose the one fact worth keeping, which is that a human made
   * a choice. Findings already raised are still real and are handed over.
   */
  "cancelled",
] as const;

export type ReviewState = (typeof REVIEW_STATES)[number];

/** Terminal states — no further work will happen without a new review. */
const TERMINAL = new Set<ReviewState>(["passed", "passed_partial", "failed", "expired", "cancelled"]);

/**
 * The same set, for SQL that has to name them.
 *
 * Derived rather than written out, because it was written out and one copy was
 * wrong: `expireStale` listed `'passed', 'failed', 'expired'` and omitted
 * `passed_partial`, so a review that legitimately reached a partial pass would be
 * overwritten with `expired` 48 hours later — a verdict destroyed by a sweep. It had
 * never fired only because `passed_partial` had never occurred in production.
 */
export const TERMINAL_SQL: string = [...TERMINAL].map((s) => `'${s}'`).join(", ");

export function isTerminal(state: ReviewState): boolean {
  return TERMINAL.has(state);
}

/**
 * The only predicate any caller should use to decide whether a branch is clean.
 *
 * Written as a function rather than a comparison so there is one place to be wrong,
 * and so no one is ever tempted to write `state !== "failed"`.
 *
 * **And for its whole life every caller wrote the comparison anyway** — four of them,
 * including both `clean` fields the MCP surface hands a client, which is the single
 * value a client decides to merge on. The function said it was the only one anyone
 * should use and nothing used it, so the "one place to be wrong" was five places.
 * That is the shape PROG.md's first bullet is about, in the most expensive field on
 * the wire: `passed_partial` has already been left out of a hand-written state list
 * three times in this codebase, and here that would read as clean.
 */
export function isClean(state: ReviewState): boolean {
  return state === "passed";
}

/** Can this review be attested? Never while a human question is open (D-39). */
export function isAttestable(state: ReviewState): boolean {
  // A partial review is attestable BECAUSE the attestation names what was skipped.
  // Refusing to attest it would leave the operator with no record at all, which is
  // worse than an honest partial one.
  return state === "passed" || state === "passed_partial";
}
