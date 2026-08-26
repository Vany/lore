/**
 * The two clocks, and the sentence that separates working from wedged.
 *
 * A board that shows a healthy review as stalled is worse than no board: an operator
 * learns to ignore the number, and then the real forty-five-minute hang looks the same as
 * every false alarm they trained themselves past. So the interesting assertions here are
 * all about which of the two readings a given database produces.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import type { ReviewState } from "../core/review-state.ts";
import { Store } from "../store/store.ts";
import { board } from "./board.ts";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-board-"));
  store = new Store(join(dir, "lore.db"));
  repoId = store.upsertRepo("demo", "git@example.com:o/demo.git").id;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const review = (id: string, state: ReviewState, branch = "feat/x") =>
  store.createReview({
    id, repoId, principal: "p", branch, intoRef: "main",
    ticket: "t", type: "code-arch", state, ladder: initialState(),
  });

const find = (id: string) => board(store).reviews.find((r) => r.id === id);

describe("what a review is doing right now", () => {
  it("names the tier that is working, and no note", () => {
    review("r1", "running");
    store.openTierRun("r1", "t2", 3, ago(600_000));

    const r = find("r1");
    expect(r?.step, "the collapsed row's whole point").toBe("t2");
    expect(r?.stepNote, "a tier IS working, so there is nothing to explain").toBeUndefined();
  });

  /**
   * THE STALL THAT COST FOUR AND A HALF HOURS. A `running` review with every tier row
   * closed is not progressing visibly, and it must not render as ordinary progress —
   * `running` alone never said which tier, and that was the entire question.
   */
  it("says loudly when NO tier is working", () => {
    review("r1", "running");
    const t = store.openTierRun("r1", "t1", 1, ago(900_000));
    store.closeTierRun(t, "clean", []);

    const r = find("r1");
    expect(r?.step, "nothing is working, and that is a fact rather than a blank").toBeUndefined();
    expect(r?.stepNote).toMatch(/NO TIER IS WORKING/);
  });

  it("distinguishes never-started from between-tiers", () => {
    review("r1", "running");
    expect(find("r1")?.stepNote).toMatch(/starting/);
  });

  /**
   * A QUEUED REVIEW SAYS WHAT IT IS WAITING FOR, and it must not name a thing that no
   * longer exists.
   *
   * The first version pointed at the model-call gate and said rounds wait for a slot —
   * written before D-98 removed that gate in the same branch, so the board would have
   * blamed a slot while the header beside it read `model calls 0`. Two facts on one page
   * contradicting each other build the wrong intuition about why work is stuck, which is
   * worse than explaining nothing. There was no test; there is now.
   */
  it("explains a queued review without blaming a gate that no longer exists", () => {
    review("r1", "queued");
    const note = find("r1")?.stepNote ?? "";
    expect(note, "the honest fact: nothing has run").toMatch(/no worker has claimed it/i);
    // The removed semaphore, by any of its names.
    expect(note).not.toMatch(/model[- ]call gate|wait(ing)? for a model slot/i);
    // And it does not invent congestion either — see the drain test below for why.
    expect(note).not.toMatch(/every worker loop is busy/i);
    expect(note, "queued at all is the anomaly now").toMatch(/under a second|should take/i);
  });

  /**
   * THE NOTE REPORTS A FACT THE BOARD HOLDS, RATHER THAN GUESSING ONE.
   *
   * It has been wrong twice. It blamed the model-slot gate that the same branch deleted;
   * then it blamed worker-loop congestion, and Vany found a review queued while ELEVEN OF
   * TWELVE LOOPS WERE IDLE — the real cause, `draining`, sitting in the very payload that
   * rendered the row. An operator reading that goes hunting for capacity they do not need
   * while the flag that stopped their work is in the banner above.
   */
  it("names DRAINING as the reason when that is the reason", () => {
    review("r1", "queued");
    store.setDraining(true);

    const note = find("r1")?.stepNote ?? "";
    expect(note).toMatch(/DRAINING/);
    expect(note, "and what to do about it").toMatch(/drain-off/);
    // Never the guess, when the fact is available.
    expect(note).not.toMatch(/worker loop is busy/i);
  });

  // A finished review explains nothing about tiers; the note would be noise on every row.
  it("says nothing about phases for a review that has ended", () => {
    review("r1", "passed");
    expect(find("r1")?.stepNote).toBeUndefined();
  });
});

describe("the two clocks", () => {
  /**
   * `updated_at` MOVES ON STATE CHANGES ONLY, and a tier can read a repository for twenty
   * minutes without changing state. A board built on it alone reports every healthy deep
   * round as stalled from the moment it began.
   */
  it("counts a stall from the last thing that moved, not from the last state change", () => {
    review("r1", "running");
    // The state has not changed for an hour, but a tier opened a minute ago.
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = 'r1'").run(ago(3_600_000));
    store.openTierRun("r1", "t2", 1, ago(60_000));

    const moved = Date.parse(find("r1")?.movedAt ?? "");
    expect(Date.now() - moved, "one minute, not one hour").toBeLessThan(120_000);
  });

  // A tier that raised findings ten seconds ago is the clearest possible evidence of life,
  // and it does not touch the review row at all.
  it("counts a finding as movement", () => {
    review("r1", "running");
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = 'r1'").run(ago(3_600_000));
    const t = store.openTierRun("r1", "t1", 1, ago(3_600_000));
    store.closeTierRun(t, "findings", []);
    store.db.prepare("UPDATE tier_run SET started_at = ?, finished_at = ? WHERE id = ?")
      .run(ago(3_600_000), ago(3_600_000), t);
    store.recordFinding("r1", {
      fingerprint: "f1", file: "a.ts", line: 1, symbol: "s", severity: "high",
      claim: "c", evidence: "e", failureScenario: "s", origin: "t1", round: 1,
      firstSeen: ago(10_000),
    });

    const moved = Date.parse(find("r1")?.movedAt ?? "");
    expect(Date.now() - moved, "ten seconds, not an hour").toBeLessThan(60_000);
  });

  it("carries the start, so total elapsed is the browser's to compute", () => {
    review("r1", "running");
    expect(Date.parse(find("r1")?.createdAt ?? "")).toBeGreaterThan(0);
  });

  /**
   * A FINISHED REVIEW'S TOTAL TIME STOPS. Without an end the page counts from `createdAt`
   * to now for ever, so a review that passed on Monday claims to have spent four days
   * working — a number that grows while nothing happens is this project's own failure
   * mode rendered in a table.
   */
  it("freezes the total for a review that has ended, and only then", () => {
    review("live", "running", "feat/live");
    review("done", "passed", "feat/done");

    expect(find("live")?.endedAt, "still going — there is no end to state").toBeUndefined();
    expect(Date.parse(find("done")?.endedAt ?? ""), "ended, so the clock has a stop").toBeGreaterThan(0);
  });
});

describe("what the expanded detail carries", () => {
  it("lists every tier attempt, open ones without a finish", () => {
    review("r1", "running");
    const a = store.openTierRun("r1", "t0", 1, ago(300_000));
    store.closeTierRun(a, "clean", []);
    store.openTierRun("r1", "t1", 1, ago(100_000));

    const tiers = find("r1")?.tiers ?? [];
    expect(tiers.map((t) => t.tier)).toStrictEqual(["t0", "t1"]);
    expect(tiers[0]?.finishedAt, "a closed run has an end").toBeDefined();
    // Absent rather than null: JSON.stringify drops the key, so a reader cannot mistake an
    // unfinished run for one that finished at time zero.
    expect(tiers[1]?.finishedAt).toBeUndefined();
    expect(tiers[1]?.outcome).toBeUndefined();
  });

  // INV-1 on the operator surface. Every other number on this row says what happened; the
  // absence of this line would quietly claim full coverage.
  it("carries checks that did not run, once each however many rounds saw them", () => {
    review("r1", "running");
    const a = store.openTierRun("r1", "t0", 1, ago(300_000));
    store.closeTierRun(a, "clean", ["eslint: not configured", "tests: disabled"]);
    const b = store.openTierRun("r1", "t0", 2, ago(200_000));
    store.closeTierRun(b, "clean", ["eslint: not configured"]);

    expect([...(find("r1")?.checksSkipped ?? [])].map((c) => c.text).sort())
      .toStrictEqual(["eslint: not configured", "tests: disabled"]);
    // AND EACH IS LABELLED. Both of these are genuine losses; the label exists because one
    // KIND of entry is not, and the board used to print "did not run:" in front of a
    // sentence whose own words were "the tier ran and its opinion counts in full".
    expect(find("r1")?.checksSkipped.every((c) => !c.ranAnyway), "both are real losses").toBe(true);
  });

  /**
   * Open findings, not raw ones. A board counting every finding ever raised shows five
   * problems when the author has answered four — the number would rise as work was done.
   */
  it("counts findings by severity, and separately how many are still work", () => {
    review("r1", "findings_ready");
    for (const [fp, sev] of [["f1", "high"], ["f2", "medium"], ["f3", "medium"]] as const) {
      store.recordFinding("r1", {
        fingerprint: fp, file: "a.ts", line: 1, symbol: "s", severity: sev,
        claim: "c", evidence: "e", failureScenario: "s", origin: "t1", round: 1,
        firstSeen: new Date().toISOString(),
      });
    }
    store.recordVerdict("r1", {
      fingerprint: "f1", verdict: "fixed", rationale: "done", scope: undefined, tier: "t1", round: 2,
    });

    const r = find("r1");
    expect(r?.findings.high).toBe(1);
    expect(r?.findings.medium).toBe(2);
    expect(r?.findings.open, "the answered one stopped being work").toBe(2);
  });
});

/**
 * Findings hang under the ATTEMPT that raised them, which is what makes the detail
 * readable without a "raised by" label on every line — the nesting is the answer.
 *
 * `finding.origin` is the tier id and `finding.round` the round, exactly the pair a
 * `tier_run` is identified by, so this is a join and not a heuristic. Verified against
 * the live database before it was written: zero findings fail to match.
 */
describe("findings under the step that raised them", () => {
  const raise = (id: string, fp: string, origin: string, round: number, sev = "medium") =>
    store.recordFinding(id, {
      fingerprint: fp, file: "src/a.ts", line: 12, symbol: "fn",
      severity: sev as "high" | "medium" | "low", claim: `claim ${fp}`, evidence: "the proof",
      failureScenario: "given x, y happens", origin, round, firstSeen: new Date().toISOString(),
    });

  it("puts each finding under its own tier attempt", () => {
    review("r1", "findings_ready");
    const a = store.openTierRun("r1", "t1", 1, ago(600_000));
    store.closeTierRun(a, "findings", []);
    const b = store.openTierRun("r1", "t2", 2, ago(300_000));
    store.closeTierRun(b, "findings", []);
    raise("r1", "f1", "t1", 1);
    raise("r1", "f2", "t2", 2);
    raise("r1", "f3", "t2", 2);

    const tiers = find("r1")?.tiers ?? [];
    expect(tiers.map((t) => t.findings.map((f) => f.fingerprint))).toStrictEqual([["f1"], ["f2", "f3"]]);
    // The same tier in a LATER round is a different attempt, and its findings are not
    // retrospectively attributed to the earlier one.
    expect(tiers[0]?.tier).toBe("t1");
  });

  it("carries the whole finding, because the point is to read it here", () => {
    review("r1", "findings_ready");
    const a = store.openTierRun("r1", "t1", 1, ago(600_000));
    store.closeTierRun(a, "findings", []);
    raise("r1", "f1", "t1", 1, "high");

    const f = find("r1")?.tiers[0]?.findings[0];
    expect(f?.claim).toBe("claim f1");
    expect(f?.evidence).toBe("the proof");
    expect(f?.failureScenario).toBe("given x, y happens");
    expect(f?.severity).toBe("high");
    expect(f?.file).toBe("src/a.ts");
    expect(f?.line).toBe(12);
  });

  /**
   * A SETTLED FINDING MUST NOT LOOK LIKE AN OPEN ONE. A board where answered work reads
   * as outstanding work is a board whose reader learns to discount it.
   */
  it("says which findings have been answered, and how", () => {
    review("r1", "findings_ready");
    const a = store.openTierRun("r1", "t1", 1, ago(600_000));
    store.closeTierRun(a, "findings", []);
    raise("r1", "f1", "t1", 1);
    raise("r1", "f2", "t1", 1);
    store.recordVerdict("r1", {
      fingerprint: "f1", verdict: "justified-accepted", rationale: "bounded upstream",
      scope: undefined, tier: "t1", round: 2,
    });

    const byFp = Object.fromEntries((find("r1")?.tiers[0]?.findings ?? []).map((f) => [f.fingerprint, f]));
    expect(byFp["f1"]?.settled).toBe("justified-accepted");
    expect(byFp["f1"]?.settledBecause).toContain("bounded upstream");
    expect(byFp["f2"]?.settled, "still work").toBeUndefined();
  });

  /**
   * WHERE A FINDING IS FILED MUST NEVER DECIDE WHETHER IT IS SEEN. The grouping is a
   * presentation choice; a presentation choice that can swallow a finding is a defect of
   * the same shape as a review that did not run.
   */
  it("surfaces a finding that matches no tier attempt instead of dropping it", () => {
    review("r1", "findings_ready");
    const a = store.openTierRun("r1", "t1", 1, ago(600_000));
    store.closeTierRun(a, "findings", []);
    raise("r1", "f1", "t1", 1);
    raise("r1", "ghost", "t9", 7);

    const r = find("r1");
    expect(r?.tiers[0]?.findings.map((f) => f.fingerprint)).toStrictEqual(["f1"]);
    expect(r?.orphanFindings.map((f) => f.fingerprint)).toStrictEqual(["ghost"]);
  });

  // A cap that does not say what it dropped turns a partial list into a complete-looking
  // one — the same silence this whole service exists to refuse.
  it("counts what the cap left out rather than trimming quietly", () => {
    review("r1", "findings_ready");
    const a = store.openTierRun("r1", "t1", 1, ago(600_000));
    store.closeTierRun(a, "findings", []);
    for (let i = 0; i < 45; i++) raise("r1", `f${String(i).padStart(3, "0")}`, "t1", 1);

    const r = find("r1");
    expect(r?.tiers[0]?.findings.length).toBe(40);
    expect(r?.findingsNotShown, "and it says so").toBe(5);
  });

  it("says nothing was raised only when nothing was", () => {
    review("r1", "running");
    const a = store.openTierRun("r1", "t1", 1, ago(600_000));
    store.closeTierRun(a, "clean", []);
    expect(find("r1")?.tiers[0]?.findings).toStrictEqual([]);
    expect(find("r1")?.findingsNotShown).toBe(0);
  });
});

describe("which reviews are on the board at all", () => {
  it("keeps a finished review for a couple of hours, then drops it", () => {
    review("fresh", "passed", "feat/just-passed");
    review("stale", "passed", "feat/yesterday");
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = 'stale'").run(ago(6 * 3_600_000));

    const ids = board(store).reviews.map((r) => r.id);
    // A verdict that vanishes at the moment it arrives is the one you were watching for.
    expect(ids, "just finished — you were watching this").toContain("fresh");
    expect(ids, "and the board is about NOW").not.toContain("stale");
  });

  it("keeps an unfinished review however old it is", () => {
    review("old", "findings_ready");
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = 'old'").run(ago(48 * 3_600_000));
    expect(board(store).reviews.map((r) => r.id)).toContain("old");
  });

  it("puts unfinished work above finished work", () => {
    review("done", "passed", "feat/done");
    review("live", "running", "feat/live");
    // `done` was updated most recently, so a plain recency sort would put it first.
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = 'live'").run(ago(60_000));

    expect(board(store).reviews[0]?.id).toBe("live");
  });
});

/**
 * `needs_human` is the one state where a person IS the mechanism — no tier, retry or
 * sweep can end it. So the board owes them the argument, not the label.
 *
 * The MCP surface learned this the hard way: it shipped saying only that there was
 * something to decide, and a client answered that it could not surface a question it was
 * never given, and that guessing is what lore's own doctrine forbids everywhere else.
 */
describe("why a person is needed", () => {
  const teach = (statement: string, provenance: string) =>
    store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement, why: "read from the code",
      path: "src/ledger", cwe: undefined, provenance, sourceBlob: undefined, confidence: undefined,
    });

  const conflict = () => {
    const left = teach("Holds are released by capture()", "t2 on feat/x");
    const right = teach("Holds are released only by the settlement job", "koray, 2026-08-09");
    store.recordConflict(repoId, left.id, right.id);
    return { left: left.id, right: right.id };
  };

  it("carries both statements in full, with where each came from", () => {
    const ids = conflict();
    review("r1", "needs_human");

    const q = find("r1")?.openQuestions ?? [];
    expect(q).toHaveLength(1);
    const statements = [q[0]?.left.statement, q[0]?.right.statement];
    expect(statements).toContain("Holds are released by capture()");
    expect(statements).toContain("Holds are released only by the settlement job");
    // The provenance is what makes it decidable: one of these came from a person.
    expect([q[0]?.left.source, q[0]?.right.source]).toContain("koray, 2026-08-09");
    expect([q[0]?.left.id, q[0]?.right.id].sort()).toStrictEqual([ids.left, ids.right].sort());
  });

  // The question costs two queries, and a board of ordinary reviews should not pay them.
  it("asks only for the state that needs it", () => {
    conflict();
    review("r1", "running");
    expect(find("r1")?.openQuestions).toStrictEqual([]);
  });

  /**
   * A REAL AND CONFUSING STATE: parked, with nothing left to decide. It means the
   * contradiction was settled and nothing re-queued the review. An empty list here is
   * what the page turns into a sentence rather than a blank box.
   */
  it("is empty when the review is parked but the question has been settled", () => {
    review("r1", "needs_human");
    expect(find("r1")?.openQuestions).toStrictEqual([]);
  });
});

describe("the service facts above the list", () => {
  // Drained looks idle from outside and means the opposite: work arrives and nothing
  // claims it. Thirteen hours of exactly that is why the board leads with it.
  it("reports draining", () => {
    expect(board(store).draining).toBe(false);
    store.setDraining(true);
    expect(board(store).draining).toBe(true);
  });

  it("reports a tier lore has stopped asking, and whether the provider said so", () => {
    store.markTierUnavailable("t1", new Date(Date.now() + 3_600_000).toISOString(), "plan is out", 1, true);
    const down = board(store).tiersDown;
    expect(down.map((d) => d.tier)).toStrictEqual(["t1"]);
    // The flag travels rather than the reader inferring: a guess bounds only the
    // background screen, and reporting it as "not being asked" claims a coverage gap
    // that is not happening.
    expect(down[0]?.stated).toBe(true);
  });

  /**
   * A CAP THAT DOES NOT ANNOUNCE ITSELF TELLS AN OPERATOR THEY HAVE SEEN EVERYTHING.
   *
   * The ordering drops finished work first, so what falls off is the least interesting —
   * but that is a property of the ordering, not a promise about the sixty-first row, and
   * the whole reason to open this page is to hunt a review nobody has touched in an hour.
   * Raised by lore's own t2.
   */
  it("says how many reviews the row cap left out", () => {
    for (let i = 0; i < 63; i++) review(`r${String(i).padStart(3, "0")}`, "running", `feat/${i}`);
    const b = board(store);
    expect(b.reviews.length).toBe(60);
    expect(b.reviewsNotShown).toBe(3);
  });

  it("says nothing was left out when nothing was", () => {
    review("r1", "running");
    expect(board(store).reviewsNotShown).toBe(0);
  });

  it("is empty and honest when nothing is happening", () => {
    const b = board(store);
    expect(b.reviews).toStrictEqual([]);
    // Three kernel-maintained numbers, present on every snapshot.
    expect(b.load).toHaveLength(3);
    expect(b.load.every((x) => typeof x === "number" && x >= 0)).toBe(true);
  });

  /**
   * THE STATUS LINE'S ROUTES (D-93): every route the ladder can spend, its parking
   * state read from the store — hours-to-reset being the only quota fact lore has,
   * since no provider publishes a percentage (D-84).
   */
  it("reports each route the ladder can reach, with its parking", () => {
    const saved = process.env["LORE_TIERS"];
    process.env["LORE_TIERS"] = JSON.stringify({
      models: { "GLM5.2": ["zp1/glm-5.2", "zp2/glm-5.2"] },
      tiers: [
        { id: "t0", kind: "deterministic", stage: "fast" },
        { id: "t1", kind: "model", model: "GLM5.2", stage: "fast", fallback: ["openrouter/z-ai/glm-5.2"] },
      ],
    });
    try {
      store.markRouteUnavailable("zp2/glm-5.2", "2126-01-01T00:00:00.000Z", "out", 2, false);
      const b = board(store);
      const byRoute = new Map(b.providers.map((p) => [p.route, p]));
      expect([...byRoute.keys()].sort()).toStrictEqual([
        "openrouter/z-ai/glm-5.2",
        "zp1/glm-5.2",
        "zp2/glm-5.2",
      ]);
      expect(byRoute.get("zp1/glm-5.2")?.until, "no refusal on record reads as payable").toBeUndefined();
      expect(byRoute.get("zp2/glm-5.2")?.until).toBe("2126-01-01T00:00:00.000Z");
      expect(byRoute.get("zp2/glm-5.2")?.stated, "lore's guess is marked as a guess").toBe(false);
    } finally {
      if (saved === undefined) delete process.env["LORE_TIERS"];
      else process.env["LORE_TIERS"] = saved;
    }
  });

  // 733b59e6, found by lore's own review: `loadPools`/`loadTiers` throw on a bad
  // LORE_TIERS path or malformed JSON, and board() called them with nothing
  // catching it. board-stream.ts calls board() from a raw `setInterval` tick with
  // no enclosing try/catch anywhere in the chain — unlike /board.json's plain HTTP
  // path, which http.ts's own top-level handler catch already protects — so an
  // uncaught throw here is an uncaught exception in a timer callback: Node kills
  // the whole process, taking every in-flight review round with it, the moment
  // anyone has the board open while the ladder file is broken.
  it("does not throw when LORE_TIERS will not load, degrading providers instead", () => {
    const saved = process.env["LORE_TIERS"];
    process.env["LORE_TIERS"] = "/definitely/does/not/exist/tiers.json";
    try {
      let b: ReturnType<typeof board> | undefined;
      expect(() => {
        b = board(store);
      }, "a broken ladder file must not crash the live board stream").not.toThrow();
      expect(b?.providers, "degrades to empty rather than a half-built list").toStrictEqual([]);
    } finally {
      if (saved === undefined) delete process.env["LORE_TIERS"];
      else process.env["LORE_TIERS"] = saved;
    }
  });
});
