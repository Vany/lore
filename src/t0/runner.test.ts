/**
 * What T0 tells the model tiers.
 *
 * The interesting part is the cut. `renderT0` lists a bounded number of findings and
 * they arrive grouped by engine, so the order decides which facts the tier is given
 * about the tree it is reviewing. The findings themselves are not lost — `runRound`
 * records every one of them — but a tier that is not told the suite fails is judging
 * the code without knowing that.
 */

import { describe, expect, it } from "vitest";
import type { Finding } from "../core/finding.ts";
import { renderT0, renderT0Delta } from "./runner.ts";
import { CODE_ARCH } from "../core/review-type.ts";
import { runEngine } from "./engines.ts";
import type { T0Engine } from "../core/review-type.ts";

const f = (severity: Finding["severity"], file: string): Finding => ({
  file,
  severity,
  claim: `claim about ${file}`,
  evidence: "e",
  failureScenario: "s",
});

describe("renderT0", () => {
  it("says plainly what did not run, rather than implying it was clean", () => {
    const out = renderT0({ findings: [], outcomes: [], unavailable: ["tsc: not configured"], skipped: [] });
    expect(out).toContain("Deterministic tooling found nothing.");
    expect(out).toContain("NOT RUN");
    expect(out).toContain("tsc: not configured");
  });

  it("lists findings worst first", () => {
    const out = renderT0({
      findings: [f("low", "a.ts"), f("high", "b.ts"), f("medium", "c.ts")],
      outcomes: [],
      unavailable: [], skipped: [],
    });
    const lines = out.split("\n").filter((l) => l.startsWith("  ["));
    expect(lines.map((l) => l.slice(0, 10))).toStrictEqual(["  [high] b", "  [medium]", "  [low] a."]);
  });

  // D-50. Engines run in the order the review type lists them — for code-arch,
  // `tests` is last — so before this a flood of eslint output displaced the two
  // `high` findings the tests stage raises, and the tier was handed 200 nits instead.
  it("sorts before it truncates, so the cut drops the least severe", () => {
    const nits = Array.from({ length: 250 }, (_, i) => f("low", `nit${String(i).padStart(3, "0")}.ts`));
    const out = renderT0({
      findings: [...nits, f("high", "broken.ts")],
      outcomes: [],
      unavailable: [], skipped: [],
    });

    expect(out).toContain("[high] broken.ts");
    expect(out).toContain("Deterministic tooling found 251 issue(s)");
    // 251 findings, 200 listed. The 51 omitted are the tail of the sorted list, so
    // the sentence claiming they are no worse than the last one shown is true.
    expect(out).toContain("… and 51 more, none more severe than the last line above");
    const listed = out.split("\n").filter((l) => l.startsWith("  ["));
    expect(listed).toHaveLength(200);
    expect(listed.every((l, i) => i === 0 || !l.startsWith("  [high]"))).toBe(true);
  });
});

// D-24 is a boundary, not a preference: the service container holds the knowledge
// base, the attestation signing key and every provider credential, so nothing the
// TARGET controls may execute in it.
//
// `tsc` and `eslint` used to run there through `npx --no-install`, which resolves
// out of the target's own `node_modules` — the same dependency tree the sandbox
// exists to contain. The sandbox had a second door with no lock on it.
describe("nothing the target controls runs in the service", () => {
  // D-71: `tests` was in this list and is no longer an engine at all. lore reads a
  // suite and never runs it, so there is nothing here to contain — the strongest
  // version of the boundary, since code that is never executed cannot escape.
  it("does not know about a test engine, because there is not one", () => {
    expect(CODE_ARCH.t0).not.toContain("tests");
  });

  it.each([["tsc"], ["eslint"]])("refuses to run %s on the host", async (engine) => {
    const out = await runEngine(process.cwd(), engine as T0Engine);
    expect(out.findings).toStrictEqual([]);
    expect(out.unavailable).toMatch(/runs in the sandbox/);
  });

  // The engines that stay are lore's OWN binaries reading files. They need no
  // install and execute nothing from the dependency tree.
  it("still runs its own scanners here", async () => {
    const out = await runEngine(process.cwd(), "ast-grep");
    expect(out.unavailable ?? "").not.toMatch(/runs in the sandbox/);
  });
});

/**
 * THE SESSION GETS THE DELTA, NOT THE REPEAT (D-108). A kept session's fix message used
 * to re-render every still-present t0 finding — the cold-start tax paid again in
 * miniature. What moved is what it needs; its memory holds the rest.
 */
describe("renderT0Delta", () => {
  const fp = (f: { file: string; line?: number; claim: string }) => `${f.file}:${String(f.line ?? 0)}:${f.claim}`;
  const F = (file: string, line: number, claim: string, severity = "medium") =>
    ({ file, line, claim, severity, evidence: "e", failureScenario: "x" }) as never;
  const seen = (file: string, line: number, claim: string, severity = "medium") => ({
    fingerprint: `${file}:${String(line)}:${claim}`, file, line, severity, claim,
  });

  it("names what resolved, what is new, and how much stands", () => {
    const out = renderT0Delta(
      [seen("a.ts", 1, "old bug"), seen("b.ts", 2, "still here")],
      { findings: [F("b.ts", 2, "still here"), F("c.ts", 3, "brand new", "high")], outcomes: [], skipped: [], unavailable: [] },
      fp as never,
    );
    expect(out).toContain("1 resolved, 1 new, 1 unchanged");
    expect(out).toContain("resolved: a.ts:1 — old bug");
    expect(out).toContain("[high] NEW c.ts:3 — brand new");
    expect(out, "the unchanged one is a count, not a repeat").not.toContain("still here");
  });

  it("says still-nothing in one line when both sides are empty", () => {
    const out = renderT0Delta([], { findings: [], outcomes: [], skipped: [], unavailable: [] }, fp as never);
    expect(out).toContain("still nothing");
  });

  it("says unchanged in one line when nothing moved", () => {
    const out = renderT0Delta(
      [seen("a.ts", 1, "x")],
      { findings: [F("a.ts", 1, "x")], outcomes: [], skipped: [], unavailable: [] },
      fp as never,
    );
    expect(out).toContain("unchanged — the 1 issue(s) you already know still stand");
  });

  // NOT-RUN is never delta'd: "nothing checked this" is the one fact repetition cannot
  // cheapen (INV-1).
  it("repeats the not-run section every time, whatever moved", () => {
    const out = renderT0Delta([], { findings: [], outcomes: [], skipped: [], unavailable: ["eslint: no config"] }, fp as never);
    expect(out).toContain("NOT RUN");
    expect(out).toContain("eslint: no config");
  });
});
