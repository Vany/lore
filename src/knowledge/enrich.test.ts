import { beforeEach, describe, expect, it } from "vitest";
import { Store, type RecordedFinding } from "../store/store.ts";
import { initialState } from "../core/ladder.ts";
import { enrich, renderEnrichment } from "./enrich.ts";

let store: Store;
let repoId: string;
let n = 0;

function review(): string {
  const id = `r${n++}`;
  store.createReview({
    id, repoId, principal: "p", branch: `b-${id}`, intoRef: "main",
    ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
  });
  return id;
}

function finding(overrides: Partial<RecordedFinding> & { fingerprint: string; claim: string }): RecordedFinding {
  return {
    file: "src/a.ts", line: 1, symbol: "s", severity: "high",
    evidence: "e", failureScenario: "s", cwe: undefined,
    origin: "t1", round: 1, firstSeen: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
  n = 0;
});

describe("enrich (4029f8b3: a shared CWE alone is not a shared defect)", () => {
  it("does not count unrelated findings that only share a common CWE as prior occurrences", () => {
    // Forty unrelated CWE-754 findings, each about a different thing in a different
    // file, mostly justified away — none of them related to each other or to the
    // finding under test beyond the taxonomy entry.
    for (let i = 0; i < 40; i++) {
      const id = review();
      const fp = `unrelated-${i}`;
      store.recordFinding(
        id,
        finding({
          fingerprint: fp,
          file: `src/module${i}/thing.ts`,
          claim: `subsystem ${i} skips a null check on its own internal cache handle`,
          cwe: "CWE-754",
        }),
      );
      store.recordVerdict(id, {
        fingerprint: fp,
        verdict: i % 5 === 0 ? "fixed" : "justified-accepted",
        rationale: "not applicable here",
        scope: undefined, tier: "t1", round: 1,
      });
    }

    const brandNew = finding({
      fingerprint: "brand-new",
      file: "src/pay/hold.ts",
      claim: "a released hold's timer is never cancelled, so it can fire twice",
      cwe: "CWE-754",
    });
    review();
    const e = enrich(store, repoId, brandNew);

    expect(e.priorOccurrences, "40 unrelated same-CWE findings must not read as 40 priors").toBe(0);
    expect(e.priorJustified).toBe(0);
    expect(e.priorFixed).toBe(0);

    const rendered = renderEnrichment(e);
    expect(
      rendered === undefined ? false : rendered.includes("TELL YOUR USER"),
      `must not fabricate a misfire escalation off an unrelated CWE bucket, got: ${String(rendered)}`,
    ).toBe(false);
  });

  it("still counts a genuine paraphrase of the same defect under a shared CWE (D-44)", () => {
    const claims = [
      "the payment amount is stored as a float instead of an integer number of minor units",
      "ledger amount kept as a float rather than an integer count of minor units",
      "balance amount stored using a float instead of an integer in minor units",
    ];
    for (const [i, claim] of claims.entries()) {
      const id = review();
      const fp = `paraphrase-${i}`;
      store.recordFinding(id, finding({ fingerprint: fp, file: `src/pay/f${i}.ts`, claim, cwe: "CWE-1339" }));
      store.recordVerdict(id, {
        fingerprint: fp, verdict: "justified-accepted", rationale: "not a real issue here",
        scope: undefined, tier: "t1", round: 1,
      });
    }

    const again = finding({
      fingerprint: "paraphrase-new",
      file: "src/pay/f9.ts",
      claim: "hold amount is stored as a float instead of an integer number of minor units",
      cwe: "CWE-1339",
    });
    review();
    const e = enrich(store, repoId, again);

    expect(e.priorOccurrences, "a real recurring paraphrase must still be caught").toBeGreaterThanOrEqual(2);
    expect(e.priorJustified).toBeGreaterThanOrEqual(2);
  });
});

// Found by lore's own review (10bb335b): a fourth copy of the raw-prefix scoping bug
// already fixed in relevantTo, conflict.ts's scopesOverlap and store.ts's
// knowledgeFor (372b6bf0/f9559e98) — relatedTo's own path-boost term was missed when
// those three were fixed together, ~75 lines above in this same file.
describe("enrich (10bb335b: relatedTo's path boost is a sibling-directory bug too)", () => {
  it("does not boost a rule into 'related' just because a sibling directory shares a text prefix", () => {
    store.addKnowledge({
      repoId, kind: "rule", source: "taught",
      statement: "Payments must retry on timeout and log the retry count",
      why: undefined, path: "src/pay", cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: 1,
    });

    // Token overlap alone scores 0.2, under RELATED_THRESHOLD (0.35) — only a wrongly
    // applied path boost (+0.2, "src/payroll/adapter.ts".startsWith("src/pay")) would
    // cross it.
    const f = finding({
      fingerprint: "payroll-1",
      file: "src/payroll/adapter.ts",
      claim: "The payroll adapter must retry declined captures on timeout",
    });
    const e = enrich(store, repoId, f);

    expect(
      e.related.some((k) => k.statement.includes("retry on timeout")),
      "a rule scoped to src/pay must not be handed to a src/payroll finding as related",
    ).toBe(false);
  });

  it("does boost a rule genuinely scoped to the finding's own directory (control)", () => {
    store.addKnowledge({
      repoId, kind: "rule", source: "taught",
      statement: "Payments must retry on timeout and log the retry count",
      why: undefined, path: "src/pay", cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: 1,
    });

    const f = finding({
      fingerprint: "pay-1",
      file: "src/pay/adapter.ts",
      claim: "The pay adapter must retry declined captures on timeout",
    });
    const e = enrich(store, repoId, f);

    expect(e.related.some((k) => k.statement.includes("retry on timeout"))).toBe(true);
  });
});
