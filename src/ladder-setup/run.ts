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
import type { Tier } from "../core/ladder.ts";
import { fetchCatalog, type CatalogModel } from "./catalog.ts";
import { ladderPrompt, LADDER_CONTRACT } from "./prompt.ts";
import { makeTierPickParser, validatePicks, type TierPick } from "./suggestion.ts";

/** The model that makes the pick. Reuses `DEFAULT_TIERS[1]`'s own choice (`core/ladder.ts`)
 *  rather than inventing a new default: already the proven zero-config gate model. */
export const BOOTSTRAP_CALLER: Tier = {
  id: "ladder-setup",
  kind: "model",
  model: "openrouter/z-ai/glm-5.2",
  effort: "medium",
  stage: "fast",
};

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

  const result = await deps.ask(BOOTSTRAP_CALLER, ladderPrompt(catalog), worktree, extract, LADDER_CONTRACT);

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

  return { tiers, picks, candidateCount: catalog.length };
}
