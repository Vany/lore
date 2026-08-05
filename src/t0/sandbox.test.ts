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
import { commandsFor } from "./sandbox.ts";

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
    expect(cmds?.install).toContain(name);
    expect(cmds?.test).toContain(name);
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
