/**
 * The states a refactor run (D-136) can be in, and which of them mean it is over.
 *
 * A separate, smaller set from `review-state.ts`'s own — a refactor run has no rounds,
 * no ladder, no `needs_human`; it runs once and either produces suggestions or does not.
 *
 * SPEC: spec/refactor.md
 */

export const REFACTOR_STATES = ["queued", "running", "done", "failed"] as const;

export type RefactorState = (typeof REFACTOR_STATES)[number];

/** Terminal states — no further work will happen without a new run. */
const TERMINAL = new Set<RefactorState>(["done", "failed"]);

/**
 * The same set, for SQL that has to name it — `review-state.ts`'s own `TERMINAL_SQL`,
 * mirrored for the same reason: a hand-copied state list is how `passed_partial` went
 * missing from three of six review-side copies (2026-08-06) and overwrote real verdicts.
 * Found again in this table's own board-visibility change (D-139, fingerprints
 * ad809772/ba0d19b8) before this file existed to prevent it — four independent copies
 * of `'queued','running'`/`'done','failed'`, hand-written from memory in two SQL
 * strings and one TypeScript comparison.
 */
export const REFACTOR_TERMINAL_SQL: string = [...TERMINAL].map((s) => `'${s}'`).join(", ");

/**
 * The complement, spelled out rather than left as `NOT IN (REFACTOR_TERMINAL_SQL)` —
 * `boardRefactorRuns`'s own WHERE reads as "unfinished, or finished recently" more
 * plainly with both halves named than with one negated.
 */
export const REFACTOR_OPEN_SQL: string = REFACTOR_STATES.filter((s) => !TERMINAL.has(s))
  .map((s) => `'${s}'`)
  .join(", ");

export function isRefactorTerminal(state: RefactorState): boolean {
  return TERMINAL.has(state);
}
