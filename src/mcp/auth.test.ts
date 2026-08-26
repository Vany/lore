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

  it("refuses an empty prefix rather than matching everything", () => {
    grantToken(store, repoId, "a");
    const r = revokeByPrefix(store, listTokens(store)[0]?.short.slice(0, 0) + "");
    expect(r.kind).toBe("not-found");
  });

  // git's rule (spec/review-ladder.md §3.1.2), and it matters more here: picking a
  // winner locks out a teammate AND leaves the leaked token live.
  //
  // lore-ok[5cc6d24d]: found real by lore's own review — this used to rely on TWO
  // real, CSPRNG-random tokens happening to share a 4+ char hash prefix by chance
  // (`if (common.length >= 4)`), which is a ~1-in-65536 event per pair. The property
  // the test's own name and comment claim to check — "refuses an ambiguous prefix
  // rather than choosing" — almost never actually ran; a regression that made
  // `revokeByPrefix` pick a winner on ambiguity (revoking one match and leaving the
  // other, leaked token live) would have passed this suite green. `store.insertToken`
  // writes two CHOSEN hashes sharing a prefix directly, so the ambiguity branch is
  // reached every run, not by luck.
  it("refuses an ambiguous prefix rather than choosing", () => {
    store.insertToken(`aaaa${"1".repeat(60)}`, "a", repoId, undefined);
    store.insertToken(`aaaa${"2".repeat(60)}`, "b", repoId, undefined);

    const ambiguous = revokeByPrefix(store, "aaaa");
    expect(ambiguous.kind, "a prefix both hashes share must not pick a winner").toBe("ambiguous");
    // Neither was revoked by the ambiguous attempt — both still resolve individually.
    expect(revokeByPrefix(store, `aaaa${"1".repeat(60)}`).kind).toBe("revoked");
    expect(revokeByPrefix(store, `aaaa${"2".repeat(60)}`).kind).toBe("revoked");
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
