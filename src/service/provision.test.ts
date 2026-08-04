/**
 * Provisioning has to describe what it actually did.
 *
 * Found by provisioning the first repository that was not lore itself: a local
 * directory got a generated ed25519 keypair, a private half written to disk, and an
 * instruction to install it as a deploy key on a repository that has no remote. A
 * step that cannot be followed, printed next to two that must be.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { isLocalPath, provision, renderProvisioned } from "./provision.ts";

let store: Store;
let keysDir: string;

beforeEach(() => {
  store = new Store(":memory:");
  keysDir = mkdtempSync(join(tmpdir(), "lore-keys-"));
});
afterEach(() => {
  store.close();
  rmSync(keysDir, { recursive: true, force: true });
});

describe("telling a path from a remote", () => {
  it.each([
    ["/Users/vany/c/rigid-monorepo", true],
    ["./relative/checkout", true],
    ["file:///srv/repo", true],
    ["git@github.com:org/repo.git", false],
    ["ssh://git@host/org/repo.git", false],
    ["https://github.com/org/repo.git", false],
    ["git://host/repo.git", false],
  ])("%s -> local=%s", (url, local) => {
    expect(isLocalPath(url)).toBe(local);
  });
});

describe("a local path", () => {
  const local = () =>
    provision({ store, name: "vany", gitUrl: "/Users/vany/c/rigid-monorepo", keysDir, publicUrl: "http://x/mcp" });

  // A private key for a repository that will never be reached is a secret created
  // for no reason — the smallest version of the same fault as printing the step.
  it("generates no key at all", async () => {
    const p = await local();
    expect(p.deployPublicKey).toBeUndefined();
    expect(readdirSync(keysDir)).toStrictEqual([]);
  });

  it("does not print a step that cannot be followed", async () => {
    const out = renderProvisioned(await local());
    expect(out).not.toContain("READ-ONLY deploy key");
    expect(out).toContain("No deploy key");
    // The steps that remain must still be numbered from 1.
    expect(out).toContain("1. Set LORE_TOKEN");
    expect(out).toContain("2. Add to the MCP client config");
  });
});

describe("a remote", () => {
  it("still generates a key and asks for it to be installed", async () => {
    const p = await provision({
      store, name: "vany", gitUrl: "git@github.com:org/repo.git", keysDir, publicUrl: "http://x/mcp",
    });
    expect(p.deployPublicKey).toMatch(/^ssh-ed25519 /);
    const out = renderProvisioned(p);
    expect(out).toContain("1. Add this as a READ-ONLY deploy key");
    expect(out).toContain("2. Set LORE_TOKEN");
    expect(out).toContain("3. Add to the MCP client config");
  });
});
