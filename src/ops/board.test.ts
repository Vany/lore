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

    expect([...(find("r1")?.checksSkipped ?? [])].sort())
      .toStrictEqual(["eslint: not configured", "tests: disabled"]);
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

  it("is empty and honest when nothing is happening", () => {
    const b = board(store);
    expect(b.reviews).toStrictEqual([]);
    expect(b.queued).toBe(0);
    expect(b.inFlight).toBe(0);
  });
});
