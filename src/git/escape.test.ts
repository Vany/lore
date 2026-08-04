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

// D-62. The deploy key was generated at provisioning and used by nothing, so every
// ssh remote failed to clone while a public https url and a local path kept working
// — the documented workflow had never run end to end.
describe("a repo with a deploy key authenticates with it", () => {
  it("pins the key into the clone, and offers no other identity", async () => {
    const src = join(root, "src2");
    mkdirSync(src, { recursive: true });
    const s = (...a: string[]) => execFileSync("git", a, { cwd: src, stdio: "ignore" });
    s("init", "-q", "-b", "main");
    s("config", "user.email", "t@e.com");
    s("config", "user.name", "t");
    writeFileSync(join(src, "a.txt"), "a\n");
    s("add", "-A");
    s("commit", "-qm", "x");

    const keys = join(root, "keys");
    mkdirSync(keys, { recursive: true });
    const keyPath = join(keys, "r1_ed25519");
    writeFileSync(keyPath, "not-a-real-key\n");

    const paths = { bare: join(root, "repos/r1/bare.git"), worktrees: join(root, "repos/r1/wt") };
    await ensureBare(paths, src, keyPath);

    const cfg = execFileSync("git", ["-C", paths.bare, "config", "--get", "core.sshCommand"], { encoding: "utf8" });
    expect(cfg).toContain(keyPath);
    // Without this ssh also offers the agent's keys, which authenticates as the
    // person rather than as the read-only deploy key.
    expect(cfg).toContain("IdentitiesOnly=yes");
    // `no` would silently accept a CHANGED host, which is what checking is for.
    expect(cfg).toContain("StrictHostKeyChecking=accept-new");
  });

  it("does not set an ssh command when there is no key", async () => {
    const src = join(root, "src3");
    mkdirSync(src, { recursive: true });
    const s = (...a: string[]) => execFileSync("git", a, { cwd: src, stdio: "ignore" });
    s("init", "-q", "-b", "main");
    s("config", "user.email", "t@e.com");
    s("config", "user.name", "t");
    writeFileSync(join(src, "a.txt"), "a\n");
    s("add", "-A");
    s("commit", "-qm", "x");

    const paths = { bare: join(root, "repos/r2/bare.git"), worktrees: join(root, "repos/r2/wt") };
    await ensureBare(paths, src, join(root, "keys", "absent_ed25519"));

    // `git config --get` exits 1 when the key is unset, so absence IS the throw.
    expect(() =>
      execFileSync("git", ["-C", paths.bare, "config", "--get", "core.sshCommand"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).toThrow();
  });
});
