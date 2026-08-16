/**
 * IS THIS ROUTE ONE THAT BILLS PER CALL (D-117)?
 *
 * Vany: *"metered is only openrouter. It is human managed."*
 *
 * A string test on the route, not a cost model. Every other provider in this deployment
 * is a flat subscription; OpenRouter is the only one that charges for the call it is
 * about to make. So "would continuing down the fallback chain start spending money" is
 * answerable BEFORE the call, from the route id alone — which is the whole point, because
 * the alternative is finding out afterwards from a total.
 *
 * That alternative was tried and it failed in the way that matters. On 2026-08-16 at
 * 05:06 UTC the Kimi subscription hit its billing-cycle limit, D-48 parked the route and
 * walked the chain exactly as designed onto `openrouter/moonshotai/kimi-k3` — the same
 * model, metered, ~$4.83 a call. Twenty-one calls and $101.36 later the only thing that
 * spoke was a daily spend ceiling, four hours after the event, and it spoke by stopping
 * eight reviews on three other people's branches at round 0. Route health and route COST
 * are different questions, and only the first was being asked.
 *
 * The ceiling is gone (D-121). This is what replaced it: asked first, answered from
 * config by a person, and it costs nothing when the answer is yes.
 *
 * SPEC: SPEC.md D-117, spec/operations.md §4
 */

/**
 * The prefix, held once.
 *
 * Routes reach here as opencode model ids — `provider/model`, e.g.
 * `openrouter/moonshotai/kimi-k3`. Matching the provider segment rather than searching
 * the whole string keeps `zai-coding-plan/openrouter-mirror` (or any future model whose
 * NAME contains the word) from being read as metered.
 */
const METERED_PROVIDER = "openrouter";

export function isMeteredRoute(route: string): boolean {
  return route.slice(0, route.indexOf("/")) === METERED_PROVIDER;
}

/**
 * Drop the routes a subscription-only deployment must not walk onto.
 *
 * Returns the chain unchanged when metered routes are allowed, so the permitted case
 * carries no behaviour of its own — a deployment that has deliberately bought metered
 * capacity as its safety net keeps the safety net, which is the objection that stopped
 * this being decided by the ladder in the first place.
 *
 * When they are refused the chain can empty, and an empty chain is the honest outcome
 * rather than an error: the caller rethrows the original `Exhausted`, D-48 steps over the
 * tier, and the verdict is `passed_partial` with the tier named in `checks_skipped`. Free,
 * already implemented, and it says out loud that the review is worth less.
 */
export function withoutMetered(chain: readonly string[], allowMetered: boolean): readonly string[] {
  return allowMetered ? chain : chain.filter((r) => !isMeteredRoute(r));
}

/**
 * The spellings of yes, held in ONE place.
 *
 * The service parses `LORE_ALLOW_METERED` at startup (`envBool`) and accepts
 * `1/true/yes/on`; `make status` reads the same variable to explain what a cool-off costs.
 * The two started out disagreeing — status tested `=== "1"` alone — so a deployment
 * configured with `true` would pay for fallbacks while the one view an operator is taught
 * to watch reported that it would not. Two readers of one setting is exactly the drift
 * D-11 calls this repository's most common defect, and the fix is that there is only one
 * reader of the STRING.
 *
 * Anything unrecognised is not answered here. `envBool` throws on it at startup, which is
 * the one moment somebody is watching; this is for readers that cannot refuse to exist.
 */
export const METERED_YES = ["1", "true", "yes", "on"] as const;

export function allowMeteredFromEnv(raw: string | undefined): boolean {
  return METERED_YES.includes((raw ?? "").trim().toLowerCase() as (typeof METERED_YES)[number]);
}
