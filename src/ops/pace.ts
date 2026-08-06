/**
 * When to come back, measured rather than guessed.
 *
 * Every text this service ships told a waiting client to *"poll again in 10s, backing
 * off to 60s"*. Against the measured reality of this deployment — t1's median round is
 * 323s and t2's is 820s — that instructs a client to make roughly seven calls before a
 * cheap round can possibly have finished, and fifteen before a deep one can. For an
 * agent client every one of those is a turn: context and wall-clock spent to be told
 * `running`.
 *
 * **This is not the progress estimate SPEC §2 refuses, and the difference is the whole
 * justification.** *"How far along is this review"* is unanswerable and we go on
 * refusing it. *"Nothing can have happened before the median round of the tier that is
 * currently working"* is a fact about the tier, taken from `usage.latency_ms` — the
 * same column D-58 reads for the size ceiling — and it collapses fifteen calls into
 * one.
 *
 * **It refuses to answer rather than guess**, on the same rule as D-58: with too few
 * runs, or a distribution too wide to have a middle, there is no honest number and
 * saying nothing is correct. t3 is the live example in our own table — n=12 spread
 * across 126s to 1691s, which is two populations (a tier that refused early and a tier
 * that actually read the code), and a median of that is arithmetic rather than
 * knowledge.
 *
 * SPEC: spec/mcp-api.md §2.1.2
 */

import type { Store } from "../store/store.ts";

/**
 * The smallest sample a median is allowed to come from.
 *
 * Twenty is not a statistical threshold, it is an operational one: below it a single
 * pathological branch moves the middle, and the number we ship is read by a client
 * that will act on it without being able to check it.
 */
const MIN_RUNS = 20;

/**
 * How wide a distribution may be before its middle stops meaning anything.
 *
 * p90/p10. A tier whose slowest tenth takes six times its fastest tenth is not one
 * thing being measured — t3 sits at 13× because early refusals and real reviews are
 * pooled, and no single number describes both.
 */
const MAX_SPREAD = 6;

export interface Pace {
  /** Milliseconds before anything can plausibly have changed. */
  readonly ms: number;
  /** The tier this describes, so the client can see the number is not about its review. */
  readonly tier: string;
  /** How many runs it came from — the reader's own check on how much to trust it. */
  readonly runs: number;
}

/**
 * How long the given tier's rounds have actually taken on this deployment.
 *
 * `undefined` when the sample cannot support a median. The caller must then say
 * nothing rather than substituting a default: a made-up interval is worse than no
 * interval, because a client cannot tell them apart.
 *
 * Failed runs are excluded. They measure how fast a tier can die — a quota refusal
 * returns in seconds — and pooling them with real reviews drags the median toward a
 * number that describes nothing anyone is waiting for.
 */
export function paceFor(store: Store, tier: string): Pace | undefined {
  const rows = store.db
    .prepare(
      "SELECT latency_ms FROM usage WHERE tier = ? AND latency_ms IS NOT NULL AND outcome != 'failed'" +
        " ORDER BY latency_ms",
    )
    .all(tier) as { latency_ms: number }[];

  if (rows.length < MIN_RUNS) return undefined;

  const at = (p: number) => rows[Math.min(rows.length - 1, Math.floor(rows.length * p))]?.latency_ms ?? 0;
  const p10 = at(0.1);
  const p50 = at(0.5);
  if (p10 <= 0 || at(0.9) / p10 > MAX_SPREAD) return undefined;

  return { ms: p50, tier, runs: rows.length };
}

/**
 * The sentence a waiting client reads, or one that admits there is no number.
 *
 * Both forms say what to DO. A client handed a bare integer has to decide what it
 * means, and the whole failure history of this surface is clients deciding reasonably
 * and wrongly about things nothing told them.
 */
export function paceNote(pace: Pace | undefined): string {
  if (pace === undefined) {
    return (
      "There is no measured interval for the tier now running — too few completed rounds to have an honest " +
      "median, so none is offered rather than one invented. Wait MINUTES, not seconds, and make one call when " +
      "you come back."
    );
  }
  const secs = Math.round(pace.ms / 1000);
  return (
    `MAKE ONE CALL AFTER ~${String(secs)}s, THEN LEAVE. That is the median round for ${pace.tier} on this ` +
    `repository across ${String(pace.runs)} completed runs — nothing can have happened before it, so polling ` +
    "sooner returns `running` and costs you a turn for nothing. It is a fact about the TIER, not a prediction " +
    "about this review: half of all rounds take longer, and a round that has escalated is a different tier " +
    "with a different number. If it is still running when you return, come back again after the same interval."
  );
}
