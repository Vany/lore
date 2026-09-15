/**
 * The environment every git call runs under, and the one thing it must NOT do.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, gitEnv } from "./exec.ts";

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

/** Every `safe.directory` value gitEnv emitted, in order. */
function safeDirs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([k]) => /^GIT_CONFIG_VALUE_\d+$/.test(k))
    .sort(([a], [b]) => Number(a.slice(17)) - Number(b.slice(17)))
    .map(([, v]) => v);
}

/**
 * A real bare clone with a linked worktree, laid out the way `repo.ts` lays one out:
 * `repos/<id>/bare.git` and `repos/<id>/wt/<review>`. Built with plain git, not gitEnv,
 * because it is the fixture and not the thing under test.
 */
function linkedFixture(): { bare: string; worktree: string } {
  const plain = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as Record<string, string>;
  const run = (args: string[], cwd?: string): void => {
    const r = spawnSync("git", args, { cwd, env: plain, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture: git ${args.join(" ")} failed: ${r.stderr}`);
  };
  const src = mkdtempSync(join(tmpdir(), "lore-src-"));
  run(["init", "-q", src]);
  run(["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"]);
  const repoDir = join(root, "repos", "fixture");
  mkdirSync(repoDir, { recursive: true });
  const bare = join(repoDir, "bare.git");
  run(["clone", "-q", "--bare", src, bare]);
  const worktree = join(repoDir, "wt", "rev_fixture");
  run(["-C", bare, "worktree", "add", "-q", "--detach", worktree, "HEAD"]);
  return { bare, worktree };
}

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
    const values = safeDirs(env);
    expect(env["GIT_CONFIG_KEY_0"]).toBe("safe.directory");
    // THE CANONICAL ROOT is among the values, not at a fixed position. It used to be
    // asserted at index 0, which pinned the ordering rather than the property — and the
    // exact repositories now come first, because they are the entries that actually work
    // on the git lore ships (D-146).
    expect(values).toContain(realpathSync(root));
    expect(values).toContain(`${realpathSync(root)}/*`);
  });

  /**
   * THE EXACT REPOSITORY IS NAMED, AND THIS IS THE ASSERTION THAT WAS MISSING (D-146).
   *
   * git 2.39.5 — the version in lore's image — ignores the `<dataDir>/*` form entirely.
   * Measured in the container with the foreign-owner check forced on: `/*` REFUSED, the
   * exact `bare.git` passed. The suite runs on a host whose git DOES honour `/*`, so a test
   * that only exercised real git would keep passing while production stayed broken. This
   * one does not depend on any git version: the exact path is either in the list or not.
   */
  it("names the exact bare repository, not only a prefix git may ignore", () => {
    const { bare } = linkedFixture();
    expect(safeDirs(gitEnv(bare))).toContain(realpathSync(bare));
  });

  it("names a linked worktree's own gitdir and the bare repository it belongs to", () => {
    const { bare, worktree } = linkedFixture();
    const values = safeDirs(gitEnv(worktree));
    expect(values, "the worktree itself").toContain(realpathSync(worktree));
    expect(values, "the bare clone its commondir points at").toContain(realpathSync(bare));
  });

  /**
   * AND THE EXACT ENTRIES ALONE ARE ENOUGH, proven against real git without the prefix form.
   *
   * Every `/*` value is stripped before git runs, which is precisely what git 2.39.5 sees.
   * The first assertion is the CONTROL: with no exemption the command must be REFUSED. The
   * previous verification of this function ran while ownership happened to be fine, so git
   * never consulted `safe.directory` and every row passed — including the wrong ones. A
   * test whose control does not refuse is measuring nothing, so this one fails if it does.
   */
  it("lets git through on exact entries alone, where the control is refused", () => {
    const { bare } = linkedFixture();
    const isolated = {
      ...process.env,
      // A host with `safe.directory=*` in its global config would make the control pass.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
    } as Record<string, string>;
    const list = (env: Record<string, string>): string =>
      spawnSync("git", ["-C", bare, "worktree", "list", "--porcelain"], { env, encoding: "utf8" }).stdout;

    expect(list(isolated), "CONTROL: without an exemption git must refuse, or this proves nothing").toBe("");

    const exactOnly = safeDirs(gitEnv(bare)).filter((v) => !v.endsWith("/*"));
    const withExact: Record<string, string> = { ...isolated, GIT_CONFIG_COUNT: String(exactOnly.length) };
    exactOnly.forEach((v, i) => {
      withExact[`GIT_CONFIG_KEY_${String(i)}`] = "safe.directory";
      withExact[`GIT_CONFIG_VALUE_${String(i)}`] = v;
    });
    expect(list(withExact), "the exact entries must carry it without the prefix form").toContain("worktree ");
  });

  /**
   * THE CHECK THE UNIT ASSERTIONS CANNOT MAKE: does the value we hand git equal the path
   * git actually compares it against?
   *
   * Everything above inspects the env we build, which is how the symlink hole survived a
   * test written specifically for this function. Real refusal needs a foreign uid and a
   * test cannot make one — but the mechanism behind the refusal is a string comparison,
   * and this pins both sides of it against the real git in this image.
   */
  it("names the same path git itself resolves the repository to", async () => {
    const repo = join(root, "repos", "canon");
    await git(root, ["init", "-q", repo]);
    const { stdout } = await git(repo, ["rev-parse", "--show-toplevel"]);
    const asGitSeesIt = stdout.trim();
    const env = gitEnv(repo);
    const exempted = [env["GIT_CONFIG_VALUE_0"], env["GIT_CONFIG_VALUE_2"]].filter((v) => v !== undefined);
    expect(
      exempted.some((v) => asGitSeesIt === v || asGitSeesIt.startsWith(v + "/")),
      `git resolves the repo to ${asGitSeesIt}; the exemption names ${exempted.join(" and ")}`,
    ).toBe(true);
  });

  /**
   * AND THE UNCANONICAL SPELLING IS SENT TOO, because which of the two a given git compares
   * is a property of that git, and the cost of guessing wrong is silence.
   *
   * THE SYMLINK IS BUILT HERE RATHER THAN HOPED FOR (`5d2e4db7`). The first version of
   * this test asserted the second spelling inside `if (realpath !== resolve)` — true on
   * macOS, where `mkdtemp` lands under `/var/folders`, and FALSE on a Linux runner with a
   * plain `/tmp`. There the whole assertion was skipped, so deleting the second spelling
   * from `exec.ts` would have passed CI and failed only on a deployment reached through a
   * symlink. A conditional assertion is a test that is absent exactly where it is cheap to
   * be absent.
   */
  it("sends both spellings when the data directory is reached through a symlink", () => {
    const link = join(mkdtempSync(join(tmpdir(), "lore-link-")), "data");
    symlinkSync(realpathSync(root), link);
    process.env["LORE_DATA_DIR"] = link;
    expect(realpathSync(link), "the fixture must actually be a symlink for this to test anything")
      .not.toBe(resolve(link));

    const env = gitEnv(link);
    const values = Object.entries(env)
      .filter(([k]) => k.startsWith("GIT_CONFIG_VALUE_"))
      .map(([, v]) => v);
    expect(values, "git compares the canonical path").toContain(realpathSync(link));
    expect(values, "the as-written path must travel too").toContain(resolve(link));
    expect(env["GIT_CONFIG_COUNT"]).toBe("4");
  });

  /**
   * A PATH THAT DOES NOT EXIST YET STILL GETS THE EXEMPTION, because lore hands git
   * paths that do not exist yet — `git init <dest>`, `clone <dest>`, `worktree add
   * <dest>` — and those are exactly the calls that CREATE its tree. The first version of
   * the canonicalizing fix answered `undefined` for them and silently withheld it.
   */
  it("exempts a directory inside the tree that has not been created yet", () => {
    const env = gitEnv(join(root, "repos", "not-yet", "bare.git"));
    expect(env["GIT_CONFIG_KEY_0"]).toBe("safe.directory");
  });

  /**
   * AND A SYMLINK PARTWAY DOWN THAT LEAVES THE TREE IS REFUSED — canonicalizing makes the
   * scope check STRICTER, not merely different. Without it, `dataDir()/repos/x` pointing
   * at a stranger's checkout would read as inside lore's own tree by string prefix alone.
   */
  it("does not exempt a path inside the tree that symlinks out of it", () => {
    const outside = mkdtempSync(join(tmpdir(), "lore-elsewhere-"));
    mkdirSync(join(root, "repos"), { recursive: true });
    symlinkSync(outside, join(root, "repos", "escape"));
    expect(gitEnv(join(root, "repos", "escape", "repo"))["GIT_CONFIG_COUNT"]).toBeUndefined();
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
    // 2 entries for one spelling, 4 when the canonical and as-written paths differ.
    expect(["2", "4"]).toContain(gitEnv(root)["GIT_CONFIG_COUNT"]);
  });
});
