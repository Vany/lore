/**
 * What the deterministic engines claim when they cannot run.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect, runEngine } from "./engines.ts";


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
});
