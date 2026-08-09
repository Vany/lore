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
      // Silent when it did nothing, which is almost every hour. A log line per repo per
      // hour saying "0" is how a log stops being read.
      if (r.documents > 0 || r.deferred > 0) {
        log(
          `lore: screened ${String(r.documents)} document(s) of ${repo.name} — ` +
            `${String(r.kept)} rules kept, ${String(r.refused)} refused` +
            (r.deferred > 0 ? `, ${String(r.deferred)} document(s) deferred: the tier stopped answering` : ""),
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
