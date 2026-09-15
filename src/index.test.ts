import { describe, expect, it } from "vitest";
import { existingReview, parseArgs, render } from "./cli.ts";
import { initialState } from "./core/ladder.ts";
import type { ReviewState } from "./core/review-state.ts";
import { Store } from "./store/store.ts";
import { EXIT } from "./core/errors.ts";

describe("parseArgs", () => {
  it("reads the flags a review needs", () => {
    const a = parseArgs(["review", "--branch", "feat/x", "--into", "develop", "--ticket", "do the thing"]);
    expect(a.command).toBe("review");
    expect(a.branch).toBe("feat/x");
    expect(a.into).toBe("develop");
    expect(a.ticket).toBe("do the thing");
  });

  it("defaults the base branch and review type", () => {
    const a = parseArgs(["review", "--ticket", "t"]);
    expect(a.into).toBe("main");
    expect(a.type).toBe("code-arch");
  });

  it("leaves ticket absent when not given, so the caller can reject it", () => {
    // Required rather than defaulted: a made-up ticket would be worse than none,
    // because scope creep is judged against it (D-38).
    expect(parseArgs(["review"]).ticket).toBeUndefined();
  });

  // D-71: lore reads a test suite and never runs it, so there is no flag to parse.
  // `--run-tests` is accepted-and-ignored by nothing: it is simply not a flag, and an
  // unknown flag is better than one that silently does nothing.
  it("has no test-execution flag, because lore does not execute tests", () => {
    expect(parseArgs(["review", "--ticket", "t"])).not.toHaveProperty("runTests");
  });
});

describe("exit codes", () => {
  // The caller is a program, so these are the API. Pinned so nobody renumbers them
  // casually: 0 is the ONLY code that means reviewed and clean.
  it("are the documented contract", () => {
    expect(EXIT).toStrictEqual({
      PASS: 0,
      FINDINGS: 1,
      // Partial is deliberately NOT 0: "the tiers we could afford agreed" is
      // weaker evidence than "every tier agreed", and a caller that wants to
      // treat them alike must say so itself (D-48).
      THIN_LADDER: 3,
      USAGE: 2,
      DID_NOT_RUN: 70,
      EXHAUSTED: 75,
    });
  });
});

/**
 * `b632d279`: the CLI resumed any review whose state it had not named, and after D-147 that
 * included the ordinary successful ending. Asked through `isTerminal` now.
 */
describe("which review the CLI resumes", () => {
  const withReview = (state: ReviewState): { store: Store; id: string } => {
    const store = new Store(":memory:");
    const repo = store.upsertRepo("r", "u");
    store.createReview({
      id: "rev_x", repoId: repo.id, principal: "p", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state, ladder: initialState(),
    });
    return { store, id: "rev_x" };
  };

  it.each(["passed", "passed_thin_ladder", "failed", "expired", "cancelled"] as const)(
    "starts fresh rather than running another round on a %s review",
    (state) => {
      const { store } = withReview(state);
      expect(existingReview(store, "p", "feat/x"), "a concluded review is not resumed").toBeUndefined();
    },
  );

  it.each(["findings_ready", "running", "fast_clean"] as const)("resumes a %s review", (state) => {
    const { store, id } = withReview(state);
    expect(existingReview(store, "p", "feat/x")).toBe(id);
  });
});

/**
 * `2df1e05f`: the thin ladder was told "This is NOT a pass. Fix or justify, then run again."
 * while exiting 3, which the README calls a success.
 */
describe("what the CLI says at the end of a round", () => {
  const say = (decision: string): string => render("rev_x", decision, [], [], [], [], [], new Map());

  it("does not tell a thin ladder it failed", () => {
    const text = say("passedThinLadder");
    expect(text).not.toContain("NOT a pass");
    expect(text).toContain("CLEARED, on a thinner ladder");
  });

  it("does not tell a full pass it failed either", () => {
    expect(say("passed")).not.toContain("NOT a pass");
  });

  it("still says NOT a pass where nothing was cleared", () => {
    for (const d of ["findings", "fastClean", "stopped"]) expect(say(d), d).toContain("NOT a pass");
  });
});
