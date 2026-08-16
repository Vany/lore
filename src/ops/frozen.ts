/**
 * IS LORE FROZEN BY THE DAY'S SPEND CEILING (D-119).
 *
 * One predicate, because two places have to agree about it and they are in different
 * files: the dispatcher must not CLAIM work while frozen, and the retention sweep must not
 * EXPIRE anybody while frozen. A second copy of this arithmetic would eventually disagree
 * with the first, and the disagreement would be a client's review reaped for waiting.
 *
 * Inert under subscriptions, deliberately: every `usage` row carries `cost_usd: 0` on a
 * flat plan, so the sum is zero and this never fires. It becomes real the moment a
 * fallback walks onto a metered route (D-117).
 */
import { startOfDayIso } from "./spend.ts";
import type { Store } from "../store/store.ts";

export function frozenBySpend(store: Store, dailyCeilingUsd?: number): boolean {
  if (dailyCeilingUsd === undefined) return false;
  return store.spendSince(startOfDayIso()) >= dailyCeilingUsd;
}
