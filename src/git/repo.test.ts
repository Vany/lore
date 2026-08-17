/**
 * The git boundary, where a caller's string meets a command line.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revParse } from "./repo.ts";

/**
 * A CLIENT'S STRING MUST NOT REACH GIT'S ARGV AS ITSELF.
 *
 * Git reads any argument beginning with `-` as an OPTION, not a ref — so an unvalidated
 * commit handed to `git diff <tree> <commit>` is an option-injection surface, and this
 * service hands that slot to anyone holding a token. `--output=` alone turns a read into
 * an arbitrary file write, aimed wherever the caller likes, against a service whose
 * database IS the product. It also breaks D-61 outright: git must never be aimed outside
 * the directory it was given.
 *
 * `revParse` is the one gate. Everything downstream sees a 40-character sha, which cannot
 * be an option however the caller wrote it.
 */
describe("resolving a caller's commit before git sees it", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-revparse-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "one");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves a real commit to its sha", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    expect(await revParse(dir, "HEAD")).toBe(head);
    expect(await revParse(dir, "main")).toBe(head);
  });

  // THE FINDING, AS A TEST. Every one of these is a git option, and each was accepted
  // verbatim into argv before this gate existed.
  it.each([["--output=/tmp/lore-pwned"], ["--no-index"], ["-z"], ["--textconv"]])(
    "refuses %j rather than handing it to git as a flag",
    async (hostile) => {
      expect(await revParse(dir, hostile)).toBeUndefined();
    },
  );

  it("refuses a ref that simply does not exist", async () => {
    expect(await revParse(dir, "no-such-branch")).toBeUndefined();
  });

  // A TREE IS NOT A COMMIT. `^{commit}` is what refuses it, and the submit path needs a
  // commit specifically — a tree would resolve and then mean something different.
  it("refuses a tree object", async () => {
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
    expect(await revParse(dir, tree)).toBeUndefined();
  });
});
