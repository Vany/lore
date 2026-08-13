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
import { worktreeFor, repoPaths } from "../git/repo.ts";
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
    g(paths.bare, "fetch", "-q", "origin", "+refs/heads/*:refs/heads/*");
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
});
