/**
 * What T0 tells the model tiers.
 *
 * The interesting part is the cut. `renderT0` lists a bounded number of findings and
 * they arrive grouped by engine, so the order decides which facts the tier is given
 * about the tree it is reviewing. The findings themselves are not lost — `runRound`
 * records every one of them — but a tier that is not told the suite fails is judging
 * the code without knowing that.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const out = renderT0({ findings: [], outcomes: [], unavailable: ["tsc: not configured"], skipped: [], interrupted: false });
    expect(out).toContain("Deterministic tooling found nothing.");
    expect(out).toContain("NOT RUN");
    expect(out).toContain("tsc: not configured");
  });

  it("lists findings worst first", () => {
    const out = renderT0({
      findings: [f("low", "a.ts"), f("high", "b.ts"), f("medium", "c.ts")],
      outcomes: [],
      unavailable: [], skipped: [], interrupted: false,
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
      unavailable: [], skipped: [], interrupted: false,
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

  it.each([["tsc"], ["eslint"], ["cargo-check"], ["cargo-clippy"]])("refuses to run %s on the host", async (engine) => {
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
        // `clearStaleContainer`'s own `rm -f` (fingerprint bfc4e055), transparent
        // here the same way a real one is against a name not in use — succeeds,
        // untouched by and untouching the marker file every OTHER assertion below
        // depends on counting.
        'if [ "$1" = "rm" ]; then exit 0; fi\n' +
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
        'if [ "$1" = "rm" ]; then exit 0; fi\n' +
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

  // Fingerprint 6af88f4d: eslint's OWN JSON formatter reports `filePath` absolute,
  // and this run happened inside the sandbox where the only files on disk sit under
  // SANDBOX_CWD (`/work`) — never under the HOST worktree path (`dir`, here). A
  // fake `filePath` built from `dir` (as the killed-run test above uses, harmlessly,
  // since a kill discards it before parsing) would silently hide this: it must be
  // built from the container's own path, exactly as a real sandboxed eslint run
  // would report it.
  it("checkLint: a real eslint finding's file is the repo-relative path, not the container's absolute one", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(dir, "eslint.config.js"), "module.exports = [];\n");
    const eslintJson = JSON.stringify([
      {
        filePath: "/work/src/foo.ts",
        messages: [{ ruleId: "no-unused-vars", message: "'x' is defined but never used", line: 3, severity: 2 }],
      },
    ]);
    // Exit 1: eslint's own real exit code when it found something, not a kill.
    const sandbox = fakeDocker(eslintJson, 1);
    const out = await runT0(dir, { engines: ["eslint"], sandbox });
    const eslint = out.outcomes.find((o) => o.engine === "eslint");
    expect(eslint?.findings).toHaveLength(1);
    expect(eslint?.findings?.[0]?.file).toBe("src/foo.ts");
  });

  // Fingerprint dd36a31b, found by lore's own review: a timeout is the THIRD way
  // a run does not finish, alongside a kill and OOM, and it reaches `runInSandbox`
  // as `r.unavailable` set with `r.timedOut` true — a structured signal `ToolResult`
  // already carries, distinct from a STABLE absence (no config), which must not
  // withhold trust from the round. Every `r.unavailable !== undefined` early return
  // in checkTypes/checkLint now threads it through; this exercises one for real,
  // with `execFile`'s own timeout killing a script that sleeps well past it.
  it("checkTypes: a run that times out is interrupted, not a stable absence", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc -b" } }));
    const script = join(dir, "fake-docker-hang.sh");
    const called = join(dir, ".called-hang");
    writeFileSync(
      script,
      "#!/bin/sh\n" +
        'if [ "$1" = "rm" ]; then exit 0; fi\n' +
        // `killIfTimedOut`'s own explicit kill (fingerprint 0b55733a) reaches
        // this same script with `$1 = "kill"` after the `run` below hangs —
        // without this, "kill" falls into the marker-file branch same as any
        // other second call and sleeps another real 5s, well past this test's
        // own default timeout.
        'if [ "$1" = "kill" ]; then exit 0; fi\n' +
        `if [ -f "${called}" ]; then\n` +
        "  sleep 5\n" +
        "else\n" +
        `  touch "${called}"\n` +
        "  exit 0\n" +
        "fi\n",
    );
    chmodSync(script, 0o755);
    const sandbox = { ...baseSandbox(script), timeoutMs: 200 };
    const out = await runT0(dir, { engines: ["tsc"], sandbox });
    const tsc = out.outcomes.find((o) => o.engine === "tsc");
    expect(tsc?.unavailable).toMatch(/timed out/);
    expect(tsc?.interrupted, "a timeout withholds trust from this round the same as a kill").toBe(true);
  });
});

/**
 * `sandboxedCargo` (D-131), through the same fake-`docker` stand-in pattern the tsc
 * suite above uses — no real Docker, no network, hermetic. Verified here: the
 * orchestration (manifest-path plumbing, the fetch-then-check(-then-clippy)
 * sequence, real JSON parsing end to end) and, deliberately first, the case every
 * real review hits until a follow-up adds a Rust toolchain to the sandbox image —
 * cargo genuinely not being there yet.
 */
describe("sandboxedCargo, through a fake docker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-t0-cargo-"));
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
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

  it("with no toolchain in the sandbox image, reports it plainly rather than 'dependencies do not fetch'", async () => {
    const script = join(dir, "fake-docker-no-cargo.sh");
    writeFileSync(script, "#!/bin/sh\necho 'sh: cargo: not found' >&2\nexit 127\n");
    chmodSync(script, 0o755);
    const out = await runT0(dir, { engines: ["cargo-check", "cargo-clippy"], sandbox: baseSandbox(script) });
    for (const engine of ["cargo-check", "cargo-clippy"]) {
      const o = out.outcomes.find((x) => x.engine === engine);
      expect(o?.findings, engine).toStrictEqual([]);
      expect(o?.unavailable, engine).toBe("cargo is not available in the sandbox image");
    }
  });

  // A GENUINE DEPENDENCY FAILURE THAT HAPPENS TO SAY "not found" MUST NOT BE
  // MISREAD AS A MISSING TOOLCHAIN — found by lore's own review, fingerprint
  // 01270153: a broken git dependency's own error ("repository … not found") or a
  // missing path dependency's ("No such file or directory") used to trip the same
  // text check the case above needs, discarding a real, high-severity finding about
  // the branch's own dependencies as a false "cargo is not available". cargo itself
  // is present here (exit 101, a plausible cargo failure code — not 127), so only
  // the exit code decides now.
  it("a genuine dependency-fetch failure is reported as one, even if its text says 'not found'", async () => {
    const script = join(dir, "fake-docker-broken-dep.sh");
    writeFileSync(
      script,
      "#!/bin/sh\necho 'error: failed to get `foo` as a dependency' >&2\n" +
        "echo 'Caused by:' >&2\n  echo '  fatal: repository https://example.invalid/foo not found' >&2\nexit 101\n",
    );
    chmodSync(script, 0o755);
    const out = await runT0(dir, { engines: ["cargo-check"], sandbox: baseSandbox(script) });
    const o = out.outcomes.find((x) => x.engine === "cargo-check");
    expect(o?.unavailable).toBe("dependencies failed to fetch with cargo");
    expect(o?.findings).toHaveLength(1);
    expect(o?.findings[0]?.severity).toBe("high");
    expect(o?.findings[0]?.evidence).toMatch(/not found/);
  });

  // A MISSING CLIPPY COMPONENT IS NOT A BROKEN BRANCH EITHER — found by lore's own
  // review, fingerprint f2b0d6c3: `cargo-clippy` is its own binary, a separate
  // rustup component / distro package from bare cargo, and can be absent when
  // cargo itself works fine (fetch succeeds, exit 127's own check never fires).
  // Confirmed empirically what cargo itself prints for a missing subcommand
  // (`cargo some-fake-subcommand` on a real, working cargo): `error: no such
  // command:` on stderr, exit 101 — the SAME generic exit code an ordinary lint
  // failure also uses, so only the message tells the two apart.
  it("a missing clippy component is reported plainly, not as a failing branch", async () => {
    const script = join(dir, "fake-docker-no-clippy.sh");
    const countFile = join(dir, ".count-noclippy");
    writeFileSync(
      script,
      "#!/bin/sh\n" +
        'if [ "$1" = "rm" ]; then exit 0; fi\n' +
        `N=$(cat "${countFile}" 2>/dev/null || echo 0)\n` +
        `echo $((N+1)) > "${countFile}"\n` +
        'if [ "$N" -eq 0 ]; then exit 0; ' +
        "else echo 'error: no such command: \\`clippy\\`' >&2; exit 101; fi\n",
    );
    chmodSync(script, 0o755);
    const out = await runT0(dir, { engines: ["cargo-clippy"], sandbox: baseSandbox(script) });
    const o = out.outcomes.find((x) => x.engine === "cargo-clippy");
    expect(o?.findings).toStrictEqual([]);
    expect(o?.unavailable).toBe("clippy is not available in the sandbox image");
  });

  // A RUSTUP TOOLCHAIN THAT HAS CARGO BUT NOT THE CLIPPY COMPONENT FAILS A
  // DIFFERENT WAY than a plain missing binary — found by lore's own review,
  // fingerprint c618f5cb, and confirmed by actually removing the component from
  // a real local toolchain and restoring it after: `error: 'cargo-clippy' is
  // not installed for the toolchain '…'`, exit 1, zero stdout bytes — a message
  // the earlier, narrower "no such command:" check would have missed entirely.
  it("a rustup toolchain missing the clippy component is also reported plainly", async () => {
    const script = join(dir, "fake-docker-rustup-no-clippy.sh");
    const countFile = join(dir, ".count-rustup-noclippy");
    writeFileSync(
      script,
      "#!/bin/sh\n" +
        'if [ "$1" = "rm" ]; then exit 0; fi\n' +
        `N=$(cat "${countFile}" 2>/dev/null || echo 0)\n` +
        `echo $((N+1)) > "${countFile}"\n` +
        'if [ "$N" -eq 0 ]; then exit 0; ' +
        "else echo \"error: 'cargo-clippy' is not installed for the toolchain 'stable-x86_64'.\" >&2; exit 1; fi\n",
    );
    chmodSync(script, 0o755);
    const out = await runT0(dir, { engines: ["cargo-clippy"], sandbox: baseSandbox(script) });
    const o = out.outcomes.find((x) => x.engine === "cargo-clippy");
    expect(o?.findings).toStrictEqual([]);
    expect(o?.unavailable).toBe("clippy is not available in the sandbox image");
  });

  // THE EMPTY-STDOUT REQUIREMENT IS LOAD-BEARING, NOT INCIDENTAL — found by
  // lore's own review, fingerprint 57dea7e8: a text match on stderr ALONE would
  // also match a target's own `build.rs` printing similar text as part of a
  // REAL failure, swallowing it as a false "no toolchain" instead. Simulated
  // here as a run that emits SOME cargo JSON on stdout (proving the build
  // genuinely started, i.e. cargo itself dispatched fine) before failing with
  // text that collides with the missing-tool phrase — this must NOT be
  // classified as a missing tool.
  it("does not classify a failure as a missing tool when stdout shows the build actually started", async () => {
    const script = join(dir, "fake-docker-collision.sh");
    const countFile = join(dir, ".count-collision");
    writeFileSync(
      script,
      "#!/bin/sh\n" +
        'if [ "$1" = "rm" ]; then exit 0; fi\n' +
        `N=$(cat "${countFile}" 2>/dev/null || echo 0)\n` +
        `echo $((N+1)) > "${countFile}"\n` +
        "if [ \"$N\" -eq 0 ]; then exit 0; " +
        "else echo '{\"reason\":\"compiler-artifact\",\"package_id\":\"x\"}'; " +
        "echo 'error: no such command: `something-a-build-script-shelled-out-to`' >&2; exit 1; fi\n",
    );
    chmodSync(script, 0o755);
    const out = await runT0(dir, { engines: ["cargo-clippy"], sandbox: baseSandbox(script) });
    const o = out.outcomes.find((x) => x.engine === "cargo-clippy");
    expect(o?.unavailable, JSON.stringify(o)).toBeUndefined();
    expect(o?.findings, JSON.stringify(o)).toHaveLength(1);
    expect(o?.findings[0]?.claim).toMatch(/fails on this branch/);
    // Fingerprint 2060d1f6: this fixture's own root has no package.json anywhere
    // (see beforeEach — only Cargo.toml) — `scriptFinding`'s old hardcoded
    // default named a file that does not exist in this repo at all. Must be the
    // real manifest, exactly as the sibling fetch-failure test below already
    // asserts for the fetch-failure arm (fingerprint 47ddd7fa).
    expect(o?.findings[0]?.file).toBe("Cargo.toml");
  });

  // CARGO_HOME/CARGO_TARGET_DIR MUST ACTUALLY REACH CARGO — found by lore's own
  // review, fingerprint d341a76e: the cache mount at /work/.cargo was wired but
  // nothing ever pointed cargo's OWN env vars at it, so every fetch silently used
  // each throwaway container's own ephemeral $HOME/.cargo instead — downloads that
  // die with the container that made them, and an offline check next door with
  // nothing to resolve from.
  //
  // Checked on the CONSTRUCTED COMMAND itself, not by trying to make a fake docker
  // actually run cargo — the export lives inside the `sh -lc` script string
  // `runInSandbox` builds, which this fake docker receives as an inert argument and
  // was never going to execute; a fake that only pattern-matched its own live
  // environment would see nothing regardless of whether the fix were present. This
  // dumps the real argv it was called with and asserts on that instead.
  it("sets CARGO_HOME and CARGO_TARGET_DIR in every cargo invocation it builds", async () => {
    const script = join(dir, "fake-docker-cargo-env.sh");
    const captured = join(dir, "captured-argv.txt");
    // `clearStaleContainer`'s own `rm -f` (fingerprint bfc4e055) is real but not
    // what this test counts — excluded from the capture, not merely tolerated.
    writeFileSync(script, `#!/bin/sh\nif [ "$1" = "rm" ]; then exit 0; fi\nprintf '%s\\n---\\n' "$*" >> "${captured}"\nexit 0\n`);
    chmodSync(script, 0o755);
    await runT0(dir, { engines: ["cargo-check", "cargo-clippy"], sandbox: baseSandbox(script) });
    const argv = readFileSync(captured, "utf8");
    const calls = argv.split("---\n").filter((s) => s.trim().length > 0);
    // Fetch, plus one check invocation per requested engine.
    expect(calls.length, argv).toBe(3);
    for (const call of calls) {
      expect(call, call).toMatch(/CARGO_HOME=\/cargo-cache\/home/);
      expect(call, call).toMatch(/CARGO_TARGET_DIR=\/cargo-cache\/target/);
      // NOT nested under /work — see the dedicated test below for why: that path
      // collides with cargo's own config-discovery convention.
      expect(call, call).not.toMatch(/\/work\/\.cargo/);
    }
  });

  // THE CACHE MOUNT ITSELF, NOT JUST THE ENV VARS THAT POINT AT IT — found by
  // lore's own review, fingerprints a461dd72/54900638: mounting the shared,
  // cross-review cache at `/work/.cargo` puts it on cargo's OWN config-discovery
  // path, and `SYNC`'s `cp -a /src/. /work/` (dotfiles included) copies a reviewed
  // repo's own committed `.cargo/config.toml` INTO that exact, persistent,
  // Cargo.lock-hash-keyed location — never cleaned back out, silently configuring
  // the next review sharing that hash. The `-v` flag itself must target a path
  // `SYNC` never writes to, not merely have the right env vars layered on top.
  it("mounts the cache as a sibling of /work, never nested under /work/.cargo", async () => {
    const script = join(dir, "fake-docker-mount-check.sh");
    const captured = join(dir, "captured-mount.txt");
    writeFileSync(script, `#!/bin/sh\nif [ "$1" = "rm" ]; then exit 0; fi\nprintf '%s\\n---\\n' "$*" >> "${captured}"\nexit 0\n`);
    chmodSync(script, 0o755);
    await runT0(dir, { engines: ["cargo-check"], sandbox: baseSandbox(script) });
    const argv = readFileSync(captured, "utf8");
    expect(argv, argv).toMatch(/-v [^ ]+:\/cargo-cache\b/);
    expect(argv, argv).not.toContain(":/work/.cargo");
  });

  // THE MANIFEST PATH IS REPO-CONTROLLED, NOT A VALUE THIS CODE CHOOSES — found by
  // lore's own review, fingerprint 2b5a78f6: a one-level directory containing a
  // space, interpolated unquoted into the `sh -lc` string, would word-split and
  // break `--manifest-path` for a perfectly healthy repo. A separate worktree here
  // (not the outer `dir`, whose own `beforeEach` already wrote a ROOT Cargo.toml —
  // `detectEcosystems`' first-match-wins would find that one first and never
  // exercise the nested, space-containing path this test is about).
  it("quotes a manifest path containing a space, rather than letting the shell word-split it", async () => {
    const spaced = mkdtempSync(join(tmpdir(), "lore-t0-cargo-spaced-"));
    try {
      mkdirSync(join(spaced, "Rust Core"));
      writeFileSync(join(spaced, "Rust Core", "Cargo.toml"), '[package]\nname = "x"\n');
      const script = join(spaced, "fake-docker-spaced.sh");
      const captured = join(spaced, "captured-argv.txt");
      writeFileSync(script, `#!/bin/sh\nif [ "$1" = "rm" ]; then exit 0; fi\nprintf '%s\\n---\\n' "$*" >> "${captured}"\nexit 0\n`);
      chmodSync(script, 0o755);
      await runT0(spaced, {
        engines: ["cargo-check"],
        sandbox: { ...baseSandbox(script), cacheRoot: join(spaced, "cache"), scratchRoot: join(spaced, "scratch") },
      });
      const argv = readFileSync(captured, "utf8");
      expect(argv, argv).toContain("--manifest-path 'Rust Core/Cargo.toml'");
    } finally {
      rmSync(spaced, { recursive: true, force: true });
    }
  });

  // Sequenced by call count — fetch (1) succeeds silently, cargo-check (2) and
  // cargo-clippy (3) each answer with their own real-shaped JSON, one lint apiece,
  // proving the full path (manifest-path plumbing, the mount, the parse) round-trips
  // real cargo output rather than only the constructed fixtures in engines.test.ts.
  it("a real check and a real clippy finding both come back through the full path", async () => {
    const script = join(dir, "fake-docker-cargo-ok.sh");
    const countFile = join(dir, ".count");
    const checkOut = join(dir, "check-out.json");
    const clippyOut = join(dir, "clippy-out.json");
    writeFileSync(
      checkOut,
      JSON.stringify({
        reason: "compiler-message",
        message: {
          message: "unused variable: `y`",
          code: { code: "unused_variables" },
          level: "warning",
          spans: [{ file_name: "src/main.rs", line_start: 2, is_primary: true }],
        },
      }),
    );
    writeFileSync(
      clippyOut,
      JSON.stringify({
        reason: "compiler-message",
        message: {
          message: "this returns unconditionally",
          code: { code: "clippy::needless_return" },
          level: "warning",
          spans: [{ file_name: "src/main.rs", line_start: 5, is_primary: true }],
        },
      }),
    );
    writeFileSync(
      script,
      "#!/bin/sh\n" +
        'if [ "$1" = "rm" ]; then exit 0; fi\n' +
        `N=$(cat "${countFile}" 2>/dev/null || echo 0)\n` +
        `echo $((N+1)) > "${countFile}"\n` +
        `if [ "$N" -eq 0 ]; then exit 0; ` +
        `elif [ "$N" -eq 1 ]; then cat "${checkOut}"; exit 0; ` +
        `else cat "${clippyOut}"; exit 0; fi\n`,
    );
    chmodSync(script, 0o755);
    const out = await runT0(dir, { engines: ["cargo-check", "cargo-clippy"], sandbox: baseSandbox(script) });

    const check = out.outcomes.find((o) => o.engine === "cargo-check");
    expect(check?.unavailable).toBeUndefined();
    expect(check?.findings).toHaveLength(1);
    expect(check?.findings[0]).toMatchObject({ file: "src/main.rs", line: 2, severity: "medium" });

    const clippy = out.outcomes.find((o) => o.engine === "cargo-clippy");
    expect(clippy?.unavailable).toBeUndefined();
    expect(clippy?.findings).toHaveLength(1);
    expect(clippy?.findings[0]).toMatchObject({ file: "src/main.rs", line: 5, severity: "medium" });
  });

  it("reports absence as skipped, not unavailable, when there is no Cargo.toml at all", async () => {
    const empty = mkdtempSync(join(tmpdir(), "lore-t0-nocargo-"));
    try {
      const sandbox: SandboxConfig = {
        image: "unused",
        cacheRoot: join(empty, "cache"),
        scratchRoot: join(empty, "scratch"),
        uid: 1000,
        gid: 1000,
        memory: "6g",
        cpus: "2",
        timeoutMs: 30_000,
        runtime: "unused",
      };
      const out = await runT0(empty, { engines: ["cargo-check"], sandbox });
      const o = out.outcomes.find((x) => x.engine === "cargo-check");
      expect(o?.findings).toStrictEqual([]);
      expect(o?.unavailable, "not a gap the client should be told about, same as ast-grep's own absence").toBeUndefined();
      expect(o?.skipped).toMatch(/no Cargo\.toml/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // Fingerprints 0691f313/6eae08da: this was `unavailable` — the client-facing
  // NOT RUN list, on EVERY round of every review of a pure Rust/Go/Python repo
  // forever — until lore's own review asked why tsc/eslint never got the same
  // fix cargo did, right above, for the identical shape.
  it("reports absence as skipped, not unavailable, when there is no package.json at all", async () => {
    const empty = mkdtempSync(join(tmpdir(), "lore-t0-nopkg-"));
    try {
      const sandbox: SandboxConfig = {
        image: "unused", cacheRoot: join(empty, "cache"), scratchRoot: join(empty, "scratch"),
        uid: 1000, gid: 1000, memory: "6g", cpus: "2", timeoutMs: 30_000, runtime: "unused",
      };
      const out = await runT0(empty, { engines: ["tsc", "eslint"], sandbox });
      for (const engineName of ["tsc", "eslint"] as const) {
        const o = out.outcomes.find((x) => x.engine === engineName);
        expect(o?.findings).toStrictEqual([]);
        expect(o?.unavailable, "not a gap the client should be told about, same as cargo's own absence").toBeUndefined();
        expect(o?.skipped).toMatch(/no package\.json/);
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // The distinction the fix has to preserve: a REAL JS/TS repo whose specific
  // shape genuinely cannot be handled yet must still say so — never silently
  // folded into the same "not a project at all" skip.
  it("still reports a genuine gap as unavailable when a package.json exists but this cannot install from it", async () => {
    const nested = mkdtempSync(join(tmpdir(), "lore-t0-nested-"));
    try {
      mkdirSync(join(nested, "infra"));
      writeFileSync(join(nested, "infra", "package.json"), "{}");
      const sandbox: SandboxConfig = {
        image: "unused", cacheRoot: join(nested, "cache"), scratchRoot: join(nested, "scratch"),
        uid: 1000, gid: 1000, memory: "6g", cpus: "2", timeoutMs: 30_000, runtime: "unused",
      };
      const out = await runT0(nested, { engines: ["tsc"], sandbox });
      const o = out.outcomes.find((x) => x.engine === "tsc");
      expect(o?.skipped, "this repo IS JS/TS-shaped, the gap is real and worth telling the client").toBeUndefined();
      expect(o?.unavailable).toMatch(/infra\//);
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
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
      { findings: [F("b.ts", 2, "still here"), F("c.ts", 3, "brand new", "high")], outcomes: [], skipped: [], unavailable: [], interrupted: false },
      fp as never,
    );
    expect(out).toContain("1 resolved, 1 new, 1 unchanged");
    expect(out).toContain("resolved: a.ts:1 — old bug");
    expect(out).toContain("[high] NEW c.ts:3 — brand new");
    expect(out, "the unchanged one is a count, not a repeat").not.toContain("still here");
  });

  it("says still-nothing in one line when both sides are empty", () => {
    const out = renderT0Delta([], { findings: [], outcomes: [], skipped: [], unavailable: [], interrupted: false }, fp as never);
    expect(out).toContain("still nothing");
  });

  it("says unchanged in one line when nothing moved", () => {
    const out = renderT0Delta(
      [seen("a.ts", 1, "x")],
      { findings: [F("a.ts", 1, "x")], outcomes: [], skipped: [], unavailable: [], interrupted: false },
      fp as never,
    );
    expect(out).toContain("unchanged — the 1 issue(s) you already know still stand");
  });

  // NOT-RUN is never delta'd: "nothing checked this" is the one fact repetition cannot
  // cheapen (INV-1).
  it("repeats the not-run section every time, whatever moved", () => {
    const out = renderT0Delta([], { findings: [], outcomes: [], skipped: [], unavailable: ["eslint: no config"], interrupted: false }, fp as never);
    expect(out).toContain("NOT RUN");
    expect(out).toContain("eslint: no config");
  });

  // Fingerprint 4a39ae0d, found by lore's own review of the OOM-kill fix: a
  // previously-seen finding absent from an INTERRUPTED round's findings used to be
  // reported "resolved" — the same false-improvement claim `settleFixed`
  // (reviewer/review.ts) made with its verdict, aimed at the model's own memory of
  // the review instead of the store. T0 did not re-check it; it just did not finish.
  it("does not claim a previously-seen finding resolved when t0 was interrupted", () => {
    const out = renderT0Delta(
      [seen("a.ts", 1, "old bug")],
      { findings: [], outcomes: [], skipped: [], unavailable: ["tsc: killed"], interrupted: true },
      fp as never,
    );
    expect(out, "an interrupted round must never claim a fix it did not verify").not.toContain("resolved: a.ts:1");
    expect(out).toContain("unconfirmed");
    expect(out).toContain("a.ts:1 — old bug");
    expect(out).toMatch(/still treat these as open, not resolved/);
  });
});
