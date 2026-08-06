/**
 * What each tier is told.
 *
 * A tier's *position* is information (D-31). The same prompt everywhere makes the
 * expensive tier spend its budget re-deriving what the cheap one already
 * established — and Vany's framing was exact: don't bother it with stupid
 * mistakes, the code must be almost fixed. The ladder guarantees that; the prompt
 * has to say so, or the model does not know it.
 */

import { CLAIM_MAX, compareFindings } from "../core/finding.ts";
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
  /**
   * Which round of this review is about to run, and how many each tier has already had.
   *
   * Absent means "not known", which renders as a first look — the old behaviour, and
   * correct for the CLI and for tests that do not model a ladder.
   *
   * This exists because the prompt was lying. `position()` keyed on the TIER alone, so
   * on round 11 of this repository's own review t1 was told *"You are the FIRST model
   * to see this change"* — having already read and cleared that tree four times, with
   * t2 and t3 clean behind it. Told it is first, a model behaves like it is first: it
   * re-audits, and on a tree whose only new material is the author's comments, what it
   * finds is comments. Five such re-reads cost 28 minutes and produced nothing.
   */
  readonly round?: number;
  readonly tierRounds?: Readonly<Record<string, number>>;
}

/**
 * THE BAR FOR REPORTING ANYTHING, stated before position and before the question.
 *
 * D-79. The prompts used to ask for volume — T1 was told "expect obvious defects,
 * report them plainly and cheaply, do not agonise" — and the output showed it: eleven
 * findings on one commit, every one correct and nearly all documentation drift, while
 * one semgrep rule was raised 63 times and justified away 63 times. MEMO session 30
 * named it a year earlier: the ladder converges on code and oscillates on prose.
 *
 * The schema was part of the cause. `failureScenario` is required, so a model writes
 * one for whatever it already decided to report, and a wording nit acquires a
 * plausible consequence on the way out. Here it is the TEST instead: if you cannot
 * state it, you do not have a finding.
 *
 * **The third test was added 2026-08-07, and it is the one that cost a whole review.**
 * t3 asked the question only the ticket makes possible — *"does this do what was
 * asked?"* — read the diff's own paragraph saying one half was deliberately not built,
 * CITED THAT PARAGRAPH AS ITS EVIDENCE, and raised the gap as a `medium` finding
 * anyway. The check ran and the model ignored its own answer.
 *
 * Cost, measured: nothing changed (the answer could only ever be a `lore-ok`), and the
 * reset it triggered consumed the last three rounds of the global budget. Without it
 * the trace ended `t3 clean → passed` at round 10; with it the review stopped at 13.
 * One finding, no defect, verdict destroyed.
 *
 * The question stays — a gap the author did NOT disclose is the finding of the night,
 * and a reviewer cannot know in advance which it is, so it must look. What changes is
 * what to do once it has looked: evidence that consists of the author saying "we did
 * not do this" is the disclosure WORKING, and repeating it back is not review.
 */
const BAR = [
  "WHAT COUNTS AS A FINDING",
  "",
  "You are looking for what the author MISSED and would be hurt by. Not everything true you could say about",
  "this diff — an author can read their own code. Two tests, and a finding must pass both:",
  "",
  "  1. CONSEQUENCE. Can you name concrete inputs or state, and the wrong outcome that follows? Write that",
  "     down first. If you cannot write it, you have an observation, not a finding, and you must not report it.",
  "     'This is inconsistent' or 'this could be clearer' is not a consequence. 'On a decline, the hold is",
  "     never released, so funds stay held until the 7-day sweeper' is.",
  "",
  "  2. MISSED. Would the author — who knows what they meant and has just re-read this — still not have seen",
  "     it? Not 'is it subtle': an off-by-one is obvious once pointed at and is still worth reporting. The",
  "     question is whether their own next pass would have caught it.",
  "",
  "A prose or spec finding clears the same bar. Documents are reviewable here and drift is a real defect — but",
  "say WHO is misled and INTO DOING WHAT. A sentence that is merely imprecise is not a finding; a sentence that",
  "would make a reader call an API that does not behave that way is.",
  "",
  "  3. NOT ALREADY SAID. If your evidence is the change ITSELF stating that something was not done — a spec",
  "     paragraph marking it open, a comment naming it as deferred, a TODO the diff adds — then the author did",
  "     not miss it, test 2 fails, and you must NOT report it. That is the disclosure working, and repeating it",
  "     back tells the author only what they wrote.",
  "     An UNDISCLOSED gap between the ticket and the code is the most valuable thing you can find, so keep",
  "     looking for one. A disclosed gap is a roadmap item: the only possible answer is 'yes, we know', and a",
  "     finding no diff can settle costs the author a cycle and returns nothing.",
  "     If the disclosure itself is wrong — the spec says 'not built' while a tool description promises it —",
  "     THAT is a finding, and a good one: name who is misled and into doing what.",
  "",
  "Reporting less is not being lenient. Every finding costs the author a fix cycle, and a review that spends",
  "them on observations is one they learn to skim — which is how the real one gets skimmed too.",
].join("\n");

/**
 * What is NEW since this tier last looked, when it has looked before.
 *
 * A re-read is a different job from a first look, and saying so is the whole point: the
 * tree was cleared, the author has answered, and the thing to judge is the answer. That
 * is not a licence to skim — the fix IS new code, and one of tonight's real findings
 * (a test that would have stayed green through a regression) came from exactly such a
 * re-read. It is a licence to stop re-auditing what this tier already passed.
 */
function reReadPosition(i: PromptInput, mine: number): string {
  const others = Object.entries(i.tierRounds ?? {})
    .filter(([id, n]) => id !== i.tier.id && n > 0)
    .map(([id, n]) => `${id}×${String(n)}`);
  return [
    `You have READ THIS BRANCH ${String(mine)} time(s) already in this review — this is round ${String(i.round ?? 0)}.` +
      (others.length === 0 ? "" : ` Other tiers have looked too: ${others.join(", ")}.`),
    "",
    "So this is NOT a first look, and you must not review it as one. What is new is the AUTHOR'S ANSWER to what",
    "was raised: a fix, or a justification. Judge that.",
    "",
    "  * Does the fix actually close the finding, or move it?",
    "  * Is the fix ITSELF sound? It is new code, written under time pressure, and nobody has reviewed it. This",
    "    is where the real defects in a late round live.",
    "  * Does a justification hold — against the code as it now stands, not against how reasonable it sounds?",
    "",
    "Do NOT re-audit what you already passed. You cleared this tree; re-reading it for something you did not",
    "report the first time is how a review turns into an argument about wording. If you genuinely find something",
    "you missed, report it — but it must clear the bar above, and 'I looked again' is not new evidence.",
  ].join("\n");
}

/** Where this tier stands, and therefore what is left for it to find. */
function position(i: PromptInput): string {
  const mine = i.tierRounds?.[i.tier.id] ?? 0;
  if (mine > 0) return reReadPosition(i, mine);
  if (i.tierIndex === 0) {
    return [
      "You are the FIRST model to see this change. Deterministic tooling has already run.",
      "The defects still here are the ones a typechecker cannot see. Look for those, and hold each one to the",
      "bar above — being first is not a licence to report more, it is the chance to catch what is plainly wrong",
      "before anyone spends a dearer tier on it.",
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

/**
 * How much of this diff is prose, so a finding about prose can be priced against it.
 *
 * Counted from the added lines only: a round that adds 170 comment lines and 20 code
 * lines is a round about comments, whatever the deletions say.
 *
 * The point is NOT to suppress documentation findings. Specs are reviewable here (D-11)
 * and drift is this repository's most common real defect — the first pass over this
 * very change found five instances of it. The point is that a reviewer looking at a
 * diff which is almost entirely prose will find prose, and unless it is told what it is
 * looking at it cannot tell "the author rewrote a comment" from "the author changed the
 * system". Measured on this repository's own review: the first pass found 8 defects and
 * 0 drift; the passes over the fixes found 1 defect and 8 drift.
 */
export function proseShare(diff: string): { readonly added: number; readonly prose: number } {
  let added = 0;
  let prose = 0;
  let inProseFile = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      // `+++ b/spec/foo.md` — the file the following `+` lines belong to.
      inProseFile = /\.(md|markdown|txt|rst)\s*$/i.test(line);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("diff ") || !line.startsWith("+")) continue;
    added++;
    const body = line.slice(1).trim();
    // Blank lines are neither, and counting them as code would understate every prose
    // diff — markdown is half blank lines.
    if (body === "") {
      added--;
      continue;
    }
    if (inProseFile || /^(\/\/|\/\*|\*|#|--)/.test(body)) prose++;
  }
  return { added, prose };
}

/** Told to the model only when the diff is overwhelmingly prose, so it stays rare enough to read. */
function compositionBlock(diff: string): string {
  const { added, prose } = proseShare(diff);
  if (added < 20 || prose * 4 < added * 3) return "";
  return [
    "",
    "WHAT THIS CHANGE IS MADE OF",
    `Of ${String(added)} added lines, ${String(prose)} are comments or documentation. This is a change ABOUT`,
    "prose, so the easy thing to find here is prose — and most of it will be the author saying the same thing a",
    "different way.",
    "",
    "A documentation finding still counts, and drift is a real defect. But in a diff like this one it must name",
    "a READER and what they would DO wrongly — a client that would call an API that does not behave that way, a",
    "maintainer who would undo a guard. 'This sentence is now inconsistent with that one' is the finding this",
    "shape of diff generates endlessly, and answering it writes more prose for the next round to fault.",
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
    // The client is TOLD this happens (TOOL_DOCS.submit), so it has to actually
    // happen. Nothing in the code raises a severity: the fingerprint deliberately
    // excludes severity so the same finding is recognised across the change, and the
    // raising itself was left to a reviewer nobody had asked. A promise the system
    // does not keep is worth less than no promise.
    "When you re-raise something whose justification you are rejecting, raise its SEVERITY above what it was.",
    "A defect that was argued away and is still there is worse than one nobody has looked at, because the",
    "argument was believed. Keep the claim wording otherwise identical, so it is recognised as the same finding.",
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
    "The author asked for this review and will read what you say. Be adversarial about the CODE and plain with",
    "them: default to suspicion, because an author's own tests confirm the design they already had in mind and",
    "only an independent reader finds its blind spots.",
    "",
    "Each finding is a question you are putting to them: here is what I found, fix it or tell me why it is not a",
    "problem. Both are real answers. They may be right and you may be wrong — say what you saw and why it worries",
    "you, not what they must do.",
    "",
    BAR,
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
    compositionBlock(i.diff),
    "",
    "DETERMINISTIC RESULTS",
    i.t0,
    "",
    i.diff,
    "",
    "Before you report anything, re-read the bar: consequence you can state, and something the author would",
    "still have missed. Drop what does not clear it — that is the job, not a failure to do the job.",
    "Say plainly if it is clean. `\"findings\": []` is a real answer and often the right one; a review that",
    "invents work costs the author a whole fix cycle and teaches them to skim the next one.",
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
    "claim": "one sentence, max ${CLAIM_MAX} characters",
    "evidence": "where the proof is, with file:line",
    "failureScenario": "concrete inputs or state, then the wrong outcome",
    "cwe": "CWE-459"
  }
]}
\`\`\`

Rules:
- "findings": [] means clean. That is a valid and welcome answer, and often the right one.
- "failureScenario" IS THE TEST, not a field to fill. Write it before you decide to report: concrete inputs
  or state, then the wrong outcome. If it comes out as "a reader might be confused" or "this is
  inconsistent", you do not have a finding — drop it. Findings dropped this way are the review working.
- "claim" is what you would say to the author's face: what you found, not what they must do. They may
  answer that it is not a problem, and that is a legitimate answer you may be wrong about.
- severity is exactly one of: high, medium, low.
- "symbol" is the enclosing function or class. Include it whenever you can: it is what keeps a finding's
  identity stable when line numbers shift, and without it your finding may be mistaken for a different one.
- "cwe" only when the finding genuinely is that weakness class. Omit it otherwise.
- Every field except "line", "symbol" and "cwe" is required. For those three, omit the
  key or send null — both mean "does not apply" and neither is an error.
- No other keys. Extra keys are rejected and the review is re-run.
`.trim();
