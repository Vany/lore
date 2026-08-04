/**
 * What `ensureBare` guarantees now that it neither clones nor fetches (D-63).
 *
 * `make mirror` populates `data/repos/<id>/bare.git` on the HOST, where the
 * operator's agent and credentials are. lore holds none, sees nothing outside its
 * own data directory, and only checks what it was given.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBare, worktreeFor } from "./repo.ts";

let root: string;

/** A repository with one commit, standing in for something real. */
const makeRepo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  g("add", "-A");
  g("commit", "-qm", "x");
  return g;
};

/** What `make mirror` leaves behind. */
const mirror = (src: string, bare: string) => {
  mkdirSync(join(bare, ".."), { recursive: true });
  execFileSync("git", ["clone", "--bare", src, bare], { stdio: "ignore" });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-bare-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("git cannot climb out of the directory it was aimed at (D-61)", () => {
  // The original defect: an empty bare dir nested inside another repository made
  // `rev-parse` report the ENCLOSING checkout, so lore treated it as already cloned
  // and every later command operated on the operator's own repository.
  it("refuses an empty directory nested in another repo, rather than adopting it", async () => {
    const outer = join(root, "outer");
    const g = makeRepo(outer);
    g("tag", "precious-tag");

    // lore's data directory living inside a checkout: the normal layout.
    const paths = { bare: join(outer, "data/repos/r1/bare.git"), worktrees: join(outer, "data/repos/r1/wt") };
    mkdirSync(paths.bare, { recursive: true });

    await expect(ensureBare(paths, "git@example.com:o/r.git")).rejects.toThrow(/no clone of/);
    // And the enclosing repository is untouched.
    expect(execFileSync("git", ["-C", outer, "tag"], { encoding: "utf8" })).toContain("precious-tag");
  });
});

describe("the clone has to be there, and recent (D-63)", () => {
  it("refuses when nothing has been mirrored yet, and names the fix", async () => {
    const paths = { bare: join(root, "repos/r2/bare.git"), worktrees: join(root, "repos/r2/wt") };
    await expect(ensureBare(paths, "git@example.com:o/r.git")).rejects.toThrow(/make mirror/);
    // Waiving the freshness requirement must not waive EXISTENCE. A later round with
    // no clone at all is a broken deployment, not a pinned review.
    await expect(ensureBare(paths, "git@example.com:o/r.git", false)).rejects.toThrow(/make mirror/);
  });

  it("accepts a clone with no remote, because it cannot be behind one", async () => {
    const src = join(root, "src1");
    makeRepo(src);
    const paths = { bare: join(root, "repos/r3/bare.git"), worktrees: join(root, "repos/r3/wt") };
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "remote", "remove", "origin"], { stdio: "ignore" });

    await expect(ensureBare(paths, src)).resolves.toBeUndefined();
  });

  // The gap between the two tests above, and the one `make mirror` can actually
  // produce: its clone branch is `git clone --bare && … && git fetch`, so a clone
  // that succeeds with a fetch that fails leaves a remote configured and no
  // FETCH_HEAD. That used to return `undefined` from the freshness read — the same
  // answer as "no remote" — and was accepted.
  //
  // It is the worst version of the failure, not a mild one: `refs/remotes/origin/*`
  // does not exist yet either, so `addWorktree` falls back to the LOCAL branch and
  // reviews whatever commit the clone happened to be made at.
  //
  // Note that `mirror()` above produces exactly this state, and the two tests
  // around it write FETCH_HEAD by hand — so the helper was manufacturing the
  // dangerous case and every test was stepping over it. Raised by t2 against the
  // commit that introduced the check.
  it("refuses a clone whose fetch never landed, even though a remote is configured", async () => {
    const src = join(root, "src-nofetch");
    makeRepo(src);
    const paths = { bare: join(root, "repos/r6/bare.git"), worktrees: join(root, "repos/r6/wt") };
    mirror(src, paths.bare); // clone only — no fetch, so no FETCH_HEAD

    // The precondition that makes this dangerous rather than merely unfetched.
    expect(existsSync(join(paths.bare, "FETCH_HEAD"))).toBe(false);
    expect(
      execFileSync("git", ["-C", paths.bare, "config", "--get", "remote.origin.url"]).toString().trim(),
    ).toBe(src);

    await expect(ensureBare(paths, src)).rejects.toThrow(/never been fetched/);
    await expect(ensureBare(paths, src)).rejects.toThrow(/make mirror/);
  });

  // Raised by t3 at HIGH, against the fix for the previous round's finding.
  //
  // The worker decided "this review is already pinned" from `existsSync` on the
  // worktree directory — but `review_submit` also cuts a worktree, through a path
  // that called `addWorktree` with no freshness check at all. So: start a review
  // against a stale mirror, submit before the queued job runs, and the submit cuts
  // the base; the worker then sees the directory, concludes it is a later round, and
  // skips the check. A review, and an attestation, over a base nobody fetched.
  //
  // The rule that replaces the heuristic: whoever CUTS the base asks the question,
  // and there is one function that does both.
  it("requires freshness whenever a base is cut, not merely when the worker cuts it", async () => {
    const src = join(root, "src-submit");
    makeRepo(src);
    const paths = { bare: join(root, "repos/r7/bare.git"), worktrees: join(root, "repos/r7/wt") };
    mirror(src, paths.bare);
    const fetchHead = join(paths.bare, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    const stale = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(fetchHead, stale, stale);

    // The submit path is the one that used to skip this entirely.
    await expect(worktreeFor(paths, "rev_x", "main", src)).rejects.toThrow(/last fetched/);
    // ...and it must not have left a worktree behind for the worker to mistake for
    // a pinned one, which is the whole mechanism of the finding.
    expect(existsSync(join(paths.worktrees, "rev_x"))).toBe(false);

    // Once the mirror is current, the base may be cut — and the SECOND call reuses
    // it without re-asking, which is what lets a long review outlive the window.
    const now = new Date();
    utimesSync(fetchHead, now, now);
    const wt = await worktreeFor(paths, "rev_x", "main", src);
    expect(existsSync(wt)).toBe(true);

    utimesSync(fetchHead, stale, stale);
    await expect(worktreeFor(paths, "rev_x", "main", src)).resolves.toBe(wt);
  });

  it("accepts a clone fetched just now", async () => {
    const src = join(root, "src2");
    makeRepo(src);
    const paths = { bare: join(root, "repos/r4/bare.git"), worktrees: join(root, "repos/r4/wt") };
    mirror(src, paths.bare);
    writeFileSync(join(paths.bare, "FETCH_HEAD"), "");

    await expect(ensureBare(paths, src)).resolves.toBeUndefined();
  });

  // The failure on-demand refresh actually has: a client that forgot. Reviewing
  // anyway describes a tree that is not the one being merged — INV-2, with an
  // attestation over it.
  it("refuses a stale clone, and says how to fix it", async () => {
    const src = join(root, "src3");
    makeRepo(src);
    const paths = { bare: join(root, "repos/r5/bare.git"), worktrees: join(root, "repos/r5/wt") };
    mirror(src, paths.bare);
    const fetchHead = join(paths.bare, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(fetchHead, old, old);

    await expect(ensureBare(paths, src)).rejects.toThrow(/last fetched \d+ minutes ago/);

    // ...but only while the base is being chosen. A review already holding a
    // worktree is pinned to it (D-40) and never reads the mirror again, so the
    // same staleness is not disqualifying on a later round.
    //
    // This is not hypothetical tidiness: reviewing the commit that introduced the
    // check, round 3 was refused at "35 minutes" after t2 alone spent 16 — three
    // rounds and eight answered findings destroyed by a guard with nothing left to
    // guard. A t1→t2 climb alone exceeds MAX_MIRROR_AGE_MS, so between D-63 and this
    // fix no review could reach t3 at all.
    await expect(ensureBare(paths, src, false)).resolves.toBeUndefined();
    await expect(ensureBare(paths, src)).rejects.toThrow(/make mirror/);
  });
});
