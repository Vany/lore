/**
 * What the knowledge base is holding, and what it threw away.
 *
 * **The product had no operator view.** `lore` grew commands for tokens, repositories,
 * tiers and proposals; the thing this service exists to build — the memory — could only
 * be read with hand-written SQL through the container. Every measurement in `MEMO.md`
 * was taken that way, by me, at a prompt, which means nobody else could take one.
 *
 * Two questions it answers that nothing else could:
 *
 *   * **What was refused, and why.** D-81 writes every screen refusal as a knowledge row
 *     that is born retired, carrying the model's reason, precisely so a rule that never
 *     arrived is not invisible. That guarantee was worth nothing while the only way to
 *     read those rows was `docker compose exec` and a SELECT.
 *   * **Which documents produce junk.** The refusal rate per document turned out to be a
 *     drift metric on our own writing: measured 2026-08-07, `CLAUDE.md` and `PROG.md`
 *     were refused 0 of 13, and every refusal came from the explanatory specs — worst in
 *     the three edited most that day. `CLAUDE.md` says specs describe the system as it
 *     stands and change-narrative belongs in `MEMO.md`, so a document whose rate climbs
 *     is one where somebody has been writing session notes into a spec. That was not
 *     what the screen was built for and is more useful than what it was built for.
 *
 * SPEC: spec/knowledge.md §2.1.2, D-81
 */

import type { Store } from "../store/store.ts";

export interface DocumentTally {
  readonly provenance: string;
  readonly kept: number;
  readonly refused: number;
}

export interface Refusal {
  readonly provenance: string;
  readonly statement: string;
  readonly because: string;
}

export interface KnowledgeReport {
  readonly repo: string;
  /** Live rules by where they came from: taught | ingested | derived. */
  readonly bySource: readonly { readonly source: string; readonly n: number }[];
  readonly byDocument: readonly DocumentTally[];
  readonly refusals: readonly Refusal[];
  /** Documents kept WITHOUT a screen having passed them — a degraded memory, healing. */
  readonly unscreened: number;
}

/**
 * DISTINCT statements, not rows, and the difference is a factor of three.
 *
 * A refusal is re-recorded every time its document changes, and nothing collects the
 * older copies (`TODO.md`). Counting rows made `spec/mcp-api.md` look 69% refused when
 * three statements had simply been written three times; the honest figure was 43%. A
 * report whose first reading was wrong by that much is worse than none, so it counts
 * what was said rather than how often it was stored.
 */
export function knowledgeReport(store: Store, repo: string, repoId: string): KnowledgeReport {
  const bySource = store.liveKnowledgeBySource(repoId);
  const byDocument = store.knowledgeByDocument(repoId);
  return {
    repo,
    bySource,
    byDocument,
    refusals: store.screenRefusals(repoId),
    unscreened: store.unscreenedDocuments(repoId),
  };
}

/** Right-pad without letting a long path push the columns apart. */
const col = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));

export function renderKnowledge(r: KnowledgeReport, opts: { readonly refusals: boolean } = { refusals: false }): string {
  const out: string[] = [];
  const live = r.bySource.reduce((a, s) => a + s.n, 0);
  out.push(`${r.repo} — ${String(live)} live rules (${r.bySource.map((s) => `${String(s.n)} ${s.source}`).join(", ")})`);

  if (r.unscreened > 0) {
    // A QUEUE, NOT A FAULT, since D-89. Extraction keeps every candidate and the
    // background screen judges them within the hour; a document sitting here is waiting,
    // not broken. It is still worth printing, because a queue that stops draining looks
    // exactly like one that is draining — the number staying put across days is the
    // signal, and it is the operator who can see that and the code that cannot.
    out.push(
      `  ${String(r.unscreened)} document(s) waiting for the screen — every candidate is live and in use;` +
        ` the background pass judges them within the hour. A count that does not fall is a stopped screen`,
    );
  }

  if (r.byDocument.length > 0) {
    out.push("");
    out.push(`  ${col("document", 26)} ${"kept".padStart(5)} ${"refused".padStart(8)}   share`);
    for (const d of r.byDocument) {
      const total = d.kept + d.refused;
      const pct = total === 0 ? "" : `${String(Math.round((100 * d.refused) / total))}%`;
      out.push(`  ${col(d.provenance, 26)} ${String(d.kept).padStart(5)} ${String(d.refused).padStart(8)}   ${pct}`);
    }
    const kept = r.byDocument.reduce((a, d) => a + d.kept, 0);
    const refused = r.byDocument.reduce((a, d) => a + d.refused, 0);
    const all = kept + refused;
    out.push(
      `  ${col("TOTAL", 26)} ${String(kept).padStart(5)} ${String(refused).padStart(8)}   ` +
        `${all === 0 ? "" : `${String(Math.round((100 * refused) / all))}%`}`,
    );
    out.push("");
    // The reading that is not obvious from the numbers, and is the useful one.
    out.push(
      "  A document with a high share is usually not a bad document — it is a spec carrying",
    );
    out.push(
      "  change-narrative that belongs in MEMO.md. Rule documents refuse at 0%.",
    );
  }

  if (opts.refusals && r.refusals.length > 0) {
    out.push("");
    out.push("  refused, with the reason given:");
    for (const f of r.refusals) {
      out.push(`    [${f.provenance}] ${f.statement}`);
      out.push(`        ${f.because}`);
    }
  } else if (r.refusals.length > 0) {
    out.push("");
    out.push(`  ${String(r.refusals.length)} refusal(s) recorded — see them with --refusals`);
  }

  return out.join("\n");
}
