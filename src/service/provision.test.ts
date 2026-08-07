/**
 * Provisioning has to describe what it actually did, and print a config that works.
 *
 * Two findings, a day apart, the same shape both times — confident output asserting
 * something untrue:
 *
 *   * a local directory got a generated ed25519 keypair, a private half written to
 *     disk, and an instruction to install it as a deploy key on a repository with no
 *     remote. A step that cannot be followed, printed next to two that must be. No key
 *     is generated for any url now, since lore does not fetch at all (D-65).
 *   * the `.mcp.json` fragment — nine lines whose whole purpose is to be pasted
 *     without thought — was wrong in three independent, each individually fatal,
 *     ways. It was never compared against a config known to work, though one sat in
 *     this repository the entire time.
 *
 * So the fragment is checked structurally here, not by eye. `toContain` on a JSON
 * blob is the test that would have passed while all three fields were wrong.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { authenticate } from "../mcp/auth.ts";
import { Store } from "../store/store.ts";
import { provision, renderProvisioned } from "./provision.ts";

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  store.close();
});

const make = (gitUrl: string) => provision({ store, name: "vany", gitUrl, publicUrl: "http://lore:7777/mcp" });

describe("the client config is a real .mcp.json", () => {
  it("parses, and uses the key, type and expansion the client actually reads", async () => {
    const cfg = JSON.parse((await make("git@github.com:org/repo.git")).clientConfig);

    // Each of these was wrong, and each alone stops the server from ever loading.
    expect(Object.keys(cfg)).toStrictEqual(["mcpServers"]); // was `mcp`
    expect(cfg.mcpServers.lore.type).toBe("http"); // was `remote`
    expect(cfg.mcpServers.lore.headers.Authorization).toBe("Bearer ${LORE_TOKEN}"); // was {env:...}
    expect(cfg.mcpServers.lore.url).toBe("http://lore:7777/mcp");
  });

  // D-21. The token is minted here, so a slip could put it in the url trivially.
  it("never puts the secret in the url", async () => {
    const p = await make("git@github.com:org/repo.git");
    expect(p.clientConfig).not.toContain(p.token);
    expect(JSON.parse(p.clientConfig).mcpServers.lore.url).not.toContain("token");
  });
});

describe("what the printed steps promise", () => {
  // The distinction the old output turned on is gone: `make mirror` clones a local
  // path and a remote with one command, so both get one set of instructions.
  it.each([["git@github.com:org/repo.git"], ["/Users/vany/c/rigid-monorepo"], ["https://github.com/org/repo.git"]])(
    "%s is told to mirror, and is never told to install a key",
    async (url) => {
      const out = renderProvisioned(await make(url));
      expect(out).toContain("make mirror");
      expect(out).not.toMatch(/deploy key/i);
      expect(out).toContain("1. Populate the mirror");
      expect(out).toContain("2. Set LORE_TOKEN");
      expect(out).toContain("3. Add to .mcp.json");
    },
  );

  // The round trip, not the storage shape: the token that gets printed is the token
  // that opens the door, and it opens it onto the repo just provisioned.
  it("prints a token that authenticates for this repo", async () => {
    const p = await make("git@github.com:org/repo.git");
    expect(renderProvisioned(p)).toContain(p.token);

    const who = authenticate(store, `Bearer ${p.token}`);
    expect(who?.principal).toBe("vany");
    expect(who?.repoId).toBe(p.repoId);
    expect(authenticate(store, "Bearer lore_not_a_real_token")).toBeUndefined();
  });
});

describe("provisioning the same url twice", () => {
  // Registering `lore` a second time under a different protocol produced a second
  // repo row with its own clone and its own history, and the knowledge split across
  // both. Merging them by hand cost a transaction over nine tables.
  it("reuses the repo and does not fork its history", async () => {
    const a = await make("git@github.com:org/repo.git");
    const b = await make("git@github.com:org/repo.git");
    expect(b.repoId).toBe(a.repoId);
    expect(b.token).not.toBe(a.token);
  });
});

// THE FIRST THING A NEW OPERATOR READS, and it was two days out of date.
//
// D-65 (2026-08-05) moved mirror refreshing to a host timer precisely because it "is
// not the client's responsibility" — and this output went on saying "run it again
// before each review", a chore that had been automatic since. Nothing pinned it, which
// is how it survived: `TOOL_DOCS` has a mechanical check that the client-facing texts
// stay honest, and the operator-facing one had none.
//
// It matters more than a stale sentence usually would. An operator who believes the
// refresh is theirs will not install the daemon, and the first they hear of it is a
// client relaying a refusal they cannot act on.
describe("what a new operator is told about mirrors", () => {
  it("says refresh ONCE and names the timer that does the rest", async () => {
    const out = renderProvisioned(await make("git@github.com:org/repo.git"));
    expect(out).toContain("make mirror REPO=repo");
    expect(out).toContain("make mirror-daemon");
    expect(out).toMatch(/ONCE, not before every review/);
  });

  it("never tells anybody to refresh before each review", async () => {
    const out = renderProvisioned(await make("git@github.com:org/repo.git"));
    expect(out).not.toMatch(/before each review|before every review\b(?!\.)/i);
  });

  // lore cannot tell whether the timer is alive — it holds no credentials and does not
  // fetch — so the operator has to be told where to look rather than left to assume
  // silence means health.
  it("says how to see whether it is still working", async () => {
    const out = renderProvisioned(await make("git@github.com:org/repo.git"));
    expect(out).toContain("make status");
  });
});
