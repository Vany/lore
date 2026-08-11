/**
 * When a tier keeps its session, and when that session is compacted (D-80).
 *
 * Vany: *"the main idea is to stop restarting it and continue the session in opencode, and
 * manage it so each model will be started and initialised only once per review"*, and
 * *"let's compact if the session is 2/3 of context."*
 *
 * **What this replaces.** Every round used to be a cold start: a new session, the whole
 * prompt rebuilt, and the model re-orienting itself in a worktree it had examined minutes
 * earlier. Measured across 128 completed t2 rounds — 31.6 turns and 972K cached reads a
 * round, with **63 of 218 model rounds (29%) being a tier re-reading a review it already
 * knew**. `settledBlock` in the prompt is the workaround, and it names the problem: it
 * exists to re-tell a fresh session what the last one had already decided.
 *
 * **Compaction, not restart, and the distinction is the point.** Restarting on the fixed
 * tree keeps the CODE and throws away the REASONING — why the model looked where it
 * looked, what it ruled out, what it was suspicious of and let go. I proposed exactly that
 * and was corrected: *"I said compact, who said restart?"* The worktree is not the memory
 * of a review, only of its subject.
 *
 * **A new tier still starts empty.** Continuity is within one tier's run, never across
 * tiers: a tier that inherited the previous model's conclusions would make three tiers into
 * one opinion asked three times, which is what D-1 and D-49 exist to prevent. What travels
 * to the next tier is the RECORD — `settledBlock` — not the reasoning.
 *
 * SPEC: SPEC.md D-80, spec/mcp-async.md §6
 */

/**
 * The fraction of a tier's context window at which its session is compacted.
 *
 * Vany's number. Two thirds leaves room for the turn that follows the compaction to
 * actually say something: compacting at the brim would summarise, then immediately
 * overflow on the next diff.
 *
 * opencode compacts on its own as well — `CompactionPart` carries `auto: boolean` — so
 * this is choosing the threshold deliberately rather than inheriting whatever it would
 * otherwise pick.
 */
export const COMPACT_AT = 2 / 3;

/**
 * One session per REVIEW and TIER, which is the whole of the addressing.
 *
 * Not per review: t1's conversation and t2's are different models with different
 * judgement, and merging them is the failure the ladder exists to avoid. Not per tier:
 * two reviews of different branches share nothing.
 */
export function sessionKey(reviewId: string, tierId: string): string {
  return `${reviewId}:${tierId}`;
}

/**
 * Is this session close enough to full to be compacted before the next turn?
 *
 * `used` is the context the LAST turn actually carried — input plus cache reads on the
 * most recent assistant message — not the session's cumulative spend. The two differ by a
 * factor of thirty on a long round, and using the sum would compact almost immediately and
 * then every turn after.
 *
 * Unknown window means NO: a tier whose context we cannot measure gets the behaviour it
 * had before this existed, which is the safe direction. Guessing a window and compacting
 * against it would throw away reasoning on a false alarm.
 */
export function shouldCompact(used: number | undefined, window: number | undefined): boolean {
  if (used === undefined || window === undefined || window <= 0) return false;
  return used >= window * COMPACT_AT;
}
