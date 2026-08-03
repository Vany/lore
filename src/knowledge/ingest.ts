/**
 * Reading a repo's own documents into rules.
 *
 * A team's `CLAUDE.md` and `PROG.md` already state what it enforces. Making a model
 * rediscover that by watching reviews fail would be slow, expensive, and worse —
 * the docs say it outright.
 *
 * **The hazard was accepted knowingly, so the mitigation is mandatory.** A stale
 * document becomes a confidently wrong rule, injected into every future session and
 * every future review. So each rule records the blob it came from, and when that
 * blob changes the rules are **re-derived, never retained** (D-20). A rule must not
 * outlive the text that justified it.
 *
 * Extraction is deterministic on purpose. A model would extract better rules, but
 * this runs on every document change, must be free, and must give the same answer
 * twice — and D-8 says not to pay a model for what a rule can decide.
 *
 * SPEC: spec/knowledge.md §2
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { blobSha } from "../git/diff.ts";
import type { KnowledgeItem, Store } from "../store/store.ts";

/** Documents that state a project's rules, in the order a reader would trust them. */
export const RULE_DOCS = [
  "CLAUDE.md",
  "AGENTS.md",
  "PROG.md",
  "SPEC.md",
  "CONTRIBUTING.md",
  ".cursorrules",
] as const;

export const RULE_DIRS = ["docs/adr", "docs/decisions", "spec", "adr"] as const;

/**
 * Words that turn a sentence into an instruction.
 *
 * Deliberately narrow. Sweeping up every declarative sentence would fill the
 * knowledge base with prose, and a knowledge base nobody trusts is one nobody
 * reads.
 */
const MODAL = /\b(must not|must|never|always|do not|don't|shall|required|forbidden|prefer|avoid)\b/i;

/** Prose that looks like a rule but is about the document, not the code. */
const NOT_A_RULE = /^(see |read |this (file|document|section)|table of contents)/i;

const MIN_LENGTH = 20;
const MAX_LENGTH = 280;

export interface Candidate {
  readonly statement: string;
  readonly why: string | undefined;
}

/**
 * Pull rule-shaped statements out of markdown.
 *
 * Bullets first, because a bulleted rule is almost always the whole rule; then
 * standalone sentences carrying a modal. Headings, code fences and quotes are
 * skipped: a rule inside a code block is an example of a rule, not one.
 */
export function extractRules(markdown: string): readonly Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  let inFence = false;

  for (const raw of markdown.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0 || line.startsWith("#") || line.startsWith(">")) continue;

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const text = bullet?.[1] ?? line;
    const cleaned = stripMarkup(text);

    if (cleaned.length < MIN_LENGTH || cleaned.length > MAX_LENGTH) continue;
    if (!MODAL.test(cleaned) || NOT_A_RULE.test(cleaned)) continue;

    const { statement, why } = splitReason(cleaned);
    const key = statement.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ statement, why });
  }
  return out;
}

/**
 * Separate the rule from its reason.
 *
 * The *why* is the part that survives disagreement: a rule without one gets deleted
 * by the next reader who thinks they know better, which is precisely how a codebase
 * forgets why it does things.
 */
function splitReason(text: string): Candidate {
  const m = /^(.*?)[,—-]?\s*\b(because|since|so that|otherwise)\b\s+(.*)$/i.exec(text);
  if (m === null || (m[1] ?? "").trim().length < MIN_LENGTH) {
    return { statement: tidy(text), why: undefined };
  }
  return { statement: tidy(m[1] ?? ""), why: tidy(m[3] ?? "") };
}

/**
 * Trim the sentence punctuation a document uses and a rule does not need.
 *
 * Without this, the same rule written with and without a full stop is two rules —
 * and since a document is re-ingested on every change, an editor adding a period
 * would quietly double an entry.
 */
function tidy(s: string): string {
  return s.trim().replace(/[.,;:!]+$/, "").trim();
}

function stripMarkup(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export interface IngestResult {
  readonly documents: number;
  readonly added: number;
  readonly retired: number;
}

/**
 * Ingest every rule document in a worktree.
 *
 * Re-derivation is the whole point of the shape here: retire first, then re-extract.
 * Merging into what is already there would let a rule that was *deleted* from the
 * document live on forever, which is the same rot in a different coat.
 */
export async function ingestDocs(
  store: Store,
  repoId: string,
  worktree: string,
  files: readonly string[] = discoverable(),
): Promise<IngestResult> {
  let added = 0;
  let retired = 0;
  let documents = 0;

  for (const rel of files) {
    const source = await readFile(join(worktree, rel), "utf8").catch(() => undefined);
    if (source === undefined) continue;
    documents++;

    const blob = (await blobSha(worktree, rel)) ?? hashOf(source);
    retired += store.retireForChangedBlob(repoId, rel, blob);

    // Already ingested at this exact blob: nothing to do, and re-inserting would
    // duplicate every rule on every review.
    if (hasBlob(store, repoId, rel, blob)) continue;

    for (const c of extractRules(source)) {
      store.addKnowledge({
        repoId,
        kind: "rule",
        source: "ingested",
        statement: c.statement,
        why: c.why,
        path: pathScopeFor(rel),
        cwe: undefined,
        provenance: rel,
        sourceBlob: blob,
        // Below taught (1.0) and above a single derived observation: the document
        // says so, but nobody has confirmed the extraction understood it.
        confidence: 0.8,
      });
      added++;
    }
  }
  return { documents, added, retired };
}

function discoverable(): readonly string[] {
  return RULE_DOCS;
}

/**
 * Rules from a spec under `spec/` or `docs/adr/` are usually about that area;
 * rules from a root `CLAUDE.md` are about everything.
 */
function pathScopeFor(rel: string): string | undefined {
  const dir = RULE_DIRS.find((d) => rel.startsWith(`${d}/`));
  return dir === undefined ? undefined : dir;
}

function hasBlob(store: Store, repoId: string, provenance: string, blob: string): boolean {
  const row = store.db
    .prepare(
      "SELECT 1 AS present FROM knowledge WHERE repo_id = ? AND provenance = ? AND source_blob = ? AND retired_at IS NULL LIMIT 1",
    )
    .get(repoId, provenance, blob) as Record<string, number> | undefined;
  return row !== undefined;
}

function hashOf(s: string): string {
  // Fallback when the file is untracked and git cannot hash it for us. Any stable
  // function will do; it only has to change when the content does.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `nogit-${(h >>> 0).toString(16)}`;
}

/** Ranked view for prompts and `knowledge.query`. */
export function rank(items: readonly KnowledgeItem[]): readonly KnowledgeItem[] {
  const weight = (k: KnowledgeItem): number =>
    k.source === "taught" ? 0 : k.source === "ingested" ? 1 : 2;
  return [...items].sort(
    (a, b) => weight(a) - weight(b) || (b.confidence ?? 0) - (a.confidence ?? 0) || b.verifiedAt.localeCompare(a.verifiedAt),
  );
}
