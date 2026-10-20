/**
 * D-159's acceptance rule, run once over STORED verdicts, report-only (decision 7: old
 * reviews are not re-judged; show where the new rule would decide differently).
 *
 * Only this rule is replayable. The ledger's other two answers — what an all-skipped rung
 * emitted, and which raise came after which fix on one clock — need a record of who emitted
 * what and when, and rounds before `contest_event` kept none. Said in the report rather than
 * implied by an empty list.
 *
 * The rule: silence accepts an answer only from a finisher at or above the tier that raised
 * the finding. A stored `justified-accepted` stamped by a tier weaker than the finding's
 * origin is exactly the acceptance the ledger now calls UNKNOWN. Ranks come from the
 * review's own pinned ladder (`review.tiers`), never today's config.
 */

import type { Store } from "../store/store.ts";

export interface ReplayDiffer {
  readonly reviewId: string;
  readonly state: string;
  readonly fingerprint: string;
  readonly acceptedBy: string;
  readonly raisedBy: string;
  readonly round: number | null;
}

export interface ReplayReport {
  /** Model acceptances examined: carried and expiry rows are someone else's ruling. */
  readonly checked: number;
  readonly differ: readonly ReplayDiffer[];
  /** What a replay cannot see, said every time. */
  readonly blind: readonly string[];
}

export function replayAcceptances(store: Store): ReplayReport {
  const rows = store.latestModelAcceptances();

  const differ: ReplayDiffer[] = [];
  let checked = 0;
  for (const r of rows) {
    // No pinned ladder means no ranks to compare — not counted, rather than guessed at.
    if (r.tiers === null) continue;
    const order = r.tiers.split(",").map((t) => t.split(":")[0] ?? "");
    const rank = (id: string) => order.indexOf(id);
    if (rank(r.tier) < 0 || rank(r.origin) < 0) continue;
    checked++;
    if (rank(r.origin) > rank(r.tier)) {
      differ.push({ reviewId: r.review_id, state: r.state, fingerprint: r.fingerprint, acceptedBy: r.tier, raisedBy: r.origin, round: r.round });
    }
  }
  return {
    checked,
    differ,
    blind: [
      "an all-skipped rung's emissions and the per-pass clock cannot be replayed: rounds before contest_event kept no record of who emitted what, when",
    ],
  };
}

export function renderReplay(r: ReplayReport): string {
  const lines = [
    `D-159 replay (report only, nothing changed): ${String(r.checked)} model acceptance(s) checked, ` +
      `${String(r.differ.length)} the ledger would have held as UNKNOWN.`,
    ...r.differ.map(
      (d) =>
        `  ${d.reviewId} [${d.state}] ${d.fingerprint.slice(0, 8)}: raised by ${d.raisedBy}, accepted on ${d.acceptedBy}'s silence` +
        (d.round === null ? "" : ` in round ${String(d.round)}`),
    ),
    ...r.blind.map((b) => `  NOT CHECKED: ${b}`),
  ];
  return `${lines.join("\n")}\n`;
}
