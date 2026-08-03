import { beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { DEFAULT_RETENTION, collect, expireStale } from "./retention.ts";

let store: Store;
let repoId: string;

const cfg = { ...DEFAULT_RETENTION, reposRoot: "/tmp/lore-test-repos" };

function review(id: string, state: string, updatedDaysAgo: number): void {
  store.createReview({
    id, repoId, principal: "p", branch: `b-${id}`, intoRef: "main",
    ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
  });
  const when = new Date(Date.now() - updatedDaysAgo * 86_400_000).toISOString();
  store.db.prepare("UPDATE review SET state = ?, updated_at = ? WHERE id = ?").run(state, when, id);
}

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
});

describe("expireStale", () => {
  // A review the developer walked away from told us nothing about the code, and
  // `expired` must not read as though it did.
  it("expires an untouched unfinished review", () => {
    review("r1", "awaiting_diff", 5);
    expect(expireStale(store, cfg)).toBe(1);
    expect(store.getReview("r1", "p")?.state).toBe("expired");
  });

  it("leaves a recent one alone", () => {
    review("r1", "awaiting_diff", 0);
    expect(expireStale(store, cfg)).toBe(0);
  });

  it("never reopens or re-expires a finished review", () => {
    review("r1", "passed", 30);
    expect(expireStale(store, cfg)).toBe(0);
    expect(store.getReview("r1", "p")?.state).toBe("passed");
  });
});

describe("collect", () => {
  it("deletes review rows past the retention window", async () => {
    review("old", "passed", 200);
    review("recent", "passed", 1);

    const r = await collect(store, cfg);
    expect(r.reviewsDeleted).toBe(1);
    expect(store.getReview("old", "p")).toBeUndefined();
    expect(store.getReview("recent", "p")).toBeDefined();
  });

  it("cascades findings and verdicts with the review they belong to", async () => {
    review("old", "passed", 200);
    store.recordFinding("old", {
      fingerprint: "aaaa1111", file: "a.ts", severity: "low", claim: "c",
      evidence: "e", failureScenario: "s", origin: "t1", round: 1,
      firstSeen: "2026-01-01T00:00:00.000Z",
    });
    store.recordVerdict("old", { fingerprint: "aaaa1111", verdict: "fixed", rationale: undefined, scope: undefined, tier: "t1", round: 1 });

    await collect(store, cfg);
    const left = store.db.prepare("SELECT COUNT(*) AS c FROM finding").get() as Record<string, number | bigint>;
    expect(Number(left["c"])).toBe(0);
  });

  // The asymmetry that matters: a deleted review costs one re-run, deleted
  // knowledge costs everything the workgroup ever taught the service.
  it("never touches knowledge, even when its review is deleted", async () => {
    review("old", "passed", 200);
    store.addKnowledge({
      repoId, kind: "rule", source: "derived", statement: "amounts are integers",
      why: "float money", path: undefined, cwe: undefined, provenance: "old",
      sourceBlob: undefined, confidence: 0.7,
    });

    await collect(store, cfg);
    expect(store.getReview("old", "p")).toBeUndefined();
    expect(store.knowledgeFor(repoId)).toHaveLength(1);
  });

  it("survives a worktree directory that is already gone", async () => {
    review("old", "passed", 30);
    // A missing directory is the desired state; failing over one would leave every
    // later one uncollected.
    await expect(collect(store, cfg)).resolves.toBeDefined();
  });
});
