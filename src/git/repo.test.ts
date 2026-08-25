/**
 * The git boundary, where a caller's string meets a command line.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch, gitlinks, revParse, treeHash, type RepoPaths, worktreeFor } from "./repo.ts";

/**
 * A CLIENT'S STRING MUST NOT REACH GIT'S ARGV AS ITSELF.
 *
 * Git reads any argument beginning with `-` as an OPTION, not a ref — so an unvalidated
 * commit handed to `git diff <tree> <commit>` is an option-injection surface, and this
 * service hands that slot to anyone holding a token. `--output=` alone turns a read into
 * an arbitrary file write, aimed wherever the caller likes, against a service whose
 * database IS the product. It also breaks D-61 outright: git must never be aimed outside
 * the directory it was given.
 *
 * `revParse` is the one gate. Everything downstream sees a pure-hex sha (40 or 64
 * characters, whichever git's own object format produced — see the SHA-256 block
 * below), which cannot be an option however the caller wrote it.
 */
describe("resolving a caller's commit before git sees it", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-revparse-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "one");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves a real commit to its sha", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    expect(await revParse(dir, "HEAD")).toBe(head);
    expect(await revParse(dir, "main")).toBe(head);
  });

  // THE FINDING, AS A TEST. Every one of these is a git option, and each was accepted
  // verbatim into argv before this gate existed.
  it.each([["--output=/tmp/lore-pwned"], ["--no-index"], ["-z"], ["--textconv"]])(
    "refuses %j rather than handing it to git as a flag",
    async (hostile) => {
      expect(await revParse(dir, hostile)).toBeUndefined();
    },
  );

  it("refuses a ref that simply does not exist", async () => {
    expect(await revParse(dir, "no-such-branch")).toBeUndefined();
  });

  // A TREE IS NOT A COMMIT. `^{commit}` is what refuses it, and the submit path needs a
  // commit specifically — a tree would resolve and then mean something different.
  it("refuses a tree object", async () => {
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
    expect(await revParse(dir, tree)).toBeUndefined();
  });
});

// Found by lore's own review of src/git: `revParse` and `gitlinks` both matched
// exactly 40 hex characters, SHA-1's length only. git also has a SHA-256 object
// format (`git init --object-format=sha256`), whose commit ids are 64 hex
// characters — a real, resolvable commit that the old regex refused outright,
// which for review_submit's commit form meant telling a client holding a genuine
// sha that lore "cannot see" it. Real git, not a fixture: `git --version` on this
// machine supports `--object-format=sha256` directly.
describe("a repository using SHA-256 object ids, not SHA-1", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-sha256-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    };
    git("init", "-q", "--object-format=sha256", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "one");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves a real 64-character commit id, not just 40", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    expect(head).toHaveLength(64);
    expect(await revParse(dir, "HEAD")).toBe(head);
  });

  it("still refuses a hostile flag under the 64-character gate too", async () => {
    expect(await revParse(dir, "--output=/tmp/lore-pwned")).toBeUndefined();
  });

  it("gitlinks names a 64-character submodule commit, not an empty list", async () => {
    const innerDir = mkdtempSync(join(tmpdir(), "lore-sha256-inner-"));
    const gInner = (...args: string[]): void => {
      execFileSync("git", args, { cwd: innerDir, stdio: ["ignore", "pipe", "pipe"] });
    };
    gInner("init", "-q", "--object-format=sha256", "-b", "main");
    gInner("config", "user.email", "t@example.com");
    gInner("config", "user.name", "t");
    writeFileSync(join(innerDir, "f.txt"), "a\n");
    gInner("add", "-A");
    gInner("commit", "-qm", "inner");
    const innerHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: innerDir, encoding: "utf8" }).trim();

    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", innerDir, "inner"], {
      cwd: dir,
    });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "add submodule"], { cwd: dir });

    expect(await gitlinks(dir)).toStrictEqual([{ commit: innerHead, path: "inner" }]);
    rmSync(innerDir, { recursive: true, force: true });
  });
});

/**
 * gitlinks() and applyPatch()'s `--index`, together — found by lore's own review of
 * src/git. Neither had a test before this.
 *
 * `applyPatch` (no `--index`) could not apply a gitlink-only hunk at all: a mode-160000
 * entry has no working-tree bytes to rewrite, so the hunk silently matched nothing,
 * `treeHash`'s later `git add -A` found nothing new to stage either, and the whole
 * submission failed D-40's tree-hash check with advice — "resend the whole diff" —
 * that could never have helped, since resending hits the identical gap. `--index`
 * writes a gitlink straight into the index, which is where one lives.
 *
 * That fix is also what makes `gitlinks()`'s own bug reachable rather than moot:
 * before it, HEAD and the index could never disagree about a gitlink (a bump could not
 * apply, so nothing to disagree about); after it, `ls-tree -r HEAD` — this function's
 * original source — stays on the ORIGINAL commit while the index correctly advances,
 * so OSV queried a commit no round was actually reviewing.
 */
describe("gitlinks reads the worktree a review is reviewing, not its starting HEAD", () => {
  let outerDir: string;
  let innerDir: string;
  let commitA: string;
  let commitB: string;

  beforeEach(() => {
    outerDir = mkdtempSync(join(tmpdir(), "lore-gitlinks-outer-"));
    innerDir = mkdtempSync(join(tmpdir(), "lore-gitlinks-inner-"));
    const gInner = (...args: string[]): string =>
      execFileSync("git", args, { cwd: innerDir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    gInner("init", "-q", "-b", "main");
    gInner("config", "user.email", "t@example.com");
    gInner("config", "user.name", "t");
    writeFileSync(join(innerDir, "f.txt"), "a\n");
    gInner("add", "-A");
    gInner("commit", "-qm", "commit A");
    commitA = gInner("rev-parse", "HEAD");
    writeFileSync(join(innerDir, "f.txt"), "a\nb\n");
    gInner("add", "-A");
    gInner("commit", "-qm", "commit B");
    commitB = gInner("rev-parse", "HEAD");

    const gOuter = (...args: string[]): string =>
      execFileSync("git", args, { cwd: outerDir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    gOuter("init", "-q", "-b", "main");
    gOuter("config", "user.email", "t@example.com");
    gOuter("config", "user.name", "t");
    gOuter("-c", "protocol.file.allow=always", "submodule", "add", "-q", innerDir, "inner");
    execFileSync("git", ["checkout", "-q", commitA], { cwd: join(outerDir, "inner"), stdio: "ignore" });
    gOuter("add", "-A");
    gOuter("commit", "-qm", "add submodule at A");
  });

  afterEach(() => {
    rmSync(outerDir, { recursive: true, force: true });
    rmSync(innerDir, { recursive: true, force: true });
  });

  it("names the pinned commit before any submit", async () => {
    expect(await gitlinks(outerDir)).toStrictEqual([{ commit: commitA, path: "inner" }]);
  });

  it("names the BUMPED commit after a submitted gitlink diff, not HEAD's original one", async () => {
    execFileSync("git", ["checkout", "-q", commitB], { cwd: join(outerDir, "inner"), stdio: "ignore" });
    const patch = execFileSync("git", ["diff", "--submodule=short"], { cwd: outerDir, encoding: "utf8" });
    execFileSync("git", ["checkout", "-q", commitA], { cwd: join(outerDir, "inner"), stdio: "ignore" });

    await applyPatch(outerDir, patch);

    expect(await gitlinks(outerDir)).toStrictEqual([{ commit: commitB, path: "inner" }]);
    const headTree = execFileSync("git", ["ls-tree", "-r", "HEAD"], { cwd: outerDir, encoding: "utf8" });
    expect(headTree, "HEAD itself genuinely did not move — gitlinks reads the index, not HEAD").toContain(commitA);
  });

  // Found by lore's own review of src/git (ad43ea6d): `treeHash`'s own `git add -A`
  // re-stages every submodule from what the submodule's WORKING DIRECTORY has checked
  // out — which the review flow never moves — silently overwriting the bump the line
  // above this just confirmed `applyPatch`'s `--index` fix had staged. Without the
  // snapshot-and-restore in `treeHash`, this test's `gitlinks` call after `treeHash`
  // fails, back to commitA, even though the one before it (same worktree, no calls in
  // between except `treeHash`) passes.
  it("treeHash's own add -A does not revert the bump applyPatch just staged", async () => {
    execFileSync("git", ["checkout", "-q", commitB], { cwd: join(outerDir, "inner"), stdio: "ignore" });
    const patch = execFileSync("git", ["diff", "--submodule=short"], { cwd: outerDir, encoding: "utf8" });
    execFileSync("git", ["checkout", "-q", commitA], { cwd: join(outerDir, "inner"), stdio: "ignore" });

    await applyPatch(outerDir, patch);
    const tree = await treeHash(outerDir);

    expect(
      await gitlinks(outerDir),
      "gitlinks after treeHash must still see the bump — treeHash must not revert it",
    ).toStrictEqual([{ commit: commitB, path: "inner" }]);
    const treeEntries = execFileSync("git", ["ls-tree", tree], { cwd: outerDir, encoding: "utf8" });
    expect(treeEntries, "the tree object treeHash wrote must itself name the bumped commit").toContain(commitB);
  });

  // Found by lore's own review (d6f934ac), on top of the fix just above: restoring
  // ONLY the index entry makes THIS submit verify, but a gitlink's worktree side for
  // git's own diffing is the submodule's ACTUAL checkout, not the index — so the next
  // round's `computeDiff` (a plain `git diff <mergeBase>`, reproduced here the same
  // way) would still read the submodule's old, unmoved HEAD and render zero bytes of
  // patch for a file `--name-only` still lists as changed. Without checking the
  // submodule out to match, this test's diff below comes back empty even though
  // `gitlinks`/`write-tree` already report the bump correctly.
  it("treeHash also checks the submodule out, so the NEXT round's diff can see the bump", async () => {
    const mergeBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: outerDir, encoding: "utf8" }).trim();

    execFileSync("git", ["checkout", "-q", commitB], { cwd: join(outerDir, "inner"), stdio: "ignore" });
    const patch = execFileSync("git", ["diff", "--submodule=short"], { cwd: outerDir, encoding: "utf8" });
    execFileSync("git", ["checkout", "-q", commitA], { cwd: join(outerDir, "inner"), stdio: "ignore" });

    await applyPatch(outerDir, patch);
    await treeHash(outerDir);

    const innerHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(outerDir, "inner"), encoding: "utf8" }).trim();
    expect(innerHead, "the submodule's own checkout must follow the restored index entry, not stay at the old commit").toBe(
      commitB,
    );

    const nextRoundDiff = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--submodule=diff", "--no-color", mergeBase],
      { cwd: outerDir, encoding: "utf8" },
    );
    expect(nextRoundDiff.length, "the bump must not render as an empty, invisible patch next round").toBeGreaterThan(0);
    expect(nextRoundDiff).toContain(`Submodule inner ${commitA.slice(0, 7)}`);
  });
});

/**
 * `worktreeFor`'s existsSync-only recovery — found wrong by lore's own review,
 * reproduced directly against real git: a `git worktree add` SIGTERMed mid-checkout
 * by its own 300s timeout leaves a populated, `.git`-bearing directory that
 * `existsSync` cannot tell apart from a finished one, and `git worktree list` never
 * names. These construct the states a kill (and a genuinely concurrent, still-running
 * peer) leave behind directly, rather than waiting out a real 300-second timeout, and
 * check `worktreeFor`'s reaction to each.
 */
describe("worktreeFor recovers from a worktree that never finished, without touching one that is still running", () => {
  let root: string;
  let paths: RepoPaths;

  const g = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lore-worktreefor-"));
    const srcDir = join(root, "src");
    mkdirSync(srcDir);
    g(srcDir, "init", "-q", "-b", "main");
    g(srcDir, "config", "user.email", "t@example.com");
    g(srcDir, "config", "user.name", "t");
    writeFileSync(join(srcDir, "a.txt"), "one\n");
    g(srcDir, "add", "-A");
    g(srcDir, "commit", "-qm", "one");

    paths = { bare: join(root, "bare.git"), worktrees: join(root, "wt") };
    execFileSync("git", ["clone", "-q", "--bare", srcDir, paths.bare], { stdio: "ignore" });
    // A real host-side mirror has an `origin` and a freshness clock (`ensureBare`,
    // `mirrorFreshness`) — orthogonal to what these tests check, so removed here the
    // same way it is absent for every OTHER repo this file builds by hand.
    g(paths.bare, "config", "--unset", "remote.origin.url");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("cuts a real worktree, and reuses the SAME one on a second call", async () => {
    const w1 = await worktreeFor(paths, "rev1", "main", "");
    expect(existsSync(join(w1, "a.txt"))).toBe(true);
    const w2 = await worktreeFor(paths, "rev1", "main", "");
    expect(w2).toBe(w1);
  });

  it("does not reuse a directory a dead worktree add left behind", async () => {
    const existing = join(paths.worktrees, "rev2");
    // NOT registered with git at all (no `git worktree add` ever ran) — exactly what
    // a killed one leaves: a populated directory `worktree list` has never heard of.
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "garbage.txt"), "not a real checkout\n");

    const w = await worktreeFor(paths, "rev2", "main", "");
    expect(existsSync(join(w, "garbage.txt")), "the dead directory must not have been reused as-is").toBe(false);
    expect(existsSync(join(w, "a.txt")), "a real, freshly-cut worktree must be there instead").toBe(true);
  });

  it("refuses to touch a worktree a peer is genuinely still creating", async () => {
    const existing = join(paths.worktrees, "rev3");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "partial.txt"), "mid-checkout\n");
    // `git worktree add` holds exactly this lock, in exactly this location, for the
    // whole time it runs (verified directly against real git) — a fresh one is
    // indistinguishable from a peer's checkout that is honestly still in progress.
    const adminDir = join(paths.bare, "worktrees", "rev3");
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(adminDir, "index.lock"), "");

    await expect(worktreeFor(paths, "rev3", "main", "")).rejects.toThrow(/already creating/);
    expect(existsSync(join(existing, "partial.txt")), "a live peer's directory must be untouched").toBe(true);
  });

  it("treats a lock far older than addWorktree's own timeout as abandoned, not busy", async () => {
    const existing = join(paths.worktrees, "rev4");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "partial.txt"), "mid-checkout\n");
    const adminDir = join(paths.bare, "worktrees", "rev4");
    mkdirSync(adminDir, { recursive: true });
    const lock = join(adminDir, "index.lock");
    writeFileSync(lock, "");
    // Older than WORKTREE_ADD_TIMEOUT_MS (300s) + the 60s margin: nothing this
    // codebase starts could still legitimately hold this lock.
    const old = new Date(Date.now() - 400_000);
    utimesSync(lock, old, old);

    const w = await worktreeFor(paths, "rev4", "main", "");
    expect(existsSync(join(w, "a.txt")), "self-healed to a real worktree instead of waiting forever").toBe(true);
  });
});
