/**
 * Relocating is a separate operation because the obvious route silently splits a
 * repository's memory.
 *
 * `make new` with a moved repository's new url calls `upsertRepo`, which matches on
 * `git_url` — so it creates a SECOND row. Reviews, findings, verdicts, usage and
 * knowledge stay on the old one while everything new attaches to the new one. That
 * happened here with a single repository registered under both https and ssh, and
 * undoing it cost a transaction across nine tables.
 *
 * Every refusal below is the feature. Each prevents either a split, or the worse
 * outcome: one repository's accumulated memory attached to another's code (D-14,
 * D-19), which nothing downstream could notice.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { RelocateError, relocate } from "./relocate.ts";

let store: Store;
let repoId: string;

const OLD = "git@github.com:chainnodesorg/rigid-monorepo.git";
const NEW = "git@github.com:RigidFi/rigid-monorepo.git";

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("rigid-monorepo", OLD).id;
});
afterEach(() => store.close());

describe("a repository that moved", () => {
  it("keeps its id, so nothing attached to it is orphaned", () => {
    const r = relocate(store, "rigid-monorepo", NEW);
    expect(r.repoId).toBe(repoId);
    expect(r.from).toBe(OLD);
    expect(r.to).toBe(NEW);
    expect(store.upsertRepo("x", NEW).id).toBe(repoId);
  });

  // The whole point: everything follows the id, and the id did not move.
  it("carries its history, knowledge and tokens across", () => {
    store.createReview({
      id: "rev1", repoId, principal: "vany", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "passed", ladder: initialState(),
    });
    store.addKnowledge({
      repoId, kind: "rule", source: "taught",
      statement: "holds are idempotent on the network transaction id", why: "ADR-0026",
      path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: undefined,
    });

    relocate(store, "rigid-monorepo", NEW);

    const moved = store.upsertRepo("rigid-monorepo", NEW).id;
    expect(moved).toBe(repoId);
    expect(store.knowledgeFor(moved).length).toBe(1);
    expect(store.getReview("rev1", "vany")?.state).toBe("passed");
  });

  it.each([[OLD], ["rigid-monorepo"]])("can be named by %s", (how) => {
    expect(relocate(store, how, NEW).to).toBe(NEW);
  });
});

describe("what it refuses", () => {
  it("an unknown repository, listing what there is", () => {
    expect(() => relocate(store, "not-a-repo", NEW)).toThrow(RelocateError);
    expect(() => relocate(store, "not-a-repo", NEW)).toThrow(/rigid-monorepo/);
  });

  // Relocating onto a url another row already holds recreates the exact split this
  // operation exists to prevent.
  it("a url already registered to a different repository", () => {
    store.upsertRepo("other", NEW);
    expect(() => relocate(store, "rigid-monorepo", NEW)).toThrow(/already registered as other/);
    // And the original is untouched — a refusal must not half-apply.
    expect(store.upsertRepo("rigid-monorepo", OLD).id).toBe(repoId);
  });

  it("a move to where it already is", () => {
    expect(() => relocate(store, "rigid-monorepo", OLD)).toThrow(/already at/);
  });

  // Picking one would move the wrong repository's entire history, and the loser
  // would look untouched.
  it("an ambiguous name rather than choosing", () => {
    store.upsertRepo("rigid-monorepo", "https://github.com/other/rigid-monorepo.git");
    expect(() => relocate(store, "rigid-monorepo", NEW)).toThrow(/matches 2 repositories/);
  });
});
