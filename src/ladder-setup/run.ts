/**
 * The orchestration: fetch the live catalog, ask one model to pick from it, validate the
 * reply, assemble a ladder. One call, one model session, no `Store` — this runs before a
 * deployment has a database, the same reason `lore review` and `lore propose` work
 * standalone (`Reviewer`'s constructor takes only a `ReviewerConfig`).
 *
 * SPEC: spec/review-ladder.md
 */

import { extractList, type Listed, type SessionResult } from "../reviewer/opencode.ts";
import { DidNotRun } from "../core/errors.ts";
import { DEFAULT_TIERS, type Tier } from "../core/ladder.ts";
import { fetchCatalog, type CatalogModel } from "./catalog.ts";
import { ladderPrompt, LADDER_CONTRACT } from "./prompt.ts";
import { makeTierPickParser, validatePicks, type TierPick } from "./suggestion.ts";

/** The id every bootstrap-caller tier carries, whichever model it ends up naming. */
export const BOOTSTRAP_CALLER_ID = "ladder-setup";

/**
 * The model that makes the pick, chosen from the SAME live catalog it is about to hand
 * the picker — never a second hardcoded guess. Prefers `DEFAULT_TIERS[1]`'s own values
 * (`core/ladder.ts`), spread rather than re-typed so the two cannot silently drift apart,
 * but only when that model is actually IN the catalog: found by lore's own review,
 * fingerprint 9a97bb77 — a tool that exists to replace a stale hardcoded guess must not
 * share DEFAULT_TIERS' single point of failure with no way out when OpenRouter withdraws
 * it. Falls back to the catalog's own cheapest priced candidate, since the bootstrap call
 * is a short JSON-generation task, not a task that benefits from spending more.
 */
function pickCaller(catalog: readonly CatalogModel[]): Tier {
  const preferred = DEFAULT_TIERS[1];
  if (preferred?.model !== undefined && catalog.some((c) => c.id === preferred.model)) {
    return { ...preferred, id: BOOTSTRAP_CALLER_ID };
  }
  const priced = [...catalog]
    .filter((c) => c.costInput !== undefined)
    .sort((a, b) => (a.costInput ?? 0) - (b.costInput ?? 0));
  const fallback = priced[0] ?? catalog[0];
  if (fallback === undefined) {
    // Unreachable once suggestLadder's own catalog.length < 3 guard has run first (it
    // always does — this is the only caller) — kept as a real throw rather than a
    // silent default, since skipping the guard deserves a loud error, not a made-up id.
    throw new DidNotRun("no candidate model available to make the ladder pick itself");
  }
  return { id: BOOTSTRAP_CALLER_ID, kind: "model", model: fallback.id, effort: "medium", stage: "fast" };
}

export interface LadderSetupDeps {
  readonly fetchCatalog: () => Promise<readonly CatalogModel[]>;
  readonly ask: <T>(
    tier: Tier,
    prompt: string,
    worktree: string,
    extract: (text: string) => Listed<T>,
    contract: string,
  ) => Promise<SessionResult<T>>;
}

/** Production wiring — `cli.ts`'s own default. Tests inject a fake instead. */
export function defaultDeps(reviewer: { askFor: LadderSetupDeps["ask"] }): LadderSetupDeps {
  return { fetchCatalog, ask: reviewer.askFor.bind(reviewer) };
}

export interface LadderSetupResult {
  /** `t0` deterministic, then the three picks in role order — ready to write out as-is. */
  readonly tiers: readonly Tier[];
  /** The same three, with their model's own stated reasoning, for the printed summary. */
  readonly picks: readonly TierPick[];
  readonly candidateCount: number;
  /**
   * What the bootstrap call itself cost — found missing by lore's own review,
   * fingerprint e3ed9214: on a metered-only install this spends real money and the
   * first version reported none of it, contradicting D-121's "lore reports what each
   * call cost". `SessionResult`'s own fields, carried through rather than discarded.
   */
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
}

const ROLE_ORDER: Record<TierPick["role"], number> = { t1: 0, t2: 1, t3: 2 };

export async function suggestLadder(deps: LadderSetupDeps, worktree = process.cwd()): Promise<LadderSetupResult> {
  const catalog = await deps.fetchCatalog();
  // Fewer than 3 usable models cannot possibly satisfy the three-distinct-vendor rule —
  // refused here, loudly, rather than spending a session asking the impossible.
  if (catalog.length < 3) {
    throw new DidNotRun(
      `only ${String(catalog.length)} usable OpenRouter model(s) reachable (tool-call-capable, not deprecated/` +
        "alpha) — need at least 3 for an independent ladder. Check the OpenRouter key is set and connected " +
        "('lore doctor'), or that opencode's own catalog has not shrunk.",
    );
  }

  const knownIds = new Set(catalog.map((c) => c.id));
  const parseOne = makeTierPickParser(knownIds);
  const extract = (text: string): Listed<TierPick> => extractList<TierPick>(text, "tiers", parseOne);

  let result: SessionResult<TierPick>;
  try {
    result = await deps.ask(pickCaller(catalog), ladderPrompt(catalog), worktree, extract, LADDER_CONTRACT);
  } catch (e) {
    // A failed call is still a paid one — surfaced in the message since there is no
    // `Store` here to record it against, mirroring `refactor/run.ts`'s own
    // `recordFailedUsage` shape (`.spent` recovered onto a thrown error) one door down.
    const spent = (e as { spent?: { input: number; cached: number; output: number; cost: number } }).spent;
    const spentNote =
      spent === undefined
        ? ""
        : ` (spent before failing: $${spent.cost.toFixed(4)}, ${String(spent.input)} in / ${String(spent.output)} out)`;
    throw new DidNotRun(`the bootstrap call failed: ${e instanceof Error ? e.message : String(e)}${spentNote}`);
  }

  const err = validatePicks(result.items);
  if (err !== undefined) {
    const rejectedNote = result.rejected.length > 0 ? ` (also rejected: ${result.rejected.join("; ")})` : "";
    throw new DidNotRun(`the model's ladder pick was invalid: ${err}${rejectedNote}`);
  }

  const picks = [...result.items].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const tiers: Tier[] = [
    { id: "t0", kind: "deterministic", stage: "fast" },
    ...picks.map((p) => ({
      id: p.role,
      kind: "model" as const,
      model: p.model,
      effort: p.effort,
      stage: p.role === "t1" ? ("fast" as const) : ("deep" as const),
    })),
  ];

  return {
    tiers,
    picks,
    candidateCount: catalog.length,
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    cachedTokens: result.cachedTokens,
    outputTokens: result.outputTokens,
  };
}
