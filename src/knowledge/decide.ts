/**
 * A person settling a contradiction — the one action `needs_human` is waiting for.
 *
 * Two callers now, and that is why it is a function rather than a handler: `knowledge_resolve`
 * over MCP, where an agent relays a decision its user made, and a button on the operator
 * board, where the person clicks it themselves. Both must do exactly the same three things
 * — retire the losing statement, resume the reviews it blocked, and record that a HUMAN
 * decided — because a review resumed one way and a review resumed the other way must not
 * be distinguishable afterwards.
 *
 * **The client has to learn that the decision was made without it.** From the client's
 * side a resume looks like an ordinary state change: it was parked, now it is queued. If
 * that is all it sees, it does the thing the state used to demand — take the question to
 * its user — and asks somebody who has already answered. So the decision travels on the
 * review itself and `review_poll` reports it.
 *
 * SPEC: SPEC.md D-99, spec/knowledge.md §7.3
 */

import type { Store } from "../store/store.ts";

export interface Decision {
  readonly repoId: string;
  /** The statement that survives. */
  readonly keep: string;
  /** The statement that is retired — kept in the database, never deleted. */
  readonly retire: string;
  readonly reason: string;
  /** Who decided, in words a later reader can act on: a principal, or the board. */
  readonly by: string;
}

export interface DecisionResult {
  readonly resolved: boolean;
  /** Reviews taken off `needs_human` by this decision. */
  readonly resumed: number;
  /** Conflicts still open in this repository, which is why `resumed` can be zero. */
  readonly stillBlocking: number;
}

export function decide(store: Store, d: Decision): DecisionResult {
  const resolved = store.resolveConflict(d.repoId, d.keep, d.retire, `${d.reason} — decided by ${d.by}`);
  if (!resolved) return { resolved: false, resumed: 0, stillBlocking: store.openConflicts(d.repoId).length };

  // ONLY WHEN NOTHING ELSE IS STILL OPEN. `needsHuman` is recomputed from the
  // repository's open conflicts, not from one a review could name, so a review parked
  // while a second contradiction stands would buy one paid round and park again at the
  // end of it — reporting progress that is not happening.
  const stillBlocking = store.openConflicts(d.repoId).length;
  const resumed =
    stillBlocking === 0
      ? store.resumeNeedsHuman(
          d.repoId,
          // Written for the CLIENT to read and act on, not for a log. It says a person
          // decided, what they decided, and — because the client's instinct on seeing
          // `needs_human` is to go and ask somebody — that asking again would be asking
          // a question that has an answer.
          `A person answered the question that blocked this review: ${d.reason} (kept ${d.keep}, ` +
            `retired ${d.retire}; decided by ${d.by}). You do not need to raise it with your ` +
            `user — it has been decided. Carry on from where the review stopped.`,
        )
      : 0;
  return { resolved: true, resumed, stillBlocking };
}
