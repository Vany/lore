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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CancelledByLore, DidNotRun, Exhausted, ProbeInconclusive, ProviderAuthFailed, ServiceUnreachable } from "../core/errors.ts";
import type { Tier } from "../core/ladder.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { DEFAULT_TIERS, initialState, ladderFingerprint } from "../core/ladder.ts";
import { PROBE_INTERVAL_MS } from "../core/cooloff.ts";
import { CODE_ARCH } from "../core/review-type.ts";
import { Store } from "../store/store.ts";
import type { Finding } from "../core/finding.ts";
import type { Listed, ReviewerLike, ReviewerResult, SessionResult } from "./opencode.ts";
import { CARRIED_TIER, originalJustification, runRound } from "./review.ts";
import { treeHash } from "../git/repo.ts";

/** A reviewer that says exactly what a test tells it to, and records what it saw. */
class ScriptedReviewer implements ReviewerLike {
  /**
   * A PAIR NOW, NOT A STRING (D-80). `review()` takes either one prompt or the
   * initial/continued pair a kept session needs, and a fixture that recorded the object
   * would assert against "[object Object]" — passing or failing for reasons unrelated to
   * what it is testing. The INITIAL is what these tests are about: what a tier is told
   * when it first looks.
   */
  static text(p: unknown): string {
    return typeof p === "string" ? p : String((p as { initial?: string }).initial ?? "");
  }


  readonly prompts: string[] = [];
  /**
   * The CONTINUED half of each pair, which only a kept session is ever sent (D-80).
   * Recorded separately because it is a different question — what a tier is told when it
   * comes BACK — and because it is where the D-10 filter is observable.
   */
  readonly continued: string[] = [];
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

  async review(_tier: unknown, prompt: unknown, _worktree: string): Promise<ReviewerResult> {
    this.prompts.push(ScriptedReviewer.text(prompt));
    if (typeof prompt === "object" && prompt !== null) {
      this.continued.push(String((prompt as { continued?: string }).continued ?? ""));
    }
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

/** Same shape, anchored to a doc file — the D-132 prose-loop shape. */
const nthDocBug = (n: number): Finding => ({ ...HOLD_BUG, file: "TODO.md", line: n, claim: `wording issue ${String(n)}` });

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

  // Fingerprint 4ca2c2a4: the catch block around t0 used to close the round
  // ("failed", []) — an empty unavailable list reads exactly like a t0 phase
  // that attempted every engine and found none of them unavailable, when in
  // fact the whole phase never got that far.
  it("closes t0's tier_run with a real reason when the phase itself throws", async () => {
    const reviewer = new ScriptedReviewer([]);
    const throwingT0 = async () => {
      throw new Error("ECONNREFUSED");
    };
    const t0 = throwingT0 as unknown as Parameters<typeof runRound>[0]["t0"];
    await expect(
      runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(store.latestT0Unavailable("r1")).toEqual(["t0: threw before completing — ECONNREFUSED"]);
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

  // D-132: the same bound, the opposite outcome — a branch whose diff against its
  // base is documentation only must not be stopped by the per-tier round bound,
  // even raising a fresh finding every round exactly as the test above does.
  it("does not stop on the per-tier bound when every open finding is doc-anchored", async () => {
    // Explicitly off `main`, not whatever `beforeEach` left checked out
    // (`feat/holds`) — branching from there would carry src/hold.ts into this
    // diff too and defeat the whole point of the test.
    git("checkout", "-qb", "docs/only", "main");
    writeFileSync(join(dir, "TODO.md"), "- [ ] a real task\n");
    git("add", "-A");
    git("commit", "-qm", "update todo");

    store.createReview({
      id: "r3",
      repoId,
      principal: "p",
      branch: "docs/only",
      intoRef: "main",
      ticket: "Update TODO.md.",
      type: CODE_ARCH.id,
      state: "running",
      ladder: initialState(CODE_ARCH.tiers),
    });

    const reviewer = new ScriptedReviewer([[nthDocBug(1)], [nthDocBug(2)], [nthDocBug(3)], [nthDocBug(4)]]);
    let last;
    for (let i = 0; i < 4; i++) {
      last = await runRound({ store, reviewer, reviewId: "r3", principal: "p", worktree: dir, type: TYPE });
    }

    expect(last?.decision.kind).not.toBe("stopped");
    expect(store.getReview("r3", "p")?.state).not.toBe("failed");
  });

  // THE ACTUAL MOTIVATING SHAPE (fingerprint 6a6ae919): both MEMO-recorded
  // incidents were CODE branches that also touched prose — a `.ts` finding
  // settled early, then every later round argued only about `SPEC.md`. The
  // branch's cumulative diff is therefore NEVER docs-only for its whole life;
  // what must go doc-only is which findings are still OPEN, round by round.
  it("does not stop once the only findings still open are doc-anchored, even though the branch also touched code", async () => {
    git("checkout", "-qb", "mixed/holds-and-docs", "main");
    execFileSync("mkdir", ["-p", join(dir, "src")]);
    writeFileSync(join(dir, "src/hold.ts"), "export function capture() {\n  // work\n  return 1;\n}\n");
    writeFileSync(join(dir, "TODO.md"), "- [ ] a real task\n");
    git("add", "-A");
    git("commit", "-qm", "add capture, update todo");

    store.createReview({
      id: "r4",
      repoId,
      principal: "p",
      branch: "mixed/holds-and-docs",
      intoRef: "main",
      ticket: "Add capture() and update TODO.md.",
      type: CODE_ARCH.id,
      state: "running",
      ladder: initialState(CODE_ARCH.tiers),
    });

    // Round 1 raises both; the code finding is fixed before round 2, so every
    // round after that only ever has doc findings still open — the code
    // finding's own presence in the branch's diff must not matter from here on.
    const reviewer = new ScriptedReviewer([
      [HOLD_BUG, nthDocBug(1)],
      [nthDocBug(2)],
      [nthDocBug(3)],
      [nthDocBug(4)],
    ]);
    let last = await runRound({ store, reviewer, reviewId: "r4", principal: "p", worktree: dir, type: TYPE });
    writeFileSync(join(dir, "src/hold.ts"), "export function capture() {\n  return release();\n}\n");
    for (let i = 0; i < 3; i++) {
      last = await runRound({ store, reviewer, reviewId: "r4", principal: "p", worktree: dir, type: TYPE });
    }

    expect(store.latestVerdict("r4", fingerprint(HOLD_BUG))?.verdict).toBe("fixed");
    expect(
      store.openFindings("r4").every((f) => f.file === "TODO.md"),
      "every finding still open by the last round is doc-anchored",
    ).toBe(true);
    expect(last.decision.kind).not.toBe("stopped");
    expect(store.getReview("r4", "p")?.state).not.toBe("failed");
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

  // D-130: a folder review has no `into` and no diff to speak of — runRound routes it
  // to wholeTreeDiff instead of computeDiff, and the prompt has to say so honestly
  // rather than reusing branch-mode's "THIS DIFF IS THE CHANGE THE BRANCH INTRODUCES"
  // framing over a diff that, mechanically, shows everything as added.
  it("reviews a path as a full read, not a diff, when reviewPath is set", async () => {
    store.createReview({
      id: "r2",
      repoId,
      principal: "p",
      branch: "feat/holds",
      reviewPath: "src",
      ticket: "Review this module on its own terms.",
      type: CODE_ARCH.id,
      state: "running",
      ladder: initialState(CODE_ARCH.tiers),
    });
    const reviewer = new ScriptedReviewer([[]]);
    const result = await runRound({ store, reviewer, reviewId: "r2", principal: "p", worktree: dir, type: TYPE });

    expect(result.decision.kind).not.toBe("stopped");
    const prompt = reviewer.prompts[0] ?? "";
    expect(prompt).toContain("Review this module on its own terms.");
    expect(prompt).toContain("FULL READ");
    expect(prompt).toContain("src/hold.ts");
    expect(prompt).not.toContain("THIS DIFF IS THE CHANGE THE BRANCH INTRODUCES");
    // PROG.md sits outside src/ in the fixture, so a path-scoped folder review must
    // not pull it into the diff the way an unscoped one (or a branch diff) would.
    expect(prompt).not.toContain("PROG.md");
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

  // D-133, the same silence-based ruling loop a text lore-ok already goes through —
  // reached by a stored claim instead of a file comment.
  it("accepts a fixed_elsewhere claim the reviewer declines to re-raise", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    store.recordFixedElsewhere("r1", fingerprint(HOLD_BUG), "src/hold.ts", 3, "released in a shared helper now");
    const second = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(second.accepted).toStrictEqual([fingerprint(HOLD_BUG)]);
    expect(store.latestVerdict("r1", fingerprint(HOLD_BUG))?.verdict).toBe("justified-accepted");
    expect(store.latestVerdict("r1", fingerprint(HOLD_BUG))?.rationale).toContain("shared helper");
  });

  it("rejects a fixed_elsewhere claim when the reviewer raises the finding anyway", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG], [HOLD_BUG]]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    store.recordFixedElsewhere("r1", fingerprint(HOLD_BUG), "src/hold.ts", 3, "moved it, trust me");
    const second = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(second.rejected).toStrictEqual([fingerprint(HOLD_BUG)]);
    // NOT "fixed" -- silence over a fixed_elsewhere claim is justified-accepted, the
    // same verdict kind an ordinary lore-ok gets, not a new kind of its own.
    expect(store.latestVerdict("r1", fingerprint(HOLD_BUG))?.verdict).toBe("justified-rejected");
    expect(store.settledFingerprints("r1")).not.toContain(fingerprint(HOLD_BUG));
  });

  // Regression for fingerprint c380dbe9: collectFixedElsewhere built a Pending from
  // `claim.reason` alone -- the ONE structured datum a fixed_elsewhere claim supplies
  // beyond an ordinary lore-ok, WHERE the fix landed, never reached the tier that is
  // meant to ratify it, which saw only free prose indistinguishable from a claim
  // naming nowhere at all. Uses a DIFFERENT file than HOLD_BUG's own ("src/hold.ts"),
  // so its appearance in the prompt can only come from the claim, not the finding.
  it("tells the reviewer WHERE a fixed_elsewhere claim's fix landed, not only why", async () => {
    const reviewer = new ScriptedReviewer([[HOLD_BUG], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    store.recordFixedElsewhere("r1", fingerprint(HOLD_BUG), "src/shared/release.ts", 9, "released in a shared helper now");
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(reviewer.prompts[1]).toContain("src/shared/release.ts");
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
      return { findings: [], outcomes: [], unavailable: [], skipped: [], interrupted: false };
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

    /**
     * THE RATIFIED REASON REACHES A LATER PROMPT (found by lore's own review, fingerprint
     * c8f3a31e). `settledForPrompt` looked a settled fingerprint up inside `openFindings`
     * — its own provable complement (`settledFingerprints` requires a settling verdict,
     * `openFindings` requires none) — so the lookup always failed and every review's
     * "ALREADY CONSIDERED AND RESOLVED" block was empty from round one onward, silently.
     */
    it("carries a settled finding's claim into the next round's prompt", async () => {
      const reviewer = new ScriptedReviewer([[HOLD_BUG], [], []]);
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
      fix();
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
      expect(store.settledFingerprints("r1"), "settled after round 2's silence over the fix").toContain(fingerprint(HOLD_BUG));

      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

      const thirdPrompt = reviewer.prompts[2] ?? "";
      expect(thirdPrompt, "the settled ledger reaches a later prompt").toContain("ALREADY CONSIDERED AND RESOLVED");
      expect(thirdPrompt, "naming the claim that was settled").toContain(HOLD_BUG.claim);
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

    /**
     * THE SAME RULE, ON THE PROMPT SIDE (D-80 × D-10).
     *
     * A continued round hands the tier its own open findings and asks it to rule on them.
     * Handing it ANOTHER tier's would ask t1 to close what t3 raised — which is what the
     * test above refuses to let happen in the verdict, and it would be no better for
     * arriving as a question. The tier that raised a finding is the one that judges it.
     */
    it("puts only this tier's own open findings back to it", async () => {
      // Only a tier that KEEPS its session is ever sent a continued prompt (D-80), and the
      // flag is deliberately outside `ladderFingerprint`, so this resumes the same review.
      const KEEPS = {
        ...TYPE,
        tiers: DEFAULT_TIERS.map((t) => (t.kind === "model" ? { ...t, conversation: true } : t)),
      };
      const reviewer = new ScriptedReviewer([[HOLD_BUG], []]);
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: KEEPS });
      expect(store.openFindings("r1")).toHaveLength(1);

      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: KEEPS });
      expect(reviewer.continued[1], "its own finding is named").toContain(HOLD_BUG.claim);

      // Now it belongs to t3, and t1 must not be asked about it.
      store.db.prepare("UPDATE finding SET origin = 't3' WHERE review_id = 'r1'").run();
      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: KEEPS });
      expect(reviewer.continued[2], "another tier's is not").not.toContain(HOLD_BUG.claim);
    });

    // Fingerprint dd98f788, found by lore's own review of the OOM-kill fix (src/t0):
    // this same silence-settles-a-fix mechanism assumed t0's silence about a
    // previously open finding always meant a genuine re-check. An interrupted t0
    // round's silence means nothing — some engine did not finish — and settling on
    // it anyway would record a permanent `fixed` verdict `expireStaleVerdicts` can
    // never reopen (it only reopens justifications, never a settled fix).
    it("does not settle a t0 finding on an interrupted round's silence", async () => {
      const T0_BUG: Finding = { ...HOLD_BUG, claim: "t0 found a real defect here" };
      let call = 0;
      const t0 = async () => {
        call++;
        return call === 1
          ? { findings: [T0_BUG], outcomes: [], unavailable: [], skipped: [], interrupted: false }
          : { findings: [], outcomes: [], unavailable: ["tsc: killed"], skipped: [], interrupted: true };
      };
      const type = { ...CODE_ARCH, t0: ["tsc"] as const };
      const reviewer = new ScriptedReviewer([[], []]);

      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, t0 });

      fix();
      const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, t0 });

      expect(after.fixed, "an interrupted round's silence must not settle a t0 finding").not.toContain(fingerprint(T0_BUG));
      expect(store.openFindings("r1").map((f) => f.fingerprint)).toContain(fingerprint(T0_BUG));
    });
  });

  // lore-ok[6aa59cb5]: found by lore's own review. `verdict.model` existed in the
  // schema and was published by the audit trail, but no code path ever wrote it —
  // and the one thing it exists to answer is exactly this: a fallback keeps the
  // tier's id and changes its model (`continuity.ts`, observed on rev_8ZM1XT7), so
  // naming `tier.model` there would have recorded the PRIMARY that never answered.
  describe("a settled verdict names the route that actually answered", () => {
    const fix = () => writeFileSync(join(dir, "src/hold.ts"), "export function capture() {\n  return release();\n}\n");

    it("records the twin's route on a fix settled while the tier is running on its fallback", async () => {
      const type = {
        ...TYPE,
        tiers: DEFAULT_TIERS.map((t) => (t.id === "t1" ? { ...t, fallback: ["openrouter/twin"] } : t)),
      };
      const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";

      /** Answers once as the primary, then goes out of quota — forcing round 2 onto the twin. */
      class FallsBackOnSecondCall implements ReviewerLike {
        primaryCalls = 0;
        async review(tier: Tier): Promise<ReviewerResult> {
          const empty = { discarded: [], raw: "", inputTokens: 1, cachedTokens: 0, outputTokens: 1, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
          if (tier.model === primary) {
            this.primaryCalls++;
            if (this.primaryCalls >= 2) throw new Exhausted("primary is out");
            return { ...empty, findings: [HOLD_BUG] };
          }
          // The twin: silent about HOLD_BUG, which — once the code has moved — is
          // what settles it.
          return { ...empty, findings: [] };
        }
      }
      const reviewer = new FallsBackOnSecondCall();

      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });
      fix();
      const after = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

      expect(after.fixed, "the fallback's silence over moved code must still settle it").toStrictEqual([fingerprint(HOLD_BUG)]);
      expect(
        store.latestVerdict("r1", fingerprint(HOLD_BUG))?.model,
        "the twin's own route, not t1's configured primary — the whole point of the fix",
      ).toBe("openrouter/twin");
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

  /**
   * A KEPT SESSION'S USAGE IS RECORDED AS A DELTA, NOT ITS RUNNING TOTAL (found by
   * lore's own review, fingerprint 43cfcfbc). `conduct` (opencode.ts) reads a
   * conversation:true tier's usage from its WHOLE message list, which for a session
   * kept across rounds already includes every earlier round's messages — round 3's
   * figure IS rounds 1+2+3. Recorded verbatim each round, `spendSince` and the
   * per-tier board (both `SUM(cost_usd)` across every row) then add round 1's total
   * in again on top of round 2's, and again on top of round 3's: the same n²/2
   * over-count `runRound`'s own D-107 emission loop was fixed for within one round,
   * reopened across the rounds of a kept one.
   */
  it("records a kept session's usage as a per-round delta, not a running total", async () => {
    // ONLY t1 kept, and a FRESH finding every round: a kept tier that goes clean
    // ESCALATES to the next one (D-31/32), which would ask three DIFFERENT tiers once
    // each rather than the same one three times — not the shape this fix is about.
    // `nthBug` keeps raising something new so t1 is asked again instead.
    const KEPT = { ...TYPE, tiers: DEFAULT_TIERS.map((t) => (t.id === "t1" ? { ...t, conversation: true } : t)) };
    let calls = 0;
    const cumulative: ReviewerLike = {
      review: async () => {
        calls++;
        // A kept session reports CUMULATIVE usage every round — exactly what `conduct`
        // does for a conversation:true tier, summing the whole session each time.
        return {
          findings: [nthBug(calls)],
          raw: "", inputTokens: 1000 * calls, cachedTokens: 0,
          outputTokens: 100 * calls, costUsd: 0.01 * calls, latencyMs: 1,
          discarded: [], retried: false, steps: 1,
        };
      },
    };
    await runRound({ store, reviewer: cumulative, reviewId: "r1", principal: "p", worktree: dir, type: KEPT });
    await runRound({ store, reviewer: cumulative, reviewId: "r1", principal: "p", worktree: dir, type: KEPT });
    await runRound({ store, reviewer: cumulative, reviewId: "r1", principal: "p", worktree: dir, type: KEPT });
    expect(calls, "three rounds must each have asked t1").toBe(3);

    const total = store.usageSoFar("r1", "t1", "openrouter/z-ai/glm-5.2");
    expect(total.inputTokens, "the true total, not 1000+2000+3000").toBe(3000);
    expect(total.costUsd, "the true total, not 0.01+0.02+0.03").toBeCloseTo(0.03, 6);
  });

  /**
   * A ROUTE FLIP STARTS A NEW SESSION WITH ITS OWN COUNTER — found by lore's own review
   * of the first version of the 43cfcfbc fix, fingerprint 45fa213f. `sessionKey`
   * (continuity.ts) addresses a session by `(review, tier, MODEL)` because a fallback
   * keeps the tier's id and changes its model — so the twin's session is genuinely new
   * and its own usage has nothing to do with what the primary's session had already
   * banked. The first version of `perRoundUsage` summed a tier's usage across every
   * model it had ever run on, so the twin's first, small report was floored to $0 by
   * subtracting the primary's unrelated total.
   */
  it("does not floor a route flip's usage using the old route's unrelated total", async () => {
    const type = {
      ...TYPE,
      tiers: DEFAULT_TIERS.map((t) => (t.id === "t1" ? { ...t, conversation: true, fallback: ["openrouter/twin"] } : t)),
    };
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";

    class FallingBack implements ReviewerLike {
      primaryCalls = 0;
      twinCalls = 0;
      async review(tier: Tier): Promise<ReviewerResult> {
        if (tier.model === primary) {
          this.primaryCalls++;
          // Answers once, then goes out of quota — forcing round 2 onto the twin.
          if (this.primaryCalls >= 2) throw new Exhausted("primary is out");
          return {
            findings: [nthBug(this.primaryCalls)], discarded: [], raw: "",
            inputTokens: 500, cachedTokens: 0, outputTokens: 50, costUsd: 0.005,
            latencyMs: 1, retried: false, steps: 1,
          };
        }
        // The twin: a fresh session (D-80), its own first-ever report.
        this.twinCalls++;
        return {
          findings: [nthBug(100 + this.twinCalls)], discarded: [], raw: "",
          inputTokens: 500, cachedTokens: 0, outputTokens: 50, costUsd: 0.005,
          latencyMs: 1, retried: false, steps: 1,
        };
      }
    }
    const reviewer = new FallingBack();

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });
    expect(store.usageSoFar("r1", "t1", primary).inputTokens, "the primary's own round 1").toBe(500);

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });
    expect(reviewer.twinCalls, "round 2 fell back to the twin").toBe(1);

    // THE RAW ROW ITSELF, not `usageSoFar`'s aggregate: a tier-only baseline zeroing the
    // twin's delta and a correctly model-scoped one summed to the SAME total by
    // coincidence in an earlier version of this test (both models happened to report
    // 500) — the aggregate could not tell a genuine 500 from a wrongly-floored 0 sitting
    // beside the primary's untouched 500. The row `recordUsage` actually wrote can.
    const twinRow = store.db
      .prepare("SELECT input_tokens FROM usage WHERE review_id = 'r1' AND tier = 't1' AND model = 'openrouter/twin' ORDER BY id DESC LIMIT 1")
      .get() as { input_tokens: number } | undefined;
    expect(twinRow?.input_tokens, "the twin's own report, not zeroed by the primary's unrelated banked total").toBe(500);

    // AND THE PRIMARY'S OWN TOTAL IS UNTOUCHED — a route flip must not retroactively
    // change what an earlier, different session had already recorded.
    expect(store.usageSoFar("r1", "t1", primary).inputTokens).toBe(500);
  });

  /**
   * A CANCEL MID-TWIN-CALL STILL SPENT REAL MONEY, and it has to be attributed to the
   * twin that spent it — not floored to zero against the PRIMARY's unrelated banked
   * total.
   *
   * `if (!stillWanted()) throw twin` used to fire before the twin-attributed recording
   * a few lines below it, so a cancel landing mid-twin-call skipped straight to the
   * outer catch — which has no `twinModel` in scope and falls back to
   * `fellBackTo ?? chosenRoute ?? member.model`, both of the first two undefined on
   * this path. Once `usageSoFar` became model-scoped, by fingerprint 45fa213f, that meant
   * the twin's spend was deltaed against the PRIMARY's own banked total and floored to
   * zero, with no paid-route alert either — fingerprint 960cb2b7.
   */
  it("attributes a cancel-during-twin-call's spend to the twin, not the primary it floors against", async () => {
    const type = {
      ...TYPE,
      tiers: DEFAULT_TIERS.map((t) => (t.id === "t1" ? { ...t, conversation: true, fallback: ["openrouter/twin"] } : t)),
    };
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    const sent: { condition: string; detail: string; severity: string }[] = [];
    const alerter = {
      send: (x: { condition: string; detail: string; severity: string }) => {
        sent.push(x);
        return Promise.resolve(true);
      },
    };

    class CancelMidTwin implements ReviewerLike {
      primaryCalls = 0;
      async review(tier: Tier): Promise<ReviewerResult> {
        if (tier.model === primary) {
          this.primaryCalls++;
          if (this.primaryCalls >= 2) throw new Exhausted("primary is out");
          // Round 1 banks a large baseline the twin's small delta must not be measured against.
          return {
            findings: [nthBug(this.primaryCalls)], discarded: [], raw: "",
            inputTokens: 100_000, cachedTokens: 0, outputTokens: 5_000, costUsd: 0,
            latencyMs: 1, retried: false, steps: 1,
          };
        }
        // The twin: spends real metered money, then the client cancels while it is
        // still mid-call — the review's own state turns terminal before the twin's
        // promise settles, exactly as a live cancel would land.
        store.updateReview("r1", { state: "cancelled" });
        const e = new Error("review r1 ended while the twin was mid-call") as Error & { spent?: Record<string, number> };
        e.spent = { input: 8_000, cached: 0, output: 800, cost: 1.9 };
        throw e;
      }
    }
    const reviewer = new CancelMidTwin();

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true, alerter });
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true, alerter }).catch(() => undefined);

    const twinRow = store.db
      .prepare("SELECT input_tokens i, cost_usd c FROM usage WHERE review_id = 'r1' AND tier = 't1' AND model = 'openrouter/twin' ORDER BY id DESC LIMIT 1")
      .get() as { i: number; c: number } | undefined;
    expect(twinRow?.i, "the twin's real spend, not floored against the primary's unrelated baseline").toBe(8_000);
    expect(twinRow?.c, "the real dollar cost, not zeroed").toBeCloseTo(1.9);

    // THE PRIMARY'S OWN BANKED TOTAL IS UNTOUCHED — a cancelled twin's spend must not
    // land under the primary's name, zeroed or otherwise.
    expect(store.usageSoFar("r1", "t1", primary).inputTokens, "round 1's banked total, unchanged").toBe(100_000);

    expect(sent, "a paid route was actually reached and must still be reported").toHaveLength(1);
    expect(sent[0]?.detail).toContain("openrouter/twin");
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
    // `stated: true` — the provider named this time. Only a stated time may skip a tier
    // in a REVIEW; the test below holds the other half.
    // Probed a moment ago, so the cool-off is honoured: D-94 asks once per interval, not
    // once per review, or a dead tier would cost twelve seconds on every one.
    store.markTierUnavailable(
      "t1", new Date(Date.now() + 3_600_000).toISOString(), "the provider said its limit resets then",
      1, true, new Date().toISOString(),
    );
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

  /**
   * lore HEARS A TIER DIE AND COULD NOT HEAR ONE RECOVER (D-94).
   *
   * The refusal arrives on the event stream in seconds; nothing carried the opposite news.
   * A subscription that came back 81 minutes before its stated reset went on being skipped
   * for all 81, paying a metered provider throughout, and no check anywhere could notice.
   *
   * The trade that justified never asking has inverted: asking cost 2700s when D-90 was
   * written, about twelve seconds since D-91, against a fallback that has cost $4.94.
   */
  it("asks a cooled-off tier again once the probe interval has passed", async () => {
    const reviewer = new Counting();
    // Marked as down for another hour, but last probed long ago.
    store.markTierUnavailable(
      "t1", new Date(Date.now() + 3_600_000).toISOString(), "the provider said its limit resets then",
      1, true, new Date(Date.now() - PROBE_INTERVAL_MS - 1_000).toISOString(),
    );
    const type = { ...CODE_ARCH, t0: [] as const };

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });

    expect(reviewer.seen, "twelve seconds to maybe save a dollar").toStrictEqual(["t1"]);
    // AND ONE SUCCESS CLEARS IT — which the operator banner has promised since D-90
    // shipped, while only the background screen ever delivered it.
    expect(store.tierUnavailable("t1"), "it answered, so it is not down any more").toBeUndefined();
  });

  /**
   * A GUESS MAY NOT DECIDE A REVIEW'S COVERAGE, and this is the half the code got wrong.
   *
   * The background screen writes a mark for its own doubling backoff under the same key.
   * SPEC D-90 and the comment at the call site both promise a review acts only on a time
   * the PROVIDER stated — the write side honoured it and the read side did not, so a
   * screen pass's guess would silently narrow a review that never saw the failure.
   */
  it("is still asked when the wait was only our own guess", async () => {
    const reviewer = new Counting();
    store.markTierUnavailable("t1", new Date(Date.now() + 3_600_000).toISOString(), "2 screen call(s) went unanswered", 2, false);
    const type = { ...CODE_ARCH, t0: [] as const };

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });

    expect(reviewer.seen, "a guess bounds the screen, never a review").toStrictEqual(["t1"]);
  });

  // An EXPIRED mark is not a mark. The window closing is the whole mechanism by which a
  // recovered provider gets used again; a comparison that ignored it would retire a tier
  // permanently on one bad afternoon.
  it("is asked again once the stated time has passed", async () => {
    const reviewer = new Counting();
    // `stated: true`, because that is the half being tested. Four arguments left `stated`
    // defaulting to FALSE, so the read-side condition never got as far as comparing the
    // time — the test passed for the wrong reason and asserted nothing about expiry.
    store.markTierUnavailable("t1", new Date(Date.now() - 1_000).toISOString(), "over", 1, true);
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
    return { findings: [], outcomes: [], unavailable: ["eslint: no config"], skipped: [], interrupted: false };
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
   * THE ENGINE SET IS PART OF THE KEY, not just the tree.
   *
   * The reuse rests on "a deterministic engine set given the same bytes cannot answer
   * differently" — and the SET was a free variable nothing pinned, while the model
   * ladder's fingerprint is pinned and a change refuses the review. A deploy that adds or
   * drops a t0 engine mid-review would have carried the old set's answer forward as
   * though it were the new set's.
   */
  it("runs again when the engine set has changed under it", async () => {
    const calls = { n: 0 };
    const reviewer = new ScriptedReviewer([[], [], []]);

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: { ...CODE_ARCH, t0: [] as const }, t0: countingT0(calls) });
    // Same tree, DIFFERENT engines: the stored answer is another set's answer.
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: { ...CODE_ARCH, t0: ["semgrep"] as const }, t0: countingT0(calls) });

    expect(calls.n, "a different engine set is a different question").toBe(2);
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

/**
 * A REUSED t0 MUST NOT HAND THE CLIENT'S TEXT TO A MODEL (D-83 × D-92).
 *
 * The client's `unavailable` quotes the development rule an accepted appeal cited; the
 * reviewer's says a check was silenced and never what the rule says — `knowledge_teach`
 * promises exactly that, and a rule's text reaches a tier only with the appeal citing it.
 *
 * Both were recomputed every round, so one column held only the client's version and
 * nothing noticed. Reusing a stored t0 (D-92) then read that column back into `renderT0`,
 * which is in every model prompt for every later round: one accepted appeal would have
 * become a standing injection into that repository's reviews for ever.
 */
describe("what a reused t0 tells a reviewer", () => {
  it("carries the reviewer's list forward, not the client's", async () => {
    const CLIENT = 'X was NOT reported at a.ts — t1 accepted an appeal to rule abc ("never do Y") on 2026-08-09';
    const TIER = "X was NOT reported at a.ts — an appeal to a development rule was accepted";
    const t0RunId = store.openTierRun("r1", "t0", 1, new Date().toISOString());
    store.closeTierRun(t0RunId, "clean", [CLIENT], "tree-1", [TIER]);

    const back = store.lastT0("r1");

    expect(back?.unavailable, "the audit trail keeps the whole reason").toStrictEqual([CLIENT]);
    expect(back?.unavailableForTier, "the prompt gets the fact without the rule").toStrictEqual([TIER]);
    expect((back?.unavailableForTier ?? []).join(" "), "the rule's own words never travel").not.toContain("never do Y");
  });

  /**
   * A row written before the split existed has no tier-facing column, and the honest
   * reading is "the two were the same" — those rows predate t0 reuse, so nothing feeds
   * them to a model. An EMPTY tier list is a real answer and must not be confused with an
   * absent one, or every reused round would silently fall back to the client's text.
   */
  /**
   * A row from before the split says UNKNOWN, never "the same as the client's".
   *
   * Falling back to the client's list was the first fix and it re-opened the very hole it
   * closed: this query reads only t0 rows, so the only NULL it can see is a pre-split row
   * — exactly the rows whose client text can quote a rule. The caller re-runs the engines
   * instead, which costs one t0 on a review open across a deploy.
   */
  it("says UNKNOWN for a row written before the split, never the client's list", async () => {
    const old = store.openTierRun("r1", "t0", 1, new Date().toISOString());
    store.closeTierRun(old, "clean", ["eslint: no config"], "tree-old");
    expect(store.lastT0("r1")?.unavailableForTier).toBeUndefined();

    const fresh = store.openTierRun("r1", "t0", 2, new Date().toISOString());
    store.closeTierRun(fresh, "clean", ["eslint: no config"], "tree-new", []);
    expect(store.lastT0("r1")?.unavailableForTier, "nothing to tell the reviewer is an answer").toStrictEqual([]);
  });
});

/**
 * A REUSED ROUND STILL SAYS WHAT IS SWITCHED OFF (D-83 × D-92).
 *
 * `silenced` is built by filtering fresh engine findings, and a reused t0 has none — so
 * nothing was filtered and nothing was said. That is silent for exactly the case that
 * matters: an appeal accepted in round N is recorded AFTER round N's filter has run, so
 * round N's rows do not mention it either. On the ordinary appeal-then-pass path no row
 * in the whole review says a check is off.
 */
describe("what a reused round says about a suppressed check", () => {
  /**
   * A REUSED ROUND STILL SAYS WHAT IS SWITCHED OFF (D-83 × D-92).
   *
   * `silenced` is built by filtering fresh engine findings, and a reused t0 has none — so
   * nothing was filtered and nothing was said. That is silent for exactly the case that
   * matters: an appeal accepted in round N is recorded AFTER round N's filter has run, so
   * round N's rows do not mention it either. On the ordinary appeal-then-pass path no row
   * in the whole review would say a check is off.
   *
   * DRIVEN THROUGH `runRound`, because the first version of this test asserted only that
   * `store.liveSuppressions` returned the row it had just seeded — naming the disclosure
   * and testing the fixture. Deleting the whole block left the suite green.
   */
  it("discloses a live suppression on a round that reused t0", async () => {
    const policy = store.addKnowledge({
      repoId, kind: "policy", source: "taught",
      statement: "Loopback HTTP in a test is not transport.", why: "no network to encrypt",
      path: undefined, cwe: undefined, provenance: "taught by vany", sourceBlob: undefined, confidence: 1,
    });
    store.recordSuppression({
      repoId,
      policyShort: policy.id.slice(0, 8),
      ruleClass: "some.engine.rule",
      path: "src/a.test.ts",
      reviewId: "r1",
      tier: "t1",
    });
    const reviewer = new ScriptedReviewer([[], [], []]);
    const type = { ...CODE_ARCH, t0: [] as const };

    // Two rounds on an unchanged tree: the second reuses t0 and so has no findings to
    // filter, which is the whole condition under test.
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });

    const rows = store.db
      .prepare("SELECT unavailable, unavailable_for_tier FROM tier_run WHERE review_id='r1' AND tier='t0' ORDER BY id")
      .all() as { unavailable: string | null; unavailable_for_tier: string | null }[];
    const reused = rows[rows.length - 1];
    expect(rows.length, "the second round recorded a t0 row too").toBeGreaterThan(1);
    expect(reused?.unavailable ?? "", "the client is told a check is off").toContain("was NOT reported at src/a.test.ts");
    // TWO AUDIENCES. The client's version quotes the rule; the reviewer's must not — a
    // rule's text reaches a tier only with the appeal that cites it (D-83).
    expect(reused?.unavailable ?? "").toContain("Loopback HTTP");
    expect(reused?.unavailable_for_tier ?? "").toContain("was NOT reported at src/a.test.ts");
    expect(reused?.unavailable_for_tier ?? "", "the rule's own words never travel").not.toContain("Loopback HTTP");
  });
});

/**
 * An exhausted subscription asks the same model somewhere with credit (D-93).
 *
 * Vany: *"we have some openrouter credits… if there is no quota on the subscription
 * fallback to openrouter."* An exhausted plan used to cost the review this tier entirely
 * — its work promoted to a dearer one (D-48) and the verdict labelled accordingly. The
 * model is not gone, only this route to it.
 *
 * This is the ONLY path in lore that spends metered money, so both bounds are pinned
 * here: it fires on quota alone, and it fires once.
 */
describe("falling back to a metered twin", () => {
  /** Refuses the primary on quota, answers as the fallback. */
  class OutOfQuota implements ReviewerLike {
    readonly asked: string[] = [];
    // Declared rather than a parameter property: `erasableSyntaxOnly` forbids those,
    // because node strips types rather than compiling them (D-3).
    private readonly refuse: string;
    constructor(refuse: string) {
      this.refuse = refuse;
    }
    async review(tier: Tier): Promise<ReviewerResult> {
      this.asked.push(tier.model ?? "?");
      if (tier.model === this.refuse) throw new Exhausted(`tier ${tier.id} refused on quota`);
      return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
    }
  }

  const withFallback = (...fallback: string[]) => ({
    ...CODE_ARCH,
    t0: [] as const,
    tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, fallback } : t)),
  });

  /**
   * THE CHAIN, WALKED IN ORDER (D-93, extended 2026-08-12).
   *
   * Vany: *"let's fall back on t2 and t3 to openrouter, and then, if there is no quota, to
   * zai-coding-plan/glm."* One fallback stopped being enough the day OpenRouter ran to
   * zero — $5165.00 granted against $5165.04 used — and every deep tier's only twin was
   * as out as the subscription it was covering for.
   */
  describe("a chain of fallbacks", () => {
    /** Refuses everything named, in the order they are asked. */
    class AllOut implements ReviewerLike {
      readonly asked: string[] = [];
      private readonly refuse: Set<string>;
      constructor(refuse: readonly string[]) {
        this.refuse = new Set(refuse);
      }
      async review(tier: Tier): Promise<ReviewerResult> {
        this.asked.push(tier.model ?? "?");
        if (this.refuse.has(tier.model ?? "")) throw new Exhausted(`tier ${tier.id} refused on quota`);
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }

    it("moves to the second route when the first is out of quota too", async () => {
      const type = withFallback("openrouter/twin", "zai/last-resort");
      const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
      const reviewer = new AllOut([primary, "openrouter/twin"]);

      const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

      expect(reviewer.asked).toStrictEqual([primary, "openrouter/twin", "zai/last-resort"]);
      expect(r.decision.kind, "the tier ran, so the ladder carries on").not.toBe("stopped");
    });

    it("stops at the first route that answers", async () => {
      const type = withFallback("openrouter/twin", "zai/last-resort");
      const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
      const reviewer = new AllOut([primary]);

      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

      expect(reviewer.asked, "the last resort costs money and was not needed").toStrictEqual([
        primary,
        "openrouter/twin",
      ]);
    });

    /**
     * EVERY ROUTE THAT REFUSED IS NAMED (D-105). A notice that stops at the primary is
     * what sent Vany looking for a fallback that had in fact been tried and had failed
     * for its own reason — with nothing anywhere saying so.
     */
    it("names every route when they are all out", async () => {
      const type = withFallback("openrouter/twin", "zai/last-resort");
      const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
      const reviewer = new AllOut([primary, "openrouter/twin", "zai/last-resort"]);

      const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

      const said = JSON.stringify(r);
      expect(said).toContain("openrouter/twin");
      expect(said).toContain("zai/last-resort");
    });

    /**
     * ONWARD ONLY ON QUOTA. Quota is a fault about the ROUTE; a bad reply or a diff too
     * large is a fault about the MODEL and repeats wherever it is asked. Walking on for
     * those would spend the next subscription buying the same failure.
     */
    it("does not walk on past a failure that is not about quota", async () => {
      const type = withFallback("openrouter/twin", "zai/last-resort");
      const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
      class TwinBroken implements ReviewerLike {
        readonly asked: string[] = [];
        async review(tier: Tier): Promise<ReviewerResult> {
          this.asked.push(tier.model ?? "?");
          if (tier.model === primary) throw new Exhausted(`tier ${tier.id} refused on quota`);
          throw new DidNotRun(`tier ${tier.id} returned nothing usable`);
        }
      }
      const reviewer = new TwinBroken();

      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

      expect(reviewer.asked).toStrictEqual([primary, "openrouter/twin"]);
    });
  });

  it("asks the twin, and the tier still counts", async () => {
    const type = withFallback("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    const reviewer = new OutOfQuota(primary);

    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked).toStrictEqual([primary, "openrouter/twin"]);
    // NOT skipped and NOT promoted: the tier ran, so the ladder advances normally.
    expect(["escalate", "fastClean"]).toContain(r.decision.kind);
    expect(store.getReview("r1", "p")?.ladder.unavailable ?? []).toStrictEqual([]);
    // AND THE CLIENT IS TOLD IT WAS NOT FREE. The tier ran, so this is not the usual
    // "you got less than you think" — but which provider answered is a fact about the
    // review, and this one costs money.
    expect(store.unavailableChecks("r1").join("\n")).toMatch(/answered by openrouter\/twin/);
  });

  /**
   * QUOTA ONLY. A tier that returned garbage, or whose window could not hold the diff,
   * will do the same through any provider — retrying those buys the same failure for
   * real money.
   */
  it("does not spend money on a fault the twin would repeat", async () => {
    const type = withFallback("openrouter/twin");
    class Broken implements ReviewerLike {
      readonly asked: string[] = [];
      async review(tier: Tier): Promise<ReviewerResult> {
        this.asked.push(tier.model ?? "?");
        throw new Error("did not return a usable reply after a retry");
      }
    }
    const reviewer = new Broken();

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true }).catch(() => undefined);

    expect(reviewer.asked, "one call: the twin would fail the same way").toHaveLength(1);
  });

  /**
   * A FALLBACK MAY ONLY IMPROVE THE OUTCOME, NEVER WORSEN IT.
   *
   * A twin that HANGS, or returns an unusable reply after its retry, throws `DidNotRun` —
   * which the outer catch rethrows and which fails the whole review. Without a fallback
   * configured, the primary's `Exhausted` alone would have been stepped over with the
   * verdict intact (D-48, D-88). So an unguarded fallback made things strictly worse in
   * exactly the outage window it was bought for.
   */
  it("steps the tier over when the twin fails for a reason that is not quota", async () => {
    const type = withFallback("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    class TwinHangs implements ReviewerLike {
      readonly asked: string[] = [];
      async review(tier: Tier): Promise<ReviewerResult> {
        this.asked.push(tier.model ?? "?");
        if (tier.model === primary) throw new Exhausted("primary is out");
        // ONLY THE TWIN HANGS. The first version of this fixture threw for every model
        // that was not the primary, so t2 and t3 failed too and the review died of that
        // rather than of the thing under test — a fixture broader than its claim.
        if (tier.model === "openrouter/twin") throw new Error("opencode ran past 2700s without finishing");
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }
    const reviewer = new TwinHangs();

    let last;
    for (let i = 0; i < 8; i++) {
      last = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true }).catch(() => undefined);
      if (last === undefined || !["escalate", "fastClean"].includes(last.decision.kind)) break;
    }

    expect(reviewer.asked.slice(0, 2)).toStrictEqual([primary, "openrouter/twin"]);
    // The ladder does what it would have done with no fallback configured: step over the
    // tier and finish. NOT a failed review.
    expect(last?.decision.kind, "a dead twin must not cost more than no twin").toBe("passed");
    expect(store.getReview("r1", "p")?.state).toBe("passed");
  });

  /**
   * A FAILED TWIN STILL SPENT MONEY, and the ceiling has to be able to see it.
   *
   * The outer catch recovers spend from the error it receives, and this path rethrows the
   * PRIMARY's `Exhausted` — whose session spent nothing. So a failed fallback burned real
   * metered tokens that no `usage` row recorded, leaving the round-boundary ceiling blind
   * to exactly the runaway it is the only guard against.
   */
  it("records what the twin spent even when the twin failed", async () => {
    const type = withFallback("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    class TwinBurnsThenDies implements ReviewerLike {
      async review(tier: Tier): Promise<ReviewerResult> {
        if (tier.model === primary) throw new Exhausted("primary is out");
        if (tier.model === "openrouter/twin") {
          const e = new Error("opencode ran past 2700s without finishing") as Error & {
            spent?: { input: number; cached: number; output: number };
          };
          e.spent = { input: 1_000, cached: 250_000, output: 500 };
          throw e;
        }
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }

    await runRound({ store, reviewer: new TwinBurnsThenDies(), reviewId: "r1", principal: "p", worktree: dir, allowMetered: true, type }).catch(
      () => undefined,
    );

    const row = store.db
      .prepare("SELECT model, cached_tokens c, outcome FROM usage WHERE review_id='r1' AND tier='t1'")
      .get() as Record<string, string | number> | undefined;
    expect(row?.["model"], "attributed to the twin, which is the metered one").toBe("openrouter/twin");
    expect(row?.["c"]).toBe(250_000);
    expect(row?.["outcome"], "and marked failed, so it cannot read as a completed round").toBe("failed");
  });

  /**
   * A CANCEL MUST NOT BE LAUNDERED INTO A PROVIDER FAULT.
   *
   * "Never worse than no fallback" is a rule about the PROVIDER failing. A cancel landing
   * while the twin is in flight makes the twin throw because the review ended — and
   * rethrowing the primary's `Exhausted` sent that through D-48's step-over, which writes
   * the ladder's state over the `cancelled` the client was just told it got. The review
   * came back to life and the worker enqueued its next round.
   */
  it("lets a cancel through instead of resurrecting the review", async () => {
    const type = withFallback("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    class CancelledMidFallback implements ReviewerLike {
      async review(tier: Tier): Promise<ReviewerResult> {
        if (tier.model === primary) throw new Exhausted("primary is out");
        // The client cancels while the twin is in flight.
        store.updateReview("r1", { state: "cancelled" });
        throw new DidNotRun("review r1 was ended while this call waited for a provider slot");
      }
    }

    await runRound({ store, reviewer: new CancelledMidFallback(), reviewId: "r1", principal: "p", worktree: dir, allowMetered: true, type }).catch(
      () => undefined,
    );

    expect(store.getReview("r1", "p")?.state, "a cancelled review stays cancelled").toBe("cancelled");
  });

  // A failed twin's spend has to be a number the ceiling can add up. Recorded as a hard
  // zero, the row could not move the only guard against runaway metered spend — which is
  // the entire reason the row exists.
  it("records what the provider said the failed twin cost", async () => {
    const type = withFallback("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    class TwinCostsThenDies implements ReviewerLike {
      async review(tier: Tier): Promise<ReviewerResult> {
        if (tier.model === primary) throw new Exhausted("primary is out");
        if (tier.model === "openrouter/twin") {
          const e = new Error("opencode ran past 2700s") as Error & { spent?: Record<string, number> };
          e.spent = { input: 1_000, cached: 250_000, output: 500, cost: 0.42 };
          throw e;
        }
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }

    await runRound({ store, reviewer: new TwinCostsThenDies(), reviewId: "r1", principal: "p", worktree: dir, allowMetered: true, type }).catch(
      () => undefined,
    );

    const row = store.db
      .prepare("SELECT cost_usd FROM usage WHERE review_id='r1' AND tier='t1'")
      .get() as Record<string, number> | undefined;
    expect(row?.["cost_usd"], "the ceiling sums this column").toBe(0.42);
  });

  /**
   * A RESCUED FALLBACK MUST NOT DROP THE PRIMARY'S OWN RECOVERED SPEND (found by lore's
   * own review, fingerprint f65306a0). The primary's `.spent` is only ever read in the
   * OUTER catch — reached when no fallback runs at all, or when the whole chain is
   * exhausted and replaced by a brand-new synthesized error. When a twin RESCUES the
   * round instead, the primary's own catch falls through having set `result`/`fellBackTo`
   * without ever throwing, so the outer catch — and the only place that read `.spent` —
   * is never reached, and whatever the primary burned before dying vanished.
   */
  it("records what the primary spent even when a fallback rescues the round", async () => {
    const type = withFallback("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    class PrimaryBurnsThenRescued implements ReviewerLike {
      async review(tier: Tier): Promise<ReviewerResult> {
        if (tier.model === primary) {
          const e = new Exhausted("primary is out") as Exhausted & {
            spent?: { input: number; cached: number; output: number; cost: number };
          };
          e.spent = { input: 300, cached: 0, output: 30, cost: 0.02 };
          throw e;
        }
        return { findings: [], discarded: [], raw: "", inputTokens: 500, cachedTokens: 0, outputTokens: 50, costUsd: 0.01, latencyMs: 1, retried: false, steps: 1 };
      }
    }

    await runRound({ store, reviewer: new PrimaryBurnsThenRescued(), reviewId: "r1", principal: "p", worktree: dir, allowMetered: true, type });

    const primaryRow = store.db
      .prepare("SELECT input_tokens i, cost_usd c, outcome FROM usage WHERE review_id='r1' AND tier='t1' AND model = ?")
      .get(primary) as { i: number; c: number; outcome: string } | undefined;
    expect(primaryRow?.i, "the primary's own spend, not dropped because a fallback rescued it").toBe(300);
    expect(primaryRow?.c).toBeCloseTo(0.02);
    expect(primaryRow?.outcome, "the PRIMARY itself did not complete, even though the round did").toBe("failed");

    // AND THE TWIN'S OWN SUCCESSFUL SPEND IS RECORDED SEPARATELY, under its own name —
    // the round overall succeeded, and both routes' real costs are kept, not merged.
    const twinRow = store.db
      .prepare("SELECT input_tokens i FROM usage WHERE review_id='r1' AND tier='t1' AND model = 'openrouter/twin'")
      .get() as { i: number } | undefined;
    expect(twinRow?.i, "the rescuing twin's own spend, unaffected").toBe(500);
  });

  // No fallback for the fallback. If the metered provider refuses too, the ladder's own
  // answer is the right one — a chain of retries is how a bounded cost becomes unbounded.
  it("gives up when the twin is out too, rather than chaining", async () => {
    const type = withFallback("openrouter/twin");
    class BothOut implements ReviewerLike {
      readonly asked: string[] = [];
      async review(tier: Tier): Promise<ReviewerResult> {
        this.asked.push(tier.model ?? "?");
        throw new Exhausted(`tier ${tier.id} refused on quota`);
      }
    }
    const reviewer = new BothOut();

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true }).catch(() => undefined);

    expect(reviewer.asked, "primary, then twin, then stop").toHaveLength(2);
  });
});

/**
 * A COOL-OFF MUST REACH THE FALLBACK, or the two features cancel each other.
 *
 * D-90 skips a tier the provider said is out; D-93 asks the same model somewhere with
 * credit. Thrown one line too far out, the cool-off's synthetic `Exhausted` bypassed the
 * fallback entirely — so for the whole stated window, which is DAYS, the twin was never
 * asked once. Each feature looked correct alone, and together they did nothing.
 */
/**
 * WHEN BOTH HALVES ARE OUT, THE NOTICE MUST SAY BOTH (D-105).
 *
 * A tier is `unpayable` only when its primary AND its fallback have failed, and the record
 * named the primary alone. So a reader saw *"tier t2 (kimi-for-coding/k3) refused on
 * quota"* with a fallback configured and running, and reasonably concluded it had never
 * been tried. Vany did: *"but there is a fallback to openrouter!"* It had been tried, and
 * the OpenRouter account had run to zero — $5165.00 granted against $5165.04 used — and
 * nothing anywhere said so.
 */
describe("a tier whose fallback also failed", () => {
  it("names the twin and its reason, not just the primary", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, fallback: ["openrouter/twin"] } : t)),
    };
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    class BothOut implements ReviewerLike {
      async review(tier: Tier): Promise<ReviewerResult> {
        if (tier.model === primary) throw new Exhausted("the subscription is out for this billing cycle");
        if (tier.model === "openrouter/twin") throw new Exhausted("402: insufficient credit");
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }

    await runRound({ store, reviewer: new BothOut(), reviewId: "r1", principal: "p", worktree: dir, allowMetered: true, type });

    const notice = (store.tierRunsFor("r1").find((t) => t["tier"] === "t1")?.["unavailable"] ?? "") as string;
    expect(notice, "the primary's reason, as before").toContain("billing cycle");
    expect(notice, "AND the fallback was tried").toContain("openrouter/twin");
    expect(notice, "AND why it could not run either").toContain("insufficient credit");
  });
});

describe("a cool-off and a fallback together", () => {
  class Answers implements ReviewerLike {
    readonly asked: string[] = [];
    async review(tier: Tier): Promise<ReviewerResult> {
      this.asked.push(tier.model ?? "?");
      return { findings: [], discarded: [], raw: "", inputTokens: 7, cachedTokens: 0, outputTokens: 3, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
    }
  }

  it("asks the twin instead of skipping the tier", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, fallback: ["openrouter/twin"] } : t)),
    };
    // Probed a moment ago, so this round honours the cool-off and goes straight to the
    // twin — the D-94 probe is once per interval, not once per review.
    store.markTierUnavailable(
      "t1", new Date(Date.now() + 86_400_000).toISOString(), "the provider said so", 1, true,
      new Date().toISOString(),
    );
    const reviewer = new Answers();

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked, "the primary is never called; the twin is").toStrictEqual(["openrouter/twin"]);
    // AND THE SPEND IS ATTRIBUTED TO WHAT ANSWERED. This is the one table that says what
    // money went where, and naming a flat-subscription model that never ran would make it
    // useless exactly when it starts mattering.
    const u = store.db
      .prepare("SELECT model FROM usage WHERE review_id = 'r1' AND tier = 't1'")
      .get() as Record<string, string> | undefined;
    expect(u?.["model"]).toBe("openrouter/twin");
  });

  // A fallback that succeeds still LEARNED the reset time, and dropping it made every
  // later review re-pay the rediscovery.
  it("records the provider's reset time even though the round succeeded", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, fallback: ["openrouter/twin"] } : t)),
    };
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    // RELATIVE TO THE CLOCK THIS TEST ACTUALLY RUNS ON, because `runRound` reads the real
    // one. The first version pinned Z.ai's literal answer — "2026-08-10 18:19:09" — which
    // was in the future the day it was written and in the past the next morning. Once past,
    // `retryAt`'s floor clamp correctly returned now+60s and the assertion started failing:
    // a test that quietly changes what it asserts as the wall clock moves is the same
    // defect as a review that did not run, and it announced itself only by luck of timing.
    const reset = new Date(Date.now() + 86_400_000).toISOString();
    class OutWithTime implements ReviewerLike {
      async review(tier: Tier): Promise<ReviewerResult> {
        if (tier.model === primary) throw new Exhausted("out", reset);
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }

    await runRound({ store, reviewer: new OutWithTime(), reviewId: "r1", principal: "p", worktree: dir, type });

    const mark = store.tierUnavailable("t1");
    expect(mark?.until, "the next review skips straight to the twin").toBe(reset);
    expect(mark?.stated).toBe(true);
  });

  /**
   * THE PROBE SURVIVES THE REFUSAL IT DISCOVERED — which it did not, and D-94's whole
   * rate limit was void wherever a fallback was configured, which is every deployed tier.
   *
   * Raised by lore's own t1 against the D-94 commit. The probe stamps the mark before it
   * calls; the primary refuses; the fallback's catch rewrites the mark with five
   * arguments and no stamp. `shouldProbe` then reads "never probed" and the NEXT review
   * probes immediately — so a dead primary was asked once per review again, restored to
   * exactly the cost D-94 was written to bound while every test still passed.
   */
  it("does not let the refusal erase the probe that found it", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, fallback: ["openrouter/twin"] } : t)),
    };
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    class OutWithTime implements ReviewerLike {
      readonly asked: string[] = [];
      async review(tier: Tier): Promise<ReviewerResult> {
        this.asked.push(tier.model ?? "?");
        if (tier.model === primary) throw new Exhausted("out", new Date(Date.now() + 86_400_000).toISOString());
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }
    const reviewer = new OutWithTime();

    // Down, stated, and last probed 16 minutes ago — so this round is due one probe.
    store.markTierUnavailable(
      "t1", new Date(Date.now() + 86_400_000).toISOString(), "the provider said so", 1, true,
      new Date(Date.now() - 16 * 60_000).toISOString(),
    );

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });
    expect(reviewer.asked, "the probe happens, is refused, and the twin answers")
      .toStrictEqual([primary, "openrouter/twin"]);
    const after = store.tierUnavailable("t1");
    expect(after?.probedAt, "the stamp the probe wrote is still there").toBeDefined();

    // A SECOND REVIEW, not a second round: one round of r1 has already put t1 behind it,
    // and the mark is service-wide, so only a fresh ladder asks t1 again. That is also
    // the finding's own scenario — "Review B starts one minute later".
    store.createReview({
      id: "r2", repoId, principal: "p", branch: "feat/holds", intoRef: "main",
      ticket: "a second review, moments later", type: CODE_ARCH.id, state: "running",
      ladder: initialState(CODE_ARCH.tiers),
    });
    await runRound({ store, reviewer, reviewId: "r2", principal: "p", worktree: dir, type, allowMetered: true });
    expect(reviewer.asked, "which does NOT pay to ask the dead primary again")
      .toStrictEqual([primary, "openrouter/twin", "openrouter/twin"]);
  });
});

/**
/**
 * A METERED ROUTE IS ONE THE OPERATOR SWITCHED ON (D-117).
 *
 * The fallback chain is the exact line the 2026-08-16 incident walked through: the Kimi
 * subscription answered `403: you have reached your usage limit for this billing cycle`,
 * D-48 parked it, and the chain stepped onto `openrouter/moonshotai/kimi-k3` — the same
 * model, ~$4.83 a call, twenty-one calls, $101.36. Every rule involved behaved correctly.
 * Route health and route COST are different questions, and only the first was ever asked.
 *
 * A daily spend ceiling used to be what noticed, four hours and a hundred dollars later,
 * by stopping eight reviews on three other people's branches. It is gone (D-121); this is
 * what replaced it, and the difference that matters is WHEN: before the call, from the
 * route id, and never as a total.
 */
describe("a fallback that would walk onto a metered route", () => {
  const withFallback = (...fallback: string[]) => ({
    ...CODE_ARCH,
    t0: [] as const,
    tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, fallback } : t)),
  });

  /** Exhausts exactly the named routes, so a fixture never proves a broader claim. */
  class OutOn implements ReviewerLike {
    readonly asked: string[] = [];
    readonly dead: readonly string[];
    constructor(dead: readonly string[]) {
      this.dead = dead;
    }
    async review(tier: Tier): Promise<ReviewerResult> {
      this.asked.push(tier.model ?? "?");
      if (this.dead.includes(tier.model ?? "")) throw new Exhausted("plan is out");
      return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
    }
  }

  it("is not walked when nobody said lore may pay", async () => {
    const type = withFallback("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    const reviewer = new OutOn([primary]);

    let last;
    for (let i = 0; i < 8; i++) {
      last = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type }).catch(() => undefined);
      if (last === undefined || !["escalate", "fastClean"].includes(last.decision.kind)) break;
    }

    // THE MONEY WAS NEVER SPENT. Not "spent and then noticed" — the call did not happen.
    expect(reviewer.asked, "the twin is never asked").not.toContain("openrouter/twin");
    // AND THE LOSS IS SAID OUT LOUD, which is the half that keeps this honest: a tier that
    // did not run is named, so the verdict is the weaker claim rather than a quiet one.
    expect(store.getReview("r1", "p")?.ladder.unavailable ?? [], "t1 is skipped").toContain("t1");
    expect(last?.decision.kind, "and the review still reaches a verdict").toBe("passed");
  });

  it("is walked when the operator has bought that safety net", async () => {
    const type = withFallback("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    const reviewer = new OutOn([primary]);

    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked).toStrictEqual([primary, "openrouter/twin"]);
    // The tier RAN, so nothing is weakened — which is the deployment that deliberately
    // pays for a safety net getting the safety net it paid for.
    expect(store.getReview("r1", "p")?.ladder.unavailable ?? []).toStrictEqual([]);
    expect(["escalate", "fastClean"]).toContain(r.decision.kind);
  });

  /**
   * REFUSING THE METER IS NOT REFUSING THE CHAIN. Filtering the whole fallback list on
   * finding one metered entry would throw away the free routes beside it — turning a
   * money guard into a coverage loss nobody asked for, in the outage the chain exists for.
   */
  it("still walks to a free route standing beside the metered one", async () => {
    const type = withFallback("openrouter/twin", "zai-coding-plan2/glm-5.2");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    const reviewer = new OutOn([primary]);

    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });

    expect(reviewer.asked, "the meter is stepped over, not the chain").toStrictEqual([primary, "zai-coding-plan2/glm-5.2"]);
    expect(store.getReview("r1", "p")?.ladder.unavailable ?? []).toStrictEqual([]);
    expect(["escalate", "fastClean"]).toContain(r.decision.kind);
  });

  /**
   * A POOL MATE IS NOT "THE TIER'S OWN MODEL" — raised by t1 against this change (ccccf0db).
   *
   * The gate first covered the fallback chain only, exempting `member.model` on the
   * reasoning that naming a metered route IS the operator choosing it. A NICKNAME breaks
   * that reasoning: `routesFor` expands it to a pool and `poolOrder` shuffles, so a metered
   * pool mate becomes the unfiltered PRIMARY in some rounds — and in EVERY round once the
   * free routes are parked, which is exactly the 2026-08-16 shape. It would have falsified
   * the claim written into SPEC, TODO, MEMO and the compose file: at
   * `LORE_ALLOW_METERED=0`, no charging route is ever called.
   */
  describe("a pool with a metered route in it", () => {
    // GLM-5.2 AND NOT K3, and the difference is what makes this a valid config at all.
    // The finding's own example paired `kimi-for-coding/k3` with
    // `openrouter/moonshotai/kimi-k3`, which `loadTiers` REFUSES — a pool is several routes
    // to ONE model and those two last segments differ (`k3` vs `kimi-k3`). The hazard is
    // real anyway, and this is its reachable shape: `glm-5.2` on a Z.ai plan and on
    // OpenRouter is the same model by two routes, passes the pool check, and
    // `openrouter/z-ai/glm-5.2` is a route this deployment genuinely lists.
    const MIXED = JSON.stringify({
      models: { "GLM5.2": ["zai-coding-plan/glm-5.2", "openrouter/z-ai/glm-5.2"] },
      tiers: [
        { id: "t0", kind: "deterministic", stage: "fast" },
        { id: "t1", kind: "model", model: "GLM5.2", stage: "fast" },
      ],
    });
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env["LORE_TIERS"];
      process.env["LORE_TIERS"] = MIXED;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env["LORE_TIERS"];
      else process.env["LORE_TIERS"] = saved;
    });

    const pooled = { ...CODE_ARCH, t0: [] as const, tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "GLM5.2" } : t)) };

    // TWENTY FIRST ROUNDS, because `poolOrder` SHUFFLES: one round proves nothing about a
    // route picked at random, and a single-run assertion would pass half the time with the
    // gate removed. Twenty is ~1e-6 of passing by luck.
    //
    // A FRESH REVIEW EACH TIME, not twenty rounds of one. Twenty rounds walk the LADDER
    // forward — round 2 is the deep rung, not a second draw for t1 — so the loop would have
    // measured the shuffle once and the ladder nineteen times.
    // EXPLICIT TIMEOUT, because twenty real rounds cost ~5.1s and the default is 5s.
    // It failed on the clock rather than on the property — measured at 5063-5170ms across
    // runs, in isolation and in the full file alike. A test that fails for a reason
    // unrelated to what it guards gets disabled rather than fixed, and the twenty draws
    // are not negotiable: one draw proves nothing about a route picked at random.
    it("never runs the metered pool route as the primary", { timeout: 30_000 }, async () => {
      for (let i = 0; i < 20; i++) {
        const id = `rPool${String(i)}`;
        store.createReview({
          id, repoId, principal: "p", branch: "feat/holds", intoRef: "main",
          ticket: "one draw from the pool", type: CODE_ARCH.id, state: "running",
          ladder: initialState(CODE_ARCH.tiers),
        });
        const reviewer = new OutOn([]);
        await runRound({ store, reviewer, reviewId: id, principal: "p", worktree: dir, type: pooled });
        expect(reviewer.asked, "the free plan every time, never the twin").toStrictEqual(["zai-coding-plan/glm-5.2"]);
      }
    });

    /**
     * THE INCIDENT ITSELF, one layer in: the subscription is parked and only the metered
     * route is left in the pool. Before the fix this ran `openrouter/moonshotai/kimi-k3`
     * on EVERY round at ~$4.83 a call, under the setting documented as never paying.
     */
    it("skips the tier when the free plan is parked and only the metered route remains", async () => {
      store.markRouteUnavailable("zai-coding-plan/glm-5.2", new Date(Date.now() + 86_400_000).toISOString(), "billing cycle", 1, true);
      const reviewer = new OutOn([]);

      let last;
      for (let i = 0; i < 8; i++) {
        last = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: pooled }).catch(() => undefined);
        if (last === undefined || !["escalate", "fastClean"].includes(last.decision.kind)) break;
      }

      // T1'S POOL ROUTE, and only that. Tiers ABOVE t1 in this fixture are configured with
      // literal `openrouter/` models, which are exempt by design — naming one IS switching
      // it on. Asserting `asked` was empty would have failed on that deliberate exemption
      // and told me the gate was broken when it was working.
      expect(reviewer.asked, "t1's metered pool route was never bought").not.toContain("openrouter/z-ai/glm-5.2");
      expect(store.getReview("r1", "p")?.ladder.unavailable ?? [], "t1 is skipped instead").toContain("t1");
      expect(last?.decision.kind, "and the review still reaches a verdict").toBe("passed");
    });

    it("runs it when the operator has allowed metered routes", async () => {
      store.markRouteUnavailable("zai-coding-plan/glm-5.2", new Date(Date.now() + 86_400_000).toISOString(), "billing cycle", 1, true);
      const reviewer = new OutOn([]);

      await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: pooled, allowMetered: true });

      expect(reviewer.asked, "the twin answers, because it was bought on purpose").toStrictEqual(["openrouter/z-ai/glm-5.2"]);
    });

    /**
     * A FAILED PRIMARY IS STILL A PAID PRIMARY, when the primary itself is the pool's
     * metered member and there is no fallback to walk (found by lore's own review,
     * fingerprint 39b5b427). f65306a0 moved this tier's own usage recording earlier,
     * into the primary's own catch, and cleared `.spent` there so the outer catch would
     * not double-record it — but the outer catch's paid-route alert lived inside that
     * same `if (spent !== undefined)` block, and clearing `.spent` silently disarmed it
     * for exactly this shape.
     */
    it("still alerts when a metered primary dies with no fallback to walk", async () => {
      store.markRouteUnavailable("zai-coding-plan/glm-5.2", new Date(Date.now() + 86_400_000).toISOString(), "billing cycle", 1, true);
      const sent: { condition: string; detail: string; severity: string }[] = [];
      const alerter = {
        send: (x: { condition: string; detail: string; severity: string }) => {
          sent.push(x);
          return Promise.resolve(true);
        },
      };
      class DiesWithSpend implements ReviewerLike {
        async review(): Promise<ReviewerResult> {
          const e = new Error("provider dropped the connection") as Error & {
            spent?: { input: number; cached: number; output: number; cost: number };
          };
          e.spent = { input: 400, cached: 0, output: 40, cost: 0.11 };
          throw e;
        }
      }

      await runRound({
        store, reviewer: new DiesWithSpend(), reviewId: "r1", principal: "p", worktree: dir,
        type: pooled, allowMetered: true, alerter,
      }).catch(() => undefined);

      const row = store.db
        .prepare("SELECT model, input_tokens i, cost_usd c FROM usage WHERE review_id='r1' AND tier='t1'")
        .get() as Record<string, string | number> | undefined;
      expect(row?.["model"], "the metered pool route, the only one available").toBe("openrouter/z-ai/glm-5.2");
      expect(row?.["i"], "the primary's own spend, recorded").toBe(400);
      expect(row?.["c"]).toBeCloseTo(0.11);

      expect(sent, "a paid route was reached and must still be reported").toHaveLength(1);
      expect(sent[0]?.detail).toContain("openrouter/z-ai/glm-5.2");
    });
  });

  /**
   * LORE SAYS IT HAS STARTED PAYING — once a day, to a person (D-117).
   *
   * The per-call figure went to stderr and nowhere else, which is read by somebody already
   * looking; during the four hours of 2026-08-16 that cost $101.36, nobody was. An EVENT,
   * not a threshold: no total is consulted, so D-121 is untouched.
   */
  describe("the notice that a paid route is answering", () => {
    // T1'S OWN MODEL MUST BE A SUBSCRIPTION HERE, or there is no event to report: the
    // suite's ladder is all `openrouter/` literals, which `exemptLiteral` correctly treats
    // as the operator's own paid choice and which therefore suppress this notice. The
    // event is lore reaching a paid route BECAUSE something broke, so the fixture has to
    // have something to break.
    const withFallback2 = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) =>
        t.id === "t1" ? { ...t, model: "zai-coding-plan/glm-5.3", fallback: ["openrouter/twin"] } : t,
      ),
    };
    const primaryOf = () => withFallback2.tiers.find((t) => t.id === "t1")?.model ?? "";

    /** Records what would have been sent, and never touches the network. */
    const spy = () => {
      const sent: { condition: string; detail: string; severity: string }[] = [];
      return { sent, send: (a: { condition: string; detail: string; severity: string }) => { sent.push(a); return Promise.resolve(true); } };
    };

    it("tickets the first paid call, naming the route and what it cost", async () => {
      const a = spy();
      class Paid implements ReviewerLike {
        async review(tier: Tier): Promise<ReviewerResult> {
          if (tier.model === primaryOf()) throw new Exhausted("plan is out");
          return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 4.83, latencyMs: 1, retried: false, steps: 1 };
        }
      }

      await runRound({ store, reviewer: new Paid(), reviewId: "r1", principal: "p", worktree: dir, type: withFallback2, allowMetered: true, alerter: a });

      expect(a.sent).toHaveLength(1);
      expect(a.sent[0]?.severity, "nothing is broken; a person should know").toBe("ticket");
      expect(a.sent[0]?.detail).toContain("openrouter/twin");
      expect(a.sent[0]?.detail, "the figure a decision is made on").toContain("4.83");
    });

    // ONCE A DAY, and the latch is the whole point: a message about money said on every
    // round is one an operator learns to skip, which is the failure mode of the channel
    // rather than of the code.
    it("says it once a day however many rounds pay", async () => {
      const a = spy();
      class Paid implements ReviewerLike {
        async review(tier: Tier): Promise<ReviewerResult> {
          if (tier.model === primaryOf()) throw new Exhausted("plan is out");
          return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 4.83, latencyMs: 1, retried: false, steps: 1 };
        }
      }
      const reviewer = new Paid();
      for (const id of ["r1", "r1", "r1"]) {
        await runRound({ store, reviewer, reviewId: id, principal: "p", worktree: dir, type: withFallback2, allowMetered: true, alerter: a }).catch(() => undefined);
      }
      expect(a.sent, "three rounds, one notice").toHaveLength(1);
    });

    /**
     * A COIN TOSS IS NOT AN INCIDENT, and it must not eat the day's alarm.
     *
     * A metered member of a pool can be `pool[0]` by shuffle with every free sibling
     * healthy — the operator put it there and allowed metered, so that is their
     * arrangement working. Alerting on it consumed the single daily notice, so a REAL
     * exhaustion hours later was silent: the benign case eating the alarm meant for the
     * dangerous one. Fixing the alert's WORDING did not fix that; the condition had to.
     */
    // Same clock, same reason as the twenty-draw test above.
    it("says nothing when a free sibling was available and the shuffle picked the paid one", { timeout: 30_000 }, async () => {
      const a = spy();
      const MIXED = JSON.stringify({
        models: { GLM: ["zai-coding-plan/glm-5.2", "openrouter/z-ai/glm-5.2"] },
        tiers: [
          { id: "t0", kind: "deterministic", stage: "fast" },
          { id: "t1", kind: "model", model: "GLM", stage: "fast" },
        ],
      });
      const saved = process.env["LORE_TIERS"];
      process.env["LORE_TIERS"] = MIXED;
      try {
        const pooled = { ...CODE_ARCH, t0: [] as const, tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "GLM" } : t)) };
        class Answers3 implements ReviewerLike {
          async review(): Promise<ReviewerResult> {
            return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 4.83, latencyMs: 1, retried: false, steps: 1 };
          }
        }
        // TWENTY DRAWS, because the shuffle decides which route is picked: one run proves
        // nothing about a condition that only fires on half of them.
        for (let i = 0; i < 20; i++) {
          const id = `rPick${String(i)}`;
          store.createReview({
            id, repoId, principal: "p", branch: "feat/holds", intoRef: "main",
            ticket: "one draw", type: CODE_ARCH.id, state: "running", ladder: initialState(CODE_ARCH.tiers),
          });
          await runRound({ store, reviewer: new Answers3(), reviewId: id, principal: "p", worktree: dir, type: pooled, allowMetered: true, alerter: a });
        }
        expect(a.sent, "a healthy pool picking its paid member is not news").toStrictEqual([]);
      } finally {
        if (saved === undefined) delete process.env["LORE_TIERS"];
        else process.env["LORE_TIERS"] = saved;
      }
    });

    // A DEPLOYMENT THAT CONFIGURED A PAID MODEL IS NOT SURPRISED BY IT. Ticketing that
    // daily would be telling an operator their own configuration is working.
    it("says nothing when the tier's own configured model is the paid one", async () => {
      const a = spy();
      const literal = { ...CODE_ARCH, t0: [] as const, tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "openrouter/chosen" } : t)) };
      class Answers2 implements ReviewerLike {
        async review(): Promise<ReviewerResult> {
          return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 4.83, latencyMs: 1, retried: false, steps: 1 };
        }
      }

      await runRound({ store, reviewer: new Answers2(), reviewId: "r1", principal: "p", worktree: dir, type: literal, alerter: a });

      expect(a.sent, "chosen, immediate, and not news").toStrictEqual([]);
    });
  });

  /**
   * A TIER'S OWN MODEL IS NEVER FILTERED, however metered it is.
   *
   * Naming `openrouter/x` as the model IS the operator switching it on: it runs every
   * round, and its cost is chosen and immediate. A fallback is CONDITIONAL — insurance,
   * invisible until a subscription dies, then billing every call for as long as the
   * outage lasts. Identical config; only one of them can surprise somebody.
   */
  it("does not refuse a metered route the tier is configured to use", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "openrouter/chosen" } : t)),
    };
    const reviewer = new OutOn([]);

    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });

    expect(reviewer.asked, "the configured model runs, metered or not").toContain("openrouter/chosen");
    expect(["escalate", "fastClean"]).toContain(r.decision.kind);
  });
});

/**
 * WHEN A TIER HAS BOTH `skip_if_quota` AND a `fallback`, the fallback wins.
 *
 * Vany: *"if we have both, fallback must win, and if it has no quota even in fallback —
 * it must be skipped."* Both flags answer the same question — what to do when this plan
 * is out — and the order between them is the whole of their meaning: skipping first would
 * mean a paid twin sitting configured and never asked, which is D-93 bought and not used.
 *
 * Every deployed tiers file sets both on t1, so this is the live arrangement rather than
 * a hypothetical one.
 */
/**
 * A REUSED t0 IS RECORDED AS REUSED, NEVER AS CLEAN (D-102).
 *
 * D-92 skips t0 when the tree and the engine set are unchanged — right, and it produces
 * zero findings, so the row was closed as `clean`. That is a check which did not run,
 * written into the audit trail as a check that found nothing: INV-1, in the one table that
 * exists to say whether a review really ran. The board then rendered it as
 * `t0 · round 2 · 0s · clean · raised nothing`, a stronger claim than the database made.
 *
 * Vany asked why there was a t0 round 2 at all, which is how it surfaced.
 */
describe("a reused t0 says so", () => {
  it("records `reused` rather than `clean` when it did not run", async () => {
    const type = { ...CODE_ARCH, t0: ["tsc"] as const };
    const reviewer = new ScriptedReviewer([[], []]);

    // Round 1 runs t0 for real; round 2 follows an escalation, so the tree is identical.
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });

    const t0s = store.tierRunsFor("r1").filter((t) => t["tier"] === "t0");
    expect(t0s.length, "t0 opens a row every round").toBeGreaterThan(1);
    // Whatever the sweep FOUND is not this test's business — only that it swept, and
    // that the second round did not pretend to.
    expect(t0s[0]?.["outcome"], "the round that actually swept").not.toBe("reused");
    expect(t0s[1]?.["outcome"], "the round that did not").toBe("reused");
  }, 60_000);

  // It LOOKED, in an earlier round, at these exact bytes — so it must not be counted
  // among the tiers that missed the code, or every verdict resting on it weakens for
  // nothing.
  it("still counts as having read the tree", async () => {
    const type = { ...CODE_ARCH, t0: ["tsc"] as const };
    const reviewer = new ScriptedReviewer([[], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });

    expect(store.tierFailureCount("r1", "t0"), "a reuse is not a miss").toBe(0);
  }, 60_000);
});

/**
 * A TIER'S MODEL MAY NAME A POOL — several subscriptions reaching one model (D-93).
 *
 * Twice the quota and one opinion. The pool is tried in a random order because nothing
 * publishes how much of a subscription is left, and the choice is then KEPT: re-rolling
 * each round would hand a kept session (D-80) a different model to continue.
 */
describe("a pool of routes to one model", () => {
  const POOL = JSON.stringify({
    models: { "GLM5.2": ["zai-coding-plan/glm-5.2", "zai-coding-plan2/glm-5.2"] },
    tiers: [{ id: "t0", kind: "deterministic", stage: "fast" }, { id: "t1", kind: "model", model: "GLM5.2", stage: "fast" }],
  });

  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["LORE_TIERS"];
    process.env["LORE_TIERS"] = POOL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["LORE_TIERS"];
    else process.env["LORE_TIERS"] = saved;
  });

  const nicknamed = (fallback: string[] = []) => ({
    ...CODE_ARCH,
    t0: [] as const,
    tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "GLM5.2", fallback } : t)),
  });

  /** Answers on anything, recording which route it was asked as. */
  class Answers implements ReviewerLike {
    readonly asked: string[] = [];
    private readonly refuse: Set<string>;
    constructor(refuse: readonly string[] = []) {
      this.refuse = new Set(refuse);
    }
    async review(tier: Tier): Promise<ReviewerResult> {
      this.asked.push(tier.model ?? "?");
      if (this.refuse.has(tier.model ?? "")) throw new Exhausted(`tier ${tier.id} refused on quota`);
      return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
    }
  }

  it("asks one of the pool's routes, not the nickname", async () => {
    const reviewer = new Answers();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: nicknamed() });

    expect(reviewer.asked).toHaveLength(1);
    expect(
      ["zai-coding-plan/glm-5.2", "zai-coding-plan2/glm-5.2"],
      "a nickname is not a model id and must never reach opencode",
    ).toContain(reviewer.asked[0]);
  });

  /**
   * THE CHOICE IS KEPT. Whichever route the first round rolled, the second uses THAT one
   * — which is the property a kept session depends on, and it holds however the coin
   * lands, so this test does not need to control the randomness.
   */
  it("keeps the route it chose for the next round", async () => {
    // RAISING SOMETHING KEEPS THE LADDER ON t1. A clean round escalates, and the second
    // round would then be a different tier entirely — which is what this test asked
    // about the first time it was written, and it was measuring the wrong thing.
    class Raises extends Answers {
      private n = 0;
      override async review(tier: Tier): Promise<ReviewerResult> {
        const out = await super.review(tier);
        this.n += 1;
        return this.n === 1 ? { ...out, findings: [HOLD_BUG] } : out;
      }
    }
    const reviewer = new Raises();
    const type = nicknamed();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked).toHaveLength(2);
    expect(reviewer.asked[1], "re-rolling would give a kept session a different model").toBe(reviewer.asked[0]);
  });

  it("tries the rest of the pool when the first route is out of quota", async () => {
    const reviewer = new Answers(["zai-coding-plan/glm-5.2"]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: nicknamed() });

    // Whatever order was rolled, the survivor answered and both were asked if needed.
    expect(reviewer.asked).toContain("zai-coding-plan2/glm-5.2");
    expect(reviewer.asked.at(-1)).toBe("zai-coding-plan2/glm-5.2");
  });

  /**
   * A POOL ROUTE IS NOT A FALLBACK. `fell_back_to` reaches the client as "this tier was
   * answered by somebody else, and it cost money" — true of a configured fallback, false
   * of a second subscription to the same plan, which is the model the tier was always
   * going to use.
   */
  it("does not report a pool pick as having fallen back", async () => {
    // PINNED, NOT ROLLED. Seeding the kept choice with the route that will refuse forces
    // the spare to answer through the walk — the path where a pool pick could be
    // mislabelled. Left to the coin, this test exercised that path half the time and
    // passed either way, which is a test that reports success for work it did not do.
    const ladder = { ...initialState(CODE_ARCH.tiers), answeredBy: { t1: "zai-coding-plan/glm-5.2" } };
    store.db.prepare("UPDATE review SET ladder = ? WHERE id = 'r1'").run(JSON.stringify(ladder));

    const reviewer = new Answers(["zai-coding-plan/glm-5.2"]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: nicknamed() });

    expect(reviewer.asked, "the kept route first, then the rest of the pool").toStrictEqual([
      "zai-coding-plan/glm-5.2",
      "zai-coding-plan2/glm-5.2",
    ]);
    const note = String(
      (store.db.prepare("SELECT unavailable FROM tier_run WHERE review_id='r1' AND tier='t1' ORDER BY id DESC LIMIT 1").get() as
        | Record<string, string>
        | undefined)?.["unavailable"] ?? "",
    );
    expect(note, "a second subscription to the same plan is not a concession").not.toContain("was answered by");
  });

  it("falls to the configured fallback only once the whole pool is out", async () => {
    const reviewer = new Answers(["zai-coding-plan/glm-5.2", "zai-coding-plan2/glm-5.2"]);
    await runRound({
      store, reviewer, reviewId: "r1", principal: "p", worktree: dir, allowMetered: true,
      type: nicknamed(["openrouter/z-ai/glm-5.2"]),
    });

    expect(reviewer.asked, "both plans first, the metered twin last").toStrictEqual([
      ...reviewer.asked.slice(0, 2),
      "openrouter/z-ai/glm-5.2",
    ]);
    expect(reviewer.asked.slice(0, 2).sort()).toStrictEqual([
      "zai-coding-plan/glm-5.2",
      "zai-coding-plan2/glm-5.2",
    ]);
  });

  /**
   * A REFUSAL IS LEARNED, AND KEPT AGAINST THE ROUTE.
   *
   * Two plans behind one tier have independent quota, so recording "t1 is out" would
   * either strike out the plan that is fine or keep asking the one that is empty.
   */
  it("remembers which route refused, and when the provider says it returns", async () => {
    // Six hours out: inside the cap `retryAt` clamps a stated reset to, so the time the
    // provider named survives intact. A claim of a century would be clamped, correctly —
    // a provider must not be able to strike a paid-for route out for a year.
    const RESET = new Date(Date.now() + 6 * 3_600_000).toISOString();
    class OutUntil implements ReviewerLike {
      readonly asked: string[] = [];
      async review(tier: Tier): Promise<ReviewerResult> {
        this.asked.push(tier.model ?? "?");
        if (tier.model === "zai-coding-plan/glm-5.2") throw new Exhausted("out of quota", RESET);
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }
    // PINNED, so the route that refuses is certainly asked. Left to the shuffle this test
    // passed or failed on a coin toss — and passing because the failing route was never
    // tried is a test reporting success for work it did not do.
    const ladder = { ...initialState(CODE_ARCH.tiers), answeredBy: { t1: "zai-coding-plan/glm-5.2" } };
    store.db.prepare("UPDATE review SET ladder = ? WHERE id = 'r1'").run(JSON.stringify(ladder));

    const reviewer = new OutUntil();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: nicknamed() });

    const out = store.routeUnavailable("zai-coding-plan/glm-5.2");
    expect(out?.stated, "the provider named the time, so it is evidence and not a guess").toBe(true);
    expect(out?.until).toBe(RESET);
    // The route that answered is not marked, and a route nobody asked is not either.
    expect(store.routeUnavailable("zai-coding-plan2/glm-5.2")).toBeUndefined();
  });

  /**
   * AND IT IS NOT ASKED AGAIN UNTIL THEN. Spending a call to be told a second time what
   * the provider already told us is the cost this memory exists to avoid — D-90's rule,
   * which until now only tiers could benefit from.
   */
  it("does not ask a route again before the time it named", async () => {
    store.markRouteUnavailable("zai-coding-plan/glm-5.2", "2126-01-01T00:00:00.000Z", "out of quota", 1, true);
    const reviewer = new Answers();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: nicknamed() });

    expect(reviewer.asked).toStrictEqual(["zai-coding-plan2/glm-5.2"]);
  });

  /**
   * ONE SUCCESS CLEARS IT. A stale mark is a subscription lore has stopped using for
   * nothing, and "one success clears this" has to hold for a route as it does for a tier.
   */
  it("forgets the mark as soon as that route answers", async () => {
    store.markRouteUnavailable("zai-coding-plan2/glm-5.2", "2026-01-01T00:00:00.000Z", "was out", 1, true);
    const reviewer = new Answers();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: nicknamed() });

    // Its reset is long past, so it is asked again — and answering clears the record.
    if (reviewer.asked.includes("zai-coding-plan2/glm-5.2")) {
      expect(store.routeUnavailable("zai-coding-plan2/glm-5.2")).toBeUndefined();
    }
  });

  /**
   * A PARKED ROUTE IS NOT ASKED AT ALL — Vany: *"I do not want a regular check for quota
   * if nothing happens."* The day he said it, both kimi routes were marked out with
   * `stated: false`, and every t2 round still burned two refused calls before landing on
   * the super fallback, because a guessed mark could not skip anything.
   */
  /**
   * A BACKOFF LORE GUESSED IS RE-TESTED; ONE A PROVIDER STATED IS NOT (D-94, widened to
   * routes 2026-08-17).
   *
   * `shouldProbe` was only ever asked about the TIER mark — and both outages this service
   * actually has are ROUTE marks, so nothing re-tested them. Measured the morning it was
   * found: `openai/gpt-5.6-terra` parked at a GUESSED 19:18Z, last asked at 00:46Z eleven
   * hours earlier, while t3 answered on Z.ai and every verdict came back `passed_partial`
   * for a vendor collapse that no longer had to exist.
   *
   * The trade is twelve seconds (D-91 makes a refusal arrive fast) against a whole vendor.
   */
  it("re-tests a route parked on lore's own guess, and keeps it if it answers", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "kimi/k3", fallback: ["GLM5.2"] } : t)),
    };
    // `stated: false` — a doubling backoff lore invented, reaching into 2126.
    store.markRouteUnavailable("kimi/k3", "2126-01-01T00:00:00.000Z", "out of quota", 3, false);
    const reviewer = new Answers();

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked, "the guess is questioned rather than obeyed").toContain("kimi/k3");
    // ONE SUCCESS CLEARS IT, so the next round does not probe at all — the route is simply
    // back, which is the whole point of asking.
    expect(store.routeUnavailable("kimi/k3"), "and it is no longer parked").toBeUndefined();
  });

  // A STATED RESET IS THE PROVIDER TELLING US SOMETHING TRUE (D-91). Probing it would be
  // re-asking a question already answered, which is the cost Vany refused: *"I do not want
  // a regular check for quota if nothing happens."*
  it("does not re-test a route whose reset the provider stated", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "kimi/k3", fallback: ["GLM5.2"] } : t)),
    };
    store.markRouteUnavailable("kimi/k3", "2126-01-01T00:00:00.000Z", "billing cycle", 3, true);
    const reviewer = new Answers();

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked, "the provider's word is taken").not.toContain("kimi/k3");
  });

  // AND NOT ON EVERY ROUND. The probe is bounded by PROBE_INTERVAL_MS exactly as the
  // per-tier one is: a route that refuses again is stamped and left alone, which is what
  // stops this becoming the per-round re-ask that was measured burning two calls a round
  // to learn nothing.
  it("probes a still-dead route once, not on every round", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "kimi/k3", fallback: ["GLM5.2"] } : t)),
    };
    store.markRouteUnavailable("kimi/k3", "2126-01-01T00:00:00.000Z", "out of quota", 3, false);
    const reviewer = new Answers(["kimi/k3"]);

    // FRESH REVIEWS, not three rounds of one. The first version reused `r1`, whose ladder
    // simply advanced past t1 — so rounds two and three never reached the parked route and
    // the test passed without exercising the bound at all. It went green against a build
    // that re-probed on EVERY round, and the live deployment is what caught that.
    for (let i = 0; i < 3; i++) {
      const id = `rProbe${String(i)}`;
      store.createReview({
        id, repoId, principal: "p", branch: "feat/holds", intoRef: "main",
        ticket: "one look at a dead route", type: CODE_ARCH.id, state: "running",
        ladder: initialState(CODE_ARCH.tiers),
      });
      await runRound({ store, reviewer, reviewId: id, principal: "p", worktree: dir, type, allowMetered: true }).catch(
        () => undefined,
      );
    }

    expect(reviewer.asked.filter((m) => m === "kimi/k3"), "asked once across three reviews").toHaveLength(1);
    // AND THE STAMP SURVIVED THE REFUSAL THAT DISCOVERED IT, which is the mechanism the
    // bound rests on: the catch rewrites the mark, and a write that does not name a stamp
    // must keep the stored one.
    expect(store.routeUnavailable("kimi/k3")?.probedAt, "the probe is remembered").toBeDefined();
  });

  /**
   * A PROBE THAT GOES QUIET LEARNS NOTHING (D-138).
   *
   * Kimi's real weekly-quota refusal on 2026-08-31 took ~21.5 minutes to arrive on a
   * single, silent call — bounded now by `opencode.ts`'s own `probeTimeoutMs`, which
   * surfaces here as `ProbeInconclusive`. What THIS round has to get right: the existing
   * mark must come through unread, not overwritten with a generic timeout reason and a
   * failure count that climbed on a non-answer, and the chain must still walk to the
   * fallback exactly as it would for a real refusal.
   */
  it("leaves an existing route mark untouched when its probe is inconclusive", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "kimi/k3", fallback: ["GLM5.2"] } : t)),
    };
    store.markRouteUnavailable(
      "kimi/k3", "2126-01-01T00:00:00.000Z", "You've reached your weekly usage limit", 3, false,
    );
    class ProbeTimesOut implements ReviewerLike {
      readonly asked: { model: string; probing: boolean | undefined }[] = [];
      async review(
        tier: Tier,
        _prompt: unknown,
        _worktree: string,
        _reviewId?: string,
        _stillWanted?: () => boolean,
        probing?: boolean,
      ): Promise<ReviewerResult> {
        this.asked.push({ model: tier.model ?? "?", probing });
        if (tier.model === "kimi/k3") throw new ProbeInconclusive(`tier ${tier.id} probe did not answer in time`);
        return {
          findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0,
          latencyMs: 1, retried: false, steps: 1,
        };
      }
    }
    const reviewer = new ProbeTimesOut();

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked.find((a) => a.model === "kimi/k3")?.probing, "asked BECAUSE it was due a probe").toBe(true);
    expect(
      reviewer.asked.some((a) => a.model === "zai-coding-plan/glm-5.2" || a.model === "zai-coding-plan2/glm-5.2"),
      "the chain still walks to the fallback pool",
    ).toBe(true);
    const mark = store.routeUnavailable("kimi/k3");
    expect(mark?.why, "unchanged — a probe that went quiet learned nothing new").toBe(
      "You've reached your weekly usage limit",
    );
    expect(mark?.failures, "the failure count must not climb on a non-answer").toBe(3);
    expect(mark?.probedAt, "only the probe stamp may move").toBeDefined();
  });

  it("goes straight past a lone primary inside its backoff, without calling it", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "kimi/k3", fallback: ["GLM5.2"] } : t)),
    };
    store.markRouteUnavailable("kimi/k3", "2126-01-01T00:00:00.000Z", "out of quota", 3, true);
    const reviewer = new Answers();
    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked, "the refused route is not re-confirmed").not.toContain("kimi/k3");
    expect(reviewer.asked[0], "the fallback still runs").toMatch(/^zai-coding-plan2?\/glm-5\.2$/);
    expect(r.decision.kind).not.toBe("stopped");
  });

  it("does not re-ask a marked fallback route either", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) =>
        t.id === "t1" ? { ...t, model: "kimi/k3", fallback: ["openrouter/moonshotai/kimi-k3", "GLM5.2"] } : t,
      ),
    };
    store.markRouteUnavailable("kimi/k3", "2126-01-01T00:00:00.000Z", "out", 3, true);
    store.markRouteUnavailable("openrouter/moonshotai/kimi-k3", "2126-01-01T00:00:00.000Z", "out", 3, true);
    const reviewer = new Answers();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked, "both marked routes stay unasked").toStrictEqual([reviewer.asked[0]]);
    expect(reviewer.asked[0]).toMatch(/^zai-coding-plan2?\/glm-5\.2$/);
  });

  /**
   * WHEN EVERYTHING IS PARKED, THE TIER IS SKIPPED WITH A TIME — the same outcome as
   * calling every route and being refused by every route, minus the calls (INV-1: the
   * record still says the tier did not look).
   */
  it("skips the tier without one call when every route is inside its backoff", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      // A SECOND, TRIVIAL TIER, NEVER ACTUALLY CALLED — found while fixing 61df6e72:
      // `CODE_ARCH.tiers` is no longer a frozen import-time snapshot (a plain field)
      // but a live getter reading the CURRENT LORE_TIERS (`POOL`, two tiers only,
      // set in this describe's own `beforeEach`) — correctly, since a getter is
      // indistinguishable from a plain property to every reader, `type.tiers.map(...)`
      // now maps over `POOL`'s real two tiers instead of an unrelated 4-tier default
      // this test never asked for. Measured directly: `runRound` needs SOMETHING
      // after the exhausted t1 to conclude with a weaker verdict (`fastClean`) rather
      // than throwing `Exhausted` uncaught — `t2` here is never itself asked
      // (`reviewer.asked` stays `[]` either way), so this is not escalation, only
      // the ladder having a rung beyond the one that was skipped.
      tiers: [
        ...CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "GLM5.2", fallback: [] } : t)),
        { id: "t2", kind: "model" as const, model: "unused/never-asked", stage: "deep" as const },
      ],
    };
    store.markRouteUnavailable("zai-coding-plan/glm-5.2", "2126-01-01T00:00:00.000Z", "out", 3, true);
    store.markRouteUnavailable("zai-coding-plan2/glm-5.2", "2126-01-01T00:00:00.000Z", "out", 3, true);
    const reviewer = new Answers();
    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked, "no call spent re-confirming a parked route").toStrictEqual([]);
    expect(r.decision.kind, "skipped and promoted, not failed").not.toBe("stopped");
    const note = String(
      (store.db.prepare("SELECT unavailable FROM tier_run WHERE review_id='r1' AND tier='t1' ORDER BY id DESC LIMIT 1").get() as
        | Record<string, string>
        | undefined)?.["unavailable"] ?? "",
    );
    expect(note, "and the record names when it comes back").toContain("2126-01-01");
  });

  /**
   * THE CHOSEN FALLBACK ROUTE IS KEPT TOO — Vany's rule has no exception clause: *"if a
   * model is chosen, use it."* The first version shuffled the fallback pool fresh every
   * round, and for a tier living on its super fallback that is a new model instance per
   * round: observed on rev_zbFO, t2's findings were raised by plan1's session and the
   * fixes judged by a cold plan2 session.
   */
  it("keeps the fallback route it chose, on the next round", async () => {
    // FOUR ROUTES AND TWO ROUNDS, so a shuffle cannot pass this by luck. The first
    // version used the two-route pool and one round: with stickiness deleted it still
    // passed every second run, which is a test reporting success for work it did not do.
    process.env["LORE_TIERS"] = JSON.stringify({
      models: { "GLM5.2": ["zp1/glm-5.2", "zp2/glm-5.2", "zp3/glm-5.2", "zp4/glm-5.2"] },
      tiers: [{ id: "t0", kind: "deterministic", stage: "fast" }, { id: "t1", kind: "model", model: "GLM5.2", stage: "fast" }],
    });
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "kimi/k3", fallback: ["GLM5.2"] } : t)),
    };
    store.markRouteUnavailable("kimi/k3", "2126-01-01T00:00:00.000Z", "out", 3, true);
    // The previous round settled on zp3 — the roll must not happen again, this round or next.
    const ladder = { ...initialState(CODE_ARCH.tiers), answeredBy: { t1: "zp3/glm-5.2" } };
    store.db.prepare("UPDATE review SET ladder = ? WHERE id = 'r1'").run(JSON.stringify(ladder));

    // Raising on the first round keeps the ladder on t1, so the second round is the same
    // tier walking the same chain — the case stickiness exists for.
    class Raises extends Answers {
      private n = 0;
      override async review(tier: Tier): Promise<ReviewerResult> {
        const out = await super.review(tier);
        this.n += 1;
        return this.n === 1 ? { ...out, findings: [HOLD_BUG] } : out;
      }
    }
    const reviewer = new Raises();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked, "the kept route both rounds, never a re-roll").toStrictEqual([
      "zp3/glm-5.2",
      "zp3/glm-5.2",
    ]);
  });

  /** `usage.model` names the route that ran — the nickname makes per-plan spend untraceable. */
  it("records the concrete route in usage, never the nickname", async () => {
    const reviewer = new Answers();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: nicknamed() });

    const row = store.db.prepare("SELECT model FROM usage WHERE review_id='r1' ORDER BY id DESC LIMIT 1").get() as
      | Record<string, string>
      | undefined;
    expect(String(row?.["model"])).toMatch(/^zai-coding-plan2?\/glm-5\.2$/);
  });

  /**
   * THE PROBE OUTRANKS THE PARKING (D-94 over the route filter). A probing round exists
   * to reach a provider we believe is down — filtered by that same belief, lore could
   * never again learn that anything recovered before its backoff ran out.
   */
  it("still probes a parked route when the tier's probe interval has passed", async () => {
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "kimi/k3", fallback: ["GLM5.2"] } : t)),
    };
    // The tier is in a stated cool-off whose last probe is ancient, so this round IS the
    // probe — and the route's own mark must not veto it.
    store.markTierUnavailable("t1", "2126-01-01T00:00:00.000Z", "provider said out", 1, true, "2020-01-01T00:00:00.000Z");
    store.markRouteUnavailable("kimi/k3", "2126-01-01T00:00:00.000Z", "out", 3, false);
    const reviewer = new Answers();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked[0], "the probe reached the provider").toBe("kimi/k3");
  });

  /**
   * A NICKNAME IN THE FALLBACK LIST EXPANDS TOO.
   *
   * The deployed ladder names `GLM5.2` as the last resort for both deep tiers, which is
   * the pool — so unexpanded it would reach opencode as a model id and be refused for not
   * being `provider/model`: a configuration error found in the middle of a review.
   */
  it("expands a pool named as a fallback into its routes", async () => {
    const bothOut = ["kimi/k3"];
    class KimiOut implements ReviewerLike {
      readonly asked: string[] = [];
      async review(tier: Tier): Promise<ReviewerResult> {
        this.asked.push(tier.model ?? "?");
        if (bothOut.includes(tier.model ?? "")) throw new Exhausted("out of quota");
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }
    const type = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, model: "kimi/k3", fallback: ["GLM5.2"] } : t)),
    };
    const reviewer = new KimiOut();
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked[0]).toBe("kimi/k3");
    expect(reviewer.asked[1], "the nickname resolved to a real route").toMatch(/^zai-coding-plan2?\/glm-5\.2$/);
    expect(reviewer.asked, "never the nickname itself").not.toContain("GLM5.2");
  });

  /** WHEN NOTHING IS LEFT, SAY SO, and name every route that refused (D-105, INV-1). */
  it("names every route when the pool and the fallbacks are all out", async () => {
    const reviewer = new Answers([
      "zai-coding-plan/glm-5.2",
      "zai-coding-plan2/glm-5.2",
      "openrouter/z-ai/glm-5.2",
    ]);
    // A SECOND, TRIVIAL TIER BESIDE `nicknamed()`'s OWN — same reasoning as the
    // backoff test above, found fixing 61df6e72: `nicknamed()` maps over
    // `CODE_ARCH.tiers`, now a live getter reading `POOL` (two tiers), not a frozen
    // 4-tier snapshot this test never asked for. `runRound` needs a rung beyond the
    // one being exhausted to conclude with a decision rather than throwing —
    // confirmed the extra tier is never itself asked.
    const base = nicknamed(["openrouter/z-ai/glm-5.2"]);
    const type = {
      ...base,
      tiers: [...base.tiers, { id: "t2", kind: "model" as const, model: "unused/never-asked", stage: "deep" as const }],
    };
    const r = await runRound({
      store, reviewer, reviewId: "r1", principal: "p", worktree: dir, allowMetered: true,
      type,
    });

    // The tier was stepped over (D-48), so the account of WHY is on its run rather than in
    // the decision — and that account has to name every route, or a reader concludes the
    // fallback was never tried.
    expect(r.decision.kind, "an unpayable tier does not fail the review").not.toBe("stopped");
    const note = String(
      (store.db.prepare("SELECT unavailable FROM tier_run WHERE review_id='r1' AND tier='t1' ORDER BY id DESC LIMIT 1").get() as
        | Record<string, string>
        | undefined)?.["unavailable"] ?? "",
    );
    expect(note).toContain("zai-coding-plan2/glm-5.2");
    expect(note).toContain("openrouter/z-ai/glm-5.2");
  });

  /**
   * A TIER-LEVEL PROBE MUST BOUND THE TWIN TOO (D-138, found by lore's own review,
   * fingerprint 093456fe).
   *
   * `dueProbe` is deliberately EMPTY while the tier itself is probing (`believed =
   * {usable: all}` already un-parks every route without a per-route re-test), so a twin
   * reached via `dueProbe.has(twinModel)` alone — the first version of this fix — got NO
   * bound at all: a pool spare carrying its own unstated route mark would run completely
   * unbounded, the exact failure this whole entry exists to remove, re-entering through
   * the twin.
   */
  it("bounds the twin too under a tier-level probe, not only a route-level one", async () => {
    const type = nicknamed();
    // Never probed (no probedAt) — `shouldProbe` fires, so this whole round is a
    // TIER-level probe: `probing` is true and `dueProbe` stays empty.
    store.markTierUnavailable("t1", "2126-01-01T00:00:00.000Z", "guessed cool-off", 3, false);
    class ProbeAware implements ReviewerLike {
      readonly asked: { model: string; probing: boolean | undefined }[] = [];
      async review(
        tier: Tier,
        _prompt: unknown,
        _worktree: string,
        _reviewId?: string,
        _stillWanted?: () => boolean,
        probing?: boolean,
      ): Promise<ReviewerResult> {
        this.asked.push({ model: tier.model ?? "?", probing });
        // The PRIMARY (whichever pool member the shuffle picked) goes inconclusive, so
        // the walk reaches the pool's other member as a twin.
        if (this.asked.length === 1) throw new ProbeInconclusive(`tier ${tier.id} probe did not answer in time`);
        return {
          findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0,
          latencyMs: 1, retried: false, steps: 1,
        };
      }
    }
    const reviewer = new ProbeAware();

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type, allowMetered: true });

    expect(reviewer.asked).toHaveLength(2);
    expect(reviewer.asked[0]?.probing, "the primary, forced by the tier-level probe").toBe(true);
    expect(
      reviewer.asked[1]?.probing,
      "the twin too -- dueProbe is empty while tier-probing, but the bound must still apply",
    ).toBe(true);
  });
});

/**
 * THE STREAMED TIER-RUN, END TO END (D-107).
 *
 * Emit-and-stop, the fix landing at the emission boundary, and the done declaration —
 * driven through runRound with a scripted conversation partner, because the loop's
 * whole claim is about WHAT HAPPENS BETWEEN emissions: findings visible before the run
 * ends, held diffs applied exactly at the boundary, and a run that only silence would
 * otherwise end failing loudly instead.
 */
describe("a streamed tier-run", () => {
  /** Answers askFor from a script of emissions; records every prompt it was sent. */
  class Streaming implements ReviewerLike {
    readonly asked: string[] = [];
    readonly opened: string[] = [];
    private script: string[];
    /** Runs before each answer — how a test observes the store BETWEEN emissions. */
    onAsk?: (index: number) => void;
    constructor(script: string[]) {
      this.script = script;
    }
    async review(): Promise<ReviewerResult> {
      throw new Error("a conversation tier must stream, not run a batch round");
    }
    async askFor<T>(
      _tier: Tier,
      prompt: unknown,
      _worktree: string,
      extract: (text: string) => Listed<T>,
      _contract: string,
    ): Promise<SessionResult<T>> {
      const p = prompt as { initial: string; continued: string };
      // The first call opens the session; later calls continue it — mirror the real
      // reviewer's kept-session choice so the test sees the prompts a session would.
      this.onAsk?.(this.asked.length);
      this.asked.push(this.asked.length === 0 ? p.initial : p.continued);
      const text = this.script.shift();
      if (text === undefined) throw new Error("the script ran out — the loop asked more than the test expected");
      const r = extract(text);
      if (!r.ok) throw new Error(`the fixture's own emission was refused: ${r.why}`);
      return {
        items: r.items, raw: text, inputTokens: 10, cachedTokens: 5, outputTokens: 5,
        costUsd: 0, latencyMs: 1, retried: false, steps: 1, rejected: r.rejected,
      };
    }
  }

  const emission = (findings: readonly Finding[]) => "```json\n" + JSON.stringify({ findings }) + "\n```";
  const DONE = '```json\n{"done": true, "examined": "everything"}\n```';
  const STREAM_TYPE = {
    ...CODE_ARCH,
    t0: [] as const,
    tiers: CODE_ARCH.tiers.map((t) => (t.kind === "model" ? { ...t, conversation: true } : t)),
  };

  it("records each emission as it arrives, and ends on the done declaration", async () => {
    const second: Finding = { ...HOLD_BUG, file: "src/other.ts", claim: "a second defect entirely" };
    const reviewer = new Streaming([emission([HOLD_BUG]), emission([second]), DONE]);

    // THE CLAIM IS THE TIMING: before the run's second turn is even asked, the first
    // emission must already be collectable — that is what "immediately" means, and it is
    // what an end-of-run recorder cannot fake.
    reviewer.onAsk = (i) => {
      if (i >= 1) {
        expect(
          store.undelivered("r1").map((f) => f.claim),
          "the first finding is deliverable while the tier still reads",
        ).toContain(HOLD_BUG.claim);
      }
    };
    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });

    expect(r.newFindings.map((f) => f.claim).sort()).toStrictEqual([HOLD_BUG.claim, "a second defect entirely"].sort());
    expect(reviewer.asked, "orientation, then two continues").toHaveLength(3);
    expect(reviewer.asked[0]).toContain("STREAMING MODE");
    expect(reviewer.asked[1]).toMatch(/Continue the review/);
    expect(store.getReview("r1", "p")?.state).toBe("findings_ready");
  });

  /**
   * THE done DECLARATION SURVIVES A RE-ASK — the exact regression (62dffc58, found by
   * lore's own review of D-123).
   *
   * `conduct`'s garbled-block re-ask calls the streamed loop's `extract` closure a SECOND
   * time on the re-ask's own reply, which is about ONE missing block and never carries its
   * own `done` marker. Overwriting `flag.done` with that second, narrower answer let a
   * model's genuine "I have examined everything" on the first reply be silently un-said —
   * INV-1's own load-bearing marker, reset by a question that was never about it. The loop
   * then failed to break and asked an unwanted extra turn.
   *
   * `StreamingWithReask` models exactly what `conduct` does within one turn: two calls to
   * `extract`, first on a reply that declares done, second on a re-ask reply that does not
   * — simulating a rung member whose first emission had one clean block and one garbled
   * one, the garbled one recovered by an empty-array reply. The whole test IS the
   * assertion: with the fix, the round ends after this one script entry; with the bug, the
   * loop believes it is not done, asks again, the one-entry script is exhausted, and the
   * mock throws.
   */
  class StreamingWithReask implements ReviewerLike {
    readonly asked: string[] = [];
    private script: string[];
    constructor(script: string[]) {
      this.script = script;
    }
    async review(): Promise<never> {
      throw new Error("a conversation tier must stream, not run a batch round");
    }
    async askFor<T>(
      _tier: Tier,
      prompt: unknown,
      _worktree: string,
      extract: (text: string) => Listed<T>,
      _contract: string,
    ): Promise<SessionResult<T>> {
      const p = prompt as { initial: string; continued: string };
      this.asked.push(this.asked.length === 0 ? p.initial : p.continued);
      const text = this.script.shift();
      if (text === undefined) throw new Error("the script ran out — the loop asked more than the test expected");
      // FIRST CALL: the turn's real reply — one clean finding, and a done declaration
      // sitting beside a block that (in the real system) failed to parse.
      const first = extract(text);
      if (!first.ok) throw new Error(`the fixture's own emission was refused: ${first.why}`);
      // SECOND CALL: exactly what conduct's re-ask does — the SAME closure, called again,
      // on a COMPLIANT recovery: the model reconstructs the lost block's real content,
      // without redeclaring `done` — the re-ask asked about ONE block, not about the
      // state of the whole tree, so an honest reply has no reason to repeat it.
      //
      // NOT an empty array: `emissionOf` refuses `{"findings": []}` outright unless a
      // done marker sits beside it (its own rule — empty-without-done is a contract
      // failure for a streamed emission, never "nothing lost"), so that reply can never
      // reach the assignment this test exists to exercise. A reply that IS accepted but
      // carries no done marker is what a genuine recovery looks like, and it is the
      // shape that stomped `flag.done` before the fix.
      const second: Finding = { ...HOLD_BUG, file: "src/recovered.ts", claim: "reconstructed from the lost block" };
      const recovery = extract("```json\n" + JSON.stringify({ findings: [second] }) + "\n```");
      if (!recovery.ok) throw new Error(`the fixture's recovery reply was refused: ${recovery.why}`);
      return {
        items: [...first.items, ...recovery.items], raw: text, inputTokens: 10, cachedTokens: 5, outputTokens: 5,
        costUsd: 0, latencyMs: 1, retried: true, steps: 1, rejected: first.rejected,
      };
    }
  }

  it("does not let a re-ask's reply erase the done declaration from the same turn", async () => {
    const reviewer = new StreamingWithReask([
      '```json\n{"findings": [' + JSON.stringify(HOLD_BUG) + '], "done": true}\n```',
    ]);

    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });

    // ONE TURN, not two: the script had exactly one entry, so reaching a decision at all
    // proves the loop broke on `flag.done` rather than asking again and exhausting it.
    expect(reviewer.asked).toHaveLength(1);
    expect(r.newFindings.map((f) => f.claim)).toContain(HOLD_BUG.claim);
    // AND THE RECOVERED FINDING SURVIVES TOO — the merge is additive, not a replacement.
    expect(r.newFindings.map((f) => f.claim)).toContain("reconstructed from the lost block");
    expect(store.getReview("r1", "p")?.state).toBe("findings_ready");
  });

  it("lands a held diff at the emission boundary and puts it to the same session", async () => {
    const reviewer = new Streaming([
      emission([HOLD_BUG]),
      emission([{ ...HOLD_BUG, claim: "the fix broke the retry path" }]),
      DONE,
    ]);
    // Build the held diff exactly as a client would: edit, hash, git-diff — then put the
    // tree back so the hold is applied from the original state at the boundary.
    const file = join(dir, "src/hold.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("return 1;", "return release();"));
    const claimed = await treeHash(dir);
    const diffText = execFileSync("git", ["diff", "HEAD"], { cwd: dir }).toString();
    writeFileSync(file, original);
    await treeHash(dir);
    store.holdDiff("r1", diffText, claimed);

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });

    expect(store.heldDiffs("r1"), "consumed at the boundary").toHaveLength(0);
    expect(readFileSync(file, "utf8")).toContain("return release();");
    const fixPrompt = reviewer.asked[1] ?? "";
    expect(fixPrompt, "the fix goes to the session, findings named").toContain("The author has answered");
    expect(fixPrompt).toContain(HOLD_BUG.claim);
    // t0 arrives as the DELTA against what the session already saw, never the repeat —
    // with nothing on either side, that is one line, not the full orientation render.
    expect(fixPrompt).toContain("still nothing");
    expect(fixPrompt).not.toContain("Deterministic tooling found nothing");
  });

  /**
   * A SUPPRESSED RULE STAYS SUPPRESSED AT THE BOUNDARY TOO (D-83 × D-107). Found by
   * lore's own review of this module, fingerprint f68ace59: round-open t0 filters a
   * live suppression out of what the session is told AND out of the seen-record
   * `t0Seen` diffs against — but the boundary's own t0 re-run, triggered by a held
   * fix landing mid-stream, ran unfiltered. The suppressed fingerprint was absent
   * from the seen-record and present in the fresh boundary read, so `renderT0Delta`
   * could only read it as NEW, undoing the suppression notice already given at round
   * open.
   */
  it("does not let a held fix's boundary t0 re-surface a suppressed finding as new", async () => {
    const policy = store.addKnowledge({
      repoId, kind: "policy", source: "taught",
      statement: "This rule is noise on generated code.", why: "false positives every run",
      path: undefined, cwe: undefined, provenance: "taught by vany", sourceBlob: undefined, confidence: 1,
    });
    store.recordSuppression({
      repoId,
      policyShort: policy.id.slice(0, 8),
      ruleClass: "some.engine.rule",
      path: "src/hold.ts",
      reviewId: "r1",
      tier: "t1",
    });
    // A real engine that keeps matching the file every time it is asked — round-open
    // AND the boundary — so the test isolates whether the BOUNDARY filters it, rather
    // than passing for the unrelated reason that it was only ever read once.
    const SUPPRESSED: Finding = { ...HOLD_BUG, claim: "some.engine.rule: a rule this project has appealed away" };
    const t0 = async () => ({ findings: [SUPPRESSED], outcomes: [], skipped: [], unavailable: [], interrupted: false });
    const reviewer = new Streaming([emission([HOLD_BUG]), DONE]);

    const file = join(dir, "src/hold.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("return 1;", "return release();"));
    const claimed = await treeHash(dir);
    const diffText = execFileSync("git", ["diff", "HEAD"], { cwd: dir }).toString();
    writeFileSync(file, original);
    await treeHash(dir);
    store.holdDiff("r1", diffText, claimed);

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE, t0 });

    const fixPrompt = reviewer.asked[1] ?? "";
    expect(fixPrompt, "the held fix's boundary is where the bug reproduced").toContain("The author has answered");
    expect(fixPrompt, "a suppressed rule must not come back as NEW").not.toContain("NEW src/hold.ts");
    expect(fixPrompt, "nor by its claim text").not.toContain(SUPPRESSED.claim);
  });

  /**
   * A QUOTED PATH MUST STILL REACH THE BOUNDARY'S T0 RE-SCAN (found by lore's own
   * review, fingerprint eab161bc). The old `/^\+\+\+ b\/(.+)$/` regex requires `b/`
   * immediately after the space — but git quotes any non-ASCII name by default
   * (`+++ "b/caf\303\251.ts"`), putting a `"` there instead, so the anchored pattern
   * never matched such a line at all and the touched file was silently absent from
   * `files`, exactly the gap `filesInDiff` (git/diff.ts) already closes elsewhere.
   */
  it("re-scans a fix that touches only a quoted, non-ASCII path", async () => {
    // NEW, and never committed or landed on either branch — `feat/holds` already
    // differs from `main` by `hold.ts` (the fixture's own setup), and committing this
    // file too would make it part of THAT branch-vs-into diff, reaching `files` via
    // `diff.changedFiles` regardless of whether the boundary's own re-scan works. Kept
    // out of history entirely, the only way it can reach `files` is through the held
    // fix's own boundary re-scan, which is the one path this test means to isolate.
    // `git diff HEAD` still quotes it exactly as a client's own committed diff would —
    // core.quotePath's default, not a fixture faking it.
    const file = join(dir, "src/café.ts");
    writeFileSync(file, "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const claimed = await treeHash(dir);
    const diffText = execFileSync("git", ["diff", "HEAD"], { cwd: dir }).toString();
    expect(diffText, "this test means to exercise the quoted form").toContain("caf\\303\\251.ts");
    execFileSync("git", ["reset", "--", "."], { cwd: dir });
    rmSync(file, { force: true });
    await treeHash(dir);
    store.holdDiff("r1", diffText, claimed);

    let boundaryFiles: readonly string[] | undefined;
    const t0: NonNullable<Parameters<typeof runRound>[0]["t0"]> = async (_worktree, opts) => {
      boundaryFiles = opts.files;
      return { findings: [], outcomes: [], skipped: [], unavailable: [], interrupted: false };
    };
    const reviewer = new Streaming([emission([HOLD_BUG]), DONE]);

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE, t0 });

    expect(boundaryFiles, "the quoted path, decoded to its real name, not dropped").toContain("src/café.ts");
  });

  /**
   * A SUPPRESSION THAT ONLY MATCHES AT THE BOUNDARY STILL REACHES checks_skipped
   * (found by lore's own review, fingerprint d8e642af). Round-open's t0 row closes
   * before the streaming loop's boundary ever runs, so a live suppression that first
   * matches there — new code the held fix itself introduces, or a file round-open t0
   * never read — used to vanish: the filter (f68ace59's fix) correctly keeps the tier
   * from seeing it, but nothing told the CLIENT a check had been switched off.
   */
  it("discloses a suppression that only matches at a held fix's boundary", async () => {
    const policy = store.addKnowledge({
      repoId, kind: "policy", source: "taught",
      statement: "This rule is noise on generated code.", why: "false positives every run",
      path: undefined, cwe: undefined, provenance: "taught by vany", sourceBlob: undefined, confidence: 1,
    });
    store.recordSuppression({
      repoId,
      policyShort: policy.id.slice(0, 8),
      ruleClass: "some.engine.rule",
      path: "src/hold.ts",
      reviewId: "r1",
      tier: "t1",
    });
    const SUPPRESSED: Finding = { ...HOLD_BUG, claim: "some.engine.rule: only the boundary's read finds this" };
    let call = 0;
    const t0 = async () => {
      call++;
      // Round-open finds nothing: this suppression has never yet matched anything in
      // THIS review. The boundary's re-run, after the held fix lands, is the first time
      // it does — the scenario this fix exists for.
      return call === 1
        ? { findings: [], outcomes: [], skipped: [], unavailable: [], interrupted: false }
        : { findings: [SUPPRESSED], outcomes: [], skipped: [], unavailable: [], interrupted: false };
    };
    const reviewer = new Streaming([emission([HOLD_BUG]), DONE]);

    const file = join(dir, "src/hold.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("return 1;", "return release();"));
    const claimed = await treeHash(dir);
    const diffText = execFileSync("git", ["diff", "HEAD"], { cwd: dir }).toString();
    writeFileSync(file, original);
    await treeHash(dir);
    store.holdDiff("r1", diffText, claimed);

    expect(store.checksSkippedFor("r1"), "nothing to disclose before the round runs").toHaveLength(0);

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE, t0 });

    const skipped = store.checksSkippedFor("r1");
    expect(skipped.some((l) => l.includes("src/hold.ts")), "the boundary-only match still reaches checks_skipped").toBe(true);
  });

  /**
   * POST-FIX SILENCE SETTLES A MID-STREAM FINDING. Raised by lore's own review of this
   * change: a finding emitted before the boundary and fixed by the held diff was in
   * NEITHER set the settle pass read — not in `open` (born mid-round) and present in
   * `raised` (the pre-fix emission) — so the client was shown, still open, the very
   * thing its held fix had fixed, and paid another round to close it.
   */
  it("settles a finding the held diff fixed, on the model's silence after seeing it", async () => {
    // Emission 1 raises HOLD_BUG about src/hold.ts; the held diff rewrites that file;
    // emission 2 stays silent about it (a different file entirely) and declares done.
    const other: Finding = { ...HOLD_BUG, file: "src.txt", line: 1, claim: "an unrelated remark" };
    const reviewer = new Streaming([emission([HOLD_BUG]), emission([other]), DONE]);

    const file = join(dir, "src/hold.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("return 1;", "return release();"));
    const claimed = await treeHash(dir);
    const diffText = execFileSync("git", ["diff", "HEAD"], { cwd: dir }).toString();
    writeFileSync(file, original);
    await treeHash(dir);
    store.holdDiff("r1", diffText, claimed);

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });

    const stillOpen = store.openFindings("r1").map((f) => f.claim);
    expect(stillOpen, "the fixed finding closed in THIS round").not.toContain(HOLD_BUG.claim);
    expect(stillOpen, "silence settles only what the fix touched").toContain("an unrelated remark");
  });

  /**
   * A PRE-FIX RE-RAISE MUST NOT BLOCK THE SETTLE (raised by lore's own t2). A finding
   * open from an earlier round, re-raised in the very turn whose boundary applies the
   * fix, was counted as this round's fresh objection — so the model's qualified
   * post-fix silence could never settle the thing the fix fixed, and the client was
   * nagged about a finding it had answered.
   */
  it("settles an open finding re-raised just before the fix that answers it", async () => {
    // Round 1 raises HOLD_BUG and it stays open. Round 2: the model re-raises it,
    // the held fix lands at that boundary, the model sees it and goes silent.
    const reviewer = new Streaming([
      emission([HOLD_BUG]), DONE,
      emission([HOLD_BUG]), DONE,
    ]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });
    expect(store.openFindings("r1").map((f) => f.claim)).toContain(HOLD_BUG.claim);

    const file = join(dir, "src/hold.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("return 1;", "return release();"));
    const claimed = await treeHash(dir);
    const diffText = execFileSync("git", ["diff", "HEAD"], { cwd: dir }).toString();
    writeFileSync(file, original);
    await treeHash(dir);
    store.holdDiff("r1", diffText, claimed);

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });

    expect(
      store.openFindings("r1").map((f) => f.claim),
      "silence after seeing the fix settles the re-raised finding",
    ).not.toContain(HOLD_BUG.claim);
  });

  /**
   * TO THE MODEL, EVERY TREE ADVANCE IS A NEW DIFF ARRIVING (D-108). Vany: *"for the
   * model everything must look like a new diff arrived, not some restart."* Before this,
   * a kept session's post-submit round opened with "continue from where you were" — the
   * model was never told the tree had changed. Now the round opens with the
   * author-answered prompt carrying exactly the delta the session has not seen, whether
   * it arrived by submit, held diff, or pull_fresh re-pin.
   */
  it("opens a kept session's next round with the unseen delta, as an author's answer", async () => {
    const reviewer = new Streaming([emission([HOLD_BUG]), DONE, emission([{ ...HOLD_BUG, claim: "second look" }]), DONE]);
    const type = STREAM_TYPE;

    // Round 1 streams and ends; the run records the tree its session saw.
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });
    expect(reviewer.asked, "orientation, then done").toHaveLength(2);

    // The author's fix lands the ordinary way: applied to the tree between rounds,
    // exactly as review_submit or pull_fresh leaves things.
    writeFileSync(join(dir, "src/hold.ts"), "export function capture() {\n  return release();\n}\n");
    await treeHash(dir);

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type });

    const opener = reviewer.asked[2] ?? "";
    expect(opener, "the author answered — never a bare continue").toContain("The author has answered");
    expect(opener, "carrying the exact unseen delta").toContain("return release();");
    expect(opener, "and naming the session's own open findings").toContain(HOLD_BUG.claim);
  });

  it("opens with a plain continue when the tree did not move between rounds", async () => {
    const reviewer = new Streaming([emission([HOLD_BUG]), DONE, emission([{ ...HOLD_BUG, claim: "again" }]), DONE]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });

    expect(reviewer.asked[2] ?? "", "nothing changed, nothing claimed").toMatch(/Continue the review/);
  });

  /**
   * THE RUN'S OWN CLOCK, not just its turn count. Measured: a t3 run took 137.4 minutes
   * against a 2700s per-CALL deadline, because D-107 made a tier-run a LOOP of calls and
   * the deadline bounds one call. 32 turns each finishing just inside 45 minutes is over
   * a day, and nothing would have stopped it. The fake below never sleeps — it moves the
   * clock, so the test proves the BOUND rather than waiting for it.
   */
  it("stops a streamed run that outlives its wall-clock budget, keeping what it found", async () => {
    const many = Array.from({ length: 40 }, (_, i) => emission([{ ...HOLD_BUG, line: 200 + i, claim: `finding ${String(i)}` }]));
    const reviewer = new Streaming(many);
    const real = Date.now;
    let t = real();
    // Each ask jumps the clock 20 minutes: the run must die on time, not on turn 32.
    reviewer.onAsk = () => { t += 20 * 60_000; };
    Date.now = () => t;
    try {
      const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });
      expect(reviewer.asked.length, "stopped by the clock, well before the 32-emission cap").toBeLessThan(10);
      expect(r.newFindings.length, "everything it did emit is kept").toBeGreaterThan(0);
    } finally {
      Date.now = real;
    }
  });

  it("surfaces a held diff that cannot land as awaiting_diff, never silently", async () => {
    const reviewer = new Streaming([emission([HOLD_BUG]), DONE]);
    store.holdDiff("r1", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-nope\n+never", "0".repeat(40));

    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE });

    expect(store.getReview("r1", "p")?.state).toBe("awaiting_diff");
    expect(String(store.failureReason("r1", false))).toMatch(/dropped|did not apply|claimed/);
    expect(store.heldDiffs("r1"), "the dead chain does not linger").toHaveLength(0);
  });

  /** INV-1: a session that dies mid-search must never read as finished-clean. */
  it("fails loudly when the stream dies instead of declaring done", async () => {
    const dead = new (class extends Streaming {
      override async askFor<T>(): Promise<SessionResult<T>> {
        throw new DidNotRun("tier t1 (m) failed: the provider returned 500");
      }
    })([]);

    // The round REJECTS — the worker is what records `failed` — and the rejection names
    // the tier fault. What must never happen is a clean return from a dead stream.
    await expect(
      runRound({ store, reviewer: dead, reviewId: "r1", principal: "p", worktree: dir, type: STREAM_TYPE }),
    ).rejects.toThrow(/failed: the provider returned 500/);
  });
});

/**
 * A STOP LORE CAUSED IS NOT EVIDENCE ABOUT THE TIER. A rigid client restarted its
 * review; the predecessor's in-flight session was aborted (as designed); the abort
 * classifier said "stopped by lore, not by the provider" — and skip_if_quota read only
 * the type and recorded "t1 could not answer … one fewer independent vendor" on a board
 * where every provider chip was green. The operator called it a lie, and it was.
 */
describe("a round lore itself stopped", () => {
  it("is rethrown untouched — never booked as a tier skip", async () => {
    const KEEPS = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, skip_if_quota: true } : t)),
    };
    class Stopped implements ReviewerLike {
      async review(tier: Tier): Promise<ReviewerResult> {
        throw new CancelledByLore(`tier ${tier.id} (${tier.model ?? "?"}) was stopped by lore, not by the provider: aborted`);
      }
    }
    // A prior failure on record — the exact precondition that used to trip the skip.
    store.db
      .prepare("INSERT INTO tier_run(review_id, tier, round, outcome, started_at) VALUES('r1','t1',0,'failed','2026-01-01')")
      .run();

    await expect(
      runRound({ store, reviewer: new Stopped(), reviewId: "r1", principal: "p", worktree: dir, type: KEEPS }),
    ).rejects.toThrow(CancelledByLore);

    const note = store.db
      .prepare("SELECT unavailable_for_tier FROM tier_run WHERE review_id='r1' ORDER BY id DESC LIMIT 1")
      .get() as Record<string, string> | undefined;
    expect(String(note?.["unavailable_for_tier"] ?? ""), "no shortfall was invented").not.toContain("SKIPPED");
    const ladder = JSON.parse(String(store.db.prepare("SELECT ladder FROM review WHERE id='r1'").get()?.["ladder"] ?? "{}")) as { unavailable?: string[] };
    expect(ladder.unavailable ?? [], "the tier was not marked unpayable").not.toContain("t1");
  });
});

/**
 * AN UNREACHABLE OPENCODE IS THE WORKER'S TO REQUEUE, NEVER A TIER'S SHORTFALL. The
 * probe said it honestly — "opencode itself is not answering … the round is requeued" —
 * and skip_if_quota consumed that exact error as the tier's second strike: t1 SKIPPED,
 * one fewer independent vendor, on a fault that was lore's own deploy window.
 */
describe("a round that lost opencode", () => {
  it("rethrows ServiceUnreachable untouched, past the skip machinery", async () => {
    const KEEPS = {
      ...CODE_ARCH,
      t0: [] as const,
      tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, skip_if_quota: true } : t)),
    };
    class Gone implements ReviewerLike {
      async review(tier: Tier): Promise<ReviewerResult> {
        throw new ServiceUnreachable(`tier ${tier.id} could not reach opencode — the connection dropped mid-call`);
      }
    }
    store.db
      .prepare("INSERT INTO tier_run(review_id, tier, round, outcome, started_at) VALUES('r1','t1',0,'failed','2026-01-01')")
      .run();

    await expect(
      runRound({ store, reviewer: new Gone(), reviewId: "r1", principal: "p", worktree: dir, type: KEEPS }),
    ).rejects.toThrow(ServiceUnreachable);

    const note = store.db
      .prepare("SELECT unavailable_for_tier FROM tier_run WHERE review_id='r1' ORDER BY id DESC LIMIT 1")
      .get() as Record<string, string> | undefined;
    expect(String(note?.["unavailable_for_tier"] ?? ""), "no vendor was declared lost").not.toContain("SKIPPED");
  });
});

describe("skip_if_quota together with a fallback", () => {
  const bothSet = (...fallback: string[]) => ({
    ...CODE_ARCH,
    t0: [] as const,
    tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, skip_if_quota: true, fallback } : t)),
  });

  it("asks the twin rather than skipping, when the twin can answer", async () => {
    const type = bothSet("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    class PrimaryOut implements ReviewerLike {
      readonly asked: string[] = [];
      async review(tier: Tier): Promise<ReviewerResult> {
        this.asked.push(tier.model ?? "?");
        if (tier.model === primary) throw new Exhausted("plan is out");
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }
    const reviewer = new PrimaryOut();

    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, allowMetered: true, type });

    expect(reviewer.asked).toStrictEqual([primary, "openrouter/twin"]);
    // NOT skipped: the tier ran, so it never enters `unavailable` and the verdict is not
    // weakened by it.
    expect(store.getReview("r1", "p")?.ladder.unavailable ?? []).toStrictEqual([]);
    expect(["escalate", "fastClean"]).toContain(r.decision.kind);
  });

  it("skips the tier when the twin is out of quota too", async () => {
    const type = bothSet("openrouter/twin");
    const primary = type.tiers.find((t) => t.id === "t1")?.model ?? "";
    class BothOut implements ReviewerLike {
      readonly asked: string[] = [];
      async review(tier: Tier): Promise<ReviewerResult> {
        this.asked.push(tier.model ?? "?");
        // ONLY t1's PAIR is out. An earlier version of this fixture exhausted every tier,
        // so the review died of having nothing left to run rather than of the thing under
        // test — a fixture broader than its claim proves the wrong statement.
        if (tier.model === primary || tier.model === "openrouter/twin") throw new Exhausted("plan is out");
        return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
      }
    }
    const reviewer = new BothOut();

    let last;
    for (let i = 0; i < 8; i++) {
      last = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, allowMetered: true, type }).catch(() => undefined);
      if (last === undefined || !["escalate", "fastClean"].includes(last.decision.kind)) break;
    }

    // Both asked once — `skip_if_quota` spends no second attempt on the primary — and then
    // the tier is stepped over rather than failing the review.
    expect(reviewer.asked.slice(0, 2)).toStrictEqual([primary, "openrouter/twin"]);
    expect(store.getReview("r1", "p")?.ladder.unavailable ?? [], "t1 is skipped").toContain("t1");
    expect(last?.decision.kind, "and the review still reaches a verdict").toBe("passed");
  });
});

/**
 * A DEAD CREDENTIAL IS A ROUTE FAULT, NOT A VERDICT (2026-08-14). rev_gOhsCu cleared
 * t1 and t2, then died 0.4 seconds into t3 on `Token refresh failed: 401` — with a
 * healthy OpenRouter twin configured and never asked, because the chain advanced on
 * `Exhausted` alone. Auth walks the same chain now; what it does NOT inherit is
 * quota's quiet step-over when nothing rescues, because a credential heals only by a
 * person and the worker must page one.
 */
describe("a tier whose credentials died", () => {
  const withTwin = {
    ...CODE_ARCH,
    t0: [] as const,
    tiers: CODE_ARCH.tiers.map((t) => (t.id === "t1" ? { ...t, fallback: ["openrouter/twin"] } : t)),
  };
  const primary = withTwin.tiers.find((t) => t.id === "t1")?.model ?? "";

  class AuthDead implements ReviewerLike {
    readonly asked: string[] = [];
    async review(tier: Tier): Promise<ReviewerResult> {
      this.asked.push(tier.model ?? "?");
      if (tier.model === primary) throw new ProviderAuthFailed(primary, "tier t1: opencode returned 500: UnknownError: Token refresh failed: 401");
      return { findings: [], discarded: [], raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1 };
    }
  }

  it("asks the same model through the twin, and parks the dead route for the status line", async () => {
    const reviewer = new AuthDead();
    const r = await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, allowMetered: true, type: withTwin });

    expect(reviewer.asked).toStrictEqual([primary, "openrouter/twin"]);
    expect(store.getReview("r1", "p")?.ladder.unavailable ?? [], "the tier ran — nothing is skipped").toStrictEqual([]);
    expect(["escalate", "fastClean"]).toContain(r.decision.kind);
    // The mark is what the status line reads; without it the board showed the dead
    // provider green while every round refused (the exact complaint that shaped this).
    const parked = store.routeUnavailable(primary);
    expect(parked, "the route is parked with the auth reason").toBeDefined();
    expect(parked?.why).toContain("Token refresh failed");
  });

  it("keeps its own type when nothing rescues, so the worker pages a person", async () => {
    const noTwin = { ...CODE_ARCH, t0: [] as const };
    class NothingLeft implements ReviewerLike {
      async review(tier: Tier): Promise<ReviewerResult> {
        throw new ProviderAuthFailed(tier.model ?? "?", "tier t1: Token refresh failed: 401");
      }
    }
    // Quota in this shape steps the tier over (D-48); auth must NOT take that quiet
    // exit — the review fails carrying ProviderAuthFailed, which is what pages.
    await expect(
      runRound({ store, reviewer: new NothingLeft(), reviewId: "r1", principal: "p", worktree: dir, type: noTwin }),
    ).rejects.toThrow(ProviderAuthFailed);
  });
});

/**
 * A RUNG'S MEMBERS RUN TOGETHER (D-109): one round, two sessions, one worktree.
 *
 * The interleaving is pinned by GATES rather than left to the scheduler — the property
 * under test is "what one member is told about the other", and a test that only
 * sometimes produces the crossing proves nothing about it (the coin-toss-test lesson,
 * again). Each fixture blocks one member until the other has demonstrably passed the
 * point the assertion depends on.
 */
describe("a rung of two members", () => {
  /** Per-tier scripts and per-tier transcripts — two sessions, one fake. */
  class RungStreaming implements ReviewerLike {
    readonly asked = new Map<string, string[]>();
    /** Runs before each answer, ASYNC so a test can hold one member at a gate. */
    onAsk?: (tierId: string, index: number) => void | Promise<void>;
    /** A member that must die instead of answering, and how. */
    fail: Record<string, Error> = {};
    private readonly scripts: Record<string, string[]>;
    constructor(scripts: Record<string, string[]>) {
      this.scripts = scripts;
    }
    async review(): Promise<ReviewerResult> {
      throw new Error("a conversation tier must stream, not run a batch round");
    }
    async askFor<T>(
      tier: Tier,
      prompt: unknown,
      _worktree: string,
      extract: (text: string) => Listed<T>,
    ): Promise<SessionResult<T>> {
      const dead = this.fail[tier.id];
      if (dead !== undefined) throw dead;
      const list = this.asked.get(tier.id) ?? [];
      this.asked.set(tier.id, list);
      const p = prompt as { initial: string; continued: string };
      await this.onAsk?.(tier.id, list.length);
      list.push(list.length === 0 ? p.initial : p.continued);
      const text = this.scripts[tier.id]?.shift();
      if (text === undefined) throw new Error(`the script for ${tier.id} ran out`);
      const r = extract(text);
      if (!r.ok) throw new Error(`the fixture's own emission was refused: ${r.why}`);
      return {
        items: r.items, raw: text, inputTokens: 10, cachedTokens: 5, outputTokens: 5,
        costUsd: 0, latencyMs: 1, retried: false, steps: 1, rejected: r.rejected,
      };
    }
  }

  const emission = (findings: readonly Finding[]) => "```json\n" + JSON.stringify({ findings }) + "\n```";
  const DONE = '```json\n{"done": true, "examined": "everything"}\n```';

  // The rung, hand-stamped exactly as `loadTiers` stamps a nested array: both members
  // carry the flat index of the rung's first member.
  const RUNG_TIERS: readonly Tier[] = [
    { id: "t0", kind: "deterministic", stage: "fast" },
    { id: "t2", kind: "model", model: "vendor-a/m", effort: "high", stage: "deep", conversation: true, rung: 1 },
    { id: "t3", kind: "model", model: "vendor-b/m", effort: "high", stage: "deep", conversation: true, rung: 1 },
  ];
  const RUNG_TYPE = { ...CODE_ARCH, t0: [] as const, tiers: RUNG_TIERS };

  const A: Finding = { ...HOLD_BUG, claim: "found by the second tier" };
  const B: Finding = { ...HOLD_BUG, file: "src.txt", line: 1, claim: "found by the third tier" };

  beforeEach(() => {
    store.createReview({
      id: "rung1", repoId, principal: "p", branch: "feat/holds", intoRef: "main",
      ticket: "t", type: CODE_ARCH.id, state: "running", ladder: initialState(RUNG_TIERS),
    });
  });

  it("crosses one member's finding into the other's next boundary, and only that way", async () => {
    const reviewer = new RungStreaming({ t2: [emission([A]), DONE], t3: [emission([B]), DONE] });
    // t3 is held at its FIRST ask until t2 is provably past recording A — t2 asking for
    // its second prompt is that proof, because the boundary runs before the ask.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    reviewer.onAsk = async (tierId, i) => {
      if (tierId === "t2" && i === 1) release();
      if (tierId === "t3" && i === 0) await gate;
    };

    const r = await runRound({ store, reviewer, reviewId: "rung1", principal: "p", worktree: dir, type: RUNG_TYPE });

    const t3Second = reviewer.asked.get("t3")?.[1] ?? "";
    expect(t3Second, "the peer's finding crosses at the boundary").toContain("co-reviewer");
    expect(t3Second).toContain(A.claim);
    expect(t3Second, "never the member's own finding, echoed back").not.toContain(B.claim);
    // t2 reached its boundary before t3 had recorded anything, so it was told to continue.
    expect(reviewer.asked.get("t2")?.[1] ?? "").toMatch(/Continue the review/);

    expect(r.newFindings.map((f) => [f.origin, f.claim]).sort()).toStrictEqual(
      [["t2", A.claim], ["t3", B.claim]].sort(),
    );
    const ladder = store.getReview("rung1", "p")?.ladder;
    expect(ladder?.tierRounds, "every member that ran is billed the round").toStrictEqual({ t2: 1, t3: 1 });
    expect(store.getReview("rung1", "p")?.state).toBe("findings_ready");
  });

  it("applies a held diff once and tells each member at its own boundary", async () => {
    const reviewer = new RungStreaming({ t2: [emission([A]), DONE], t3: [emission([B]), DONE] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    reviewer.onAsk = async (tierId, i) => {
      // t2's second ask means its boundary ran: the diff is applied and in the chain.
      if (tierId === "t2" && i === 1) release();
      if (tierId === "t3" && i === 0) await gate;
    };

    const file = join(dir, "src/hold.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("return 1;", "return release();"));
    const claimed = await treeHash(dir);
    const diffText = execFileSync("git", ["diff", "HEAD"], { cwd: dir }).toString();
    writeFileSync(file, original);
    await treeHash(dir);
    store.holdDiff("rung1", diffText, claimed);

    await runRound({ store, reviewer, reviewId: "rung1", principal: "p", worktree: dir, type: RUNG_TYPE });

    expect(store.heldDiffs("rung1"), "consumed exactly once").toHaveLength(0);
    expect(readFileSync(file, "utf8"), "applied to the one shared tree").toContain("return release();");
    // EACH member hears of the fix — the applier at the boundary that applied it, the
    // sibling at its own next boundary, reading the chain's unseen tail.
    for (const id of ["t2", "t3"]) {
      const second = reviewer.asked.get(id)?.[1] ?? "";
      expect(second, `${id} was told the author answered`).toContain("The author has answered");
      expect(second, `${id} was shown the same diff`).toContain("return release();");
    }
  });

  /**
   * NO MEMBER LEAVES THE ROUND BEHIND THE TREE — t2's highest finding on this change.
   * A member that declares done early has no boundary left, so a fix a sibling
   * applies afterwards was never delivered to it, and the rung could conclude clean
   * over a tree that member never read. The catch-up pass re-runs it, pinned to its
   * route, opening with exactly the unseen delta.
   */
  it("re-runs a member that finished before the fix landed, until it has seen the final tree", async () => {
    // t3 declares done at its FIRST ask (no boundary); its catch-up answers done again.
    const reviewer = new RungStreaming({ t2: [emission([A]), DONE], t3: [DONE, DONE] });
    reviewer.onAsk = async (tierId, i) => {
      // Hold t2's first ask until t3's first run has ENDED — its session tree being
      // recorded is the observable end — so the fix provably lands after t3 is gone.
      if (tierId === "t2" && i === 0) {
        for (let w = 0; w < 400 && store.sessionTreeOf("rung1", "t3", "vendor-b/m") === undefined; w++) {
          await new Promise((r) => setTimeout(r, 5));
        }
      }
    };

    const file = join(dir, "src/hold.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("return 1;", "return release();"));
    const claimed = await treeHash(dir);
    const diffText = execFileSync("git", ["diff", "HEAD"], { cwd: dir }).toString();
    writeFileSync(file, original);
    await treeHash(dir);
    store.holdDiff("rung1", diffText, claimed);

    await runRound({ store, reviewer, reviewId: "rung1", principal: "p", worktree: dir, type: RUNG_TYPE });

    const t3Asked = reviewer.asked.get("t3") ?? [];
    expect(t3Asked, "t3 was brought back for the fix").toHaveLength(2);
    expect(t3Asked[1], "its catch-up opens as the author's answer").toContain("The author has answered");
    expect(t3Asked[1]).toContain("return release();");
    const finalTree = await treeHash(dir);
    expect(store.sessionTreeOf("rung1", "t3", "vendor-b/m"), "and it has now seen the final tree").toBe(finalTree);
    expect(store.sessionTreeOf("rung1", "t2", "vendor-a/m")).toBe(finalTree);
  });

  it("continues with the survivor when one member cannot be paid for", async () => {
    const reviewer = new RungStreaming({ t3: [emission([B]), DONE] });
    reviewer.fail["t2"] = new Exhausted("plan is out");

    const r = await runRound({ store, reviewer, reviewId: "rung1", principal: "p", worktree: dir, type: RUNG_TYPE });

    expect(r.decision.kind, "the survivor's findings still arrive").toBe("findings");
    expect(r.newFindings.map((f) => f.claim)).toStrictEqual([B.claim]);
    const ladder = store.getReview("rung1", "p")?.ladder;
    expect(ladder?.unavailable, "the dead member is marked, alone").toStrictEqual(["t2"]);
    expect(ladder?.tierRounds, "and not billed for a round it never saw").toStrictEqual({ t3: 1 });
    expect(r.t0Unavailable.join(" "), "the client is told which member could not look").toContain("t2");
  });
});
