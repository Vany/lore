/**
 * What each tier is told.
 *
 * A tier's *position* is information (D-31). The same prompt everywhere makes the
 * expensive tier spend its budget re-deriving what the cheap one already
 * established — and Vany's framing was exact: don't bother it with stupid
 * mistakes, the code must be almost fixed. The ladder guarantees that; the prompt
 * has to say so, or the model does not know it.
 */

import { compareFindings } from "../core/finding.ts";
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
  /** Rendered contradictions the reviewer must settle, or "" (D-39). */
  readonly conflicts?: string;
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

/**
 * Extra instructions that only make sense for one review type.
 *
 * The security type is the one that needs it: scanners have already done the
 * *detection*, and asking a model to repeat that is paying for the wrong thing.
 * Its contribution is reachability — the judgement no rule can make.
 */
function typeGuidance(typeId: string): string {
  if (typeId !== "security") return "";
  return [
    "",
    "Your job is REACHABILITY, not detection. The scanners below have already found which vulnerable packages are",
    "present; that part is done and you must not re-report it. What only you can answer is whether the vulnerable",
    "code path can actually be reached from this application.",
    "",
    "For each candidate, decide and say which:",
    "  * the vulnerable function is never called from any code path this app executes",
    "  * it is called, but the inputs that reach it cannot take the exploitable form",
    "  * it is reachable and exploitable — say from where, concretely",
    "  * the package is not even bundled into what ships",
    "",
    "Most transitive vulnerabilities are NOT exploitable in a given application. Saying so, with the reason, is the",
    "valuable answer here — it is what a VEX statement records, and a review that marks everything exploitable is",
    "as useless as one that marks everything safe.",
    "",
    "Do not guess. If you cannot trace the call path, say that you could not, and why. 'Unexamined' is an honest",
    "answer; 'probably fine' is not.",
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
  // Ordered BEFORE truncating, and this was the last place it was not.
  //
  // The store now hands out findings worst-first, but this list is assembled from
  // verdicts rather than read from one of those queries, so it arrived in whatever
  // order the caller built it and then lost everything past the 80th. A cut list is
  // exactly where order decides what a reader never sees — and the reader here is a
  // model tier, which will re-raise a settled high-severity finding it was never
  // shown, and be told its justification was rejected.
  const ranked = [...settled].sort((a, b) => compareFindings(a.finding, b.finding));
  const dropped = Math.max(0, ranked.length - 80);
  const lines = ranked.slice(0, 80).map((s) => {
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
    // Truncation is stated, never silent. A reviewer that is shown 80 of 200 settled
    // findings and told nothing will treat the other 120 as never-raised.
    ...(dropped > 0
      ? [`  … and ${dropped} more already-settled findings, not listed here. Lowest severity first, so these are the least severe.`]
      : []),
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
    typeGuidance(i.type.id),
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
    i.conflicts ?? "",
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
