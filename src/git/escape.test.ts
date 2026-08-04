import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBare } from "./repo.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-esc-"));
  // An OUTER repository, standing in for the operator's checkout.
  const outer = join(root, "outer");
  mkdirSync(outer, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: outer, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
  writeFileSync(join(outer, "f.txt"), "x\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  g("tag", "precious-tag");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("git cannot climb out of the directory it was aimed at", () => {
  it("clones into an empty dir nested in another repo, and leaves that repo alone", async () => {
    const outer = join(root, "outer");
    // lore's data directory living INSIDE a checkout: the normal layout.
    const paths = { bare: join(outer, "data/repos/r1/bare.git"), worktrees: join(outer, "data/repos/r1/wt") };
    const src = join(root, "source");
    mkdirSync(src, { recursive: true });
    const s = (...a: string[]) => execFileSync("git", a, { cwd: src, stdio: "ignore" });
    s("init", "-q", "-b", "main");
    s("config", "user.email", "t@e.com");
    s("config", "user.name", "t");
    writeFileSync(join(src, "a.txt"), "a\n");
    s("add", "-A");
    s("commit", "-qm", "src");

    await ensureBare(paths, src);

    // The bare clone is real, and the outer repository still has its tag.
    const head = execFileSync("git", ["-C", paths.bare, "rev-parse", "--is-bare-repository"], { encoding: "utf8" });
    expect(head.trim()).toBe("true");
    const tags = execFileSync("git", ["-C", outer, "tag"], { encoding: "utf8" });
    expect(tags).toContain("precious-tag");
  });
});
