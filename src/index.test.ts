import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.ts";
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

  it("treats test execution as opt-in", () => {
    expect(parseArgs(["review", "--ticket", "t"]).runTests).toBe(false);
    expect(parseArgs(["review", "--ticket", "t", "--run-tests"]).runTests).toBe(true);
  });
});

describe("exit codes", () => {
  // The caller is a program, so these are the API. Pinned so nobody renumbers them
  // casually: 0 is the ONLY code that means reviewed and clean.
  it("are the documented contract", () => {
    expect(EXIT).toStrictEqual({
      PASS: 0,
      FINDINGS: 1,
      USAGE: 2,
      DID_NOT_RUN: 70,
      EXHAUSTED: 75,
    });
  });
});
