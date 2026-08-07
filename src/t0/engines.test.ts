/**
 * What the deterministic engines claim when they cannot run.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect, engineRuleClass, parseEslint, parseTsc, ruleClaim, runEngine } from "./engines.ts";


// ast-grep reported itself missing on every review of every repository lore has ever
// met — 5 of 7 runs on the customer's repo — for a check that never existed to be
// skipped. It needs project-authored structural rules to say anything at all.
//
// `unavailable` is what the client repeats to its user so a `passed` is not
// over-read. It only keeps working while every entry is worth reading, and a list
// that always contains the same noise is a list nobody reads — including on the day
// it says "the test suite did not run".
describe("an optional engine's absence is not a gap in the review", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-optin-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports ast-grep with no rules as skipped, never as unavailable", async () => {
    const out = await runEngine(dir, "ast-grep");
    expect(out.skipped).toMatch(/optional/);
    expect(out.unavailable).toBeUndefined();
    expect(out.findings).toStrictEqual([]);
  });

  // The contrast that makes the distinction meaningful: a JS project with no
  // typecheck config HAS a gap, and saying so is the point.
  it("still reports a missing typecheck as a gap", async () => {
    const out = await runEngine(dir, "sbom");
    expect(out.unavailable).toMatch(/not configured/);
    expect(out.skipped).toBeUndefined();
  });

  it("runs ast-grep when the project has written rules", () => {
    writeFileSync(join(dir, "sgconfig.yml"), "ruleDirs: [rules]\n");
    expect(detect(dir, "ast-grep")).toBe(true);
  });

  // `osv` shared `sbom`'s gate, so a repository that vendors purely by gitlink — no
  // package.json anywhere — skipped the vulnerability check entirely and reported
  // nothing. The two questions are not the same one: an SBOM enumerates packages,
  // OSV also answers about commits.
  it("runs osv for a submodule-only repository that has no package.json", () => {
    writeFileSync(join(dir, ".gitmodules"), '[submodule "vendor/pay"]\n\tpath = vendor/pay\n');
    expect(detect(dir, "osv")).toBe(true);
    expect(detect(dir, "sbom")).toBe(false);
  });
});

/**
 * A T0 finding has to carry which RULE fired, and a `Finding` has nowhere to put it.
 *
 * The schema is the wire contract with the models, so a field meaningless to them does
 * not belong in it — which leaves the head of the claim, `<rule id>: <message>`. D-83
 * turns that convention into something load-bearing: an accepted appeal suppresses a
 * rule CLASS for a path, and the class is read back off this string.
 *
 * So the property under test is the ROUND TRIP, not the shape of either half. `ruleClaim`
 * writes and `engineRuleClass` reads; either alone is a decision written twice.
 */
describe("an engine finding says which rule fired", () => {
  it("reads back the id every engine wrote", () => {
    for (const id of ["TS2345", "no-unused-vars", "javascript.lang.security.audit.sqli", "my-rules/no-raw-sql"]) {
      expect(engineRuleClass(ruleClaim(id, "some message", "fallback"))).toBe(id);
    }
  });

  it("reads back the fallback when the tool named no rule", () => {
    expect(engineRuleClass(ruleClaim(undefined, "rule matched", "semgrep"))).toBe("semgrep");
  });

  // The real parser output, so the convention is checked against the engines rather
  // than against a literal that agrees with the test by construction.
  it("survives tsc's real output", () => {
    const findings = parseTsc("src/a.ts(3,7): error TS2345: Argument of type 'x' is not assignable.");
    expect(findings.map((f) => engineRuleClass(f.claim))).toStrictEqual(["TS2345"]);
  });

  it("survives eslint's real output", () => {
    const json = JSON.stringify([
      { filePath: "/w/src/a.ts", messages: [{ ruleId: "no-unused-vars", severity: 2, message: "'x' is unused.", line: 4 }] },
    ]);
    expect((parseEslint(json, "/w") ?? []).map((f) => engineRuleClass(f.claim))).toStrictEqual(["no-unused-vars"]);
  });

  /**
   * NOTHING APPEALS ITS WAY PAST A RED SUITE.
   *
   * A script failure carries the command, not a rule — and a suppression is granted per
   * CLASS, so a class here would let one accepted appeal silence "the tests fail" for a
   * whole file, permanently, on the strength of a rule about something else entirely.
   * The claim has a space before its colon, so no class comes out of it, and there is
   * nothing to suppress by.
   */
  it("gives no class to a claim that is a sentence", () => {
    for (const claim of [
      "`npm test` fails on this branch",
      "dependencies do not install with npm, so nothing that needs them could run",
      "lodash@4.17.20 is affected by CVE-2021-23337: command injection",
      "submodule vendor/x is pinned at a commit affected by CVE-2020-1: bad",
    ]) {
      expect(engineRuleClass(claim), claim).toBeUndefined();
    }
  });
});
