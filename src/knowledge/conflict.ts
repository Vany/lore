/**
 * Two beliefs about the same code that cannot both be true.
 *
 * This is the failure mode most likely to poison every future session, because a
 * wrong remembered rule is injected into all of them automatically. So a
 * contradiction is **not resolved by the store** — it becomes a finding the
 * reviewing agent must actually work through, and if it cannot, the review stops
 * and asks a person (D-39).
 *
 * **Newer leans correct, but only leans.** Code evolves, so a later rule is usually
 * the truer one — that is a prior, not a verdict. A recent rule written carelessly
 * must not silently overwrite an older one that was reasoned through.
 *
 * SPEC: spec/knowledge.md §7
 */

import type { KnowledgeItem, Store } from "../store/store.ts";

/**
 * Words that flip a statement's polarity.
 *
 * A closed list, so "must not be ABSENT" reads as one negation here and as a double
 * negative to a person. That is a known limit rather than a bug — widening it to
 * every negative-meaning word needs a lexicon this file has no business carrying.
 */
const NEGATIONS = /\b(not|never|no|avoid|forbidden|must not|don't|do not|without|reject)\b/gi;

/** Words carrying no signal about what a rule is about. */
const STOP = new Set([
  "the", "a", "an", "is", "are", "be", "to", "of", "in", "on", "for", "and", "or", "it", "this",
  "that", "with", "as", "at", "by", "from", "we", "you", "must", "should", "always", "never",
  "not", "no", "do", "don't", "avoid", "prefer", "use", "using", "when", "if", "any", "all",
]);

export interface ConflictCandidate {
  readonly left: KnowledgeItem;
  readonly right: KnowledgeItem;
  readonly similarity: number;
  readonly reason: string;
}

/**
 * Positive (1), negative (-1), or **too compound to say** (0).
 *
 * Double negation only cancels within ONE proposition — "must not run without a tree
 * hash" really is a positive claim. It was applied to the whole statement, and a
 * sentence making SEVERAL claims breaks that badly:
 *
 *   "…the seam holds NO balance and NEVER calls the ledger"   → 2 negations → positive
 *   "…the seam still NEVER touches the ledger"                → 1 negation  → negative
 *
 * Those are the same assertion, written twice. The first was read as its own
 * opposite, and with 63% token overlap the two were recorded as a contradiction that
 * stopped a real review at `needs_human` — the first time this path ever fired in
 * production, and it was wrong. Two independent negative clauses do not cancel; they
 * are two negative facts.
 *
 * So cancellation is now per CLAUSE, and a statement whose clauses disagree returns 0
 * — this heuristic cannot reduce it to one polarity, and saying so is better than
 * picking one. `findConflicts` skips those rather than guessing, which is the right
 * trade here: a missed conflict leaves two rules to be caught later, while a false one
 * stops a review and demands a person.
 */
export function polarity(statement: string): number {
  // Clause boundaries, not sentence boundaries: the failure was WITHIN one sentence.
  const clauses = statement.split(/[,;:—]|\band\b|\bbut\b|\bwhile\b/i).filter((c) => c.trim().length > 0);
  const polarities = new Set(
    clauses.map((c) => ((c.match(NEGATIONS)?.length ?? 0) % 2 === 0 ? 1 : -1)),
  );
  if (polarities.size === 0) return 1;
  // Mixed: several claims pulling different ways. Undecidable, and it says so.
  return polarities.size > 1 ? 0 : (polarities.values().next().value ?? 1);
}

export function subjectTokens(statement: string): ReadonlySet<string> {
  return new Set(
    statement
      .toLowerCase()
      .replace(/[^a-z0-9\s_./-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Threshold for "these are about the same thing".
 *
 * Tuned to be **noisy rather than silent**. A false candidate costs a reviewer one
 * sentence of consideration; a missed contradiction costs every future session a
 * wrong belief.
 */
const SIMILARITY_THRESHOLD = 0.5;

/**
 * Find candidate contradictions among live rules.
 *
 * A heuristic, and honestly so: token overlap with opposite polarity. It will miss
 * contradictions phrased without an explicit negation ("amounts are integers" vs
 * "amounts are floats"), and those need a model or a human to spot. Stated here
 * rather than left for someone to discover by trusting it too much.
 */
export function findConflicts(items: readonly KnowledgeItem[]): readonly ConflictCandidate[] {
  const prepared = items.map((k) => ({ k, tokens: subjectTokens(k.statement), pol: polarity(k.statement) }));
  const out: ConflictCandidate[] = [];

  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i];
      const b = prepared[j];
      if (a === undefined || b === undefined) continue;
      // 0 means "too compound to reduce to one polarity" — a statement that makes
      // several claims cannot be said to contradict anything on this evidence.
      if (a.pol === 0 || b.pol === 0) continue;
      if (a.pol === b.pol) continue;
      // Rules scoped to unrelated paths are not in conflict; they are two rules.
      if (!scopesOverlap(a.k.path, b.k.path)) continue;

      const similarity = jaccard(a.tokens, b.tokens);
      if (similarity < SIMILARITY_THRESHOLD) continue;

      out.push({
        left: a.k,
        right: b.k,
        similarity,
        reason: `same subject (${Math.round(similarity * 100)}% overlap), opposite polarity`,
      });
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}

function scopesOverlap(a: string | undefined, b: string | undefined): boolean {
  // An unscoped rule is repo-wide, so it can conflict with anything.
  if (a === undefined || b === undefined) return true;
  return a.startsWith(b) || b.startsWith(a);
}

export interface ConflictReport {
  readonly recorded: number;
  readonly open: number;
}

/**
 * Record candidates for the reviewer to settle.
 *
 * Recording, never resolving. The store's job is to make sure the contradiction is
 * *seen*; deciding it needs someone who can read the code.
 */
export function detectAndRecord(store: Store, repoId: string): ConflictReport {
  const live = store.knowledgeFor(repoId, undefined, 1000);
  const candidates = findConflicts(live);
  const already = new Set(store.openConflicts(repoId).map((c) => `${c.left}|${c.right}`));

  let recorded = 0;
  for (const c of candidates) {
    const key = `${c.left.id}|${c.right.id}`;
    const reverse = `${c.right.id}|${c.left.id}`;
    if (already.has(key) || already.has(reverse)) continue;
    store.recordConflict(repoId, c.left.id, c.right.id);
    already.add(key);
    recorded++;
  }
  return { recorded, open: store.openConflicts(repoId).length };
}

/**
 * Render open conflicts for a reviewer prompt.
 *
 * Phrased as work to be done, not as information. The agent must either settle it
 * with reasoning or say plainly that it cannot — and it is told explicitly that
 * `lore-ok` is not available here, because a justification is a claim about code
 * and this is a question about which of two beliefs is true.
 */
export function renderConflicts(store: Store, repoId: string): string {
  const open = store.openConflicts(repoId);
  if (open.length === 0) return "";

  const byId = new Map(store.knowledgeFor(repoId, undefined, 1000).map((k) => [k.id, k]));
  const lines: string[] = [
    "",
    "CONTRADICTIONS TO RESOLVE",
    "This codebase holds two beliefs that cannot both be true. Resolve each one: read both rules, read their",
    "provenance, read the code as it stands now, and decide — recording why. A later rule is USUALLY the truer",
    "one because code evolves, but that is a prior, not a verdict: a careless recent rule must not overwrite an",
    "older one that was reasoned through.",
    "",
    "If you cannot decide, say so plainly and stop. Do not guess, and do not close it with lore-ok — a",
    "justification is a claim about code, and this is a question about which of two beliefs is true.",
  ];

  for (const c of open) {
    const l = byId.get(c.left);
    const r = byId.get(c.right);
    if (l === undefined || r === undefined) continue;
    lines.push(
      "",
      `  A [${l.source}, ${l.verifiedAt.slice(0, 10)}] ${l.statement}${l.why === undefined ? "" : ` (because ${l.why})`}`,
      `  B [${r.source}, ${r.verifiedAt.slice(0, 10)}] ${r.statement}${r.why === undefined ? "" : ` (because ${r.why})`}`,
    );
  }
  return lines.join("\n");
}
