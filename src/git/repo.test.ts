/**
 * The git boundary, where a caller's string meets a command line.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch, gitlinks, restoreTree, revParse, treeHash, type RepoPaths, worktreeFor } from "./repo.ts";

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

  // Found by lore's own review (70cc792a), the opposite direction from the bump
  // fixes above: the restore loop answers "add -A MOVED a gitlink `before` already
  // had" — it does nothing for one add -A INVENTS. Deleting a submodule removes its
  // gitlink from the index cleanly (`applyPatch --index`, so the pre-loop snapshot is
  // correctly empty), but git's own apply cannot rmdir the submodule's directory
  // while the submodule's OWN `.git` is still inside it, so the directory survives
  // untracked. `add -A` then reads that survivor as an embedded repository and
  // re-stages the gitlink `before` never had anything to restore over.
  it("treeHash does not let add -A resurrect a gitlink the client deleted", async () => {
    // `git rm inner` also rewrites `.gitmodules` to drop the submodule's own section,
    // staging both in one step — the ordinary shape of a real deletion.
    execFileSync("git", ["rm", "-q", "inner"], { cwd: outerDir, stdio: "ignore" });
    const patch = execFileSync("git", ["diff", "--cached", "--submodule=short"], { cwd: outerDir, encoding: "utf8" });
    execFileSync("git", ["reset", "-q", "--hard", "HEAD"], { cwd: outerDir, stdio: "ignore" });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init"], {
      cwd: outerDir,
      stdio: "ignore",
    });
    expect(existsSync(join(outerDir, "inner", ".git")), "fixture must start with inner really checked out").toBe(true);

    await applyPatch(outerDir, patch);
    expect(await gitlinks(outerDir), "the deletion must apply cleanly first").toStrictEqual([]);

    await treeHash(outerDir);

    expect(await gitlinks(outerDir), "add -A must not resurrect the deleted gitlink").toStrictEqual([]);
    expect(existsSync(join(outerDir, "inner")), "the leftover directory must be cleaned up, not merely untracked").toBe(
      false,
    );
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: outerDir,
      encoding: "utf8",
    });
    expect(untracked, "no leftover inner/* debris should show as untracked either").toBe("");
  });

  // Found by lore's own review (3c9916f4): a rejected submission calls `restoreTree`
  // to put the worktree back exactly as `review_submit` tells the client — but
  // `checkout-index` only ever writes REGULAR files from the index, and a gitlink has
  // none, so a submodule bump that `treeHash` had already checked out (the d6f934ac
  // fix, working) survives a restore meant to undo it. The next round would have
  // reviewed a "refused" bump as if it were real, unreviewed content.
  it("restoreTree also checks the submodule back out, undoing a bump treeHash applied", async () => {
    execFileSync("git", ["checkout", "-q", commitB], { cwd: join(outerDir, "inner"), stdio: "ignore" });
    const patch = execFileSync("git", ["diff", "--submodule=short"], { cwd: outerDir, encoding: "utf8" });
    execFileSync("git", ["checkout", "-q", commitA], { cwd: join(outerDir, "inner"), stdio: "ignore" });

    const before = await treeHash(outerDir);
    await applyPatch(outerDir, patch);
    await treeHash(outerDir);
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(outerDir, "inner"), encoding: "utf8" }).trim(),
      "the bump must really have moved the submodule first, or this test proves nothing",
    ).toBe(commitB);

    await restoreTree(outerDir, before);

    expect(await gitlinks(outerDir), "the index must be back at the pre-bump commit").toStrictEqual([
      { commit: commitA, path: "inner" },
    ]);
    const innerHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(outerDir, "inner"), encoding: "utf8" }).trim();
    expect(innerHead, "the submodule's own checkout must follow the index back, not stay at the bumped commit").toBe(
      commitA,
    );
  });

  // Found by lore's own review (7f6e08e7), against my own prior comment on this
  // function: a swallowed `submodule update` failure is NOT visible via
  // `submodulesThatFailedToExpand` the way that comment claimed — when the checkout
  // never moves, the next round's diff has nothing to fail expanding, just two
  // identical commits and a silently stale read. Refusing outright, instead, is what
  // this test pins: a gitlink pointing at a commit `inner`'s own git genuinely cannot
  // resolve (never fetched, never will be — the D-65 shape) must throw rather than
  // let treeHash succeed over content it cannot show a reviewer.
  it("treeHash refuses to verify a submodule bump it could not actually check out", async () => {
    const unreachable = "1111111111111111111111111111111111111111";
    const patch = [
      "diff --git a/inner b/inner",
      "index " + commitA.slice(0, 7) + ".." + unreachable.slice(0, 7) + " 160000",
      "--- a/inner",
      "+++ b/inner",
      "@@ -1 +1 @@",
      "-Subproject commit " + commitA,
      "+Subproject commit " + unreachable,
      "",
    ].join("\n");

    await applyPatch(outerDir, patch);
    expect(await gitlinks(outerDir)).toStrictEqual([{ commit: unreachable, path: "inner" }]);

    await expect(treeHash(outerDir)).rejects.toThrow(/could not check that commit out/);

    // Found by lore's own review (d439b83c), on top of the throw above: leaving the
    // index at the unreachable commit made the worktree look broken to
    // `worktreeIsIntact` for every call after this one, not just this one — which
    // used to mean the ENTIRE worktree got destroyed and rebuilt, taking every other
    // accepted fix with it. The index must follow reality back down, same as the
    // submodule's checkout never left it.
    expect(
      await gitlinks(outerDir),
      "a refused bump must not leave the index pointing at a commit nothing has checked out",
    ).toStrictEqual([{ commit: commitA, path: "inner" }]);
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

  // Found by lore's own review (f1f825ce): registration alone answers "has a
  // `git worktree add` STARTED", not "has it finished" — verified directly, on a
  // 40,000-file checkout, registered from its very first written file. The fast path
  // used to trust registration by itself, which returned a live peer's (or a
  // partially-killed) checkout as done from the moment it began. This constructs the
  // shape directly — registered (a real, completed `worktreeFor` call), then
  // mutilated exactly like an interrupted checkout would be (see `worktreeIsIntact`) —
  // rather than timing a real kill, which this suite cannot do cheaply.
  it("does not reuse a registered worktree whose checkout does not match its index", async () => {
    const w1 = await worktreeFor(paths, "rev1b", "main", "");
    rmSync(join(w1, "a.txt"));
    expect(existsSync(join(w1, "a.txt"))).toBe(false);

    const w2 = await worktreeFor(paths, "rev1b", "main", "");
    expect(w2).toBe(w1);
    expect(existsSync(join(w2, "a.txt")), "must have been rebuilt clean, not reused mutilated").toBe(true);
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

  // Found by lore's own review (d439b83c, 3ce71958): treeHash's and restoreTree's own
  // swallowed submodule-update failures can leave a real `git status` mismatch for
  // ONE submodule — and `worktreeIsIntact`, before this fix, answered that by
  // sending this function to `removeWorktree`: not a repair of the one submodule but
  // destruction of the ENTIRE review worktree, every other previously accepted,
  // never-committed fix in it gone with it (D-40). Builds that exact mismatch on a
  // worktree that also carries a stand-in for other accumulated work, and checks
  // `worktreeFor` repairs it in place instead of destroying anything.
  it("repairs a submodule/index mismatch in place, rather than destroying the whole worktree over it", async () => {
    const innerDir = join(root, "inner");
    mkdirSync(innerDir);
    g(innerDir, "init", "-q", "-b", "main");
    g(innerDir, "config", "user.email", "t@example.com");
    g(innerDir, "config", "user.name", "t");
    writeFileSync(join(innerDir, "f.txt"), "a\n");
    g(innerDir, "add", "-A");
    g(innerDir, "commit", "-qm", "commit A");
    const commitA = g(innerDir, "rev-parse", "HEAD");
    writeFileSync(join(innerDir, "f.txt"), "a\nb\n");
    g(innerDir, "add", "-A");
    g(innerDir, "commit", "-qm", "commit B");
    const commitB = g(innerDir, "rev-parse", "HEAD");

    const srcDir = join(root, "src");
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", innerDir, "inner"], {
      cwd: srcDir,
      stdio: "ignore",
    });
    g(srcDir, "add", "-A");
    g(srcDir, "commit", "-qm", "add submodule at A");
    execFileSync("git", ["push", "-q", paths.bare, "main:main"], { cwd: srcDir, stdio: "ignore" });

    // `addWorktree`'s own `submodule update --init` (repo.ts) takes no config
    // override and swallows its failure — exactly the D-65 shape, and exactly what a
    // local file:// submodule hits by git's own default security policy. The env var
    // is what a real deployment never needs (https/ssh remotes are unaffected) and
    // this fixture does, to get past worktree creation to the state under test.
    const priorAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file";
    let w: string;
    try {
      w = await worktreeFor(paths, "rev5", "main", "");
    } finally {
      if (priorAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = priorAllowProtocol;
    }
    writeFileSync(join(w, "other-accepted-fix.txt"), "from an earlier round of this same review\n");
    execFileSync("git", ["add", "-A"], { cwd: w, stdio: "ignore" });

    // The exact shape a swallowed submodule-update failure leaves: index names a
    // commit the submodule directory does not actually have checked out.
    execFileSync("git", ["checkout", "-q", commitB], { cwd: join(w, "inner"), stdio: "ignore" });
    execFileSync("git", ["update-index", "--cacheinfo", `160000,${commitA},inner`], { cwd: w, stdio: "ignore" });
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: w, encoding: "utf8" }),
      "fixture must actually be dirty in column Y, or this test proves nothing",
    ).toMatch(/^.M inner$/m);

    const w2 = await worktreeFor(paths, "rev5", "main", "");

    expect(w2, "the SAME worktree, not a fresh one cut from origin").toBe(w);
    expect(
      existsSync(join(w2, "other-accepted-fix.txt")),
      "an earlier round's accepted fix must survive a submodule repair",
    ).toBe(true);
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(w2, "inner"), encoding: "utf8" }).trim(),
      "the submodule mismatch must have been repaired to match the index",
    ).toBe(commitA);
  });

  // Found by lore's own review (55c1bb52, 78352737, ce7012da): the ad43ea6d/d6f934ac
  // reachability check ran over EVERY gitlink in the index, not just ones a submission
  // touched — so a submodule addWorktree already tolerates being unable to fetch
  // (D-65, the exact case repo.ts:272's swallowed `submodule update --init` exists
  // for) made treeHash throw on EVERY future submit, for ANY file, forever: the repo
  // becomes permanently unreviewable. Worse than reported — reproduced directly that
  // `rev-parse HEAD` inside the never-initialized directory does not fail, it silently
  // answers from the OUTER worktree, so the old code would have written that bogus
  // value into the gitlink on its way to throwing. This builds a genuinely
  // uninitialized submodule (no `protocol.file.allow`, matching a real inaccessible
  // remote) and checks an UNRELATED fix still submits cleanly.
  it("treeHash tolerates a submodule addWorktree could never initialize, for an unrelated fix", async () => {
    const innerDir = join(root, "inner-never-reachable");
    mkdirSync(innerDir);
    g(innerDir, "init", "-q", "-b", "main");
    g(innerDir, "config", "user.email", "t@example.com");
    g(innerDir, "config", "user.name", "t");
    writeFileSync(join(innerDir, "f.txt"), "a\n");
    g(innerDir, "add", "-A");
    g(innerDir, "commit", "-qm", "commit A");

    const srcDir = join(root, "src");
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", innerDir, "inner"], {
      cwd: srcDir,
      stdio: "ignore",
    });
    g(srcDir, "add", "-A");
    g(srcDir, "commit", "-qm", "add submodule, never reachable from the worktree side");
    execFileSync("git", ["push", "-q", paths.bare, "main:main"], { cwd: srcDir, stdio: "ignore" });

    // Deliberately WITHOUT GIT_ALLOW_PROTOCOL=file: addWorktree's own `submodule
    // update --init` (repo.ts) hits the same restriction a real private, no-credentials
    // remote would, and swallows it exactly as designed.
    const w = await worktreeFor(paths, "rev6", "main", "");
    expect(existsSync(join(w, "inner", ".git")), "fixture must genuinely be uninitialized, or this test proves nothing").toBe(
      false,
    );

    writeFileSync(join(w, "unrelated.txt"), "a fix that never touches inner\n");
    execFileSync("git", ["add", "-A"], { cwd: w, stdio: "ignore" });

    await expect(treeHash(w), "an unrelated fix must not be blocked by a submodule nothing ever fetched").resolves.toEqual(
      expect.any(String),
    );
    expect(
      await gitlinks(w),
      "the untouched, never-initialized gitlink must be exactly what it always was, not the outer worktree's own HEAD",
    ).toStrictEqual([{ commit: g(innerDir, "rev-parse", "HEAD"), path: "inner" }]);
  });
});
