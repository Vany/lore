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
  /**
   * `findings_ready` that has sat unanswered for `STALE_HOURS` (D-106).
   *
   * Everything about it still works — the findings are collectable, a submit is
   * accepted, the worktree is held — it is the same state wearing gray: a visual and
   * temporal grace between "waiting on you" and "nobody came back". It lasts
   * `STALE_GRACE_DAYS`; only then does the sweep call it `expired`. Vany: *"happens
   * after ready STALE_HOURS, lasts a week, and the same as ready, but gray."*
   */
  "findings_stale",
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
 * A terminal state a person or the clock decided, never the round's own conclusion.
 *
 * Used wherever a diff arrives LATE — after the round that would ordinarily consume it
 * has already written its verdict — to decide whether that verdict should still stand.
 * `cancelled` is somebody's decision and a late diff is simply too late for it; `expired`
 * is nobody coming back, and reviving it from a stray leftover diff would be inventing
 * activity nobody asked for. `passed`, `passed_partial` and `failed` are none of that —
 * they are the round's OWN conclusion, reached the instant before the late diff was
 * noticed, and a diff genuinely sitting in the store at that moment means the conclusion
 * is stale, not that the client's accepted submit silently vanished (INV-1).
 *
 * Three call sites used to gate on plain `isTerminal`, which treats `passed` exactly
 * like `cancelled` — on the one state a client reads as the whole answer and never
 * rechecks, orphaning a diff that landed in the gap after a round's last boundary
 * behind a "held — you do not need to resubmit" promise, silently.
 */
const PERSON_OR_CLOCK_DECIDED = new Set<ReviewState>(["cancelled", "expired"]);

export function decidedByPersonOrClock(state: ReviewState): boolean {
  return PERSON_OR_CLOCK_DECIDED.has(state);
}

/**
 * The same set, for SQL that has to name it — `TERMINAL_SQL`'s sibling, derived for the
 * same reason: written out twice, the two eventually disagree.
 *
 * Needed because `failed` was found sharing `TERMINAL_SQL`'s exclusion in the uncollected-
 * findings query when it should not have: a review that FAILED is the round's own
 * mechanical conclusion, not a person's decision that the work is over, and it says
 * nothing about whether anyone ever saw what a tier found before the round died. Measured
 * live — a HIGH finding on `master`, undelivered for four days, invisible to the alert
 * built to catch exactly this, because the review carrying it happened to end `failed`.
 */
export const PERSON_OR_CLOCK_DECIDED_SQL: string = [...PERSON_OR_CLOCK_DECIDED].map((s) => `'${s}'`).join(", ");

/**
 * The two findings states — bright and gray — for SQL that must treat them alike.
 *
 * Derived here for the same reason `TERMINAL_SQL` is: spelled out at a call site, one
 * copy eventually goes wrong, and `one-definition.test.ts` refuses the spelling outright.
 */
export const FINDINGS_SQL: string = (["findings_ready", "findings_stale"] as const satisfies readonly ReviewState[])
  .map((s) => `'${s}'`)
  .join(", ");

/**
 * States where lore will do nothing further until the CLIENT acts.
 *
 * The distinction the inbox exists to make. A review in `running` is lore's move and
 * needs nothing from anyone; a review in `findings_ready` is stopped, holding a pinned
 * worktree, and will be swept as `expired` — "nobody was ever going to come back" — 48
 * hours after the client last touched it.
 *
 * `needs_human` is here because the client's move is real even though it is not a code
 * change: get a person. Nothing else in the system can do that, and lore cannot notify
 * anyone.
 */
const CLIENT_MOVE = new Set<ReviewState>(["findings_ready", "findings_stale", "awaiting_diff", "needs_human"]);

export function needsClient(state: ReviewState): boolean {
  return CLIENT_MOVE.has(state);
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
