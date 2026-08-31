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
    "EVERY review, first. ESCALATION IS ON CLEAN, NOT ON FINDINGS — t1 raising something",
    "stops the round right there for a person to fix; t2 runs next only once t1 comes back",
    "with NOTHING wrong, which is the common case for maintained code, not a rare one. t3",
    "runs only once BOTH t1 and t2 come back clean — rarer than t2, but still the ordinary",
    "path for code that already passes the first two reads, and the last independent look",
    "before a review can fully pass.",
    "",
    "THE ONE RULE THAT MATTERS MOST: t1, t2 and t3 must come from THREE DIFFERENT",
    "underlying organisations (the \"vendor\" column below — z-ai, moonshotai, openai,",
    "anthropic, and so on) — never the route prefix, which is \"openrouter\" for all of",
    "them here. Two tiers from the same organisation are not two opinions; they are one",
    "opinion asked twice, and this tool's entire premise is that reviewers must be",
    "independent of each other. This is not a preference — a review run on a ladder that",
    "fails this can never fully pass, however good the individual models are. WATCH FOR",
    "NEAR-DUPLICATE VENDOR NAMES IN THE TABLE — the same real company sometimes publishes",
    "under two different prefixes (for example \"meta\" and \"meta-llama\" are almost",
    "certainly the same organisation despite reading as different vendor strings); use",
    "your own knowledge of who actually owns what, not just string equality, when judging",
    "whether two candidates are genuinely independent.",
    "",
    "Prefer models with a track record of following instructions precisely: reviews depend",
    "on structured JSON replies, and a model that drifts into prose loses the review, not",
    "just this one answer. Cost matters at all three tiers, since t2 and t3 run on most",
    "reviews of code that is already in good shape, not only the rare exceptional one — t1",
    "still deserves the most weight toward cheap and fast, since every review pays for it",
    "at least once, but do not treat t2/t3 as occasional splurges.",
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
  {"role": "t1", "model": "<copy an id column value from the candidates table above>", "effort": "medium", "why": "one sentence"},
  {"role": "t2", "model": "<a DIFFERENT candidate id, from a different vendor than t1>", "effort": "high", "why": "one sentence"},
  {"role": "t3", "model": "<a DIFFERENT candidate id again, from a third vendor>", "effort": "high", "why": "one sentence"}
]}
\`\`\`

The angle-bracketed text above is a PLACEHOLDER, not an example to copy — every "model"
value must be a real id you copied from the candidates table's own id column, for a
candidate that actually appeared in it. Nothing named in this contract itself is a
valid answer.

Rules:
- Exactly three entries, one each for "t1", "t2", "t3" — no more, no fewer.
- "model" must be copied EXACTLY from the id column of the candidates you were given —
  not the name column, not a route you remember from training, not a close guess.
- "effort" is one of "low", "medium", "high", "max".
- "why" is one sentence — it is shown to the operator, not stored in the config.
`.trim();
