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
/**
 * How long a review will honour a cool-off before trying the primary once anyway.
 *
 * THE COST ASYMMETRY THAT JUSTIFIED "DO NOT EVEN INITIATE" HAS INVERTED. When D-90 was
 * written, asking a dead tier cost the full 2700s deadline, so skipping was obviously
 * right. D-91 made that same question cost about twelve seconds — and D-93 made the
 * alternative a metered call that has cost as much as $4.94. Twelve seconds to maybe save
 * a dollar is a trade worth taking every time.
 *
 * It also closes the only way lore could not learn something: it hears a tier DIE, on the
 * event stream, and had no way at all to hear one RECOVER. A subscription that came back
 * 81 minutes before its stated reset went on being skipped for all 81 of them, paying
 * OpenRouter throughout, and nothing in the system could notice.
 *
 * Fifteen minutes, so a recovery is found within fifteen rather than within however long
 * the provider guessed — and so a genuinely dead tier costs at most twelve seconds per
 * quarter hour rather than per review.
 */
export const PROBE_INTERVAL_MS = 15 * 60_000;

/**
 * Is it time to ask a cooled-off tier whether it is back?
 *
 * `probedAt` absent means the mark predates probing, and the honest reading is "never
 * probed" — so the first review after a deploy asks once, which is the same twelve
 * seconds and immediately correct if the tier recovered while lore was down.
 */
export function shouldProbe(mark: { readonly probedAt?: string } | undefined, now: number): boolean {
  if (mark === undefined) return false;
  const last = mark.probedAt === undefined ? Number.NaN : Date.parse(mark.probedAt);
  return Number.isNaN(last) || now - last >= PROBE_INTERVAL_MS;
}

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
