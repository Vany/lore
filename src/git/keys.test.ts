/**
 * The deploy key lore fetches with (D-65).
 *
 * These are the properties that decide whether reversing D-63 was safe, so they are
 * asserted rather than assumed: one key per repository and never a shared one,
 * generated once and never silently replaced, offered to ssh to the exclusion of
 * every other identity, and absent entirely for a url that needs no credential.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeInstructions, ensureDeployKey, isLocalPath, keyPathFor, sshCommandFor } from "./keys.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-keys-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a repository's key", () => {
  it("is generated once and reused, so authorizing it stays valid", async () => {
    const first = await ensureDeployKey(dir, "repo-1", "rigid-monorepo");
    expect(first.created).toBe(true);

    const second = await ensureDeployKey(dir, "repo-1", "rigid-monorepo");
    // The whole point: regenerating would invalidate a key the operator has already
    // pasted into the forge, and the fetch would break later for no visible reason.
    expect(second.created).toBe(false);
    expect(second.publicKey).toBe(first.publicKey);
  });

  it("is per repository, never shared", async () => {
    const a = await ensureDeployKey(dir, "repo-a", "alpha");
    const b = await ensureDeployKey(dir, "repo-b", "beta");
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privatePath).toBe(keyPathFor(dir, "repo-a"));
  });

  // A key readable by anything else on the box is a key that has already leaked.
  it("is unreadable by anyone but its owner, and so is the directory", async () => {
    const key = await ensureDeployKey(dir, "repo-perm", "perms");
    expect(statSync(key.privatePath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  // A forge's deploy-key list showing a bare uuid is a list nobody dares prune.
  it("carries the repository name, so a human can tell what it is", async () => {
    const key = await ensureDeployKey(dir, "repo-2", "rigid-monorepo");
    expect(key.publicKey).toContain("lore:rigid-monorepo");
    expect(key.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
  });

  it("is a real key ssh-keygen accepts", async () => {
    const key = await ensureDeployKey(dir, "repo-3", "real");
    const out = execFileSync("ssh-keygen", ["-lf", key.privatePath], { encoding: "utf8" });
    expect(out).toContain("ED25519");
  });
});

describe("the ssh command git is given", () => {
  // THE load-bearing option. Without it ssh offers every identity it can find,
  // including anything an agent has loaded, and the forge accepts the first that
  // works — so the fetch would quietly succeed on the operator's personal key and
  // per-repo scoping would be a fiction that happened to hold in testing.
  it("offers this key and no other", async () => {
    const key = await ensureDeployKey(dir, "repo-4", "scoped");
    const cmd = sshCommandFor(key.privatePath, dir);
    expect(cmd).toContain("IdentitiesOnly=yes");
    expect(cmd).toContain(key.privatePath);
  });

  it("never waits for a human who is not there", async () => {
    const key = await ensureDeployKey(dir, "repo-5", "batch");
    expect(sshCommandFor(key.privatePath, dir)).toContain("BatchMode=yes");
  });

  // `no` would accept a changed host key, which is the case that matters: a
  // redirected answer serving a different tree. `accept-new` trusts first use and
  // refuses a change.
  it("pins host keys after first use, in its own known_hosts", async () => {
    const cmd = sshCommandFor(join(dir, "k"), dir);
    expect(cmd).toContain("StrictHostKeyChecking=accept-new");
    expect(cmd).toContain(join(dir, "known_hosts"));
  });

  // GIT_SSH_COMMAND is parsed by a shell, and `/Users/me/My Data/keys` is a path a
  // person really has. Unquoted, it becomes two arguments and ssh reads the wrong one.
  it("survives a path with a space in it", () => {
    const cmd = sshCommandFor("/tmp/My Data/k_ed25519", "/tmp/My Data");
    expect(cmd).toContain("'/tmp/My Data/k_ed25519'");
    expect(cmd).toContain("'/tmp/My Data/known_hosts'");
  });
});

describe("which urls need a credential at all", () => {
  it.each([
    ["git@github.com:RigidFi/rigid-monorepo.git", false],
    ["ssh://git@github.com/o/r.git", false],
    ["https://github.com/o/r.git", false],
    ["/srv/checkouts/thing", true],
    ["./relative/thing", true],
    ["file:///srv/checkouts/thing", true],
  ])("%s is local: %s", (url, local) => {
    expect(isLocalPath(url)).toBe(local);
  });

  // The scp-like form is the one that matters most: it has no scheme and no leading
  // slash, so a naive check reads it as a path and skips the credential — and the
  // fetch then fails with an ssh error nobody expects.
  it("treats the scp-like form as remote", () => {
    expect(isLocalPath("git@github.com:o/r.git")).toBe(false);
  });
});

describe("what a human is told when the key is not authorized", () => {
  it("carries the key itself, rather than sending the reader looking", async () => {
    const key = await ensureDeployKey(dir, "repo-6", "unauthorized");
    const msg = authorizeInstructions("git@github.com:o/r.git", key);
    // This is the NORMAL first state of every new repository, not an anomaly, so the
    // message has to be sufficient on its own.
    expect(msg).toContain(key.publicKey);
    expect(msg).toContain("git@github.com:o/r.git");
    expect(msg).toMatch(/READ-ONLY/);
    // lore never pushes; a write key would breach D-2.
    expect(msg).toMatch(/UNTICKED/);
  });
});

describe("an existing key is adopted, not replaced", () => {
  // Upgrading from D-62 finds keys already on disk — one was still sitting in the
  // deployment's data directory, unused, when this was written. Regenerating over it
  // would break a key that may already be authorized.
  it("reuses a keypair written by something else", async () => {
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "older", "-f", keyPathFor(dir, "repo-7"), "-q"]);
    const before = readFileSync(`${keyPathFor(dir, "repo-7")}.pub`, "utf8").trim();

    const key = await ensureDeployKey(dir, "repo-7", "adopted");
    expect(key.created).toBe(false);
    expect(key.publicKey).toBe(before);
  });

  // A private half with no public half is the one shape that cannot be adopted:
  // there is nothing to tell the operator to authorize. Regenerating is wrong (it
  // would orphan a possibly-authorized key), so it fails loudly instead.
  //
  // This test is why the guard exists. Without it `ssh-keygen -f` onto an existing
  // file asks "Overwrite (y/n)?" and blocks on a stdin that never closes — so the
  // first version of this test did not fail, it HUNG, and in production that is a
  // review that sits for ever while the queue looks busy.
  it("fails rather than half-adopting a keypair missing its public half", async () => {
    writeFileSync(keyPathFor(dir, "repo-8"), "not a key\n");
    await expect(ensureDeployKey(dir, "repo-8", "broken")).rejects.toThrow(/will not overwrite a private key/);
    // Fast, not eventually: the point is that it does not wait for an answer.
    await expect(ensureDeployKey(dir, "repo-8", "broken")).rejects.toThrow(/ssh-keygen -y -f/);
  });
});
