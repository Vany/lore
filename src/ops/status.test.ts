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
import { initialState } from "../core/ladder.ts";
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

// D-68 ranks inherited pattern matches below the branch's own for the CLIENT, on the
// reasoning that a reader triaging by severity should not answer test-fixture noise
// first. The operator view inherited raw severity and said `3 finding(s), 2 high` for
// a review whose only branch-caused finding was the `low` — the two highs were the
// semgrep CWE-319 hit on fixtures the branch never touches, justified here repeatedly.
// An alarm that fires on the same known noise every day is one that gets ignored.
describe("uncollected findings distinguish the branch's own from inherited ones", () => {
  const withFindings = (branch: string, fs: { severity: string; preexisting: number }[]) => {
    const repoId = store.upsertRepo("demo", `git@example.com:o/${branch}.git`).id;
    const id = `rev_${branch.replace(/\W/g, "")}`;
    store.createReview({
      id, repoId, principal: "p", branch, intoRef: "main",
      ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
    });
    fs.forEach((f, i) => {
      store.recordFinding(id, {
        fingerprint: `${branch}${i}`.padEnd(12, "0"), file: "a.ts", line: 1, symbol: "s",
        severity: f.severity as "high" | "medium" | "low", claim: `c${i}`, evidence: "e",
        failureScenario: "s", origin: "t0", round: 1, firstSeen: new Date().toISOString(),
        preexisting: f.preexisting === 1,
      });
    });
  };

  it("does not count an inherited high as the branch's own", () => {
    withFindings("feat/x", [
      { severity: "high", preexisting: 1 },
      { severity: "high", preexisting: 1 },
      { severity: "low", preexisting: 0 },
    ]);
    const out = render();
    expect(out).toContain("2 high preexisting");
    // The alarming form must NOT appear: this branch caused no high finding.
    expect(out).not.toMatch(/3 finding\(s\), 2 high(?! preexisting)/);
  });

  it("still shouts when the branch really did cause a high finding", () => {
    withFindings("feat/y", [
      { severity: "high", preexisting: 0 },
      { severity: "high", preexisting: 1 },
    ]);
    const out = render();
    expect(out).toContain("1 high");
    expect(out).toContain("1 high preexisting");
  });
});

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

// Eighteen findings sat unread across four reviews on 2026-08-05, fourteen of them
// `high`. The review reached findings_ready, nothing polled it again, and nothing
// said so — `delivered_at` had recorded it per finding the whole time.
describe("findings nobody has collected", () => {
  const withFinding = (severity: "high" | "low", fingerprint: string) => {
    store.createReview({
      id: "revU", repoId: store.upsertRepo("r", "git@x:r.git").id, principal: "alice",
      branch: "feat/unread", intoRef: "main", ticket: "t", type: "code-arch",
      state: "findings_ready", ladder: initialState(),
    });
    store.recordFinding("revU", {
      fingerprint, file: "a.ts", line: 1, symbol: undefined, severity,
      claim: "something is wrong", evidence: "e", failureScenario: "f",
      cwe: undefined, origin: "t1", round: 1, firstSeen: new Date().toISOString(),
    });
  };

  it("names them, counts the high ones, and says how long they have waited", () => {
    withFinding("high", "f".repeat(64));
    const out = render();
    expect(out).toContain("waiting to be collected");
    expect(out).toMatch(/1 finding\(s\), 1 high\s+feat\/unread/);
    expect(out).toContain("unread since");
    // The consequence, not just the count — this is why it is worth a line.
    expect(out).toContain("a review that did not run, later");
  });

  it("says nothing when everything has been collected", () => {
    withFinding("low", "e".repeat(64));
    store.markDelivered("revU", ["e".repeat(64)]);
    expect(render()).not.toContain("waiting to be collected");
  });
});
