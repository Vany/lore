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

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { blobSha } from "../git/diff.ts";
import type { KnowledgeItem, Store } from "../store/store.ts";

/** Documents that state a project's rules, in the order a reader would trust them. */
const RULE_DOCS = [
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

  for (const block of blocks(markdown)) {
    for (const sentence of sentences(block)) {
      const cleaned = stripMarkup(sentence);
      if (cleaned.length < MIN_LENGTH || cleaned.length > MAX_LENGTH) continue;
      if (!MODAL.test(cleaned) || NOT_A_RULE.test(cleaned)) continue;

      const { statement, why } = splitReason(cleaned);
      const key = statement.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ statement, why });
    }
  }
  return out;
}

/**
 * Markdown reflowed into logical blocks: a paragraph or one bullet, wrapped lines
 * joined back together.
 *
 * This is the whole difference between a knowledge base and a pile of fragments.
 * Reading PHYSICAL lines means every rule in a hard-wrapped document is cut at the
 * wrap — and these documents are wrapped at eighty characters, so most were. The
 * store filled with things like "change — I do not let code and spec drift apart
 * quietly": true, unattributable, and starting mid-sentence because the clause
 * before it lived on the previous line.
 *
 * Headings, code fences, quotes and TABLE ROWS are skipped. A table row matches a
 * modal as readily as prose does — `| D-2 | lore never commits or pushes |` — and
 * arrives as pipes and alignment rather than as a sentence anyone can act on.
 */
function blocks(markdown: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current.length > 0) out.push(current.join(" "));
    current = [];
  };

  for (const raw of markdown.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("```")) {
      flush();
      inFence = !inFence;
      continue;
    }
    // A rule inside a code block is an example of a rule, not one.
    if (inFence) continue;

    // A blank line, a heading, a quote or a table row all end whatever came before.
    if (line.length === 0 || line.startsWith("#") || line.startsWith(">") || line.startsWith("|")) {
      flush();
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line) ?? /^\d+\.\s+(.*)$/.exec(line);
    if (bullet !== null) {
      // A new bullet ends the previous one; its own continuation lines follow.
      flush();
      current.push(bullet[1] ?? "");
      continue;
    }
    current.push(line);
  }
  flush();
  return out;
}

/**
 * One block into whole sentences.
 *
 * Split on sentence-ending punctuation followed by a capital, which leaves
 * abbreviations and version numbers intact. A block with no terminator is one
 * sentence — bullets frequently have no full stop.
 */
function sentences(block: string): string[] {
  return block
    .split(/(?<=[.!?])\s+(?=[A-Z"`*])/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
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
  files?: readonly string[],
): Promise<IngestResult> {
  let added = 0;
  let retired = 0;
  let documents = 0;

  for (const rel of files ?? (await discoverable(worktree))) {
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

/**
 * Every rule document in the tree: the root files, and the decision records.
 *
 * **The directories were missing, and the spec said they were not.**
 * `spec/knowledge.md` promised rules parsed from "`CLAUDE.md`, `PROG.md`, `SPEC.md`,
 * ADRs"; this returned `RULE_DOCS` alone, so no ADR was ever read. `RULE_DIRS` existed
 * only to *scope* a rule found under one — a branch nothing could reach, which is
 * what made the gap invisible to a reader: the constant is right there and looks used.
 *
 * The cost was the product. `rigid-monorepo` carries 37 ADRs and had **eight** rules,
 * all from two root files, while its entire decision record — the reasoning a reviewer
 * most needs and least can infer — was not read at all. That is the memory this
 * service exists to keep, missing for the one repository with a real user.
 *
 * Recursive, because ADRs get filed into subdirectories once there are enough of them.
 * The cap is per repository and announced when hit (`ingest: …`) rather than silently
 * truncating: a knowledge base that quietly stopped reading at some arbitrary file is
 * exactly the confident incompleteness this project refuses.
 */
const MAX_RULE_DOCS = 400;

async function discoverable(worktree: string): Promise<readonly string[]> {
  const out: string[] = [...RULE_DOCS];

  for (const dir of RULE_DIRS) {
    const found: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      const entries = await readdir(join(worktree, rel), { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(child);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) found.push(child);
      }
    };
    await walk(dir);
    out.push(...found);
  }

  if (out.length > MAX_RULE_DOCS) {
    console.error(
      `[lore:log] ingest: ${out.length} rule documents found, reading the first ${MAX_RULE_DOCS}. ` +
        `The rest were NOT read — this repository's memory is incomplete and knows it.`,
    );
    return out.slice(0, MAX_RULE_DOCS);
  }
  return out;
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
