/**
 * The daily spend ceiling.
 *
 * At 30 PRs a day this is a $500–2,600/month tool, and a cheap tier looping on a
 * pathological branch is exactly the shape that runs up a bill nobody sees until
 * the invoice.
 *
 * When the ceiling is reached the service **stops starting reviews** rather than
 * continuing quietly. A review not started is honest; a review that runs and cannot
 * be paid for is not.
 *
 * SPEC: spec/operations.md §4
 */

import type { Store } from "../store/store.ts";
import { Alerter, CONDITIONS } from "./alerts.ts";

export interface SpendConfig {
  readonly dailyCeilingUsd: number;
  /** Fraction of the ceiling at which a ticket is raised rather than a page. */
  readonly warnAt: number;
}

export const DEFAULT_SPEND: SpendConfig = { dailyCeilingUsd: 100, warnAt: 0.8 };

export function startOfDayIso(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export interface SpendVerdict {
  readonly allowed: boolean;
  readonly spent: number;
  readonly ceiling: number;
  /**
   * Whether this deployment reports cost at all.
   *
   * `false` means the ceiling CANNOT FIRE, and that is not a bug — it is what a
   * subscription looks like. Both current providers bill a flat rate, so every one of
   * the 84 usage rows carries `cost_usd = 0` and this sums exactly that column.
   *
   * It matters because an unfired ceiling reads as headroom. "Spend is $0 against a
   * $100 ceiling" and "nothing here can measure spend" are opposite facts that look
   * identical in a dashboard, and this is the only thing that separates them. A guard
   * that cannot fire must say so rather than stay quiet and be mistaken for one that
   * looked.
   */
  readonly metered: boolean;
}

/**
 * May a new review start?
 *
 * Checked before starting, at enqueue — and `runRound` asks again at every ROUND
 * BOUNDARY (D-93), which is not the same as mid-review: killing a review halfway leaves it in
 * a state that is neither passed nor honestly failed, and wastes everything already
 * spent on it.
 */
export async function mayStart(store: Store, cfg: SpendConfig, alerter: Alerter): Promise<SpendVerdict> {
  const spent = store.spendSince(startOfDayIso());
  const metered = store.hasMeteredUsage();

  if (spent >= cfg.dailyCeilingUsd) {
    await alerter.send(CONDITIONS.spendCeiling(spent, cfg.dailyCeilingUsd));
    return { allowed: false, spent, ceiling: cfg.dailyCeilingUsd, metered };
  }
  if (spent >= cfg.dailyCeilingUsd * cfg.warnAt) {
    await alerter.send(CONDITIONS.spendAnomaly(spent, cfg.dailyCeilingUsd * cfg.warnAt));
  }
  return { allowed: true, spent, ceiling: cfg.dailyCeilingUsd, metered };
}

/** Per-tier spend, for the operator view — where the money actually goes. */
export function spendByTier(store: Store, sinceIso: string): readonly { tier: string; usd: number; calls: number }[] {
  return store.spendByTierSince(sinceIso);
}
