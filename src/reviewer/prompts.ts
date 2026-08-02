/**
 * What each tier is told.
 *
 * A tier's *position* is information (D-31). The same prompt everywhere makes the
 * expensive tier spend its budget re-deriving what the cheap one already
 * established — and Vany's framing was exact: don't bother it with stupid
 * mistakes, the code must be almost fixed. The ladder guarantees that; the prompt
 * has to say so, or the model does not know it.
 */

import type { Tier } from "../core/ladder.ts";
import type { ReviewType } from "../core/review-type.ts";
import type { KnowledgeItem, RecordedFinding } from "../store/store.ts";

export interface PromptInput {
  readonly tier: Tier;
  readonly tierIndex: number;
  readonly modelTierCount: number;
  readonly type: ReviewType;
  readonly worktree: string;
  readonly branch: string;
  readonly ticket: string;
  readonly diff: string;
  readonly t0: string;
  readonly knowledge: readonly KnowledgeItem[];
  /** Findings already settled, with the reasons. Re-raise only with new evidence. */
  readonly settled: readonly { finding: RecordedFinding; rationale: string | undefined }[];
}

/** Where this tier stands, and therefore what is left for it to find. */
function position(i: PromptInput): string {
  if (i.tierIndex === 0) {
    return [
      "You are the FIRST model to see this change. Deterministic tooling has already run.",
      "Expect obvious defects. Report them plainly and cheaply; do not agonise.",
    ].join("\n");
  }
  if (i.tierIndex === i.modelTierCount - 1) {
    return [
      `You are the LAST line. ${i.tierIndex} independent reviewers, from different vendors, found nothing left,`,
      "and deterministic tooling is clean. The code is close to correct.",
      "",
      "So do NOT re-report style, formatting, or anything a typechecker or linter would catch — that work is done,",
      "and repeating it wastes the one review nobody else can do.",
      "",
      "What remains is what a careful reader misses: a lifecycle or shutdown claim no test exercises; a race that",
      "needs two things to happen at once; an error path that leaves state behind; a test that would pass without",
      "its fix; a fake kinder than production; absence asserted with toEqual, which ignores undefined-valued",
      "properties, where toStrictEqual is the one that means it.",
    ].join("\n");
  }
  return [
    `You are reviewer ${i.tierIndex + 1} of ${i.modelTierCount}. Cheaper tiers and deterministic tooling found nothing new.`,
    "The easy defects are gone. Look at design, seams, and what the tests claim but do not exercise.",
  ].join("\n");
}

function knowledgeBlock(items: readonly KnowledgeItem[]): string {
  if (items.length === 0) return "";
  const lines = items.slice(0, 60).map((k) => {
    const why = k.why === undefined ? "" : ` — because ${k.why}`;
    return `  [${k.source}] ${k.statement}${why}`;
  });
  return [
    "",
    "WHAT THIS CODEBASE ALREADY KNOWS ABOUT ITSELF",
    "Taught rules outrank inferred ones. Treat these as this team's decisions, not suggestions.",
    ...lines,
  ].join("\n");
}

function settledBlock(settled: PromptInput["settled"]): string {
  if (settled.length === 0) return "";
  const lines = settled.slice(0, 80).map((s) => {
    const where = `${s.finding.file}${s.finding.line !== undefined ? `:${s.finding.line}` : ""}`;
    const why = s.rationale === undefined ? "fixed" : `justified: ${s.rationale}`;
    return `  ${where} — ${s.finding.claim}\n      → ${why}`;
  });
  return [
    "",
    "ALREADY CONSIDERED AND RESOLVED",
    "These were raised and settled, with reasons. Re-raise one ONLY with new evidence that the reason is wrong.",
    "If you can show a recorded reason is wrong, say so explicitly — a mistaken justification matters more than a",
    "fresh bug, because it means someone's reasoning was wrong and was trusted.",
    ...lines,
  ].join("\n");
}

export function reviewPrompt(i: PromptInput): string {
  return [
    `You are an independent reviewer of branch ${i.branch}. You did not write this code.`,
    "Be adversarial: your job is to find what is WRONG, not to summarise. Default to suspicion — an author's own",
    "tests confirm the design they had in mind, and only an independent reader finds its blind spots.",
    "",
    position(i),
    "",
    `THE QUESTION: ${i.type.question}`,
    "",
    "FIRST: cd into the worktree and confirm with `pwd`. Your default directory is NOT the branch under review.",
    `    ${i.worktree}`,
    "",
    "Read the surrounding files, not just the diff — a diff alone hides the seam. Read the project's README,",
    "CLAUDE.md / AGENTS.md, and any specs or ADRs that bear on this change.",
    "",
    "THE TASK THIS CHANGE IMPLEMENTS",
    "Judge the change against this, not against what the code appears to be trying to do:",
    "  - does it do what was asked?",
    "  - does it do LESS than was asked — a requirement with no corresponding code?",
    "  - does it do MORE than was asked? Unrequested refactors, renames and 'improvements' are code nobody",
    "    decided to write and no ticket justifies. Flag them; they are not automatically wrong, but they must",
    "    be noticed.",
    "",
    indent(i.ticket),
    knowledgeBlock(i.knowledge),
    settledBlock(i.settled),
    "",
    "DETERMINISTIC RESULTS",
    i.t0,
    "",
    i.diff,
    "",
    "Report concrete findings only: what is wrong, the evidence (file:line), and the failure scenario.",
    "Say plainly if it is clean — do NOT manufacture findings. A review that invents work costs a whole fix cycle.",
  ].join("\n");
}

function indent(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/**
 * The output contract, appended verbatim.
 *
 * Kept separate from the review instructions so it can be restated on a retry
 * without re-sending the whole prompt — the retry exists because an unparseable
 * review is a failed review, not a clean one.
 */
export const OUTPUT_CONTRACT = `
Reply with ONE fenced json block and nothing else. No preamble, no commentary after it.

\`\`\`json
{"findings": [
  {
    "file": "src/pay/hold.ts",
    "line": 142,
    "symbol": "capturePayment",
    "severity": "high",
    "claim": "one sentence, max 300 characters",
    "evidence": "where the proof is, with file:line",
    "failureScenario": "concrete inputs or state, then the wrong outcome",
    "cwe": "CWE-459"
  }
]}
\`\`\`

Rules:
- "findings": [] means clean. That is a valid and welcome answer.
- severity is exactly one of: high, medium, low.
- "symbol" is the enclosing function or class. Include it whenever you can: it is what keeps a finding's
  identity stable when line numbers shift, and without it your finding may be mistaken for a different one.
- "cwe" only when the finding genuinely is that weakness class. Omit it otherwise.
- Every field except "line", "symbol" and "cwe" is required.
- No other keys. Extra keys are rejected and the review is re-run.
`.trim();
