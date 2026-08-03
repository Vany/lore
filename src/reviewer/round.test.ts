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
});
