/**
 * What T0 tells the model tiers.
 *
 * The interesting part is the cut. `renderT0` lists a bounded number of findings and
 * they arrive grouped by engine, so the order decides which facts the tier is given
 * about the tree it is reviewing. The findings themselves are not lost — `runRound`
 * records every one of them — but a tier that is not told the suite fails is judging
 * the code without knowing that.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "../core/finding.ts";
import { renderT0, renderT0Delta, runT0 } from "./runner.ts";
import { CODE_ARCH } from "../core/review-type.ts";
import { runEngine } from "./engines.ts";
import type { T0Engine } from "../core/review-type.ts";
import type { SandboxConfig } from "./sandbox.ts";

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
 * D-127: host engines and the sandbox used to run one after the other for no reason
 * beyond argument order — an unrelated multi-minute install held up a two-second
 * ast-grep/semgrep pair in production. They now run concurrently. No engine here asks
 * for `tsc` or `eslint`, so the sandbox phase short-circuits before touching docker
 * (`wanted.length === 0`) and this stays a fast test — what it proves is that merging
 * two `Promise.all` branches back together did not scramble the result, not that it
 * is fast (that claim is a wall-clock one, verified live, not in a unit test).
 *
 * RUNS AGAINST AN EMPTY TEMP DIRECTORY, not this repo — found twice by lore's own
 * review of this same test. First against `semgrep` (`detect()` is unconditionally
 * true, so it shells out for real on any machine that has it — a natural machine for
 * this project — fetching the registry ruleset against vitest's 5s default timeout).
 * Then, after swapping in `sbom`, against `sbom` too: `npx --no-install` does not mean
 * "no network", it means "do not fall back to installing" — on a machine with cdxgen
 * cached OR globally installed (`npm i -g @cyclonedx/cdxgen`, cdxgen's own documented
 * setup), `npx --no-install` runs it for real, same failure shape. Both engines gate
 * on a REPO FILE (`sgconfig.yml`, `package.json`) before touching a binary at all, so
 * an empty directory makes both report `unavailable`/`skipped` without executing
 * anything — hermetic regardless of what is installed on whatever machine runs this.
 */
describe("runT0 merges the host and sandbox branches", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-runt0-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns one outcome per requested engine, in request order", async () => {
    const out = await runT0(dir, { engines: ["ast-grep", "sbom"] });
    expect(out.outcomes.map((o) => o.engine)).toStrictEqual(["ast-grep", "sbom"]);
    // Both unavailable/skipped, never a real finding — the point is they did not run,
    // confirming the directory truly has neither config file rather than happening to
    // report nothing found.
    expect(out.findings).toStrictEqual([]);
  });

  it("asking for nothing produces nothing, not a crash", async () => {
    const out = await runT0(dir, { engines: [] });
    expect(out.outcomes).toStrictEqual([]);
    expect(out.findings).toStrictEqual([]);
  });
});

/**
 * A killed sandboxed run used to be able to reach `parseTsc`/`parseEslint` before
 * anything checked the exit code — found live: lore's own tsc check was OOM-killed
 * mid-run, and the partial output already sitting in the buffer was silently
 * returned as `findings`, indistinguishable from a complete, honest result.
 * `checkTypes` and `checkLint` check `ranOutOfMemory(r)` before attempting to
 * parse, everywhere they call `runInSandbox` directly — and `sandboxed()` itself
 * checks it for `install()`. Findings from three rounds of lore's own review of
 * this fix, tested here: bd0f45f3, an OOM-killed install fell into the same
 * handling as a genuine one and came out as a confident, wrong claim that the
 * branch's dependencies do not install; fde373d4, a related but memory-independent
 * hole in the bare-tsc branch where a non-137 failure whose output does not match
 * tsc's error format also used to read as a clean pass; cbb6824f, the cgroup's
 * SIGKILL (137) is not the only way a memory limit ends a run — V8 can abort on
 * its OWN heap ceiling too, which `ranOutOfMemory` now also recognises; 9171c6c9,
 * that recognition has to match V8's full, distinctive crash phrase rather than a
 * fragment ordinary content (this file's own tests, after this fix landed) could
 * contain; 1fa9229d, fde373d4's own fix overclaimed — the bare-tsc branch runs
 * speculatively, with no script the target declared, so an unparseable failure
 * there is reported `unavailable`, not a "fails on this branch" finding; and
 * a7f2d87c, the content match itself has to be gated on `!r.ok` — a run that
 * exits 0 is not the process WE killed, whatever its own logs happen to quote.
 * (10986564, the same fix one file over in `engines.ts` for host-run semgrep/
 * ast-grep, is tested in `engines.test.ts` instead.)
 *
 * Exercised end to end through `runT0`, with a stand-in `docker`: `execFile`
 * (exec.ts) does not go through a shell, so it happily runs an arbitrary executable
 * given by absolute path, and `SandboxConfig.runtime` is just that path — no real
 * docker, no network, so this stays hermetic and fast.
 */
describe("a run the sandbox itself killed is never mistaken for a clean or partial one", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-t0-killed-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const baseSandbox = (runtime: string): SandboxConfig => ({
    image: "unused",
    cacheRoot: join(dir, "cache"),
    scratchRoot: join(dir, "scratch"),
    uid: 1000,
    gid: 1000,
    memory: "6g",
    cpus: "2",
    timeoutMs: 30_000,
    runtime,
  });

  // Content lives in its own file rather than inlined into the shell script text,
  // so nothing here has to worry about quoting JSON (eslint's fake output) inside a
  // `sh -c` string. Succeeds on its first call (install) and reports `exitCode`
  // with `stdoutOnKill` on its second (the actual check) — 137 (the cgroup's own
  // SIGKILL) unless told otherwise.
  const fakeDocker = (stdoutOnKill: string, exitCode = 137): SandboxConfig => {
    const script = join(dir, "fake-docker.sh");
    const called = join(dir, ".called");
    const output = join(dir, "fake-stdout.txt");
    writeFileSync(output, stdoutOnKill);
    writeFileSync(
      script,
      "#!/bin/sh\n" +
        `if [ -f "${called}" ]; then\n` +
        `  cat "${output}"\n` +
        `  exit ${String(exitCode)}\n` +
        "else\n" +
        `  touch "${called}"\n` +
        "  exit 0\n" +
        "fi\n",
    );
    chmodSync(script, 0o755);
    return baseSandbox(script);
  };

  it("sandboxed install: a killed install is reported killed, not a false 'dependencies do not install'", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc -b" } }));
    const script = join(dir, "fake-docker-install-killed.sh");
    writeFileSync(script, "#!/bin/sh\nexit 137\n");
    chmodSync(script, 0o755);
    const out = await runT0(dir, { engines: ["tsc"], sandbox: baseSandbox(script) });
    const tsc = out.outcomes.find((o) => o.engine === "tsc");
    expect(tsc?.findings, "a killed install must not become a false failing-dependency finding").toStrictEqual([]);
    expect(tsc?.unavailable).toMatch(/killed/);
    expect(tsc?.unavailable).toMatch(/not a fault in the branch/);
  });

  it("checkTypes: a killed `typecheck` script is reported killed, not its partial output", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc -b" } }));
    const sandbox = fakeDocker("src/foo.ts(3,5): error TS2322: fake partial output before the kill");
    const out = await runT0(dir, { engines: ["tsc"], sandbox });
    const tsc = out.outcomes.find((o) => o.engine === "tsc");
    expect(tsc?.findings, "the parseable line must not survive as a finding").toStrictEqual([]);
    expect(tsc?.unavailable).toMatch(/killed/);
    expect(tsc?.unavailable).toMatch(/not a fault in the branch/);
  });

  // Fingerprint cbb6824f: the cgroup's SIGKILL (137) is not the only way a memory
  // limit ends a run — V8 can also abort on its OWN heap ceiling, typically exit
  // 134, with no cgroup kill involved at all. Mixed with a REAL parseable error
  // from a package that finished first, which the fix must still discard: knowing
  // one package's real result does not mean the rest is known to be clean.
  it("checkTypes: a run that aborts on its own heap limit is reported as OOM, not its partial output", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc -b" } }));
    const stdoutOnAbort =
      "src/foo.ts(3,5): error TS2322: real error from a package that finished first\n" +
      "\n<--- Last few GCs --->\n\nFATAL ERROR: Ineffective mark-compacts near heap limit " +
      "Allocation failed - JavaScript heap out of memory\n";
    const sandbox = fakeDocker(stdoutOnAbort, 134);
    const out = await runT0(dir, { engines: ["tsc"], sandbox });
    const tsc = out.outcomes.find((o) => o.engine === "tsc");
    expect(tsc?.findings, "a heap-OOM abort must not be reported as a clean or partial result").toStrictEqual([]);
    expect(tsc?.unavailable).toMatch(/ran out of memory/);
    expect(tsc?.unavailable).toMatch(/not a fault in the branch/);
  });

  // Fingerprint 9171c6c9: the short phrase alone is not distinctive enough to key
  // on — this repository's own source now contains it, discussing this exact fix.
  // A real tsc error whose message happens to quote that text (an ordinary
  // failure, no cgroup kill and no V8 abort in sight) must still be reported as a
  // real finding, not discarded as a false OOM.
  it("checkTypes: a real error mentioning the short OOM phrase is not misread as an abort", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc -b" } }));
    const stdoutOnFail =
      'src/oom-handler.ts(12,3): error TS2322: Type \'string\' is not assignable to type \'"JavaScript heap out of memory"\'.\n';
    const sandbox = fakeDocker(stdoutOnFail, 1);
    const out = await runT0(dir, { engines: ["tsc"], sandbox });
    const tsc = out.outcomes.find((o) => o.engine === "tsc");
    expect(tsc?.findings, "a real, parseable error must survive even if it mentions the short phrase").toHaveLength(1);
    expect(tsc?.unavailable).toBeUndefined();
  });

  // Fingerprint a7f2d87c: a run that exits 0 is not the process WE killed, whatever
  // its own logs happen to contain — e.g. a build step that catches and retries a
  // child's OOM, then finishes and succeeds. Without gating the content match on
  // `!r.ok`, that success would still read as "did not complete".
  it("checkTypes: a run that exits 0 is never misread as OOM, whatever its own logs say", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc -b" } }));
    const stdoutOnSuccess =
      "retrying after a child reported FATAL ERROR: Reached heap limit " +
      "Allocation failed - JavaScript heap out of memory\n" +
      "retry succeeded\n";
    const sandbox = fakeDocker(stdoutOnSuccess, 0);
    const out = await runT0(dir, { engines: ["tsc"], sandbox });
    const tsc = out.outcomes.find((o) => o.engine === "tsc");
    expect(tsc?.findings, "a successful run must not be discarded because its own log mentions the phrase").toStrictEqual([]);
    expect(tsc?.unavailable).toBeUndefined();
  });

  it("checkTypes: a killed bare `tsc --noEmit` is reported killed, not its partial output", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const sandbox = fakeDocker("src/foo.ts(3,5): error TS2322: fake partial output before the kill");
    const out = await runT0(dir, { engines: ["tsc"], sandbox });
    const tsc = out.outcomes.find((o) => o.engine === "tsc");
    expect(tsc?.findings, "the parseable line must not survive as a finding").toStrictEqual([]);
    expect(tsc?.unavailable).toMatch(/killed/);
    expect(tsc?.unavailable).toMatch(/not a fault in the branch/);
  });

  // Fingerprint 1fa9229d: this scenario used to become a HIGH "fails on this
  // branch" finding (fde373d4's own fix, one round ago) — overclaiming, since this
  // branch runs tsc speculatively (triggered by a bare tsconfig.json, no declared
  // script) and "not found" is a tooling gap, not evidence the branch's own code
  // fails to typecheck.
  it("checkTypes: a bare tsc run that is not installed is reported unavailable, not a false 'fails on this branch'", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const script = join(dir, "fake-docker-tsc-broken.sh");
    const called = join(dir, ".called-broken");
    writeFileSync(
      script,
      "#!/bin/sh\n" +
        `if [ -f "${called}" ]; then\n` +
        "  echo 'sh: 1: tsc: not found' >&2\n" +
        "  exit 127\n" +
        "else\n" +
        `  touch "${called}"\n` +
        "  exit 0\n" +
        "fi\n",
    );
    chmodSync(script, 0o755);
    const out = await runT0(dir, { engines: ["tsc"], sandbox: baseSandbox(script) });
    const tsc = out.outcomes.find((o) => o.engine === "tsc");
    expect(tsc?.findings, "an ambiguous, unparseable failure must not become a confident 'fails' claim").toStrictEqual([]);
    expect(tsc?.unavailable).toMatch(/not installed/);
  });

  it("checkLint: a killed bare eslint run is reported killed, not its partial output", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(dir, "eslint.config.js"), "module.exports = [];\n");
    const eslintJson = JSON.stringify([
      {
        filePath: join(dir, "src", "foo.ts"),
        messages: [{ ruleId: "no-unused-vars", message: "fake partial output before the kill", line: 3, severity: 2 }],
      },
    ]);
    const sandbox = fakeDocker(eslintJson);
    const out = await runT0(dir, { engines: ["eslint"], sandbox });
    const eslint = out.outcomes.find((o) => o.engine === "eslint");
    expect(eslint?.findings, "the parseable message must not survive as a finding").toStrictEqual([]);
    expect(eslint?.unavailable).toMatch(/killed/);
    expect(eslint?.unavailable).toMatch(/not a fault in the branch/);
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
