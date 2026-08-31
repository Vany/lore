/**
 * What a fan-out tier is told, and what the combiner is told.
 *
 * Two different jobs, two different prompts (D-136). The fan-out tiers (t2, t3, or
 * whichever tiers carry `refactor: true`) each read the folder cold and say what they
 * would change — independently, so neither sees the other's answer before writing its
 * own. The combiner (t1) never reads the folder again: it is handed both raw sets and
 * asked to reconcile them into one list, which is a different task from generating
 * suggestions and does not need the tree to do it.
 *
 * SPEC: spec/refactor.md
 */

export interface SuggestInput {
  readonly folder: string;
  readonly commit: string;
  readonly worktree: string;
}

function scope(folder: string): string {
  const where = folder === "" || folder === "." ? "this repository" : `\`${folder}\``;
  return [
    `THE SUBJECT IS ${where.toUpperCase()}.`,
    "",
    "Read whatever you need to judge it fairly — callers, dependants, specs or ADRs it is governed by —",
    `but the suggestions themselves must be ABOUT ${where}: what in there is worth restructuring, splitting,`,
    "merging, renaming, or removing, and why.",
  ].join("\n");
}

export function suggestPrompt(i: SuggestInput): string {
  return [
    "You are being asked what in this code is worth refactoring. This is NOT a review: nothing you say",
    "gates anything, no finding is filed, and nobody has to defend the code against you. You are also not",
    "being asked to redesign what the code does — only how it is built.",
    "",
    "Give the suggestions you actually believe are worth the effort — not a padded list. A short list of",
    "real ones is worth more than a long list of minor ones stated to look thorough.",
    "",
    scope(i.folder),
    "",
    "For each suggestion, name what must keep working: a refactor changes STRUCTURE, not BEHAVIOUR. If your",
    "idea would change what the code does, it is a different kind of change and does not belong here.",
    "",
    `The tree is commit ${i.commit}, checked out at:`,
    `    ${i.worktree}`,
    "cd there first and confirm with `pwd`. Read the code before you decide.",
  ].join("\n");
}

export const SUGGESTION_CONTRACT = `
Reply with ONE fenced json block and nothing else. No preamble, no commentary after it.

\`\`\`json
{"suggestions": [
  {
    "title": "one line, plain enough to sort a list by",
    "area": ["src/store/store.ts", "src/store/schema.ts"],
    "rationale": "why this is worth doing, and what it costs to leave as-is",
    "roughSize": "small"
  }
]}
\`\`\`

Rules:
- "area" is required — the files or directories the change lands in. Omit it and the suggestion cannot be
  placed, and it is dropped.
- "roughSize" is one of "small", "medium", "large", or may be omitted if you genuinely cannot judge it.
- "suggestions": [] is a valid answer. If you looked and would change nothing here, say that — it is worth
  more than a suggestion you do not believe.
`.trim();

/** One suggestion, indented, for a combiner reading several sets at once. */
function listing(title: string, items: readonly { readonly title: string; readonly area: readonly string[]; readonly rationale: string; readonly roughSize?: string }[]): string {
  if (items.length === 0) return `${title}\n    (none)`;
  return [
    title,
    ...items.map((s, i) =>
      [
        `  ${String(i + 1)}. ${s.title}`,
        `     area: ${s.area.join(", ")}`,
        `     rationale: ${s.rationale}`,
        s.roughSize === undefined ? undefined : `     roughSize: ${s.roughSize}`,
      ].filter((l): l is string => l !== undefined).join("\n"),
    ),
  ].join("\n");
}

export interface CombineInput {
  readonly folder: string;
  readonly sets: readonly {
    readonly tier: string;
    readonly suggestions: readonly { readonly title: string; readonly area: readonly string[]; readonly rationale: string; readonly roughSize?: string }[];
  }[];
}

/**
 * The combiner sees ONLY the suggestion sets, never the folder's code again — Vany's own
 * call: its job is reconciling two (or more) viewpoints, not re-deriving them, and asking
 * it to also re-read the tree would be a third full-context read on every call for a task
 * that does not need one.
 *
 * lore-ok[f63ec425]: found by lore's own review — this used to say "Two independent
 * models" unconditionally, false on the one-tier-failed path `run.test.ts` already
 * covers and on any deployment that marks only one tier `refactor: true` (the door
 * check requires only one, not two). Sized from `i.sets.length`, which is the actual
 * count of sets this call was handed, not the count `refactor_start`'s config implies.
 */
export function combinePrompt(i: CombineInput): string {
  const where = i.folder === "" || i.folder === "." ? "this repository" : `\`${i.folder}\``;
  const n = i.sets.length;
  const intro =
    n === 1
      ? [
          `One model was asked what is worth refactoring in ${where}. You did not read the code yourself and`,
          "are not being asked to — your job is to clean up its list into one a person can actually act on:",
          "drop exact duplicates, tighten a vague title, nothing more inventive than that.",
        ]
      : [
          `${String(n)} independent models were each asked what is worth refactoring in ${where}, without seeing`,
          "any other's answer. You did not read the code yourself and are not being asked to — your job is to",
          "merge their suggestions into ONE list a person can actually act on.",
        ];
  const mergeInstructions =
    n === 1
      ? []
      : [
          "",
          "MERGE, DO NOT JUST CONCATENATE. Where two suggestions are the same idea in different words, keep one —",
          "prefer the clearer statement of it, and combine anything true in both. Where they disagree about the",
          "same area, say so in the merged suggestion rather than silently picking a side. Drop nothing for being",
          `named by only one model: a real idea one model had and ${n === 2 ? "the other" : "the others"} missed is still a real idea.`,
        ];
  return [
    ...intro,
    "",
    ...i.sets.map((s) => listing(`FROM ${s.tier.toUpperCase()}`, s.suggestions)),
    ...mergeInstructions,
    "",
    "Keep every suggestion's own \"area\" and \"roughSize\" where they still apply; adjust \"rationale\" if",
    "merging two suggestions changes what actually justifies the result.",
  ].join("\n");
}
