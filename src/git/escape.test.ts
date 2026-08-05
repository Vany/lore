/**
 * What `ensureBare` guarantees now that it clones and fetches for itself (D-65).
 *
 * It used to only check, and refuse with "run `make mirror` on the host" — an
 * instruction the only party who ever reads it cannot follow, because the client is
 * an agent with no shell there. So the mirror is made current here, with the
 * repository's own read-only deploy key, and a refusal now means it could not be.
 *
 * Every url below is a LOCAL PATH on purpose. git reaches those through the
 * filesystem, so no key is generated, no ssh runs, and the suite neither touches the
 * network nor depends on a credential — while exercising the same code a remote
 * takes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDiff, renderDiff } from "./diff.ts";
import { type RepoPaths, ensureBare, worktreeFor } from "./repo.ts";

let root: string;

/** The full shape, so a test never has to know how `repoPaths` lays a repo out. */
const at = (id: string): RepoPaths => ({
  bare: join(root, "repos", id, "bare.git"),
  worktrees: join(root, "repos", id, "wt"),
  keysDir: join(root, "keys"),
  repoId: id,
});

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
  it("clones into an empty directory nested in another repo, rather than adopting it", async () => {
    const outer = join(root, "outer");
    const g = makeRepo(outer);
    g("tag", "precious-tag");
    const src = join(root, "src-nested");
    makeRepo(src);

    // lore's data directory living inside a checkout: the normal layout. The bare
    // path exists but is EMPTY, which is what made `rev-parse` report the enclosing
    // checkout and every later command operate on the operator's own repository.
    const paths = { ...at("r1"), bare: join(outer, "data/repos/r1/bare.git") };
    mkdirSync(paths.bare, { recursive: true });

    await ensureBare(paths, src);

    // The enclosing repository is untouched — without the ceiling, `fetch --prune
    // --tags` would have run in it and taken this with it.
    expect(execFileSync("git", ["-C", outer, "tag"], { encoding: "utf8" })).toContain("precious-tag");
    // And what was cloned is the source, not the enclosing repo.
    expect(
      execFileSync("git", ["-C", paths.bare, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim(),
    ).toBe(src);
  });
});

describe("the mirror is made current, or the review does not run (D-65)", () => {
  it("clones on demand when nothing has been mirrored yet", async () => {
    const src = join(root, "src-ondemand");
    makeRepo(src);
    const paths = at("r2");

    await ensureBare(paths, src);

    // A clone that is immediately usable: origin refs resolve, which is the state
    // `make mirror`'s clone-then-fetch could fail to reach.
    expect(existsSync(join(paths.bare, "objects"))).toBe(true);
    expect(
      execFileSync("git", ["-C", paths.bare, "rev-parse", "origin/main"], { encoding: "utf8" }).trim(),
    ).toHaveLength(40);
  });

  // The failure is loud and the mirror is left absent rather than half-made — a
  // partial clone satisfies `rev-parse` next time, so the next review would take the
  // never-fetched path against an empty object store instead of cloning properly.
  it("leaves nothing behind when the clone fails", async () => {
    const paths = at("r2b");
    await expect(ensureBare(paths, join(root, "no-such-repo"))).rejects.toThrow(/could not fetch/);
    expect(existsSync(paths.bare)).toBe(false);
  });

  it("accepts a clone with no remote, because it cannot be behind one", async () => {
    const src = join(root, "src1");
    makeRepo(src);
    const paths = at("r3");
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
  it("fetches a clone whose fetch never landed, rather than reviewing the clone-time commit", async () => {
    const src = join(root, "src-nofetch");
    const g = makeRepo(src);
    const paths = at("r6");
    mirror(src, paths.bare); // clone only — no fetch, so no FETCH_HEAD
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);

    // The precondition that makes this dangerous rather than merely unfetched.
    expect(existsSync(join(paths.bare, "FETCH_HEAD"))).toBe(false);
    expect(execFileSync("git", ["-C", paths.bare, "config", "--get", "remote.origin.url"]).toString().trim()).toBe(src);

    // The source moves after the clone. `origin/main` does not exist yet, so without
    // the fetch `addWorktree` falls back to the frozen local branch.
    writeFileSync(join(src, "later.txt"), "later\n");
    g("add", "-A");
    g("commit", "-qm", "after the clone");

    await ensureBare(paths, src);

    const originMain = execFileSync("git", ["-C", paths.bare, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
    const srcMain = execFileSync("git", ["-C", src, "rev-parse", "main"], { encoding: "utf8" }).trim();
    expect(originMain).toBe(srcMain); // caught up, not frozen
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
  it("refreshes whenever a base is cut, and never once the review is pinned", async () => {
    const src = join(root, "src-submit");
    const g = makeRepo(src);
    const paths = at("r7");
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    const fetchHead = join(paths.bare, "FETCH_HEAD");
    const stale = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(fetchHead, stale, stale);

    // The source moves while the mirror is stale. Cutting a base must see it.
    writeFileSync(join(src, "b.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "moved while the mirror was stale");

    // The submit path is the one that used to skip the question entirely.
    const wt = await worktreeFor(paths, "rev_x", "main", src);
    expect(existsSync(wt)).toBe(true);
    expect(execFileSync("git", ["-C", paths.bare, "rev-parse", "origin/main"], { encoding: "utf8" }).trim()).toBe(
      execFileSync("git", ["-C", src, "rev-parse", "main"], { encoding: "utf8" }).trim(),
    );

    // A review already holding a worktree is pinned to it (D-40) and never reads the
    // mirror again — so a later round must NOT fetch, however stale the mirror looks.
    //
    // Not hypothetical tidiness: when staleness was disqualifying on every round,
    // round 3 was refused at "35 minutes" after t2 alone had spent 16, destroying
    // three rounds and eight answered findings. Re-fetching instead of refusing would
    // repeat the same mistake in the other direction — moving the base under a review
    // that has already been reported on.
    utimesSync(fetchHead, stale, stale);
    writeFileSync(join(src, "c.txt"), "c\n");
    g("add", "-A");
    g("commit", "-qm", "must not be pulled into a pinned review");

    await expect(worktreeFor(paths, "rev_x", "main", src)).resolves.toBe(wt);
    expect(execFileSync("git", ["-C", paths.bare, "rev-parse", "origin/main"], { encoding: "utf8" }).trim()).not.toBe(
      execFileSync("git", ["-C", src, "rev-parse", "main"], { encoding: "utf8" }).trim(),
    );
  });

  it("does not fetch a clone that is already current", async () => {
    const src = join(root, "src2");
    makeRepo(src);
    const paths = at("r4");
    mirror(src, paths.bare);
    const fetchHead = join(paths.bare, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    const stamp = statSync(fetchHead).mtimeMs;

    await expect(ensureBare(paths, src)).resolves.toBeUndefined();
    // Untouched: re-fetching inside the window would cost a network round trip per
    // round on every review, for a mirror that is by definition current enough.
    expect(statSync(fetchHead).mtimeMs).toBe(stamp);
  });

  // The failure that used to be a client's to fix and is now lore's: a mirror
  // nobody refreshed. Reviewing it anyway describes a tree that is not the one being
  // merged — INV-2, with an attestation over it.
  it("refreshes a stale clone before choosing a base", async () => {
    const src = join(root, "src3");
    const g = makeRepo(src);
    const paths = at("r5");
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);
    const fetchHead = join(paths.bare, "FETCH_HEAD");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(fetchHead, old, old);

    writeFileSync(join(src, "new.txt"), "new\n");
    g("add", "-A");
    g("commit", "-qm", "upstream moved");

    await ensureBare(paths, src);
    expect(execFileSync("git", ["-C", paths.bare, "rev-parse", "origin/main"], { encoding: "utf8" }).trim()).toBe(
      execFileSync("git", ["-C", src, "rev-parse", "main"], { encoding: "utf8" }).trim(),
    );

    // ...and the pinned path still declines to look, whatever the age.
    utimesSync(fetchHead, old, old);
    await expect(ensureBare(paths, src, false)).resolves.toBeUndefined();
    expect(statSync(fetchHead).mtime.getTime()).toBe(old.getTime());
  });
});

// The two traps a mirror sets, both hit by hand before they were fixed.
describe("a mirror's local branches are frozen, and nothing may resolve to them", () => {
  // `make mirror` fetches into refs/remotes/origin/* and never touches refs/heads/*,
  // so a mirror's own `main` still points at the commit it was cloned at. Resolving
  // an `into` of "main" against that produces a diff many times the real change —
  // which reads as an enormous branch rather than as a wrong base. Measured on this
  // repository at 165 KB against 94 KB for the same work.
  it("prefers origin/<base> over the stale local branch", async () => {
    const src = join(root, "src-drift");
    const g = makeRepo(src);
    const paths = at("r8");
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    // The source moves; the mirror's LOCAL `main` does not follow a fetch.
    writeFileSync(join(src, "b.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "second");
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    const localMain = execFileSync("git", ["-C", paths.bare, "rev-parse", "main"], { encoding: "utf8" }).trim();
    const originMain = execFileSync("git", ["-C", paths.bare, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
    expect(localMain).not.toBe(originMain); // the trap exists

    const wt = await worktreeFor(paths, "rev_drift", "main", src);
    const diff = await computeDiff(wt, "main");
    // Against origin/main there is nothing between them; against the stale local
    // branch the second commit would show up as the branch's own work.
    expect(diff.mergeBase).toBe(originMain);
    expect(diff.changedFiles).toStrictEqual([]);
  });

  // The message that sent someone hunting for a branch that existed: tokens are
  // per-repo, so starting a review of one repository's branch with another's token
  // reports, truthfully and uselessly, that the branch is not there.
  it("names the repository when a branch is missing, and what else it holds", async () => {
    const src = join(root, "src-wrongrepo");
    makeRepo(src);
    const paths = at("r9");
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    const err = await worktreeFor(paths, "rev_x", "feat/belongs-elsewhere", "git@github.com:org/other.git")
      .then(() => undefined, (e: unknown) => e as Error);

    expect(err?.message).toContain("git@github.com:org/other.git");
    expect(err?.message).toMatch(/token is scoped/);
    expect(err?.message).toContain("main"); // what the mirror actually holds
  });
});

// A reviewer was given `Base: main (merge-base abc123)`, went and ran
// `git diff main..HEAD` itself, and reported at HIGH severity that the branch had
// bundled a ~70-file refactor from an unrelated ticket. The branch was one commit
// and twenty files. The base had moved 22 commits ahead, and two dots render that
// as the branch deleting everything the base gained.
//
// The alarm was right — the branch WAS dangerously stale — and the diagnosis was
// invented, because nothing told it how far behind the branch was. So the true fact
// is stated now, and the trap is named.
describe("the diff says what it is, and how stale the branch is", () => {
  it("names three-dot semantics and warns off two", async () => {
    const src = join(root, "src-semantics");
    const g = makeRepo(src);
    const paths = at("rA");
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    // The base moves on without the branch — the shape that misled the reviewer.
    writeFileSync(join(src, "b.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "base moves on");
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    const wt = await worktreeFor(paths, "rev_sem", "main", src);
    const rendered = renderDiff(await computeDiff(wt, "main"));

    expect(rendered).toMatch(/three-dot/);
    expect(rendered).toMatch(/Do NOT recompute/);
    expect(rendered).toContain("git diff <base>..HEAD");
  });

  it("states how far behind the branch is, rather than leaving it to be inferred", async () => {
    const src = join(root, "src-behind");
    const g = makeRepo(src);
    const paths = at("rB");
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);
    const forkPoint = execFileSync("git", ["-C", paths.bare, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();

    for (const n of [1, 2, 3]) {
      writeFileSync(join(src, `m${n}.txt`), "x\n");
      g("add", "-A");
      g("commit", "-qm", `base ${n}`);
    }
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    // A worktree cut at the fork point: zero of its own commits, three behind.
    execFileSync("git", ["-C", paths.bare, "worktree", "add", "--detach", join(paths.worktrees, "rev_b"), forkPoint], { stdio: "ignore" });
    const d = await computeDiff(join(paths.worktrees, "rev_b"), "main");

    expect(d.behindBy).toBe(3);
    expect(renderDiff(d)).toContain("MOVED 3 COMMIT(S) AHEAD");
  });
});

// Everything a command can answer, answered by the command.
//
// A reviewer given only the diff and `Base: main` reported that a one-commit,
// twenty-file branch had bundled a seventy-file refactor from an unrelated ticket.
// It had not — the base had moved 22 commits ahead. Each fact below is deterministic,
// costs milliseconds, and removes a question the model was answering by inference.
describe("what the model is told instead of left to infer", () => {
  const repoWithBranch = async (name: string) => {
    const src = join(root, `src-${name}`);
    const g = makeRepo(src);
    const paths = at(name);
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);
    return { src, g, paths };
  };

  it("lists the branch's own commits, so a focused branch cannot read as a bundled one", async () => {
    const { src, g, paths } = await repoWithBranch("rC");
    g("checkout", "-qb", "feat/x");
    writeFileSync(join(src, "f.txt"), "f\n");
    g("add", "-A");
    g("commit", "-qm", "the only thing this branch does");
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    const wt = await worktreeFor(paths, "rev_c", "feat/x", src);
    const d = await computeDiff(wt, "main");

    expect(d.commits).toHaveLength(1);
    expect(d.commits[0]).toContain("the only thing this branch does");
    expect(renderDiff(d)).toContain("THIS BRANCH IS 1 COMMIT(S)");
  });

  // "Behind" says the base moved. This says whether that matters — and it is the
  // question a landing decision actually turns on.
  it("says whether it still merges, and which files both sides touched", async () => {
    const { src, g, paths } = await repoWithBranch("rD");
    g("checkout", "-qb", "feat/y");
    writeFileSync(join(src, "shared.txt"), "branch version\n");
    g("add", "-A");
    g("commit", "-qm", "branch touches shared");
    g("checkout", "-q", "main");
    writeFileSync(join(src, "shared.txt"), "base version\n");
    writeFileSync(join(src, "other.txt"), "base only\n");
    g("add", "-A");
    g("commit", "-qm", "base touches shared too");
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    const wt = await worktreeFor(paths, "rev_d", "feat/y", src);
    const d = await computeDiff(wt, "main");

    expect(d.behindBy).toBe(1);
    expect(d.overlap.map((o) => o.file)).toStrictEqual(["shared.txt"]); // not other.txt
    expect(d.overlap[0]?.baseCommits.join(" ")).toContain("base touches shared too");
    expect(d.mergesClean).toBe(false); // both edited the same line
    const out = renderDiff(d);
    expect(out).toContain("NO LONGER MERGES CLEANLY");
    expect(out).toContain("shared.txt");
  });

  // Unknown is not "fine". If git cannot answer, say so rather than implying safety.
  it("never reports a clean merge it did not verify", async () => {
    const { paths, src } = await repoWithBranch("rE");
    const d = await computeDiff(await worktreeFor(paths, "rev_e", "main", src), "main");
    // Current branch: nothing to say about merging at all.
    expect(d.behindBy).toBe(0);
    expect(renderDiff(d)).not.toContain("MERGES CLEANLY");
  });
});

// The base's commits per overlapping file, which is what turns a warning into a
// finding — and the exact fact whose absence produced a false one.
//
// A reviewer reported that a branch had bundled "a refactoring from RIGID-455".
// RIGID-455 was real: it was on the BASE, and it had touched the one file the branch
// also touched. The model had the ticket name and attributed it to the wrong side.
describe("the base's own work on the files that overlap", () => {
  it("names which base commits touched each shared file", async () => {
    const src = join(root, "src-attr");
    const g = makeRepo(src);
    const paths = at("rF");
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    g("checkout", "-qb", "feat/z");
    writeFileSync(join(src, "contract.ts"), "branch edit\n");
    g("add", "-A");
    g("commit", "-qm", "branch edits the contract");
    g("checkout", "-q", "main");
    writeFileSync(join(src, "contract.ts"), "base edit\n");
    g("add", "-A");
    g("commit", "-qm", "TICKET-455 remove the face from contracts");
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    const d = await computeDiff(await worktreeFor(paths, "rev_f", "feat/z", src), "main");
    const shared = d.overlap.find((o) => o.file === "contract.ts");
    expect(shared).toBeDefined();
    // The attribution that was missing: the ticket belongs to the BASE.
    expect(shared?.baseCommits.join(" ")).toContain("TICKET-455");
    expect(renderDiff(d)).toContain("base: ");
  });

  // A branch touching source and no tests is a question worth asking every time.
  it("says plainly when source changed and no test did", async () => {
    const src = join(root, "src-notest");
    const g = makeRepo(src);
    const paths = at("rG");
    mirror(src, paths.bare);
    execFileSync("git", ["-C", paths.bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    g("checkout", "-qb", "feat/untested");
    writeFileSync(join(src, "money.ts"), "export const x = 1\n");
    g("add", "-A");
    g("commit", "-qm", "change the money path");
    execFileSync("git", ["-C", paths.bare, "fetch", "-q", "origin"]);

    const d = await computeDiff(await worktreeFor(paths, "rev_g", "feat/untested", src), "main");
    expect(d.changedSource).toBe(1);
    expect(d.changedTests).toBe(0);
    expect(renderDiff(d)).toContain("NO test file changed");
  });
});
