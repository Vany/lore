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
import { fingerprint } from "../core/fingerprint.ts";
import { initialState } from "../core/ladder.ts";
import { CODE_ARCH } from "../core/review-type.ts";
import { Store } from "../store/store.ts";
import type { Finding } from "../core/finding.ts";
import type { ReviewerLike, ReviewerResult } from "./opencode.ts";
import { runRound } from "./review.ts";

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
    // An accepted justification is how the codebase acquires a fact about itself.
    expect(
      store.knowledgeFor(repoId).some((k) => k.statement.includes("releases the hold in its finally block")),
    ).toBe(true);
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

  // Raised by a real reviewer against this file, an hour after the model tier's
  // half of the same fix landed: T0 shells out to tsc, semgrep and a sandboxed test
  // suite, any of which can die, and a crash used to leave no row at all.
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
