import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

  // EVERY optional field, not just the one that was reported.
  //
  // The `cwe` table above existed, the reasoning was written beside it, and the fix
  // was applied to that field instead of to the rule — so `symbol` and `line` kept
  // the identical defect. glm-5-turbo sent `symbol: null`, twice, and the whole
  // review failed: the schema is `.strict()` inside a batch parse, so one null
  // discards every finding in a reply that has already been paid for.
  //
  // Parameterised over the fields so adding an optional one without deciding this
  // question is not possible by accident.
  it.each([["cwe"], ["symbol"], ["line"]])("reads %s null/blank as absent, not as malformed", (field) => {
    for (const v of [undefined, null, "", "   "]) {
      const got = parseFinding({ ...valid, [field]: v });
      expect(got[field as keyof typeof got], `${field}=${JSON.stringify(v)}`).toBeUndefined();
    }
  });

  // Forgiving blank must not become forgiving anything, on any of them.
  it.each([
    ["symbol", 42],
    ["symbol", {}],
    ["line", "top"],
    ["line", 0],
    ["line", -1],
    ["line", 1.5],
  ])("still rejects %s = %s", (field, v) => {
    expect(() => parseFinding({ ...valid, [field]: v })).toThrow();
  });

  /**
   * FOLDS AN OVER-LONG CLAIM RATHER THAN THROWING THE FINDING AWAY (D-116). Reversed
   * deliberately, exactly as the severity case above was: this used to assert `toThrow()`,
   * and the cost was measured on this repository: a t2 finding — a ledger read ordered
   * before a bound check — was lost to `claim: Too big: expected string to have <=500
   * characters`, in the same review where two more were lost to the severity word D-115
   * had just fixed.
   *
   * Derived from the constant, not from a literal: the cap moved 300 → 500 and a
   * hardcoded 301 would have kept passing while asserting nothing.
   */
  /**
   * THE SAME RULE ON THE FIELDS IT HAD NOT REACHED. D-115 fixed `severity`, D-116 fixed
   * `claim`, and these two kept the identical defect one field along — which is exactly
   * how the first two came to exist. Parameterised over the fields so adding a third text
   * field without deciding this question is not possible by accident.
   */
  it.each([["evidence"], ["failureScenario"]])(
    "clamps an over-long %s instead of losing the finding",
    (field) => {
      const long = "word ".repeat(600); // 3000 chars, well past TEXT_MAX
      const got = parseFinding({ ...valid, [field]: long });
      const text = got[field as "evidence" | "failureScenario"];
      expect(text.length).toBeLessThanOrEqual(2000);
      // MARKED, never silent — the whole difference from the mid-clause truncation D-64
      // condemns is that a reader can see something was cut.
      expect(text.endsWith("…")).toBe(true);
    },
  );

  // Order matters: the claim fold WRITES into evidence, so clamping evidence first would
  // leave the join to overflow and lose the finding both folds exist to save.
  it("survives an over-long claim and an over-long evidence together", () => {
    const f = parseFinding({
      ...valid,
      claim: "c".repeat(CLAIM_MAX * 3),
      evidence: "e".repeat(5000),
    });
    expect(f.claim.length).toBeLessThanOrEqual(CLAIM_MAX);
    expect(f.evidence.length).toBeLessThanOrEqual(2000);
  });

  it("folds an over-long claim instead of losing the finding", () => {
    const long = `${"word ".repeat(CLAIM_MAX)}end`;
    const f = parseFinding({ ...valid, claim: long });
    expect(f.claim.length).toBeLessThanOrEqual(CLAIM_MAX);
    expect(f.claim.endsWith("…")).toBe(true);
  });

  // Nothing the author wrote may be lost — that is the whole difference between this and
  // the mid-clause truncation D-64's rationale condemns. Sized like the observed failure
  // (a claim a few hundred over the cap), which is the case this has to get right; the
  // pathological one is asserted separately below.
  it("carries the full claim into evidence, verbatim", () => {
    const long = `${"word ".repeat(140)}end`;
    expect(long.length).toBeGreaterThan(CLAIM_MAX);
    const f = parseFinding({ ...valid, claim: long });
    expect(f.evidence).toContain(long.trim());
    expect(f.evidence).toContain(valid.evidence);
    expect(f.evidence.length).toBeLessThanOrEqual(2000);
  });

  // Both fields share TEXT_MAX, so a claim longer than the whole evidence budget cannot be
  // carried whole AND leave the original evidence intact. The claim wins, because it is the
  // field that was about to cost the finding — and the clamp is marked, not silent. Asserted
  // rather than left implicit: this is the one case where the fold is lossy.
  it("prefers the claim over the original evidence when the claim alone exceeds TEXT_MAX", () => {
    const enormous = "word ".repeat(600); // 3000 chars, well past TEXT_MAX
    const f = parseFinding({ ...valid, claim: enormous, evidence: "original evidence" });
    expect(f.evidence.startsWith("Claim in full: word word")).toBe(true);
    expect(f.evidence.endsWith("…")).toBe(true);
    expect(f.evidence.length).toBeLessThanOrEqual(2000);
  });

  // A fold must not trade one refusal for another: evidence at its own cap plus a carried
  // claim would overflow TEXT_MAX and lose the finding this just rescued.
  it("keeps evidence inside its cap when both are at their limits", () => {
    const f = parseFinding({
      ...valid,
      claim: "x".repeat(CLAIM_MAX * 3),
      evidence: "e".repeat(2000),
    });
    expect(f.evidence.length).toBeLessThanOrEqual(2000);
    expect(f.claim.length).toBeLessThanOrEqual(CLAIM_MAX);
  });

  // The boundary itself is untouched: a claim exactly at the cap is not a fold candidate,
  // so it keeps its last character and gains no ellipsis and no evidence prefix.
  it("leaves a claim at exactly the cap alone", () => {
    const f = parseFinding({ ...valid, claim: "x".repeat(CLAIM_MAX) });
    expect(f.claim).toBe("x".repeat(CLAIM_MAX));
    expect(f.evidence).toBe(valid.evidence);
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

  /**
   * MAPS AN UNKNOWN SEVERITY RATHER THAN THROWING THE FINDING AWAY. Reversed
   * deliberately: this used to assert `toThrow()`, and the cost of that strictness was
   * measured on this repository — t1 raised a `critical` finding about an unbounded round
   * loop, the parse failed, and the whole report was discarded. What reached the client
   * was a `checks_skipped` line saying a finding existed and could not be shown: a review
   * that found something and said nothing, which is INV-1 exactly.
   *
   * The scale stays three (D-50). A model reaching for a fourth word is expressing
   * urgency, not proposing a taxonomy, so the word is mapped and the finding survives.
   */
  it("maps an unknown severity to high instead of losing the finding", () => {
    expect(parseFinding({ ...valid, severity: "critical" }).severity).toBe("high");
    expect(parseFinding({ ...valid, severity: "blocker" }).severity).toBe("high");
    // Unrecognised means ESCALATE, never bury: `severityRank` ranks an unknown first for
    // the same reason, and a nit misfiled as high costs a reader one line.
    expect(parseFinding({ ...valid, severity: "wat" }).severity).toBe("high");
  });

  it("maps the ordinary synonyms to the scale that exists", () => {
    expect(parseFinding({ ...valid, severity: "MODERATE" }).severity).toBe("medium");
    expect(parseFinding({ ...valid, severity: "informational" }).severity).toBe("low");
    expect(parseFinding({ ...valid, severity: " High " }).severity).toBe("high");
  });

  it("still rejects a severity that is not a word at all", () => {
    expect(() => parseFinding({ ...valid, severity: 3 })).toThrow();
    expect(() => parseFinding({ ...valid, severity: null })).toThrow();
  });
});

// D-64 said "the number is now in one place". It was not, and I wrote that sentence
// into SPEC without checking it.
//
// t2 found four survivors: `src/t0/engines.ts` and `src/security/osv.ts` both
// truncated claims at a hardcoded 300 — with an ellipsis, mid-clause, which is the
// exact failure D-64's own rationale gives for raising the cap rather than
// truncating — `src/knowledge/bootstrap.ts` told a model "max 300 characters", and
// `src/security/security.test.ts` asserted `<= 300` under the title "satisfy the
// finding schema's caps", so correcting osv.ts would have made that test fail and
// blocked its own fix.
//
// The consequence was worse than staleness: a 350-character claim from semgrep was
// silently cut while an identical one from a model passed intact, so the same
// finding got different treatment depending on which engine raised it.
//
// This is the check that makes the claim in SPEC true, mechanically, instead of by
// assertion — the same shape as `docs.test.ts`, and for the same reason.
// The rule, not the field. `cwe` was given a preprocess mapping null and blank to
// absent, with the reasoning written beside it, and `symbol`, `line` and all five
// optional MCP tool arguments kept the defect — because the fix went where the bug
// was reported instead of where it applied. It then went off: `symbol: null`, twice,
// and a whole review discarded.
//
// Zod's `.optional()` short-circuits on `undefined` alone, so a bare one always
// rejects `null` — and every caller here is a language model, which writes `null` for
// absent as readily as it omits the key.
describe("no schema field is optional without deciding what null means", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));

  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return e.isFile() && p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });

  it("routes every .optional() through absent()", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      // The helper itself is where `.optional()` is allowed to appear.
      if (file.endsWith("core/optional.ts")) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (line.includes(".optional()")) offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toStrictEqual([]);
  });
});

describe("the claim cap lives in exactly one place", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));

  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return e.isFile() && p.endsWith(".ts") ? [p] : [];
    });

  // Comments are exempt, and that is not a loophole — it is the same rule MEMO
  // follows. "glm-5.2 wrote a 325-character claim against a 300-character cap" is a
  // record of what was true then; rewriting it to say 500 would falsify the history
  // that justifies the current value. Three such lines exist and all three are
  // history. What must never appear is an EXECUTABLE 300: a cap, an assertion, or a
  // string handed to a model.
  const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

  it("is not hardcoded in any code path that caps or states it", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (isComment(line) || !/\bclaim\b/i.test(line)) return;
          // The shapes that drifted: `cap(claim, 300)`, `"max 300 characters"`,
          // `toBeLessThanOrEqual(300)`. The CURRENT value is matched too, so raising
          // the cap again cannot leave a fresh literal behind — this test has to
          // fail on its own next revision, not just on the last one.
          if (/\b(300|500)\b/.test(line) && !line.includes("CLAIM_MAX")) {
            offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toStrictEqual([]);
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
