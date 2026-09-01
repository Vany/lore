import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmbiguousFingerprint } from "../core/errors.ts";
import { initialState } from "../core/ladder.ts";
import { SCHEMA_VERSION, applyMigrations } from "./schema.ts";
import { NO_LIMIT, SETTLING_VERDICTS, Store, type RecordedFinding, type VerdictKind } from "./store.ts";

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

  // CHECK-THEN-ACT WITH NO LOCK. `upsertRepo` reads by git_url and inserts when it finds
  // nothing; two provisions of one repository racing both find nothing and both insert.
  // Tokens, reviews and knowledge then split across two rows for one repository — the
  // knowledge base halves, and a client holding the older token cannot see reviews
  // started under the newer one.
  it("cannot hold two rows for one repository", () => {
    const first = store.upsertRepo("demo", "git@x:same.git");
    // The race, simulated: an insert that the read said was safe.
    const second = store.upsertRepo("demo-again", "git@x:same.git");
    expect(second.id).toBe(first.id);
    const rows = store.db.prepare("SELECT COUNT(*) AS n FROM repo WHERE git_url = 'git@x:same.git'").get() as {
      n: number;
    };
    expect(Number(rows.n)).toBe(1);
  });

  it("refuses a duplicate at the schema, not only in the read", () => {
    store.upsertRepo("demo", "git@x:same.git");
    expect(() =>
      store.db
        .prepare("INSERT INTO repo(id, name, git_url, created_at) VALUES('x', 'sneaky', 'git@x:same.git', 'now')")
        .run(),
    ).toThrow();
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

  // ANNOUNCED AFTER THE WRITE, and the comment saying so used to sit above a call
  // that ran before it. A client woken first re-reads and sees the state it was told
  // had changed; if the write then throws it waits for a second wake that never comes.
  it("wakes a subscriber only once the new state is readable", () => {
    newReview("rev1");
    let stateWhenWoken: string | undefined;
    store.events = {
      changed: (id) => {
        stateWhenWoken = store.getReview(id, PRINCIPAL)?.state;
      },
    };
    // NOT the state it already has — `newReview` opens at `running`, and updating to
    // the same value would let a wake fired before the write look correct.
    store.updateReview("rev1", { state: "findings_ready" });
    expect(stateWhenWoken).toBe("findings_ready");
  });

  // A WRITE IS NOT NEWS. Every round boundary writes `state: running` over `running`,
  // and the next round writes it again, so a review climbing t1→t2→t3 with nothing to
  // report woke its subscriber twice per tier — an LLM turn spent per wake to poll and
  // learn nothing. The same shape as notifying on a re-raised finding, which this file
  // already refuses.
  it("does not wake a subscriber for a write that changes no state", () => {
    newReview("rev1");
    const woken: string[] = [];
    store.events = { changed: (id) => woken.push(id) };

    store.updateReview("rev1", { state: "running" }); // already running
    store.updateReview("rev1", { ladder: { ...initialState(), cursor: 2 } }); // bookkeeping
    expect(woken).toEqual([]);

    store.updateReview("rev1", { state: "findings_ready" });
    expect(woken).toEqual(["rev1"]);
  });

  // THE ONE STATE CHANGE THAT WOKE NOBODY. The expiry sweep wrote `state` with its own
  // SQL, so a client subscribed to a review — the path the docs lead with — was never
  // told it had been abandoned and waited on a stream that would never deliver for it
  // again.
  it("wakes a subscriber when the sweep expires their review", () => {
    newReview("rev1");
    newReview("rev2");
    store.db.prepare("UPDATE review SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'rev1'").run();

    const woken: string[] = [];
    store.events = { changed: (id) => woken.push(id) };
    const expired = store.expireStaleReviews("2021-01-01T00:00:00.000Z");

    expect(expired).toEqual(["rev1"]);
    expect(woken).toEqual(["rev1"]);
    expect(store.getReview("rev1", PRINCIPAL)?.state).toBe("expired");
    expect(store.getReview("rev2", PRINCIPAL)?.state).toBe("running");
  });

  it("round-trips ladder state", () => {
    newReview("rev1");
    const ladder = { ...initialState(), round: 4, settled: ["aa"] };
    store.updateReview("rev1", { ladder, state: "awaiting_diff" });
    const got = store.getReview("rev1", PRINCIPAL);
    expect(got?.ladder.round).toBe(4);
    expect(got?.state).toBe("awaiting_diff");
  });

  // ESCALATING WAS A ONE-WAY DOOR. `knowledge_escalate` moves a conflict to
  // `needs-human` and `resolveConflict` matched only `open`, so the state a person is
  // supposed to settle was the one state nothing could settle — while D-77 and
  // `spec/knowledge.md` §7.3 both say the exit is a person deciding and the client
  // calling `knowledge_resolve`. Latent until the resume gate counted escalated
  // conflicts as blocking, at which point the reviews behind it could never resume.
  it("settles a conflict a person was called to, not just an open one", () => {
    const rule = (s: string) =>
      store.addKnowledge({
        repoId, kind: "rule", source: "taught", statement: s, why: "because",
        path: undefined, cwe: undefined, provenance: undefined,
        sourceBlob: undefined, confidence: undefined,
      }).id;
    const [a, b] = [rule("holds expire"), rule("holds never expire")];
    store.recordConflict(repoId, a, b);
    store.escalateConflict(repoId, a, b, "two ADRs disagree, ask someone");
    expect(store.openConflicts(repoId)).toHaveLength(1);

    expect(store.resolveConflict(repoId, a, b, "Vany: ADR-0026 wins")).toBe(true);
    expect(store.openConflicts(repoId)).toHaveLength(0);
  });

  // A BLOCK WITH NO EXIT IS A TRAP, and this one had an exit sign over a wall.
  // `spec/knowledge.md` §7.3 promises the ladder recomputes needsHuman each round —
  // true, and unreachable, because settling a conflict scheduled no round. A client
  // that resolved and waited, exactly as told, waited for nothing; `needs_human` is
  // not terminal, so the sweep turned the review into `expired` two days later.
  describe("settling a conflict resumes the reviews it blocked", () => {
    const parked = (id: string, state = "needs_human") => {
      newReview(id);
      store.db.prepare("UPDATE review SET state = ? WHERE id = ?").run(state, id);
    };

    it("re-queues a parked review", () => {
      parked("rev1");
      expect(store.resumeNeedsHuman(repoId)).toBe(1);
      expect(store.getReview("rev1", PRINCIPAL)?.state).toBe("queued");
    });

    it("leaves reviews that are not parked alone", () => {
      parked("rev1", "passed");
      parked("rev2", "findings_ready");
      expect(store.resumeNeedsHuman(repoId)).toBe(0);
      expect(store.getReview("rev1", PRINCIPAL)?.state).toBe("passed");
      expect(store.getReview("rev2", PRINCIPAL)?.state).toBe("findings_ready");
    });

    it("does not reach into another repository's reviews", () => {
      parked("rev1");
      const other = store.upsertRepo("other", "git@x:other.git").id;
      expect(store.resumeNeedsHuman(other)).toBe(0);
      expect(store.getReview("rev1", PRINCIPAL)?.state).toBe("needs_human");
    });
  });

  // The refusal built on this is read by someone deciding whether to continue or
  // restart, and that turns entirely on how stale the pinned snapshot is (D-40). It
  // fired on a review twenty hours and twenty-five commits old while offering
  // `restart: true` only "if the branch was rebased" — which it had not been, so the
  // one correct action looked unavailable.
  describe("openReviewFor carries the age the advice depends on", () => {
    it("reports an open review with how long since it advanced", () => {
      newReview("rev1");
      const when = new Date(Date.now() - 20 * 3_600_000).toISOString();
      store.db.prepare("UPDATE review SET branch = 'feat/x', updated_at = ? WHERE id = 'rev1'").run(when);

      const open = store.openReviewFor(repoId, "feat/x");
      expect(open?.id).toBe("rev1");
      expect(open?.ageHours ?? 0).toBeGreaterThan(19);
      expect(open?.ageHours ?? 0).toBeLessThan(21);
    });

    it("is undefined once the review is terminal, so a finished branch can start again", () => {
      newReview("rev1");
      store.db.prepare("UPDATE review SET branch = 'feat/x', state = 'passed' WHERE id = 'rev1'").run();
      expect(store.openReviewFor(repoId, "feat/x")).toBeUndefined();
    });

    // NaN would print as "NaN hours old" in the refusal. Zero suppresses the
    // staleness advice rather than inventing it.
    it("reads an unparseable timestamp as age zero rather than NaN", () => {
      newReview("rev1");
      store.db.prepare("UPDATE review SET branch = 'feat/x', updated_at = 'not a date' WHERE id = 'rev1'").run();
      expect(store.openReviewFor(repoId, "feat/x")?.ageHours).toBe(0);
    });
  });

  // D-130: a folder review of one path and a diff review of the same branch are
  // different work, and so are folder reviews of two different paths — none of the
  // three should collide with either of the others in the one-review-per-branch check.
  describe("openReviewFor's dedup key includes path (D-130)", () => {
    it("does not confuse a folder review with a diff review of the same branch", () => {
      store.createReview({
        id: "diff-rev",
        repoId,
        principal: PRINCIPAL,
        branch: "feat/x",
        intoRef: "origin/main",
        ticket: "do the thing",
        type: "code-arch",
        state: "running",
        ladder: initialState(),
      });
      store.createReview({
        id: "folder-rev",
        repoId,
        principal: PRINCIPAL,
        branch: "feat/x",
        reviewPath: "src/payments",
        ticket: "do the thing",
        type: "code-arch",
        state: "running",
        ladder: initialState(),
      });

      expect(store.openReviewFor(repoId, "feat/x")?.id).toBe("diff-rev");
      expect(store.openReviewFor(repoId, "feat/x", "src/payments")?.id).toBe("folder-rev");
    });

    it("does not confuse two folder reviews of the same branch at different paths", () => {
      store.createReview({
        id: "payments-rev",
        repoId,
        principal: PRINCIPAL,
        branch: "feat/x",
        reviewPath: "src/payments",
        ticket: "do the thing",
        type: "code-arch",
        state: "running",
        ladder: initialState(),
      });
      store.createReview({
        id: "auth-rev",
        repoId,
        principal: PRINCIPAL,
        branch: "feat/x",
        reviewPath: "src/auth",
        ticket: "do the thing",
        type: "code-arch",
        state: "running",
        ladder: initialState(),
      });

      expect(store.openReviewFor(repoId, "feat/x", "src/payments")?.id).toBe("payments-rev");
      expect(store.openReviewFor(repoId, "feat/x", "src/auth")?.id).toBe("auth-rev");
      expect(store.openReviewFor(repoId, "feat/x", "src/nowhere")).toBeUndefined();
    });
  });
});

describe("a folder review's row (D-130)", () => {
  it("round-trips with no intoRef and a reviewPath, not the write-side sentinel", () => {
    store.createReview({
      id: "rev1",
      repoId,
      principal: PRINCIPAL,
      branch: "feat/x",
      reviewPath: "src/payments",
      ticket: "do the thing",
      type: "code-arch",
      state: "running",
      ladder: initialState(),
    });

    const row = store.getReview("rev1", PRINCIPAL);
    expect(row?.reviewPath).toBe("src/payments");
    // "" is the write-side representation forced by into_ref's pre-existing NOT NULL
    // constraint (store.ts's createReview) — it must never leak out as a real value.
    expect(row?.intoRef).toBeUndefined();
  });

  it("still round-trips an ordinary diff review with no reviewPath", () => {
    newReview("rev1");
    const row = store.getReview("rev1", PRINCIPAL);
    expect(row?.intoRef).toBe("origin/main");
    expect(row?.reviewPath).toBeUndefined();
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

  // The two views of "settled" must agree, and review.ts:427 says why in the code
  // that depends on it: when they diverge the review LIVELOCKS — a re-raised
  // fingerprint looks fresh to `step`, which resets the ladder, while `openFindings`
  // excludes it and `undelivered` has already delivered it, so the client is told
  // `findings_ready` and handed nothing, for ever. It had been applied
  // to `openFindings` and to `review_poll` and not to `settledFingerprints`, so the
  // constant left three definitions where it was meant to leave one.
  //
  // Asserted over every verdict kind rather than the two that settle, so adding a
  // kind cannot pass by being ignored on both sides.
  it("agrees with openFindings on every verdict kind", () => {
    const kinds: VerdictKind[] = ["fixed", "justified-accepted", "justified-rejected"];
    kinds.forEach((verdict, i) => {
      const fp = `f${i}`;
      store.recordFinding("rev1", finding(fp));
      store.recordVerdict("rev1", { fingerprint: fp, verdict, rationale: "r", scope: undefined, tier: "t1", round: 1 });
    });

    const settled = new Set(store.settledFingerprints("rev1"));
    const open = new Set(store.openFindings("rev1").map((f) => f.fingerprint));

    for (const fp of ["f0", "f1", "f2"]) {
      expect(settled.has(fp), `${fp}: settled and open disagree`).toBe(!open.has(fp));
    }
    expect([...settled].sort()).toStrictEqual(SETTLING_VERDICTS.map((_, i) => `f${i}`));
  });

  // lore-ok[6aa59cb5]: found by lore's own review. `model` existed on the schema
  // and was published by verdictsFor/lore://review/<id> since before this file's
  // own history begins, but recordVerdict had nowhere to put a caller's value and
  // no reader ever pulled the column back out — so every verdict read `model: null`
  // for ever, in the one field that says which route actually decided.
  it("carries the model through recordVerdict, latestVerdict and priorAcceptedVerdict", () => {
    store.recordFinding("rev1", finding("aa"));
    store.recordVerdict("rev1", {
      fingerprint: "aa", verdict: "justified-accepted", rationale: "bounded upstream",
      scope: { blob: "b1", hunk: "h1" }, tier: "t1", model: "openrouter/twin", round: 1,
    });

    expect(store.latestVerdict("rev1", "aa")?.model).toBe("openrouter/twin");
    expect(store.priorAcceptedVerdict(repoId, "aa", "rev2")?.model).toBe("openrouter/twin");
  });

  // A carried verdict, an expiry sweep and t0's own "fixed" silence never had a
  // model to name — leaving the field absent must not throw or silently invent one.
  it("leaves model absent when nothing ruled on it", () => {
    store.recordFinding("rev1", finding("bb"));
    store.recordVerdict("rev1", {
      fingerprint: "bb", verdict: "fixed", rationale: undefined, scope: undefined, tier: "t0", round: 1,
    });

    expect(store.latestVerdict("rev1", "bb")?.model).toBeUndefined();
  });

  // Verdicts are append-only, so the two views must agree on the LATEST row — and
  // the test above only proved they agree for findings with exactly one. That gap
  // was named by t2, in a reply the 300-character claim cap then discarded; the
  // finding was real and is fixed here.
  //
  // `openFindings` matched ANY historical settling verdict with no latest gate,
  // while `settledFingerprints` took the maximum id. So a justification accepted and
  // later rejected — precisely what `expireStaleVerdicts` writes when the code it
  // justified changes — was excluded from open AND excluded from settled. Neither.
  // That is the livelock condition review.ts:427 spells out, and the rubber-stamping
  // the expiry exists to prevent: the defect is back and nothing counts it.
  it("agrees on the latest verdict, not merely on some historical one", () => {
    store.recordFinding("rev1", finding("aa"));
    store.recordVerdict("rev1", { fingerprint: "aa", verdict: "justified-accepted", rationale: "bounded", scope: undefined, tier: "t1", round: 1 });
    expect(store.openFindings("rev1").map((f) => f.fingerprint)).not.toContain("aa");
    expect(store.settledFingerprints("rev1")).toContain("aa");

    // The code moved, so the reason no longer holds.
    store.recordVerdict("rev1", { fingerprint: "aa", verdict: "justified-rejected", rationale: "expired: code changed", scope: undefined, tier: "expiry", round: 0 });

    expect(store.settledFingerprints("rev1")).not.toContain("aa");
    expect(store.openFindings("rev1").map((f) => f.fingerprint)).toContain("aa");
  });

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

/**
 * A REVIEW THAT HAS ENDED LEAVES NO WORK BEHIND IT.
 *
 * `claimJob` refuses a job whose review is terminal — right, since a cancelled review
 * must not go on being paid for — but nothing closed those rows, so they sat in `queued`
 * for ever, unclaimable, and `queueDepth` counted them.
 *
 * Found by Vany asking the question the operator view invited: *"a job must be picked
 * immediately. Why has nobody claimed it?"* Three jobs, up to nineteen hours old, against
 * eleven idle workers and three free model slots. They were not waiting for anything.
 * The number said a backlog was building on a service that was doing nothing — the same
 * false reassurance as a drain flag reporting `ok: true`, pointing the other way.
 */
describe("jobs of a review that has ended", () => {
  beforeEach(() => newReview("rev1"));

  it("closes the queued job when the review is cancelled, and stops counting it", () => {
    store.enqueue("rev1", "fast");
    expect(store.queueDepth()).toBe(1);

    store.updateReview("rev1", { state: "cancelled" });

    expect(store.queueDepth(), "nothing is waiting — that job can never be claimed").toBe(0);
    expect(store.claimJob(), "and indeed nobody can claim it").toBeUndefined();
  });

  // Kept as a row, not deleted: the job table is the record of what the scheduler did,
  // and `last_error` is where a reader finds out the round never ran.
  it("says why the job ended rather than deleting the evidence", () => {
    store.enqueue("rev1", "fast");
    store.updateReview("rev1", { state: "passed" });

    const row = store.db.prepare("SELECT state, last_error FROM job WHERE review_id = 'rev1'").get() as
      { state: string; last_error: string };
    expect(row.state).toBe("failed");
    expect(row.last_error).toContain("passed");
  });

  // A running job belongs to the worker that claimed it. Taking it away here would race
  // the code that reports what the abort cost.
  it("leaves a running job to the worker that holds it", () => {
    store.enqueue("rev1", "fast");
    store.claimJob();
    store.updateReview("rev1", { state: "cancelled" });

    const row = store.db.prepare("SELECT state FROM job WHERE review_id = 'rev1'").get() as { state: string };
    expect(row.state).toBe("running");
  });

  // The expiry sweep writes state in SQL rather than through `updateReview`, and that
  // split has already cost one bug — it was the one state change that woke no subscriber.
  it("closes them when the staleness sweep expires a review too", () => {
    store.enqueue("rev1", "fast");
    store.expireStaleReviews(new Date(Date.now() + 60_000).toISOString());

    expect(store.getReview("rev1", PRINCIPAL)?.state).toBe("expired");
    expect(store.queueDepth()).toBe(0);
  });

  /**
   * The backstop, for rows that leaked before the cause was fixed — which is how this
   * was found, so the fix has to be able to clean up after itself.
   */
  it("sweeps rows that leaked before any of this existed", () => {
    store.enqueue("rev1", "fast");
    // Exactly the shape found in production: the review ended without its job closing.
    store.db.prepare("UPDATE review SET state = 'cancelled' WHERE id = 'rev1'").run();
    expect(store.queueDepth(), "already excluded from the count").toBe(0);

    expect(store.closeJobsOfEndedReviews()).toBe(1);
    // Idempotent: a second pass finds nothing, so a non-zero number is always news.
    expect(store.closeJobsOfEndedReviews()).toBe(0);
  });
});

// lore-ok[1b056160]: found by lore's own review. `runJob` used to write `state:
// "running"` unconditionally after `worktreeFor` — a real git operation with
// nothing holding the review row for the whole time it ran. A `review_cancel`
// landing in that window wrote `cancelled`, and the unconditional write then
// overwrote it back to `running`, one write before `runRound`'s own TOCTOU check
// ever got to read it. `startRunning` closes the window with a single atomic
// `UPDATE ... WHERE`, the same shape `claimJob` already uses for its own
// terminal check.
describe("starting a claimed review", () => {
  beforeEach(() => {
    newReview("rev1");
    store.updateReview("rev1", { state: "queued" });
  });

  it("moves a live review into running", () => {
    expect(store.startRunning("rev1")).toBe(true);
    expect(store.getReview("rev1", PRINCIPAL)?.state).toBe("running");
  });

  it("refuses a review that was cancelled while its worktree was being cut, and leaves the cancel standing", () => {
    // Simulates the exact race: `review_cancel` wins before this write is attempted.
    store.updateReview("rev1", { state: "cancelled" });

    expect(store.startRunning("rev1"), "the write must not go through").toBe(false);
    expect(store.getReview("rev1", PRINCIPAL)?.state, "cancelled must not be clobbered back to running").toBe(
      "cancelled",
    );
  });

  it.each(["passed", "passed_partial", "failed", "expired"] as const)(
    "refuses a review that reached '%s' in the same window",
    (state) => {
      store.updateReview("rev1", { state });
      expect(store.startRunning("rev1")).toBe(false);
      expect(store.getReview("rev1", PRINCIPAL)?.state).toBe(state);
    },
  );
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

    expect(store.reclaimOrphanedJobs()).toMatchObject({ requeued: 1, failed: 0 });
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
      expect(store.reclaimOrphanedJobs()).toMatchObject({ requeued: 1, failed: 0 });
    }
    // The third claim takes attempts to 3, and dying again is where it stops.
    expect(store.claimJob()).toBeDefined();
    expect(store.reclaimOrphanedJobs()).toMatchObject({ requeued: 0, failed: 1 });
    expect(store.queueDepth()).toBe(0);
    expect(store.claimJob()).toBeUndefined();
  });

  // THE TIER RUN OUTLIVES THE JOB. `openTierRun` leaves `finished_at` NULL so a reader
  // can tell working from stopped-without-saying-so — and a process that died mid-round
  // left the row open for ever, so the operator view showed a tier still running weeks
  // later. Reclaiming the job and leaving its row open fixed the queue and left the
  // evidence lying.
  it("closes the tier runs a dead worker left open", () => {
    store.enqueue("rev1", "fast");
    store.claimJob();
    const runId = store.openTierRun("rev1", "t1", 1, "2026-08-07T00:00:00.000Z");
    expect(store.reclaimOrphanedJobs().closedRuns).toBe(1);
    const row = store.db.prepare("SELECT outcome, finished_at FROM tier_run WHERE id = ?").get(runId) as Record<string, string>;
    expect(row["outcome"]).toBe("failed");
    expect(row["finished_at"]).not.toBeNull();
  });

  // ...AND THE ONES IT LEFT OPEN LAST TIME, which is where they actually pile up.
  //
  // The loop above is scoped to reviews with a job still `running` — the process died
  // THIS time. A row orphaned by an earlier kill, whose job was later requeued and then
  // failed, has no running job left to find it by and stays open for ever. Four such
  // rows sat in the live database claiming a tier had been reading `rigid-monorepo` for
  // forty-six hours, on reviews that failed two days earlier, and every restart swept
  // straight past them. The invariant does not depend on why the row is open: a review
  // that has reached a verdict has no tier reading it.
  it("closes an open run on a review that already ended, with no running job to find it by", () => {
    const runId = store.openTierRun("rev1", "t0", 1, "2026-08-05T21:12:13.026Z");
    store.enqueue("rev1", "fast");
    const job = store.db.prepare("SELECT id FROM job WHERE review_id = 'rev1'").get() as { id: number };
    store.finishJob(job.id, "failed", "the round threw");
    store.updateReview("rev1", { state: "failed" });

    // Nothing is running, so the job-scoped sweep above has nothing to key on.
    const running = store.db.prepare("SELECT COUNT(*) c FROM job WHERE state = 'running'").get() as { c: number };
    expect(Number(running.c)).toBe(0);

    expect(store.reclaimOrphanedJobs().closedRuns).toBe(1);
    const row = store.db.prepare("SELECT outcome, finished_at FROM tier_run WHERE id = ?").get(runId) as Record<string, string>;
    expect(row["outcome"]).toBe("failed");
    expect(row["finished_at"]).not.toBeNull();
  });

  // And a review still in flight keeps its open row: that one IS working, and closing
  // it would be the same lie in the other direction.
  it("leaves an open run alone on a review that has not ended", () => {
    store.openTierRun("rev1", "t2", 1, new Date().toISOString());
    store.updateReview("rev1", { state: "running" });
    expect(store.reclaimOrphanedJobs().closedRuns).toBe(0);
  });

  // A review whose last attempt burned out is not still RUNNING. Nothing will claim
  // that job again, but the review sat in `running` until the sweep called it
  // `expired` — which says nobody came back, and that is false: the ladder died.
  it("fails the review whose every attempt died, and says why", () => {
    store.enqueue("rev1", "fast");
    for (let i = 0; i < 3; i++) {
      store.claimJob();
      if (i < 2) store.reclaimOrphanedJobs();
    }
    const out = store.reclaimOrphanedJobs();
    expect(out.failed).toBe(1);
    expect(out.reviewsFailed).toBe(1);
    expect(store.getReview("rev1", PRINCIPAL)?.state).toBe("failed");
    expect(store.failureReason("rev1")).toMatch(/died along with the process/);
    expect(store.failureReason("rev1")).toMatch(/NOT a pass/);
  });

  it("does not overwrite a review that already reached a verdict", () => {
    store.enqueue("rev1", "fast");
    for (let i = 0; i < 3; i++) {
      store.claimJob();
      if (i < 2) store.reclaimOrphanedJobs();
    }
    store.updateReview("rev1", { state: "passed" });
    expect(store.reclaimOrphanedJobs().reviewsFailed).toBe(0);
    expect(store.getReview("rev1", PRINCIPAL)?.state).toBe("passed");
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
    expect(store.reclaimOrphanedJobs()).toMatchObject({ requeued: 0, failed: 0 });
  });
});

// The invariant is not "two workers never take the same JOB" — that was true, and
// it was the wrong question. It is that two rounds never run on the same REVIEW,
// because runRound reads the ladder, runs a tier and writes the ladder back.
//
// Observed 2026-08-04: review_start queued one job, a
// review_submit 19s later queued a second, two loops took one each, and both paid
// for a t1 call. The ladder settled at round 1 after two rounds had finished and
// one completed review was discarded.
// A re-raise refreshes what the settling rule reads. Both fields describe the LAST
// raise, not the first, and `recordFinding` is ON CONFLICT DO NOTHING (D-56).
describe("a re-raise refreshes the finding's context", () => {
  beforeEach(() => newReview("rev1"));

  it("moves the scope, so a stale hunk cannot look like a fix", () => {
    store.recordFinding("rev1", { ...finding("aaaa1111"), scope: { blob: "b1", hunk: "h1" } });
    store.refreshFinding("rev1", "aaaa1111", { blob: "b2", hunk: "h2" }, undefined);
    expect(store.openFindings("rev1")[0]?.scope).toStrictEqual({ blob: "b2", hunk: "h2" });
  });

  // The qualified-silence guard reads `origin`. If t3 confirms what t1 first found
  // and origin stays t1, t1's silence closes a defect t3 is still asserting.
  it("raises the origin to the tier that last confirmed it", () => {
    store.recordFinding("rev1", { ...finding("bbbb2222"), origin: "t1" });
    store.refreshFinding("rev1", "bbbb2222", undefined, "t3");
    expect(store.openFindings("rev1")[0]?.origin).toBe("t3");
  });

  it("leaves both alone when there is nothing new to record", () => {
    store.recordFinding("rev1", { ...finding("cccc3333"), origin: "t2", scope: { blob: "b1", hunk: "h1" } });
    store.refreshFinding("rev1", "cccc3333", undefined, undefined);
    const f = store.openFindings("rev1")[0];
    expect(f?.origin).toBe("t2");
    expect(f?.scope).toStrictEqual({ blob: "b1", hunk: "h1" });
  });
});

// The ceiling a tier has DEMONSTRATED, never a constant (D-58). With no evidence
// there is no warning, because a threshold nobody calibrated fails real reviews for
// nothing — the trap D-50 names.
describe("the diff ceiling is observed, not guessed", () => {
  beforeEach(() => newReview("rev1"));
  const ran = (tier: string, diffChars: number, outcome: string) =>
    store.recordUsage({ reviewId: "rev1", repoId, tier, diffChars, outcome });

  it("says nothing until the tier has finished something", () => {
    expect(store.largestCompletedDiff("t2")).toBeUndefined();
  });

  it("reports the largest diff the tier actually completed", () => {
    ran("t2", 20_000, "ok");
    ran("t2", 31_000, "ok-after-retry");
    ran("t2", 12_000, "ok");
    expect(store.largestCompletedDiff("t2")).toBe(31_000);
  });

  // A run that timed out proves the opposite of capacity. Counting it would raise
  // the ceiling every time the tier failed, so the warning would go quiet exactly
  // as the problem got worse.
  it("ignores runs that did not finish", () => {
    ran("t2", 20_000, "ok");
    ran("t2", 69_000, "timeout");
    ran("t2", 80_000, "failed");
    expect(store.largestCompletedDiff("t2")).toBe(20_000);
  });

  it("is per tier, because capacity is", () => {
    ran("t1", 30_000, "ok");
    ran("t3", 5_000, "ok");
    expect(store.largestCompletedDiff("t1")).toBe(30_000);
    expect(store.largestCompletedDiff("t3")).toBe(5_000);
  });
});

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

    // QUEUED counts. Asking only about `running` left a TOCTOU: the
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

  // Fingerprint 4c38b78d/928bccd1, found by lore's own review of the OOM-kill
  // fix: `runRound`'s t0-reuse path (reviewer/review.ts) used to hardcode
  // `interrupted: false` on a reused run, reasoning that `codeMoved`'s own
  // guard made it moot — false, because D-107's held-diff boundary can move the
  // worktree LATER in the SAME round, after reuse has already fired. The fix
  // carries the REUSED run's own interrupted status forward instead of
  // hardcoding it, which needs this field on `lastT0`'s own return.
  it("carries a reused run's own interrupted status forward", () => {
    const id = store.openTierRun("rev1", "t0", 1, new Date().toISOString());
    store.closeTierRun(id, "interrupted", ["tsc: killed"], "treehash1");
    expect(store.lastT0("rev1")?.interrupted).toBe(true);
  });

  it("says false for a genuinely clean run, not just absent", () => {
    const id = store.openTierRun("rev1", "t0", 1, new Date().toISOString());
    store.closeTierRun(id, "clean", [], "treehash1");
    expect(store.lastT0("rev1")?.interrupted).toBe(false);
  });

  // Fingerprint 1f8b0b2d, found by lore's own review of the fix directly above:
  // it carried `interrupted` across exactly ONE reuse hop, because a reusing
  // round always closes its OWN row `reused` (D-102 — the operator board must
  // see that, not `interrupted`), so the SECOND consecutive reuse read the
  // first reuse's own row, whose outcome says `reused`, never the `interrupted`
  // truth two rows back. D-92 measured `reused` at roughly a fifth of all
  // rounds, so a chain longer than one is the ordinary case, not an edge one.
  it("carries interrupted status through a chain of several reuse rounds", () => {
    const first = store.openTierRun("rev1", "t0", 1, new Date().toISOString());
    store.closeTierRun(first, "interrupted", ["tsc: killed"], "treehash1");
    for (let round = 2; round <= 4; round++) {
      const id = store.openTierRun("rev1", "t0", round, new Date().toISOString());
      store.closeTierRun(id, "reused", ["tsc: killed"], "treehash1");
    }
    expect(store.lastT0("rev1")?.interrupted, "three reuse rounds deep, still true").toBe(true);
  });

  it("a reuse chain under a genuinely clean run stays false", () => {
    const first = store.openTierRun("rev1", "t0", 1, new Date().toISOString());
    store.closeTierRun(first, "clean", [], "treehash1");
    const id = store.openTierRun("rev1", "t0", 2, new Date().toISOString());
    store.closeTierRun(id, "reused", [], "treehash1");
    expect(store.lastT0("rev1")?.interrupted).toBe(false);
  });

  // `roundStartedAt` feeds `check_back_after_ms`, which is conditioned on how long the
  // round has run and compared against the CURSOR TIER's latencies. It used to answer
  // with any open row — and during T0 the only open row is T0's, while the cursor
  // already points at the model tier. On a repository whose T0 takes minutes (this
  // deployment has measured ~21) that told a client the model round had been open
  // longer than every completed one before the model was asked anything, then jumped
  // the advertised wait back UP when the model's row opened — contradicting the field's
  // own promise that it only ever shrinks.
  it("answers about the tier asked for, not whatever row is open", () => {
    const t0Start = new Date(Date.now() - 600_000).toISOString();
    store.openTierRun("rev1", "t0", 1, t0Start);

    // T0 is in flight and the model tier has not begun.
    expect(store.roundStartedAt("rev1", "t0")).toBe(Date.parse(t0Start));
    expect(store.roundStartedAt("rev1", "t1")).toBeUndefined();

    // Once it does, that is what the model tier's elapsed is measured from.
    const t1Start = new Date().toISOString();
    store.openTierRun("rev1", "t1", 1, t1Start);
    expect(store.roundStartedAt("rev1", "t1")).toBe(Date.parse(t1Start));
  });
});

describe("priorLike", () => {
  beforeEach(() => newReview("rev1"));

  // lore-ok[3d90d9a0]: found by lore's own review. fingerprint() (core/fingerprint.ts)
  // is content-derived — claim, file, symbol, nothing review-specific — so the SAME
  // defect raised in an earlier review carries the IDENTICAL fingerprint. Excluding
  // on the bare value excluded exactly the prior sightings this method exists to
  // surface, not just the current finding's own row.
  it("finds an earlier sighting of the same fingerprint in a DIFFERENT review", () => {
    store.recordFinding("rev1", finding("aa", { claim: "the hold is never released on decline" }));
    newReview("rev2");
    // The genuinely same defect: a second review's t1 raises the identical claim,
    // which is exactly why `fingerprint()` gives it the identical value.
    store.recordFinding("rev2", finding("aa", { claim: "a different but unrelated claim" }));

    const priors = store.priorLike(repoId, "rev2", "aa", "the hold is never released on decline", undefined);
    expect(priors.map((p) => p.claim)).toContain("the hold is never released on decline");
  });

  // The property the exclusion still has to keep: a finding is never its own prior.
  it("still excludes this exact finding's own row", () => {
    store.recordFinding("rev1", finding("aa", { claim: "the hold is never released on decline" }));

    const priors = store.priorLike(repoId, "rev1", "aa", "the hold is never released on decline", undefined);
    expect(priors).toStrictEqual([]);
  });

  // lore-ok[54d77a41]: found by lore's own review. The caller passes normalizeClaim's
  // full output (trim, lower-case, collapse whitespace, strip trailing `.`/`!`); the
  // stored side used to apply only LOWER(TRIM(...)), so a stored claim differing by
  // exactly the variation normalizeClaim exists to erase never matched.
  it("matches a stored claim differing only by trailing punctuation", () => {
    store.recordFinding("rev1", finding("aa", { claim: "The hold is never released on decline." }));
    newReview("rev2");

    const priors = store.priorLike(repoId, "rev2", "bb", "the hold is never released on decline", undefined);
    expect(priors.map((p) => p.claim)).toContain("The hold is never released on decline.");
  });

  it("matches a stored claim differing only by a doubled internal space", () => {
    store.recordFinding("rev1", finding("aa", { claim: "the hold is  never released on decline" }));
    newReview("rev2");

    const priors = store.priorLike(repoId, "rev2", "bb", "the hold is never released on decline", undefined);
    expect(priors.map((p) => p.claim)).toContain("the hold is  never released on decline");
  });

  // lore-ok[6f0e17d0]: found by lore's own review, one round after 54d77a41's own
  // fix — SQLite's bare TRIM strips only ASCII space, never a tab or a newline, and
  // a chained REPLACE only collapses a literal double-space, not an embedded
  // newline or a longer run. Ordinary in free-text model output, and normalizeClaim
  // (core/finding.ts) already collapses ALL of `\s+` to one space. Matching in JS
  // against the same function the caller used, rather than a second SQL dialect of
  // it, closes this the way it cannot reopen a third time.
  it("matches a stored claim differing only by an embedded newline", () => {
    store.recordFinding("rev1", finding("aa", { claim: "the hold is never\nreleased on decline" }));
    newReview("rev2");

    const priors = store.priorLike(repoId, "rev2", "bb", "the hold is never released on decline", undefined);
    expect(priors.map((p) => p.claim)).toContain("the hold is never\nreleased on decline");
  });
});

describe("knowledge", () => {
  it("retires rules whose source document changed", () => {
    // The single guard against the knowledge base rotting: a stale doc must never
    // become a confidently wrong rule injected into every future session.
    store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "amounts are integers in minor units",
      why: "float money", path: "src/pay", cwe: undefined, provenance: "PROG.md",
      sourceBlob: "blobA", extractor: "3", confidence: 0.9,
    });
    expect(store.knowledgeFor(repoId)).toHaveLength(1);
    expect(store.retireForChangedBlob(repoId, "PROG.md", "blobB", "3")).toBe(1);
    expect(store.knowledgeFor(repoId)).toHaveLength(0);
  });

  it("keeps rules whose source is unchanged", () => {
    store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "s", why: undefined, path: undefined,
      cwe: undefined, provenance: "PROG.md", sourceBlob: "blobA", extractor: "3", confidence: undefined,
    });
    expect(store.retireForChangedBlob(repoId, "PROG.md", "blobA", "3")).toBe(0);
    expect(store.knowledgeFor(repoId)).toHaveLength(1);
  });

  // WRITTEN AND NEVER READ BACK. `addKnowledge` stamped the reader's version and
  // `toKnowledge` did not map it, so every row came out of the Store with
  // `extractor: undefined` however it was stored. The audit that re-measured this base
  // had to reach past the Store into raw SQL to see the column at all, and anyone
  // trusting the interface would have concluded the stamping never landed — or treated
  // a current row as one an older reader wrote, which is what retirement turns on.
  it("hands back the reader that produced a rule, not just the document", () => {
    store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "handles are CSPRNG-generated, never sequential",
      why: undefined, path: undefined, cwe: undefined, provenance: "spec/mcp-api.md",
      sourceBlob: "blobA", extractor: "3", confidence: 0.8,
    });
    expect(store.knowledgeFor(repoId)[0]?.extractor).toBe("3");
  });

  // A ROW STAMPED BY THE CURRENT READER IS NOT AN OLD ROW, and the guard decides that by
  // comparison — so the stamp has to be supplied. It used to be optional, which meant the
  // pre-existing three-argument call bound NULL, `extractor IS NOT NULL` matched every
  // stamped row, and one call retired a document's whole live rule set with a reason no
  // reader had earned. It is a required parameter now; this pins the behaviour the type
  // signature protects.
  it("retires a rule the current reader did not produce, and keeps one it did", () => {
    for (const [statement, extractor] of [["old reader must go", "2"], ["current reader must stay", "3"]]) {
      store.addKnowledge({
        repoId, kind: "rule", source: "ingested", statement: statement ?? "", why: undefined, path: undefined,
        cwe: undefined, provenance: "PROG.md", sourceBlob: "blobA", extractor, confidence: undefined,
      });
    }
    expect(store.retireForChangedBlob(repoId, "PROG.md", "blobA", "3")).toBe(1);
    expect(store.knowledgeFor(repoId).map((k) => k.statement)).toStrictEqual(["current reader must stay"]);
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

  it("round-trips a fixed_elsewhere claim (D-133)", () => {
    newReview("rev1");
    store.recordFixedElsewhere("rev1", "aaaa1111", "src/other.ts", 42, "moved the release call here");
    expect(store.fixedElsewhereFor("rev1")).toStrictEqual([
      { fingerprint: "aaaa1111", file: "src/other.ts", line: 42, reason: "moved the release call here" },
    ]);
  });

  it("stores a fixed_elsewhere claim with no line as undefined, not null", () => {
    newReview("rev1");
    store.recordFixedElsewhere("rev1", "aaaa1111", "src/other.ts", undefined, "file-level fix");
    expect(store.fixedElsewhereFor("rev1")).toHaveLength(1);
    expect(store.fixedElsewhereFor("rev1")[0]?.line).toBeUndefined();
  });

  it("scopes fixed_elsewhere claims to their own review", () => {
    newReview("rev1");
    newReview("rev2");
    store.recordFixedElsewhere("rev1", "aaaa1111", "src/other.ts", 1, "for rev1");
    store.recordFixedElsewhere("rev2", "bbbb2222", "src/another.ts", 2, "for rev2");
    expect(store.fixedElsewhereFor("rev1").map((c) => c.fingerprint)).toStrictEqual(["aaaa1111"]);
    expect(store.fixedElsewhereFor("rev2").map((c) => c.fingerprint)).toStrictEqual(["bbbb2222"]);
  });

  // Regression for fingerprint f83d72a1: `fixed_elsewhere_claim` was created WITHOUT
  // `ON DELETE CASCADE` on its review_id FK, the one thing `deleteReviewsBefore`'s own
  // docblock already names as fatal — a child row with no cascade makes the retention
  // sweep's plain `DELETE FROM review` violate the FK and roll back the WHOLE
  // transaction, forever, the first time any review carrying a claim ages past
  // retention. This asserts the sweep survives a terminal review that has one.
  it("cascades a fixed_elsewhere claim when retention sweeps its review (D-133)", () => {
    newReview("rev1");
    store.recordFixedElsewhere("rev1", "aaaa1111", "src/other.ts", 1, "reason");
    store.db.prepare("UPDATE review SET state = 'passed', updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'rev1'").run();

    const deleted = store.deleteReviewsBefore("2099-01-01T00:00:00.000Z");

    expect(deleted).toBe(1);
    expect(store.fixedElsewhereFor("rev1")).toStrictEqual([]);
  });

  // b1a9841c, found by lore's own review: every OTHER id-comparison path in this
  // file (retirePolicy, policyByShort, the appeal grammar) resolves a prefix;
  // resolveConflict matched keep/retire with exact `=`. A client naturally holds
  // the SAME rule in two lengths — open_questions renders full ids, knowledge_teach
  // returns both a full id and an 8-char cite_as — so mixing them (full for one
  // side, short for the other, the obvious thing to do with two ids for one rule)
  // must still resolve, or a needs_human review a person HAD just decided stays
  // parked with nothing naming why.
  it("settles a conflict named with a mix of full and short ids, not only two full ones", () => {
    const keep = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "always X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    const lose = store.addKnowledge({ repoId, kind: "rule", source: "derived", statement: "never X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    store.recordConflict(repoId, keep.id, lose.id);

    // Full id for the winner (as open_questions would render it), short cite_as
    // form for the loser (as knowledge_teach's reply would have given it).
    expect(store.resolveConflict(repoId, keep.id, lose.id.slice(0, 8), "the schema was changed in July")).toBe(true);
    expect(store.openConflicts(repoId)).toStrictEqual([]);
    // The LOSING rule must actually be retired, not merely the conflict row marked
    // resolved while the short id silently matched nothing to retire.
    expect(store.knowledgeFor(repoId).map((k) => k.id)).toStrictEqual([keep.id]);
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

  // Found by lore's own review (55452eb0): this used to return `void`, so
  // knowledge_escalate's handler could not tell a real escalation from a silent
  // no-op — a wrong id, another repo's ids, or a conflict already at needs-human —
  // and reported "Recorded" regardless.
  it("reports whether an escalation actually matched an open conflict", () => {
    const a = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "always X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    const b = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "never X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });

    expect(
      store.escalateConflict(repoId, a.id, b.id, "no conflict recorded yet"),
      "no recorded conflict between these two ids must not report success",
    ).toBe(false);

    store.recordConflict(repoId, a.id, b.id);
    expect(store.escalateConflict(repoId, a.id, b.id, "now it exists")).toBe(true);
    // Already at needs-human: escalating again matches no OPEN row.
    expect(
      store.escalateConflict(repoId, a.id, b.id, "escalating twice"),
      "a conflict already escalated must not report a fresh success",
    ).toBe(false);
  });

  // 457ef530, found by lore's own review, one method past b1a9841c's own fix for
  // resolveConflict's identical shape: escalateConflict still matched left/right
  // with exact `=`, while docs.ts's `resolve` text — offered right beside
  // `escalate` as the other thing to do with the same conflict — explicitly
  // blesses mixing a full id with an 8-char cite_as. A client has no reason to
  // expect the two tools to disagree about the same pair of ids.
  it("escalates a conflict named with a mix of full and short ids, not only two full ones", () => {
    const a = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "always X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    const b = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "never X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    store.recordConflict(repoId, a.id, b.id);

    // Full id for one side (as open_questions would render it), short cite_as
    // form for the other (as knowledge_teach's reply would have given it).
    expect(store.escalateConflict(repoId, a.id, b.id.slice(0, 8), "cannot decide")).toBe(true);
    expect(store.openConflicts(repoId)).toStrictEqual([{ left: a.id, right: b.id, state: "needs-human" }]);
  });

  // Found by lore's own review (372b6bf0, f9559e98): the path filter was a raw
  // `? LIKE path || '%'`, so a query for one directory pulled in a sibling one
  // sharing its text prefix — "src/payroll/x.ts" matched a rule scoped to "src/pay".
  it("scopes a path query to real path segments, not a raw text prefix", () => {
    store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "payments retry on timeout", why: undefined, path: "src/pay", cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    expect(store.knowledgeFor(repoId, "src/payroll/adapter.ts").map((k) => k.statement)).toStrictEqual([]);
    expect(store.knowledgeFor(repoId, "src/pay/hold.ts").map((k) => k.statement)).toStrictEqual(["payments retry on timeout"]);
    expect(store.knowledgeFor(repoId, "src/pay").map((k) => k.statement)).toStrictEqual(["payments retry on timeout"]);
  });

  // lore-ok[9cdd2299]: found by lore's own review. The prefix check used SQL LIKE,
  // which case-folds ASCII by default — so a rule scoped to "src/pay" was ALSO
  // served for a query naming "src/PAY", agreeing with neither the exact-match
  // branch beside it nor scopesOverlap (knowledge/conflict.ts), both case-sensitive.
  it("does not scope a path query case-insensitively", () => {
    store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "payments retry on timeout", why: undefined, path: "src/pay", cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    expect(store.knowledgeFor(repoId, "src/PAY/hold.ts").map((k) => k.statement)).toStrictEqual([]);
    expect(store.knowledgeFor(repoId, "SRC/pay/hold.ts").map((k) => k.statement)).toStrictEqual([]);
  });

  // lore-ok[9cdd2299]: found by lore's own review, the same fix as the case test
  // above. `%`/`_` in a taught path used to be live SQL wildcards in the LIKE
  // pattern (the same class already fixed for id lookups, a6a4b832) — a rule
  // scoped to "src/pay_v2" matched the unrelated sibling "src/payXv2" too, since
  // `_` matches any one character.
  it("does not treat wildcard characters in a taught path as patterns", () => {
    store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "v2 payments rule", why: undefined, path: "src/pay_v2", cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    expect(store.knowledgeFor(repoId, "src/payXv2/hold.ts").map((k) => k.statement)).toStrictEqual([]);
    expect(store.knowledgeFor(repoId, "src/pay_v2/hold.ts").map((k) => k.statement)).toStrictEqual(["v2 payments rule"]);
  });

  // Found by lore's own review (592cd49f): nothing that retires a rule for a reason
  // OTHER than resolving a conflict ever touched knowledge_conflict, so a conflict
  // naming a retired rule stayed open — and blocking — forever, with no way to
  // settle a contradiction one side of which no longer exists.
  it("stops counting a conflict as open once one of its rules is retired for an unrelated reason", () => {
    // An untouched control conflict, to prove the fix does not over-filter.
    const a = store.addKnowledge({ repoId, kind: "rule", source: "taught", statement: "always X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    const b = store.addKnowledge({ repoId, kind: "rule", source: "derived", statement: "never X", why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: undefined });
    store.recordConflict(repoId, a.id, b.id);

    // The pair that is about to lose a side to an ordinary document edit — the D-20
    // re-derive path, not a conflict resolution.
    const doc1 = store.addKnowledge({ repoId, kind: "rule", source: "ingested", statement: "always Y", why: undefined, path: undefined, cwe: undefined, provenance: "PROG.md", sourceBlob: "v1", confidence: undefined });
    const doc2 = store.addKnowledge({ repoId, kind: "rule", source: "ingested", statement: "never Y", why: undefined, path: undefined, cwe: undefined, provenance: "PROG.md", sourceBlob: "v1", confidence: undefined });
    store.recordConflict(repoId, doc1.id, doc2.id);
    expect(store.openConflicts(repoId)).toHaveLength(2);

    store.retireForChangedBlob(repoId, "PROG.md", "v2", "x");
    expect(
      store.openConflicts(repoId),
      "the conflict naming the two now-retired rules must stop blocking; the unrelated one must not",
    ).toStrictEqual([{ left: a.id, right: b.id, state: "open" }]);
  });

  // Found by lore's own review (aa57c0f2): `knowledgeFor` had no ORDER BY, so a plain
  // LIMIT returned whichever rows SQLite happened to enumerate first — the OLDEST
  // live rows in practice — meaning a repo past the cap silently lost its NEWEST
  // knowledge from every capped caller: review prompts, conflict detection,
  // knowledge_query. A person teaching a rule got a success reply and the rule was
  // never shown to anything.
  describe("knowledgeFor orders newest-verified first, and can be asked for everything (aa57c0f2)", () => {
    it("puts a just-taught rule ahead of two hundred older ones under the default cap", () => {
      for (let i = 0; i < 205; i++) {
        store.addKnowledge({
          repoId, kind: "rule", source: "ingested", statement: `old rule ${i}`, why: undefined, path: undefined,
          cwe: undefined, provenance: `doc${i}.md`, sourceBlob: `b${i}`, confidence: 0.5,
        });
      }
      const fresh = store.addKnowledge({
        repoId, kind: "rule", source: "taught", statement: "just taught, must not be silently dropped",
        why: undefined, path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: 1,
      });

      const capped = store.knowledgeFor(repoId);
      expect(capped.length, "the default cap must still apply").toBeLessThanOrEqual(200);
      expect(
        capped.some((k) => k.id === fresh.id),
        "the newest rule must survive the default cap, not be pushed out by 205 older ones",
      ).toBe(true);
    });

    it("returns every live row with NO_LIMIT, past the old 1000 ceiling", () => {
      for (let i = 0; i < 1005; i++) {
        store.addKnowledge({
          repoId, kind: "rule", source: "ingested", statement: `rule ${i}`, why: undefined, path: undefined,
          cwe: undefined, provenance: `doc${i}.md`, sourceBlob: `b${i}`, confidence: 0.5,
        });
      }
      expect(store.knowledgeFor(repoId, undefined, NO_LIMIT)).toHaveLength(1005);
    });
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
 * WHICH TERMINAL ENDINGS GENUINELY SELF-RESOLVE, and `failed` is not one of them.
 *
 * Found live: a HIGH finding sat on `master` for four days, undelivered, invisible to
 * this exact query the whole time — because the review carrying it ended `failed`, and
 * the query excluded every terminal state alike. `cancelled` is safe to exclude because
 * `review_cancel` hands its findings over explicitly at the moment of cancelling;
 * `expired` is safe because the client was told repeatedly over days before it happened.
 * `failed` can happen on a review's very first round, with no warning and no handover.
 */
describe("uncollectedHighOlderThan", () => {
  const old = "2020-01-01T00:00:00.000Z";

  it("counts a HIGH finding sitting on a FAILED review, unlike expired or cancelled", () => {
    newReview("revFailed");
    store.recordFinding("revFailed", finding("f1", { firstSeen: old }));
    store.updateReview("revFailed", { state: "failed" });

    newReview("revExpired");
    store.recordFinding("revExpired", finding("f2", { firstSeen: old }));
    store.updateReview("revExpired", { state: "expired" });

    newReview("revCancelled");
    store.recordFinding("revCancelled", finding("f3", { firstSeen: old }));
    store.updateReview("revCancelled", { state: "cancelled" });

    // ONE review counted, not three — `failed` only. A review whose ending genuinely
    // self-resolves must not inflate a ticket meant to prompt a person into action.
    expect(store.uncollectedHighOlderThan(1)).toBe(1);
  });

  it("does not count once the finding is delivered, whatever the review's ending", () => {
    newReview("revFailed");
    store.recordFinding("revFailed", finding("f1", { firstSeen: old }));
    store.markDelivered("revFailed", ["f1"]);
    store.updateReview("revFailed", { state: "failed" });

    expect(store.uncollectedHighOlderThan(1)).toBe(0);
  });

  it("ignores a finding younger than the threshold", () => {
    newReview("revFailed");
    store.recordFinding("revFailed", finding("f1", { firstSeen: new Date().toISOString() }));
    store.updateReview("revFailed", { state: "failed" });

    expect(store.uncollectedHighOlderThan(24)).toBe(0);
  });

  // D-68's reasoning applies here too: an inherited pattern match is not this branch's
  // own defect, and an alert that fires on it every day is one nobody reads.
  it("ignores medium severity and inherited findings", () => {
    newReview("revFailed");
    store.recordFinding("revFailed", finding("f1", { firstSeen: old, severity: "medium" }));
    store.recordFinding("revFailed", finding("f2", { firstSeen: old, preexisting: true }));
    store.updateReview("revFailed", { state: "failed" });

    expect(store.uncollectedHighOlderThan(1)).toBe(0);
  });
});

// 038955e5, found by lore's own review: `/status`'s JSON endpoint
// (service/http.ts's uncollected field) read this with no review-state filter at
// all — not even `uncollectedHighOlderThan`'s own exclusion, right above, for the
// identical underlying fact. An `expired` or `cancelled` review's findings are
// either permanently uncollectible or already handed over at the cancel itself.
describe("uncollectedByReview", () => {
  const old = "2020-01-01T00:00:00.000Z";

  it("lists a FAILED review's undelivered finding, unlike expired or cancelled", () => {
    newReview("revFailed");
    store.recordFinding("revFailed", finding("f1", { firstSeen: old }));
    store.updateReview("revFailed", { state: "failed" });

    newReview("revExpired");
    store.recordFinding("revExpired", finding("f2", { firstSeen: old }));
    store.updateReview("revExpired", { state: "expired" });

    newReview("revCancelled");
    store.recordFinding("revCancelled", finding("f3", { firstSeen: old }));
    store.updateReview("revCancelled", { state: "cancelled" });

    const rows = store.uncollectedByReview();
    expect(rows.map((r) => r["id"])).toStrictEqual(["revFailed"]);
  });

  // be79f02a, found by lore's own review: this counted every `high` alike, unlike
  // `uncollectedHighOlderThan` right above (`f.preexisting = 0`) and
  // `ops/status.ts`'s `uncollectedLines` (the `high`/`high_pre` split) — the two
  // other representations of the exact same fact. A branch whose only OWN finding
  // is a `low`, plus inherited fixture noise reported as branch-caused highs, is
  // D-68's own example of the wolf-crying this omission reproduced on the one
  // surface a monitor SCRIPT reads rather than a person.
  it("splits branch-caused highs from inherited ones, like the other two uncollected surfaces", () => {
    newReview("revMixed");
    store.recordFinding("revMixed", finding("own1", { firstSeen: old, severity: "high" }));
    store.recordFinding("revMixed", finding("inherited1", { firstSeen: old, severity: "high", preexisting: true }));
    store.recordFinding("revMixed", finding("inherited2", { firstSeen: old, severity: "high", preexisting: true }));

    const row = store.uncollectedByReview().find((r) => r["id"] === "revMixed");
    expect(row?.["high"], "only the branch's own high").toBe(1);
    expect(row?.["high_pre"], "the two inherited highs, counted separately").toBe(2);
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

  /**
   * `review` as it stood before D-130 (`review_path` did not exist), including a real
   * row written under that shape — `into_ref` populated, `NOT NULL`, no other option.
   * The scenario this de-risks: `into_ref` predates folder mode and cannot have its
   * constraint relaxed by this migration system (ADD COLUMN only), so a folder review
   * writes "" to it instead (store.ts's createReview). This proves that write actually
   * succeeds against a real pre-D-130 table, not only against the fixture every other
   * test in this file creates fresh.
   */
  const V1_REVIEW = `CREATE TABLE review (
    id           TEXT PRIMARY KEY,
    repo_id      TEXT NOT NULL,
    principal    TEXT NOT NULL,
    token_hash   TEXT,
    tiers        TEXT,
    branch       TEXT NOT NULL,
    pull_request TEXT,
    into_ref     TEXT NOT NULL,
    ticket       TEXT NOT NULL,
    type         TEXT NOT NULL,
    state        TEXT NOT NULL,
    tree_hash    TEXT,
    base_commit  TEXT,
    ladder       TEXT NOT NULL,
    failed_because TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`;

  it("adds review_path to a pre-D-130 review table, and a folder review can then be written", () => {
    const path = join(dir, "pre-d130.db");
    const v1 = new DatabaseSync(path);
    v1.exec(V1_REVIEW);
    v1.exec(
      `INSERT INTO review(id, repo_id, principal, branch, into_ref, ticket, type, state, ladder, created_at, updated_at)
       VALUES('old-rev', 'repo1', 'tok_x', 'main', 'origin/main', 't', 'code-arch', 'passed', '{}', '2026-01-01', '2026-01-01')`,
    );
    v1.close();

    const migrated = new Store(path);
    // The pre-existing row is untouched by the migration.
    expect(
      migrated.db.prepare("SELECT into_ref, review_path FROM review WHERE id = 'old-rev'").get(),
    ).toMatchObject({ into_ref: "origin/main", review_path: null });

    // A folder review, written against the now-migrated table, does not trip the
    // pre-existing into_ref NOT NULL constraint.
    const repoId = migrated.upsertRepo("demo", "git@x:demo.git").id;
    expect(() =>
      migrated.createReview({
        id: "folder-rev",
        repoId,
        principal: "tok_x",
        branch: "feat/y",
        reviewPath: "src",
        ticket: "t",
        type: "code-arch",
        state: "running",
        ladder: initialState(),
      }),
    ).not.toThrow();
    expect(migrated.getReview("folder-rev", "tok_x")?.reviewPath).toBe("src");
    expect(migrated.getReview("folder-rev", "tok_x")?.intoRef).toBeUndefined();
    migrated.close();
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

/**
 * A DIFF ACCEPTED WHILE A ROUND RUNS, waiting for the reviewer's next emission (D-107).
 * Arrival order is the contract: each held diff was built by the client on top of the
 * one before it, so consuming out of order can never verify.
 */
describe("held diffs", () => {
  it("keeps them in arrival order and consumes one at a time", () => {
    const repoId = store.upsertRepo("d", "git@x:d.git").id;
    store.createReview({
      id: "rh", repoId, principal: "p", branch: "b", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
    store.holdDiff("rh", "diff-1", "hash-1");
    store.holdDiff("rh", "diff-2", "hash-2");

    const held = store.heldDiffs("rh");
    expect(held.map((h) => h.diff)).toStrictEqual(["diff-1", "diff-2"]);

    store.clearHeldDiff("rh", held[0]?.id);
    expect(store.heldDiffs("rh").map((h) => h.diff)).toStrictEqual(["diff-2"]);

    // The mismatch path drops the whole remaining chain at once.
    store.clearHeldDiff("rh");
    expect(store.heldDiffs("rh")).toStrictEqual([]);
  });
});

/**
 * Refactor runs (D-136) — separate from `review` throughout: no `review_id` anywhere,
 * its own queue, its own state machine. Weighted toward the same INV-1 shape review's
 * own tests are: a run that could not be claimed twice, a failure that says why.
 */
describe("refactor runs", () => {
  it("round-trips create, claim, finish and the suggestions it recorded", () => {
    store.createRefactorRun({ id: "rf1", repoId, principal: PRINCIPAL, commitSha: "abc1234", folder: "src/store" });
    expect(store.refactorRun("rf1")?.state).toBe("queued");

    const claimed = store.claimRefactorRun();
    expect(claimed).toStrictEqual({ id: "rf1", repoId, commitSha: "abc1234", folder: "src/store" });
    expect(store.refactorRun("rf1")?.state).toBe("running");

    store.finishRefactorRun("rf1", {
      state: "done",
      combined: true,
      sources: [{ tier: "t2", ok: true, count: 1 }, { tier: "t3", ok: true, count: 1 }],
    });
    store.recordRefactorSuggestions("rf1", [
      { title: "Split the store's query surface", area: ["src/store/store.ts"], rationale: "read by different callers", roughSize: "medium" },
    ]);

    const row = store.refactorRun("rf1");
    expect(row?.state).toBe("done");
    expect(row?.combined).toBe(true);
    expect(row?.sources).toStrictEqual([{ tier: "t2", ok: true, count: 1 }, { tier: "t3", ok: true, count: 1 }]);
    expect(row?.suggestions).toStrictEqual([
      { title: "Split the store's query surface", area: ["src/store/store.ts"], rationale: "read by different callers", roughSize: "medium" },
    ]);
  });

  /**
   * IDS ARE `refactor_<random>` (`newRefactorRunId`, mcp/server.ts) — NOT an
   * autoincrement integer the way `job.id` is, so `refactor_zzz` created first and
   * `refactor_aaa` created second is a real, ordinary case, not a contrived one. Chosen
   * exactly that way (second-created sorts first alphabetically) so a claim ordered by
   * `id` would pass this test for the wrong reason — this asserts creation order under
   * the one arrangement where id-order and creation-order actively disagree.
   */
  it("claims one queued run at a time, atomically, in creation order — not id order", () => {
    store.createRefactorRun({ id: "refactor_zzz_first", repoId, principal: PRINCIPAL, commitSha: "a", folder: "." });
    store.createRefactorRun({ id: "refactor_aaa_second", repoId, principal: PRINCIPAL, commitSha: "b", folder: "." });
    // Both land in the same test tick and could share a millisecond `created_at`
    // (`now()`'s own precision) — spread deliberately so the ordering this test checks
    // is unambiguous rather than resting on real-clock luck.
    store.db.prepare("UPDATE refactor_run SET created_at = '2026-08-01T00:00:00.000Z' WHERE id = 'refactor_zzz_first'").run();
    store.db.prepare("UPDATE refactor_run SET created_at = '2026-08-01T00:00:01.000Z' WHERE id = 'refactor_aaa_second'").run();

    expect(store.claimRefactorRun()?.id).toBe("refactor_zzz_first");
    // Now 'running', not 'queued' — a second claim must not return it again.
    expect(store.claimRefactorRun()?.id).toBe("refactor_aaa_second");
    expect(store.claimRefactorRun()).toBeUndefined();
  });

  it("records why a run failed, distinctly from a run that never started", () => {
    store.createRefactorRun({ id: "rf1", repoId, principal: PRINCIPAL, commitSha: "a", folder: "." });
    store.claimRefactorRun();
    store.finishRefactorRun("rf1", { state: "failed", lastError: "every tier failed: t2: quota exhausted" });

    const row = store.refactorRun("rf1");
    expect(row?.state).toBe("failed");
    expect(row?.lastError).toBe("every tier failed: t2: quota exhausted");
    expect(row?.combined).toBeUndefined();
  });

  it("says a run that did not combine why, rather than leaving the field ambiguous", () => {
    store.createRefactorRun({ id: "rf1", repoId, principal: PRINCIPAL, commitSha: "a", folder: "." });
    store.finishRefactorRun("rf1", {
      state: "done",
      combined: false,
      combinerNote: "no usable t1 tier is configured to combine — showing the uncombined sets",
      sources: [{ tier: "t2", ok: true, count: 2 }],
    });

    const row = store.refactorRun("rf1");
    expect(row?.combined).toBe(false);
    expect(row?.combinerNote).toContain("no usable t1");
  });

  it("returns undefined for a run that was never created", () => {
    expect(store.refactorRun("nope")).toBeUndefined();
  });

  /**
   * `recentRefactorRuns`' own `SELECT` never fetches `sources` (its own doc comment:
   * "no suggestions in the row") — so a row recorded with `sources` at ALL, via the
   * exact same `finishRefactorRun` a `refactorRun` reader would see it through, must
   * still come back with no `sources` key here. `toRefactorRun`, the mapper shared
   * with `refactorRun`, distinguishes an absent key from `NULL` internally — this is
   * the regression test for getting that distinction right, not merely for the field
   * being unset on a run that never recorded one.
   */
  it("never carries sources, even for a run that recorded some", () => {
    store.createRefactorRun({ id: "rf1", repoId, principal: PRINCIPAL, commitSha: "abc1234", folder: "src/store" });
    store.finishRefactorRun("rf1", {
      state: "done",
      combined: true,
      sources: [{ tier: "t2", ok: true, count: 1 }],
    });

    expect(store.refactorRun("rf1")?.sources).toStrictEqual([{ tier: "t2", ok: true, count: 1 }]);

    const { runs } = store.recentRefactorRuns(repoId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toHaveProperty("sources");
    expect(runs[0]?.combined).toBe(true);
  });

  it("lists runs repo-scoped, newest first, and says how many older ones it did not show", () => {
    store.createRefactorRun({ id: "rf-old", repoId, principal: PRINCIPAL, commitSha: "a", folder: "." });
    store.createRefactorRun({ id: "rf-new", repoId, principal: PRINCIPAL, commitSha: "b", folder: "." });
    store.db.prepare("UPDATE refactor_run SET created_at = '2026-08-01T00:00:00.000Z' WHERE id = 'rf-old'").run();
    store.db.prepare("UPDATE refactor_run SET created_at = '2026-08-01T00:00:01.000Z' WHERE id = 'rf-new'").run();
    const otherRepoId = store.upsertRepo("other", "git@x:other.git").id;
    store.createRefactorRun({ id: "rf-elsewhere", repoId: otherRepoId, principal: PRINCIPAL, commitSha: "c", folder: "." });

    const { runs, notShown } = store.recentRefactorRuns(repoId, 1);
    expect(runs.map((r) => r.id)).toStrictEqual(["rf-new"]);
    expect(notShown).toBe(1);
  });
});

// lore-ok[ad96016b]: found by lore's own review, a third time against the same
// column list — `finding.delivered_at` was the first miss this file's own comment
// names. `held_diff.created_at` and `tier_run.finished_at` were the second and
// third: the held path is the ONLY durable write a review_submit held mid-round
// makes (D-107), and a tier CLOSING (not just opening) is the moment its own
// outcome and findings are recorded — both invisible to the replica monitor before
// this fix, exactly the kind of silent gap `lastWriteAt`'s own doc comment already
// warns is easy to reintroduce.
describe("lastWriteAt", () => {
  const old = "2020-01-01T00:00:00.000Z";
  /** Pins every OTHER covered write to something unambiguously in the past. */
  const pinPast = (reviewId: string) => {
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = ?").run(old, reviewId);
    store.db.prepare("UPDATE repo SET created_at = ? WHERE id = ?").run(old, repoId);
  };

  it("counts a held diff, even when nothing else has moved since", () => {
    newReview("rev1");
    pinPast("rev1");
    expect(store.lastWriteAt()).toBe(old);

    store.holdDiff("rev1", "diff text", "treehash123");

    expect(store.lastWriteAt(), "the held diff's own write must move the clock").not.toBe(old);
  });

  it("counts a tier run closing, not only opening", () => {
    newReview("rev1");
    pinPast("rev1");
    const id = store.openTierRun("rev1", "t1", 1, old);
    expect(store.lastWriteAt(), "an old started_at alone must not move the clock").toBe(old);

    store.closeTierRun(id, "clean", []);

    expect(store.lastWriteAt(), "closing the tier run must move the clock").not.toBe(old);
  });

  /**
   * A FOURTH gap, found reading this method against `schema.ts` rather than by a
   * review round — `refactor_run`/`refactor_suggestion` (D-136) never reached this
   * list at all, so a workgroup running only refactor suggestions (no reviews, no
   * knowledge writes) would have read as a dead replicator throughout.
   * `recordRefactorSuggestions` covers `refactor_suggestion.created_at`;
   * `finishRefactorRun` alone (no later `recordRefactorSuggestions` call) would
   * still leave `refactor_run.updated_at` as the only mover, so this checks both
   * paths independently rather than only the common one where both fire together.
   */
  it("counts a refactor run, and its suggestions, not only a review", () => {
    newReview("rev1");
    pinPast("rev1");
    store.createRefactorRun({ id: "rf1", repoId, principal: PRINCIPAL, commitSha: "abc1234", folder: "." });
    store.db.prepare("UPDATE refactor_run SET updated_at = ? WHERE id = 'rf1'").run(old);
    expect(store.lastWriteAt(), "an old refactor_run alone must not move the clock").toBe(old);

    store.finishRefactorRun("rf1", { state: "done", combined: true, sources: [{ tier: "t2", ok: true, count: 1 }] });
    expect(store.lastWriteAt(), "finishing the refactor run must move the clock").not.toBe(old);

    store.db.prepare("UPDATE refactor_run SET updated_at = ? WHERE id = 'rf1'").run(old);
    store.recordRefactorSuggestions("rf1", [{ title: "x", area: ["src/x.ts"], rationale: "y", roughSize: "small" }]);
    expect(store.lastWriteAt(), "recording a suggestion must move the clock too").not.toBe(old);
  });
});

/**
 * THE DEPLOY WINDOW: a round finishing after the store has closed.
 *
 * `Worker.round` writes its own completion, and on shutdown the handle is already shut —
 * `node:sqlite` throws `ERR_INVALID_STATE: database is not open` out of a detached
 * promise, which is an unhandled rejection during exactly the window three deploys have
 * gone wrong in. Refusing the write is safe ONLY because every one of these is
 * recoverable: the job row stays `running` and `reclaimOrphanedJobs` requeues it at the
 * next start. That is the same outcome, without the crash.
 */
describe("a round completing into a closed store", () => {
  it("refuses the write instead of throwing, and says so", () => {
    const s = new Store(":memory:");
    const repoId = s.upsertRepo("r", "git@x:r.git").id;
    s.createReview({
      id: "revC", repoId, principal: "p", branch: "b", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
    s.enqueue("revC", "fast");
    const job = s.claimJob();
    expect(job).toBeDefined();

    s.close();
    expect(s.isClosed()).toBe(true);

    // All three of the round's ending writes. Before this, the first one threw.
    expect(() => s.finishJob(job?.id ?? 0, "done")).not.toThrow();
    expect(() => s.updateReview("revC", { state: "failed" })).not.toThrow();
    expect(() => s.setFailureReason("revC", "whatever")).not.toThrow();
  });

  // The guard is deliberately NOT a general shield: a write to a closed store anywhere
  // else is still a defect and must still be loud.
  it("still throws for writes that are not a round's ending", () => {
    const s = new Store(":memory:");
    s.close();
    expect(() => s.upsertRepo("r", "git@x:r2.git")).toThrow();
  });
});
