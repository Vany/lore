import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmbiguousFingerprint } from "../core/errors.ts";
import { initialState } from "../core/ladder.ts";
import { SCHEMA_VERSION, applyMigrations } from "./schema.ts";
import { SETTLING_VERDICTS, Store, type RecordedFinding, type VerdictKind } from "./store.ts";

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

  // ANNOUNCED AFTER THE WRITE, and the comment saying so used to sit above a call
  // that ran before it. A client woken first re-reads and sees the state it was told
  // had changed; if the write then throws it waits for a second wake that never comes.
  // Caught by t2 on the commit that wrote the comment — the false-statement-about-
  // behaviour this repository is worst at, inside the feature meant to keep clients
  // informed.
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
  // already refuses. Raised by t2 two rounds after subscriptions landed.
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
  // again. Raised by t1 one round after subscriptions landed, in a file the comment
  // predicting exactly this had never reached.
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
  // `findings_ready` and handed nothing, for ever.
  //
  // Raised by t1 — the cheapest tier — one round after SETTLING_VERDICTS was
  // introduced precisely to stop "settled" being defined twice. It had been applied
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
