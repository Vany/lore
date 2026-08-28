/**
 * Which installer T0 uses, and why it cannot be a constant.
 *
 * T0 runs the target repository's own tooling (D-8), and that has to include how it
 * installs. Reviewing a real pull request against a pnpm monorepo showed what the
 * constant costs: `npm install` hit a `preinstall` guard that exits 1 unless pnpm
 * invoked it, so no `node_modules` appeared — and the damage was not limited to the
 * suite, because `tsc` and `eslint` both run through `npx --no-install` and resolve
 * out of `node_modules`. Three of T0's engines produced nothing from one wrong verb.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptFinding } from "./runner.ts";
import { cargoLockKey, commandsFor, detectEcosystems, install, lockfileKey, runInSandbox, type SandboxConfig } from "./sandbox.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-tc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Writes `package.json` alongside, because `commandsFor` now requires it present
// before it will trust any lockfile (D-129) — matching what every real manager
// actually needs to have written the lockfile in the first place. Tests that
// specifically exercise the "lockfile with no manifest" case write the lockfile
// directly instead of through this helper.
const lock = (name: string) => {
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, name), "");
};

describe("the installer follows the lockfile", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ])("%s -> %s", async (file, name) => {
    lock(file);
    const outcome = await commandsFor(dir);
    if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.why}`);
    expect(outcome.toolchain.name).toBe(name);
    // Install only. There is no `test` command any more (D-71): lore reads a suite
    // and never runs it, so the toolchain carries nothing to run one with.
    expect(outcome.toolchain.install).toContain(name);
  });

  // D-129, found live by lore's own t2: a lockfile alone used to be trusted as
  // proof a `package.json` existed, on the reasoning that no manager writes one
  // without a manifest to install against — true when written, not guaranteed
  // true when READ. A branch that deletes its manifest but leaves a stale
  // `package-lock.json` behind (a bad merge, a mid-migration commit) recreates
  // exactly the wasted-install shape this decision exists to remove. Written
  // directly, bypassing `lock()`, which now writes package.json on purpose.
  it.each([["pnpm-lock.yaml"], ["yarn.lock"], ["package-lock.json"]])(
    "does not trust a stale %s with no package.json",
    async (file) => {
      writeFileSync(join(dir, file), "");
      const outcome = await commandsFor(dir);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.why).toContain("package.json");
    },
  );

  // A repo with no lockfile at all is not an error IF IT IS A JS PROJECT: npm is the
  // reasonable default and `npm install` will resolve from `package.json` — which
  // this test now actually writes, rather than asserting the fallback on an empty
  // directory that was never a JS project to begin with (see the next test).
  it("falls back to npm when there is a package.json but no lockfile", async () => {
    writeFileSync(join(dir, "package.json"), "{}");
    const outcome = await commandsFor(dir);
    if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.why}`);
    expect(outcome.toolchain.name).toBe("npm");
  });

  // D-129, found live: an empty directory — no lockfile AND no package.json, exactly
  // what a non-JS repo (a Rust project, say) looks like from here — used to fall
  // through to the SAME npm default as a real JS project with no lockfile yet. atuin
  // queued a real `npm ci` against a tree with nothing for it to install, 15 minutes
  // behind an unrelated review sharing the same empty `no-lockfile` cache bucket.
  it("is NOT a JS project when neither a lockfile nor package.json exists", async () => {
    const outcome = await commandsFor(dir);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.why).toContain("package.json");
  });

  // D-129, found live by lore's own t1 on a real repo this deployment reviews:
  // `acdc` keeps its only manifest at infra/package.json, no root one. This used
  // to say "not a JS/TS project" — flatly false, and disagreeing with
  // `detectEcosystems` about the exact same repo in the exact same file. Still
  // `ok: false` (this function cannot install from a directory it does not run
  // in), but the reason must not overclaim what was actually checked.
  it("names a nested package.json instead of claiming the repo is not JS/TS at all", async () => {
    mkdirSync(join(dir, "infra"));
    writeFileSync(join(dir, "infra", "package.json"), "{}");
    const outcome = await commandsFor(dir);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.why).toContain("infra/");
    expect(outcome.why).not.toContain("not a JS/TS project");
  });

  // The most specific manager wins. A repo carrying two lockfiles is already a mess,
  // and picking the wrong one installs a tree the project never uses.
  it("prefers pnpm when a stale package-lock.json is also present", async () => {
    lock("package-lock.json");
    lock("pnpm-lock.yaml");
    const outcome = await commandsFor(dir);
    if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.why}`);
    expect(outcome.toolchain.name).toBe("pnpm");
  });

  // Bun is a different runtime, not just a different installer, and is not in the
  // sandbox image. `ok: false` here becomes an unavailable engine — installing with
  // npm instead and reporting the result as the project's own suite would be a
  // confident claim about something that never ran.
  it.each([["bun.lock"], ["bun.lockb"]])("refuses rather than guessing for %s", async (file) => {
    lock(file);
    const outcome = await commandsFor(dir);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.why).toContain("bun");
  });

  // The install must tolerate a lockfile that does not match package.json — common
  // on a branch that changed dependencies — rather than failing the whole tier on it.
  it("falls back from a frozen install to a resolving one", async () => {
    lock("pnpm-lock.yaml");
    const outcome = await commandsFor(dir);
    if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.why}`);
    expect(outcome.toolchain.install).toMatch(/--frozen-lockfile \|\|/);
  });
});

/**
 * D-129's foundation: which ecosystem(s) T0 should even consider for this
 * worktree, ahead of the cargo check/clippy execution that consumes it next.
 */
describe("detectEcosystems", () => {
  it("finds npm from package.json alone, no lockfile required", async () => {
    writeFileSync(join(dir, "package.json"), "{}");
    expect(await detectEcosystems(dir)).toStrictEqual([{ ecosystem: "npm", dir: "." }]);
  });

  it("finds cargo from Cargo.toml", async () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
    expect(await detectEcosystems(dir)).toStrictEqual([{ ecosystem: "cargo", dir: "." }]);
  });

  it("finds both when the worktree root carries both markers", async () => {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
    expect(await detectEcosystems(dir)).toStrictEqual([
      { ecosystem: "npm", dir: "." },
      { ecosystem: "cargo", dir: "." },
    ]);
  });

  it("finds neither for a worktree with no recognised project marker", async () => {
    expect(await detectEcosystems(dir)).toStrictEqual([]);
  });

  // teammater's ACTUAL shape, not a stand-in for it — found missing by lore's own
  // t1: a plain-JS root with no package.json anywhere, and a real Cargo project one
  // directory down, with nothing at the root marking it (unlike a workspace, which
  // always declares its members from a root manifest). Root-only detection made
  // this repo invisible to its own motivating example; this is the regression test.
  it("finds a Cargo project nested one directory down, root-only markers absent", async () => {
    mkdirSync(join(dir, "server"));
    writeFileSync(join(dir, "server", "Cargo.toml"), "[package]\nname = \"x\"\n");
    expect(await detectEcosystems(dir)).toStrictEqual([{ ecosystem: "cargo", dir: "server" }]);
  });

  it("does not walk past one level", async () => {
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "Cargo.toml"), "[package]\nname = \"x\"\n");
    expect(await detectEcosystems(dir)).toStrictEqual([]);
  });

  // A stray package.json inside node_modules (a sub-dependency's own manifest, not
  // this project's) must not be reported as a project root in its own right.
  it("skips node_modules and other build/vendor noise", async () => {
    mkdirSync(join(dir, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "some-pkg", "package.json"), "{}");
    mkdirSync(join(dir, "target"), { recursive: true });
    writeFileSync(join(dir, "target", "Cargo.toml"), "[package]\nname = \"x\"\n");
    expect(await detectEcosystems(dir)).toStrictEqual([]);
  });
});

// Exit 137 is SIGKILL, and here it is nearly always our own `--memory` limit
// stopping a monorepo that fans out across thirty packages. It is not a fault in
// the branch, and reporting it as one is a confident false statement about someone
// else's code — high severity, pointed at a gate that actually passes.
//
// Observed: `turbo run typecheck` with 27 of 28 packages green and one killed,
// reported as "`pnpm run typecheck` fails on this branch".
describe("a process we killed did not fail", () => {
  const result = (code: number) => ({ ok: code === 0, stdout: "some output", stderr: "", code });

  it("reports a kill as unavailable, with nothing claimed about the branch", () => {
    const out = scriptFinding("tsc", "pnpm run typecheck", result(137));
    expect(out.findings).toStrictEqual([]);
    expect(out.unavailable).toMatch(/killed/);
    // The distinction that matters to a reader: we do not know either way.
    expect(out.unavailable).toMatch(/not a fault in the branch/);
  });

  it("still reports an ordinary failure as a finding", () => {
    const out = scriptFinding("tsc", "pnpm run typecheck", result(1));
    expect(out.unavailable).toBeUndefined();
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.claim).toContain("fails on this branch");
    expect(out.findings[0]?.severity).toBe("high");
  });
});

//  Two functions held
// two lists with OPPOSITE precedence: the cache key took `package-lock.json` first,
// the installer took `pnpm-lock.yaml` first. A repo carrying both got its key from
// one file while installing from the other — so a change to the lockfile that
// actually mattered left the key untouched and the previous node_modules was reused.
// A review running against dependencies that are not the branch's, and nothing says so.
describe("the cache key follows the installer", () => {
  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

  it("keys on the lockfile the chosen manager installs from", async () => {
    write("package.json", "{}");
    write("package-lock.json", "npm-v1");
    write("pnpm-lock.yaml", "pnpm-v1");
    const before = await lockfileKey(dir);

    // The file the installer does NOT use changes: the key must not move.
    write("package-lock.json", "npm-v2-completely-different");
    expect(await lockfileKey(dir)).toBe(before);

    // The file it DOES use changes: the key must move.
    write("pnpm-lock.yaml", "pnpm-v2");
    expect(await lockfileKey(dir)).not.toBe(before);
  });

  it("agrees with commandsFor on which file that is", async () => {
    write("package.json", "{}");
    write("package-lock.json", "x");
    write("pnpm-lock.yaml", "y");
    const outcome = await commandsFor(dir);
    if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.why}`);
    expect(outcome.toolchain.lockfile).toBe("pnpm-lock.yaml");
  });

  it("says no-lockfile rather than inventing a key", async () => {
    expect(await lockfileKey(dir)).toBe("no-lockfile");
  });
});

describe("cargo's own cache key mirrors lockfileKey (D-131)", () => {
  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

  it("keys on Cargo.lock's content", async () => {
    write("Cargo.toml", "[package]\nname = \"x\"\n");
    write("Cargo.lock", "v1");
    const before = await cargoLockKey(dir, ".");
    write("Cargo.lock", "v2-completely-different");
    expect(await cargoLockKey(dir, ".")).not.toBe(before);
  });

  it("says no-lockfile rather than inventing a key, same as lockfileKey", async () => {
    write("Cargo.toml", "[package]\nname = \"x\"\n");
    expect(await cargoLockKey(dir, ".")).toBe("no-lockfile");
  });

  // A nested crate (D-129's `teammater` shape: root is plain JS, `server/` is the
  // real crate) keeps its own Cargo.lock in `dir`, not at the worktree root — the
  // whole reason this takes `dir` as a parameter rather than assuming the root.
  it("reads the lockfile from the manifest's own directory, not always the root", async () => {
    mkdirSync(join(dir, "server"));
    writeFileSync(join(dir, "server", "Cargo.toml"), "[package]\nname = \"x\"\n");
    writeFileSync(join(dir, "server", "Cargo.lock"), "nested-lock");
    expect(await cargoLockKey(dir, "server")).not.toBe("no-lockfile");
    expect(await cargoLockKey(dir, ".")).toBe("no-lockfile");
  });
});

// Fingerprint 0b55733a: `execFile`'s own timeout cannot be trusted to actually
// stop a hung container — verified against current Docker CLI behaviour (the
// signal-forwarding this would have relied on was removed in 27.0.3+, and this
// image's own docker is 27.5.1) and confirmed kernel PID-1 semantics, neither of
// which a plain (non-namespaced) fake process can reproduce. What CAN be verified
// without real Docker: that a timeout makes this code issue an explicit, separate
// `kill <container-name>` — not that a real container actually dies from it.
describe("a timed-out sandboxed run is killed explicitly, not left to a signal that may not arrive", () => {
  let scratch: string;
  let cache: string;
  let log: string;
  let baseSandbox: SandboxConfig;

  beforeEach(() => {
    scratch = join(dir, "scratch-abc123");
    cache = join(dir, "cache");
    log = join(dir, "calls.log");
    writeFileSync(log, "");
  });

  /**
   * `$1` decides the behaviour, the same distinction a real `docker` binary makes
   * between its own subcommands — unlike `runner.test.ts`'s `fakeDocker`, which
   * ignores argv entirely and cannot tell `run` from `kill` apart. Every
   * invocation's full argv is appended to `log` first, so a test can assert
   * exactly what this code actually ran, not just what it returned. `rm` (the
   * pre-run `clearStaleContainer` call, fingerprint bfc4e055) exits clean like a
   * real one against a name not in use — logged like every other call, since
   * these tests assert on its presence too now.
   */
  const fakeDockerBinary = (): string => {
    const script = join(dir, "fake-docker.sh");
    writeFileSync(
      script,
      "#!/bin/sh\n" +
        `printf '%s\\n' "$*" >> "${log}"\n` +
        'case "$1" in\n' +
        "  run) sleep 5 ;;\n" +
        "  kill) exit 0 ;;\n" +
        "  rm) exit 0 ;;\n" +
        "esac\n",
    );
    chmodSync(script, 0o755);
    baseSandbox = {
      image: "unused",
      cacheRoot: cache,
      scratchRoot: dir,
      uid: 1000,
      gid: 1000,
      memory: "6g",
      cpus: "2",
      // Long enough for the fake script's OWN process to start and log its argv
      // before being killed — a too-tight timeout races the shell's own startup
      // (fork+exec+parse) rather than testing anything about this code, and that
      // race is worse than it sounds under load: 800ms was reliable run alone,
      // then flaked in the full suite (many other files' own child processes
      // competing for the same CPU). 2s costs one slow test and buys real margin.
      timeoutMs: 2_000,
      runtime: script,
    };
    return script;
  };

  it("runInSandbox: clears any stale container, then issues an explicit kill after a timeout", async () => {
    fakeDockerBinary();
    const result = await runInSandbox(baseSandbox, dir, cache, scratch, "echo hi", false);
    expect(result.timedOut).toBe(true);

    const calls = readFileSync(log, "utf8").trim().split("\n");
    const runCall = calls.find((c) => c.startsWith("run "));
    expect(runCall, `expected a run call among: ${JSON.stringify(calls)}`).toBeDefined();
    const killCall = calls.find((c) => c.startsWith("kill "));
    expect(killCall, `expected a kill call among: ${JSON.stringify(calls)}`).toBeDefined();
    // The SAME name every step used — otherwise the kill (or the clear) targets
    // a container that was never this run's own.
    const nameInRun = runCall?.match(/--name (\S+)/)?.[1];
    expect(nameInRun).toBeDefined();
    // clearStaleContainer, ahead of the run it is clearing the way for.
    expect(calls[0]).toBe(`rm -f ${nameInRun}`);
    expect(killCall).toBe(`kill ${nameInRun}`);
  });

  it("install: also clears stale state and issues an explicit kill, the same as runInSandbox", async () => {
    fakeDockerBinary();
    const result = await install(baseSandbox, dir, cache, scratch, {
      name: "npm",
      lockfile: "package-lock.json",
      install: "npm ci",
      run: (s) => `npm run ${s}`,
    });
    expect(result.timedOut).toBe(true);
    const log_ = readFileSync(log, "utf8");
    expect(log_).toMatch(/^rm -f /m);
    expect(log_).toMatch(/^kill /m);
  });

  it("does not attempt a kill when the run finishes on its own", async () => {
    const script = join(dir, "fake-docker-fast.sh");
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
    chmodSync(script, 0o755);
    const sandbox: SandboxConfig = {
      image: "unused", cacheRoot: cache, scratchRoot: dir, uid: 1000, gid: 1000,
      memory: "6g", cpus: "2", timeoutMs: 30_000, runtime: script,
    };
    const result = await runInSandbox(sandbox, dir, cache, scratch, "echo hi", false);
    expect(result.timedOut).toBe(false);
    expect(readFileSync(log, "utf8")).not.toMatch(/^kill /m);
  });
});
