/**
 * Turning what keeps happening into something the codebase knows.
 *
 * **The fourth occurrence of a defect is not four bugs; it is one missing rule.**
 * That promotion is the difference between a reviewer that catches the same mistake
 * forever and a memory that stops it being made.
 *
 * Deterministic, over findings already recorded. No model, no network.
 *
 * SPEC: spec/knowledge.md §3
 */

import { normalizeClaim } from "../core/finding.ts";
import type { KnowledgeItem, Store } from "../store/store.ts";

/**
 * How many times a defect must recur before it becomes a rule.
 *
 * Three, not two: two occurrences of anything is a coincidence often enough that
 * promoting at two would fill the knowledge base with noise — and a knowledge base
 * nobody trusts is one nobody reads.
 */
export const RECURRENCE_THRESHOLD = 3;

export interface Cluster {
  readonly key: string;
  readonly kind: "cwe" | "claim";
  readonly count: number;
  readonly exemplar: string;
  readonly paths: readonly string[];
}

/**
 * Find defects that keep coming back, across every review of this repo.
 *
 * Two axes, because they catch different things. **CWE** clusters catch the same
 * *weakness class* described in different words — which is exactly what the plain
 * fingerprint cannot do (spec/review-ladder.md §3.1.1), and the reason D-44 exists.
 * **Normalised claim** clusters catch repeats of a defect that has no CWE at all,
 * which is most review findings.
 */
export function clusters(store: Store, repoId: string, threshold = RECURRENCE_THRESHOLD): readonly Cluster[] {
  const rows = store.db
    .prepare(
      `SELECT f.cwe AS cwe, f.claim AS claim, f.file AS file
       FROM finding f JOIN review r ON r.id = f.review_id
       WHERE r.repo_id = ?`,
    )
    .all(repoId) as Record<string, string | null>[];

  const byCwe = new Map<string, { count: number; exemplar: string; paths: Set<string> }>();
  const byClaim = new Map<string, { count: number; exemplar: string; paths: Set<string> }>();

  for (const row of rows) {
    const claim = row["claim"] ?? "";
    const file = row["file"] ?? "";
    const cwe = row["cwe"];

    if (typeof cwe === "string" && cwe.length > 0) bump(byCwe, cwe, claim, file);
    bump(byClaim, normalizeClaim(claim), claim, file);
  }

  const out: Cluster[] = [];
  for (const [key, v] of byCwe) {
    if (v.count >= threshold) {
      out.push({ key, kind: "cwe", count: v.count, exemplar: v.exemplar, paths: [...v.paths] });
    }
  }
  for (const [key, v] of byClaim) {
    if (v.count >= threshold) {
      out.push({ key, kind: "claim", count: v.count, exemplar: v.exemplar, paths: [...v.paths] });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

function bump(
  m: Map<string, { count: number; exemplar: string; paths: Set<string> }>,
  key: string,
  exemplar: string,
  file: string,
): void {
  const cur = m.get(key);
  if (cur === undefined) m.set(key, { count: 1, exemplar, paths: new Set([file]) });
  else {
    cur.count++;
    cur.paths.add(file);
  }
}

/**
 * Promote recurring defects to `mistake` knowledge.
 *
 * Idempotent by provenance: re-running updates nothing and duplicates nothing, so
 * this can be called after every review without the knowledge base growing a copy
 * of the same lesson each time.
 */
export function promoteRecurring(store: Store, repoId: string, threshold = RECURRENCE_THRESHOLD): readonly KnowledgeItem[] {
  const added: KnowledgeItem[] = [];

  for (const c of clusters(store, repoId, threshold)) {
    const provenance = `recurrence:${c.kind}:${c.key}`;
    if (exists(store, repoId, provenance)) continue;

    const where = c.paths.length <= 3 ? c.paths.join(", ") : `${c.paths.slice(0, 3).join(", ")} and ${c.paths.length - 3} more`;
    added.push(
      store.addKnowledge({
        repoId,
        kind: "mistake",
        source: "derived",
        statement:
          c.kind === "cwe"
            ? `This codebase repeatedly produces ${c.key} findings (${c.count} so far). Check for it explicitly.`
            : `This defect keeps recurring (${c.count} times): ${c.exemplar}`,
        why: `seen ${c.count} times in ${where} — a defect that recurs is a missing rule, not ${c.count} unrelated bugs`,
        path: c.paths.length === 1 ? c.paths[0] : undefined,
        ...(c.kind === "cwe" ? { cwe: c.key } : { cwe: undefined }),
        provenance,
        sourceBlob: undefined,
        // Derived from observation only: real, but nobody has confirmed the lesson
        // drawn from it is the right one.
        confidence: Math.min(0.9, 0.4 + c.count * 0.1),
      }),
    );
  }
  return added;
}

function exists(store: Store, repoId: string, provenance: string): boolean {
  const row = store.db
    .prepare("SELECT 1 AS present FROM knowledge WHERE repo_id = ? AND provenance = ? AND retired_at IS NULL LIMIT 1")
    .get(repoId, provenance) as Record<string, number> | undefined;
  return row !== undefined;
}
