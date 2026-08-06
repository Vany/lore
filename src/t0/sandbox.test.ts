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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptFinding } from "./runner.ts";
import { commandsFor, lockfileKey } from "./sandbox.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-tc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lock = (name: string) => writeFileSync(join(dir, name), "");

describe("the installer follows the lockfile", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ])("%s -> %s", async (file, name) => {
    lock(file);
    const cmds = await commandsFor(dir);
    expect(cmds?.name).toBe(name);
    // Install only. There is no `test` command any more (D-71): lore reads a suite
    // and never runs it, so the toolchain carries nothing to run one with.
    expect(cmds?.install).toContain(name);
  });

  // A repo with no lockfile at all is not an error: npm is the reasonable default
  // and `npm install` will resolve from package.json.
  it("falls back to npm when there is no lockfile", async () => {
    expect((await commandsFor(dir))?.name).toBe("npm");
  });

  // The most specific manager wins. A repo carrying two lockfiles is already a mess,
  // and picking the wrong one installs a tree the project never uses.
  it("prefers pnpm when a stale package-lock.json is also present", async () => {
    lock("package-lock.json");
    lock("pnpm-lock.yaml");
    expect((await commandsFor(dir))?.name).toBe("pnpm");
  });

  // Bun is a different runtime, not just a different installer, and is not in the
  // sandbox image. Undefined here becomes an unavailable engine — installing with
  // npm instead and reporting the result as the project's own suite would be a
  // confident claim about something that never ran.
  it.each([["bun.lock"], ["bun.lockb"]])("refuses rather than guessing for %s", async (file) => {
    lock(file);
    expect(await commandsFor(dir)).toBeUndefined();
  });

  // The install must tolerate a lockfile that does not match package.json — common
  // on a branch that changed dependencies — rather than failing the whole tier on it.
  it("falls back from a frozen install to a resolving one", async () => {
    lock("pnpm-lock.yaml");
    expect((await commandsFor(dir))?.install).toMatch(/--frozen-lockfile \|\|/);
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
  const result = (code: number) => ({ stdout: "some output", stderr: "", code });

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

// Raised by t1 against the commit that introduced the installer. Two functions held
// two lists with OPPOSITE precedence: the cache key took `package-lock.json` first,
// the installer took `pnpm-lock.yaml` first. A repo carrying both got its key from
// one file while installing from the other — so a change to the lockfile that
// actually mattered left the key untouched and the previous node_modules was reused.
// A review running against dependencies that are not the branch's, and nothing says so.
describe("the cache key follows the installer", () => {
  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

  it("keys on the lockfile the chosen manager installs from", async () => {
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
    write("package-lock.json", "x");
    write("pnpm-lock.yaml", "y");
    expect((await commandsFor(dir))?.lockfile).toBe("pnpm-lock.yaml");
  });

  it("says no-lockfile rather than inventing a key", async () => {
    expect(await lockfileKey(dir)).toBe("no-lockfile");
  });
});
