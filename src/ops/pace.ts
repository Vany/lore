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

/**
 * The LONGEST interval this will ever suggest.
 *
 * Vany: *"if we want to provide a time of polling — it must always be less than 120
 * seconds."* The measured conditional median is honest about when an ANSWER is likely,
 * and it is the wrong number to hand a client that can only poll: it told one to come
 * back in twelve minutes, during which a review can reach `findings_ready`, be answered
 * by nobody, and sit. A client that returns too early learns nothing and costs a turn; a
 * client that returns too late leaves the review parked, which is the dominant way
 * reviews are wasted here.
 *
 * So the median is capped rather than replaced: below two minutes the client still gets
 * the measured number, and above it the wait is bounded whatever the distribution says.
 */
const CEILING_MS = 119_000;

export interface Pace {
  /** Milliseconds before anything can plausibly have changed. */
  readonly ms: number;
  /** This round has outlasted every completed run of its tier: no data left to offer. */
  readonly overdue: boolean;
  /** The tier this describes, so the client can see the number is not about its review. */
  readonly tier: string;
  /**
   * How many runs THIS number came from — the reader's own check on how much to trust it.
   *
   * The conditioned count, not the sample size, and they diverge exactly where trust
   * matters least. A t2 round that has already run 1,500s is compared against the two
   * recorded runs that lasted that long, not against all 34 — so reporting 34 offered
   * the reader a confidence the estimate did not have, in the one field that exists
   * for them to check it with. At elapsed zero the two are the same number.
   */
  readonly runs: number;
  /**
   * Every completed run of this tier on this repository.
   *
   * Kept separate rather than letting `runs` mean one thing early and another late.
   * The overdue sentence is a claim about the WHOLE record — "longer than every round
   * we have" — and needs this; the interval is a claim about a subset and needs the
   * other. One field doing both is how a number ends up describing neither.
   */
  readonly sample: number;
  /**
   * The interval is the CAP, not the measurement — so it will not shrink yet.
   *
   * Vany's rule bounds every suggested wait below two minutes, which is right and is why
   * the cap exists. It also means a tier whose rounds run long reports the same number on
   * every poll, while the note promises a shrinking one. Reported so the note can say
   * which of the two it is handing over.
   */
  readonly capped: boolean;
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
export function paceFor(store: Store, tier: string, repoId: string, elapsedMs = 0): Pace | undefined {
  const all = store.latenciesFor(tier, repoId);
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
    return { ms: FLOOR_MS, tier, runs: 0, sample: all.length, overdue: true, capped: false };
  }

  // Floored, because the arithmetic tends to zero as a round ages and a client told to
  // return in two seconds is the busy loop this replaced.
  //
  // `runs` counts the CONDITIONED sample — the runs this median was actually drawn
  // from. Reporting the full sample here was a quiet overstatement: it grew more
  // confident-looking the longer a round ran, while the evidence behind it shrank.
  const measured = Math.max(FLOOR_MS, at(remaining, 0.5));
  return {
    // Bounded at both ends: never a busy loop, never a wait long enough to lose the
    // review. `CEILING_MS` is the harder of the two — see there.
    ms: Math.min(CEILING_MS, measured),
    tier,
    runs: remaining.length,
    sample: all.length,
    overdue: false,
    // SAY WHEN THE NUMBER IS THE CAP AND NOT THE MEASUREMENT.
    //
    // The note tells a client the interval SHRINKS as a round ages and to re-read it
    // every time. On this repository it does not: t1's conditional median is above two
    // minutes for most of a round, so the cap answers every call and the field reads
    // 119000 four polls running while only the explanatory text changes. A client
    // following the instruction spends turns re-reading a constant, and the instruction
    // is a promise the field cannot keep — which is the drift D-11 calls this
    // repository's most common defect, in a doc rather than in code.
    capped: measured > CEILING_MS,
  };
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
      "median, so none is offered rather than one invented. COME BACK IN ABOUT A MINUTE and make ONE call. " +
      "Not seconds: a round takes minutes, and a tight loop spends a turn per attempt to learn nothing."
    );
  }
  const secs = Math.round(pace.ms / 1000);
  if (pace.overdue) {
    return (
      `MAKE ONE CALL AFTER ~${String(secs)}s, THEN LEAVE. This round has been open longer than every completed ` +
      `${pace.tier} round on this repository took to answer (${String(pace.sample)} of them), so there is no ` +
      "measurement left to offer you — the next thing to happen could be the answer or a failure, and a longer " +
      "interval here would be invented rather than measured.\n" +
      `OPEN LONGER, not necessarily working longer: this counts from when ${pace.tier} itself began — after the ` +
      "deterministic checks, not from when you started the review — and from there a round can still wait behind " +
      "another review for a provider before it is asked anything. This is NOT a sign that anything is wrong, and " +
      "deep rounds have a long tail."
    );
  }
  return (
    `MAKE ONE CALL AFTER ~${String(secs)}s, THEN LEAVE. That is how much longer ${pace.tier} rounds typically ` +
    `run from where this one already is, measured across the ${String(pace.runs)} runs on this repository that ` +
    `had already been going this long (of ${String(pace.sample)} completed) — so polling sooner returns ` +
    "`running` and costs you a turn for nothing.\n" +
    (pace.capped
      ? "THIS IS THE CAP, NOT THE MEASUREMENT. Every suggested wait here is bounded below two minutes, and this " +
        `tier's rounds typically run longer than that — so expect this number to stay at ~${String(secs)}s on ` +
        "each of the next several calls rather than shrinking. That is not a stalled review and not a stale " +
        "field; it is the bound. It starts falling once the round is within about two minutes of the middle of " +
        "the distribution, and the sentence above changes when it does."
      : "READ THIS FIELD AGAIN EVERY TIME; do not reuse the number. It SHRINKS as the round ages, because a " +
        "round that has already outlived the median is not another median away from finishing — it is most of " +
        "the way there. Reusing the first interval is how a client waits twice as long as it needed to.")
  );
}
