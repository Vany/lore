import { beforeEach, describe, expect, it } from "vitest";
import { Store, type RecordedFinding } from "../store/store.ts";
import { initialState } from "../core/ladder.ts";
import { promoteRecurring, RECURRENCE_THRESHOLD } from "./derive.ts";

let store: Store;
let repoId: string;

function review(id: string): void {
  store.createReview({
    id, repoId, principal: "p", branch: `b-${id}`, intoRef: "main",
    ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
  });
}

const finding = (fp: string, file: string): RecordedFinding => ({
  fingerprint: fp, file, line: 1, symbol: "s", severity: "high",
  claim: "amount held as a JS number", evidence: "e", failureScenario: "s",
  cwe: "CWE-319", origin: "t1", round: 1, firstSeen: "2026-08-03T00:00:00.000Z",
});

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
});

describe("promoteRecurring", () => {
  it("promotes a defect that recurred at least RECURRENCE_THRESHOLD times, only counting fixed ones", () => {
    for (let i = 0; i < RECURRENCE_THRESHOLD; i++) {
      const id = `r${i}`;
      review(id);
      store.recordFinding(id, finding(`fp${i}`, `src/pay/f${i}.ts`));
      store.recordVerdict(id, {
        fingerprint: `fp${i}`, verdict: "fixed", rationale: "fixed it",
        scope: undefined, tier: "t1", round: 1,
      });
    }
    const added = promoteRecurring(store, repoId);
    expect(added.map((k) => k.statement)).toContain(
      `This codebase repeatedly produces CWE-319 findings (${RECURRENCE_THRESHOLD} so far). Check for it explicitly.`,
    );
  });

  it("does not re-run for a cluster it already promoted", () => {
    for (let i = 0; i < RECURRENCE_THRESHOLD; i++) {
      const id = `r${i}`;
      review(id);
      store.recordFinding(id, finding(`fp${i}`, `src/pay/f${i}.ts`));
      store.recordVerdict(id, {
        fingerprint: `fp${i}`, verdict: "fixed", rationale: "fixed it",
        scope: undefined, tier: "t1", round: 1,
      });
    }
    promoteRecurring(store, repoId);
    expect(promoteRecurring(store, repoId)).toStrictEqual([]);
  });

  // Found by lore's own review (b04fcd4e): the idempotence guard (`hasKnowledgeFrom`)
  // only checked LIVE rows, so a mistake rule a person explicitly retired — by
  // resolving a conflict against it, the only way a `mistake` row is ever retired,
  // since it has no source blob for retireForChangedBlob and is never `kind: policy`
  // — looked, to the very next review's promoteRecurring, exactly like a cluster
  // that had never been promoted. Reproduced directly: the identical statement came
  // back with a fresh id, undoing a deliberate human decision silently.
  it("does not resurrect a mistake rule a person deliberately retired by resolving a conflict", () => {
    for (let i = 0; i < RECURRENCE_THRESHOLD; i++) {
      const id = `r${i}`;
      review(id);
      store.recordFinding(id, finding(`fp${i}`, `src/pay/f${i}.ts`));
      store.recordVerdict(id, {
        fingerprint: `fp${i}`, verdict: "fixed", rationale: "fixed it",
        scope: undefined, tier: "t1", round: 1,
      });
    }
    const [mistake] = promoteRecurring(store, repoId);
    expect(mistake).toBeDefined();

    const taughtId = store.addKnowledge({
      repoId, kind: "rule", source: "taught",
      statement: "CWE-319 findings here are already handled by msw, ignore them",
      why: undefined, path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: 1,
    }).id;
    store.recordConflict(repoId, mistake!.id, taughtId);
    expect(store.resolveConflict(repoId, taughtId, mistake!.id, "the derived rule was noise")).toBe(true);

    review("r-later");
    expect(
      promoteRecurring(store, repoId),
      "a person's resolution must not be silently undone by the next review",
    ).toStrictEqual([]);
  });
});
