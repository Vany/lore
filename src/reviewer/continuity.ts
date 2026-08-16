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
 * One session per REVIEW, TIER and MODEL, which is the whole of the addressing.
 *
 * Not per review: t1's conversation and t2's are different models with different
 * judgement, and merging them is the failure the ladder exists to avoid. Not per tier:
 * two reviews of different branches share nothing.
 *
 * **And not per (review, tier) either, which is what this was until it met a fallback.**
 * A tier that runs on its twin keeps its ID and changes its MODEL — so the primary's
 * session was handed to the fallback, and two things went wrong at once. The fallback
 * model received the CONTINUED prompt on its first ever contact with the review, which
 * says "the author has answered" to a reviewer that has never read the code. And opencode
 * ties a session to the model that opened it, so a call lore addressed to
 * `zai-coding-plan` came back with OpenRouter's `402 Insufficient credits` — the route
 * lore reported as tried was not the route that answered. Observed on rev_8ZM1XT7 with
 * both of t2's fallbacks.
 *
 * That last part is why this is not a tidiness fix: `unpayable` means EVERY route refused,
 * and it was being written after a route nobody had actually asked.
 */
export function sessionKey(reviewId: string, tierId: string, model: string): string {
  return `${reviewId}:${tierId}:${model}`;
}

/**
 * WHERE KEPT SESSIONS SURVIVE A RESTART.
 *
 * A port, not the store, because `Reviewer` talks to opencode and should not also know
 * what a database is — and because a test needs to prove "a NEW Reviewer continues what
 * the old one opened", which is a two-instance question that a private Map cannot express
 * at all.
 *
 * It exists because the map was only ever in memory. Everything else D-80 needs was
 * already durable: the ladder, the findings, the ratified justifications, the pinned
 * worktree, and opencode's own sessions (a named volume, which survives the container
 * being recreated). Just the IDS were forgotten, so a deploy silently downgraded every
 * open review to a cold read of the full diff — the expensive half of a restart, and the
 * half nothing reported.
 *
 * Vany: *"deployment must not kill the full ladder, may be one step."*
 *
 * Absent is a supported deployment and means the old behaviour exactly: the CLI keeps no
 * sessions between processes because it does not outlive one.
 */
export interface KeptSessions {
  get(key: string): string | undefined;
  set(key: string, sessionId: string): void;
  /** The session is gone from opencode; never resume this key again. */
  forget(key: string): void;
  /**
   * Every key on record — which the reconcile needs and a lookup cannot give it.
   *
   * Durable ids made a leak reachable that the in-memory map could not have. The worker's
   * reconcile is the designated backstop for the ONE review ending that has no job and no
   * cancel — the retention sweep marking a `findings_ready` review `expired` in SQL — and
   * it asks `keptReviews()` what to sweep. Reading only the process-local cache, it sees
   * nothing after a restart, which is precisely the event these rows exist for: the rows
   * survive the 90-day review deletion (meta has no foreign key) and the opencode sessions
   * live until opencode itself restarts, which is the accumulation `release` exists to
   * prevent.
   */
  keys(): readonly string[];
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
