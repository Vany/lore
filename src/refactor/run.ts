/**
 * The run: every tier marked `refactor: true`, in parallel, then t1 merges what came
 * back (D-136).
 *
 * Separate from review on purpose — nothing here gates a merge, produces a finding, or
 * reaches an attestation. It spends real quota (one session per fan-out tier, plus one
 * for the merge) doing something closer to `propose`'s job than review's: asking models
 * what they would change, for a person or an agent to read afterwards. Unlike `propose`,
 * this is a fixed shape — named tiers, run concurrently, merged by a specific tier —
 * not an open loop over lenses with a per-idea critic.
 *
 * SPEC: spec/refactor.md
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tier } from "../core/ladder.ts";
import { DidNotRun } from "../core/errors.ts";
import type { Listed, SessionResult } from "../reviewer/opencode.ts";
import { extractList } from "../reviewer/opencode.ts";
import type { Store } from "../store/store.ts";
import { combinePrompt, suggestPrompt, SUGGESTION_CONTRACT } from "./prompt.ts";
import { parseSuggestion, type RefactorSuggestion } from "./suggestion.ts";

/** Suggestions in the shape a session returns them. */
const suggestionsOf = (text: string): Listed<RefactorSuggestion> =>
  extractList<RefactorSuggestion>(text, "suggestions", (raw) => parseSuggestion(raw));

export interface RefactorDeps {
  readonly store: Store;
  readonly repoId: string;
  /** Same gate, same retry, same abort — `Reviewer.askFor`, exactly as `propose` uses it. */
  readonly ask: <T>(
    tier: Tier,
    prompt: string,
    worktree: string,
    extract: (text: string) => Listed<T>,
    contract: string,
  ) => Promise<SessionResult<T>>;
}

export interface RefactorInput {
  /**
   * The row this run belongs to — used only to call `store.touchRefactorRun` as each
   * fan-out tier completes (D-139), so the board's stall clock has real movement to
   * read during a long fan-out instead of sitting frozen between the worktree cut and
   * the terminal write. Nothing else here reads or writes the row by id; that is
   * `RefactorWorker.execute`'s job.
   */
  readonly runId: string;
  readonly folder: string;
  /** The resolved SHA, never the ref — a stored run has to be reconstructable. */
  readonly commit: string;
  readonly worktree: string;
  /** The full configured ladder. Filtered here for `refactor: true`, and for `t1`. */
  readonly tiers: readonly Tier[];
}

/** What one fan-out tier produced, whatever it was. */
export interface RefactorSource {
  readonly tier: string;
  readonly suggestions: readonly RefactorSuggestion[];
  readonly ok: boolean;
  /** Set when `ok` is false — a tier that could not run is reported, never silently absent. */
  readonly error?: string;
}

export interface RefactorRunResult {
  /** The final list — merged by t1 when that succeeded, the raw union otherwise. */
  readonly suggestions: readonly RefactorSuggestion[];
  /** Every fan-out tier's own answer, successes and failures together. */
  readonly sources: readonly RefactorSource[];
  readonly combined: boolean;
  /** Set when `combined` is false, explaining why `suggestions` is the uncombined union. */
  readonly combinerNote?: string;
}

/**
 * A failed call is still a paid one — record what it burned before it died. Mirrors
 * `propose/run.ts`'s `recordFailedUsage` exactly, one door down: `Reviewer.askFor`
 * recovers spend from a session that fails mid-exploration and attaches it to the thrown
 * error as `.spent`.
 */
function recordFailedUsage(store: Store, repoId: string, tier: string, model: string | undefined, e: unknown): void {
  const spent = (e as { spent?: { input: number; cached: number; output: number; cost: number } }).spent;
  if (spent === undefined) return;
  store.recordUsage({
    repoId,
    tier,
    ...(model === undefined ? {} : { model }),
    inputTokens: spent.input,
    cachedTokens: spent.cached,
    outputTokens: spent.output,
    costUsd: spent.cost,
    outcome: "failed",
  });
}

async function askOneTier(deps: RefactorDeps, tier: Tier, input: RefactorInput): Promise<RefactorSource> {
  try {
    const r = await deps.ask(
      tier,
      suggestPrompt({ folder: input.folder, commit: input.commit, worktree: input.worktree }),
      input.worktree,
      suggestionsOf,
      SUGGESTION_CONTRACT,
    );
    deps.store.recordUsage({
      repoId: deps.repoId,
      tier: `refactor:${tier.id}`,
      ...(tier.model === undefined ? {} : { model: tier.model }),
      inputTokens: r.inputTokens,
      cachedTokens: r.cachedTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      ...(r.steps === undefined ? {} : { steps: r.steps }),
      outcome: r.items.length > 0 ? "findings" : "clean",
    });
    // D-139, fingerprint fe6d4318: a tier finishing IS movement, whether it succeeded
    // or not — see touchRefactorRun's own doc comment for the incident this answers.
    deps.store.touchRefactorRun(input.runId);
    return { tier: tier.id, suggestions: r.items, ok: true };
  } catch (e) {
    recordFailedUsage(deps.store, deps.repoId, `refactor:${tier.id}`, tier.model, e);
    deps.store.touchRefactorRun(input.runId);
    return { tier: tier.id, suggestions: [], ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function suggestRefactors(deps: RefactorDeps, input: RefactorInput): Promise<RefactorRunResult> {
  // lore-ok[6253e066]: found by lore's own review, against `refactor_start`'s own
  // door checks — the escape check runs there (no worktree exists yet to check
  // against), but a folder that stays inside the tree and still does not EXIST is
  // only knowable here, mirroring `propose/run.ts`'s own guard against exactly this:
  // "the whole budget burns on lenses that produce ideas nobody will ever see."
  if (input.folder !== "" && input.folder !== ".") {
    const folderPath = join(input.worktree, input.folder);
    if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
      throw new DidNotRun(`folder "${input.folder}" does not exist at commit ${input.commit} — check the spelling.`);
    }
  }

  const fanOut = input.tiers.filter((t) => t.kind === "model" && t.model !== undefined && t.refactor === true);
  if (fanOut.length === 0) {
    throw new DidNotRun('no tier is configured for refactor suggestions — LORE_TIERS needs "refactor": true on at least one model tier');
  }

  // Every `askOneTier` call catches its own failure and returns a `RefactorSource`
  // rather than throwing, so one tier's failure never sinks another's paid-for answer
  // (this project's own INV-1 doctrine, applied here exactly as `propose`'s
  // `uncriticised` and review's `checks_skipped` apply it elsewhere) — `Promise.all` is
  // therefore already as resilient as `allSettled` would be, with less to unwrap.
  const sources = await Promise.all(fanOut.map((tier) => askOneTier(deps, tier, input)));

  const succeeded = sources.filter((s) => s.ok);
  if (succeeded.length === 0) {
    throw new DidNotRun(`every tier failed: ${sources.map((s) => `${s.tier}: ${s.error ?? "unknown"}`).join("; ")}`);
  }

  const raw = succeeded.flatMap((s) => s.suggestions);
  // Both looked and had nothing to say — an honest, complete answer. Asking t1 to merge
  // an empty set into another empty one would spend a session to restate silence.
  if (raw.length === 0) return { suggestions: [], sources, combined: true };

  const combiner = input.tiers.find((t) => t.id === "t1" && t.kind === "model" && t.model !== undefined);
  if (combiner === undefined) {
    return {
      suggestions: raw,
      sources,
      combined: false,
      combinerNote: "no usable t1 tier is configured to combine — showing the uncombined sets",
    };
  }

  try {
    const c = await deps.ask(
      combiner,
      combinePrompt({ folder: input.folder, sets: succeeded.map((s) => ({ tier: s.tier, suggestions: s.suggestions })) }),
      input.worktree,
      suggestionsOf,
      SUGGESTION_CONTRACT,
    );
    deps.store.recordUsage({
      repoId: deps.repoId,
      tier: "refactor-combine:t1",
      ...(combiner.model === undefined ? {} : { model: combiner.model }),
      inputTokens: c.inputTokens,
      cachedTokens: c.cachedTokens,
      outputTokens: c.outputTokens,
      costUsd: c.costUsd,
      latencyMs: c.latencyMs,
      ...(c.steps === undefined ? {} : { steps: c.steps }),
      outcome: c.items.length > 0 ? "findings" : "clean",
    });
    deps.store.touchRefactorRun(input.runId);
    // The prompt explicitly forbids dropping a suggestion to zero unless the input
    // already was zero (handled above) — an empty reply here means t1 did not follow
    // the merge instruction, not that it looked and rejected everything, so this reports
    // as uncombined rather than as a legitimate empty answer.
    if (c.items.length === 0) {
      return {
        suggestions: raw,
        sources,
        combined: false,
        combinerNote:
          c.rejected.length > 0
            ? `t1 replied, but nothing parsed — ${c.rejected.join("; ")} — showing the uncombined sets`
            : "t1 returned no merged suggestions from a non-empty input — showing the uncombined sets",
      };
    }
    return { suggestions: c.items, sources, combined: true };
  } catch (e) {
    recordFailedUsage(deps.store, deps.repoId, "refactor-combine:t1", combiner.model, e);
    deps.store.touchRefactorRun(input.runId);
    return {
      suggestions: raw,
      sources,
      combined: false,
      combinerNote: `t1 failed to combine: ${e instanceof Error ? e.message : String(e)} — showing the uncombined sets`,
    };
  }
}
