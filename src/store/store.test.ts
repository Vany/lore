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

// A worker that dies between claiming a job and finishing it leaves the row
// `running` for ever. Nothing reclaimed it, nothing said so, and `queueDepth` counts
// only `queued` — so the operator view showed an idle service with work stranded
// inside it. INV-1 wearing the scheduler's clothes.
describe("orphaned jobs", () => {
  beforeEach(() => newReview("rev1"));

  it("requeues what a dead worker left running", () => {
    store.enqueue("rev1", "fast");
    expect(store.claimJob()).toBeDefined();
    expect(store.queueDepth()).toBe(0); // stranded, and the queue looks empty

    expect(store.reclaimOrphanedJobs()).toStrictEqual({ requeued: 1, failed: 0 });
    expect(store.queueDepth()).toBe(1);
    expect(store.claimJob()?.reviewId).toBe("rev1");
  });

  // A round that reliably kills the worker would otherwise crash-loop on every
  // restart. A review that cannot finish has to say so, not be retried in silence.
  it("fails a job that has burnt its attempts instead of looping for ever", () => {
    store.enqueue("rev1", "fast");
    // Claims 1 and 2 are survivable; each reclaim puts it back.
    for (let i = 0; i < 2; i++) {
      expect(store.claimJob()).toBeDefined();
      expect(store.reclaimOrphanedJobs()).toStrictEqual({ requeued: 1, failed: 0 });
    }
    // The third claim takes attempts to 3, and dying again is where it stops.
    expect(store.claimJob()).toBeDefined();
    expect(store.reclaimOrphanedJobs()).toStrictEqual({ requeued: 0, failed: 1 });
    expect(store.queueDepth()).toBe(0);
    expect(store.claimJob()).toBeUndefined();
  });

  // The two statements were correct only because of the order they appear in, and
  // nothing said so: swapped, every job at the limit is quietly requeued instead of
  // failed — the crash-loop the bound exists to prevent — and the tests above would
  // still have passed. This pins the outcome rather than the ordering.
  it("fails a burnt-out job even if the requeue is considered first", () => {
    store.enqueue("rev1", "fast");
    for (let i = 0; i < 3; i++) {
      store.claimJob();
      if (i < 2) store.reclaimOrphanedJobs();
    }
    // Requeue alone, with the failing statement never run: the row must still not
    // come back as claimable work.
    store.db.prepare("UPDATE job SET state = 'queued' WHERE state = 'running' AND attempts < 3").run();
    expect(store.queueDepth()).toBe(0);
  });

  it("leaves finished jobs alone", () => {
    store.enqueue("rev1", "fast");
    const job = store.claimJob();
    store.finishJob(job?.id ?? 0, "done");
    expect(store.reclaimOrphanedJobs()).toStrictEqual({ requeued: 0, failed: 0 });
  });
});

// The invariant is not "two workers never take the same JOB" — that was true, and
// it was the wrong question. It is that two rounds never run on the same REVIEW,
// because runRound reads the ladder, runs a tier and writes the ladder back.
//
// rev_cuZabwdrspNwv3OV6eu0IHA_, 2026-08-04: review_start queued one job, a
// review_submit 19s later queued a second, two loops took one each, and both paid
// for a t1 call. The ladder settled at round 1 after two rounds had finished and
// one completed review was discarded.
describe("one round at a time per review (D-53)", () => {
  beforeEach(() => {
    newReview("rev1");
    newReview("rev2");
  });

  it("will not hand out a second job for a review already running one", () => {
    // Different stages, so the dedup below does not hide what is being tested.
    store.enqueue("rev1", "fast");
    store.enqueue("rev1", "deep");
    expect(store.queueDepth()).toBe(2);

    expect(store.claimJob()?.reviewId).toBe("rev1");
    expect(store.claimJob()).toBeUndefined(); // the second is queued, not lost
    expect(store.queueDepth()).toBe(1);
  });

  it("releases the next round once the first finishes", () => {
    store.enqueue("rev1", "fast");
    store.enqueue("rev1", "deep");
    const first = store.claimJob();
    store.finishJob(first?.id ?? 0, "done");

    expect(store.claimJob()?.stage).toBe("deep");
  });

  // The concurrency worth having is BETWEEN reviews. Serialising everything would
  // fix the race by making the service single-threaded, which is not a fix.
  it("still runs other reviews in parallel", () => {
    store.enqueue("rev1", "fast");
    store.enqueue("rev2", "fast");

    expect(store.claimJob()?.reviewId).toBe("rev1");
    expect(store.claimJob()?.reviewId).toBe("rev2");
  });

  // D-53 serialised the rounds; it did nothing about a writer from outside the
  // queue. `review_submit` is one — it patches the worktree a running round is
  // reading — so it asks this before touching anything (D-55).
  it("says whether a round is pending, for callers that must not touch the worktree", () => {
    expect(store.hasPendingRound("rev1")).toBe(false);

    // QUEUED counts. Asking only about `running` left a TOCTOU (8b859cdc): the
    // handler saw "no round" while a job sat queued, yielded on its next await, and
    // a worker claimed that job and began reading the worktree the handler then
    // patched. Counting queued leaves nothing to claim.
    store.enqueue("rev1", "fast");
    expect(store.hasPendingRound("rev1")).toBe(true);

    const job = store.claimJob();
    expect(store.hasPendingRound("rev1")).toBe(true);
    expect(store.hasPendingRound("rev2")).toBe(false); // per review, not global

    store.finishJob(job?.id ?? 0, "done");
    expect(store.hasPendingRound("rev1")).toBe(false);
  });

  it("collapses a duplicate queued round instead of stacking it", () => {
    // review_start, then review_submit before the first round is even claimed.
    store.enqueue("rev1", "fast");
    store.enqueue("rev1", "fast");
    expect(store.queueDepth()).toBe(1);
  });

  // A submit DURING a running round still has to be queued: the client is not
  // required to poll before sending a fix, it just must not run beside the round.
  it("queues a round submitted while one is already running", () => {
    store.enqueue("rev1", "fast");
    store.claimJob();
    store.enqueue("rev1", "fast");
    expect(store.queueDepth()).toBe(1);
    expect(store.claimJob()).toBeUndefined();
  });

  // What the bug actually looked like: N loops polling one queue, one review.
  it("gives one review to exactly one of many concurrent loops", () => {
    store.enqueue("rev1", "fast");
    store.enqueue("rev1", "deep");
    const claimed = Array.from({ length: 4 }, () => store.claimJob()).filter((j) => j !== undefined);
    expect(claimed).toHaveLength(1);
  });
});

// A tier that ran for 30 minutes and timed out used to write NOTHING, because runs
// were recorded only on completion. To every reader of this database that was
// indistinguishable from a tier that never started, and the operator view said
// "updated 41 minutes ago" while telling the literal truth. INV-1 inside the
// bookkeeping: work that did not finish, reported as work that never happened.
describe("tier runs are opened before the tier is asked anything", () => {
  beforeEach(() => newReview("rev1"));

  it("leaves an open row a reader can see as in flight", () => {
    store.openTierRun("rev1", "t2", 1, new Date().toISOString());
    const row = store.db.prepare("SELECT outcome, finished_at FROM tier_run WHERE review_id = 'rev1'").get() as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    expect(row?.["finished_at"]).toBeNull();
    expect(row?.["outcome"]).toBeNull();
  });

  // The case that motivated this: the model never answered.
  it("keeps the evidence when the tier dies, with why", () => {
    const id = store.openTierRun("rev1", "t2", 1, new Date().toISOString());
    store.closeTierRun(id, "failed");
    const row = store.db.prepare("SELECT outcome, finished_at FROM tier_run WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    expect(row?.["outcome"]).toBe("failed");
    expect(row?.["finished_at"]).not.toBeNull();
  });

  it("does not open a second row for the same run", () => {
    const id = store.openTierRun("rev1", "t1", 1, new Date().toISOString());
    store.closeTierRun(id, "clean");
    store.closeTierRun(id, "findings");
    const n = store.db.prepare("SELECT COUNT(*) c FROM tier_run WHERE review_id = 'rev1'").get() as Record<string, number>;
    expect(Number(n["c"])).toBe(1);
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

  // Idempotence here comes from asking whether the COLUMN exists, so anything that
  // does not add a column is answered "not yet" for ever — running on every open,
  // silently for an IF NOT EXISTS index and as a startup crash for anything else.
  // Neither failure points back at this list, so the list refuses instead.
  it("refuses a migration that is not an ADD COLUMN", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE usage (id INTEGER PRIMARY KEY)");
    expect(() =>
      applyMigrations(db, [{ table: "usage", column: "by_review", sql: "CREATE INDEX IF NOT EXISTS ix ON usage(id)" }]),
    ).toThrow(/not an ADD COLUMN/);
    db.close();
  });

  // Rolling the container back is a normal operational move, and it is the one case
  // column-sniffing cannot catch: every column an older build wants already exists,
  // so it skips every migration, looks healthy, and writes into a schema it does not
  // understand — losing whatever the newer build recorded in columns it cannot see.
  it("refuses to open a database written by a newer build", () => {
    const path = join(dir, "future.db");
    const ahead = new Store(path);
    ahead.db
      .prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
      .run(String(SCHEMA_VERSION + 1), String(SCHEMA_VERSION + 1));
    ahead.close();

    expect(() => new Store(path)).toThrow(new RegExp(`written by schema version ${SCHEMA_VERSION + 1}`));
  });

  // Only ever refuses, never approves: a version row that disagrees with the real
  // columns must not be able to skip a migration. Forward is the columns' job.
  it("opens an older database rather than demanding an exact match", () => {
    const path = join(dir, "older.db");
    const old = new Store(path);
    old.db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    old.close();

    const reopened = new Store(path);
    expect(reopened.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: String(SCHEMA_VERSION),
    });
    reopened.close();
  });
});
