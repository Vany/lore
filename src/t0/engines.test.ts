/**
 * What the deterministic engines claim when they cannot run.
 */

import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scopePaths, detect, engineRuleClass, parseCargoJson, parseEslint, parseSemgrep, parseTsc, ruleClaim, runEngine } from "./engines.ts";
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

  // Fingerprint 6b8b5c00: gating on package.json alone reported both sbom and
  // osv "not configured" on a pure Go/PyPI/Rust/Maven/RubyGems repo — even with
  // cdxgen installed, which is exactly the tool that enumerates those five other
  // ecosystems.
  it("runs sbom and osv for a non-npm ecosystem with no package.json", () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/x\n");
    expect(detect(dir, "sbom")).toBe(true);
    expect(detect(dir, "osv")).toBe(true);
  });
});

/**
 * `Sbom.note` and `Sbom.incomplete` (security/sbom.ts) look alike — both are optional
 * strings on the same object — and reading the wrong one for "should this engine be
 * reported unavailable" is easy to get backwards without a test pinning it down.
 * `note` is a blanket methodology caveat `fromPackageLock` sets on EVERY fallback run,
 * cdxgen or not installed; `incomplete` is a genuine per-review count of components
 * cdxgen could not place in a queryable ecosystem. Only the second is a gap.
 */
describe("sbom: a fallback-path caveat is not the same claim as 'did not run'", () => {
  let dir: string;
  let binDir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-sbomnote-"));
    binDir = mkdtempSync(join(tmpdir(), "lore-sbomnote-bin-"));
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}:${savedPath ?? ""}`;
    writeFileSync(join(dir, "package.json"), "{}\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  // `npx` is faked to fail regardless of what actually happens to be cached on
  // whatever machine runs this test — the point under test is what `sbom()` does
  // with the fallback's note, not whether cdxgen is installed here.
  it("does not report a lockfile-fallback SBOM as unavailable", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(binDir, "npx"), 0o755);
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/lodash": { version: "4.17.21" } } }),
    );
    const out = await runEngine(dir, "sbom");
    expect(out.unavailable).toBeUndefined();
  });

  // The genuine gap DOES need to reach the reader, the same way semgrep's `unread`
  // does (below).
  it("reports a cdxgen component drop as unavailable", async () => {
    const cdxgenOutput = JSON.stringify({
      components: [
        { name: "lodash", version: "4.17.21", purl: "pkg:npm/lodash@4.17.21" },
        { name: "weird", version: "1.0.0", purl: "pkg:carthage/weird@1.0.0" },
      ],
    });
    writeFileSync(join(binDir, "npx"), `#!/bin/sh\necho '${cdxgenOutput}'\nexit 0\n`);
    chmodSync(join(binDir, "npx"), 0o755);
    const out = await runEngine(dir, "sbom");
    expect(out.unavailable).toMatch(/1 of 2 component/);
  });
});

/**
 * Fingerprint b03d0b1e: `detect()`'s own widening made `sbom()`'s own
 * "could not be enumerated" finding reachable on a repo with no package.json
 * at all — the finding used to hardcode `file: "package.json"` regardless,
 * a path that does not exist on a pure Go/PyPI/Rust/Maven/RubyGems repo.
 */
describe("sbom: the cannot-enumerate finding names a real manifest, not npm's", () => {
  let dir: string;
  let binDir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-sbomfile-"));
    binDir = mkdtempSync(join(tmpdir(), "lore-sbomfile-bin-"));
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}:${savedPath ?? ""}`;
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\nexit 1\n"); // no cdxgen
    chmodSync(join(binDir, "npx"), 0o755);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  it("names go.mod, not package.json, on a Go repo with no fallback lockfile reader", async () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/x\n");
    const out = await runEngine(dir, "sbom");
    expect(out.findings[0]?.file).toBe("go.mod");
  });
});

/**
 * A cdxgen SBOM that enumerated N components and dropped every one (a pure
 * Composer/NuGet tree, say) leaves `bom.components.length === 0` — the same
 * shape as a tree with genuinely nothing to enumerate. `osv()`'s early return
 * for that shape used to read only `bom.note`, which cdxgen never sets (it sets
 * `incomplete`), so the drop count was discarded in favour of a blanket
 * "nothing to query" — false on a tree cdxgen had, in fact, enumerated.
 */
describe("osv: a fully-dropped SBOM is a real gap, not 'nothing to query'", () => {
  let dir: string;
  let binDir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-osvdrop-"));
    execSync("git init -q", { cwd: dir });
    binDir = mkdtempSync(join(tmpdir(), "lore-osvdrop-bin-"));
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}:${savedPath ?? ""}`;
    writeFileSync(join(dir, "package.json"), "{}\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  it("reports the drop count, not 'nothing to query'", async () => {
    const cdxgenOutput = JSON.stringify({
      components: [{ name: "weird", version: "1.0.0", purl: "pkg:carthage/weird@1.0.0" }],
    });
    writeFileSync(join(binDir, "npx"), `#!/bin/sh\necho '${cdxgenOutput}'\nexit 0\n`);
    chmodSync(join(binDir, "npx"), 0o755);
    const out = await runEngine(dir, "osv");
    expect(out.unavailable).toMatch(/1 of 1 component/);
  });
});

/**
 * Fingerprint 10986564, found by lore's own review of the t0/runner.ts OOM fix: the
 * same wrong-reason defect removed from checkTypes/checkLint was still here. semgrep
 * and ast-grep run on the HOST via `runTool`, resolving a bare command name through
 * PATH — a fake executable placed first on PATH stands in for the real binary
 * without needing it installed, and confirms a SIGKILL (137) is reported honestly
 * instead of as "produced unparseable output", which points at the wrong thing.
 */
describe("a host engine the OS killed is never mistaken for a config problem", () => {
  let dir: string;
  let binDir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-killed-host-"));
    binDir = mkdtempSync(join(tmpdir(), "lore-killed-bin-"));
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}:${savedPath ?? ""}`;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  const fakeBinary = (name: string) => {
    const script = join(binDir, name);
    writeFileSync(script, "#!/bin/sh\necho 'partial output, truncated by the kill'\nexit 137\n");
    chmodSync(script, 0o755);
  };

  it("semgrep: a killed run is reported killed, not unparseable", async () => {
    fakeBinary("semgrep");
    const out = await runEngine(dir, "semgrep");
    expect(out.findings).toStrictEqual([]);
    expect(out.unavailable).toMatch(/killed/);
    expect(out.unavailable).not.toMatch(/unparseable/);
  });

  it("ast-grep: a killed run is reported killed, not unparseable", async () => {
    writeFileSync(join(dir, "sgconfig.yml"), "ruleDirs: []\n");
    fakeBinary("ast-grep");
    const out = await runEngine(dir, "ast-grep");
    expect(out.findings).toStrictEqual([]);
    expect(out.unavailable).toMatch(/killed/);
    expect(out.unavailable).not.toMatch(/unparseable/);
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
    for (const id of [
      "TS2345",
      "no-unused-vars",
      "javascript.lang.security.audit.sqli",
      "my-rules/no-raw-sql",
      // SCOPED IDS, which is most of what a TypeScript project enforces. Without the
      // leading `@` these yielded no class, so an appeal against one was accepted, the
      // fingerprint settled, and no suppression was recorded — the check went on firing
      // and nothing said why. D-83 quietly did not work for the common case.
      "@typescript-eslint/no-floating-promises",
      "@next/next/no-img-element",
      // CLIPPY'S OWN IDS, module-path-shaped the same way — the identical D-83 gap,
      // reopened for `:` instead of `@` until RULE_CLASS's body class allowed it too.
      "clippy::needless_return",
    ]) {
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

  it("survives clippy's real output, colon-shaped id included", () => {
    const line = JSON.stringify({
      reason: "compiler-message",
      message: {
        message: "this returns unconditionally",
        code: { code: "clippy::needless_return", explanation: null },
        level: "warning",
        spans: [{ file_name: "src/lib.rs", line_start: 8, is_primary: true }],
      },
    });
    const findings = parseCargoJson("cargo-clippy", line, ".");
    expect(findings.map((f) => engineRuleClass(f.claim))).toStrictEqual(["clippy::needless_return"]);
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
      // And the leading `@` must not re-open the sentence hole: OSV writes a scoped
      // package the same way, and its second `@` ends the match before any colon.
      "@scope/pkg@1.0.0 is affected by CVE-2021-23337: command injection",
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

  it("carries every line, in the evidence", () => {
    const f = semgrepFindings(two, "/w");
    expect(f, "one finding, not two - and not one that has lost a site").toHaveLength(1);
    expect(f[0]?.evidence).toContain("app/layout.tsx:32");
    expect(f[0]?.evidence).toContain("app/layout.tsx:123");
    expect(f[0]?.evidence, "fixing the first must not read as fixing the class").toMatch(/2 SEPARATE SITES/);
    // The earliest site, so the reader starts at the top of the file.
    expect(f[0]?.line).toBe(32);
  });

  /**
   * AND NOTHING ABOUT THE SITES REACHES THE CLAIM, which is the fingerprint.
   *
   * The count and the line numbers went into the claim first, so the model's one-line T0
   * summary would carry them — reintroducing exactly the churn grouping was chosen to
   * avoid, in the same change, under a comment saying it had been avoided. Any edit above
   * a multi-site match renumbers the sites, which rewrites the claim, which changes the
   * identity: the old finding can never settle and a new one takes its place for ever.
   *
   * Fixing one of two sites does it through the count alone — the moment the author is
   * actually answering, which is the worst moment to lose the thread.
   */
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
    expect(a?.claim, "the sites live in the evidence, never here").not.toMatch(/site|32|123/);
    expect(fingerprint(a as Finding)).toBe(fingerprint(b as Finding));
  });

  // The line moving is the other half of the same property: it is not in the hash either.
  it("keeps the same fingerprint when every site shifts down the file", () => {
    const moved = JSON.stringify({
      results: [
        { path: "/w/app/layout.tsx", start: { line: 140 }, check_id: "react-dangerouslysetinnerhtml", extra: { message: "Setting HTML from code is risky", severity: "WARNING" } },
        { path: "/w/app/layout.tsx", start: { line: 49 }, check_id: "react-dangerouslysetinnerhtml", extra: { message: "Setting HTML from code is risky", severity: "WARNING" } },
      ],
    });
    const a = semgrepFindings(two, "/w")[0];
    const b = semgrepFindings(moved, "/w")[0];
    expect(fingerprint(a as Finding)).toBe(fingerprint(b as Finding));
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

/**
 * AND THE SAME FOR THE ENGINES THAT RUN ON EVERY REVIEW.
 *
 * The multi-site fix landed on semgrep and ast-grep and not on eslint or tsc — so the
 * exact defect the change was written for stayed live in the two engines that run most
 * often.
 *
 * THE KEY IS THE CLAIM, not the rule id, because the claim is what the fingerprint
 * hashes. That distinction matters most here: two `TS2345`s carry different messages and
 * are different errors, so keying on the code would MERGE them — losing one, which is the
 * same harm as the collapse arrived at from the other side. semgrep collapses precisely
 * because its claim is the rule's generic message, identical at every match.
 */
describe("eslint and tsc group only genuinely identical diagnostics", () => {
  it("groups two identical eslint messages and leaves distinct ones alone", () => {
    const json = JSON.stringify([
      {
        filePath: "/w/src/a.ts",
        messages: [
          { ruleId: "eqeqeq", severity: 2, message: "Expected === and instead saw ==.", line: 4 },
          { ruleId: "eqeqeq", severity: 2, message: "Expected === and instead saw ==.", line: 40 },
          { ruleId: "no-unused-vars", severity: 2, message: "'x' is unused.", line: 12 },
        ],
      },
    ]);
    const f = parseEslint(json, "/w") ?? [];
    expect(f, "the two identical ones become one; the distinct one stays its own").toHaveLength(2);
    const eq = f.find((x) => x.claim.startsWith("eqeqeq"));
    expect(eq?.evidence).toContain("src/a.ts:4");
    expect(eq?.evidence).toContain("src/a.ts:40");
    expect(eq?.evidence).toMatch(/2 SEPARATE SITES/);
    expect(eq?.claim, "the sites live in the evidence, never in the hash").not.toMatch(/site|:40/);
    expect(eq?.line, "the earliest site, so the reader starts at the top").toBe(4);
  });

  // Two of one rule with DIFFERENT messages are two defects, and merging them would lose
  // one — the collapse this fixes, from the other direction.
  it("does not merge one eslint rule's differing messages", () => {
    const json = JSON.stringify([
      {
        filePath: "/w/src/a.ts",
        messages: [
          { ruleId: "no-unused-vars", severity: 2, message: "'x' is unused.", line: 4 },
          { ruleId: "no-unused-vars", severity: 2, message: "'y' is unused.", line: 40 },
        ],
      },
    ]);
    expect(parseEslint(json, "/w") ?? []).toHaveLength(2);
  });

  it("groups a tsc message a file has many of", () => {
    const out = [
      "src/a.ts(3,7): error TS2532: Object is possibly 'undefined'.",
      "src/a.ts(31,7): error TS2532: Object is possibly 'undefined'.",
      "src/b.ts(9,1): error TS2532: Object is possibly 'undefined'.",
    ].join("\n");
    const f = parseTsc(out);
    expect(f.map((x) => x.file).sort()).toStrictEqual(["src/a.ts", "src/b.ts"]);
    const a = f.find((x) => x.file === "src/a.ts");
    expect(a?.line).toBe(3);
    expect(a?.evidence).toContain("src/a.ts:31");
  });

  it("does not merge two tsc errors that merely share a code", () => {
    const out = [
      "src/a.ts(3,7): error TS2345: Argument of type 'x' is not assignable.",
      "src/a.ts(31,7): error TS2345: Argument of type 'y' is not assignable.",
    ].join("\n");
    expect(parseTsc(out), "different messages are different errors").toHaveLength(2);
  });

  // A single diagnostic must be unchanged — this is a grouping, not a rewrite, and tsc's
  // one-site evidence is the raw compiler line, which is what a reader wants.
  it("leaves a single tsc diagnostic exactly as it was", () => {
    const one = "src/a.ts(3,7): error TS2345: Argument of type 'x' is not assignable.";
    const f = parseTsc(one);
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toBe(one);
    expect(f[0]?.line).toBe(3);
  });
});

/**
 * `cargo check`/`cargo clippy --message-format=json` (D-131). Schema verified
 * against the Cargo Book and rustc's own JSON diagnostic docs before writing this —
 * these fixtures are shaped the way those documents describe, not guessed at.
 */
describe("cargo's JSON is a different shape and needs its own parsing", () => {
  const compilerMessage = (over: {
    level: "error" | "warning";
    code?: string | null;
    message?: string;
    file?: string;
    line?: number;
    primary?: boolean;
  }): string =>
    JSON.stringify({
      reason: "compiler-message",
      message: {
        message: over.message ?? "diagnostic",
        code: over.code === undefined ? { code: "some_lint" } : over.code === null ? null : { code: over.code },
        level: over.level,
        spans:
          over.file === undefined
            ? []
            : [{ file_name: over.file, line_start: over.line ?? 1, is_primary: over.primary ?? true }],
      },
    });

  it("error becomes high, warning becomes medium", () => {
    const out = [
      compilerMessage({ level: "error", file: "src/a.rs", code: "E0308" }),
      compilerMessage({ level: "warning", file: "src/b.rs", code: "dead_code" }),
    ].join("\n");
    const f = parseCargoJson("cargo-check", out, ".");
    expect(f.find((x) => x.file === "src/a.rs")?.severity).toBe("high");
    expect(f.find((x) => x.file === "src/b.rs")?.severity).toBe("medium");
  });

  // A whole-crate summary ("aborting due to 2 previous errors") carries no span at
  // all — dropped rather than turned into a finding with no site, matching how every
  // other engine here only ever produces site-anchored findings.
  it("drops a whole-crate summary that names no site", () => {
    const out = [
      compilerMessage({ level: "error", file: "src/a.rs" }),
      compilerMessage({ level: "error" }), // no `file`, so no spans at all
    ].join("\n");
    expect(parseCargoJson("cargo-check", out, ".")).toHaveLength(1);
  });

  // note/help only ever appear NESTED inside a parent's own `children` array in
  // cargo's real output, never as their own top-level `reason: "compiler-message"`
  // entries — verified against the rustc JSON docs, not assumed. Filtering top-level
  // entries to error/warning is enough on its own; nothing here needs to read
  // `children` at all, and this fixture proves a bare note-shaped top-level entry
  // (however it got there) does not leak through as a finding either.
  it("does not surface note/help level as their own findings", () => {
    const out = [
      compilerMessage({ level: "error", file: "src/a.rs" }),
      JSON.stringify({
        reason: "compiler-message",
        message: { message: "`#[warn(...)]` on by default", code: null, level: "note", spans: [] },
      }),
    ].join("\n");
    expect(parseCargoJson("cargo-check", out, ".")).toHaveLength(1);
  });

  // `compiler-artifact` and `build-finished` are the other real `reason` values
  // cargo's own JSON stream carries — build progress, not diagnostics.
  it("ignores every reason except compiler-message", () => {
    const out = [
      JSON.stringify({ reason: "compiler-artifact", package_id: "x" }),
      JSON.stringify({ reason: "build-finished", success: false }),
      "",
      "not json at all",
    ].join("\n");
    expect(parseCargoJson("cargo-check", out, ".")).toStrictEqual([]);
  });

  it("groups a clippy lint a file has many of, same as eslint's own", () => {
    const out = [
      compilerMessage({ level: "warning", code: "clippy::needless_return", file: "src/a.rs", line: 3 }),
      compilerMessage({ level: "warning", code: "clippy::needless_return", file: "src/a.rs", line: 30 }),
    ].join("\n");
    const f = parseCargoJson("cargo-clippy", out, ".");
    expect(f).toHaveLength(1);
    expect(f[0]?.line).toBe(3);
    expect(f[0]?.evidence).toContain("src/a.rs:3");
    expect(f[0]?.evidence).toContain("src/a.rs:30");
    expect(f[0]?.evidence).toMatch(/2 SEPARATE SITES/);
  });

  // CLIPPY REPEATS EVERY PLAIN RUSTC DIAGNOSTIC TOO — found by lore's own review,
  // fingerprint d269a60f, and confirmed empirically: `cargo clippy`'s own JSON for
  // a fixture with one plain `unused_variables` warning (no clippy lint involved
  // at all) reported it byte-identical to `cargo check`'s. Without filtering, the
  // SAME diagnostic would reach the model tier's prompt twice, once tagged each
  // engine, with an identical claim string — doubling both the noise and the
  // reported count. Kept to `clippy::`-prefixed codes for the clippy engine only;
  // `cargo-check` stays untouched, since it is the one authoritative source for
  // everything that is not clippy's own lint.
  it("keeps only clippy's own lints for the clippy engine — plain rustc diagnostics are cargo-check's job", () => {
    const out = [
      compilerMessage({ level: "warning", code: "unused_variables", file: "src/a.rs", line: 2 }),
      compilerMessage({ level: "warning", code: "clippy::needless_return", file: "src/a.rs", line: 5 }),
    ].join("\n");
    const clippy = parseCargoJson("cargo-clippy", out, ".");
    expect(clippy).toHaveLength(1);
    expect(clippy[0]?.line).toBe(5);
    // Unaffected: cargo-check keeps the plain rustc diagnostic (and would keep a
    // clippy-shaped one too, if it somehow appeared there — check is not filtered).
    const check = parseCargoJson("cargo-check", out, ".");
    expect(check).toHaveLength(2);
  });

  // THE REBASING FIX ITSELF, AS A TEST — found by lore's own review, fingerprint
  // 47ddd7fa, and confirmed empirically against a real `cargo check --manifest-path
  // server/Cargo.toml` run: cargo's own `file_name` is relative to the manifest's
  // directory, not the repo root. A nested crate (D-129's `teammater` shape) must
  // have that directory prefixed back on, or the finding names a file that is not
  // where it claims.
  it("rebases a nested crate's file_name onto its own directory", () => {
    const out = compilerMessage({ level: "warning", file: "src/main.rs", line: 2 });
    const f = parseCargoJson("cargo-check", out, "server");
    expect(f[0]?.file).toBe("server/src/main.rs");
  });

  it("detects a root Cargo.toml, and reports absence honestly", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-cargo-detect-"));
    try {
      expect(detect(dir, "cargo-check")).toBe(false);
      expect(detect(dir, "cargo-clippy")).toBe(false);
      writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
      expect(detect(dir, "cargo-check")).toBe(true);
      expect(detect(dir, "cargo-clippy")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * What a pattern engine is pointed at (D-92).
 *
 * Vany: *"call t0 only if diff was applied. and only on this files."* A pattern engine
 * matches one file at a time, so scanning a monorepo to review a ten-file branch buys
 * nothing — measured on rigid-monorepo, t0 is 230s at the median and runs at the head of
 * every round.
 *
 * The bound and the fallback are the whole safety story here: too many paths WIDENS the
 * scan rather than truncating it, because a silently narrowed scan is a gate that reports
 * clean about code nobody read.
 */
describe("which paths an engine is given", () => {
  it("uses the changed files when there are some", () => {
    expect(scopePaths(["src/a.ts", "src/b.ts"])).toStrictEqual(["--", "./src/a.ts", "./src/b.ts"]);
  });

  /**
   * A FILENAME FROM THE BRANCH IS NOT A VALUE WE CHOSE.
   *
   * Before D-92 the only positional was the constant `"."`. Splicing repo-relative names
   * onto the argv made a root file called `--config` parse as an OPTION — and eat the next
   * path as its value, which a second file in the same branch could supply as a crafted
   * ruleset. `git add --` commits such a name happily, and lore reviews branches it does
   * not trust.
   */
  it("cannot be talked into reading a filename as an option", () => {
    const out = scopePaths(["--config", "evil.yml"]);
    expect(out[0], "the terminator comes first").toBe("--");
    expect(out).not.toContain("--config");
    expect(out, "and each path is unmistakably a path").toStrictEqual(["--", "./--config", "./evil.yml"]);
  });

  it("leaves an already-anchored path alone", () => {
    expect(scopePaths(["./a.ts", "/tmp/b.ts"])).toStrictEqual(["--", "./a.ts", "/tmp/b.ts"]);
  });

  // Absent means "no diff was computed", which is every caller that existed before this.
  // It must keep meaning the whole tree, or adding a parameter would silently narrow
  // every one of them.
  it("scans the tree when nothing was given", () => {
    expect(scopePaths(undefined)).toStrictEqual(["--", "."]);
  });

  // An EMPTY list is not "scan nothing". A review whose diff computed to no files at all
  // is a broken measurement, and answering it with an empty argv would make semgrep scan
  // the working directory anyway on some versions and nothing on others.
  it("scans the tree when the list is empty", () => {
    expect(scopePaths([])).toStrictEqual(["--", "."]);
  });

  // An argv is not unbounded. Falling back widens, which is the safe direction for a
  // bound nobody can see from outside.
  it("scans the tree rather than building an argv too long to run", () => {
    const many = Array.from({ length: 500 }, (_, i) => `src/f${String(i)}.ts`);
    expect(scopePaths(many)).toStrictEqual(["--", "."]);
  });
});
