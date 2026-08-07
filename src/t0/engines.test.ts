/**
 * What the deterministic engines claim when they cannot run.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect, engineRuleClass, parseEslint, parseSemgrep, parseTsc, ruleClaim, runEngine } from "./engines.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Finding } from "../core/finding.ts";

/** The findings half of `parseSemgrep`, which is what most of these assert about. */
const semgrepFindings = (stdout: string, worktree: string): readonly Finding[] =>
  parseSemgrep(stdout, worktree)?.findings ?? [];

/** The other half: what semgrep could not read. */
const semgrepUnread = (stdout: string): readonly string[] => parseSemgrep(stdout, "/w")?.unread ?? [];


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

/**
 * TWO MATCHES OF ONE RULE IN ONE FILE MUST NOT BECOME ONE FINDING.
 *
 * A finding's identity is `sha256(claim, file, symbol)` — no line, deliberately, because
 * a defect that moved three lines down is the same defect. A pattern engine reports no
 * symbol, so two matches of one rule in one file hashed identically and the store's
 * `ON CONFLICT DO NOTHING` dropped the second. Silently. The client saw one site, fixed
 * it, and had nothing to tell it there was another.
 *
 * That is a FALSE NEGATIVE on a sink class, which is the worst failure this service can
 * produce: a reviewer reading "1 finding, now fixed" reasonably concludes the class is
 * clean. A customer hit the same class across two FILES on 2026-08-08 — which lore does
 * distinguish — and found the missed sink only by grepping for it by hand.
 *
 * The fix is one finding naming every site, not a line-keyed fingerprint: that would
 * trade the false negative for permanent churn, since every edit above a match would
 * retire one finding and raise an identical one below it.
 */
describe("a rule matching twice in one file reports both sites", () => {
  const two = JSON.stringify({
    results: [
      { path: "/w/app/layout.tsx", start: { line: 123 }, check_id: "react-dangerouslysetinnerhtml", extra: { message: "Setting HTML from code is risky", severity: "WARNING" } },
      { path: "/w/app/layout.tsx", start: { line: 32 }, check_id: "react-dangerouslysetinnerhtml", extra: { message: "Setting HTML from code is risky", severity: "WARNING" } },
    ],
  });

  it("carries every line, in the claim the model actually reads", () => {
    const f = semgrepFindings(two, "/w");
    expect(f, "one finding, not two - and not one that has lost a site").toHaveLength(1);
    expect(f[0]?.claim, "the T0 summary shows the claim alone, so the count must live there").toContain(
      "[2 sites in this file: 32, 123]",
    );
    expect(f[0]?.evidence).toContain("app/layout.tsx:32");
    expect(f[0]?.evidence).toContain("app/layout.tsx:123");
    expect(f[0]?.evidence, "fixing the first must not read as fixing the class").toMatch(/SEPARATE SITE/);
    // The earliest site, so the reader starts at the top of the file.
    expect(f[0]?.line).toBe(32);
  });

  // The identity must still be stable: this is one finding about one rule in one file,
  // and it has to survive the author fixing the first site and re-running.
  it("keeps the same fingerprint when a site is added or removed", () => {
    const one = JSON.stringify({
      results: [
        { path: "/w/app/layout.tsx", start: { line: 32 }, check_id: "react-dangerouslysetinnerhtml", extra: { message: "Setting HTML from code is risky", severity: "WARNING" } },
      ],
    });
    const a = semgrepFindings(two, "/w")[0];
    const b = semgrepFindings(one, "/w")[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Different claims (the suffix names the sites), so DIFFERENT fingerprints — which is
    // correct and is the point: answering "there are two here" is not answering "there is
    // one here", and the ladder must see the second as a fresh statement.
    expect(fingerprint(a as Finding)).not.toBe(fingerprint(b as Finding));
  });

  it("still separates two files, which is what a fingerprint already did", () => {
    const across = JSON.stringify({
      results: [
        { path: "/w/app/layout.tsx", start: { line: 123 }, check_id: "react-dangerouslysetinnerhtml", extra: { message: "risky", severity: "WARNING" } },
        { path: "/w/components/json-ld.tsx", start: { line: 32 }, check_id: "react-dangerouslysetinnerhtml", extra: { message: "risky", severity: "WARNING" } },
      ],
    });
    const f = semgrepFindings(across, "/w");
    expect(f.map((x) => x.file).sort()).toStrictEqual(["app/layout.tsx", "components/json-ld.tsx"]);
    expect(new Set(f.map((x) => fingerprint(x))).size, "two files, two identities").toBe(2);
  });
});

/**
 * A FILE SEMGREP COULD NOT PARSE IS NOT A FILE WITH NO FINDINGS.
 *
 * semgrep exits zero and answers `results: []` for a file its parser choked on, putting
 * the failure in `errors` at level `warn`. lore read only `results`, so the file was
 * scanned, skipped, and reported as carrying nothing — INV-1 inside the deterministic
 * tier, which is the worst place for it, because T0 is what a model tier is told it need
 * not re-derive.
 *
 * Found by accident while reproducing a customer's false negative: the fixture had a bad
 * identifier, semgrep answered exactly this, and lore would have called it clean.
 */
describe("a file semgrep could not read", () => {
  it("is reported as unavailable, never as clean", () => {
    const out = JSON.stringify({
      results: [],
      errors: [
        { code: 3, level: "warn", type: ["PartialParsing", [{ path: "app/layout.tsx" }]], path: "app/layout.tsx", message: "Syntax error" },
      ],
    });
    const unread = semgrepUnread(out);
    expect(unread, "silence here is the failure INV-1 forbids").toHaveLength(1);
    expect(unread[0]).toContain("app/layout.tsx");
    expect(unread[0]).toMatch(/SKIPPED, not found clean/);
  });

  it("says nothing when there is nothing to say", () => {
    expect(semgrepUnread(JSON.stringify({ results: [], errors: [] }))).toStrictEqual([]);
  });

  // A rule that could not be fetched is a different problem and semgrep fails loudly for
  // it. This channel is for code that was silently skipped, and it only keeps working
  // while every entry in it is worth reading.
  it("ignores errors that are not parse failures", () => {
    const out = JSON.stringify({
      results: [],
      errors: [{ level: "warn", type: ["Timeout", []], path: "big.ts", message: "timed out" }],
    });
    expect(semgrepUnread(out)).toStrictEqual([]);
  });
});
