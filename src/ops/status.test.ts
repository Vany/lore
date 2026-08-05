/**
 * The mirror-staleness warning, which is the only thing that notices a dead
 * refresher.
 *
 * lore does not fetch (D-65). A host timer does, outside the container, as the
 * operator — the right place, with one weakness: nothing in lore knows whether it is
 * still alive. A stopped LaunchAgent looks exactly like a healthy one right up until
 * a review is refused, and on 2026-08-05 a mirror nobody refreshed failed more
 * reviews than every model and transport fault combined.
 *
 * So this is the safety net for the whole arrangement, and it gets a test. It had
 * none until the module was made importable: `status.ts` opened a database and wrote
 * to stdout at import time, so nothing could load it.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_MIRROR_AGE_MS } from "../git/repo.ts";
import { Store } from "../store/store.ts";
import { renderStatus } from "./status.ts";

let dir: string;
let store: Store;

const mirrorAged = (repoId: string, ms: number) => {
  const bare = join(dir, "repos", repoId, "bare.git");
  mkdirSync(bare, { recursive: true });
  const head = join(bare, "FETCH_HEAD");
  writeFileSync(head, "");
  const at = new Date(Date.now() - ms);
  utimesSync(head, at, at);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-status-"));
  store = new Store(join(dir, "lore.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const render = () => {
  const db = new DatabaseSync(join(dir, "lore.db"), { readOnly: true });
  try {
    return renderStatus(db, undefined, dir);
  } finally {
    db.close();
  }
};

describe("what the operator is told about the mirrors", () => {
  it("marks a mirror past the review threshold, not merely old-ish", () => {
    const fresh = store.upsertRepo("fresh-repo", "git@example.com:o/a.git").id;
    const stale = store.upsertRepo("stale-repo", "git@example.com:o/b.git").id;
    mirrorAged(fresh, MAX_MIRROR_AGE_MS / 2);
    mirrorAged(stale, MAX_MIRROR_AGE_MS * 3);

    const out = render();

    // The threshold is MAX_MIRROR_AGE_MS itself, not a second number beside it: a
    // warning that fires at a different age than the refusal is a warning that
    // eventually disagrees with the thing it is warning about.
    expect(out).toMatch(/✓ \d+m ago\s+fresh-repo/);
    expect(out).toMatch(/✗ \d+m ago\s+stale-repo/);
    // Said in terms of the consequence, because "stale" alone is not actionable.
    expect(out).toContain("a review started now would be refused");
  });

  // Never fetched is WORSE than stale, not milder: refs/remotes/origin/* does not
  // exist, so a base cut from it takes the frozen clone-time commit.
  it("distinguishes never fetched from stale", () => {
    store.upsertRepo("never-repo", "git@example.com:o/c.git");
    expect(render()).toMatch(/✗ never fetched\s+never-repo/);
  });

  // "Nothing is happening" and "nothing CAN happen" look identical otherwise, and
  // the idle path is exactly when a dead refresher goes unnoticed the longest.
  it("reports mirrors even when there is nothing to review", () => {
    const id = store.upsertRepo("idle-repo", "git@example.com:o/d.git").id;
    mirrorAged(id, MAX_MIRROR_AGE_MS * 4);

    const out = render();
    expect(out).toContain("idle");
    expect(out).toMatch(/✗ \d+m ago\s+idle-repo/);
  });

  it("says nothing about mirrors when no repository is registered", () => {
    expect(render()).not.toContain("mirrors");
  });
});
