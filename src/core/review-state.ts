/**
 * The states a review can be in, and which of them mean the code was CLEARED.
 *
 * Two states mean the ladder read this tree and found nothing: `passed` and
 * `passed_thin_ladder`. They differ in how much independent scrutiny stood behind that,
 * never in what was concluded. Everything else is some flavour of not-that, and the
 * distinctions are load-bearing: `failed`, `expired` and `fast_clean` are all ways a
 * caller could wrongly conclude nothing was found (INV-1).
 *
 * SPEC: spec/mcp-api.md §3, D-147
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
  /** Cleared by the FULL ladder: every configured tier ran, each a distinct vendor. */
  "passed",
  /**
   * Cleared, on a thinner ladder than the one this deployment describes (D-147).
   *
   * Renamed from `passed_partial` on 2026-09-10, because that name put it in the wrong
   * column and clients acted on the column. "Partial" attaches to *passed* — it reads as
   * a half-verdict, something unfinished — while what is actually reduced is the LADDER:
   * either a tier above the highest that ran never looked (D-48), or fewer distinct
   * vendors read the code than tiers ran (D-49/D-88). The verdict itself is whole. Every
   * tier that ran agreed.
   *
   * This is not the exception it was named for. Measured on the live store the day of the
   * rename: 201 of 408 reviews all-time, and 54 of the 61 that concluded cleanly since
   * 2026-09-01. A client that reads the NORMAL ending of a lore review as "not a pass"
   * stops in the middle of its own loop, which is what Vany reported and what this name
   * exists to stop.
   */
  "passed_thin_ladder",
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
const TERMINAL = new Set<ReviewState>(["passed", "passed_thin_ladder", "failed", "expired", "cancelled"]);

/**
 * The same set, for SQL that has to name them.
 *
 * Derived rather than written out, because it was written out and one copy was
 * wrong: `expireStale` listed `'passed', 'failed', 'expired'` and omitted
 * `passed_thin_ladder`, so a review that legitimately reached a partial pass would be
 * overwritten with `expired` 48 hours later — a verdict destroyed by a sweep. It had
 * never fired only because `passed_thin_ladder` had never occurred in production.
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
 * activity nobody asked for. `passed`, `passed_thin_ladder` and `failed` are none of that —
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
 * change: get a person. Nothing else in the system can do that, and lore cannot reach
 * one.
 */
const CLIENT_MOVE = new Set<ReviewState>(["findings_ready", "findings_stale", "awaiting_diff", "needs_human"]);

export function needsClient(state: ReviewState): boolean {
  return CLIENT_MOVE.has(state);
}

/**
 * Did the ladder read this tree and find nothing? The one predicate for that question.
 *
 * REPLACES BOTH `isClean` AND `isAttestable` (D-147), which were two names asking one
 * question and disagreeing about the answer. `isAttestable` returned true for both
 * passing states; `isClean` returned true only for `passed`, and it is `isClean` that fed
 * the wire field a client decides to merge on. So lore told clients that the state it
 * signs an attestation for is not clean — on 89% of the reviews that concluded cleanly.
 *
 * `clean` was also the wrong WORD, independently of which states it covered. It is a
 * claim about the code, and lore never makes one: the attestation says so in as many
 * words — *"It asserts what was checked. It does NOT assert the code is correct."*
 * `cleared` is a claim about the reading, which is the only thing lore can witness, and
 * it is already this codebase's verb for it — `prompts.ts` tells a tier *"You cleared
 * this tree"*.
 *
 * How much scrutiny stood behind it is a SEPARATE question with a separate answer,
 * `evidenceOf`. One boolean for the decision, one word for the strength, so no client has
 * to parse a state string to find either.
 */
export function isCleared(state: ReviewState): boolean {
  return state === "passed" || state === "passed_thin_ladder";
}

/**
 * How much independent scrutiny stood behind a clearing — and `undefined` when there was
 * no clearing at all.
 *
 * `undefined` is NOT "full" and is NOT a mild "unknown": on `failed`, `expired` or
 * `cancelled` there is no evidence claim to make, because the ladder did not finish
 * reading. INV-1 in its original words. A caller that defaults a missing `evidence` to
 * anything has invented a reading nobody took, which is the exact failure this service
 * exists to refuse, so the docs say what absence means rather than leaving it inferable.
 */
export function evidenceOf(state: ReviewState): "full" | "thin" | undefined {
  if (state === "passed") return "full";
  if (state === "passed_thin_ladder") return "thin";
  return undefined;
}
