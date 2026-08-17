/**
 * The ladder: which tier runs next, and when the review is over.
 *
 * A pure reducer over plain data. No models, no network, no repo — this is the
 * logic that must be right, and it is the part that can be proven without paying
 * anyone.
 *
 * SPEC: spec/review-ladder.md §1, §5
 */

import { allowMeteredFromEnv, withoutMetered } from "./metered.ts";
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
   * The RUNG this tier runs on, when it shares one (D-109).
   *
   * A ladder is a list of rungs and a rung is a set of tiers that run TOGETHER —
   * concurrently, on the same worktree, findings crossing between them at emission
   * boundaries. In the tiers file a rung is a nested array; the loader flattens it and
   * stamps each member with the flat index of the rung's first member, which is unique
   * by construction (no other tier's own index can equal a position occupied by a rung
   * member).
   *
   * ABSENT ON EVERY TIER THAT RUNS ALONE, deliberately — not zero, not its own index.
   * Absent means the flat index itself is the rung key (`rungKey`), so every config
   * written before rungs existed carries exactly the state it always carried, and
   * `ladderFingerprint` spells it as `r-`: old pins keep matching, and only a genuine
   * regroup reads as a different ladder.
   */
  readonly rung?: number;
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
   * **A LIST, TRIED IN ORDER, and only ever advanced by a ROUTE fault.** Vany,
   * 2026-08-12: *"let's fall back on t2 and t3 to openrouter, and then, if there is no
   * quota, to zai-coding-plan/glm."* OpenRouter ran to zero on 2026-08-11 — $5165.00
   * granted against $5165.04 used — and on that day a single fallback was the same as
   * none: both routes to the model were out and the tier was `unpayable`. A second entry
   * is a different SUBSCRIPTION, which is the only kind of spare capacity that survives
   * a metered account hitting zero.
   *
   * The chain advances on `Exhausted` and on `ProviderAuthFailed`, and on nothing else —
   * the same narrow reading that governs the first hop: quota and a rejected credential
   * are faults about the ROUTE, while a bad reply or an oversized diff will repeat
   * through any provider. Auth joined on 2026-08-14, when an OAuth-backed t3 died on
   * `Token refresh failed: 401` with a healthy OpenRouter twin configured and never
   * asked. It is bounded by the list, which is short and written down — the "chain of
   * retries becomes an unbounded cost" objection is about retrying the same route, not
   * about naming a second one.
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
 * NICKNAMES FOR A MODEL, and the routes that can serve it.
 *
 * Vany, 2026-08-12: *"we have model definitions in a configuration file like
 * `{ "GLM5.2": ["zai-coding-plan/glm-5.2", "zai-coding-plan2/glm-5.2"] }`, and in tiers we
 * use these identifiers. If there is more than one model under a nickname we use a random
 * one with quota; if all are empty we return that we have no model for this."*
 *
 * **A nickname is the MODEL; the list is the ROUTES to it.** Two subscriptions to one
 * company are one reviewer reachable two ways — the same opinion, twice the quota. That
 * distinction is what the config could not express before: `fallback` had to carry both
 * "the same model somewhere else" and "something else entirely", and an entry's position
 * was the only thing saying which.
 *
 * **A pool is not a chain, and they answer different questions.** The pool is "these are
 * interchangeable, take one"; the chain is "that failed, try something worse". Keeping
 * them apart is what stops the ordering from quietly meaning nothing.
 */
export type ModelPools = Readonly<Record<string, readonly string[]>>;

const PoolsSchema = z.record(z.string().min(1), z.array(z.string().min(1)).min(1));

/**
 * A ladder entry: one tier, or a RUNG — several tiers that run together (D-109).
 *
 * The nesting is the whole syntax. `rung` is never written in the file; the loader
 * stamps it from the structure, because a hand-assigned rung number could collide with
 * a flat index and silently group tiers nobody grouped.
 */
const EntrySchema = z.union([TierSchema, z.array(TierSchema).min(1)]);

/**
 * The two shapes a ladder file may have.
 *
 * A bare array is the shape every deployed config had before nicknames, and it still
 * loads — `loadTiers` throws on anything malformed, so refusing it would turn a stale
 * `LORE_TIERS` into a boot crash-loop, which this repository has already done to itself
 * once this week over exactly this kind of key.
 */
const LadderFileSchema = z.union([
  z.array(EntrySchema).min(1),
  z
    .object({
      models: absent(PoolsSchema),
      /**
       * THE MODEL FOR WORK THAT IS NOT A REVIEW.
       *
       * Vany: *"if we need just GLM, to understand something, not for review, use 5.2
       * from the small subscription for this."*
       *
       * TWO CALL SITES READ THIS, not three: the background screen and the bootstrap
       * survey. The proposer does NOT — it deliberately takes the DEAREST model tier,
       * because proposing and criticising a design is not the same errand as deciding
       * whether an extracted sentence is a rule, and moving it here would quietly
       * downgrade it. An earlier version of this comment claimed all three, which was
       * false about the code and would have had an operator believe `propose` runs on
       * the small plan when every lens and critic session burns the t3 subscription.
       *
       * The screen borrowed the first model TIER, so every hourly pass competed for the
       * quota the gate tier runs on. With the big plan now
       * carrying t1 and the small one carrying the fallback, that borrowing would put
       * housekeeping directly in front of reviews on the seat that matters most.
       *
       * A concrete `provider/model` or a pool nickname, exactly like a tier's `model`.
       * ABSENT means the old behaviour — borrow the first model tier — so every config
       * written before this key keeps working unchanged.
       */
      helper: absent(z.string().min(1)),
      tiers: z.array(EntrySchema).min(1),
    })
    .strict(),
]);

let cached:
  | { source: string; tiers: readonly Tier[]; pools: ModelPools; helper: string | undefined }
  | undefined;

/**
 * Which concrete routes serve a tier's model.
 *
 * A plain model id is its own single route, so a config without nicknames behaves exactly
 * as it did. An id that names a pool expands to it.
 */
export function routesFor(tier: Tier, pools: ModelPools): readonly string[] {
  const named = tier.model ?? "";
  return pools[named] ?? (named === "" ? [] : [named]);
}

/**
 * Every concrete route the configured fallbacks can reach, nicknames expanded.
 *
 * The startup check (D-93) asks opencode whether each of these exists, and it asked with
 * the raw config entries until a fallback named a POOL — then it asked after `GLM5.2`,
 * which is not a model id and never will be, and ticketed that opencode could not reach
 * it. A check that cries wolf about a healthy fallback is worse than none: the one time it
 * means something, nobody reads it.
 *
 * Here rather than at the call site because this is the second place a nickname had to be
 * expanded and the third would have been found the same way — by shipping it.
 */
export function fallbackRoutes(tiers: readonly Tier[], pools: ModelPools): readonly string[] {
  return [
    ...new Set(tiers.flatMap((t) => (t.fallback ?? []).flatMap((f) => routesFor({ ...t, model: f }, pools)))),
  ];
}

/**
 * One concrete, believed-payable route for this tier — or `undefined` when every route is
 * parked, which the caller reports as "no model for this" rather than discovering it as a
 * provider error mid-call.
 *
 * FOR THE CALLERS THAT ARE NOT A REVIEW ROUND: the screen, the bootstrap survey, the
 * proposer. Each of them picked a tier from the config and handed `tier.model` straight
 * to opencode — which was fine for as long as a model id was a model id, and broke the
 * hour nicknames shipped: the background screen died every hour with `model id 'GLM5.2'
 * is not provider/model`, four documents waiting, until this existed. The round itself
 * does NOT use this — it needs stickiness and the D-94 probe bypass, which one-shot
 * callers have no use for.
 */
export function concreteRoute(
  tier: Tier,
  pools: ModelPools,
  known: (model: string) => RouteState | undefined,
  rand: () => number = Math.random,
  /**
   * May this pick a route that bills per call (D-117)?
   *
   * GATED HERE, at the chokepoint, and that is the point of the parameter existing at
   * all. The first version of the gate covered `runRound` and left this function — the
   * OTHER indirection that turns a nickname into a concrete route — open, so the hourly
   * screen, the bootstrap survey and `propose` (proposer AND critics) could each hand
   * opencode a paid route while the deployment was documented as never paying. Once an
   * hour, indefinitely, silently. Four callers, none of which had any reason to think
   * about money.
   *
   * That is the same lesson twice in one change: *an exemption written for a literal
   * value must be re-checked against every indirection that can produce that value.* So
   * the check lives where the routes are chosen rather than at each caller, and the fifth
   * caller is gated by existing.
   *
   * Defaults to the deployment's own answer so a caller cannot forget it. Overridable
   * because a default that cannot be overridden is untestable.
   */
  allowMetered: boolean = allowMeteredFromEnv(process.env["LORE_ALLOW_METERED"]),
): string | undefined {
  const all = routesFor(tier, pools);
  // ONLY A NICKNAME'S POOL IS FILTERED — a literal `openrouter/x` written as the tier's
  // model is the operator switching it on, exactly as in `runRound`. Keeping the two
  // rules identical matters more than the saving: two different answers to "is this route
  // allowed" is how the first hole was reached.
  const permitted = exemptLiteral(tier, pools) ? all : withoutMetered(all, allowMetered);
  const usable = withQuota(permitted, known).usable;
  return usable.length > 1 ? poolOrder(usable, rand)[0] : usable[0];
}

/**
 * WHY THERE IS NO ROUTE — because "parked" and "not allowed" are answered differently.
 *
 * One is a clock and the other is a person: a quota park lifts by itself at a time we can
 * name, a metered gate lifts when somebody decides and never on its own. Telling an
 * operator their routes are "out of quota" when the truth is that a toggle forbids the one
 * with quota sends them to wait for a reset that will not help.
 *
 * The round already says this properly; the rule was written in `runRound` — *a pool
 * emptied by the gate is not a pool out of quota, and the two must not share a sentence* —
 * and then the OTHER callers of `concreteRoute` went on sharing it. This is that sentence
 * made available rather than repeated, so a fourth caller cannot get it wrong privately.
 *
 * `undefined` when a route WAS found; there is nothing to explain.
 */
export function noRouteBecause(
  tier: Tier,
  pools: ModelPools,
  known: (model: string) => RouteState | undefined,
  allowMetered: boolean = allowMeteredFromEnv(process.env["LORE_ALLOW_METERED"]),
): string | undefined {
  const all = routesFor(tier, pools);
  const permitted = exemptLiteral(tier, pools) ? all : withoutMetered(all, allowMetered);
  if (withQuota(permitted, known).usable.length > 0) return undefined;
  const model = tier.model ?? "?";
  // THE TOGGLE IS THE WHOLE REMEDY ONLY WHEN NOTHING PERMITTED SURVIVES.
  //
  // `permitted.length === 0`, not `permitted.length < all.length`. The looser test was
  // true whenever ANY route had been gated — including the state where a free route
  // survives the gate and is merely PARKED, which self-heals when its backoff lifts. In
  // that state the sentence told an operator that waiting would not help and pointed them
  // at a deployment-wide money toggle to work around a condition that would have cleared
  // by itself, in the one channel this project insists must be exactly right.
  if (permitted.length === 0 && all.length > 0) {
    return (
      `no route to ${model} may be used: ${all.join(", ")} bill per call and this deployment does not ` +
      "allow metered routes. Set LORE_ALLOW_METERED=1 to use them; waiting will not change it"
    );
  }
  // BOTH CAUSES AT ONCE, and it says so rather than picking the more dramatic one: a free
  // route exists and is parked, and a metered one was refused. Waiting DOES fix this.
  if (permitted.length < all.length) {
    const blocked = all.filter((r) => !permitted.includes(r));
    return (
      `every permitted route to ${model} is out of quota (${blocked.join(", ")} would be allowed but bills ` +
      "per call, and this deployment does not allow metered routes). The parked routes return on their own " +
      "when their backoff lifts"
    );
  }
  return `every route to ${model} is out of quota`;
}

/** What is known about a route's quota, as `routeUnavailable` returns it. */
export interface RouteState {
  readonly until: string;
  readonly stated: boolean;
}

/**
 * Which of these routes we believe can be paid for, and when the rest come back.
 *
 * **Optimistic by default** — Vany: *"at the start assume all connections have quota, and
 * clarify if it is; and if it is not, what time of release when it rejects to work."* A
 * route nobody has seen refuse is believed good, so a fresh service asks rather than
 * assumes and learns from the answer.
 *
 * **Any refusal parks the route until its `until` passes** — the provider's own date when
 * it named one, lore's doubling backoff (1h, capped at 24h) when it did not. Vany, when
 * the first version re-asked an unstated refusal on every round: *"I do not want a regular
 * check for quota if nothing happens."* The recheck is not a schedule, it is the backoff
 * expiring: the next round after `until` asks the route again, a success clears the mark,
 * and another refusal doubles the wait.
 *
 * This deliberately parts from D-90's tier rule, and the difference is what is lost by
 * being wrong. Skipping a TIER on a guess narrows a review's coverage — a whole opinion
 * gone. Skipping a ROUTE loses nothing while any pool twin or fallback answers, and when
 * nothing does, the tier is skipped with a named comeback time — the same outcome as
 * calling everything and being refused by everything, minus the calls. The tier-level
 * probe (D-94) is unaffected: a probing round bypasses this filter entirely.
 *
 * When every route is parked, `usable` is empty and `until` is the EARLIEST release —
 * "we have no model for this, and here is when we will".
 */
export function withQuota(
  routes: readonly string[],
  known: (model: string) => RouteState | undefined,
  now = new Date().toISOString(),
): { readonly usable: readonly string[]; readonly until?: string } {
  const out: string[] = [];
  const waits: string[] = [];
  for (const r of routes) {
    const k = known(r);
    if (k !== undefined && k.until > now) waits.push(k.until);
    else out.push(r);
  }
  const soonest = [...waits].sort()[0];
  return out.length > 0 || soonest === undefined ? { usable: out } : { usable: out, until: soonest };
}

/**
 * The order to try a pool's routes in, chosen once and then kept (D-93).
 *
 * **Random, and the reason matters more than the choice.** Nothing publishes how much of a
 * subscription is left — z.ai does not, and neither does anyone else here — so any policy
 * cleverer than a coin toss would be guessing dressed as arithmetic. Random spreads load
 * across equivalent plans without pretending to know which has more room.
 *
 * Chosen ONCE per (review, tier) and then kept: Vany, *"if a model is chosen, use it —
 * this rule is only for the initial choosing."* Re-rolling every round would give a kept
 * session (D-80) a different model to continue, which is a cold start wearing the config
 * of a warm one.
 */
export function poolOrder(routes: readonly string[], rand: () => number = Math.random): readonly string[] {
  const out = [...routes];
  // Fisher-Yates, so every order is equally likely. Sorting by a random key is the
  // version people write from memory and it is subtly biased.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i] as string;
    out[i] = out[j] as string;
    out[j] = a;
  }
  return out;
}

/**
 * IS THIS TIER'S OWN MODEL EXEMPT FROM THE METERED GATE (D-117)?
 *
 * Two conditions, and both are about whether a PERSON chose this route:
 *
 *  * it must be a literal model id rather than a nickname — a pool is lore picking between
 *    interchangeable routes, and a shuffled pool mate is nobody's decision;
 *  * and the ladder must be one an operator wrote, because the built-in default is three
 *    literal `openrouter/` models nobody chose.
 *
 * One definition, because there are three gate sites and a fourth will be added: the first
 * version of this rule lived in `runRound` alone, and the two places it was missing are
 * exactly where the holes were found.
 */
export function exemptLiteral(tier: Tier, pools: ModelPools, source = process.env["LORE_TIERS"]): boolean {
  return pools[tier.model ?? ""] === undefined && ladderIsOperatorWritten(source);
}

/**
 * DID A PERSON CHOOSE THIS LADDER, or is it the one lore ships with?
 *
 * The metered exemption rests entirely on this. `openrouter/x` written as a tier's model
 * is the operator switching a paid route on — chosen, immediate, and theirs. The BUILT-IN
 * default is three literal `openrouter/` models, chosen by nobody, and exempting those
 * made `LORE_ALLOW_METERED=0` gate exactly nothing on the configuration this repository
 * ships: `deploy/docker-compose.yml` passes `LORE_TIERS: ${LORE_TIERS:-}`, blank means
 * `DEFAULT_TIERS`, and every call would have billed while five documents promised that no
 * charging route is ever called.
 *
 * Vany, asked which way to resolve it: exempt only an operator-written ladder.
 *
 * Same predicate as `loadTiers`' own first line, deliberately — two readings of "is this
 * configured" that could disagree is how the hole opened in the first place.
 */
export function ladderIsOperatorWritten(source = process.env["LORE_TIERS"]): source is string {
  return source !== undefined && source.trim().length > 0;
}

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
export function loadTiers(source = process.env["LORE_TIERS"]): readonly Tier[] {
  if (!ladderIsOperatorWritten(source)) return DEFAULT_TIERS;

  // Memoised per source, so the single-vendor warning is said once per process
  // rather than once per review type. A warning repeated three times at startup
  // reads as noise, and noise is what people learn to scroll past.
  if (cached?.source === source) return cached.tiers;

  const raw = source.trim().startsWith("[") || source.trim().startsWith("{") ? source : readFileSync(source, "utf8");
  const parsed = LadderFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new UsageError(`LORE_TIERS is malformed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const file = Array.isArray(parsed.data) ? { tiers: parsed.data } : parsed.data;
  const pools: ModelPools = file.models ?? {};
  const helper = file.helper;

  // ONE SHAPE PAST THIS POINT. The schema accepts a bare string for `fallback` so a
  // stale config cannot crash-loop the service at boot; everything downstream reads a
  // list, because two shapes for one field is how the copies come to disagree.
  // AND ONE STRUCTURE: rungs are flattened here, each member stamped with the flat
  // index of its rung's first member (D-109). That key is unique without a registry —
  // no singleton's own index can equal a position a rung member occupies — and a
  // one-member array is just a tier, so it is NOT stamped and fingerprints as itself.
  const tiers: Tier[] = [];
  for (const entry of file.tiers) {
    const group = Array.isArray(entry) ? entry : [entry];
    const at = tiers.length;
    for (const t of group) {
      tiers.push({
        ...t,
        ...(typeof t.fallback === "string" ? { fallback: [t.fallback] } : {}),
        ...(Array.isArray(entry) && group.length > 1 ? { rung: at } : {}),
      } as Tier);
    }
  }
  if (!tiers.some((t) => t.kind === "model")) {
    throw new UsageError("LORE_TIERS has no model tier — deterministic tooling alone is not a review");
  }

  // A TIER ID NAMES A COUNTER, A SESSION AND AN AUDIT ROW, so two tiers sharing one
  // would write over each other's rounds — quietly corrupt before rungs, loudly
  // impossible with them, and refused for both.
  const ids = new Set<string>();
  for (const t of tiers) {
    if (ids.has(t.id)) throw new UsageError(`LORE_TIERS: two tiers are both called '${t.id}' — every id must be unique`);
    ids.add(t.id);
  }

  // WHAT A RUNG'S MEMBERS MUST SHARE, refused at load rather than discovered mid-round.
  //
  // One STAGE, because the ladder crosses fast→deep between rungs and a rung half in
  // each would answer a client inline and asynchronously at once. All MODEL tiers,
  // because t0 already runs unconditionally at the head of every round — a
  // deterministic member would be a second spelling of that with nothing to run in
  // parallel WITH. And every member CONVERSATIONAL, because the emission boundary is
  // the only safe point to apply a fix or cross a peer finding: a batch member has no
  // boundaries, so a sibling's mid-round apply would rewrite files under it mid-read —
  // exactly what D-55 exists to prevent.
  for (const t of tiers) {
    if (t.rung === undefined) continue;
    const mates = tiers.filter((m) => m.rung === t.rung);
    if (mates.some((m) => m.stage !== t.stage)) {
      throw new UsageError(`LORE_TIERS: the rung holding ${mates.map((m) => m.id).join(", ")} mixes fast and deep tiers — a rung's members answer together, so they must share a stage`);
    }
    if (t.kind !== "model") {
      throw new UsageError(`LORE_TIERS: tier ${t.id} is deterministic and cannot share a rung — t0's engines already run at the head of every round`);
    }
    if (t.conversation !== true) {
      throw new UsageError(`LORE_TIERS: tier ${t.id} shares a rung but is not \`conversation: true\` — the emission boundary is the only safe point to deliver a sibling's finding or the author's fix, and a tier without one would have files rewritten under it mid-read`);
    }
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

  // EVERY NICKNAME A TIER USES MUST EXIST, checked here rather than at the moment a
  // review needs it. A typo would otherwise read as an ordinary model id, be handed
  // straight to opencode, and come back as a provider error in the middle of somebody's
  // review — the same fault the startup fallback check exists to pull forward.
  // ONLY WHERE NICKNAMES EXIST. A ladder that defines no pools has no nickname to
  // mistype, and its model ids are whatever they have always been — tightening that at
  // the same time would refuse configs this change has no quarrel with.
  // THE HELPER IS CHECKED LIKE A TIER'S MODEL, because its docstring promises exactly
  // that ("a concrete `provider/model` or a pool nickname, exactly like a tier's
  // `model`") and only the tiers were being checked. The failure it lets through is not
  // hypothetical: this key was introduced in the same change that DELETED the `GLM5.2`
  // pool, so `"helper": "GLM5.2"` — the nickname an operator has been reading in this
  // file all along — loads without complaint, is handed to opencode as a model id, and
  // fails as a provider error on every hourly screening pass and every first-review
  // bootstrap. Refused at load, where somebody is watching, exactly as a tier is.
  if (helper !== undefined && !helper.includes("/") && pools[helper] === undefined) {
    throw new UsageError(
      `LORE_TIERS: helper names the model '${helper}', which is neither a provider/model id nor one of the ` +
        `defined pools (${Object.keys(pools).join(", ") || "none"}). It would be handed to opencode as a model ` +
        `id and come back as a provider error on every background pass.`,
    );
  }
  if (Object.keys(pools).length > 0) {
    for (const t of tiers) {
      if (t.kind !== "model") continue;
      const named = t.model ?? "";
      if (named.includes("/") || pools[named] !== undefined) continue;
      throw new UsageError(
        `LORE_TIERS: tier ${t.id} names the model '${named}', which is neither a provider/model id nor one of ` +
          `the defined pools (${Object.keys(pools).join(", ")}). A mistyped nickname would otherwise be handed ` +
          `to opencode as a model id and come back as a provider error in the middle of a review.`,
      );
    }
  }
  // A ROUTE MAY NOT APPEAR TWICE IN ONE POOL. Two identical entries do not double the
  // quota; they double the chance of picking the exhausted one.
  for (const [name, routes] of Object.entries(pools)) {
    if (new Set(routes).size !== routes.length) {
      throw new UsageError(`LORE_TIERS: pool '${name}' lists the same route twice — that is not more capacity.`);
    }
    for (const r of routes) {
      if (!r.includes("/")) {
        throw new UsageError(`LORE_TIERS: pool '${name}' contains '${r}', which is not a provider/model id.`);
      }
    }
    // ONE POOL, ONE MODEL. The whole premise of a pool is that its routes are
    // interchangeable — the same reviewer reachable several ways — and every consumer
    // leans on it: the session key treats a re-pick as the same conversation partner,
    // `answeredBy` treats the pick as an accounting detail, and "twice the quota, one
    // opinion" is the sentence the feature was sold on. A pool mixing glm-5.2 with
    // kimi-k3 would be a ladder whose tier identity means nothing, enforced by nobody.
    const names = new Set(routes.map((r) => r.split("/").pop() ?? r));
    if (names.size > 1) {
      throw new UsageError(
        `LORE_TIERS: pool '${name}' mixes different models (${[...names].join(", ")}) — a pool is several ` +
          `routes to ONE model; a different model belongs in \`fallback\`.`,
      );
    }
  }

  cached = { source, tiers, pools, helper: file.helper };
  return tiers;
}

/**
 * The pools that came with the ladder last loaded.
 *
 * Read from the same cache as `loadTiers` so the two can never describe different files;
 * a caller that wants both calls `loadTiers` first, exactly as it already does.
 */
export function loadPools(source = process.env["LORE_TIERS"]): ModelPools {
  loadTiers(source);
  const c = cached;
  return c !== undefined && c.source === source ? c.pools : {};
}

/**
 * The model for work that is not a review, or `undefined` to borrow the first model tier.
 *
 * Read from the same cache as `loadTiers`, so the two can never describe different files.
 */
export function loadHelper(source = process.env["LORE_TIERS"]): string | undefined {
  loadTiers(source);
  const c = cached;
  return c !== undefined && c.source === source ? c.helper : undefined;
}

/**
 * ONE VENDOR CAN BE REACHED UNDER SEVERAL NAMES, and they all share its blind spots.
 *
 * A subscription provider and the same company's OpenRouter listing are different
 * strings for one trainer: `zai-coding-plan` and `z-ai` are Z.AI, `kimi-for-coding` and
 * `moonshotai` are Moonshot. Two SUBSCRIPTIONS to one company are the same again —
 * `zai-coding-plan2` buys quota, not a second opinion.
 *
 * **This became load-bearing the moment fallbacks fed into the count** (`answeredBy`,
 * D-49). While only CONFIGURED models were compared the names were stable and the
 * aliasing was harmless. Now a tier that falls back to its own OpenRouter twin changes
 * the string it contributes — so an all-Z.AI ladder whose t2 fell back through OpenRouter
 * would count `zai-coding-plan` and `z-ai` as two vendors and allow `passed`. That is
 * precisely the failure this function exists to prevent, reached through the door the
 * fallback list opened.
 *
 * Names, not heuristics. Stripping a trailing digit would fold `glm-5` into `glm`, and
 * guessing that two ids are one company because they look alike is how a rule that must
 * be exactly right becomes approximately right. An unknown id stands for itself, which
 * over-counts vendors — the safe direction is the one that says "not independent".
 */
const VENDOR_ALIASES: Readonly<Record<string, string>> = {
  "zai-coding-plan": "z-ai",
  "zai-coding-plan2": "z-ai",
  zai: "z-ai",
  "kimi-for-coding": "moonshotai",
};

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
  const named = (parts.length >= 3 ? parts[1] : parts[0]) ?? "";
  return VENDOR_ALIASES[named] ?? named;
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
export function soleVendorOf(
  tiers: readonly Tier[],
  unavailable: readonly string[] = [],
  answeredBy: Readonly<Record<string, string>> = {},
): string | undefined {
  const spread = vendorSpread(tiers, unavailable, answeredBy);
  return spread.distinct === 1 ? spread.vendors[0] : undefined;
}

/**
 * HOW MANY INDEPENDENT OPINIONS ACTUALLY READ THIS CODE, against how many tiers ran.
 *
 * D-1's premise is that each tier is a different vendor, because two tiers from one model
 * family share blind spots and are not two opinions. The rule enforcing it only ever asked
 * the weakest possible version of the question — *are they ALL the same?* — so three tiers
 * answered by two vendors was a clean `passed`, and the erosion between "all different" and
 * "all identical" was invisible to the verdict.
 *
 * D-117 made that erosion systematic rather than incidental. When a subscription dies the
 * free fallback is, by construction, another plan from a vendor already in the ladder —
 * that is WHY it is free — so every metered refusal trades money for vendor diversity.
 * Observed the day the gate shipped: t1 on `zai-coding-plan/glm-5.3` and t2 answered by
 * `zai-coding-plan2/glm-5.2` are both z-ai, t3 was OpenAI, and the review passed clean.
 *
 * Vany, asked what two-of-three should be worth: downgrade on ANY collapse.
 *
 * `answeredBy` over `model`, because a tier that ran on its fallback was read by THAT
 * model's vendor whatever the config says — the two disagree exactly when this matters.
 */
export interface VendorSpread {
  /** Distinct vendors among the model tiers that ran. */
  readonly distinct: number;
  /** How many model tiers ran. `distinct < tiers` is the collapse. */
  readonly tiers: number;
  /** Their names, for the sentence a person reads. */
  readonly vendors: readonly string[];
}

export function vendorSpread(
  tiers: readonly Tier[],
  unavailable: readonly string[] = [],
  answeredBy: Readonly<Record<string, string>> = {},
  readBy: Readonly<Record<string, readonly string[]>> = {},
): VendorSpread {
  const ran = tiers.filter((t) => t.kind === "model" && !unavailable.includes(t.id));
  const vendors = new Set<string>();
  for (const t of ran) {
    // EVERY ROUTE THIS TIER HAS RUN ON, not the one it happens to be on now. `answeredBy`
    // is the fallback for a review recorded before `readBy` existed, and for a tier that
    // never left its configured model — where the two agree by construction.
    const routes = readBy[t.id] ?? [answeredBy[t.id] ?? t.model ?? ""];
    for (const r of routes) vendors.add(vendorOf(r));
  }
  return { distinct: vendors.size, tiers: ran.length, vendors: [...vendors] };
}

/**
 * Did fewer vendors read this code than tiers ran? `undefined` when the review got as many
 * independent opinions as it had rungs.
 *
 * `distinct < tiers`, and accumulation is what makes that arithmetic honest. Measured over
 * a last-write-wins field it was wrong in the one shape that matters most — a single tier,
 * which has one vendor by construction and would have been refused `passed` for a property
 * it cannot have. Over the UNION it comes out right without a special case: one tier
 * contributing one vendor is `1 < 1`, false. A tier that ran on two vendors contributes
 * both, so a review where Moonshot read at t2 before Z.ai covered for it really did get
 * three opinions, and says so.
 */
export function vendorCollapse(
  tiers: readonly Tier[],
  unavailable: readonly string[] = [],
  answeredBy: Readonly<Record<string, string>> = {},
  readBy: Readonly<Record<string, readonly string[]>> = {},
): VendorSpread | undefined {
  const spread = vendorSpread(tiers, unavailable, answeredBy, readBy);
  return spread.distinct < spread.tiers ? spread : undefined;
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
  /**
   * The round at which the CLIENT last delivered work, so the bounds count arguing
   * rather than working (D-114).
   *
   * Both bounds used to count a review's whole life, which is right for a snapshot gate
   * and wrong for the incremental review D-112 opened up: a review that follows the work
   * accumulates rounds because someone keeps feeding it, and it would hit
   * `globalRounds` — twelve — for succeeding. Absent on rows written before this, read as
   * 0, which is exactly the old arithmetic.
   *
   * TERMINATION IS UNCHANGED, and this is the only thing that matters here. The bound
   * that guarantees it is "rounds since new work arrived", not "rounds ever": with no
   * new input the floor stops moving, the count runs out, and the review stops. A client
   * can extend a review indefinitely only by continuing to submit — which is not a
   * runaway, it is the feature.
   */
  readonly workRound?: number;
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
  /**
   * How many vendors actually read the code, against how many tiers ran.
   *
   * Carried in the STATE and not only in the decision, because the attestation and the
   * operator board are written from the state after the review has ended — and a
   * two-of-three collapse that only ever existed inside a `Decision` would be invisible to
   * both, which is where a reader goes to find out what a verdict was worth.
   */
  readonly vendorSpread?: VendorSpread;
  /**
   * Every route each tier has run on in this review, accumulated.
   *
   * Beside `answeredBy` rather than replacing it: that one answers "where is this tier
   * now" for route stickiness and must keep forgetting, this one answers "who has read
   * this code" for D-49 and must not.
   */
  readonly readBy?: Readonly<Record<string, readonly string[]>>;
  /**
   * The model that ACTUALLY ANSWERED each tier, where it was not the configured one.
   *
   * Independence is the product's whole claim, and until 2026-08-12 it was checked
   * against `tier.model` — the model the config NAMES. That was sound while every
   * fallback was the same model by another route, because the vendor was then the same
   * whichever route answered. It stopped being sound the day a fallback chain was allowed
   * to end at a DIFFERENT model on a plan that is still paying: with t1 on
   * `zai-coding-plan/glm-5.2` and both deep tiers falling back to it, a fully degraded
   * ladder is one model asked three times while the config still reads as three vendors.
   *
   * So the answer is recorded per tier as it happens, and `soleVendorOf` prefers it. Keyed
   * by tier id, absent for tiers that ran on their own model — which is every tier on an
   * ordinary day, so the common case stores nothing and old states read exactly as before.
   */
  readonly answeredBy?: Readonly<Record<string, string>>;
}

/**
 * Record which model answered a tier, when it was not the tier's own (D-49, D-93).
 *
 * Only ever called on the fallback path. A tier that answers on its configured model
 * leaves no entry, so `answeredBy` stays empty on every review where nothing ran out.
 */
export function markAnsweredBy(state: LadderState, tierId: string, model: string): LadderState {
  // TWO RECORDS, TWO QUESTIONS, and conflating them was the defect.
  //
  // `answeredBy` is LAST-WRITE-WINS and exists for route stickiness — *which route is this
  // tier currently on*, so a warm session is not abandoned. Independence borrowed it, and
  // borrowed a field that forgets: a tier that ran on Kimi for five rounds and Z.ai for two
  // reported only Z.ai, so the verdict claimed a vendor collapse most of the review did not
  // have. Reverse the order and it claims three independent opinions when one vendor read
  // the code twice. Wrong in both directions, and invisible from outside.
  //
  // `readBy` ACCUMULATES: every route this tier has ever run on in this review. A blind
  // spot is a property of who looked, not of which tree they looked at, so the honest
  // question for D-49 is over the union.
  const seen = state.readBy?.[tierId] ?? [];
  return {
    ...state,
    answeredBy: { ...(state.answeredBy ?? {}), [tierId]: model },
    readBy: { ...(state.readBy ?? {}), [tierId]: seen.includes(model) ? seen : [...seen, model] },
  };
}

/**
 * The client delivered work — a submitted diff, or a `pull_fresh` onto new commits — so
 * the round bounds start counting again from here (D-114).
 *
 * Both counters move together because they bound the same thing from two angles: how long
 * the ladder may go round on ONE piece of work before admitting it cannot settle it. New
 * work is new material, not the same argument continuing, and a review that keeps
 * receiving it is being used rather than looping.
 *
 * `round` itself is NOT reset. It numbers `tier_run` rows and is the review's audit
 * trail; rewinding it would make two different rounds share a number, in the one table
 * that exists to say whether a review really ran.
 *
 * NOT called for fixes lore applies on its own account, and there are none — every tree
 * change that is not a round's own output comes from the client. If that ever stops being
 * true, this is the line that decides whether the bound still means anything.
 */
export function clientDeliveredWork(state: LadderState): LadderState {
  return { ...state, tierRounds: {}, workRound: state.round };
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
 * The key that says which rung a position belongs to (D-109).
 *
 * A stamped tier answers with its rung; an unstamped one answers with its own index,
 * which makes every pre-rung ladder a ladder of one-tier rungs without a migration.
 */
export function rungKey(tiers: readonly Tier[], index: number): number {
  return tiers[index]?.rung ?? index;
}

/**
 * The model tiers that run together with the one at `cursor`, in ladder order.
 *
 * `unavailable` members are excluded because the question is always "who runs this
 * round", and a tier marked unpayable does not — the rung continues with survivors
 * (D-48 per member, unchanged).
 */
export function rungMembers(
  tiers: readonly Tier[],
  cursor: number,
  unavailable: readonly string[] = [],
): readonly Tier[] {
  const key = rungKey(tiers, cursor);
  return tiers.filter(
    (t, i) => rungKey(tiers, i) === key && t.kind === "model" && !unavailable.includes(t.id),
  );
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
  | {
      readonly kind: "passedPartial";
      readonly skipped: readonly string[];
      readonly soleVendor?: string;
      /**
       * Set when fewer vendors read the code than tiers ran (D-49, widened 2026-08-17).
       *
       * `soleVendor` is kept beside it and still means exactly what it always did — every
       * tier was one vendor — so a client reading the old field is never told something
       * false. It is simply the extreme case of this one.
       */
      readonly vendorSpread?: VendorSpread;
    }
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
  /**
   * The tier ids that actually RAN this round (D-109). Absent means the cursor's tier
   * alone — every caller that predates rungs. A rung round names its live members, so
   * each one's counter moves and a member sitting in `unavailable` is not billed for a
   * round it never saw.
   */
  readonly ran?: readonly string[];
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
  // EVERY MEMBER THAT RAN IS BILLED, not only the cursor's (D-109). A rung round runs
  // all its live members at once, and a counter that moved for one of them alone would
  // let the per-tier cap read half the iteration that actually happened.
  const ran = input.ran ?? [tier.id];
  const tierRounds = { ...prev.tierRounds };
  for (const id of ran) tierRounds[id] = (tierRounds[id] ?? 0) + 1;

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
  // COUNTED FROM THE LAST TIME THE CLIENT DELIVERED WORK, not from the review's birth
  // (D-114). Twelve rounds of ARGUING is a review that cannot converge and should stop;
  // twelve rounds spread across a week of a developer submitting, fixing and submitting
  // again is a review doing its job, and killing it there would make D-112's incremental
  // loop unusable by design. Termination is untouched: with no new work the floor stops
  // moving and this runs out exactly as before.
  if (round - (prev.workRound ?? 0) > limits.globalRounds) {
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
    //
    // ANY member that ran, on a rung (D-109): the members run every round together,
    // so their counters move together and this is the rung's own iteration count —
    // the same bound it has always been, worn by however many tiers share the round.
    if (ran.some((id) => (tierRounds[id] ?? 0) > limits.perTierRounds)) {
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
    const sole = soleVendorOf(tiers, skipped, base.answeredBy ?? {});
    // ANY REPEAT COSTS THE VERDICT, not only a total collapse (D-49, widened 2026-08-17).
    //
    // This asked `soleVendorOf` alone — all-one-vendor — so three tiers read by two vendors
    // passed clean, and the whole range between "three independent opinions" and "one
    // opinion asked three times" was worth nothing to the verdict. D-117 made that range
    // the common case: a dead subscription falls back to another plan from a vendor already
    // in the ladder, because that is the fallback that costs nothing.
    const collapse = vendorCollapse(tiers, skipped, base.answeredBy ?? {}, base.readBy ?? {});
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
      state: {
        ...base,
        cursor: prev.cursor,
        ...(sole === undefined ? {} : { soleVendor: sole }),
        ...(collapse === undefined ? {} : { vendorSpread: collapse }),
      },
      decision:
        above.length === 0 && collapse === undefined
          ? { kind: "passed" }
          : // `skipped`, not `above`: the client is still told every tier that did not
            // run. What changed is which of them costs the verdict, never which of them
            // is disclosed — a `passed` that quietly stopped mentioning t1 would be the
            // silent downgrade this whole project exists to refuse.
            {
              kind: "passedPartial",
              skipped,
              ...(sole === undefined ? {} : { soleVendor: sole }),
              ...(collapse === undefined ? {} : { vendorSpread: collapse }),
            },
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
  // PAST THE WHOLE RUNG, not merely past the cursor (D-109). A clean rung means every
  // member was clean — `raised` is their union — so the cursor's own rung-mates are
  // already answered, and stepping "up" onto one would run half the rung again alone.
  const key = rungKey(tiers, from);
  for (let i = from + 1; i < tiers.length; i++) {
    const t = tiers[i];
    if (rungKey(tiers, i) === key) continue;
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
 *
 * `rung` joins the pin (D-109), because a regrouped ladder runs the same tiers with a
 * different meaning: inside a rung the members are peers on one tree, not gates for each
 * other, and a review must finish under the discipline it started under. Spelled `r-`
 * for a tier that runs alone — which is every tier in every config that predates rungs —
 * so existing pins keep matching field-for-field, and old shorter pins have no opinion
 * (`ladderChanged` compares only shared fields, by design).
 */
export function ladderFingerprint(tiers: readonly Tier[]): string {
  return tiers
    .map((t) => `${t.id}:${t.model ?? t.kind}:${t.effort ?? "-"}:${t.stage}:${t.rung === undefined ? "r-" : `r${String(t.rung)}`}`)
    .join(",");
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
