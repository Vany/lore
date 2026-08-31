/**
 * The orchestration: fetch the live catalog, ask one model to pick from it, validate the
 * reply, assemble a ladder. One call, one model session, no `Store` — this runs before a
 * deployment has a database, the same reason `lore review` and `lore propose` work
 * standalone (`Reviewer`'s constructor takes only a `ReviewerConfig`).
 *
 * SPEC: spec/review-ladder.md
 */

import { join } from "node:path";
import { CHARS_PER_TOKEN, extractList, type Listed, type SessionResult } from "../reviewer/opencode.ts";
import { DidNotRun } from "../core/errors.ts";
import { DEFAULT_TIERS, type Tier } from "../core/ladder.ts";
import { dataDir } from "../core/paths.ts";
import { fetchCatalog, type CatalogModel } from "./catalog.ts";
import { ladderPrompt, LADDER_CONTRACT } from "./prompt.ts";
import { makeTierPickParser, validatePicks, type TierPick } from "./suggestion.ts";

/**
 * Anchored at `dataDir()/repos`, NEVER `process.cwd()` — found by lore's own review,
 * fingerprint 476c87c6: this session runs inside the `lore` container, where
 * `process.cwd()` is `/app`, a path that does not exist inside the SEPARATE `opencode`
 * container the SDK actually resolves `directory` against (`docker-compose.yml`'s
 * `opencode` service mounts only `${LORE_HOST_DATA}/repos`, read-only — nothing else
 * lore's own filesystem has is shared with it, on purpose). An unresolvable directory
 * has been reported upstream to fall back to opencode's own "global" project rooted at
 * "/" — the opencode CONTAINER's own root, where `auth.json` (the actual OpenRouter/
 * Z.ai/OpenAI credentials) lives on disk. `repos` is the one path guaranteed to exist
 * on both sides, exactly the reasoning `propose`'s own `reposRoot` (`cli.ts`) already
 * uses for the same two-container split.
 *
 * lore-ok[b532a942]: found by lore's own review — `repos` EXISTS, but is not itself a
 * git repository (its children, one per mirrored customer repo, are); the upstream
 * fallback this fix cites has not been confirmed to key on existence specifically
 * rather than "no VCS root found here", and a fresh install's `repos/` starts empty,
 * so the residual case this fix may not fully close is real and NOT verified shut —
 * stated plainly rather than claimed fixed, since confirming opencode's own exact
 * resolution rule needs either its source or a live session-scope experiment, and the
 * one attempted here was stopped before it ran. Two things bound the actual risk in
 * the meantime, not removed by this fix but already true regardless of it: every
 * `askFor` caller in this codebase — `propose`, `refactor`, this one — runs under the
 * SAME read-only agent (`DEFAULT_REVIEWER.agent = "readonly"`, `opencode.ts:160`;
 * verified present at boot, INV-8), so a worse-than-intended scope is not a NEW
 * capability this feature grants, only a possibly-wider read scope under a policy
 * that already denies writes; and this session's own prompt (`prompt.ts`) never asks
 * the model to explore, read files, or use any tool — it asks for one JSON reply
 * about a candidate table already IN the prompt. `repos` existing is a real, verified
 * improvement over the prior bug (`process.cwd()`, which was guaranteed not to exist
 * at all); whether it is also sufficient on its own is the part left open here.
 */
const DEFAULT_WORKTREE = join(dataDir(), "repos");

/** The id every bootstrap-caller tier carries, whichever model it ends up naming. */
export const BOOTSTRAP_CALLER_ID = "ladder-setup";

/**
 * The model that makes the pick, chosen from the SAME live catalog it is about to hand
 * the picker — never a second hardcoded guess. Prefers `DEFAULT_TIERS[1]`'s own values
 * (`core/ladder.ts`), spread rather than re-typed so the two cannot silently drift apart,
 * but only when that model is actually IN the catalog: found by lore's own review,
 * fingerprint 9a97bb77 — a tool that exists to replace a stale hardcoded guess must not
 * share DEFAULT_TIERS' single point of failure with no way out when OpenRouter withdraws
 * it. Falls back to the cheapest priced candidate WITH ROOM FOR THE PROMPT IT WILL BE
 * ASKED — found by lore's own review, fingerprints db8dedc2/a9bed880: the first version
 * sorted by price alone, and the candidate table itself grows with the catalog (a few
 * hundred rows is tens of thousands of characters) — so on the exact day the fallback
 * exists for (the preferred model withdrawn), the cheapest candidate could easily be a
 * model whose own context window cannot hold the prompt asking it to choose, failing the
 * one path that has no larger tier to step to. `contextTokens` was already in hand.
 */
function pickCaller(catalog: readonly CatalogModel[], promptChars: number): Tier {
  // Doubled for headroom — the contract text, the reply itself, and whatever system
  // overhead opencode adds are all real but not measured here.
  const minContext = Math.ceil((promptChars / CHARS_PER_TOKEN) * 2);
  const fitsPrompt = (c: CatalogModel): boolean => c.contextTokens >= minContext;

  const preferred = DEFAULT_TIERS[1];
  if (preferred?.model !== undefined) {
    const p = catalog.find((c) => c.id === preferred.model);
    if (p !== undefined && fitsPrompt(p)) return { ...preferred, id: BOOTSTRAP_CALLER_ID };
  }

  const priced = catalog.filter((c) => c.costInput !== undefined && fitsPrompt(c)).sort((a, b) => (a.costInput ?? 0) - (b.costInput ?? 0));
  const fallback = priced[0] ?? [...catalog].filter(fitsPrompt).sort((a, b) => b.contextTokens - a.contextTokens)[0];
  if (fallback === undefined) {
    throw new DidNotRun(
      `no candidate model has enough context to hold its own prompt (~${String(minContext)} tokens estimated ` +
        `for ${String(catalog.length)} candidates) — every usable model's window is too small for this catalog.`,
    );
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

export async function suggestLadder(deps: LadderSetupDeps, worktree = DEFAULT_WORKTREE): Promise<LadderSetupResult> {
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

  const prompt = ladderPrompt(catalog);
  const caller = pickCaller(catalog, prompt.length + LADDER_CONTRACT.length);

  let result: SessionResult<TierPick>;
  try {
    result = await deps.ask(caller, prompt, worktree, extract, LADDER_CONTRACT);
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
