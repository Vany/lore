import { describe, expect, it } from "vitest";
import { normalizeClaim, parseFinding } from "./finding.ts";

const valid = {
  file: "src/pay/hold.ts",
  line: 142,
  symbol: "capturePayment",
  severity: "high",
  claim: "decline path leaves the hold active",
  evidence: "hold released only in the success branch (hold.ts:142-151)",
  failureScenario: "card declines → funds stay held until the 7d sweeper",
} as const;

describe("parseFinding", () => {
  it("accepts a well-formed finding", () => {
    expect(parseFinding(valid)).toStrictEqual(valid);
  });

  it("accepts one with only the required fields", () => {
    const minimal = {
      file: "README.md",
      severity: "low",
      claim: "no tests cover the drain path",
      evidence: "no reference to drain() in any test file",
      failureScenario: "shutdown drops in-flight work and nothing notices",
    };
    expect(parseFinding(minimal)).toStrictEqual(minimal);
  });

  // The drift detector. A model that invents a field means our prompt and this
  // schema have parted ways, and dropping it silently would hide that for as long
  // as it took someone to notice the findings had quietly got worse.
  it("rejects unknown keys rather than dropping them", () => {
    expect(() => parseFinding({ ...valid, confidence: 0.8 })).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() => parseFinding({ ...valid, file: "/etc/passwd" })).toThrow();
  });

  it("rejects a path that escapes the repo", () => {
    expect(() => parseFinding({ ...valid, file: "../../secrets.env" })).toThrow();
  });

  it("accepts a well-formed cwe and rejects a malformed one", () => {
    expect(parseFinding({ ...valid, cwe: "CWE-362" }).cwe).toBe("CWE-362");
    expect(() => parseFinding({ ...valid, cwe: "89" })).toThrow();
    expect(() => parseFinding({ ...valid, cwe: "CWE-" })).toThrow();
  });

  it("rejects a claim that sprawls past one sentence", () => {
    expect(() => parseFinding({ ...valid, claim: "x".repeat(301) })).toThrow();
  });

  it("rejects empty required text", () => {
    expect(() => parseFinding({ ...valid, claim: "" })).toThrow();
    expect(() => parseFinding({ ...valid, evidence: "" })).toThrow();
    expect(() => parseFinding({ ...valid, failureScenario: "" })).toThrow();
  });

  it("rejects a non-positive or fractional line", () => {
    expect(() => parseFinding({ ...valid, line: 0 })).toThrow();
    expect(() => parseFinding({ ...valid, line: -1 })).toThrow();
    expect(() => parseFinding({ ...valid, line: 1.5 })).toThrow();
  });

  it("rejects an unknown severity", () => {
    expect(() => parseFinding({ ...valid, severity: "critical" })).toThrow();
  });
});

describe("normalizeClaim", () => {
  it("ignores case, surrounding space and collapsed whitespace", () => {
    expect(normalizeClaim("  Decline   path\nleaves the hold ACTIVE  ")).toBe(
      "decline path leaves the hold active",
    );
  });

  it("ignores trailing sentence punctuation", () => {
    expect(normalizeClaim("hold stays active.")).toBe("hold stays active");
    expect(normalizeClaim("hold stays active!!")).toBe("hold stays active");
  });

  // Guards against over-normalising. Two genuinely different claims must stay
  // different: a wrongly merged finding is one that never gets fixed.
  it("does not merge claims that differ in meaning", () => {
    expect(normalizeClaim("hold is released twice")).not.toBe(
      normalizeClaim("hold is never released"),
    );
  });

  it("leaves internal punctuation alone", () => {
    expect(normalizeClaim("uses toEqual, not toStrictEqual")).toBe(
      "uses toequal, not tostrictequal",
    );
  });
});
