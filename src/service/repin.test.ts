/**
 * Continue the same review on origin's new tip (D-108) — against a real bare and a real
 * push, because the whole point is what the recut worktree actually contains.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { worktreeFor, repoPaths, treeHash } from "../git/repo.ts";
import { Store } from "../store/store.ts";
import { repinReview } from "./repin.ts";

let root: string;
let store: Store;
let repoId: string;

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-repin-"));
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  g(src, "init", "-q", "-b", "main");
  g(src, "config", "user.email", "t@e.com");
  g(src, "config", "user.name", "t");
  writeFileSync(join(src, "a.txt"), "one\n");
  g(src, "add", "-A");
  g(src, "commit", "-qm", "one");

  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", src).id;
  const bare = join(root, "repos", repoId, "bare.git");
  mkdirSync(join(bare, ".."), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", src, bare], { stdio: "pipe" });
  writeFileSync(join(bare, "FETCH_HEAD"), "");

  store.createReview({
    id: "rev1", repoId, principal: "p", branch: "main", intoRef: "main",
    ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
  });
  // NO heartbeat on purpose: no test runs the host's sync loop, and repin must survive
  // exactly that — the sync request is refused at once ("no sync process"), `synced`
  // comes back false, and the recut proceeds on the mirror as it stands. A heartbeat
  // with no consumer would make repin wait out its whole 45s bound instead.
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("repinReview", () => {
  it("recuts the same review's worktree at the mirror's current tip", async () => {
    const reposRoot = join(root, "repos");
    const paths = repoPaths(reposRoot, repoId);
    const src = join(root, "src");

    // The review's first pin, at commit one.
    const first = await worktreeFor(paths, "rev1", "main", src);
    expect(readFileSync(join(first, "a.txt"), "utf8")).toBe("one\n");

    // The author pushes commit two; the mirror learns of it (the test plays the host).
    writeFileSync(join(src, "a.txt"), "two\n");
    g(src, "add", "-A");
    g(src, "commit", "-qm", "two");
    // THE PRODUCTION REFSPEC, and the difference is the point: `mirror-refresh.sh`
    // configures `+refs/heads/*:refs/remotes/origin/*`, so a real mirror advances only
    // `refs/remotes/origin/*` and its local `refs/heads/*` stay frozen at clone time.
    // This fixture used to fetch into `refs/heads/*`, keeping local heads current in a
    // way no deployed mirror ever is — which is exactly why it could not see a guard
    // reading the wrong namespace.
    g(paths.bare, "fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
    writeFileSync(join(paths.bare, "FETCH_HEAD"), "");

    const out = await repinReview(store, reposRoot, reposRoot, "rev1");

    expect(out.worktree, "the same review id keeps naming the folder").toBe(first);
    expect(readFileSync(join(out.worktree, "a.txt"), "utf8"), "the pin advanced to the push").toBe("two\n");
    expect(out.treeHash).toMatch(/^[0-9a-f]{40}$/);
    // No test consumed the sync request, and that is a fact the caller is told, not a
    // failure: the recut ran on the mirror as it stood.
    expect(out.synced).toBe(false);
    expect(existsSync(first)).toBe(true);
  });

  it("refuses a review it cannot place", async () => {
    await expect(repinReview(store, join(root, "repos"), join(root, "repos"), "rev_ghost")).rejects.toThrow(
      /no repository on record/,
    );
  });

  // ORIGIN HAS NOTHING NEWER — so nothing may be destroyed. The recut used to run
  // unconditionally and the caller compared afterwards, which meant the ordinary answer
  // to a mistaken pull_fresh ("push your commits, then call again") was handed back over
  // a worktree that had just been thrown away and cut fresh from origin — taking every
  // fix the client had submitted, since a submit is applied there and never committed.
  it("leaves the worktree — and the fixes in it — untouched when origin has not moved", async () => {
    const reposRoot = join(root, "repos");
    const paths = repoPaths(reposRoot, repoId);
    const cut = await worktreeFor(paths, "rev1", "main", join(root, "src"));
    const atOrigin = await treeHash(cut);
    // What review_submit leaves behind: applied to the worktree, committed nowhere.
    // Staged, matching `applyPatch`'s real `git apply --index` (worktree and index
    // move together) — not a bare write, which `worktreeFor`'s own intactness check
    // (repo.ts, `worktreeIsIntact`) reads as an interrupted checkout rather than a
    // submitted fix, since a bare write is exactly the shape THAT leaves behind.
    writeFileSync(join(cut, "a.txt"), "the client's fix\n");
    g(cut, "add", "-A");

    const out = await repinReview(store, reposRoot, reposRoot, "rev1", atOrigin);

    expect(out.treeHash, "reports origin's tree, so the caller answers 'unchanged'").toBe(atOrigin);
    expect(readFileSync(join(cut, "a.txt"), "utf8"), "the fix survives").toBe("the client's fix\n");
  });

  // The caller's upfront `hasPendingRound` check and the sync it then awaits are two
  // different moments, and a submit landing in between used to sail through unchecked —
  // repin went on to destroy the worktree that submit had just applied its diff to.
  // This pins the re-check INSIDE repinReview, right before the destructive step,
  // rather than relying on timing a real race.
  it("refuses to destroy the worktree if a round became pending during the sync", async () => {
    const reposRoot = join(root, "repos");
    const paths = repoPaths(reposRoot, repoId);
    const cut = await worktreeFor(paths, "rev1", "main", join(root, "src"));
    // The diff a `review_submit` landing mid-sync would have applied — stands in for
    // the write repin must not clobber.
    writeFileSync(join(cut, "a.txt"), "submitted mid-sync\n");
    // Simulates exactly what that submit leaves behind: a job the caller's own upfront
    // `hasPendingRound` check could not have seen yet, since it ran BEFORE the sync.
    store.enqueue("rev1", "fast");

    await expect(repinReview(store, reposRoot, reposRoot, "rev1")).rejects.toThrow(/a round started for rev1/);
    // The worktree from before the refused repin is untouched — this is the whole point
    // of catching it before `removeWorktree`, not after.
    expect(existsSync(cut)).toBe(true);
    expect(readFileSync(join(cut, "a.txt"), "utf8")).toBe("submitted mid-sync\n");
  });
});
