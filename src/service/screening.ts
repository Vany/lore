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

import { retryAt } from "../core/cooloff.ts";
import { concreteRoute, loadHelper, loadPools } from "../core/ladder.ts";
import { dataDir } from "../core/paths.ts";
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
  // THE HELPER MODEL WHERE ONE IS NAMED. Judging whether an extracted candidate is a
  // rule is not reviewing anything, and this ran HOURLY against whatever the first model
  // tier was — so every screening pass competed for the gate tier's subscription, the
  // one seat every review's first round needs. Vany: *"if we need just GLM, to
  // understand something, not for review, use 5.2 from the small subscription."*
  // Absent, it borrows the first model tier exactly as before.
  const helperModel = loadHelper();
  const named = helperModel !== undefined
    ? { id: "helper", kind: "model" as const, model: helperModel, stage: "fast" as const }
    : tiers.find((t) => t.kind === "model" && t.model !== undefined);
  const ask = reviewer.askFor?.bind(reviewer);
  if (named === undefined || ask === undefined) return;

  // INSIDE THE GUARD, both of them. The docstring promises this never rejects — the
  // caller is a timer and an unhandled rejection from a timer is a dead process — and
  // `tierUnavailable` and `repos()` are store calls that sat outside every try. A locked
  // or unreadable database would have taken the process with it, through the one function
  // that says it cannot.
  let repos: readonly { readonly id: string; readonly name: string }[];
  let down;
  let route: string | undefined;
  try {
    down = store.tierUnavailable(named.id);
    repos = store.repos();
    // THE NICKNAME RESOLVED TO A ROUTE THAT CAN PAY, before anything is asked. `t1.model`
    // may be a pool name, and handing that to opencode is how the screen died every hour
    // after pools shipped — `model id 'GLM5.2' is not provider/model`, loudly, four
    // documents waiting. Inside this guard because it reads the store, and the docstring
    // promises a closed database returns rather than rejects.
    route = concreteRoute(named, loadPools(), (m) => store.routeUnavailable(m));
  } catch (e) {
    log(`[lore:log] background screen could not read the database: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // No usable route means no pass this hour, said out loud: the rules stay live exactly
  // as they do through a tier cool-off.
  if (route === undefined) {
    log(`[lore:log] background screen skipped — every route to ${named.model ?? "?"} is out of quota`);
    return;
  }
  const tier = { ...named, model: route };

  // NOT EVEN INITIATED (D-90). A tier known to be down is not asked, and this is the
  // whole point: a deadline bounds a wasted call, and not making it costs nothing. With
  // an exhausted plan the alternative was one 45-minute hang per hour, holding a quarter
  // of the provider gate, to re-learn a fact already written down.
  if (down !== undefined && down.until > new Date().toISOString()) {
    // Silent. This is the expected state for as long as the cool-off lasts, and an hourly
    // line saying so is how a log stops being read. `make status` shows it standing.
    return;
  }

  let stopPass = false;
  for (const repo of repos) {
    // A tier is billed the same whoever asked it, so a background screen lands in `usage`
    // under `screen:<tier>` exactly as the inline one did — with no review id, because
    // there is no review. `ops/spend` therefore still sees every model call lore makes.
    const spent = (u: ScreenUsage) => store.recordUsage(screenUsage(u, repo.id));
    // A REAL DIRECTORY, because this one IS used and the comment here used to say it was
    // not. `screenFor` forwards it to `ask()`, which sends it as `query: {directory}` on
    // `session.prompt` — so `""` was telling opencode to run the session in a path that
    // does not exist, and both plausible behaviours (refuse, or silently use its own cwd)
    // are wrong in a way nothing would have reported — and the comment here asserted the
    // opposite, which is why it went unexamined.
    //
    // `rescreen` genuinely needs no worktree: it reads the rows, which carry the document
    // path and the statements. But opencode needs somewhere to be, so it gets lore's data
    // directory — mounted read-only into the opencode container at the same absolute path
    // (`deploy/docker-compose.yml`), and the one path guaranteed to exist on both sides.
    const screen = screenFor(ask, tier, dataDir(), { spent });
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
        // STOPS FOR THE PASS, which is what D-87 says and what `screenFor` does WITHIN a
        // repository — but its `stopped` flag is rebuilt per repo, so a pass over R
        // backlogged repositories made R dead-tier calls and advanced `failures` by R,
        // running the doubling schedule R times faster than `cooloff.test.ts` pins. One
        // fault is one fault however many repositories were waiting on it.
        stopPass = true;
        // THE PROVIDER'S OWN DEADLINE BEATS OUR GUESS (D-91). When Z.ai says *"your limit
        // will reset at 2026-08-10 18:19:09"* there is nothing to infer: waiting exactly
        // that long is both the shortest correct wait and the longest safe one. The
        // doubling backoff below is what to do when NOBODY SAID — it was written believing
        // nobody ever would, which D-84 got wrong.
        //
        // Clamped, because a parsed timestamp is attacker-adjacent input in the general
        // case and a typo in the far future would retire a tier for ever. A minute is the
        // floor so a bad parse cannot become a busy loop; a week is the ceiling because a
        // tier nobody retries for longer than that is a tier nobody would notice coming
        // back.
        const { until, stated } = retryAt(Date.now(), failures, r.retryAfter);
        const why = stated
          ? "the provider said its limit resets then"
          : `${String(failures)} consecutive screen call(s) went unanswered`;
        store.markTierUnavailable(tier.id, until, why, failures, stated);
        // SAID ONCE, when the decision is made rather than every hour it holds. This is
        // the line that tells an operator a provider is down, which the service has never
        // been able to say from the inside (`spec/operations.md` §2.4.2).
        log(
          `lore: ${tier.id} (${tier.model ?? "?"}) did not answer — not asking it again before ${until} ` +
            `(${why}; failure ${String(failures)}). ${String(r.deferred)} document(s) of ${repo.name} keep ` +
            "waiting; their rules stay live and in use.",
        );
      } else if (r.documents === 0 && r.deferred === 0) {
        // NOTHING TO ASK, so nothing was learned — and an old mark left standing is not
        // neutral: its `failures` count only ever grows, so a tier that recovered weeks
        // ago would meet the next single blip with a 24-hour skip instead of an hour.
        //
        // Cleared only once the cool-off has EXPIRED, so a live one still holds. The cost
        // of being wrong is one cheap probe — since D-91 a dead tier answers in about
        // twelve seconds — against a working tier sitting unused for a day.
        const stale = store.tierUnavailable(tier.id);
        if (stale !== undefined && stale.until <= new Date().toISOString()) store.clearTierUnavailable(tier.id);
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
    if (stopPass) break;
  }
}
