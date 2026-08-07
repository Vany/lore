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

/**
 * The shortest interval this will ever suggest.
 *
 * The conditional median tends to zero as a round outlives the distribution, and a
 * client told to come back in two seconds is the 10-second retry loop this replaced,
 * wearing a measured number.
 */
const FLOOR_MS = 30_000;

export interface Pace {
  /** Milliseconds before anything can plausibly have changed. */
  readonly ms: number;
  /** This round has outlasted every completed run of its tier: no data left to offer. */
  readonly overdue: boolean;
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
export function paceFor(store: Store, tier: string, elapsedMs = 0): Pace | undefined {
  const all = store.latenciesFor(tier);
  if (all.length < MIN_RUNS) return undefined;

  const at = (rows: readonly number[], p: number) => rows[Math.min(rows.length - 1, Math.floor(rows.length * p))] ?? 0;
  const p10 = at(all, 0.1);
  if (p10 <= 0 || at(all, 0.9) / p10 > MAX_SPREAD) return undefined;

  // CONDITIONED ON HOW LONG THIS ROUND HAS ALREADY RUN, and that is the whole point.
  //
  // The first version returned the median every time, whatever the clock said. So a
  // round of 400s against a 323s median told the client to come back at 323s, found it
  // still running, and told it 323s AGAIN — returning at 646s for an answer that had
  // existed since 400. On t2, whose median is 820s, a 900s round put the client back at
  // 1,640s: over twelve minutes with the answer sitting unread. The instruction shipped
  // with it — "come back again after the same interval" — made it explicit.
  //
  // The honest quantity is the median of what is LEFT, over the runs that lasted at
  // least this long. It equals the plain median at elapsed 0, and shrinks from there:
  // surviving past the median is evidence about which half of the distribution this
  // round is in, and throwing that evidence away is what cost the twelve minutes.
  const remaining = all.filter((ms) => ms > elapsedMs).map((ms) => ms - elapsedMs);

  // PAST EVERY RUN EVER RECORDED. There is no distribution left to ask, so the honest
  // answer is a short interval and a sentence saying why — this round is longer than
  // anything measured, and the next thing to happen could be the answer or a timeout.
  // Substituting a median here would be inventing data at exactly the moment we ran out.
  if (remaining.length === 0) {
    return { ms: FLOOR_MS, tier, runs: all.length, overdue: true };
  }

  // Floored, because the arithmetic tends to zero as a round ages and a client told to
  // return in two seconds is the busy loop this replaced.
  return { ms: Math.max(FLOOR_MS, at(remaining, 0.5)), tier, runs: all.length, overdue: false };
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
  if (pace.overdue) {
    return (
      `MAKE ONE CALL AFTER ~${String(secs)}s, THEN LEAVE. This round has now run longer than every completed ` +
      `${pace.tier} round on this repository (${String(pace.runs)} of them), so there is no measurement left to ` +
      "offer you — the next thing to happen could be the answer or a failure, and a longer interval here would " +
      "be invented rather than measured. This is NOT a sign that anything is wrong; deep rounds have a long tail."
    );
  }
  return (
    `MAKE ONE CALL AFTER ~${String(secs)}s, THEN LEAVE. That is how much longer ${pace.tier} rounds typically ` +
    `run from where this one already is, measured across ${String(pace.runs)} completed runs on this ` +
    "repository — so polling sooner returns `running` and costs you a turn for nothing.\n" +
    "READ THIS FIELD AGAIN EVERY TIME; do not reuse the number. It SHRINKS as the round ages, because a round " +
    "that has already outlived the median is not another median away from finishing — it is most of the way " +
    "there. Reusing the first interval is how a client waits twice as long as it needed to."
  );
}
