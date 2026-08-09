/**
 * The background screen: judge the knowledge base's unscreened rules, off the review path.
 *
 * One timer, every repository, one pass. Everything about *what* the screen decides lives
 * in `knowledge/screen.ts` and `knowledge/rescreen.ts`; this file is only the scheduling
 * and the wiring — which tier is asked, where the spend is recorded, and what happens when
 * the pass fails.
 *
 * Extracted rather than written inline in `serve()`, because the last two defects of this
 * shape both lived in closures built there where no test could reach them: the MCP server
 * given no reviewer, and an enqueue with no failure path.
 *
 * SPEC: SPEC.md D-89, spec/knowledge.md §2.2
 */

import { rescreen } from "../knowledge/rescreen.ts";
import { screenFor, screenUsage, type ScreenUsage } from "../knowledge/screen.ts";
import type { Tier } from "../core/ladder.ts";
import type { ReviewerLike } from "../reviewer/opencode.ts";
import type { Store } from "../store/store.ts";

/**
 * How often the backlog is worked through.
 *
 * The same hour as the retention sweep, and for the same reason: nothing here is urgent.
 * An unscreened rule is a live rule that may be a fragment — it costs a line in a prompt,
 * not a wrong review — and the base sat with 27 of them for a week without anyone
 * noticing. Sooner would spend quota to fix something nobody is waiting on.
 */
export const RESCREEN_INTERVAL_MS = 3_600_000;

/**
 * How long a tier is left alone after it fails, doubling while it keeps failing.
 *
 * Vany: *"if t1 is skipped, it must not even initiate screen."* Not calling at all is the
 * only thing that costs nothing; a deadline merely bounds the waste. But lore cannot ask
 * a provider whether it is available — opencode swallows the refusal (D-84), so the ONLY
 * evidence is a call that failed, and the only question is how long to believe it.
 *
 * Doubling, because the two failure modes want opposite answers and we cannot tell them
 * apart at the moment of failure. A provider blip wants a quick retry; an exhausted
 * subscription wants a very long one — the plan that caused this reset four days later,
 * and the refusal named the date lore never gets to see. Backing off converges on either:
 * a blip costs one wasted hour, and a four-day outage costs 1+2+4+8+16+24+24… ≈ seven
 * wasted calls instead of ninety-six.
 *
 * Capped at a day, because a tier nobody has tried for longer than that is a tier nobody
 * would notice coming back, and the backlog it screens has no deadline at all.
 *
 * NOTHING IS INFERRED FROM THE CLOCK. There is no schedule here and no guess about a
 * provider's window: the mark is written when a call fails and deleted when one succeeds.
 */
export const COOLOFF_MS = 3_600_000;
export const COOLOFF_CAP_MS = 24 * 3_600_000;

export function coolOffMs(consecutiveFailures: number): number {
  return Math.min(COOLOFF_CAP_MS, COOLOFF_MS * 2 ** Math.max(0, consecutiveFailures - 1));
}

/**
 * Judge every repository's unscreened rules once.
 *
 * Returns rather than throws, and never rejects: the caller is a timer, and an unhandled
 * rejection from a timer is a dead process.
 */
export async function screeningPass(
  store: Store,
  reviewer: ReviewerLike,
  tiers: readonly Tier[],
  log: (line: string) => void = (l) => {
    console.error(l);
  },
): Promise<void> {
  // The CHEAPEST model tier, exactly as the inline screen used: this is a classification
  // with its evidence already in the prompt, and spending a deep tier on it would take
  // quota from the thing that reads branches.
  const tier = tiers.find((t) => t.kind === "model" && t.model !== undefined);
  const ask = reviewer.askFor?.bind(reviewer);
  if (tier === undefined || ask === undefined) return;

  // NOT EVEN INITIATED (D-90). A tier known to be down is not asked, and this is the
  // whole point: a deadline bounds a wasted call, and not making it costs nothing. With
  // an exhausted plan the alternative was one 45-minute hang per hour, holding a quarter
  // of the provider gate, to re-learn a fact already written down.
  const down = store.tierUnavailable(tier.id);
  if (down !== undefined && down.until > new Date().toISOString()) {
    // Silent. This is the expected state for as long as the cool-off lasts, and an hourly
    // line saying so is how a log stops being read. `make status` shows it standing.
    return;
  }

  for (const repo of store.repos()) {
    // A tier is billed the same whoever asked it, so a background screen lands in `usage`
    // under `screen:<tier>` exactly as the inline one did — with no review id, because
    // there is no review. `ops/spend` therefore still sees every model call lore makes.
    const spent = (u: ScreenUsage) => store.recordUsage(screenUsage(u, repo.id));
    // NO WORKTREE. `rescreen` works from the rows, which already carry the document path
    // and the statements, so this needs no checkout and no opinion about which branch is
    // current. The path handed to `screenFor` is unused by it for that reason.
    const screen = screenFor(ask, tier, "", { spent });
    try {
      const r = await rescreen(store, repo.id, screen);

      // WHAT THE PASS LEARNED ABOUT THE TIER, written down so the next one need not
      // re-learn it at the cost of a hang (D-90).
      //
      // `deferred > 0` is exactly the signal: `screenFor` stops asking after a fault that
      // belongs to the TIER rather than to the document (D-87), so a deferral means the
      // provider did not answer — not that a document was awkward.
      if (r.deferred > 0) {
        const failures = (store.tierUnavailable(tier.id)?.failures ?? 0) + 1;
        const until = new Date(Date.now() + coolOffMs(failures)).toISOString();
        store.markTierUnavailable(tier.id, until, `${String(failures)} consecutive screen call(s) went unanswered`, failures);
        // SAID ONCE, when the decision is made rather than every hour it holds. This is
        // the line that tells an operator a provider is down, which the service has never
        // been able to say from the inside (`spec/operations.md` §2.4.2).
        log(
          `lore: ${tier.id} (${tier.model ?? "?"}) did not answer — not asking it again before ${until} ` +
            `(failure ${String(failures)}). ${String(r.deferred)} document(s) of ${repo.name} keep waiting; ` +
            "their rules stay live and in use.",
        );
      } else if (r.documents > 0) {
        // IT ANSWERED, so whatever we believed about it being down is stale. Kept in the
        // same branch as the counting, because a mark left behind after recovery means a
        // tier we stop using for nothing — the opposite failure, and the quieter one.
        store.clearTierUnavailable(tier.id);
        log(
          `lore: screened ${String(r.documents)} document(s) of ${repo.name} — ` +
            `${String(r.kept)} rules kept, ${String(r.refused)} refused`,
        );
      }
    } catch (e) {
      // NEVER FATAL AND NEVER SILENT. The rows keep their stamp and come back next hour,
      // so a failure here costs nothing but time — but a screen that quietly stopped
      // running would leave the base degrading with `make status` still reporting the
      // count as though something were working on it.
      log(`[lore:log] background screen failed for ${repo.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
