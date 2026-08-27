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
  /**
   * How many model tiers ACTUALLY READ this tree before me, and how many will in all.
   *
   * Both count tiers that can run, not positions in the configured ladder. When a tier
   * is skipped — unpayable, or dead after its retries (D-48) — the ladder promotes its
   * work to the next one, and the promoted tier used to be told "cheaper tiers and
   * deterministic tooling found nothing new" about a tier that never looked. Worse for
   * the last one: "2 independent reviewers, from different vendors, found nothing left"
   * when one of the two was skipped.
   *
   * That is not a cosmetic inaccuracy. The whole purpose of telling a tier where it
   * stands (D-31/32) is to stop it re-deriving what the tiers below established — so a
   * tier told the easy defects are gone, when nobody looked for them, deliberately
   * looks past exactly the defects nobody has looked for.
   */
  readonly tierIndex: number;
  readonly modelTierCount: number;
  /**
   * The rung-mates reading BESIDE this tier, by id (D-109). Absent or empty for every
   * tier that runs alone — which was every tier before rungs existed.
   *
   * Load-bearing for the same reason `tierIndex` is: the last-line narration counted
   * every reviewer below it as finished, and a rung-mate is below by index while still
   * mid-read. Telling t3 "your co-reviewers found nothing left" about a t2 that is
   * three files into the same tree is the D-31 lie in a new costume — and a model told
   * the ground is covered deliberately looks past what its peer is about to raise.
   */
  readonly peers?: readonly string[];
  readonly type: ReviewType;
  readonly worktree: string;
  readonly branch: string;
  readonly ticket: string;
  readonly diff: string;
  readonly t0: string;
  readonly knowledge: readonly KnowledgeItem[];
  /** How many development rules exist — INDICATED, never listed. See `policyBlock`. */
  readonly policyCount?: number;
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
  /**
   * Set only for a folder review (D-130), matching `ReviewDiff.scopePath`.
   *
   * Found by lore's own review of D-130: this wrapper's own "THE TASK THIS CHANGE
   * IMPLEMENTS" section — "does it do MORE than was asked? Unrequested refactors...
   * Flag them" — is written for an incremental change and directly contradicts
   * `renderFolderDiff`'s own header ("judge it as the code that exists, not as a
   * change someone just made") that it wraps. In folder mode every line in the path
   * is code nobody "just wrote", so that instruction would have a compliant tier
   * flagging a stable module's whole contents as unrequested scope creep.
   */
  readonly scopePath?: string | undefined;
}

/**
 * THE BAR FOR REPORTING ANYTHING, stated before position and before the question.
 *
 * D-79. The prompts used to ask for volume — T1 was told "expect obvious defects,
 * report them plainly and cheaply, do not agonise" — and the output showed it: eleven
 * findings on one commit, every one correct and nearly all documentation drift, while
 * one semgrep rule was raised 63 times and justified away 63 times.
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
  const peers = i.peers ?? [];
  // Rung-mates are BESIDE this tier, not below it (D-109): they read the same tree
  // right now, so they are subtracted from "reviewers who found nothing left" and named
  // instead — with the one instruction that makes parallel reading pay for itself.
  const together =
    peers.length === 0
      ? []
      : [
          "",
          `You are reading TOGETHER with ${peers.join(", ")} — another reviewer, on this same tree, right now.`,
          "What it raises will reach you as you read: do not re-derive or re-report it, and do not treat its",
          "silence as clearance. Your value is what it misses.",
        ];
  if (i.tierIndex === i.modelTierCount - 1) {
    const below = Math.max(0, i.tierIndex - peers.length);
    return [
      `You are the LAST line. ${below} independent reviewer${below === 1 ? "" : "s"}, from different vendors, found nothing left,`,
      "and deterministic tooling is clean. The code is close to correct.",
      "",
      "So do NOT re-report style, formatting, or anything a typechecker or linter would catch — that work is done,",
      "and repeating it wastes the one review nobody else can do.",
      "",
      "What remains is what a careful reader misses: a lifecycle or shutdown claim no test exercises; a race that",
      "needs two things to happen at once; an error path that leaves state behind; a test that would pass without",
      "its fix; a fake kinder than production; absence asserted with toEqual, which ignores undefined-valued",
      "properties, where toStrictEqual is the one that means it.",
      ...together,
    ].join("\n");
  }
  return [
    `You are reviewer ${i.tierIndex + 1} of ${i.modelTierCount}. Cheaper tiers and deterministic tooling found nothing new.`,
    "The easy defects are gone. Look at design, seams, and what the tests claim but do not exercise.",
    ...together,
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
 * What to judge the code against — a task it changed, or a task it is meant to serve
 * while sitting still (D-130). Found by lore's own review of D-130: the change-shaped
 * version of this ("does it do MORE than was asked? ... Flag unrequested refactors")
 * directly contradicts `renderFolderDiff`'s own "judge it as the code that exists, not
 * as a change someone just made" — a compliant tier reading both would flag a stable
 * module's entire pre-existing contents as unrequested scope creep.
 */
function taskFraming(scopePath: string | undefined): string {
  if (scopePath === undefined) {
    return [
      "THE TASK THIS CHANGE IMPLEMENTS",
      "Judge the change against this, not against what the code appears to be trying to do:",
      "  - does it do what was asked?",
      "  - does it do LESS than was asked — a requirement with no corresponding code?",
      "  - does it do MORE than was asked? Unrequested refactors, renames and 'improvements' are code nobody",
      "    decided to write and no ticket justifies. Flag them; they are not automatically wrong, but they must",
      "    be noticed.",
    ].join("\n");
  }
  return [
    "WHAT THIS PATH IS FOR",
    "This is a full read of existing code, not a change — judge it against what it is meant to do, not against",
    "what someone just wrote:",
    "  - does it do what the ticket says it should?",
    "  - is anything the ticket describes missing, or done differently than described?",
    "Do NOT flag code here for being 'unrequested' or for doing 'more than was asked' — almost none of what you",
    "are reading was written for this ticket, and treating a stable module's own contents as scope creep is not",
    "review, it is noise.",
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

/**
 * Told to the model only when the diff is overwhelmingly prose, so it stays rare
 * enough to read.
 *
 * Branches on `scopePath` for the same reason `taskFraming` does (D-130): a folder
 * review's "diff" is every line in the path shown as added, not an incremental
 * change, so "this is a CHANGE about prose... the author saying the same thing a
 * different way" would describe a stable docs folder as if someone had just
 * reworded it. `taskFraming` got this branch inside the D-130 commit itself; this
 * sibling function has the identical shape of prose-framing text but was not
 * touched then — found later, auditing every client-facing text for D-130 gaps.
 */
function compositionBlock(diff: string, scopePath: string | undefined): string {
  const { added, prose } = proseShare(diff);
  if (added < 20 || prose * 4 < added * 3) return "";
  if (scopePath !== undefined) {
    return [
      "",
      "WHAT THIS PATH IS MADE OF",
      `Of ${String(added)} lines, ${String(prose)} are comments or documentation — mostly prose, not code.`,
      "",
      "A documentation finding still counts, and drift is a real defect. But it must name a READER and what",
      "they would DO wrongly — a client that would call an API that does not behave that way, a maintainer who",
      "would undo a guard. 'This sentence is inconsistent with that one' is the finding this shape of read",
      "generates endlessly, and answering it writes more prose for the next round to fault.",
    ].join("\n");
  }
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

/**
 * That this project HAS development rules, without saying what they are (D-83).
 *
 * Sixty rules already occupy space the diff wants, and a policy says nothing a reviewer
 * needs until somebody cites one — so this is a standing, not a list. What it buys is
 * that an appeal arrives as an argument the tier knows how to weigh, rather than as a
 * client asserting something about a document the reviewer has never heard of.
 */
function policyBlock(count: number): string {
  if (count === 0) return "";
  return [
    "",
    `THIS PROJECT HAS ${String(count)} DEVELOPMENT RULE(S) — decisions about what it does and does not enforce.`,
    "They are NOT listed here, deliberately; you do not need them unless one is cited at you.",
    "When a lore-ok APPEALS TO one, the rule's full text is quoted with it. Treat that as this team's stated",
    "policy rather than the author's opinion — and still rule on it: does the rule actually cover this code?",
    "Accept by not raising the finding again. Reject by raising it, and say why the rule does not reach this case.",
  ].join("\n");
}

function knowledgeBlock(items: readonly KnowledgeItem[]): string {
  if (items.length === 0) return "";
  const line = (k: KnowledgeItem): string => {
    const why = k.why === undefined ? "" : ` — because ${k.why}`;
    return `  [${k.source}] ${k.statement}${why}`;
  };

  // lore-ok[cc3354a7]: THE CUT HAPPENS HERE, AND IS SAID HERE. `items` arrives from
  // `relevantTo` (knowledge/enrich.ts) ranked best-first — taught outranks inferred,
  // then confidence, then recency — and unsliced; this used to be sliced inside
  // `relevantTo` itself with nothing said about it, which is the same silent-truncation
  // shape `settledBlock` below already guards against for findings. This is the one
  // place that knows both the cap and that a reader is about to receive the result, so
  // the notice belongs here, in the same words `settledBlock` uses for the same reason.
  const KNOWLEDGE_CAP = 60;
  const dropped = Math.max(0, items.length - KNOWLEDGE_CAP);
  const shown = items.slice(0, KNOWLEDGE_CAP);

  // lore-ok[70b88761]: `kind: "fact"` is written in exactly one place — bootstrap's
  // architecture survey, a model's ONE-TIME reading of whichever branch happened to
  // be a repo's first review, unconfirmed by anything (confidence 0.5, the lowest in
  // the store). Found by lore's own review: every item here used to get the SAME
  // "treat these as this team's decisions, not suggestions" framing, so a branch
  // could plant a plausible-but-false architecture comment and have the survey
  // launder it into what every future review trusts as settled. Vany's call: keep
  // the survey reading the branch (checking out `into` separately is a real new
  // operational cost; skipping the survey whenever `into` exists would silently
  // disable it for the common diff-mode case) and instead say plainly that a fact is
  // not a decision — proportionate to what a `fact` actually is: unlike a `policy` or
  // `rule`, nothing can CITE it in an appeal to excuse a finding (D-83); it is
  // background a reviewer weighs, not a directive.
  const facts = shown.filter((k) => k.kind === "fact");
  const rest = shown.filter((k) => k.kind !== "fact");

  const parts: string[] = [];
  if (rest.length > 0) {
    parts.push(
      "",
      "WHAT THIS CODEBASE ALREADY KNOWS ABOUT ITSELF",
      "Taught rules outrank inferred ones. Treat these as this team's decisions, not suggestions.",
      ...rest.map(line),
    );
  }
  if (facts.length > 0) {
    parts.push(
      "",
      "UNVERIFIED, FROM ONE BRANCH'S FIRST READING",
      "A model's own reading of this repository, taken once, on whichever branch got reviewed first — not a" +
        " team decision and not corroborated by anything since. Weigh it, do not treat it as settled, and say so" +
        " if a finding turns on one of these being true.",
      ...facts.map(line),
    );
  }
  if (dropped > 0) {
    parts.push(
      "",
      `  … and ${String(dropped)} more relevant item(s), not listed here. Ranked best-first — taught outranks` +
        " inferred, then confidence, then recency — so these are the ones least likely to matter.",
    );
  }
  return parts.join("\n");
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
    "These were raised and settled, with reasons. Re-raise one ONLY with new evidence that the reason is wrong —",
    "repeating the same claim is not new evidence.",
    "",
    // lore-ok[28198096]: SOFTENED, not wired up. Found by lore's own review: this used to
    // say "raise its SEVERITY above what it was" and call a mistaken justification more
    // important than a fresh bug — a promise nothing here keeps. `recordFinding` is `ON
    // CONFLICT(review_id, fingerprint) DO NOTHING`, and `step` (core/ladder.ts) treats any
    // re-raise of an already-settled fingerprint as clean BY DESIGN, to stop a review from
    // arguing forever — so keeping the claim wording identical, as the line below still
    // asks, makes an objection inert regardless of what severity the reply writes against
    // it: no verdict reopens, nothing reaches the client or the attestation. What DOES
    // work is the one path the fingerprint mechanism actually offers: state the objection
    // as its own claim, in your own words, describing what is still wrong and why the
    // recorded reason does not cover it. A claim that reads as a genuinely different
    // finding gets a genuinely different fingerprint, which is fresh, open, and real.
    "BE PLAIN IF YOU STILL DISAGREE — say so, and why. But say it as its OWN claim, in your own words: keeping the",
    "wording identical to the settled finding below only re-raises something already closed, which changes",
    "nothing here. A claim that actually describes what the justification gets wrong is a NEW finding.",
    "",
    "Keep the claim wording identical only when you mean the SAME defect and have nothing new to add about it —",
    "that is what tells the reviewer this is a repeat, not a fresh look.",
    ...lines,
    // Truncation is stated, never silent. A reviewer that is shown 80 of 200 settled
    // findings and told nothing will treat the other 120 as never-raised.
    ...(dropped > 0
      ? [`  … and ${dropped} more already-settled findings, not listed here. Lowest severity first, so these are the least severe.`]
      : []),
  ].join("\n");
}

/**
 * The next message to a tier that already holds this review (D-80).
 *
 * Everything the initial prompt spends its length on — who you are, the bar, the ticket,
 * what this codebase knows, where the worktree is — this session already has. Repeating it
 * would be the cold start we are removing, wearing a different name.
 *
 * So this says only what CHANGED, and asks the one question a continued round is for. The
 * findings are named rather than restated: the session raised them and still holds why.
 *
 * **Its own input type, naming exactly the three things it uses.** Taking `PromptInput`
 * forced the caller to invent values for fields this never reads — `tierIndex: 0`,
 * `modelTierCount: 1` — and the moment anyone rendered `position(i)` here, a t2 round
 * would have introduced itself as "tier 1 of 1" with nothing failing. A prompt that lies
 * quietly is the worst kind of defect this project has.
 */
export interface ContinuedInput {
  /** The deterministic engines re-run against the tree as it now stands. */
  readonly t0: string;
  /** What changed since this session last looked. */
  readonly diff: string;
  /** This tier's own still-open findings, one line each, for it to rule on (D-10). */
  readonly open: readonly string[];
  /**
   * Set only for a folder review (D-130), matching `ReviewDiff.scopePath` — what this
   * tier is re-reading is a full read of a path, not a diff against what it saw before.
   *
   * Found by lore's own review of D-130: `i.diff` here is `renderDiff`'s output, which
   * for a folder review is `renderFolderDiff`'s — opening with "THIS IS A FULL READ...
   * NOT A DIFF AGAINST A PRIOR VERSION". Left unbranched, this function's own headers
   * ("WHAT CHANGED SINCE YOU LAST LOOKED", "new work on the same branch") contradicted
   * the block they introduce, on the one path (a tier without `conversation: true`,
   * D-80's proven fallback) still live for exactly this shape of diff.
   */
  readonly scopePath?: string | undefined;
}

export function continuedPrompt(i: ContinuedInput): string {
  const folderMode = i.scopePath !== undefined;
  const intro = folderMode
    ? ["The author has answered. Re-read the files you care about at the path you are reviewing rather than", "assuming — there is no diff to apply; the path is read fresh, as it now stands."]
    : ["The author has answered. Their diff is applied to the worktree you are already in —", "same path, same branch — so re-read the files you care about rather than assuming."];
  const nothingOutstanding = folderMode
    ? "You raised nothing outstanding last round. Review the path as you did before."
    : "You raised nothing outstanding last round. This is new work on the same branch: review it as you did before.";
  const diffHeader = folderMode
    ? "THE PATH, AS IT NOW STANDS — NOT A DIFF AGAINST WHAT YOU SAW BEFORE"
    : "WHAT CHANGED SINCE YOU LAST LOOKED";
  const closing = folderMode
    ? ["Then review it as you would any other read: a fix can break something that was working. Same bar as", "before — consequence you can state, and something the author would still have missed."]
    : ["Then review the change itself as you would any other: it is new code, and a fix can", "break something that was working. Same bar as before — consequence you can state, and", "something the author would still have missed."];
  return [
    ...intro,
    "",
    i.open.length === 0
      ? nothingOutstanding
      : [
          "YOU RAISED THESE, and they are still open:",
          ...i.open.map((c) => `  - ${c}`),
          "",
          "For each one: is it actually fixed? A change near the code is not a fix, and a",
          "justification you do not accept is not a fix either. Say which are settled and",
          "which are not — you asked the question, so you are the one who judges the answer.",
        ].join("\n"),
    "",
    "DETERMINISTIC RESULTS FOR THE NEW TREE",
    i.t0,
    "",
    diffHeader,
    i.diff,
    "",
    ...closing,
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
    taskFraming(i.scopePath),
    "",
    indent(i.ticket),
    knowledgeBlock(i.knowledge),
    policyBlock(i.policyCount ?? 0),
    i.conflicts ?? "",
    settledBlock(i.settled),
    compositionBlock(i.diff, i.scopePath),
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

/**
 * THE STREAMING CONTRACT (D-107): one message, one emission — findings now, or done.
 *
 * Vany: *"the model must emit a finding immediately, not at the end of the session — so
 * emitting a finding is the perfect time to insert the data about the fix."* The
 * emit-and-stop discipline is what makes the prompt boundary — the only insertion point
 * opencode allows — land exactly at every finding, which is where a held fix wants in.
 *
 * The DONE marker is load-bearing (INV-1): a run ends when the model SAYS the tree is
 * examined, in this shape. A session that dies mid-search must never read as finished —
 * absence of findings is not completion, only the declaration is.
 */
export const STREAM_CONTRACT = `
Reply with ONE fenced json block and nothing else — no preamble, no commentary after.

When you have found a problem, report it NOW and STOP — do not keep it while you search
for more. One finding per message is ideal; a small batch is acceptable if several are
already in hand:

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

Only when you have examined everything this review covers and have nothing further:

\`\`\`json
{"done": true, "examined": "one sentence on what you covered"}
\`\`\`

Rules:
- Report a finding the moment you are sure of it. You will be told to continue after each report.
- {"done": true} is a DECLARATION that the review is complete. Never send it because you are unsure
  what to do next; never send an empty findings list — if you found nothing new and have examined
  everything, that IS done.
- "failureScenario" IS THE TEST: concrete inputs or state, then the wrong outcome. Drop what has none.
- Same bar as ever: consequence you can state, and something the author would still have missed.
`;

/**
 * The next instruction of the streaming loop, when no fix is waiting: keep going.
 * The session holds everything else — repeating any of it would be the cold start D-80
 * removed, wearing a message.
 */
export function streamContinue(): string {
  return [
    "Recorded and delivered to the author. Continue the review from where you were:",
    "report your next finding the moment you have it, or declare done if the tree is examined.",
  ].join("\n");
}

/**
 * A rung-mate's findings, delivered at the emission boundary (D-109).
 *
 * The other model on this same tree found something. Forwarded so the receiver STOPS
 * hunting for it — duplicate derivation is the one cost parallel review adds, and this
 * crossing is what removes it. Framed as a co-reviewer's work, not as truth: a member
 * with evidence against it says so, which is a free adversarial check, and re-raising
 * it in its own words CONFIRMS it (the recorded origin rises, as re-raises always have).
 */
export function streamPeer(findings: readonly string[]): string {
  return [
    "While you were reading, a co-reviewer working on this SAME tree raised:",
    ...findings.map((f) => `  - ${f}`),
    "",
    "These are recorded and with the author already — do NOT spend your budget re-deriving or",
    "re-reporting them. If you have evidence one is wrong, or worse than stated, say so in your",
    "next emission. Otherwise continue your own search elsewhere: next finding, or done.",
  ].join("\n");
}

/**
 * A held fix, delivered at the emission boundary (D-107).
 *
 * The diff is already APPLIED to the worktree the session is standing in, so the model
 * re-reads files rather than imagining the patch's effect. Its own open findings are
 * named, not restated — the session still holds why it raised them (D-10: the tier that
 * asked judges the answer).
 */
export function streamFix(i: {
  readonly diff: string;
  readonly t0: string;
  readonly open: readonly string[];
}): string {
  return [
    "The author has answered. Their diff is APPLIED to the worktree you are in — re-read the",
    "files you care about rather than assuming.",
    "",
    i.open.length === 0
      ? "You have nothing outstanding; treat this as new work on the same branch."
      : ["YOUR OPEN FINDINGS — for each, say in your next emission whether it is settled:", ...i.open.map((c) => `  - ${c}`)].join("\n"),
    "",
    "DETERMINISTIC RESULTS FOR THE NEW TREE",
    i.t0,
    "",
    "WHAT CHANGED",
    i.diff,
    "",
    // lore-ok[924989e3]: SOFTENED, same as the settled ledger below (28198096) and for the
    // identical reason — found by lore's own review, having missed this sibling the first
    // time. "RAISED severity" promised machinery `recordFinding`'s `ON CONFLICT(review_id,
    // fingerprint) DO NOTHING` does not have: the fingerprint is `claim`+`file`+`symbol`
    // only (core/fingerprint.ts), so a re-raise with unchanged wording writes nothing new —
    // severity included — however this line ends. Identical wording is still what keeps a
    // still-open finding tracked as the SAME one rather than a fresh discovery, so that
    // part stays; what changes is only the false promise that a severity word moves
    // anything on its own.
    "A finding that is actually fixed: do not re-raise it. Still the SAME defect: re-raise with the",
    "same claim wording — that is what keeps it tracked as the one you already raised, not a new one.",
    "Broken WORSE, or differently, than you first said: say what changed, in the claim itself. A",
    "severity word alone changes nothing on a re-raise; the wording is what carries it. The fix",
    "itself is new code — review it too. Then continue: next finding, or done.",
  ].join("\n");
}
