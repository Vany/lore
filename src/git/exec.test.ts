/**
 * The environment every git call runs under, and the one thing it must NOT do.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "./exec.ts";

let saved: string | undefined;
let root: string;

beforeEach(() => {
  saved = process.env["LORE_DATA_DIR"];
  root = mkdtempSync(join(tmpdir(), "lore-data-"));
  process.env["LORE_DATA_DIR"] = root;
});

afterEach(() => {
  if (saved === undefined) delete process.env["LORE_DATA_DIR"];
  else process.env["LORE_DATA_DIR"] = saved;
});

describe("gitEnv", () => {
  // D-61. Without it git walks UP from cwd and answers from whatever encloses the target,
  // which once pointed a `fetch --prune` at an operator's own working repository.
  it("always sets the ceiling, wherever the call is aimed", () => {
    for (const dir of [join(root, "repos", "x"), "/somewhere/else"]) {
      expect(gitEnv(dir)["GIT_CEILING_DIRECTORIES"]).toBe(dir);
    }
  });

  /**
   * INSIDE lore's own tree, the ownership check is disabled — that is D-146, and without
   * it a slip in the host bind's uid mapping refuses every git call in the review path.
   */
  it("exempts lore's own data directory from the ownership check", () => {
    const env = gitEnv(join(root, "repos", "abc", "bare.git"));
    expect(env["GIT_CONFIG_KEY_0"]).toBe("safe.directory");
    expect(env["GIT_CONFIG_VALUE_0"]).toBe(resolve(root));
    // The bare clone a worktree resolves to is a level up from the worktree, so exempting
    // only the directory git was pointed at would leave it refused.
    expect(env["GIT_CONFIG_VALUE_1"]).toBe(`${resolve(root)}/*`);
  });

  /**
   * AND NOWHERE ELSE — the finding that made this scoped rather than `*`.
   *
   * `lore review --target <path>` takes a checkout from whoever runs it, and `treeHash`
   * opens with `git add -A` there. A blanket exemption let lore WRITE a repository it does
   * not own (D-2, INV-9) and run that repository's configured filters, which is the attack
   * git's check exists to stop. If git will not touch a stranger's repository, neither
   * should lore.
   */
  it("leaves a CLI target outside the data directory protected", () => {
    const env = gitEnv("/home/someone-else/checkout");
    expect(env["GIT_CONFIG_COUNT"], "no exemption at all out here").toBeUndefined();
    expect(env["GIT_CONFIG_KEY_0"]).toBeUndefined();
  });

  // A path that merely starts with the same characters is not inside it.
  it("does not exempt a sibling whose name shares the prefix", () => {
    expect(gitEnv(`${root}-evil/repo`)["GIT_CONFIG_COUNT"]).toBeUndefined();
  });

  it("exempts the data directory itself", () => {
    expect(gitEnv(root)["GIT_CONFIG_COUNT"]).toBe("2");
  });
});
