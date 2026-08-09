/**
 * The screen judges the base afterwards, and no review waits for it (D-89).
 *
 * What is under test here is the part that used to be free and became load-bearing: a
 * rule kept WITHOUT being judged is live and in every reviewer's prompt, and the only
 * thing that ever came back for it was the next review of the same repository. That is
 * how 27 of 181 live rules came to be unscreened on a service that had been reviewing
 * for a week.
 *
 * The direction of every fixture is the one D-81 sets: a rule wrongly kept costs a line
 * in a prompt, a rule wrongly dropped is invisible for ever. So the failure paths are
 * where the assertions are.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { EXTRACTOR_VERSION, UNSCREENED, type Screen } from "./ingest.ts";
import { rescreen } from "./rescreen.ts";

const seed = (): { store: Store; repoId: string } => {
  const store = new Store(":memory:");
  const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
  return { store, repoId };
};

const rule = (store: Store, repoId: string, statement: string, doc: string, blob: string, extractor: string) =>
  store.addKnowledge({
    repoId, kind: "rule", source: "ingested", statement, why: undefined,
    path: undefined, cwe: undefined, provenance: doc, sourceBlob: blob,
    extractor, confidence: 0.8,
  });

/** Refuses exactly the statements named, keeps the rest, and says it ran. */
const refusing = (...refuse: readonly string[]): Screen =>
  (_doc, candidates) =>
    Promise.resolve({
      kept: candidates.filter((c) => !refuse.includes(c.statement)),
      refused: candidates.filter((c) => refuse.includes(c.statement)).map((c) => ({ statement: c.statement, because: "a topic label" })),
      ran: true,
    });

/** What `screenFor` returns when the TIER could not answer at all. */
const cannotRun: Screen = (_doc, candidates) =>
  Promise.resolve({ kept: candidates, refused: [], ran: false, tierFault: true });

/**
 * What it returns when THIS DOCUMENT was the problem — too large for the tier's window.
 *
 * `ran: false` alone covered both, and treating them alike meant one oversized file ended
 * the pass and got a healthy tier marked unavailable for an hour. D-87 draws the line;
 * this fixture is the half that was missing when it was drawn.
 */
const tooLarge: Screen = (_doc, candidates) =>
  Promise.resolve({ kept: candidates, refused: [], ran: false, tierFault: false });

describe("screening the base after the fact", () => {
  it("retires what the screen refuses and promotes what it keeps", async () => {
    const { store, repoId } = seed();
    const keep = rule(store, repoId, "A rule never outlives the text that justified it", "SPEC.md", "b1", UNSCREENED);
    const drop = rule(store, repoId, "Two things a client must get right", "SPEC.md", "b1", UNSCREENED);

    const r = await rescreen(store, repoId, refusing("Two things a client must get right"));

    expect(r).toStrictEqual({ documents: 1, kept: 1, refused: 1, deferred: 0 });
    const row = (id: string) =>
      store.db.prepare("SELECT retired_reason, extractor FROM knowledge WHERE id = ?").get(id) as Record<string, string | null>;
    // Promoted OUT of the unscreened stamp, so it is not asked about again every hour.
    expect(row(keep.id)["extractor"]).toBe(EXTRACTOR_VERSION);
    expect(row(keep.id)["retired_reason"]).toBeNull();
    // RETIRED IN PLACE, carrying the model's reason. "Why is that rule not in the base"
    // is the whole objection to filtering, and this row is the answer to it.
    expect(row(drop.id)["retired_reason"]).toBe("screened out: a topic label");
    expect(row(drop.id)["extractor"], "and it leaves the backlog too").toBe(EXTRACTOR_VERSION);
    store.close();
  });

  // The normal case, every hour, for ever. It must cost NOTHING — not a model call, not
  // a write — or an idle service quietly spends a subscription on nothing.
  it("asks nothing when there is no backlog", async () => {
    const { store, repoId } = seed();
    rule(store, repoId, "already judged", "SPEC.md", "b1", EXTRACTOR_VERSION);
    let asked = 0;
    const counting: Screen = (...args) => {
      asked++;
      return refusing()(...args);
    };

    const r = await rescreen(store, repoId, counting);

    expect(asked).toBe(0);
    expect(r).toStrictEqual({ documents: 0, kept: 0, refused: 0, deferred: 0 });
    store.close();
  });

  /**
   * A TIER THAT CANNOT ANSWER CHANGES NOTHING, and this is the property that makes the
   * whole feature safe to run unattended.
   *
   * The rows keep their stamp, stay live, and come back next hour. If a failed pass
   * retired anything — or promoted anything — an outage would silently edit the knowledge
   * base, which is the product.
   */
  it("leaves the base untouched when the tier cannot answer", async () => {
    const { store, repoId } = seed();
    const a = rule(store, repoId, "one", "SPEC.md", "b1", UNSCREENED);
    const b = rule(store, repoId, "two", "PROG.md", "b2", UNSCREENED);

    const r = await rescreen(store, repoId, cannotRun);

    expect(r.documents).toBe(0);
    expect(r.deferred, "both documents wait, and the count says so").toBe(2);
    for (const id of [a.id, b.id]) {
      const row = store.db.prepare("SELECT retired_reason, extractor FROM knowledge WHERE id = ?").get(id) as Record<string, string | null>;
      expect(row["retired_reason"]).toBeNull();
      expect(row["extractor"], "still in the backlog, so the next pass retries it").toBe(UNSCREENED);
    }
    store.close();
  });

  it("keeps going when it was the DOCUMENT that could not be screened", async () => {
    const { store, repoId } = seed();
    const a = rule(store, repoId, "one", "SPEC.md", "b1", UNSCREENED);
    const b = rule(store, repoId, "two", "PROG.md", "b2", UNSCREENED);
    let asked = 0;
    const counting: Screen = (doc, candidates) => {
      asked++;
      return tooLarge(doc, candidates);
    };

    const r = await rescreen(store, repoId, counting);

    expect(asked, "the next document may be a tenth the size").toBe(2);
    expect(r.deferred, "nothing is deferred: the tier is fine").toBe(0);
    // And nothing was marked, in either direction — the documents keep their stamp.
    for (const id of [a.id, b.id]) {
      const row = store.db.prepare("SELECT extractor FROM knowledge WHERE id = ?").get(id) as Record<string, string>;
      expect(row["extractor"]).toBe(UNSCREENED);
    }
    store.close();
  });

  /**
   * A DOCUMENT THAT REPEATS A STATEMENT IS AMBIGUOUS, AND AMBIGUITY KEEPS.
   *
   * The screen echoes back an index, which `partition` resolves to a candidate — but two
   * rows carrying identical text cannot be told apart afterwards, so one refusal used to
   * retire both. D-81's asymmetry decides it: a rule wrongly kept costs a line in a
   * prompt, a rule wrongly dropped is invisible to everyone for ever.
   */
  it("keeps every copy when a repeated statement is refused", async () => {
    const { store, repoId } = seed();
    const a = rule(store, repoId, "Cost. Something must happen", "SPEC.md", "b1", UNSCREENED);
    const b = rule(store, repoId, "Cost. Something must happen", "SPEC.md", "b1", UNSCREENED);
    const c = rule(store, repoId, "A rule that is only here once", "SPEC.md", "b1", UNSCREENED);

    await rescreen(store, repoId, refusing("Cost. Something must happen", "A rule that is only here once"));

    const reason = (id: string) =>
      (store.db.prepare("SELECT retired_reason FROM knowledge WHERE id = ?").get(id) as Record<string, string | null>)["retired_reason"];
    expect(reason(a.id), "ambiguous, so kept").toBeNull();
    expect(reason(b.id), "ambiguous, so kept").toBeNull();
    // The unambiguous one is still refused: this must not become "never retire anything".
    expect(reason(c.id)).toBe("screened out: a topic label");
    store.close();
  });

  // One prompt per document, because the screen's question is about a document's
  // candidates as a set — "which of THESE are not rules?" — and a prompt mixing two files
  // asks something nobody meant.
  it("asks once per document, not once per rule", async () => {
    const { store, repoId } = seed();
    rule(store, repoId, "one", "SPEC.md", "b1", UNSCREENED);
    rule(store, repoId, "two", "SPEC.md", "b1", UNSCREENED);
    rule(store, repoId, "three", "PROG.md", "b2", UNSCREENED);
    const docs: string[] = [];
    const recording: Screen = (doc, candidates) => {
      docs.push(`${doc}:${String(candidates.length)}`);
      return refusing()(doc, candidates);
    };

    await rescreen(store, repoId, recording);

    expect(docs.sort()).toStrictEqual(["PROG.md:1", "SPEC.md:2"]);
    store.close();
  });

  // Two versions of one file can both have live rules — a row from an older blob survives
  // if nothing re-ingested it. Screening them together would ask the model about a
  // document that never existed in that form.
  it("does not mix two versions of one document into one question", async () => {
    const { store, repoId } = seed();
    rule(store, repoId, "old wording", "SPEC.md", "blob-old", UNSCREENED);
    rule(store, repoId, "new wording", "SPEC.md", "blob-new", UNSCREENED);
    const sizes: number[] = [];
    const recording: Screen = (doc, candidates) => {
      sizes.push(candidates.length);
      return refusing()(doc, candidates);
    };

    await rescreen(store, repoId, recording);

    expect(sizes).toStrictEqual([1, 1]);
    store.close();
  });
});
