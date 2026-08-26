import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { detectAndRecord, findConflicts, polarity, renderConflicts } from "./conflict.ts";
import type { KnowledgeItem } from "../store/store.ts";

const item = (id: string, statement: string, path?: string): KnowledgeItem => ({
  id,
  repoId: "r",
  kind: "rule",
  source: "taught",
  statement,
  why: undefined,
  path,
  cwe: undefined,
  provenance: undefined,
  sourceBlob: undefined,
  confidence: 1,
  verifiedAt: "2026-08-03T00:00:00.000Z",
});

describe("polarity", () => {
  it("reads a plain claim as positive and a negated one as negative", () => {
    expect(polarity("amounts are integers in minor units")).toBe(1);
    expect(polarity("amounts must never be floats")).toBe(-1);
  });

  // A genuine double negative reads as positive. Only explicit negation words
  // count: "must not be absent" reads as negative here, and that is correct for
  // conflict detection — it contradicts "must be absent", which is the point.
  it("cancels a genuine double negation", () => {
    expect(polarity("never avoid checking the return value")).toBe(1);
    expect(polarity("the field must not be absent")).toBe(-1);
  });
});

describe("findConflicts", () => {
  it("flags the same subject asserted both ways", () => {
    const found = findConflicts([
      item("a", "money amounts are always integers in minor units"),
      item("b", "money amounts are never integers in minor units"),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.similarity).toBeGreaterThan(0.5);
  });

  it("leaves agreeing rules alone", () => {
    expect(
      findConflicts([
        item("a", "money amounts are always integers in minor units"),
        item("b", "money amounts are always stored as integers in minor units"),
      ]),
    ).toStrictEqual([]);
  });

  it("leaves unrelated rules alone even when polarity differs", () => {
    expect(
      findConflicts([
        item("a", "money amounts are always integers"),
        item("b", "log lines must never contain tokens"),
      ]),
    ).toStrictEqual([]);
  });

  // Two rules about different directories are two rules, not a contradiction.
  it("respects path scope", () => {
    expect(
      findConflicts([
        item("a", "requests are always retried on timeout", "src/pay"),
        item("b", "requests are never retried on timeout", "src/report"),
      ]),
    ).toStrictEqual([]);
  });

  // Found by lore's own review (372b6bf0, f9559e98): `scopesOverlap` used to be a
  // raw `startsWith`, so "src/payroll".startsWith("src/pay") — sibling directories
  // sharing a text prefix, not one containing the other — read as the same scope,
  // and this repo's own test suite never caught it because "respects path scope"
  // above uses two paths sharing no prefix at all.
  it("does not treat sibling directories sharing a text prefix as the same scope", () => {
    expect(
      findConflicts([
        item("a", "requests to the payments api are always retried on timeout", "src/pay"),
        item("b", "requests to the payroll adapter are never retried on timeout", "src/payroll"),
      ]),
    ).toStrictEqual([]);
  });

  it("treats an unscoped rule as repo-wide, so it can conflict with a scoped one", () => {
    expect(
      findConflicts([
        item("a", "requests are always retried on timeout"),
        item("b", "requests are never retried on timeout", "src/pay"),
      ]),
    ).toHaveLength(1);
  });
});

describe("detectAndRecord", () => {
  let store: Store;
  let repoId: string;

  beforeEach(() => {
    store = new Store(":memory:");
    repoId = store.upsertRepo("r", "git@x:r.git").id;
  });

  const add = (statement: string) =>
    store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement, why: undefined, path: undefined,
      cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: 1,
    });

  it("records a contradiction rather than resolving it", () => {
    add("money amounts are always integers in minor units");
    add("money amounts are never integers in minor units");

    expect(detectAndRecord(store, repoId).recorded).toBe(1);
    // Both rules survive. The store's job is to make the contradiction seen;
    // deciding it needs someone who can read the code.
    expect(store.knowledgeFor(repoId)).toHaveLength(2);
    expect(store.openConflicts(repoId)).toHaveLength(1);
  });

  it("does not record the same pair twice across runs", () => {
    add("money amounts are always integers in minor units");
    add("money amounts are never integers in minor units");
    detectAndRecord(store, repoId);
    expect(detectAndRecord(store, repoId).recorded).toBe(0);
  });

  it("tells the reviewer it must not lore-ok its way past a conflict", () => {
    add("money amounts are always integers in minor units");
    add("money amounts are never integers in minor units");
    detectAndRecord(store, repoId);
    const rendered = renderConflicts(store, repoId);
    expect(rendered).toContain("do not close it with lore-ok");
    expect(rendered).toContain("If you cannot decide");
  });

  it("renders nothing when there is nothing to settle", () => {
    expect(renderConflicts(store, repoId)).toBe("");
  });

  // Found by lore's own review (592cd49f): nothing that retires a rule for a reason
  // OTHER than resolving a conflict (a document changing under retireForChangedBlob,
  // retirePolicy, settleLateScreen) ever touched knowledge_conflict — so a conflict
  // stayed open, and blocking (openConflicts feeds needsHuman directly), forever once
  // either side was gone. Worse: renderConflicts builds its lookup from LIVE rows
  // only and silently drops a pair it cannot fully resolve, so the reviewer would be
  // told "CONTRADICTIONS TO RESOLVE" and shown nothing under it — needs_human with no
  // way to ever clear it, since resolveConflict (the only thing that closes a row)
  // needs a live pair to retire one side of.
  it("stops blocking once a document edit retires one side of a recorded conflict", () => {
    const withProvenance = (statement: string) =>
      store.addKnowledge({
        repoId, kind: "rule", source: "ingested", statement, why: undefined, path: undefined,
        cwe: undefined, provenance: "PROG.md", sourceBlob: "blob-v1", confidence: 1,
      });
    withProvenance("money amounts are always integers in minor units");
    withProvenance("money amounts are never integers in minor units");
    detectAndRecord(store, repoId);
    expect(store.openConflicts(repoId)).toHaveLength(1);

    // The ordinary D-20 re-derive path: PROG.md changed, so its rules are retired —
    // nothing here is "resolving" the contradiction, the document just moved on.
    store.retireForChangedBlob(repoId, "PROG.md", "blob-v2", "deterministic-v1");

    expect(
      store.openConflicts(repoId),
      "a conflict naming a retired rule cannot be settled by anyone and must not block passing",
    ).toHaveLength(0);
    expect(
      renderConflicts(store, repoId),
      "must not show an empty CONTRADICTIONS TO RESOLVE section with nothing to resolve",
    ).toBe("");
  });

  it("keeps blocking when both sides of a conflict are still live", () => {
    add("money amounts are always integers in minor units");
    add("money amounts are never integers in minor units");
    detectAndRecord(store, repoId);

    expect(store.openConflicts(repoId)).toHaveLength(1);
    expect(renderConflicts(store, repoId).length).toBeGreaterThan(0);
  });
});

// THE FIRST TIME needs_human EVER FIRED IN PRODUCTION, IT WAS WRONG.
//
// Two ADR sentences saying the same thing were recorded as a contradiction and
// stopped a real review whose findings were all settled. Double negation cancels
// within one proposition — "must not be absent" is positive — but it was applied to
// the whole statement, and a compound sentence with two INDEPENDENT negative clauses
// came out positive, the opposite of what it says.
describe("polarity does not cancel across independent clauses", () => {
  const SEAM_A =
    "Everything else in 0018 stands: the gateway owns the 1500 ms budget, the issuer target is configuration, " +
    "and the seam holds no balance and never calls the ledger";
  const SEAM_B =
    "Everything else in both stands — the gateway still owns the 1500 ms budget, the issuer target is still " +
    "configuration, the seam still never touches the ledger";

  it("calls a statement with clauses pulling both ways undecidable, not positive", () => {
    // 0, not 1. "I cannot reduce this to one polarity" beats picking the wrong one.
    expect(polarity(SEAM_A)).toBe(0);
    expect(polarity(SEAM_B)).toBe(0);
  });

  it("does not record two restatements of the same rule as a contradiction", () => {
    expect(findConflicts([item("a", SEAM_A), item("b", SEAM_B)])).toStrictEqual([]);
  });

  // Single-proposition double negation still cancels — that part was right, and it
  // only works for negations the regex actually knows. "must not be ABSENT" is a
  // double negative to a reader and a single one here, because `absent` is not in
  // NEGATIONS; the old doc comment used it as its example and was describing an
  // intention rather than the behaviour.
  it("still cancels a double negative built from words it recognises", () => {
    expect(polarity("A round must not run without a tree hash")).toBe(1);
    expect(polarity("A round must run with a tree hash")).toBe(1);
    expect(polarity("A round must not run")).toBe(-1);
  });

  // The trade is deliberate: skipping an undecidable statement can miss a
  // contradiction, and that costs a rule left to be caught later. A FALSE one stops a
  // review and demands a person, which is what happened.
  it("still catches a real contradiction about the same subject", () => {
    const found = findConflicts([
      item("x", "The ledger must allow a negative balance"),
      item("y", "The ledger must not allow a negative balance"),
    ]);
    expect(found).toHaveLength(1);
  });
});

// Found by lore's own review (a0f27140): the split above used to omit `.`, reasoned
// as "the failure was WITHIN one sentence" — true of the ORIGINAL incident above, but
// not a reason to exclude periods. The identical rule written as two sentences hits
// the same compounding bug the SEAM tests above exist to prevent, just across a
// sentence break instead of a comma/and/but/while.
describe("polarity does not cancel across a sentence break either (a0f27140)", () => {
  const twoSentences = "The gateway must never retry captures. Retries must not double-charge customers.";
  const oneClauseJoined = "The gateway must never retry captures; retries must not double-charge customers";

  it("reads the same rule the same way whether it is one clause-joined statement or two sentences", () => {
    expect(polarity(twoSentences)).toBe(polarity(oneClauseJoined));
    expect(polarity(twoSentences)).toBe(-1);
  });

  it("does not record two phrasings of the same rule as a contradiction", () => {
    expect(findConflicts([item("a", twoSentences), item("b", oneClauseJoined)])).toStrictEqual([]);
  });
});
