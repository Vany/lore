/**
 * The ladder: which tier runs next, and when the review is over.
 *
 * A pure reducer over plain data. No models, no network, no repo — this is the
 * logic that must be right, and it is the part that can be proven without paying
 * anyone.
 *
 * SPEC: spec/review-ladder.md §1, §5
 */

import { Exhausted } from "./errors.ts";

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

export interface Limits {
  /** Rounds one tier may produce new findings before we stop and get a human. */
  readonly perTierRounds: number;
  /** Total rounds across all tiers, per review. */
  readonly globalRounds: number;
}

export const DEFAULT_LIMITS: Limits = { perTierRounds: 3, globalRounds: 12 };

export interface LadderState {
  /** Index into the tier list of the next *model* tier to run. */
  readonly cursor: number;
  readonly round: number;
  readonly tierRounds: Readonly<Record<string, number>>;
  /** Fingerprints already fixed, or justified and accepted. */
  readonly settled: readonly string[];
  /** An unresolvable knowledge conflict is open (D-39). Blocks `passed`. */
  readonly needsHuman: boolean;
}

export function initialState(tiers: readonly Tier[] = DEFAULT_TIERS): LadderState {
  return {
    cursor: firstModelTier(tiers),
    round: 0,
    tierRounds: {},
    settled: [],
    needsHuman: false,
  };
}

function firstModelTier(tiers: readonly Tier[]): number {
  const i = tiers.findIndex((t) => t.kind === "model");
  if (i < 0) throw new Error("ladder has no model tier");
  return i;
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
  const needsHuman = prev.needsHuman || (input.needsHuman ?? false);

  const settledSet = new Set(prev.settled);
  const fresh = input.raised.filter((fp) => !settledSet.has(fp));

  const base: LadderState = { ...prev, round, tierRounds, needsHuman };

  // Bounds are checked before any success can be declared. Hitting one is a
  // distinct outcome, never a pass — a review that ran out of budget found out
  // nothing about the code it did not reach (INV-1).
  if (round > limits.globalRounds) {
    return { state: base, decision: { kind: "stopped", bound: "global" } };
  }
  if ((tierRounds[tier.id] ?? 0) > limits.perTierRounds) {
    return { state: base, decision: { kind: "stopped", bound: "perTier" } };
  }

  if (fresh.length > 0) {
    // A fix is unreviewed code, so the next round starts at the cheapest model
    // tier — the cheapest possible regression check (D-6). Resuming where we left
    // off would let hastily patched code reach `passed` having never faced the gate.
    return {
      state: { ...base, cursor: firstModelTier(tiers) },
      decision: { kind: "findings" },
    };
  }

  // Clean at this tier. A pending human question still blocks everything.
  if (needsHuman) {
    return { state: base, decision: { kind: "needsHuman" } };
  }

  const nextCursor = nextModelTier(tiers, prev.cursor);
  if (nextCursor === undefined) {
    return { state: { ...base, cursor: prev.cursor }, decision: { kind: "passed" } };
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

function nextModelTier(tiers: readonly Tier[], from: number): number | undefined {
  for (let i = from + 1; i < tiers.length; i++) {
    if (tiers[i]?.kind === "model") return i;
  }
  return undefined;
}

/** Record fingerprints as settled — fixed, or justified and accepted. */
export function settle(state: LadderState, fingerprints: readonly string[]): LadderState {
  return { ...state, settled: [...new Set([...state.settled, ...fingerprints])] };
}

/**
 * A provider refused on quota. Loud, and never a reason to fall through to the
 * next tier: a tier that did not run found nothing, which is not the same as
 * finding nothing.
 */
export function quotaExhausted(tier: Tier): never {
  throw new Exhausted(`tier ${tier.id} (${tier.model ?? tier.kind}) is out of quota — review incomplete`);
}
