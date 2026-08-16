/**
 * WHAT WAS SPENT — REPORTED, NEVER ACTED ON (D-121).
 *
 * Vany: *"we only show the price, there is no decision on the basis of it."*
 *
 * Everything here is read by the operator views and by nothing else. No caller may branch
 * on these numbers: money does not decide whether a review starts, whether a round runs,
 * whether a job is claimed, or whether anybody is expired. That is the whole contract of
 * this file, and it is the reason it is this short.
 *
 * It used to hold a daily ceiling that refused admission at $100. The ceiling was not
 * wrong about the money and it was the wrong instrument anyway: by the time a total can
 * fire, the money is spent, and the people it stops are not the people who spent it. On
 * 2026-08-16 it stopped eight reviews across three colleagues' branches at round 0, having
 * read nothing, for a bill run up by an unrelated batch. A gate that cannot run is this
 * project's worst outcome — worse than the invoice it was guarding.
 *
 * What guards the money now is D-117: a metered route is one the operator switched on,
 * asked before the call from the route id, in `core/metered.ts`. A price is evidence for a
 * person; it is not a control loop.
 *
 * lore does not CALCULATE any of this. There is no rate card here and there never was —
 * `cost_usd` is whatever opencode reported for the call (`usageFromMessages`), summed.
 *
 * SPEC: spec/operations.md §4, SPEC.md D-121
 */

import type { Store } from "../store/store.ts";

/**
 * Midnight UTC today.
 *
 * The day boundary the operator views group by. UTC and not a local zone because the
 * providers bill that way and an operator comparing lore's figure against an invoice
 * should not have to reason about which midnight either of them meant.
 */
export function startOfDayIso(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** Per-tier spend, for the operator view — where the money actually goes. */
export function spendByTier(store: Store, sinceIso: string): readonly { tier: string; usd: number; calls: number }[] {
  return store.spendByTierSince(sinceIso);
}
