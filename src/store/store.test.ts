import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmbiguousFingerprint } from "../core/errors.ts";
import { initialState } from "../core/ladder.ts";
import { SCHEMA_VERSION, applyMigrations } from "./schema.ts";
import { Store, type RecordedFinding } from "./store.ts";

let store: Store;
let repoId: string;
const PRINCIPAL = "tok_alice";

const finding = (fp: string, over: Partial<RecordedFinding> = {}): RecordedFinding => ({
  fingerprint: fp,
  file: "src/pay/hold.ts",
  line: 12,
  symbol: "capture",
  severity: "high",
  claim: `claim ${fp}`,
  evidence: "evidence",
  failureScenario: "scenario",
  origin: "t1",
  round: 1,
  firstSeen: "2026-08-03T00:00:00.000Z",
  ...over,
});

function newReview(id: string, principal = PRINCIPAL): void {
  store.createReview({
    id,
    repoId,
    principal,
    branch: "feat/x",
    intoRef: "origin/main",
    ticket: "do the thing",
    type: "code-arch",
    state: "running",
    ladder: initialState(),
  });
}

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@github.com:acme/demo.git").id;
});

describe("repo", () => {
  it("is idempotent on the git url", () => {
    const again = store.upsertRepo("demo-renamed", "git@github.com:acme/demo.git");
    expect(again.id).toBe(repoId);
  });
});

describe("review", () => {
  // Possession of a review id is never authentication (D-23). Another principal
  // presenting a VALID id must fail exactly as a forged one does.
  it("refuses to hand a review to a different principal", () => {
    newReview("rev1");
    expect(store.getReview("rev1", PRINCIPAL)).toBeDefined();
    expect(store.getReview("rev1", "tok_mallory")).toBeUndefined();
  });

  it("round-trips ladder state", () => {
    newReview("rev1");
    const ladder = { ...initialState(), round: 4, settled: ["aa"] };
    store.updateReview("rev1", { ladder, state: "awaiting_diff" });
    const got = store.getReview("rev1", PRINCIPAL);
    expect(got?.ladder.round).toBe(4);
    expect(got?.state).toBe("awaiting_diff");
  });
});

describe("findings", () => {
  beforeEach(() => newReview("rev1"));

  it("records once and reports whether it was new", () => {
    expect(store.recordFinding("rev1", finding("aaaa1111"))).toBe(true);
    expect(store.recordFinding("rev1", finding("aaaa1111"))).toBe(false);
  });

  // Poll returns deltas. In an LLM-driven loop a duplicate finding is
  // indistinguishable from real work, and costs a whole fix cycle.
  it("hands each finding to the client exactly once", () => {
    store.recordFinding("rev1", finding("aaaa1111"));
    store.recordFinding("rev1", finding("bbbb2222"));
    const first = store.undelivered("rev1");
    expect(first).toHaveLength(2);
    store.markDelivered("rev1", first.map((f) => f.fingerprint));
    expect(store.undelivered("rev1")).toHaveLength(0);
  });

  it("preserves optional fields as absent rather than null", () => {
    store.recordFinding("rev1", { ...finding("cccc3333"), line: undefined, symbol: undefined, cwe: "CWE-89" });
    const got = store.undelivered("rev1").find((f) => f.fingerprint === "cccc3333");
    expect(got).toBeDefined();
    expect("line" in (got ?? {})).toBe(false);
    expect(got?.cwe).toBe("CWE-89");
  });
});

describe("resolveShort", () => {
  beforeEach(() => newReview("rev1"));

  it("resolves an unambiguous short id", () => {
    store.recordFinding("rev1", finding("a1b2c3d4ffff"));
    expect(store.resolveShort("rev1", "a1b2c3d4")).toBe("a1b2c3d4ffff");
  });

  // This USED to throw, and that broke the loop in production. A source tree carries
  // lore-ok comments from every review that ever ran against it, and a fingerprint
  // belongs to the review that raised it — so an accepted justification matches
  // nothing next time. Throwing killed the second review of any repo using the
  // feature, and lore's own docs (which show `lore-ok[a1b2c3d4]` as the example
  // format) killed the first.
  it("returns undefined when nothing matches, because that is the normal case", () => {
    expect(store.resolveShort("rev1", "deadbeef")).toBeUndefined();
  });

  // Picking a winner would close a defect nobody examined. Git's rule.
  it("refuses to guess when two findings share a prefix", () => {
    store.recordFinding("rev1", finding("a1b2c3d40001"));
    store.recordFinding("rev1", finding("a1b2c3d40002"));
    expect(() => store.resolveShort("rev1", "a1b2c3d4")).toThrow(AmbiguousFingerprint);
  });
});

describe("verdicts", () => {
  beforeEach(() => newReview("rev1"));

  it("counts fixed and accepted as settled, but not rejected", () => {
    store.recordVerdict("rev1", { fingerprint: "aa", verdict: "fixed", rationale: undefined, scope: undefined, tier: "t1", round: 1 });
    store.recordVerdict("rev1", { fingerprint: "bb", verdict: "justified-accepted", rationale: "bounded upstream", scope: undefined, tier: "t1", round: 1 });
    store.recordVerdict("rev1", { fingerprint: "cc", verdict: "justified-rejected", rationale: "not good enough", scope: undefined, tier: "t2", round: 2 });
    expect([...store.settledFingerprints("rev1")].sort()).toStrictEqual(["aa", "bb"]);
  });

  // Verdicts are append-only, so "settled" must mean the LATEST one. Matching any
  // historical row would leave a justification settled forever after it had been
  // rejected — precisely the rubber-stamping this design exists to prevent.
  it("unsettles a finding whose justification is later rejected", () => {
    store.recordVerdict("rev1", { fingerprint: "aa", verdict: "justified-accepted", rationale: "bounded", scope: undefined, tier: "t1", round: 1 });
    expect(store.settledFingerprints("rev1")).toContain("aa");

    store.recordVerdict("rev1", { fingerprint: "aa", verdict: "justified-rejected", rationale: "expired: code changed", scope: undefined, tier: "expiry", round: 0 });
    expect(store.settledFingerprints("rev1")).not.toContain("aa");
  });

  it("re-settles when a later verdict accepts again", () => {
    store.recordVerdict("rev1", { fingerprint: "aa", verdict: "justified-rejected", rationale: "no", scope: undefined, tier: "t1", round: 1 });
    store.recordVerdict("rev1", { fingerprint: "aa", verdict: "fixed", rationale: undefined, scope: undefined, tier: "t1", round: 2 });
    expect(store.settledFingerprints("rev1")).toContain("aa");
  });

  it("keeps the latest verdict for a finding", () => {
    store.recordVerdict("rev1", { fingerprint: "aa", verdict: "justified-accepted", rationale: "first", scope: { blob: "b1", hunk: "h1" }, tier: "t1", round: 1 });
    store.recordVerdict("rev1", { fingerprint: "aa", verdict: "justified-rejected", rationale: "second", scope: undefined, tier: "t2", round: 2 });
    const latest = store.latestVerdict("rev1", "aa");
    expect(latest?.verdict).toBe("justified-rejected");
    expect(latest?.rationale).toBe("second");
  });

  it("excludes settled findings from the open set", () => {
    store.recordFinding("rev1", finding("aaaa1111"));
    store.recordFinding("rev1", finding("bbbb2222"));
    store.recordVerdict("rev1", { fingerprint: "aaaa1111", verdict: "fixed", rationale: undefined, scope: undefined, tier: "t1", round: 1 });
    expect(store.openFindings("rev1").map((f) => f.fingerprint)).toStrictEqual(["bbbb2222"]);
  });
});

describe("knowledge", () => {
  it("retires rules whose source document changed", () => {
    // The single guard against the knowledge base rotting: a stale doc must never
    // become a confidently wrong rule injected into every future session.
    store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "amounts are integers in minor units",
      why: "float money", path: "src/pay", cwe: undefined, provenance: "PROG.md",
      sourceBlob: "blobA", confidence: 0.9,
    });
    expect(store.knowledgeFor(repoId)).toHaveLength(1);
    expect(store.retireForChangedBlob(repoId, "PROG.md", "blobB")).toBe(1);
    expect(store.knowledgeFor(repoId)).toHaveLength(0);
  });

  it("keeps rules whose source is unchanged", () => {
    store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "s", why: undefined, path: undefined,
      cwe: undefined, provenance: "PROG.md", sourceBlob: "blobA", confidence: undefined,
    });
    expect(store.retireForChangedBlob(repoId, "PROG.md", "blobA")).toBe(0);
    expect(store.knowledgeFor(repoId)).toHaveLength(1);
  });

  it("records conflicts rather than resolving them", () => {
    const a = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "always X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    const b = store.addKnowledge({ repoId, kind: "rule", source: "derived", statement: "never X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    store.recordConflict(repoId, a.id, b.id);
    expect(store.openConflicts(repoId)).toStrictEqual([{ left: a.id, right: b.id, state: "open" }]);
  });

  it("settles a conflict by retiring the losing rule, with the reason", () => {
    const keep = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "always X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    const lose = store.addKnowledge({ repoId, kind: "rule", source: "derived", statement: "never X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    store.recordConflict(repoId, keep.id, lose.id);

    expect(store.resolveConflict(repoId, keep.id, lose.id, "the schema was changed in July")).toBe(true);
    // Unblocked: the review can pass again. A question with no way to answer it
    // would be a trap rather than a safeguard.
    expect(store.openConflicts(repoId)).toStrictEqual([]);
    expect(store.knowledgeFor(repoId).map((k) => k.id)).toStrictEqual([keep.id]);
  });

  it("refuses to settle a conflict that was never recorded", () => {
    expect(store.resolveConflict(repoId, "nope-a", "nope-b", "because")).toBe(false);
  });

  // Escalating is not progress toward passing. It states that passing requires
  // someone who has not looked yet.
  it("keeps blocking when a conflict is escalated to a human", () => {
    const a = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "always X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    const b = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "never X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    store.recordConflict(repoId, a.id, b.id);
    store.escalateConflict(repoId, a.id, b.id, "both rules were written by people; I cannot pick");

    expect(store.openConflicts(repoId)).toStrictEqual([{ left: a.id, right: b.id, state: "needs-human" }]);
  });
});

describe("usage and jobs", () => {
  it("sums spend since a timestamp", () => {
    store.recordUsage({ tier: "t1", costUsd: 0.02, outcome: "ok" });
    store.recordUsage({ tier: "t3", costUsd: 0.5, outcome: "ok" });
    expect(store.spendSince("2000-01-01T00:00:00.000Z")).toBeCloseTo(0.52, 6);
  });

  // Tokens default to 0 because a missing token count really is nothing spent. A
  // missing STEP count is nothing known, and the two must not share a cell value —
  // a threshold derived later from a column of zeroes would be derived from the
  // times the measurement failed (D-50).
  it("keeps 'not measured' distinct from 'explored nothing'", () => {
    store.recordUsage({ tier: "t1", steps: 41, outcome: "ok" });
    store.recordUsage({ tier: "t2", outcome: "ok" });

    const rows = store.db.prepare("SELECT tier, steps, input_tokens FROM usage ORDER BY tier").all() as {
      tier: string;
      steps: number | null;
      input_tokens: number;
    }[];
    expect(rows.map((r) => [r.tier, r.steps])).toStrictEqual([
      ["t1", 41],
      ["t2", null],
    ]);
    expect(rows[1]?.input_tokens).toBe(0);
  });

  it("hands a queued job to exactly one claimant", () => {
    newReview("rev1");
    store.enqueue("rev1", "deep");
    expect(store.queueDepth()).toBe(1);
    const claimed = store.claimJob();
    expect(claimed?.reviewId).toBe("rev1");
    expect(store.claimJob()).toBeUndefined();
    store.finishJob(claimed?.id ?? 0, "done");
  });
});

/**
 * The database this code will actually meet is not an empty one.
 *
 * `lore` runs on a deployed SQLite file created by schema version 1, and
 * `CREATE TABLE IF NOT EXISTS` does precisely nothing to a table that already
 * exists — so a column added to the DDL is present in every test and absent in
 * production, where the first insert naming it dies on `no such column`, after a
 * model has already been paid for.
 */
describe("opening a database that already exists", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** `usage` exactly as schema version 1 created it, which is what is deployed. */
  const V1_USAGE = `CREATE TABLE usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id       TEXT,
    review_id     TEXT,
    tier          TEXT NOT NULL,
    model         TEXT,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    latency_ms    INTEGER,
    outcome       TEXT NOT NULL,
    at            TEXT NOT NULL
  )`;

  it("adds a column the deployed database has never seen", () => {
    const path = join(dir, "v1.db");
    const v1 = new DatabaseSync(path);
    v1.exec(V1_USAGE);
    v1.exec("INSERT INTO usage(tier, outcome, at) VALUES('t1', 'ok', '2026-01-01T00:00:00.000Z')");
    v1.close();

    const migrated = new Store(path);
    migrated.recordUsage({ tier: "t2", steps: 12, outcome: "ok" });
    const rows = migrated.db.prepare("SELECT tier, steps FROM usage ORDER BY id").all() as {
      tier: string;
      steps: number | null;
    }[];
    // The row written before the column existed keeps the honest answer: nobody
    // counted, so nobody knows.
    expect(rows.map((r) => [r.tier, r.steps])).toStrictEqual([
      ["t1", null],
      ["t2", 12],
    ]);
    migrated.close();

    // Every restart runs the migration again, and `ADD COLUMN` twice is an error —
    // so the second open is the one that would take the service down at 3am.
    const reopened = new Store(path);
    expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM usage").get()).toMatchObject({ n: 2 });
    reopened.close();
  });

  it("records the version it left the database at, not the one it found", () => {
    const path = join(dir, "meta.db");
    const v1 = new DatabaseSync(path);
    v1.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    v1.exec("INSERT INTO meta(key, value) VALUES('schema_version', '1')");
    v1.close();

    const store2 = new Store(path);
    expect(store2.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: String(SCHEMA_VERSION),
    });
    store2.close();
  });

  // The migration decides what to do by asking the table. A table that is not there
  // must fail loudly rather than be skipped: skipping leaves the column absent and
  // moves the crash to the next insert, one layer away from the cause.
  it("refuses to migrate a table that does not exist", () => {
    const empty = new DatabaseSync(":memory:");
    expect(() => applyMigrations(empty)).toThrow(/table 'usage' does not exist/);
    empty.close();
  });
});
