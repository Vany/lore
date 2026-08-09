/**
 * How long to leave a tier alone after it could not answer (D-90).
 *
 * One definition, because it is about to have two callers that must not disagree: the
 * background screen decides when to work through its backlog, and a review decides
 * whether to spend a round on a tier at all. Two copies of this arithmetic would drift,
 * and the direction of the drift is invisible — a tier left unused for hours looks
 * exactly like a tier nobody needed.
 *
 * lore cannot ask a provider whether it is available. opencode swallows the refusal in
 * the message body (D-84) and publishes it on its event stream (D-91), so the only two
 * inputs are a call that failed and, when the provider bothered to say, the time it named.
 *
 * SPEC: SPEC.md D-90, D-91
 */

/** The first wait, and the unit the doubling is expressed in. */
export const COOLOFF_MS = 3_600_000;

/**
 * The longest we will go without retrying a tier nobody has told us about.
 *
 * A tier untried for longer than a day is a tier whose recovery nobody would notice, and
 * the work it does — screening a backlog — has no deadline at all.
 */
export const COOLOFF_CAP_MS = 24 * 3_600_000;

/** Never trust a parsed timestamp further than this. A typo in the far future is forever. */
export const RESET_CAP_MS = 7 * 24 * 3_600_000;

/** Never wait less than this, so a bad parse cannot become a busy loop. */
export const RESET_FLOOR_MS = 60_000;

/**
 * Doubling while it keeps failing, because the two failure modes want opposite answers
 * and are indistinguishable at the moment of failure.
 *
 * A provider blip wants a quick retry; an exhausted subscription wants a very long one.
 * Doubling converges on either: a blip costs one wasted hour, and a four-day outage costs
 * 1+2+4+8+16+24+24… ≈ seven wasted calls instead of ninety-six.
 */
export function coolOffMs(consecutiveFailures: number): number {
  return Math.min(COOLOFF_CAP_MS, COOLOFF_MS * 2 ** Math.max(0, consecutiveFailures - 1));
}

/**
 * When to ask this tier again — the provider's own answer if it gave one, ours if not.
 *
 * **A stated reset time beats a guess and it is not close.** Z.ai says *"your limit will
 * reset at 2026-08-10 18:19:09"*; waiting exactly that long is both the shortest correct
 * wait and the longest safe one. The doubling exists for refusals that name nothing, which
 * is what D-90 was written believing was every refusal.
 *
 * Clamped regardless, because a parsed timestamp is input: a floor so a stale or
 * mis-parsed time cannot turn into a retry loop, a ceiling so one bad string cannot retire
 * a tier for a year.
 */
export function retryAt(
  now: number,
  consecutiveFailures: number,
  statedResetAt?: string,
): { readonly until: string; readonly stated: boolean } {
  const said = statedResetAt === undefined ? Number.NaN : Date.parse(statedResetAt);
  if (Number.isNaN(said)) {
    return { until: new Date(now + coolOffMs(consecutiveFailures)).toISOString(), stated: false };
  }
  const clamped = Math.min(now + RESET_CAP_MS, Math.max(now + RESET_FLOOR_MS, said));
  return { until: new Date(clamped).toISOString(), stated: true };
}
