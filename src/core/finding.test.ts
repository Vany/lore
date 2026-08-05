import { describe, expect, it } from "vitest";
import {
  CLAIM_MAX,
  compareFindings,
  normalizeClaim,
  parseFinding,
  severityRank,
  SEVERITIES,
  worstSeverity,
  type Severity,
} from "./finding.ts";

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

  // Every way a model has been seen to write "no CWE applies", pinned.
  //
  // This table is the point. The `""` behaviour was written to stop one blank
  // field discarding a whole paid-for batch, the reasoning was put in a comment,
  // and NOTHING tested it — so deleting the preprocess left the suite green while
  // re-arming the original incident. `null` is here because a review found it
  // missing: it is the more natural JSON for absent, and it was still rejected.
  it.each([
    ["absent", undefined],
    ["empty string", ""],
    ["whitespace", "   "],
    ["null", null],
  ])("reads cwe %s as no CWE rather than as malformed", (_label, cwe) => {
    expect(parseFinding({ ...valid, cwe }).cwe).toBeUndefined();
  });

  // The other half: forgiving blank must not become forgiving anything. A CWE the
  // schema and the reviewer disagree about is drift, and drift fails loudly.
  it.each([["CWE-abc"], ["nonsense"], [89], [{}], [[]]])("still rejects %s as a cwe", (cwe) => {
    expect(() => parseFinding({ ...valid, cwe })).toThrow();
  });

  // Derived from the constant, not from a literal: the cap moved 300 → 500 and a
  // hardcoded 301 would have kept passing while asserting nothing.
  it("rejects a claim that sprawls past one sentence", () => {
    expect(() => parseFinding({ ...valid, claim: "x".repeat(CLAIM_MAX + 1) })).toThrow();
    expect(() => parseFinding({ ...valid, claim: "x".repeat(CLAIM_MAX) })).not.toThrow();
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

// The order findings are presented in (D-50). Pinned because the natural orders are
// both wrong: alphabetically "high, low, medium", by insertion whatever the engines
// happened to emit. The one that matters is worst first, and it matters most in the
// places that show only the top of the list.
describe("severity ordering", () => {
  it("declares SEVERITIES worst first, since the index IS the rank", () => {
    expect(SEVERITIES).toStrictEqual(["high", "medium", "low"]);
  });

  it("ranks medium as worse than low", () => {
    expect(severityRank("high")).toBeLessThan(severityRank("medium"));
    // The whole bug in one assertion: as text, "low" < "medium".
    expect(severityRank("medium")).toBeLessThan(severityRank("low"));
  });

  // Only reachable through a row written around the schema. First, not last: at the
  // bottom it would read as a nit, and it would be the first thing a cut discarded.
  it("ranks a severity it does not recognise first, not last", () => {
    const bogus = "catastrophic" as Severity;
    expect(severityRank(bogus)).toBeLessThan(severityRank("high"));
  });

  it("sorts worst first, then by file, then by line", () => {
    const f = (severity: Severity, file: string, line?: number) => ({
      severity,
      file,
      ...(line === undefined ? {} : { line }),
    });
    const shuffled = [
      f("low", "a.ts", 1),
      f("medium", "b.ts", 1),
      f("high", "z.ts", 9),
      f("medium", "a.ts", 40),
      f("medium", "a.ts", 2),
      f("medium", "a.ts"),
    ];
    expect([...shuffled].sort(compareFindings)).toStrictEqual([
      f("high", "z.ts", 9),
      // No line first within a file: file-level findings are about the whole file.
      f("medium", "a.ts"),
      f("medium", "a.ts", 2),
      f("medium", "a.ts", 40),
      f("medium", "b.ts", 1),
      f("low", "a.ts", 1),
    ]);
  });

  it("finds the worst severity present rather than the first one listed", () => {
    expect(worstSeverity(["low", "medium", "low"])).toBe("medium");
    expect(worstSeverity(["low", "high", "medium"])).toBe("high");
    expect(worstSeverity(["low"])).toBe("low");
    expect(worstSeverity([])).toBeUndefined();
  });
});
