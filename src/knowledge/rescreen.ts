/**
 * Screen the knowledge base in the background, so no review ever waits for it (D-89).
 *
 * The screen decides which extracted candidates are not rules (D-81). It used to run
 * inside `runRound`, before the tier, which put a model call on the critical path of
 * every review that touched a document — and made a dead cheap tier able to wedge a
 * review *before any tier had been asked anything*. On 2026-08-08 that cost four and a
 * half hours: t1's plan was exhausted, six documents had changed, and the round spent the
 * full hang deadline per document without ever reaching a reviewer.
 *
 * **The review never needed it.** A screen that cannot run keeps every candidate and
 * stamps it `<version>-unscreened`, and those rows are LIVE — reviewers have been using
 * them all along. Measured when this was written: 27 of 181 live rules had never been
 * screened, on a service that had been reviewing happily for a week. Waiting bought
 * nothing; it only decided *when* the fragments left the prompt.
 *
 * So the coupling is cut rather than tuned. The deterministic half of the ingest stays on
 * the review's path — it is free, and the review must see today's rules. The model call
 * moves here, on the same timer as the retention sweep.
 *
 * **It works from the ROWS, not from the repository.** The screen's whole input is a
 * document path and a list of candidate statements, and the rows already carry both — so
 * this needs no worktree, no mirror, and no opinion about which branch is current. That
 * is also why it cannot drift from what is actually in the base: it judges exactly the
 * rows a reviewer would be given.
 *
 * SPEC: SPEC.md D-89, spec/knowledge.md §2.2
 */

import { EXTRACTOR_VERSION, UNSCREENED, type Candidate, type Screen } from "./ingest.ts";
import type { Store } from "../store/store.ts";

export interface RescreenResult {
  readonly documents: number;
  readonly kept: number;
  readonly refused: number;
  /** Documents left for the next pass because the tier stopped answering. */
  readonly deferred: number;
  /** When the provider said its limit lifts, if it said so (D-91). */
  readonly retryAfter?: string;
}

/**
 * Judge every live rule that was kept without being screened.
 *
 * Returns counts rather than logging them, so the caller decides what is worth saying —
 * a pass that does nothing is the normal case and must stay silent.
 */
export async function rescreen(store: Store, repoId: string, screen: Screen): Promise<RescreenResult> {
  const rows = store.unscreenedRules(repoId, UNSCREENED);
  if (rows.length === 0) return { documents: 0, kept: 0, refused: 0, deferred: 0 };
  let retryAfter: string | undefined;

  // Grouped by DOCUMENT VERSION, not by document. Two blobs of one file can both have
  // live rules — a row from an older blob survives if nothing re-ingested it — and
  // screening them in one prompt would ask the model about a document that never existed.
  const byDoc = new Map<string, typeof rows>();
  for (const r of rows) {
    // BLOB FIRST, so the join needs no separator that needs escaping. A blob is a
    // fixed-length hex digest and a path is arbitrary, so `path + sep + blob` wants a
    // byte no path can contain — my first attempt used a literal NUL, which made this
    // file invisible to grep. `one-definition.test.ts` caught it, for the second time
    // in this codebase.
    const key = `${r.sourceBlob}:${r.provenance}`;
    byDoc.set(key, [...(byDoc.get(key) ?? []), r]);
  }

  let documents = 0;
  let kept = 0;
  let refused = 0;
  let deferred = 0;

  for (const group of byDoc.values()) {
    const doc = group[0]?.provenance ?? "";
    const candidates: readonly Candidate[] = group.map((r) => ({ statement: r.statement, why: r.why }));
    const out = await screen(doc, candidates);
    if (!out.ran) {
      // The tier could not answer. `screenFor` stops asking for the rest of this pass
      // after a fault that belongs to the tier (D-87), so the remaining documents come
      // back here identically and cheaply — they keep their stamp, stay live, and wait.
      deferred += byDoc.size - documents;
      retryAfter = out.retryAfter;
      break;
    }
    documents++;

    // MATCHED BY STATEMENT, because that is the only thing the screen echoes back. The
    // refusal carries an index into the list we sent and `partition` has already resolved
    // it to the candidate, so the statement is exact rather than fuzzy — but a document
    // that repeats a statement verbatim would collapse two rows onto one verdict, and the
    // conservative direction there is to KEEP: a rule wrongly kept costs a line in a
    // prompt, a rule wrongly dropped is invisible for ever (D-81).
    const refusedText = new Set(out.refused.map((r) => r.statement));
    const because = new Map(out.refused.map((r) => [r.statement, r.because]));
    const keptIds: string[] = [];
    const refusedRows: { id: string; because: string }[] = [];
    for (const r of group) {
      if (refusedText.has(r.statement)) refusedRows.push({ id: r.id, because: because.get(r.statement) ?? "screened out" });
      else keptIds.push(r.id);
    }

    store.settleLateScreen(keptIds, refusedRows, EXTRACTOR_VERSION);
    kept += keptIds.length;
    refused += refusedRows.length;
  }

  return { documents, kept, refused, deferred, ...(retryAfter === undefined ? {} : { retryAfter }) };
}
