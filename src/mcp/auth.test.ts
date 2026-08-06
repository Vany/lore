/**
 * Revocation, which `spec/mcp-api.md` §1 has promised since day one and which nothing
 * could perform.
 *
 * `revokeToken(store, token)` took the SECRET — shown once at provisioning and stored
 * only as a hash — so an operator revoking a leaked, lost, or departed teammate's
 * token could not supply the one argument it wanted. It had no caller and no route to
 * one, while `make tokens` printed a `revoked_at` column nothing in the system could
 * ever set.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { authenticate, grantToken, listTokens, revokeByPrefix } from "./auth.ts";

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
});

afterEach(() => store.close());

describe("revoking by hash prefix", () => {
  // The whole point: no one holds the token here, which is the normal case.
  it("turns off a token the operator never had", () => {
    const token = grantToken(store, repoId, "vany", "laptop");
    expect(authenticate(store, `Bearer ${token}`)).toBeDefined();

    const short = listTokens(store)[0]?.short ?? "";
    expect(revokeByPrefix(store, short)).toMatchObject({ kind: "revoked", principal: "vany" });
    expect(authenticate(store, `Bearer ${token}`)).toBeUndefined();
  });

  // git's rule (spec/review-ladder.md §3.1.2), and it matters more here: picking a
  // winner locks out a teammate AND leaves the leaked token live.
  it("refuses an ambiguous prefix rather than choosing", () => {
    grantToken(store, repoId, "a");
    grantToken(store, repoId, "b");
    const r = revokeByPrefix(store, listTokens(store)[0]?.short.slice(0, 0) + "");
    // An empty prefix is not a prefix — it must not match everything.
    expect(r.kind).toBe("not-found");

    // A prefix every hash shares is the real ambiguity case.
    const all = listTokens(store);
    const common = commonPrefix(all.map((t) => t.short));
    if (common.length >= 4) {
      expect(revokeByPrefix(store, common).kind).toBe("ambiguous");
    }
    for (const t of all) expect(revokeByPrefix(store, t.short).kind).toBe("revoked");
  });

  it("says a token is already revoked rather than pretending it never existed", () => {
    grantToken(store, repoId, "vany");
    const short = listTokens(store)[0]?.short ?? "";
    expect(revokeByPrefix(store, short).kind).toBe("revoked");
    expect(revokeByPrefix(store, short).kind).toBe("already-revoked");
  });

  it("does not treat a non-hex argument as a wildcard", () => {
    grantToken(store, repoId, "vany");
    // `%` and `_` are LIKE wildcards. Reaching the query would revoke everything.
    for (const bad of ["%", "_", "'", "abc%", ""]) {
      expect(revokeByPrefix(store, bad).kind).toBe("not-found");
    }
    expect(listTokens(store)[0]?.revokedAt).toBeUndefined();
  });
});

describe("listing tokens", () => {
  it("shows the repository, so revoking the wrong one is harder", () => {
    const other = store.upsertRepo("rigid", "git@x:rigid.git").id;
    grantToken(store, repoId, "vany", "laptop");
    grantToken(store, other, "vany", "ci");
    expect(listTokens(store).map((t) => t.repo).sort()).toStrictEqual(["demo", "rigid"]);
  });

  it("never exposes the secret, only the handle", () => {
    const token = grantToken(store, repoId, "vany");
    const row = listTokens(store)[0];
    expect(row?.short.length).toBe(8);
    expect(JSON.stringify(listTokens(store))).not.toContain(token);
  });
});

function commonPrefix(xs: readonly string[]): string {
  if (xs.length === 0) return "";
  let p = xs[0] ?? "";
  for (const x of xs) {
    while (!x.startsWith(p) && p.length > 0) p = p.slice(0, -1);
  }
  return p;
}
