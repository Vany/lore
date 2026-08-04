import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBare, sshCommand, usesSsh } from "./repo.ts";

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
  // What can honestly be tested without an ssh server, and what cannot.
  //
  // A real ssh url never reaches the config step here: ensureBare writes
  // core.sshCommand only AFTER a successful clone, and cloning git@github.com needs
  // a host. So the decision and the string are tested directly, and the plumbing
  // between them is exercised by a real private remote, not by a unit test
  // pretending to be one. The first version of this test cloned a LOCAL path with a
  // key beside it and asserted the ssh command was written — which was asserting the
  // bug below, not the behaviour.
  it.each([
    ["git@github.com:org/repo.git", true],
    ["ssh://git@host/org/repo.git", true],
    ["https://github.com/org/repo.git", false],
    ["git://host/repo.git", false],
    ["/Users/vany/c/repo", false],
    ["./checkout", false],
  ])("usesSsh(%s) === %s", (url, expected) => {
    expect(usesSsh(url)).toBe(expected);
  });

  it("offers the deploy key and nothing else", () => {
    const cmd = sshCommand("/k/r1_ed25519", "/k/known_hosts");
    expect(cmd).toContain("-i /k/r1_ed25519");
    // Without this ssh also offers the agent's keys, so the service authenticates as
    // the PERSON and can push while believing it holds a read-only key.
    expect(cmd).toContain("IdentitiesOnly=yes");
    // `no` would silently accept a CHANGED host, which is what checking is for.
    expect(cmd).toContain("StrictHostKeyChecking=accept-new");
    expect(cmd).toContain("UserKnownHostsFile=/k/known_hosts");
  });

  // The bug in the first version of D-62: it asked whether a key EXISTED, and keys
  // exist for repositories that turned out to be local paths or public https urls.
  // Both would have had an ssh command written in for a transport they never use.
  it("ignores a key when the url does not use ssh", async () => {
    const src = join(root, "src4");
    mkdirSync(src, { recursive: true });
    const s = (...a: string[]) => execFileSync("git", a, { cwd: src, stdio: "ignore" });
    s("init", "-q", "-b", "main");
    s("config", "user.email", "t@e.com");
    s("config", "user.name", "t");
    writeFileSync(join(src, "a.txt"), "a\n");
    s("add", "-A");
    s("commit", "-qm", "x");

    const keys = join(root, "keys4");
    mkdirSync(keys, { recursive: true });
    const keyPath = join(keys, "r4_ed25519");
    writeFileSync(keyPath, "not-a-real-key\n");

    // `src` is a local path, and the key is right there beside it.
    const paths = { bare: join(root, "repos/r4/bare.git"), worktrees: join(root, "repos/r4/wt") };
    await ensureBare(paths, src, keyPath);

    expect(() =>
      execFileSync("git", ["-C", paths.bare, "config", "--get", "core.sshCommand"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).toThrow();
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
