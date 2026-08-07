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

  const tiers = parsed.data as Tier[];
  if (!tiers.some((t) => t.kind === "model")) {
    throw new UsageError("LORE_TIERS has no model tier — deterministic tooling alone is not a review");
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
    return {
      state: { ...base, cursor: prev.cursor, ...(sole === undefined ? {} : { soleVendor: sole }) },
      decision:
        skipped.length === 0 && sole === undefined
          ? { kind: "passed" }
          : { kind: "passedPartial", skipped, ...(sole === undefined ? {} : { soleVendor: sole }) },
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

export { anyTierRan };
