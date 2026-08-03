/**
 * The product hypothesis, made falsifiable.
 *
 * D-14 says the memory is the product and the reviews are how it gets made. If a
 * later review is no better for what an earlier one learned, we built an expensive
 * linter. `PLAN.md` Phase 2 says to write that as a test rather than a vibe — this
 * is it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Store, type RecordedFinding } from "../store/store.ts";
import { promoteRecurring, clusters, RECURRENCE_THRESHOLD } from "./derive.ts";
import { enrich, relevantTo, renderEnrichment } from "./enrich.ts";
import { initialState } from "../core/ladder.ts";

let store: Store;
let repoId: string;

const finding = (fp: string, over: Partial<RecordedFinding> = {}): RecordedFinding => ({
  fingerprint: fp,
  file: "src/pay/hold.ts",
  line: 1,
  symbol: "capture",
  severity: "high",
  claim: "amount held as a JS number",
  evidence: "e",
  failureScenario: "s",
  cwe: "CWE-681",
  origin: "t1",
  round: 1,
  firstSeen: "2026-08-03T00:00:00.000Z",
  ...over,
});

function review(id: string): void {
  store.createReview({
    id, repoId, principal: "p", branch: `b-${id}`, intoRef: "main",
    ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
  });
}

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
});

describe("what one review learns, the next one knows", () => {
  it("carries an accepted justification into the next review's context", () => {
    review("r1");
    // Review 1: a finding is justified, the reviewer accepts, and the reason
    // becomes lore — this is what runRound does on acceptance.
    store.recordFinding("r1", finding("aaaa1111"));
    store.recordVerdict("r1", {
      fingerprint: "aaaa1111",
      verdict: "justified-accepted",
      rationale: "bounded by the schema check at api/route.ts:31",
      scope: undefined,
      tier: "t1",
      round: 1,
    });
    store.addKnowledge({
      repoId, kind: "rule", source: "derived",
      statement: "bounded by the schema check at api/route.ts:31",
      why: "accepted justification", path: "src/pay", cwe: "CWE-681",
      provenance: "aaaa1111", sourceBlob: undefined, confidence: 0.7,
    });

    // Review 2, a different branch, touching the same area.
    review("r2");
    const known = relevantTo(store, repoId, ["src/pay/hold.ts"]);
    expect(known.map((k) => k.statement)).toContain("bounded by the schema check at api/route.ts:31");
  });

  it("does not hand a reviewer rules about code this change never touches", () => {
    // Everything a repo knows would crowd the diff out of the context window, and
    // a reviewer that cannot see the change reviews nothing.
    store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "reports are paginated",
      why: undefined, path: "src/report", cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: 1,
    });
    store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "amounts are integers in minor units",
      why: undefined, path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: 1,
    });

    const known = relevantTo(store, repoId, ["src/pay/hold.ts"]).map((k) => k.statement);
    expect(known).toContain("amounts are integers in minor units"); // repo-wide, always applies
    expect(known).not.toContain("reports are paginated");
  });

  it("gives a repeated finding its history", () => {
    for (const [i, id] of ["r1", "r2", "r3"].entries()) {
      review(id);
      store.recordFinding(id, finding(`fp${i}`));
    }
    review("r4");
    const current = finding("fp9");
    const e = enrich(store, repoId, current);

    expect(e.priorOccurrences).toBe(3);
    expect(renderEnrichment(e)).toContain("this is a pattern, not an incident");
  });
});

describe("recurrence becomes a rule", () => {
  it("promotes a defect seen enough times", () => {
    // The fourth occurrence is not four bugs; it is one missing rule.
    for (let i = 0; i < RECURRENCE_THRESHOLD; i++) {
      review(`r${i}`);
      store.recordFinding(`r${i}`, finding(`fp${i}`));
    }
    expect(clusters(store, repoId).length).toBeGreaterThan(0);

    const promoted = promoteRecurring(store, repoId);
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.some((k) => k.kind === "mistake")).toBe(true);
    expect(promoted.some((k) => k.cwe === "CWE-681")).toBe(true);
  });

  it("stays quiet below the threshold, so a coincidence is not made into a rule", () => {
    review("r1");
    store.recordFinding("r1", finding("fp1"));
    expect(promoteRecurring(store, repoId)).toStrictEqual([]);
  });

  it("does not re-promote the same lesson on every review", () => {
    for (let i = 0; i < RECURRENCE_THRESHOLD; i++) {
      review(`r${i}`);
      store.recordFinding(`r${i}`, finding(`fp${i}`));
    }
    promoteRecurring(store, repoId);
    expect(promoteRecurring(store, repoId)).toStrictEqual([]);
  });

  it("clusters a weakness class across differently-worded findings", () => {
    // What the exact fingerprint cannot do, and the reason CWE is on a finding.
    review("r1");
    store.recordFinding("r1", finding("fp1", { claim: "amount held as a JS number" }));
    review("r2");
    store.recordFinding("r2", finding("fp2", { claim: "float used for a currency value" }));
    review("r3");
    store.recordFinding("r3", finding("fp3", { claim: "price stored as a double" }));

    const cwe = clusters(store, repoId).filter((c) => c.kind === "cwe");
    expect(cwe).toHaveLength(1);
    expect(cwe[0]?.count).toBe(3);
  });
});
