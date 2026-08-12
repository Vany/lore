/**
 * The ladder: which tier runs next, and when the review is over.
 *
 * A pure reducer over plain data. No models, no network, no repo — this is the
 * logic that must be right, and it is the part that can be proven without paying
 * anyone.
 *
 * SPEC: spec/review-ladder.md §1, §5
 */

import { readFileSync } from "node:fs";
import * as z from "zod";
import { absent } from "./optional.ts";
import { UsageError } from "./errors.ts";

export type TierKind = "deterministic" | "model";
export type Stage = "fast" | "deep";

export interface Tier {
  readonly id: string;
  readonly kind: TierKind;
  /** Provider-qualified model id, for `kind: "model"`. */
  readonly model?: string;
  /** Reasoning effort. Escalating effort is cheaper than escalating model (D-29). */
  readonly effort?: "low" | "medium" | "high" | "max";
  /** `fast` tiers answer inline; `deep` tiers run asynchronously (D-34). */
  readonly stage: Stage;
  /**
   * This tier is on a metered subscription: if it cannot answer, SKIP it rather than
   * spending a second attempt on it.
   *
   * Optional, and absent means the old behaviour — one retry, then promote (D-48
   * widened). The flag exists because a retry only pays for itself when the fault might
   * be transient, and an exhausted plan is not: Z.ai's answers *"Weekly/Monthly Limit
   * Exhausted, resets at …"*, which does not become untrue by asking again. Measured
   * 2026-08-09, each attempt cost the full 45-minute deadline, so the retry was 45
   * minutes of wall-clock spent to re-learn a fact with a published expiry date.
   *
   * NOT part of `ladderFingerprint`. The pin refuses to resume a review whose tiers have
   * changed meaning — a different model wearing the same name — and this changes neither
   * which model is called nor how it is asked. Flipping it mid-review is safe, and
   * pinning it would refuse every open review at the next config change for a policy the
   * review does not depend on.
   */
  readonly skip_if_quota?: boolean;
  /**
   * Keep ONE session for this tier for the whole review, instead of a cold start per
   * round (D-80).
   *
   * The tier is initialised once — full prompt, orientation, exploration — and every later
   * round arrives as the next message in the same conversation: *"this is the change that
   * answers your finding; does it?"* Compacted at two thirds of the model's context window
   * rather than restarted, because restarting keeps the code and discards the reasoning.
   *
   * Measured before it was built: a cold round spends 31.6 turns re-orienting in a
   * worktree it read minutes ago, and 29% of all model rounds are a tier re-reading a
   * review it already knows.
   *
   * Opt-in per tier so it can be tried on one tier against the recorded cold baseline
   * (`research/t2-token-cost.md`) rather than switched on everywhere at once.
   *
   * NOT part of `ladderFingerprint`, for the same reason as `skip_if_quota`: it changes
   * neither which model is called nor what it is asked, so flipping it mid-review is safe
   * and pinning it would refuse every open review at the next config change.
   */
  readonly conversation?: boolean;
  /**
   * The same model somewhere else, for when this tier's plan is out — IN ORDER (D-93).
   *
   * Vany: *"we have some openrouter credits… if there is no quota on the subscription
   * fallback to openrouter."* Three of lore's tiers are flat subscriptions, and an
   * exhausted one used to cost the review that tier entirely — its work promoted to a
   * dearer one and the verdict labelled accordingly. OpenRouter carries a twin of every
   * model in the deployed ladder, so the honest answer to "this plan is out" is to ask
   * the same model through a provider that is not.
   *
   * **This is the one path in lore that spends metered money.** Everything else is a flat
   * subscription reporting `cost_usd: 0`, which is why the daily ceiling has never been
   * able to fire (D-50). Priced against a real day — nine reviews of this repository —
   * the whole load would have been $3.80.
   *
   * **A LIST, TRIED IN ORDER, and only ever advanced by quota.** Vany, 2026-08-12:
   * *"let's fall back on t2 and t3 to openrouter, and then, if there is no quota, to
   * zai-coding-plan/glm."* OpenRouter ran to zero on 2026-08-11 — $5165.00 granted
   * against $5165.04 used — and on that day a single fallback was the same as none: both
   * routes to the model were out and the tier was `unpayable`. A second entry is a
   * different SUBSCRIPTION, which is the only kind of spare capacity that survives a
   * metered account hitting zero.
   *
   * The chain advances on `Exhausted` and on nothing else, which is the same narrow
   * reading that governs the first hop: quota is a fault about the ROUTE, while a bad
   * reply or an oversized diff will repeat through any provider. It is bounded by the
   * list, which is short and written down — the "chain of retries becomes an unbounded
   * cost" objection is about retrying the same route, not about naming a second one.
   *
   * Absent or empty means the old behaviour: an exhausted tier is skipped and its work
   * promoted (D-48), which is right for a deployment with no spare capacity to reach for.
   */
  readonly fallback?: readonly string[];
}

/**
 * The default ladder (D-7).
 *
 * Three model tiers, three **vendors**. Kimi K3 is poor value on capability alone
 * — 3× the price of GPT-5.6 Terra for two more points — but it buys a third
 * independent vendor, and two tiers from one model family are not two opinions.
 * Independence is the premise of the whole design (D-1), so it is worth the money.
 */
export const DEFAULT_TIERS: readonly Tier[] = [
  { id: "t0", kind: "deterministic", stage: "fast" },
  { id: "t1", kind: "model", model: "openrouter/z-ai/glm-5.2", effort: "medium", stage: "fast" },
  { id: "t2", kind: "model", model: "openrouter/moonshotai/kimi-k3", effort: "high", stage: "deep" },
  { id: "t3", kind: "model", model: "openrouter/openai/gpt-5.6-sol-pro", effort: "high", stage: "deep" },
];

const TierSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["deterministic", "model"]),
    model: absent(z.string().min(1)),
    effort: absent(z.enum(["low", "medium", "high", "max"])),
    stage: z.enum(["fast", "deep"]),
    skip_if_quota: absent(z.boolean()),
    conversation: absent(z.boolean()),
    // A BARE STRING IS STILL ACCEPTED and normalised to a one-entry list. The array is
    // the shape we write; the string is the shape deployed configs had until 2026-08-12,
    // and `loadTiers` THROWS on anything malformed — so refusing it outright would turn
    // a stale `LORE_TIERS` into a boot crash-loop, which this repository has already
    // done to itself once this week over exactly this kind of key.
    fallback: absent(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])),
  })
  .strict()
  .refine((t) => t.kind !== "model" || t.model !== undefined, {
    message: "a model tier must name a model",
  });

/**
 * Load the ladder from configuration.
 *
 * `LORE_TIERS` is either inline JSON or a path to a JSON file. SPEC has always
 * said tiers are configuration rather than code; until now they were only code,
 * which meant changing provider required a rebuild.
 *
 * A malformed ladder throws rather than falling back to the default. Silently
 * reviewing with a different set of models than the operator configured is the
 * kind of divergence nobody notices until the bill or the findings look wrong.
 */
let cached: { source: string; tiers: readonly Tier[] } | undefined;

export function loadTiers(source = process.env["LORE_TIERS"]): readonly Tier[] {
  if (source === undefined || source.trim().length === 0) return DEFAULT_TIERS;

  // Memoised per source, so the single-vendor warning is said once per process
  // rather than once per review type. A warning repeated three times at startup
  // reads as noise, and noise is what people learn to scroll past.
  if (cached?.source === source) return cached.tiers;

  const raw = source.trim().startsWith("[") ? source : readFileSync(source, "utf8");
  const parsed = z.array(TierSchema).min(1).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new UsageError(`LORE_TIERS is malformed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  // ONE SHAPE PAST THIS POINT. The schema accepts a bare string for `fallback` so a
  // stale config cannot crash-loop the service at boot; everything downstream reads a
  // list, because two shapes for one field is how the copies come to disagree.
  const tiers = parsed.data.map((t) => ({
    ...t,
    ...(typeof t.fallback === "string" ? { fallback: [t.fallback] } : {}),
  })) as Tier[];
  if (!tiers.some((t) => t.kind === "model")) {
    throw new UsageError("LORE_TIERS has no model tier — deterministic tooling alone is not a review");
  }

  // A FALLBACK THAT REPEATS THE ROUTE IT IS COVERING FOR IS NOT A FALLBACK.
  //
  // The chain is only ever walked because a provider said QUOTA, so naming the tier's own
  // model — or the same entry twice — buys a guaranteed second refusal, at the cost of a
  // real call, in the outage the list was written for. I did exactly this while adding
  // the list: gave a tier whose primary is the z.ai plan a last resort on the z.ai plan.
  // Refused rather than filtered, because silently dropping an entry would leave an
  // operator believing in spare capacity that lore had quietly decided not to use.
  for (const t of tiers) {
    const seen = new Set<string>(t.model === undefined ? [] : [t.model]);
    for (const f of t.fallback ?? []) {
      if (seen.has(f)) {
        throw new UsageError(
          `LORE_TIERS: tier ${t.id} lists ${f} as a fallback for itself or twice over. A fallback is only ` +
            `tried when a provider refuses on quota, so the same route can only refuse again.`,
        );
      }
      seen.add(f);
    }
  }

  // Loud AND consequential. Not fatal, because a deployment funded for one provider
  // must still be able to review — but this warning is no longer the whole story:
  // `step` refuses to call a single-vendor ladder `passed` (D-49). Saying "this is
  // degraded" at startup and then issuing a clean pass anyway is precisely the
  // advisory-guard shape this project exists to reject.
  const sole = soleVendorOf(tiers);
  if (sole !== undefined) {
    console.error(
      `lore: WARNING — every model tier is from one vendor (${sole}). Tiers share blind spots, so this ladder is closer to one opinion asked three times than to three independent reviews. Reviews on it can reach 'passed_partial' at best, never 'passed'.`,
    );
  }

  cached = { source, tiers };
  return tiers;
}

/**
 * Who actually trained the model, which is what shares blind spots.
 *
 * Ids come in two shapes and the vendor sits in a different place in each:
 * `openrouter/z-ai/glm-5.2` is *gateway/vendor/model*, while `zai/glm-5.2` is
 * *vendor/model* direct. Reading position 1 blindly compares `glm-4.7` against
 * `glm-5.2` and concludes they are different vendors — which is exactly the
 * warning this exists to raise, silently not raised.
 */
export function vendorOf(modelId: string): string {
  const parts = modelId.split("/");
  return (parts.length >= 3 ? parts[1] : parts[0]) ?? "";
}

/**
 * The one vendor behind every model tier, or `undefined` if there is more than one.
 *
 * `undefined` means "independent enough"; a name means every opinion in this ladder
 * came from the same training run, and the review is worth less than its tier count
 * suggests (D-49).
 *
 * `unavailable` tiers are excluded because the question is about the reviews that
 * actually happened. A three-vendor ladder with two tiers unpayable really did get
 * one vendor's opinion, and reporting otherwise would be a claim about work nobody
 * did — the same error as counting a tier that never ran (INV-1).
 */
export function soleVendorOf(tiers: readonly Tier[], unavailable: readonly string[] = []): string | undefined {
  const vendors = new Set(
    tiers.filter((t) => t.kind === "model" && !unavailable.includes(t.id)).map((t) => vendorOf(t.model ?? "")),
  );
  const [only] = [...vendors];
  return vendors.size === 1 ? only : undefined;
}

export interface Limits {
  /** Rounds one tier may produce new findings before we stop and get a human. */
  readonly perTierRounds: number;
  /** Total rounds across all tiers, per review. */
  readonly globalRounds: number;
}

const DEFAULT_LIMITS: Limits = { perTierRounds: 3, globalRounds: 12 };

export interface LadderState {
  /** Index into the tier list of the next *model* tier to run. */
  readonly cursor: number;
  readonly round: number;
  readonly tierRounds: Readonly<Record<string, number>>;
  /** Fingerprints already fixed, or justified and accepted. */
  readonly settled: readonly string[];
  /** An unresolvable knowledge conflict is open (D-39). Blocks `passed`. */
  readonly needsHuman: boolean;
  /**
   * Tiers that could not be paid for (D-48).
   *
   * Recorded rather than fatal: a deployment with credit for one provider must
   * still be able to finish a review, and the result says plainly how far it got.
   */
  readonly unavailable: readonly string[];
  /**
   * The single vendor behind every tier that could run, if there is only one (D-49).
   *
   * Derived, but stored: the attestation is written long after the ladder config is
   * out of scope, and it must be able to say whose opinion it is actually carrying.
   * Recomputed each round because `unavailable` grows as providers refuse.
   */
  readonly soleVendor?: string;
}

export function initialState(tiers: readonly Tier[] = DEFAULT_TIERS): LadderState {
  const sole = soleVendorOf(tiers);
  return {
    cursor: firstModelTier(tiers),
    round: 0,
    tierRounds: {},
    settled: [],
    needsHuman: false,
    unavailable: [],
    // Omitted rather than set to undefined, so a serialised state round-trips to
    // something a strict equality check still recognises.
    ...(sole === undefined ? {} : { soleVendor: sole }),
  };
}

/** Record a tier as unpayable. The ladder will step over it from now on. */
export function markUnavailable(state: LadderState, tierId: string): LadderState {
  return state.unavailable.includes(tierId)
    ? state
    : { ...state, unavailable: [...state.unavailable, tierId] };
}

function firstModelTier(tiers: readonly Tier[], unavailable: readonly string[] = []): number {
  const i = tiers.findIndex((t) => t.kind === "model" && !unavailable.includes(t.id));
  if (i < 0) throw new Error("ladder has no model tier");
  return i;
}

/**
 * Did any tier actually look at this code?
 *
 * If every model tier was unpayable there is no review at all, and calling that a
 * partial pass would be exactly the "did not run reported as found nothing" that
 * INV-1 forbids.
 */
function anyTierRan(tiers: readonly Tier[], unavailable: readonly string[]): boolean {
  return tiers.some((t) => t.kind === "model" && !unavailable.includes(t.id));
}

/**
 * The index of the dearest tier that actually answered, at or below the cursor.
 *
 * `-1` when none did, which is the only honest answer for a review whose every tier was
 * unavailable — and callers must not read that as "tier 0 ran".
 *
 * This exists because the cursor is not the fact it looks like. `runRound` promotes a
 * dead tier's work by calling `step` with `raised: []`, so a tier that FAILED arrives
 * here indistinguishable from one that came back clean, except for its entry in
 * `unavailable`. That entry is therefore the only trustworthy signal, and this is the one
 * place that reads it.
 */
function highestThatRan(tiers: readonly Tier[], cursor: number, unavailable: readonly string[]): number {
  for (let i = Math.min(cursor, tiers.length - 1); i >= 0; i--) {
    const t = tiers[i];
    if (t?.kind === "model" && !unavailable.includes(t.id)) return i;
  }
  return -1;
}

export type Decision =
  /** New findings. Report them; the next round resets to the first model tier. */
  | { readonly kind: "findings" }
  /** Nothing new at this tier. Move up. */
  | { readonly kind: "escalate"; readonly next: Tier }
  /** Fast tiers clean, deep tiers still to run. NOT a pass (D-34). */
  | { readonly kind: "fastClean" }
  /** Every tier agrees. The only success. */
  | { readonly kind: "passed" }
  /**
   * Every tier that COULD run agrees, but the evidence is weaker than a pass:
   * tiers were unpayable (D-48), or every tier that ran came from one vendor
   * (D-49), or both. `skipped` and `soleVendor` say which.
   */
  | { readonly kind: "passedPartial"; readonly skipped: readonly string[]; readonly soleVendor?: string }
  /** A human must answer before this can proceed. Not a pass. */
  | { readonly kind: "needsHuman" }
  /** A bound was hit. Not a pass — see §5. */
  | { readonly kind: "stopped"; readonly bound: "perTier" | "global" };

export interface StepInput {
  readonly state: LadderState;
  /** Fingerprints this round produced, from T0 and the current model tier. */
  readonly raised: readonly string[];
  /** Set when the round surfaced an unresolvable conflict. */
  readonly needsHuman?: boolean;
  readonly tiers?: readonly Tier[];
  readonly limits?: Limits;
}

/**
 * Advance the ladder by one round.
 *
 * "New" means a fingerprint not already settled — never a raw count. A tier that
 * re-raises three closed findings and nothing else is clean, and treating it
 * otherwise would make the loop permanent.
 */
export function step(input: StepInput): { readonly state: LadderState; readonly decision: Decision } {
  const tiers = input.tiers ?? DEFAULT_TIERS;
  const limits = input.limits ?? DEFAULT_LIMITS;
  const prev = input.state;

  const tier = tiers[prev.cursor];
  if (tier === undefined) throw new Error(`ladder cursor ${prev.cursor} is out of range`);

  const round = prev.round + 1;
  const tierRounds = { ...prev.tierRounds, [tier.id]: (prev.tierRounds[tier.id] ?? 0) + 1 };

  // Derived from the caller's CURRENT view, never accumulated.
  //
  // Sticky was wrong and would have deadlocked: once a conflict appeared, the
  // review could never pass again even after a human settled it. The system is
  // meant to stop and ask, not to stop permanently — a question with no way to
  // answer it is a trap, not a safeguard.
  const needsHuman = input.needsHuman ?? false;

  const settledSet = new Set(prev.settled);
  const fresh = input.raised.filter((fp) => !settledSet.has(fp));

  const base: LadderState = { ...prev, round, tierRounds, needsHuman };

  // The GLOBAL budget is a hard ceiling on the whole review, so it is checked
  // against the round itself, clean or not. A ceiling that a good result may
  // exceed is not a ceiling. INV-1 still holds: `stopped` is a named terminal
  // state and never reads as a pass.
  if (round > limits.globalRounds) {
    return { state: base, decision: { kind: "stopped", bound: "global" } };
  }

  if (fresh.length > 0) {
    // The PER-TIER cap is checked HERE, and only here, because it bounds a
    // different thing: going round again with the same tier. Above, next to the
    // global budget, it also fell on rounds where the tier came back CLEAN — and
    // then the cap discarded the very result that ended the ping-pong.
    //
    // Observed on this repo, 2026-08-03. One review spent
    // three rounds settling three findings, ran a fourth at t1 for 485s and 29
    // turns, came back clean — and was reported FAILED, because `tierRounds.t1`
    // had reached 4. We paid for a review, it found nothing, and the answer was
    // thrown away by a counter. With a default of 3 that makes `passed`
    // unreachable for any change needing three rounds of fixes, which is most of
    // them: the ladder could not do its job on a real branch.
    //
    // Termination (spec/review-ladder.md §5) is unaffected, and that is the whole
    // reason the bounds exist. Every round either raises something fresh — bounded
    // here and by the global budget above — or is clean, and clean is terminal:
    // it passes, asks a human, or escalates. Escalation only ever moves the cursor
    // FORWARD through a finite tier list, so no path loops.
    if ((tierRounds[tier.id] ?? 0) > limits.perTierRounds) {
      return { state: base, decision: { kind: "stopped", bound: "perTier" } };
    }

    // A CLOSED TIER STAYS CLOSED. The next round runs the SAME tier — the one that
    // raised the finding — so the author's answer is judged by whoever asked the
    // question. Revised 2026-08-07; D-6 previously reset to the cheapest tier here.
    //
    // The reset was justified as "a fix is unreviewed code, so it must face the cheap
    // gate again". Two things were wrong with that. The smaller is cost: every t2
    // finding bought two rounds, because t1 had to re-clear the fix before t2 could
    // look again — five findings cost nine rounds on this repository's own review, and
    // two reviews died on the per-tier bound that way.
    //
    // The larger is that it broke D-10. `settle()` is run by whichever tier the round
    // is on, so after a reset **t1 ruled on justifications for findings t2 raised** —
    // observed four times in one review, t1 coming back "clean" and closing the dearer
    // model's questions. A cheap model ratifying answers to an expensive model's
    // findings is worse review, not more of it, and it is exactly what D-10 says must
    // not happen.
    //
    // What is genuinely given up: the tiers BELOW no longer see the last diff. T0 still
    // runs every round, so tsc, semgrep and the tests read every fix; what is lost is a
    // second model opinion from a *weaker* model. Against that, the tier still holding
    // the conversation re-reads the whole diff. The `passed` claim narrows accordingly
    // and the attestation must say so — see `spec/review-ladder.md` §5.
    return { state: base, decision: { kind: "findings" } };
  }

  // Clean at this tier. A pending human question still blocks everything.
  if (needsHuman) {
    return { state: base, decision: { kind: "needsHuman" } };
  }

  const nextCursor = nextModelTier(tiers, prev.cursor, base.unavailable);
  if (nextCursor === undefined) {
    // Everything reachable agreed. Whether that is `passed` or "we did everything we
    // can" turns on two independent questions, and neither may be reported as the
    // other:
    //
    //   * was a tier skipped, because nobody could pay for it (D-48)
    //   * did every tier that ran come from ONE vendor (D-49)
    //
    // The second is the one this project kept getting wrong. `loadTiers` warned about
    // a single-vendor ladder and then let the review pass anyway, which made the
    // warning decorative — the reviewer that found this was right, and it is the same
    // warn-instead-of-enforce shape as INV-8's missing agent file. A rule with no
    // consequence is a comment.
    const skipped = base.unavailable;
    const sole = soleVendorOf(tiers, skipped);
    // A TIER SKIPPED BELOW ONE THAT PASSED DOES NOT WEAKEN THE VERDICT (D-88).
    //
    // Vany: *"quota on t1 must allow to skip it and start t2. passing of t2 must make t1
    // not needed."* The ladder is a gate — dearer tiers only see code the cheaper ones
    // already passed — so a cheaper tier's work is *subsumed* by whatever ran above it.
    // It made that work cheaper, not more certain, and charging the verdict for its
    // absence said the opposite.
    //
    // I argued against this and was overruled; the argument is in `spec/review-ladder.md`
    // §1 and the decision is D-88, both of which now carry it. What I got right is that
    // one label for every skip was wrong either way: *"the cheap first pass did not run"*
    // and *"nobody ran the adversarial tier"* printed identically.
    //
    // MEASURED AGAINST WHAT ACTUALLY RAN, not against the cursor. The cursor is NOT
    // reliably a tier that answered: `runRound`'s promotion path calls `step` with
    // `raised: []` after a tier FAILED, which arrives here as "clean at this tier" with
    // that tier sitting in `unavailable`. Forgiving everything below the cursor would
    // then forgive the top tier's own failure and call the review `passed` when nothing
    // had read it at that level — INV-1, inverted, inside the change that relaxes the
    // rule. So the pivot is the highest tier that is NOT unavailable.
    const ranTo = highestThatRan(tiers, prev.cursor, skipped);
    const above = skipped.filter((id) => {
      const i = tiers.findIndex((t) => t.id === id);
      return i > ranTo;
    });
    return {
      state: { ...base, cursor: prev.cursor, ...(sole === undefined ? {} : { soleVendor: sole }) },
      decision:
        above.length === 0 && sole === undefined
          ? { kind: "passed" }
          : // `skipped`, not `above`: the client is still told every tier that did not
            // run. What changed is which of them costs the verdict, never which of them
            // is disclosed — a `passed` that quietly stopped mentioning t1 would be the
            // silent downgrade this whole project exists to refuse.
            { kind: "passedPartial", skipped, ...(sole === undefined ? {} : { soleVendor: sole }) },
    };
  }

  const next = tiers[nextCursor];
  if (next === undefined) throw new Error("unreachable: next tier index out of range");

  const advanced: LadderState = { ...base, cursor: nextCursor };
  // Crossing from the fast stage into the deep stage is worth naming, because
  // `fast_clean` is the state a client is most likely to misread as `passed`.
  return tier.stage === "fast" && next.stage === "deep"
    ? { state: advanced, decision: { kind: "fastClean" } }
    : { state: advanced, decision: { kind: "escalate", next } };
}

function nextModelTier(
  tiers: readonly Tier[],
  from: number,
  unavailable: readonly string[] = [],
): number | undefined {
  for (let i = from + 1; i < tiers.length; i++) {
    const t = tiers[i];
    if (t?.kind === "model" && !unavailable.includes(t.id)) return i;
  }
  return undefined;
}

/** Record fingerprints as settled — fixed, or justified and accepted. */
export function settle(state: LadderState, fingerprints: readonly string[]): LadderState {
  return { ...state, settled: [...new Set([...state.settled, ...fingerprints])] };
}

// `quotaExhausted(tier)` lived here and threw `Exhausted`. Deleted rather than wired:
// the live path is `opencode.ts`, which classifies the provider's own status and
// throws with the message the provider gave, and a second spelling of the same throw
// would only be the one a future edit forgot to keep in step. The rule it documented —
// a refusal on quota is never a reason to fall through to the next tier — is enforced
// where the refusal is actually seen, and D-48 is where it is written down.

/**
 * A ladder as a string, for pinning it to a review that must finish on the same one.
 *
 * EVERY FIELD THAT CHANGES WHAT THE TIER DOES, in order. A tier renamed is a different
 * position; a tier repointed at another model is a different reviewer wearing the same
 * name — which is the case that corrupts the record, since `tier_run` stores only the id.
 *
 * `effort` and `stage` were omitted, and both are the same kind of change wearing the
 * same name. D-29 says escalating effort is cheaper than escalating model: it is a
 * deliberate lever, so moving t1 from `medium` to `max` mid-review means the rounds
 * before and after were done by measurably different reviewers, recorded identically.
 * `stage` decides whether the tier answers inline or asynchronously, which changes when
 * a client is told anything at all.
 *
 * Built from a literal list rather than `Object.values`, so adding a field to `Tier` does
 * not silently join the pin — a pin that changes for a field nobody meant to pin on would
 * refuse every open review at the next deploy.
 */
export function ladderFingerprint(tiers: readonly Tier[]): string {
  return tiers.map((t) => `${t.id}:${t.model ?? t.kind}:${t.effort ?? "-"}:${t.stage}`).join(",");
}

/**
 * Has the ladder actually changed, comparing only what the stored pin can speak about?
 *
 * A PIN'S FORMAT CHANGING IS NOT A LADDER CHANGING, and treating it as one is expensive:
 * adding `effort` and `stage` to the pin refused every review that was open at the
 * deploy, including one that had cost half an evening of model time on this repository.
 * The tiers were identical; only the spelling had grown. The comment above
 * `ladderFingerprint` warned about this exact shape two lines before the code that did it.
 *
 * So the comparison is per tier, field by field, bounded by the SHORTER of the two — an
 * old pin still catches everything it could always catch (a tier renamed, a tier
 * repointed at another model) and simply has no opinion about fields it never recorded.
 * A pin gaining a field is silent; a pin whose recorded fields disagree still refuses.
 *
 * Tier COUNT still matters at any format: a ladder that gained or lost a tier moves every
 * cursor after the change, which is the corruption this whole check exists for.
 */
export function ladderChanged(started: string, nowRunning: string): boolean {
  if (started === nowRunning) return false;
  const was = started.split(",");
  const now = nowRunning.split(",");
  if (was.length !== now.length) return true;
  return was.some((tier, i) => {
    const a = tier.split(":");
    const b = (now[i] ?? "").split(":");
    const shared = Math.min(a.length, b.length);
    for (let f = 0; f < shared; f++) if (a[f] !== b[f]) return true;
    return false;
  });
}

export { anyTierRan };
