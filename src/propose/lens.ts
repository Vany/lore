/**
 * What a proposer is told, and what its critic is told.
 *
 * Two rules shape every string here, and both come from `spec/propose.md`.
 *
 * **One idea per proposer, never a list.** Asked for thirty a model pads to fill the
 * count and the padding is generic; asked for the one change it would make if it could
 * make only one, it answers with what it believes. So the contract permits a list of
 * one and the prompt asks for exactly one — a model that returns three has ignored the
 * instruction, and the run keeps the first, which is the one it thought of first.
 *
 * **Consensus is a smell.** The lenses are forced apart on purpose: the same open
 * question sent to three models returns three versions of the safe answer, and the ideas
 * worth having are the ones only one lens saw. That is why the vantage is stated as an
 * attack surface rather than as a topic.
 *
 * SPEC: spec/propose.md §2, §3, §4
 */

import type { Lens } from "./proposal.ts";

/** What each lens is told to go at. Deliberately narrow — a wide brief returns a wide answer. */
const ATTACK: Readonly<Record<Lens, string>> = {
  data: [
    "THE DATA. The schema, the store, what is denormalised, what a transaction spans and what it does not.",
    "Where does a write leave two places disagreeing? What is derived and stored anyway? Which query exists",
    "only because the shape is wrong?",
  ].join("\n"),
  failure: [
    "FAILURE. What breaks under partial failure, restart, concurrency, or a dead upstream.",
    "What is left half-done when the process dies between two writes? What retries and should not, or does",
    "not and should? What does this code assume is still there when it comes back?",
  ].join("\n"),
  seams: [
    "THE SEAMS. Module boundaries: what knows too much about what, and what cannot be tested alone.",
    "Which file would you have to understand three others to change? What is imported for one function and",
    "drags in a world? Where does a caller reach past an interface because the interface was the wrong one?",
  ].join("\n"),
  greenfield: [
    "THE WHOLE SHAPE. You have six months and no compatibility constraint — but the SAME JOB TO DO.",
    "What would you build instead? Not a different product: the same behaviour, arrived at differently.",
    "This is the lens most likely to waste the budget and the only one that can produce a structural idea.",
  ].join("\n"),
};

export interface LensInput {
  readonly lens: Lens;
  readonly folder: string;
  readonly commit: string;
  readonly worktree: string;
  /** What the review type asks. `code-arch` asks what would make this better to own. */
  readonly question: string;
  /** What this repository already knows, so an idea it has had is not offered again. */
  readonly knowledge: string;
}

/** The scope rule, stated the same way to the proposer and to the critic. */
function scope(i: LensInput): string {
  const where = i.folder === "" || i.folder === "." ? "this repository" : `\`${i.folder}\``;
  return [
    `THE SUBJECT IS ${where.toUpperCase()}.`,
    "",
    "READ OUTWARD, PROPOSE INWARD. Read whatever you need — callers, dependants, the specs and ADRs that",
    `govern this code, anywhere it links to. A proposal about ${where} made without reading its callers is a`,
    "proposal about code nobody uses, and you will not know which it is until you look.",
    "",
    `But the CHANGE must land in ${where}. List the files it touches in \`touches\`. An idea whose change is`,
    "somewhere else is dropped — not ranked lower, dropped — because it answers a question nobody asked.",
    "One file inside is enough: moving a seam touches both sides, and that is the kind of idea worth having.",
  ].join("\n");
}

export function proposerPrompt(i: LensInput): string {
  return [
    "You are being asked what you would CHANGE about this code. Not to review it: nothing you say here gates",
    "anything, no finding will be filed, and nobody will be asked to defend the code against you.",
    "",
    "ONE IDEA. The single change you would make if you could make only one. Not a list, not a survey, not",
    "three safe ones — asked for many, a model pads, and the padding is what makes a document unreadable.",
    "Say the thing you actually believe, including if it is uncomfortable.",
    "",
    `YOUR VANTAGE — ${i.lens}. Attack this and nothing else:`,
    ATTACK[i.lens],
    "",
    scope(i),
    "",
    "KEEP THE FUNCTIONALITY. This is a refactor, not a redesign: what the code DOES must survive your change",
    "intact. You may restructure it however you like — different files, different types, a different internal",
    "model — but a user or a caller must not be able to tell. If your idea changes what the system does, it",
    "is a product decision and you do not have standing to make one; find a different idea.",
    "State in `preserves` what must keep working identically AND how a person would check it. 'Every existing",
    "test passes unedited' is a good answer. 'It should be fine' is not.",
    "",
    "NAME THE MEASUREMENT THAT WOULD KILL IT. `settledBy` is one thing a person could run or count in an",
    "hour that would tell them you are wrong. A large refactor was proposed in this repository and `wc -l`",
    "plus a twenty-line script killed it in ten minutes — the measurement WAS the appraisal. The danger is",
    "never a bad idea; a bad idea dies in five seconds. It is a plausible one.",
    "",
    `THE QUESTION THIS RUN IS ASKING: ${i.question}`,
    "",
    `The tree is commit ${i.commit}, checked out at:`,
    `    ${i.worktree}`,
    "cd there first and confirm with `pwd`. Read the README, CLAUDE.md / AGENTS.md and any specs before you",
    "decide — an idea that contradicts a written decision is worth less than one that knows about it, and you",
    "must name what argues against you in `contradictedBy` either way.",
    i.knowledge,
  ].join("\n");
}

/**
 * Found by lore's own review, fingerprint 33be1f60: this prompt's own field list used
 * to name five fields and omit two `parseProposal` (proposal.ts) and `screen` (screen.ts)
 * both depend on — `trueIf`, which parsing hard-rejects when empty, and `touches`, whose
 * absence demotes an otherwise-sound, correctly-placed idea out-of-scope. A critic that
 * followed its own instructions exactly could have its verdict rejected as malformed, or
 * silently drop the proposer's own scope. Both are now asked for explicitly.
 */
export function criticPrompt(i: LensInput, idea: string): string {
  return [
    "You are reading someone else's proposal about this code. You did not write it and you are not defending",
    "the code — you are the second opinion on the IDEA, and you are from a different vendor than the model",
    "that had it, on purpose: a model grading its own suggestion confirms the design it already had in mind.",
    "",
    "THE PROPOSAL",
    idea.split("\n").map((l) => `    ${l}`).join("\n"),
    "",
    "Return ONE proposal object, and it is your verdict on that idea rather than a new idea of your own:",
    "",
    "  * `idea` — restate it in your words, as you would to the person who has to do the work, INCLUDING what",
    "    the proposer left out. If you think it is simply wrong, say that first and say why.",
    "  * `touches` — the files the change lands in. Normally the SAME list the proposal gave you; correct it",
    "    only if you believe the change actually has to land somewhere else. This is required — an empty or",
    "    omitted list makes the idea unplaceable and it is dropped, whatever either of you thought of it.",
    "  * `trueIf` — your OWN answer, which may differ from the proposer's: what would have to be true for this",
    "    to be worth doing. Required, and empty is not a valid answer — say what you actually believe.",
    "  * `costIfWrong` — what it costs to find out this was a mistake. Be concrete and be pessimistic: the",
    "    author of the code is the worst judge of this and so is its proposer.",
    "  * `contradictedBy` — what in this repository, its specs or its rules argues against it. Look; do not",
    "    assume there is nothing.",
    "  * `settledBy` — the measurement. If the proposer's would not actually decide it, replace it with one",
    "    that would. If no measurement can decide it in an hour, say so and leave it out — that is a real",
    "    answer and the document marks it.",
    "  * `preserves` — whether the change really does keep the behaviour. If it does not, say what it changes;",
    "    an idea that quietly alters what the system does is the one failure this tool must not ship.",
    "",
    scope(i),
    "",
    `The tree is commit ${i.commit}, checked out at:`,
    `    ${i.worktree}`,
    "Go and read the code before you agree with any of it.",
    i.knowledge,
  ].join("\n");
}

/**
 * The output contract, restated on a retry exactly as the reviewer's is.
 *
 * `settledBy` and `preserves` are optional IN THE SCHEMA and required by the prompt,
 * which is deliberate: a model that cannot name a measurement should say so and still
 * hand over the idea, rather than inventing a measurement to satisfy a parser. The
 * document marks what arrived without them.
 */
export const PROPOSAL_CONTRACT = `
Reply with ONE fenced json block and nothing else. No preamble, no commentary after it.

\`\`\`json
{"proposals": [
  {
    "lens": "seams",
    "idea": "one paragraph, in your own words",
    "touches": ["src/store/store.ts", "src/store/schema.ts"],
    "trueIf": "what would have to be true for this to be worth doing",
    "costIfWrong": "what it costs to find out this was a mistake",
    "contradictedBy": "what in this repo or its rules argues against it",
    "settledBy": "ONE thing to run or count that would decide it",
    "preserves": "what must keep working identically, and how you would check"
  }
]}
\`\`\`

Rules:
- EXACTLY ONE proposal. The array exists so the shape matches the rest of this system.
- "lens" must be the vantage you were given, unchanged.
- "touches" is how the scope rule is applied — the files your change lands in. Omit it and your idea cannot
  be placed, and it is dropped.
- "settledBy" and "preserves" may be omitted if you genuinely have neither. Saying so is honest; inventing
  one to fill the field is not, and the document marks what arrived without them rather than hiding it.
- "proposals": [] is a valid answer. If you looked and would change nothing here, say that — it is worth more
  than an idea you do not believe.
`.trim();
