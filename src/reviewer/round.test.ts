/**
 * The walking skeleton, actually walking.
 *
 * Everything below the model runs for real here: a real git repository, real
 * worktree diffing, real T0 detection, the real store, the real ladder, and real
 * `lore-ok` reconciliation. Only the model is faked — it is the one part that
 * cannot be run for free, and it is also the part that matters least to the *loop*
 * being correct.
 *
 * This is the test that would have caught the loop being wrong before a single
 * token was spent.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Exhausted } from "../core/errors.ts";
import type { Tier } from "../core/ladder.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { initialState, ladderFingerprint } from "../core/ladder.ts";
import { CODE_ARCH } from "../core/review-type.ts";
import { Store } from "../store/store.ts";
import type { Finding } from "../core/finding.ts";
import type { ReviewerLike, ReviewerResult } from "./opencode.ts";
import { CARRIED_TIER, originalJustification, runRound } from "./review.ts";

/** A reviewer that says exactly what a test tells it to, and records what it saw. */
class ScriptedReviewer implements ReviewerLike {
  readonly prompts: string[] = [];
  /**
   * Agentic turns to report back.
   *
   * Mutable, and `undefined` is a value a test sets deliberately: it reproduces a
   * reviewer that answered but could not count its own turns (D-50), which a default
   * argument could not express — passing `undefined` would just take the default.
   */
  steps: number | undefined = 7;
  /** What the schema refused, for exercising the partial-acceptance path (D-66). */
  discarded: readonly string[] = [];
  private readonly script: (readonly Finding[])[];

  constructor(script: (readonly Finding[])[]) {
    this.script = script;
  }

  async review(_tier: unknown, prompt: string, _worktree: string): Promise<ReviewerResult> {
    this.prompts.push(prompt);
    const findings = this.script.shift() ?? [];
    return {
      findings,
      raw: "",
      inputTokens: 100,
      cachedTokens: 50,
      outputTokens: 10,
      costUsd: 0.001,
      latencyMs: 1,
      discarded: this.discarded,
      retried: false,
      steps: this.steps,
    };
  }
}

const HOLD_BUG: Finding = {
  file: "src/hold.ts",
  line: 3,
  symbol: "capture",
  severity: "high",
  claim: "decline path leaves the hold active",
  evidence: "hold released only in the success branch",
  failureScenario: "card declines and funds stay held",
};

/** Distinct findings, so each round raises something FRESH and the bound can be hit. */
const nthBug = (n: number): Finding => ({ ...HOLD_BUG, line: 100 + n, claim: `distinct defect ${String(n)}` });

let dir: string;
let store: Store;
let repoId: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-round-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");

  writeFileSync(join(dir, "PROG.md"), "- Reviewers must never write to the repo, because independence is the point.\n");
  writeFileSync(join(dir, "src.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  git("checkout", "-qb", "feat/holds");
  writeFileSync(join(dir, "src", "hold.ts").replace("/src/", "/"), "");
  execFileSync("mkdir", ["-p", join(dir, "src")]);
  writeFileSync(join(dir, "src/hold.ts"), "export function capture() {\n  // work\n  return 1;\n}\n");
  git("add", "-A");
  git("commit", "-qm", "add capture");

  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", dir).id;
  store.createReview({
    id: "r1",
    repoId,
    principal: "p",
    branch: "feat/holds",
    intoRef: "main",
    ticket: "Add capture() so declines release the hold.",
    type: CODE_ARCH.id,
    state: "running",
    ladder: initialState(CODE_ARCH.tiers),
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** T0 engines that would shell out are excluded; this exercises the loop. */
const TYPE = { ...CODE_ARCH, t0: [] as const };

describe("runRound", () => {
  it("records a finding and reports it, resetting the ladder", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG]]);
    const result = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(result.decision.kind).toBe("findings");
    expect(result.newFindings).toHaveLength(1);
    expect(store.getReview("r1", "p")?.state).toBe("findings_ready");
  });

  // A FAILURE MUST NAME ITS CAUSE (INV-1). Hitting a round bound left every job `done`
  // with no error, so `failureReason` — which read only `job.last_error` — had nothing,
  // and `review_poll` answered "no reason was recorded, which is itself a defect" about
  // a cause the ladder knew exactly. Found on a review of this repository that had just
  // hit the per-tier bound after nine rounds of documentation findings.
  it("says WHY when a round bound stops the ladder, not merely that it failed", async () => {
    // Four rounds of fresh findings at t1: the default per-tier bound is 3.
    const reviewer = new ScriptedReviewer([[nthBug(1)], [nthBug(2)], [nthBug(3)], [nthBug(4)]]);
    let last;
    for (let i = 0; i < 4; i++) {
      last = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    }

    expect(last?.decision.kind).toBe("stopped");
    expect(store.getReview("r1", "p")?.state).toBe("failed");
    const why = store.failureReason("r1") ?? "";
    expect(why).toContain("per-review round bound");
    expect(why).toContain("t1×4");
    // The instruction, not just the diagnosis: this bound is nearly always the
    // answer-begets-finding loop, and answering shorter is what ends it.
    expect(why).toMatch(/MINIMALLY/);
    expect(why).toContain("NOT a pass");
  });

  it("gives the reviewer the ticket and the diff", async () => {
    const reviewer = new ScriptedReviewer([[]]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const prompt = reviewer.prompts[0] ?? "";
    expect(prompt).toContain("Add capture() so declines release the hold.");
    expect(prompt).toContain("src/hold.ts");
    // Scope creep is judged against the ticket, so the ticket must actually arrive.
    expect(prompt).toContain("does it do MORE than was asked?");
  });

  it("ingests the repo's own rules and hands them to the reviewer", async () => {
    const reviewer = new ScriptedReviewer([[]]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(reviewer.prompts[0] ?? "").toContain("Reviewers must never write to the repo");
    expect(store.knowledgeFor(repoId).some((k) => k.source === "ingested")).toBe(true);
  });

  it("does not re-report a finding it has already delivered", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG], [HOLD_BUG]]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    const second = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    // Raised again, but not NEW: the loop must not treat a repeat as fresh work.
    expect(second.newFindings).toHaveLength(0);
  });

  // The independent-auditor property, end to end. Silence is assent.
  it("accepts a justification the reviewer declines to re-raise", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const short = fingerprint(HOLD_BUG).slice(0, 8);
    writeFileSync(
      join(dir, "src/hold.ts"),
      [
        "export function capture() {",
        `  // lore-ok[${short}]: the caller releases the hold in its finally block`,
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );

    const second = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(second.accepted).toStrictEqual([fingerprint(HOLD_BUG)]);
    expect(store.latestVerdict("r1", fingerprint(HOLD_BUG))?.verdict).toBe("justified-accepted");
    // The reason lives on the VERDICT, where it keeps its finding.
    expect(store.latestVerdict("r1", fingerprint(HOLD_BUG))?.rationale).toContain("finally block");
  });

  // AN ACCEPTED JUSTIFICATION IS A VERDICT, NOT A RULE. It used to be written as both,
  // and the knowledge copy lost the one thing that made it legible: its finding. What
  // remained went to the next model under "treat these as this team's decisions" — a
  // sentence with no subject, presented as binding.
  //
  // Nothing is lost. The reason is in every prompt with its finding through
  // `settledBlock`, and it already outlives its review (D-51) because carrying reads
  // the VERDICT table across the repo's reviews, never knowledge.
  it("does not also file the reason as a rule about the codebase", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    const short = fingerprint(HOLD_BUG).slice(0, 8);
    writeFileSync(
      join(dir, "src/hold.ts"),
      [
        "export function capture() {",
        `  // lore-ok[${short}]: the caller releases the hold in its finally block`,
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(
      store.knowledgeFor(repoId).some((k) => k.statement.includes("releases the hold in its finally block")),
    ).toBe(false);
  });

  it("rejects a justification the reviewer raises anyway, and does not settle it", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG], [HOLD_BUG]]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const short = fingerprint(HOLD_BUG).slice(0, 8);
    writeFileSync(
      join(dir, "src/hold.ts"),
      ["export function capture() {", `  // lore-ok[${short}]: it is fine, trust me`, "  return 1;", "}", ""].join("\n"),
    );

    const second = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(second.rejected).toStrictEqual([fingerprint(HOLD_BUG)]);
    expect(store.latestVerdict("r1", fingerprint(HOLD_BUG))?.verdict).toBe("justified-rejected");
    // A rejected justification does not close anything.
    expect(store.settledFingerprints("r1")).not.toContain(fingerprint(HOLD_BUG));
  });

  // The bug this exists for: a semgrep false positive on lore's own test suite could
  // NEVER be justified. T0 is deterministic — it re-matches every round — so counting
  // it as "the reviewer looked and raised it anyway" rejected the reason forever, the
  // finding never settled, the ladder reset every round, and the review could only
  // ever end `stopped`. `passed` was unreachable for any repo with one T0 false
  // positive. No existing test could see it, because every test set `t0: []`.
  it("lets the model, never T0, rule on a justification", async () => {
    // A deterministic engine that reports the same finding every single round.
    const alwaysT0 = async () => ({
      findings: [HOLD_BUG],
      unavailable: [] as readonly string[],
      outcomes: [] as readonly unknown[],
    });

    const reviewer = new ScriptedReviewer([[], []]);
    const t0 = alwaysT0 as unknown as Parameters<typeof runRound>[0]["t0"];
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });

    const short = fingerprint(HOLD_BUG).slice(0, 8);
    writeFileSync(
      join(dir, "src/hold.ts"),
      ["export function capture() {", `  // lore-ok[${short}]: the linter rule does not apply to tests`, "  return 1;", "}", ""].join("\n"),
    );

    const second = await runRound({
      store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}),
    });

    // T0 raised it again this very round, and it is STILL accepted: `tsc` and
    // `semgrep` pattern-match, they do not read reasons.
    expect(second.accepted).toStrictEqual([fingerprint(HOLD_BUG)]);
    expect(second.rejected).toStrictEqual([]);
    expect(store.settledFingerprints("r1")).toContain(fingerprint(HOLD_BUG));
  });

  // THE PRODUCT PREMISE, and it was missing until 2026-08-03. A fingerprint belongs
  // to the review that raised it, so a reason ratified in review 1 matched nothing in
  // review 2: every new review re-raised every settled finding and the author had to
  // re-submit the same comment forever. Observed on lore's own repo before it was
  // written down here.
  describe("an accepted justification outlives the review that accepted it", () => {
    const alwaysT0 = async () => ({
      findings: [HOLD_BUG],
      unavailable: [] as readonly string[],
      outcomes: [] as readonly unknown[],
    });
    const t0 = alwaysT0 as unknown as Parameters<typeof runRound>[0]["t0"];

    const justify = (reason: string) =>
      writeFileSync(
        join(dir, "src/hold.ts"),
        ["export function capture() {", `  // lore-ok[${fingerprint(HOLD_BUG).slice(0, 8)}]: ${reason}`, "  return 1;", "}", ""].join("\n"),
      );

    /** A second review of the SAME repo, which is the only place this is visible. */
    const secondReview = () =>
      store.createReview({
        id: "r2",
        repoId,
        principal: "p",
        branch: "feat/holds",
        intoRef: "main",
        ticket: "same repo, a later session",
        type: CODE_ARCH.id,
        state: "running",
        ladder: initialState(CODE_ARCH.tiers),
      });

    it("carries it into a later review, so the author does not re-argue it", async () => {
      const first = new ScriptedReviewer([[], []]);
      await runRound({ store, reviewer: first, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });
      justify("the caller releases the hold in its finally block");
      await runRound({ store, reviewer: first, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });
      expect(store.settledFingerprints("r1")).toContain(fingerprint(HOLD_BUG));

      secondReview();
      const second = await runRound({
        store, reviewer: new ScriptedReviewer([[]]), reviewId: "r2", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}),
      });

      // Settled in the FIRST round of the new review, without a submit.
      expect(second.accepted).toContain(fingerprint(HOLD_BUG));
      expect(store.settledFingerprints("r2")).toContain(fingerprint(HOLD_BUG));
      expect(store.latestVerdict("r2", fingerprint(HOLD_BUG))?.rationale).toMatch(/carried forward/);
    });

    // A reason is about a piece of code and survives exactly as long as that code
    // does. Inheriting one blind is how a ladder rots into rubber-stamping.
    it("does not carry it once the code it was about has changed", async () => {
      const first = new ScriptedReviewer([[], []]);
      await runRound({ store, reviewer: first, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });
      justify("the caller releases the hold in its finally block");
      await runRound({ store, reviewer: first, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });

      writeFileSync(join(dir, "src/hold.ts"), "export function capture() {\n  acquireTwice();\n  return 2;\n}\n");

      secondReview();
      const second = await runRound({
        store, reviewer: new ScriptedReviewer([[]]), reviewId: "r2", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}),
      });
      expect(second.accepted).not.toContain(fingerprint(HOLD_BUG));
    });

    // A model that reads the recorded reason and complains anyway is disagreeing with
    // the lore, and that disagreement is worth more than the convenience of closing.
    it("does not carry it when the model raises it again", async () => {
      const first = new ScriptedReviewer([[], []]);
      await runRound({ store, reviewer: first, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });
      justify("the caller releases the hold in its finally block");
      await runRound({ store, reviewer: first, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });

      secondReview();
      const second = await runRound({
        store, reviewer: new ScriptedReviewer([[HOLD_BUG]]), reviewId: "r2", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}),
      });
      expect(second.accepted).not.toContain(fingerprint(HOLD_BUG));
    });
  });

  // Found against this file an hour after the model tier's
  // half of the same fix landed: T0 shells out to tsc, semgrep and a sandboxed test
  // suite, any of which can die, and a crash used to leave no row at all.
  // `roundStartedAt` reads this column to condition `check_back_after_ms`, and the
  // distribution it is conditioned against (`usage.latency_ms`) times the MODEL SESSION
  // alone. Stamped at `runRound` entry, the two measured different things: T0's engines,
  // the doc ingest and the knowledge screen's own model call all counted as elapsed
  // against a distribution that contained none of them, so the wait shrank too fast and
  // the overdue branch could tell a client the round had outrun every recorded run
  // before the tier had been asked anything.
  it("stamps a model tier's run from when its own work begins, not from entry", async () => {
    const SLOW_T0_MS = 25;
    const slow: NonNullable<Parameters<typeof runRound>[0]["t0"]> = async () => {
      await new Promise((r) => setTimeout(r, SLOW_T0_MS));
      return { findings: [], outcomes: [], unavailable: [], skipped: [] };
    };

    const entered = Date.now();
    await runRound({ store, reviewer: new ScriptedReviewer([[]]), reviewId: "r1", principal: "p", worktree: dir, type: TYPE, t0: slow });

    const row = store.db
      .prepare("SELECT started_at FROM tier_run WHERE review_id = 'r1' AND tier = 't1'")
      .get() as { started_at: string };
    expect(Date.parse(row.started_at) - entered).toBeGreaterThanOrEqual(SLOW_T0_MS);
  });

  // THE INGEST CAN NOW TAKE MINUTES AND SPEND MONEY, and the terminal check at the top
  // of `runRound` was the only one — written when everything between it and the tier call
  // was free. The knowledge screen made that false: a client can cancel while a screen
  // session is in flight, and the round would then open the model tier, spend it too, and
  // write a ladder result over a review somebody deliberately ended.
  it("does not ask a tier for a review that was cancelled while its documents were read", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG]]);
    // The cancel lands DURING the ingest, which is where the gap was.
    const cancellingT0 = (async () => {
      store.updateReview("r1", { state: "cancelled" });
      return { findings: [], outcomes: [], unavailable: [], skipped: [] };
    }) as unknown as NonNullable<Parameters<typeof runRound>[0]["t0"]>;

    await expect(
      runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, t0: cancellingT0 }),
    ).rejects.toThrow(/ended while its documents were being read/);

    // The expensive half never happened, and the cancelled state was not overwritten.
    expect(reviewer.prompts).toHaveLength(0);
    expect(store.getReview("r1", "p")?.state).toBe("cancelled");
  });

  // SWAPPING `LORE_TIERS` WITH A REVIEW OPEN silently rebound its cursor. Done
  // deliberately on 2026-08-06 — the deployment went to a Kimi-only ladder to prove that
  // tier, then back — with a review sitting in findings_ready. `ladder.cursor` is an
  // index resolved against whatever config is loaded now, so cursor 1 stopped meaning
  // the tier it meant, and `tier_run` would carry two rows both called `t1` naming
  // different vendors: a corrupted audit trail with an attestation over it.
  //
  // Refused rather than remapped. Remapping needs a rule for a tier that vanished and
  // another for one that appeared, and each is a guess about what the operator meant.
  it("refuses to resume a review that began on a different ladder", async () => {
    store.db.prepare("UPDATE review SET tiers = ? WHERE id = 'r1'").run("t0:deterministic,t1:kimi-for-coding/k3");
    await expect(
      runRound({ store, reviewer: new ScriptedReviewer([[]]), reviewId: "r1", principal: "p", worktree: dir, type: TYPE }),
    ).rejects.toThrow(/began on a different ladder/);
  });

  // A review pinned to the ladder it is actually running on carries on, and one from
  // before the column exists was never pinned to anything — stranding those over a
  // comparison nobody made would be the guard causing the harm it prevents.
  it("resumes a review pinned to this ladder, and one pinned to nothing", async () => {
    const pinned = ladderFingerprint(TYPE.tiers);
    store.db.prepare("UPDATE review SET tiers = ? WHERE id = 'r1'").run(pinned);
    await expect(
      runRound({ store, reviewer: new ScriptedReviewer([[]]), reviewId: "r1", principal: "p", worktree: dir, type: TYPE }),
    ).resolves.toBeDefined();

    store.db.prepare("UPDATE review SET tiers = NULL WHERE id = 'r1'").run();
    store.updateReview("r1", { state: "running" });
    await expect(
      runRound({ store, reviewer: new ScriptedReviewer([[]]), reviewId: "r1", principal: "p", worktree: dir, type: TYPE }),
    ).resolves.toBeDefined();
  });

  it("records that T0 ran even when T0 throws", async () => {
    const exploding = (async () => {
      throw new Error("semgrep died");
    }) as unknown as Parameters<typeof runRound>[0]["t0"];

    await expect(
      runRound({ store, reviewer: new ScriptedReviewer([[]]), reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(exploding ? { t0: exploding } : {}) }),
    ).rejects.toThrow(/semgrep died/);

    const runs = store.db.prepare("SELECT tier, outcome, finished_at FROM tier_run WHERE review_id = 'r1'").all() as Record<string, unknown>[];
    const t0row = runs.find((r) => r["tier"] === "t0");
    expect(t0row).toBeDefined();
    expect(t0row?.["outcome"]).toBe("failed");
    // Closed, not left dangling: an open row that never closes reads as "still
    // running" for ever, which is the other half of the same lie.
    expect(t0row?.["finished_at"]).not.toBeNull();
  });

  // The other half of that rule, found by a real reviewer: a tier_run row records
  // what the TIER did, and nothing may overwrite it with what the LADDER decided.
  // `closeTierRun` is an UPDATE, so a second close silently replaced the first —
  // and `make status` then painted a clean, answered t1 red as `stopped`.
  it("records what the model tier found, not what the ladder decided", async () => {
    // Clean at t1 in the default ladder means `fastClean`: a decision kind that is
    // NOT a tier outcome, which is exactly the value that used to land here.
    const r = await runRound({
      store, reviewer: new ScriptedReviewer([[]]), reviewId: "r1", principal: "p", worktree: dir, type: TYPE,
    });
    expect(r.decision.kind).toBe("fastClean");

    const t1row = store.db
      .prepare("SELECT outcome, finished_at FROM tier_run WHERE review_id = 'r1' AND tier = 't1'")
      .get() as Record<string, unknown> | undefined;
    expect(t1row?.["outcome"]).toBe("clean");
    expect(t1row?.["finished_at"]).not.toBeNull();
  });

  // The attestation signs a TREE (D-40). `review_submit` was once the only writer of
  // that column, so a review needing no fixes reached `passed` having never recorded
  // one and its attestation read "reviewed tree unknown": the fix
  // shipped without a test, and reverting the line passed the whole suite.
  it("records the tree the tier actually read, with no submit involved", async () => {
    await runRound({ store, reviewer: new ScriptedReviewer([[]]), reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const recorded = store.getReview("r1", "p")?.treeHash;
    expect(recorded).toBeDefined();
    // The real tree of the worktree, not merely some non-null string.
    const actual = execFileSync("git", ["write-tree"], { cwd: dir, encoding: "utf8" }).trim();
    expect(recorded).toBe(actual);
  });

  // The quota path returns early with its own updateReview, so it missed the tree
  // recording above. It reaches `passed_partial`, which is attestable —
  // so a review could pass and then be refused an attestation for having no tree,
  // which is the guard causing the fault rather than catching it.
  it("records the tree even when the tier cannot be paid for", async () => {
    const broke: ReviewerLike = {
      review: () => Promise.reject(new Exhausted("t1: out of quota")),
    };
    await runRound({ store, reviewer: broke, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const actual = execFileSync("git", ["write-tree"], { cwd: dir, encoding: "utf8" }).trim();
    expect(store.getReview("r1", "p")?.treeHash).toBe(actual);
  });

  // D-56. The most common ending a review has — the author fixed it — was recorded
  // nowhere, so a review could pass having fixed three findings and attest
  // "0 fixed", understating its own work and implying they were ignored.
  describe("a fix is settled by qualified silence", () => {
    const fix = () => writeFileSync(join(dir, "src/hold.ts"), "export function capture() {\n  return release();\n}\n");

    it("settles a finding the tier stops raising once the code has moved", async () => {
      const reviewer = new ScriptedReviewer([[HOLD_BUG], []]);
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

      fix();
      const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

      expect(after.fixed).toStrictEqual([fingerprint(HOLD_BUG)]);
      expect(store.latestVerdict("r1", fingerprint(HOLD_BUG))?.verdict).toBe("fixed");
      expect(store.openFindings("r1")).toHaveLength(0);
    });

    // Silence is weak evidence. A tier that stops mentioning untouched code has
    // changed its mind, and recording that as a fix puts a false claim in a signed
    // line.
    it("does not settle one whose code never changed", async () => {
      const reviewer = new ScriptedReviewer([[HOLD_BUG], []]);
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
      const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

      expect(after.fixed).toStrictEqual([]);
      expect(store.openFindings("r1").map((f) => f.fingerprint)).toContain(fingerprint(HOLD_BUG));
    });

    // A re-raise of something already settled as fixed must not restart the ladder
    // with nothing for the client to do: openFindings excludes it and undelivered has
    // already delivered it, so `findings_ready` would hand back an empty list for ever
    // .
    it("does not restart the ladder when a fixed finding is raised again", async () => {
      const reviewer = new ScriptedReviewer([[HOLD_BUG], [], [HOLD_BUG]]);
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
      fix();
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
      expect(store.settledFingerprints("r1")).toContain(fingerprint(HOLD_BUG));

      const again = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
      expect(again.decision.kind).not.toBe("findings");
    });

    // A re-raise moves the goalposts, and both fields the rule reads must move with
    // it. Here the code changes WITHOUT the defect being fixed and t1 says so again;
    // testing the first raise's hunk would then find it absent and record a false
    // fix for a defect the tier is still complaining about.
    it("re-scopes a finding that is raised again, so a stale hunk cannot fake a fix", async () => {
      const reviewer = new ScriptedReviewer([[HOLD_BUG], [HOLD_BUG], []]);
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

      // Code moves; the defect does not go away, and t1 raises it again.
      writeFileSync(join(dir, "src/hold.ts"), "export function capture() {\n  // moved\n  return 1;\n}\n");
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

      // Nothing changes now, and t1 falls silent. Silence over untouched code is not
      // a fix, and it is only visible as untouched if the scope was refreshed.
      const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
      expect(after.fixed).toStrictEqual([]);
    });

    // Unreadable is "cannot tell", not "the code moved". Falling through to `fixed`
    // turned a permissions error or an I/O fault into a settled verdict.
    it("does not settle a finding whose file cannot be read", async () => {
      const reviewer = new ScriptedReviewer([[HOLD_BUG], []]);
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

      // The file is gone, so the read fails — which says nothing about the defect.
      rmSync(join(dir, "src/hold.ts"));
      const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

      expect(after.fixed).toStrictEqual([]);
    });

    // The guard that matters most. t1 not repeating what t3 found says nothing about
    // the code — t1 may be unable to see it — so closing on that silence would be
    // INV-1 inverted: a tier that did not look, recorded as one that found nothing.
    it("refuses to let a weaker tier close a stronger tier's finding", async () => {
      const reviewer = new ScriptedReviewer([[HOLD_BUG], []]);
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
      // Re-attribute it to the top tier, then let t1 fall silent over changed code.
      store.db.prepare("UPDATE finding SET origin = 't3' WHERE review_id = 'r1'").run();

      fix();
      const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

      expect(after.fixed).toStrictEqual([]);
      expect(store.openFindings("r1").map((f) => f.fingerprint)).toContain(fingerprint(HOLD_BUG));
    });
  });

  // D-57. A lore-ok is a comment, and JSON has none — so a finding raised against a
  // config file had nowhere to put its reason and could never settle.
  it("reads a justification from the repo-root ledger for a file that cannot hold one", async () => {
    const CONFIG_BUG: Finding = {
      file: "tiers.json", line: 2, symbol: "t1", severity: "medium",
      claim: "the t1 model was changed without saying so",
      evidence: "tiers.json:2", failureScenario: "an operator approves the wrong spend",
    };
    writeFileSync(join(dir, "tiers.json"), '{\n  "t1": "glm-5-turbo"\n}\n');
    git("add", "-A");
    git("commit", "-qm", "config");

    const reviewer = new ScriptedReviewer([[CONFIG_BUG], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    // Nowhere in tiers.json to write this. It goes in the ledger instead.
    writeFileSync(
      join(dir, ".lore-ok.md"),
      `<!-- lore-ok[${fingerprint(CONFIG_BUG).slice(0, 8)}]: the operator chose it; JSON cannot carry a comment -->\n`,
    );

    const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    expect(after.accepted).toStrictEqual([fingerprint(CONFIG_BUG)]);
    expect(store.latestVerdict("r1", fingerprint(CONFIG_BUG))?.verdict).toBe("justified-accepted");

    // And it must SURVIVE the next round. The scope is taken from the code the reason
    // defends, not from the ledger it is written in — a hunk of markdown can never be
    // found in the JSON it defends, so recording that expired the justification the
    // round after it was accepted and restarted the ladder for ever.
    const later = await runRound({
      store, reviewer: new ScriptedReviewer([[]]), reviewId: "r1", principal: "p", worktree: dir, type: TYPE,
    });
    expect(later.expired).toStrictEqual([]);
    expect(store.settledFingerprints("r1")).toContain(fingerprint(CONFIG_BUG));
  });

  it("climbs the ladder and passes only at the top", async () => {
    const reviewer = new ScriptedReviewer([[], [], []]);
    const first = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    // T1 clean crosses into the deep stage. NOT a pass.
    expect(first.decision.kind).toBe("fastClean");
    expect(store.getReview("r1", "p")?.state).toBe("fast_clean");

    const second = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    expect(second.decision.kind).toBe("escalate");

    const third = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    expect(third.decision.kind).toBe("passed");
    expect(store.getReview("r1", "p")?.state).toBe("passed");
  });

  // The guard against rubber-stamping. Without it, reasons accumulate, code moves
  // out from under them, and nothing is ever re-examined.
  it("expires a justification once the code it was about changes", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG], [], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const short = fingerprint(HOLD_BUG).slice(0, 8);
    writeFileSync(
      join(dir, "src/hold.ts"),
      [
        "export function capture() {",
        `  // lore-ok[${short}]: the caller releases the hold in its finally block`,
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );
    const accepted = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    expect(accepted.accepted).toHaveLength(1);
    expect(store.settledFingerprints("r1")).toContain(fingerprint(HOLD_BUG));

    // The function is rewritten. The reason was about code that no longer exists.
    writeFileSync(
      join(dir, "src/hold.ts"),
      ["export function capture() {", "  return releaseNothing();", "}", ""].join("\n"),
    );
    const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(after.expired).toContain(fingerprint(HOLD_BUG));
    expect(store.settledFingerprints("r1")).not.toContain(fingerprint(HOLD_BUG));
    // The reason is retired, not erased: why it was reopened must stay readable.
    expect(store.latestVerdict("r1", fingerprint(HOLD_BUG))?.rationale).toContain("expired");
  });

  it("keeps a justification alive when its code is untouched", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG], [], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const short = fingerprint(HOLD_BUG).slice(0, 8);
    writeFileSync(
      join(dir, "src/hold.ts"),
      ["export function capture() {", `  // lore-ok[${short}]: bounded upstream`, "  return 1;", "}", ""].join("\n"),
    );
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    // An unrelated file changes. Expiring on that would train people to ignore the
    // findings that keep reappearing.
    writeFileSync(join(dir, "src.txt"), "unrelated edit\n");
    const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(after.expired).toStrictEqual([]);
    expect(store.settledFingerprints("r1")).toContain(fingerprint(HOLD_BUG));
  });

  it("records what each tier cost", async () => {
    const reviewer = new ScriptedReviewer([[]]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    // Usage logging is what turns the subscription question into arithmetic.
    expect(store.spendSince("2000-01-01T00:00:00.000Z")).toBeCloseTo(0.001, 6);
  });

  // The whole reason the step count exists: SPEC says the cap will be derived from
  // the usage table, and a decision that cites a number nobody stores is a sentence,
  // not a plan (D-50). This is the end of that wire.
  it("stores how far the tier explored, where the threshold will be derived from", async () => {
    const reviewer = new ScriptedReviewer([[]]);
    reviewer.steps = 23;
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const row = store.db.prepare("SELECT tier, steps FROM usage").get() as { tier: string; steps: number | null };
    expect(row.tier).toBe("t1");
    expect(row.steps).toBe(23);
  });

  // A reviewer that could not count its own turns must leave the cell EMPTY. Zero
  // would be a fact — "this tier explored nothing" — and averaging it in would drag
  // the distribution down every time the measurement itself broke.
  it("leaves the step count null rather than zero when it was never measured", async () => {
    const reviewer = new ScriptedReviewer([[]]);
    reviewer.steps = undefined;
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const row = store.db.prepare("SELECT steps FROM usage").get() as { steps: number | null };
    expect(row.steps).toBeNull();
  });
});

// D-51 carries an accepted justification into a later review. The carry wrapped the
// previous rationale in its own prefix, so a justification that survived N reviews
// accumulated N prefixes — observed at THIRTEEN on this repository in one day, each
// ~62 characters, growing without bound.
//
// Found by reading what `review_poll` actually returned rather than by a test: the
// `settled_because` field was a wall of identical provenance with the one sentence
// that mattered at the far end of it.
describe("a carried justification does not accumulate its own provenance", () => {
  const wrap = (at: string, reason: string) =>
    `carried forward from an earlier review of this repo (${at}): ${reason}`;
  const carried = (rationale: string | undefined, createdAt: string) =>
    ({ rationale, createdAt, tier: CARRIED_TIER });

  it("keeps the original reason and the date it was FIRST decided", () => {
    const origin = originalJustification(carried("bounded by the schema check upstream", "2026-08-01T00:00:00.000Z"));
    expect(origin).toStrictEqual({ at: "2026-08-01T00:00:00.000Z", reason: "bounded by the schema check upstream" });
  });

  it("strips exactly one layer — the one this code added", () => {
    const inner = wrap("2026-08-01T00:00:00.000Z", "bounded by the schema check upstream");
    const origin = originalJustification(carried(wrap("2026-08-02T00:00:00.000Z", inner), "2026-08-03T00:00:00.000Z"));
    expect(origin.at).toBe("2026-08-02T00:00:00.000Z");
    expect(origin.reason).toBe(inner);
  });

  // The nested case the tier guard does NOT cover, and the reason one strip beats a
  // loop. The guard proves only the OUTERMOST verdict is ours; anything inside it is
  // opaque prose. An agent shown `settled_because` may imitate the phrasing in its
  // own lore-ok — and a loop would then eat into that sentence on the second carry
  // and adopt a date lifted from the author's own text.
  it("never eats into an author reason nested inside a real carry", () => {
    const authors = wrap("2019-01-01T00:00:00.000Z", "the vendor doc says this header is optional");
    const carriedOnce = wrap("2026-08-02T00:00:00.000Z", authors);

    const origin = originalJustification(carried(carriedOnce, "2026-08-03T00:00:00.000Z"));
    expect(origin.reason).toBe(authors);
    expect(origin.at).toBe("2026-08-02T00:00:00.000Z");
    // Specifically NOT the date embedded in the author's sentence.
    expect(origin.at).not.toBe("2019-01-01T00:00:00.000Z");
  });

  // The property that matters: re-carrying is idempotent, so the field cannot grow.
  it("is stable under repeated carrying", () => {
    let rationale = "bounded by the schema check upstream";
    let at = "2026-08-01T00:00:00.000Z";
    const lengths: number[] = [];
    for (let i = 0; i < 20; i++) {
      const origin = originalJustification(carried(rationale, at));
      rationale = wrap(origin.at, origin.reason);
      at = `2026-08-${String(2 + i).padStart(2, "0")}T00:00:00.000Z`;
      lengths.push(rationale.length);
    }
    expect(new Set(lengths).size).toBe(1);
  });

  it("says so plainly when there was never a reason", () => {
    expect(originalJustification(carried(undefined, "2026-08-01T00:00:00.000Z")).reason).toBe("(no reason recorded)");
  });

  // An author's rationale is arbitrary text from a `lore-ok` comment, and one may
  // legitimately begin with the same words this code uses for its own provenance.
  // Unwrapping is therefore keyed on the tier WE stamp, never on the prose — parsing
  // it would truncate and re-date a reason a reviewer actually ratified.
  it("never rewrites a reason a reviewer ratified, however it begins", () => {
    const authors = wrap("2019-01-01T00:00:00.000Z", "the vendor doc says this header is optional");
    const origin = originalJustification({ rationale: authors, createdAt: "2026-08-04T00:00:00.000Z", tier: "t2" });
    expect(origin.reason).toBe(authors);
    expect(origin.at).toBe("2026-08-04T00:00:00.000Z");
  });
});

// D-66. A finding the schema refused is a defect this tier SAW and the review does
// not contain. That is the same class of fact as an engine that could not run, so it
// goes in the same channel — the one the client repeats to its user so a later
// `passed` is not over-read. Silence here would be INV-1 failing one layer further in.
describe("a discarded finding is reported, not swallowed", () => {
  it("reaches checks_skipped, naming the tier and the reason", async () => {
    const reviewer = new ScriptedReviewer([[]]);
    reviewer.discarded = ["finding 2 of 2: claim: too long — {…}"];

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const skipped = store.unavailableChecks("r1").join(" ");
    expect(skipped).toMatch(/produced a finding this review does NOT contain/);
    expect(skipped).toContain("claim: too long");
  });

  it("says nothing when the tier's whole reply was accepted", async () => {
    const reviewer = new ScriptedReviewer([[]]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(store.unavailableChecks("r1").join(" ")).not.toMatch(/does NOT contain/);
  });
});

// THE THREE PATHS THAT HAD NEVER EXECUTED IN PRODUCTION.
//
// All three had code and unit tests; none had ever run through `runRound` against a
// real worktree and a real store. A path whose first real execution is during an
// incident is a path nobody has reviewed — and these three are exactly the ones that
// run when something has already gone wrong, which is the worst moment to find out.
describe("the paths that only happen when something has gone wrong", () => {
  /**
   * Clean everywhere except the tiers named, which cannot be paid for.
   *
   * Exhausted is a limitation rather than a failure (D-48), and the distinction only
   * shows up over a WHOLE ladder: one unpayable tier mid-climb is `fast_clean` with
   * more to come, and only the last tier turns it into a verdict.
   */
  class Unpayable implements ReviewerLike {
    // A plain field, not a parameter property: `erasableSyntaxOnly` is on, because
    // node runs these files directly with no build step (D-3).
    private readonly broke: readonly string[];

    constructor(broke: readonly string[]) {
      this.broke = broke;
    }

    async review(tier: Tier): Promise<ReviewerResult> {
      if (this.broke.includes(tier.id)) throw new Exhausted(`quota exhausted for ${tier.id}`);
      return new ScriptedReviewer([[]]).review(tier, "", "");
    }
  }

  /** Drive the ladder to a terminal state, as the worker does. */
  const toEnd = async (reviewer: ReviewerLike, type: typeof CODE_ARCH) => {
    let last;
    for (let i = 0; i < 8; i++) {
      last = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });
      if (!["escalate", "fastClean"].includes(last.decision.kind)) break;
    }
    return last;
  };

  /**
   * A tier that HANGS is stepped over too, once its retry is spent.
   *
   * Vany: *"if a low tier is limited it's okay, just pass its work to a higher tier."*
   * D-48 did that for a tier nobody can PAY for and not for one that simply never
   * answers — and the difference is invisible where it matters: the review is dead
   * either way, and why it is dead is not the client's to fix.
   *
   * Measured on a customer's repository: t1 was cut at the deadline on both attempts and
   * the whole review failed, while two other vendors sat there able to read the code.
   * That repo's t1 has 54 recorded calls with a maximum of 1047s, so it was a hang.
   *
   * NOT on the first failure: a provider blip deserves the cheap tier again, not
   * promotion to the dearer one. Both halves are asserted, because the expensive half is
   * the one that would go unnoticed.
   */
  class Hangs implements ReviewerLike {
    private readonly broke: readonly string[];
    calls = 0;
    constructor(broke: readonly string[]) {
      this.broke = broke;
    }
    async review(tier: Tier): Promise<ReviewerResult> {
      if (this.broke.includes(tier.id)) {
        this.calls++;
        throw new Error(`opencode ran past 2700s without finishing`);
      }
      return new ScriptedReviewer([[]]).review(tier, "", "");
    }
  }

  it("fails the round the FIRST time a tier cannot answer, so a blip is retried cheaply", async () => {
    const reviewer = new Hangs(["t1"]);
    await expect(
      runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: { ...CODE_ARCH, t0: [] as const } }),
    ).rejects.toThrow(/ran past/);
    expect(store.getReview("r1", "p")?.state, "still open — the client may retry the cheap tier").not.toBe("failed");
  });

  // `skip_if_quota` spends NO second attempt: an exhausted plan does not become
  // available by asking again, and each attempt costs the full deadline.
  it("skips a skip_if_quota tier on the FIRST failure, spending no second attempt", async () => {
    const reviewer = new Hangs(["t1"]);
    const tiers = CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, skip_if_quota: true } : t));
    const type = { ...CODE_ARCH, tiers, t0: [] as const };
    let last;
    for (let i = 0; i < 8; i++) {
      last = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type }).catch(() => undefined);
      if (last === undefined || !["escalate", "fastClean"].includes(last.decision.kind)) break;
    }
    // `passed`, not `passedPartial` (D-88): t1 is the CHEAPEST tier and both tiers above
    // it read this code. The ladder is a gate — dearer tiers only see what the cheaper
    // ones passed — so t1's absence made the review dearer, not less certain.
    expect(last?.decision.kind).toBe("passed");
    expect(reviewer.calls, "one attempt, not two — that is the whole point of the flag").toBe(1);
    // AND IT IS STILL DISCLOSED. What D-88 changed is which skips cost the verdict,
    // never which are mentioned: a `passed` that quietly stopped naming t1 would be the
    // silent downgrade this project exists to refuse.
    expect(store.unavailableChecks("r1").join("\n")).toContain("marked skip_if_quota");
  });

  it("passes a hung tier's work to the next one once its retry is spent", async () => {
    const reviewer = new Hangs(["t1"]);
    const type = { ...CODE_ARCH, t0: [] as const };
    // First failure: thrown, as above. The worker records it and the round is retried.
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type }).catch(() => undefined);
    // Second: the budget is spent, so t1 is skipped and the deeper tiers do the work.
    let last;
    for (let i = 0; i < 8; i++) {
      last = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type }).catch(() => undefined);
      if (last === undefined || !["escalate", "fastClean"].includes(last.decision.kind)) break;
    }
    expect(last?.decision.kind, "the review reaches a verdict instead of dying").toBe("passed");
    expect(store.getReview("r1", "p")?.state, "t2 and t3 read this code; t1 only made that cheaper (D-88)").toBe("passed");
    // And the client is TOLD, in the channel it repeats to its user — a hung t1 is not a
    // weaker verdict now, but it is still a fact about what this review did.
    const skipped = store.unavailableChecks("r1").join("\n");
    expect(skipped).toMatch(/could not answer on either attempt and was SKIPPED/);
  });

  // D-48 steps over a tier nobody can pay for; D-88 decides what that costs. A tier
  // BELOW one that passed costs nothing, because the ladder is a gate and everything it
  // would have read was read again by the tier above it.
  it("still passes when a tier below the top one could not be paid for", async () => {
    // t1 is unpayable; the deeper tiers still look and agree.
    const result = await toEnd(new Unpayable(["t1"]), { ...CODE_ARCH, t0: [] as const });

    // D-88: below a tier that passed, so it does not cost the verdict.
    expect(result?.decision.kind).toBe("passed");
    expect(store.getReview("r1", "p")?.state).toBe("passed");
    // The tier's own row says WHY, so the operator view cannot confuse it with a
    // tier that never started.
    const runs = store.db.prepare("SELECT outcome FROM tier_run WHERE review_id = 'r1'").all() as { outcome: string }[];
    expect(runs.some((r) => r.outcome === "unpayable")).toBe(true);
  });

  // If NOTHING can be paid for there is no review at all, and saying "partial" would
  // be claiming evidence that does not exist.
  // The ladder does not give up on the first unpayable tier — it steps over that one
  // and tries the next, which is the whole point of D-48. It gives up only when the
  // LAST tier that could have looked is gone, because at that point nothing has read
  // the code and calling it `passed_partial` would claim evidence nobody gathered.
  it("fails outright once NOTHING can run, rather than passing partially", async () => {
    const all = CODE_ARCH.tiers.filter((t) => t.kind === "model").map((t) => t.id);
    const reviewer = new Unpayable(all);
    const type = { ...CODE_ARCH, t0: [] as const };

    let thrown: unknown;
    for (let i = 0; i < 8 && thrown === undefined; i++) {
      thrown = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type })
        .then(() => undefined, (e: unknown) => e);
    }

    expect(thrown).toBeInstanceOf(Exhausted);
    expect(store.getReview("r1", "p")?.state).not.toBe("passed_partial");
  });

  // D-39: the one place the system stops and asks a person. A knowledge conflict is
  // not resolved by the store — it becomes a finding the agent must actually work
  // through, and the agent must not write its way past it.
  it("reaches needs_human when the knowledge base contradicts itself", async () => {
    const a = store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "Holds must expire after 7 days",
      why: undefined, path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: undefined,
    });
    const b = store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "Holds must never expire",
      why: undefined, path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: undefined,
    });
    store.escalateConflict(repoId, a.id, b.id, "these cannot both hold");

    const result = await runRound({
      store, reviewer: new ScriptedReviewer([[]]), reviewId: "r1", principal: "p", worktree: dir, type: TYPE,
    });

    expect(result.decision.kind).toBe("needsHuman");
    expect(store.getReview("r1", "p")?.state).toBe("needs_human");
  });
});

// The statement-level dedup these tests covered went with the write path they guarded.
//
// 21 of one repository's 27 derived rules were one sentence about one false positive,
// written once per livelock cycle, and `hasKnowledgeStatement` was the answer. Then the
// per-justification `addKnowledge` call was removed entirely — a justification teaches
// nothing now, only a `fixed` finding does — and the guard outlived what it guarded.
// Four test references and no production caller is a method that exists to be tested,
// and it read as covered because the dead-export scan counts test files.
//
// The remaining deriver, `promoteRecurring`, is idempotent by PROVENANCE rather than by
// text (`derive.ts`, `recurrence:<kind>:<key>`), which is the stronger property: it also
// refuses a second copy when the wording drifts. Nothing was left uncovered by deleting
// this; the cover was for code that is gone.

/**
 * A tier the PROVIDER has said is out is not called at all (D-90 widened).
 *
 * D-91 cut a dead tier from 2700s to a measured 41s. Forty-one seconds is still spent
 * re-confirming a fact the provider stated once with a date — per review, until the date
 * passes. Vany: *"wasting time is a crime."*
 *
 * The line these two tests hold is between a fact and an inference. A stated reset time
 * is the provider's claim about itself and is true for everyone; a backoff we guessed is
 * not, and acting on it across reviews would narrow one review's coverage using evidence
 * it never saw.
 */
describe("a tier the provider said is out", () => {
  /** Counts calls per tier, and answers cleanly — so any call at all is visible. */
  class Counting implements ReviewerLike {
    readonly seen: string[] = [];
    async review(tier: Tier): Promise<ReviewerResult> {
      this.seen.push(tier.id);
      return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
    }
  }

  it("is not asked, and the round steps over it", async () => {
    const reviewer = new Counting();
    store.markTierUnavailable("t1", new Date(Date.now() + 3_600_000).toISOString(), "the provider said its limit resets then", 1);
    const type = { ...CODE_ARCH, t0: [] as const };

    let last;
    for (let i = 0; i < 8; i++) {
      last = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type }).catch(() => undefined);
      if (last === undefined || !["escalate", "fastClean"].includes(last.decision.kind)) break;
    }

    expect(reviewer.seen.includes("t1"), "not one call to t1 — that is the whole point").toBe(false);
    expect(reviewer.seen.length, "the tiers above it did the work").toBeGreaterThan(0);
    // D-88: t1 sits below tiers that answered, so the verdict is not weakened by it.
    expect(last?.decision.kind).toBe("passed");
    // AND THE CLIENT IS TOLD. A tier that never ran is a fact about this review whether
    // or not it cost the verdict, and "not asked" must not be quieter than "asked and
    // failed" — that would make the cheaper path the less honest one.
    expect(store.unavailableChecks("r1").join("\n")).toMatch(/was not asked/);
  });

  // An EXPIRED mark is not a mark. The window closing is the whole mechanism by which a
  // recovered provider gets used again; a comparison that ignored it would retire a tier
  // permanently on one bad afternoon.
  it("is asked again once the stated time has passed", async () => {
    const reviewer = new Counting();
    store.markTierUnavailable("t1", new Date(Date.now() - 1_000).toISOString(), "over", 1);
    const type = { ...CODE_ARCH, t0: [] as const };

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });

    expect(reviewer.seen, "an expired mark is not a mark").toStrictEqual(["t1"]);
  });
});

/**
 * t0 is not re-run on a tree it has already read (D-92).
 *
 * Vany: *"call t0 only if diff was applied."* t0 runs at the head of every round so a fix
 * that breaks the build is caught — but a round following an ESCALATION reads a
 * byte-identical tree, and t0 is deterministic by construction. Measured across every t0
 * run ever recorded: 18% of t0 time on rigid-monorepo and 26% on lore went on exactly
 * this, four minutes at a time, in front of someone waiting for a verdict.
 */
describe("t0 on a tree that has not moved", () => {
  /** Counts how many times the engines were actually asked to run. */
  const countingT0 = (calls: { n: number }) => async () => {
    calls.n++;
    return { findings: [], outcomes: [], unavailable: ["eslint: no config"], skipped: [] };
  };

  it("runs once and is reused while the tree is unchanged", async () => {
    const calls = { n: 0 };
    const reviewer = new ScriptedReviewer([[], [], []]);
    const type = { ...CODE_ARCH, t0: [] as const };

    for (let i = 0; i < 3; i++) {
      const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, t0: countingT0(calls) });
      if (!["escalate", "fastClean"].includes(r.decision.kind)) break;
    }

    expect(calls.n, "the ladder escalated; nothing changed under it").toBe(1);
  });

  /**
   * `unavailable` MUST survive the reuse. It is a real coverage statement — an engine
   * that could not run is a check nobody made — and it reaches the model prompt and the
   * client verbatim. Dropping it would make a reused round quietly claim more coverage
   * than the round it reused.
   */
  it("carries forward what the first run could not check", async () => {
    const calls = { n: 0 };
    const reviewer = new ScriptedReviewer([[], [], []]);
    const type = { ...CODE_ARCH, t0: [] as const };
    for (let i = 0; i < 3; i++) {
      const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, t0: countingT0(calls) });
      if (!["escalate", "fastClean"].includes(r.decision.kind)) break;
    }

    const rows = store.db
      .prepare("SELECT unavailable FROM tier_run WHERE review_id = 'r1' AND tier = 't0' ORDER BY id")
      .all() as { unavailable: string | null }[];
    expect(rows.length, "every round still records that t0 was accounted for").toBeGreaterThan(1);
    for (const row of rows) expect(row.unavailable ?? "").toContain("eslint: no config");
  });
});
