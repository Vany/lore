/**
 * What the bootstrap-caller model is told, and the contract its reply must match.
 *
 * One job: pick t1/t2/t3 from a catalog it did not choose and cannot invent from — the
 * candidates are listed explicitly, and `suggestion.ts` rejects any reply that names a
 * model outside them, so a hallucinated id is caught before it ever reaches a file.
 *
 * SPEC: spec/review-ladder.md
 */

import type { CatalogModel } from "./catalog.ts";

/** Per-token to per-million-token, for a number a reader can actually eyeball. */
function perMillion(cost: number | undefined): string {
  return cost === undefined ? "?" : (cost * 1_000_000).toFixed(2);
}

function catalogTable(catalog: readonly CatalogModel[]): string {
  const rows = catalog.map(
    (m) => `${m.id}\t${m.vendor}\t${perMillion(m.costInput)}\t${perMillion(m.costOutput)}\t${String(m.contextTokens)}`,
  );
  return ["id\tvendor\tinput $/1M\toutput $/1M\tcontext tokens", ...rows].join("\n");
}

export function ladderPrompt(catalog: readonly CatalogModel[]): string {
  return [
    "You are picking the model ladder for an independent code-review tool, for a deployment",
    "that has ONLY an OpenRouter credential — no direct subscription to any single vendor.",
    "",
    "THE LADDER: t0 is deterministic (lint/typecheck/tests, not your concern). t1 runs on",
    "EVERY review, first — cheap and fast is what matters most here, since it carries the",
    "bulk of the volume. t2 and t3 run only when t1 finds something, reading more deeply;",
    "t3 is the last line of defence, so pick the strongest of the three for it.",
    "",
    "THE ONE RULE THAT MATTERS MOST: t1, t2 and t3 must come from THREE DIFFERENT",
    "underlying organisations (the \"vendor\" column below — z-ai, moonshotai, openai,",
    "anthropic, and so on) — never the route prefix, which is \"openrouter\" for all of",
    "them here. Two tiers from the same organisation are not two opinions; they are one",
    "opinion asked twice, and this tool's entire premise is that reviewers must be",
    "independent of each other. This is not a preference — a review run on a ladder that",
    "fails this can never fully pass, however good the individual models are.",
    "",
    "Prefer models with a track record of following instructions precisely: reviews depend",
    "on structured JSON replies, and a model that drifts into prose loses the review, not",
    "just this one answer. Prefer lower cost at t1 (it runs constantly) and prioritise",
    "capability over cost at t2 and t3 (they run rarely, only when there is already",
    "something worth a second look).",
    "",
    "THE CANDIDATES — every model this deployment's OpenRouter key can actually reach,",
    "tool-call-capable, not deprecated or alpha. Pick ONLY from this list; a model id not",
    "in it will be refused.",
    "",
    catalogTable(catalog),
  ].join("\n");
}

export const LADDER_CONTRACT = `
Reply with ONE fenced json block and nothing else. No preamble, no commentary after it.

\`\`\`json
{"tiers": [
  {"role": "t1", "model": "openrouter/z-ai/glm-5.2", "effort": "medium", "why": "cheap, fast, follows the finding contract reliably"},
  {"role": "t2", "model": "openrouter/moonshotai/kimi-k3", "effort": "high", "why": "a genuinely different organisation from t1 and t3"},
  {"role": "t3", "model": "openrouter/openai/gpt-5.6-sol-pro", "effort": "high", "why": "strongest available, last line of defence"}
]}
\`\`\`

Rules:
- Exactly three entries, one each for "t1", "t2", "t3" — no more, no fewer.
- "model" must be copied EXACTLY from the id column of the candidates you were given —
  not the name column, not a route you remember from training, not a close guess.
- "effort" is one of "low", "medium", "high", "max".
- "why" is one sentence — it is shown to the operator, not stored in the config.
`.trim();
