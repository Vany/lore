/**
 * The diff a review actually looks at.
 *
 * Three inherited rules, each of which cost real debugging time in the predecessor:
 * the base is the freshly-fetched remote ref (INV-2), the diff includes uncommitted
 * work in the review worktree (INV-3), and untracked files are named explicitly
 * because `git diff` cannot see them at all (INV-4).
 */

import { git, gitLines, gitMaybe } from "./exec.ts";

/**
 * Above this, the diff is cut and the reviewer is told so.
 *
 * A truncated diff means the reviewer did not see the whole change, and a reviewer
 * that silently saw half a change reports confidently about the half it got
 * (INV-7). An unexpectedly large diff usually means the base is wrong.
 */
const MAX_OVERLAP = 10;
const MAX_COMMITS_PER_FILE = 4;

/**
 * File extension/path only (D-132) — not diff content, so a comment-only change
 * inside a `.ts` file (a docstring, a `TOOL_DOCS` string) is invisible to this and
 * is never a doc. Exported: `review.ts` is the only production reader, applying it
 * to a finding's own `file` — deliberately NOT also exposed on `ReviewDiff` (a
 * `changedDocs`/`docsOnly` pair lived here once and had no production reader,
 * which is exactly what baited fingerprint 6a6ae919: the per-tier bound was wired
 * to the branch's whole diff instead of what was still open, because that field
 * existed, was named right, and was wrong. Removed rather than wired up for its
 * own sake — see D-132's SPEC entry.
 */
export const isDoc = (f: string) => /\.md$/.test(f) || /^(spec|docs)\//.test(f);
const MAX_DIFF_CHARS = 600_000;

/**
 * Which submodules `--submodule=diff` could not expand, named.
 *
 * Found by lore's own review: `addWorktree` (`repo.ts`) swallows a failed `git
 * submodule update --init` under a comment claiming the loss is "announced by the
 * diff layer" — nothing announced it, anywhere in this codebase, until now. When a
 * submodule's objects are missing (no credentials for a private remote, D-65),
 * `--submodule=diff` cannot expand the bump, and git says so INSIDE the patch text —
 * verified directly against real git: `Submodule <path> <a>..<b>:` followed by an
 * error line and a literal `(diff failed)`. That text was already reaching every
 * tier, unamplified, in a codebase whose whole design is that a check which did not
 * run says so LOUDLY (INV-1) rather than leaving a reader to notice three lines of
 * raw git output. D-36 promises a gitlink change is "expanded, or told explicitly it
 * was too large" (spec/review-ladder.md §6.1); this is the untold case.
 *
 * Scans backward from each `(diff failed)` line rather than matching the error
 * line's exact wording, which is git's own and not this project's to pin.
 */
function submodulesThatFailedToExpand(patch: string): readonly string[] {
  const lines = patch.split("\n");
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "(diff failed)") continue;
    for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
      const m = /^Submodule (\S+) /.exec(lines[j] ?? "");
      if (m?.[1] !== undefined) {
        names.push(m[1]);
        break;
      }
    }
  }
  return names;
}

/**
 * git's well-known empty-tree object. Present in every repository with no setup —
 * it is how `wholeTreeDiff` (D-130) gets a real, ordinary `git diff` (every file
 * shown as added) instead of a hand-rolled "pretend this is a diff" shape.
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface ReviewDiff {
  readonly base: string;
  readonly mergeBase: string;
  readonly stat: string;
  readonly patch: string;
  readonly truncated: boolean;
  /** Submodules `--submodule=diff` could not expand — see `submodulesThatFailedToExpand`. */
  readonly submoduleExpansionFailed: readonly string[];
  readonly totalChars: number;
  /**
   * Set only by `wholeTreeDiff` (D-130): the path this folder review is scoped to
   * (`"."` for the whole worktree). Absent for an ordinary branch-vs-`into` diff.
   *
   * This is what lets `renderDiff` and callers detect folder mode from the
   * `ReviewDiff` itself, instead of threading a second mode flag everywhere a
   * `ReviewDiff` already travels.
   */
  readonly scopePath?: string;
  /** Invisible to `git diff`, so they are listed by name (INV-4). */
  readonly untracked: readonly string[];
  /** Files touched, for scoping knowledge and T0 work. */
  readonly changedFiles: readonly string[];
  /**
   * How many commits the BASE has that this branch does not.
   *
   * The real signal a reviewer wants when it senses something is off about a stale
   * branch — and without it one invented a substitute, reporting that the branch
   * had bundled a 70-file refactor from another ticket. It had not: the base had
   * moved 22 commits ahead, and a two-dot diff renders that as the branch deleting
   * everything the base had added.
   */
  readonly behindBy: number;
  /**
   * The branch's OWN commits, subject line each.
   *
   * A reviewer with the diff but not this cannot tell a focused branch from a
   * bundled one, and one guessed: it reported that a single-commit, twenty-file
   * branch had folded in a seventy-file refactor from another ticket. The commit
   * list makes that unguessable.
   */
  readonly commits: readonly string[];
  /**
   * Whether the branch still merges into the base AS IT NOW STANDS.
   *
   * `behindBy` says the base moved; this says whether that matters. Computed with
   * `merge-tree`, which merges in memory and writes nothing. `undefined` when git
   * could not answer — never guessed, because "probably fine" is the claim this
   * project exists to refuse.
   */
  readonly mergesClean: boolean | undefined;
  /**
   * Files this branch changed that the BASE also changed since they diverged.
   *
   * The concrete risk in a stale branch, and the only part of staleness a reviewer
   * can actually inspect. Textually clean and semantically broken lives here: a
   * branch calling a helper the base has since deleted conflicts with nothing.
   */
  readonly overlap: readonly OverlapFile[];
  /** Changed files that look like tests, and those that do not. */
  readonly changedTests: number;
  readonly changedSource: number;
}

/**
 * A file both sides changed, and WHAT the base did to it.
 *
 * The base's commits are the part that turns a warning into a finding. On a real
 * pull request the reviewer reported that the branch had bundled "a refactoring from
 * RIGID-455". RIGID-455 was real — and it was on the BASE, touching the one file the
 * branch also touched. The model had seen the ticket somewhere and attributed it to
 * the wrong side. Naming the base's commits per overlapping file gives it the true
 * story instead of the raw material for a wrong one.
 */
export interface OverlapFile {
  readonly file: string;
  readonly baseCommits: readonly string[];
}

/**
 * WHAT A REVIEW IS A REVIEW OF, decided once and then kept (D-113).
 *
 * `merge-base(into, HEAD)` answers "where did this branch leave the base", which is the
 * right question at the moment a review is PINNED and the wrong one every time after.
 * `into` keeps moving: it is a branch name resolved fresh on every round, and when it
 * advances to CONTAIN the branch under review — which is precisely what happens when the
 * work merges, or when a batch gate pushes its own commits before the ladder has ruled —
 * the merge-base collapses onto HEAD and the change-set becomes EMPTY. Four tiers then
 * read nothing, find nothing, and the ladder can still return `passed`: an attestation
 * over a diff of zero bytes, which is INV-1's failure in its most complete form.
 *
 * Measured 2026-08-16 on lore's own batch review: three files at pin time, and after two
 * further commits of the same batch reached `main`, `merge-base(origin/main, HEAD)`
 * returned HEAD itself and the diff was zero lines — while the review sat in
 * `findings_ready` looking ready to continue.
 *
 * So the base is resolved HERE, at pin time only — `review_start`'s first round and every
 * `pull_fresh` — and stored. Recomputing at a pin is deliberate rather than lazy: a pin is
 * the one moment the CLIENT has said "this is my branch now", so a developer who merged
 * the base into their branch gets a base that accounts for it, instead of a frozen one
 * that would report all of `into`'s commits as theirs. Between pins nothing moves.
 */
export async function baseCommitFor(worktree: string, into: string): Promise<string | undefined> {
  const resolved = await resolveInto(worktree, into);
  if (resolved === undefined) return undefined;
  return await gitMaybe(worktree, ["merge-base", resolved, "HEAD"]);
}

/**
 * `origin/<base>` first, exactly as `addWorktree` resolves the branch, or `undefined`
 * when the ref does not exist at all.
 *
 * THE ONLY PLACE THIS IS DECIDED, and the claim is now true of the code: `computeDiff`,
 * `baseCommitFor` and `ingestDocs` (`knowledge/ingest.ts`, via `readAtRef` below) all
 * call it. It said the same thing while `computeDiff` carried an inline duplicate, which
 * is the one-thing-defined-twice class this repository ratchets against — and the
 * disagreement it would produce is the pin resolving against one commit while the
 * measurement runs against another, which is D-113's whole subject; for ingestion the
 * same disagreement would mean asking a client's own branch what its team decided.
 */
export async function resolveInto(worktree: string, base: string): Promise<string | undefined> {
  const resolved =
    (await gitMaybe(worktree, ["rev-parse", "--verify", "--quiet", `origin/${base}^{commit}`])) ?? base;
  return (await gitMaybe(worktree, ["rev-parse", "--verify", "--quiet", `${resolved}^{commit}`])) === undefined
    ? undefined
    : resolved;
}

export async function computeDiff(
  worktree: string,
  base: string,
  /**
   * The commit this review was pinned to measure from (`review.baseCommit`), when it has
   * one. `undefined` for rows written before D-113, which recompute exactly as before —
   * back-filling a base for a review already in flight would silently redefine what it is
   * attesting to.
   *
   * Only the MEASUREMENT uses it. `mergesClean`, `behindBy` and the overlap analysis all
   * ask about `into` AS IT IS NOW, which is the whole point of those three.
   */
  pinnedBase?: string | undefined,
): Promise<ReviewDiff> {
  // `origin/<base>` first, exactly as `addWorktree` resolves the branch.
  //
  // A worktree shares its refs with the bare mirror, and in a mirror the LOCAL
  // branches are frozen at clone time: `make mirror` fetches into
  // `refs/remotes/origin/*` and never touches `refs/heads/*`. So `main` in a mirror
  // cloned weeks ago points at a weeks-old commit while `origin/main` is current, and
  // an `into` of `main` would diff against the stale one — producing a diff many
  // times the real change, which reads as an enormous branch rather than as a wrong
  // base. Measured here at 165 KB against 94 KB for the same work.
  //
  // A sha or a tag has no `origin/` form, so it falls through untouched.
  //
  // THROUGH `resolveInto`, not a second copy of it. This was the same two-step resolution
  // written out again inline, under a comment on `resolveInto` claiming the two could not
  // disagree — so the ref logic D-113's correctness rests on was defined twice, behind a
  // door labelled "cannot disagree". Change the resolution order once and the pin would be
  // computed against one commit while every round's `git diff` ran against another, which
  // is the exact pin/measurement split D-113 exists to make impossible.
  //
  // `undefined` means the ref does not resolve; `resolved` keeps the raw name for the
  // message below, which is the only thing that still wants it.
  const into = await resolveInto(worktree, base);
  const intoExists = into !== undefined;
  const resolved = into ?? base;

  // THE BASE MUST EXIST, and saying so here is the difference between an answer and a
  // riddle. `resolved` falls back to the raw name above, and `mergeBase` falls back to
  // `resolved` — so an `into` naming a branch this repository does not have travelled
  // all the way to `git diff <name>`, which failed with `fatal: ambiguous argument
  // 'main': unknown revision or path not in the working tree` and a host filesystem
  // path. That reached a client as a `failed` review with no reason at all, and reached
  // the operator log as raw git vocabulary about a directory nobody can see.
  //
  // Measured: a review of `teammater` (whose only branch is `master`) started with
  // `into: main` died in 1.4 seconds, before any tier was asked anything, and the one
  // fact needed to fix it — this repo has `master`, not `main` — was nowhere in the
  // output. The branch list is included because "does not exist" invites a second
  // guess, and the right one is usually visible from here.
  // THE PINNED BASE WINS WHEN THERE IS ONE (D-113), and it is verified before it is
  // trusted: a stored sha that no longer resolves — a force-push that dropped it, a
  // mirror recut — must not silently become `git diff <missing-sha>`, which fails with
  // raw git vocabulary at the one moment the client needs a reason. An unresolvable pin
  // falls through to the live merge-base, which is where this review would have been
  // without the column.
  //
  // RESOLVED BEFORE THE EXISTENCE CHECK BELOW, not after, because a review with a working
  // pin does not need `into` to exist any more. That ordering was a live defect created by
  // this project's own batch procedure: a batch reviews `into: review-base/<sha>`, both
  // scratch refs are deleted as documented cleanup, and the host refresher's
  // `fetch --prune` drops them from the mirror within five minutes. An open review — and
  // D-112 reviews stay open for days — then failed its next round with "the base branch
  // does not exist", stranding every ratified justification, while the pin column held
  // everything the measurement actually needed.
  const pinned =
    pinnedBase === undefined
      ? undefined
      : await gitMaybe(worktree, ["rev-parse", "--verify", "--quiet", `${pinnedBase}^{commit}`]);

  // THE BASE MUST EXIST — unless a pin already answers the only question it was needed
  // for. `resolved` falls back to the raw name above, and `mergeBase` falls back to
  // `resolved` — so an `into` naming a branch this repository does not have travelled
  // all the way to `git diff <name>`, which failed with `fatal: ambiguous argument
  // 'main': unknown revision or path not in the working tree` and a host filesystem
  // path. That reached a client as a `failed` review with no reason at all, and reached
  // the operator log as raw git vocabulary about a directory nobody can see.
  //
  // Measured: a review of `teammater` (whose only branch is `master`) started with
  // `into: main` died in 1.4 seconds, before any tier was asked anything, and the one
  // fact needed to fix it — this repo has `master`, not `main` — was nowhere in the
  // output. The branch list is included because "does not exist" invites a second
  // guess, and the right one is usually visible from here.
  if (!intoExists && pinned === undefined) {
    const branches = await gitLines(worktree, [
      "for-each-ref",
      "--format=%(refname:strip=3)",
      "refs/remotes/origin/",
    ]);
    const known = branches.filter((b) => b !== "" && b !== "HEAD");
    throw new Error(
      `the base branch '${base}' does not exist in this repository, so there is nothing to diff against — ` +
        `nothing was reviewed. ` +
        (known.length === 0
          ? "lore's copy has no branches yet, which usually means its sync has never populated one."
          : `Branches lore can see: ${known.slice(0, 20).join(", ")}. Start the review again with the right one.`),
    );
  }

  const mergeBase =
    pinned ??
    (await gitMaybe(worktree, ["merge-base", resolved, "HEAD"])) ??
    (await gitMaybe(worktree, ["rev-parse", resolved])) ??
    resolved;

  // --submodule=diff expands a gitlink bump into the submodule's own diff. Without
  // it a two-line pointer change can hide thousands of lines, and the reviewer
  // would call it low-risk having never seen it (D-36).
  //
  // lore-ok[032c44ea]: `-c core.quotePath=false` ON EVERY CALL BELOW, same reasoning as
  // `wholeTreeDiff`'s `noQuote` (`lore-ok[01d5371d]`) — found by lore's own review: this
  // function, `wholeTreeDiff`'s older sibling, never got the D-130 quoting fix ported
  // back to it. Verified directly: `git ls-files --others` under this process's default
  // `core.quotePath` (unset, so true) prints an untracked `café.txt` as the C-quoted
  // `"caf\303\251.txt"` — the literal string, quote marks and octal escapes included,
  // that would have reached `untracked`/`changedFiles` here. The flag alone does not
  // cover a control character, backslash or literal quote, which git quotes
  // unconditionally regardless of it — `unquoteGitPath` below is the same decoder
  // `wholeTreeDiff` and `filesInDiff` already use for exactly that gap.
  const noQuote = ["-c", "core.quotePath=false"];
  const { stdout: rawPatch } = await git(worktree, [
    ...noQuote,
    "diff",
    "--submodule=diff",
    "--no-color",
    mergeBase,
  ]);
  const { stdout: stat } = await git(worktree, [...noQuote, "diff", "--stat", "--submodule=short", mergeBase]);

  const untracked = (await gitLines(worktree, [...noQuote, "ls-files", "--others", "--exclude-standard"])).map(
    (line) => unquoteGitPath(line),
  );
  const changedFilesFrom = (await gitLines(worktree, [...noQuote, "diff", "--name-only", mergeBase])).map((line) =>
    unquoteGitPath(line),
  );
  // UNIONED WITH filesInDiff(rawPatch), NOT SWAPPED — found by lore's own review: the
  // exact gap wholeTreeDiff was already fixed for (its own changedFiles is parsed from
  // the patch, not --name-only, specifically for this). `--name-only` lists a
  // submodule bump as its bare gitlink name only, never the files inside it, even
  // though `--submodule=diff` expands the inner content into the patch itself —
  // verified directly: `--name-only` on a real submodule bump prints just the gitlink
  // path while the same diff's patch carries the expanded inner file. Swapping
  // OUTRIGHT to filesInDiff alone would have cost every DELETED file: it only matches
  // `+++ b/<path>`, and a deletion's new side is `/dev/null`, which wholeTreeDiff never
  // needs to worry about (everything there is an addition, diffed against nothing).
  // computeDiff's diffs are real, so deletions are the common case the union keeps.
  const changedFiles = [...new Set([...changedFilesFrom, ...filesInDiff(rawPatch)])];
  // ZERO WHEN `into` IS GONE, not a crash. A review whose base ref was deleted under it
  // is not behind anything knowable, and `gitMaybe` already answers `undefined` for a ref
  // that will not resolve — but saying so explicitly is what stops the three staleness
  // questions below being read as "measured and fine" when they were never asked.
  const behindBy = intoExists
    ? Number((await gitMaybe(worktree, ["rev-list", "--count", `HEAD..${resolved}`])) ?? "0")
    : 0;

  // Everything below is deterministic, costs milliseconds, and answers a question
  // the model would otherwise have to infer from the diff alone — which is where
  // its inferences have been wrong.
  const commits = (await gitLines(worktree, ["log", "--format=%h %s", `${mergeBase}..HEAD`])).filter(
    (l) => l.length > 0,
  );

  // In memory; writes no tree, touches no ref, leaves no state.
  //
  // The exit code carries the answer and `gitMaybe` would destroy it: merge-tree
  // exits 0 for a clean merge and 1 for CONFLICTS, so swallowing non-zero as "could
  // not run" turns the very case we are asking about into "unknown". Anything above
  // 1 is a real failure — an old git, a bad ref — and stays unknown, because
  // "probably fine" is the claim this project exists to refuse.
  const mergesClean = intoExists ? await mergeCheck(worktree, resolved) : undefined;

  // OVERLAP IS MEASURED FROM THE LIVE MERGE-BASE, NEVER FROM THE PIN.
  //
  // The question is "which files did BOTH sides touch since they diverged", and with the
  // pinned base it degenerates exactly where D-113 matters most: once `into` contains this
  // branch, `diff(pin, into)` includes the branch's OWN change-set, so every file the
  // branch touched is reported as changed by both sides — each annotated with the branch's
  // own commits — and the reviewer prompt sends a deep tier hunting for conflicts between
  // the branch and its own merged work, every round, at deep-tier cost.
  //
  // D-113's rule as written: the pin decides what is MEASURED; `mergesClean`, `behindBy`
  // and this ask about `into` as it stands now. The docstring and SPEC both said so while
  // this line quietly did the opposite.
  const liveBase = intoExists ? await gitMaybe(worktree, ["merge-base", resolved, "HEAD"]) : undefined;
  // lore-ok[56b4abef]: `noQuote` + `unquoteGitPath` here too — found by lore's own review:
  // the quoting fix decoded `changedFilesFrom` but left this side of the SAME comparison
  // raw. Before that fix, both sides were consistently quoted and `.has()` matched by
  // coincidence; after it, a non-ASCII/tab/backslash/quote name touched by both sides
  // would decode on one side only, the lookup would fail, and the overlap this field
  // exists to flag would go silently missing for exactly the names the original fix was
  // about.
  const baseTouched = new Set(
    liveBase === undefined
      ? []
      : (await gitLines(worktree, [...noQuote, "diff", "--name-only", liveBase, resolved])).map((line) =>
          unquoteGitPath(line),
        ),
  );
  const overlapFiles = changedFilesFrom.filter((f) => baseTouched.has(f));

  // Capped: a monorepo can overlap in dozens of files, and this is read by a model
  // whose context is the budget. The cut is announced where it is rendered.
  const overlap: OverlapFile[] = [];
  for (const file of overlapFiles.slice(0, MAX_OVERLAP)) {
    const baseCommits = (
      liveBase === undefined
        ? []
        : await gitLines(worktree, ["log", "--format=%h %s", `${liveBase}..${resolved}`, "--", file])
    )
      .filter((l) => l.length > 0)
      .slice(0, MAX_COMMITS_PER_FILE);
    overlap.push({ file, baseCommits });
  }

  // A branch that changes source and no tests is a question worth asking every time,
  // and one a reviewer should never have to derive from a file list that may be cut.
  // Counted from `changedFiles` (the union), not `changedFilesFrom` alone, so a test
  // file changed only INSIDE a submodule is not invisible to this count either.
  const isTest = (f: string) => /(\.test\.|\.spec\.|(^|\/)tests?\/|__tests__)/.test(f);
  const changedTests = changedFiles.filter(isTest).length;

  const truncated = rawPatch.length > MAX_DIFF_CHARS;
  const patch = truncated
    ? `${rawPatch.slice(0, MAX_DIFF_CHARS)}\n\n[DIFF TRUNCATED at ${MAX_DIFF_CHARS} of ${rawPatch.length} characters — read the rest from the worktree directly. If this is unexpectedly large, the base ref is probably wrong.]`
    : rawPatch;

  return {
    base,
    mergeBase,
    behindBy: Number.isFinite(behindBy) ? behindBy : 0,
    commits,
    mergesClean,
    overlap,
    changedTests,
    changedSource: changedFiles.length - changedTests,
    stat: stat.trim(),
    patch,
    truncated,
    submoduleExpansionFailed: submodulesThatFailedToExpand(rawPatch),
    totalChars: rawPatch.length,
    untracked,
    changedFiles: [...changedFiles, ...untracked],
  };
}

/**
 * A review with no base: everything at `path` (or the whole worktree, for `"."`),
 * shown as a diff against nothing (D-130).
 *
 * Deliberately a SIBLING of `computeDiff`, not a branch inside it. `computeDiff` is
 * dense with incidents about resolving a real `into` — merge-base, `behindBy`,
 * `mergesClean`, overlap since divergence — none of which has an answer without one.
 * Threading a fake base through that function risks exactly the kind of edge case its
 * own comments document lore having been burned by before. This produces the same
 * `ReviewDiff` shape by a shorter, separate path instead: `git diff <EMPTY_TREE>`
 * against a single ref diffs against the WORKING TREE (INV-3, same as `computeDiff`),
 * so uncommitted work in the review worktree is included here exactly as it is there.
 *
 * Branch-only facts get honest empty values rather than invented ones: there is no
 * base to be behind, no commit list, nothing to check a merge against.
 */
export async function wholeTreeDiff(worktree: string, path: string): Promise<ReviewDiff> {
  const scope = path === "." ? [] : ["--", path];
  // lore-ok[01d5371d]: `-c core.quotePath=false` ON EVERY CALL BELOW closes the
  // common case — found by lore's own review of D-130: git C-style-quotes a path
  // needing it, which by default is any non-ASCII name (`+++
  // "b/src/caf\303\251.ts"`, verified directly), and this flag asks git for the
  // real bytes instead, for the patch and for `ls-files` (`untracked` would have
  // the identical failure for a non-ASCII name). It does NOT close a control
  // character, backslash or literal quote in a name — git quotes those
  // unconditionally — which is why `filesInDiff` (`git/diff.ts`) also decodes
  // git's quoting itself (`unquoteGitPath`) rather than relying on this flag alone.
  const noQuote = ["-c", "core.quotePath=false"];

  const { stdout: rawPatch } = await git(worktree, [...noQuote, "diff", "--submodule=diff", "--no-color", EMPTY_TREE, ...scope]);
  const { stdout: stat } = await git(worktree, [...noQuote, "diff", "--stat", "--submodule=short", EMPTY_TREE, ...scope]);

  // lore-ok[ec79f1c2]: `ls-files` C-quotes a control character, backslash or literal
  // quote in a filename unconditionally too — the same rule `filesInDiff` decodes
  // for the patch, found by lore's own review at that site and applying here by the
  // identical mechanism, not yet wired in. Each line un-quoted individually, since
  // `ls-files --others` output is one raw (possibly quoted) path per line, not a
  // diff this repo already has a block-level parser for.
  const untracked = (await gitLines(worktree, [...noQuote, "ls-files", "--others", "--exclude-standard", ...scope])).map(
    (line) => unquoteGitPath(line),
  );
  // PARSED FROM THE PATCH, not a separate `--name-only` call — found by lore's own
  // review: `--name-only` lists a submodule as its gitlink name only ("inner"), never
  // the files inside it, even with `--submodule=diff` — verified directly, a real git
  // submodule fixture prints only "inner" from `--name-only` while the patch itself
  // (same flag) expands to `inner/deep.txt`. This project's own submodule workflow
  // (D-36, spec/review-ladder.md §6.1) makes that a real gap, not a hypothetical one: a
  // pattern-engine hit inside a submodule would read `diff.changedFiles` as not
  // containing it, be marked `preexisting` (D-68) and demoted — in a full read, where
  // "outside the diff" should be nearly meaningless, silently burying a first-class
  // finding as inherited repository debt.
  const changedFiles = filesInDiff(rawPatch);

  const isTest = (f: string) => /(\.test\.|\.spec\.|(^|\/)tests?\/|__tests__)/.test(f);
  const changedTests = changedFiles.filter(isTest).length;

  const truncated = rawPatch.length > MAX_DIFF_CHARS;
  const patch = truncated
    ? `${rawPatch.slice(0, MAX_DIFF_CHARS)}\n\n[DIFF TRUNCATED at ${MAX_DIFF_CHARS} of ${rawPatch.length} characters — read the rest from the worktree directly.]`
    : rawPatch;

  return {
    base: EMPTY_TREE,
    mergeBase: EMPTY_TREE,
    scopePath: path,
    behindBy: 0,
    commits: [],
    mergesClean: undefined,
    overlap: [],
    changedTests,
    changedSource: changedFiles.length - changedTests,
    stat: stat.trim(),
    patch,
    truncated,
    submoduleExpansionFailed: submodulesThatFailedToExpand(rawPatch),
    totalChars: rawPatch.length,
    untracked,
    changedFiles: [...changedFiles, ...untracked],
  };
}

/**
 * Reverses git's C-style path quoting (`quote.c`'s `quote_c_style`).
 *
 * `wholeTreeDiff` passes `-c core.quotePath=false`, which stops IT from ever
 * producing octal-escaped non-ASCII names — but `filesInDiff` is also used on a
 * CLIENT-SUPPLIED diff (`review_submit`), generated under whatever config the
 * client's own git has, which is `core.quotePath=true` by default. Found by lore's
 * own review of D-130: a first version of this decoded one `\NNN` escape to one
 * JS code UNIT via `fromCharCode`, correct only for a single-byte escape — but
 * git's octal escapes are raw BYTES, and a non-ASCII character is a run of SEVERAL
 * of them (`café.ts` as `\303\251` is two bytes forming one UTF-8 codepoint, not
 * two characters). Decoding byte-by-byte with `fromCharCode` produced mojibake
 * ("Ã©") instead of the real name. This collects raw BYTES instead — a plain ASCII
 * character contributes its own byte, `\t`/`\n`/etc. contribute their mnemonic's
 * byte, `\NNN` contributes exactly the byte git wrote — and decodes the WHOLE
 * sequence as UTF-8 once at the end, which reassembles a multi-byte escape run
 * correctly the same way the bytes were always meant to be read together.
 */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const MNEMONIC: Record<string, number> = { a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b };
  const bytes: number[] = [];
  const inner = raw.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] ?? "";
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = inner[++i] ?? "";
    if (next in MNEMONIC) {
      bytes.push(MNEMONIC[next] as number);
    } else if (next === "\\" || next === '"') {
      bytes.push(next.charCodeAt(0));
    } else if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(next + inner.slice(i + 1, i + 3), 8));
      i += 2;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Files a unified diff touches, parsed from the diff TEXT rather than a separate
 * `--name-only` call.
 *
 * Moved here from `reviewer/review.ts` (D-130): `wholeTreeDiff` needed it for the
 * reason below, and a git-diff-text parser belongs beside the code that produces
 * git diff text, not one layer up in the reviewer that consumes it.
 *
 * `+++ b/<path>` is the post-image name, which is the one that exists in the worktree
 * after the patch applies — quoted or not (`unquoteGitPath`); `/dev/null` is a
 * deletion and has no marker to find, fine for `wholeTreeDiff`, which never has
 * one (everything is added, against nothing), and pre-existing behaviour
 * everywhere else this was already used.
 */
export function filesInDiff(diff: string): readonly string[] {
  const out: string[] = [];
  for (const m of diff.matchAll(/^\+\+\+ (.+)$/gm)) {
    const path = unquoteGitPath((m[1] ?? "").trim());
    if (path.startsWith("b/") && path.length > 2) out.push(path.slice(2));
  }
  return out;
}

/**
 * Every file a diff MENTIONS, including one it deletes — unlike `filesInDiff`, which
 * excludes a deletion by design (no marker left to scan in a file that no longer
 * exists, correct for every existing caller). Found by lore's own review, fingerprint
 * 23c8b393: `review_submit`'s `fixed_elsewhere` reused `filesInDiff` to check a claim's
 * `file` was part of the submission, and a claim naming a file the fix DELETED — often
 * the strongest evidence there is, "I removed the whole buggy module" — was refused as
 * "not part of this submission". A separate function rather than a flag on
 * `filesInDiff`: the two callers want genuinely different things (files worth reading
 * for a marker vs. files this diff is evidence about), not one behaviour with an
 * exception.
 */
export function filesTouchedByDiff(diff: string): readonly string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^\+\+\+ (.+)$/gm)) {
    const path = unquoteGitPath((m[1] ?? "").trim());
    if (path.startsWith("b/") && path.length > 2) out.add(path.slice(2));
  }
  for (const m of diff.matchAll(/^--- (.+)$/gm)) {
    const path = unquoteGitPath((m[1] ?? "").trim());
    if (path.startsWith("a/") && path.length > 2) out.add(path.slice(2));
  }
  return [...out];
}

/** git blob sha of a working-tree file — the coarse half of a verdict's scope. */
export async function blobSha(worktree: string, path: string): Promise<string | undefined> {
  return gitMaybe(worktree, ["hash-object", "--", path]);
}

/**
 * A file's content and blob sha AS OF A SPECIFIC COMMIT — never the working tree.
 *
 * For `ingestDocs` reading a rule document from `into` rather than the branch under
 * review (`lore-ok[53969ab8]`, `knowledge/ingest.ts`): a branch's own edit to its own
 * CLAUDE.md must not become a team decision the same review trusts while judging that
 * branch's code (D-10's principle, unguarded for ingested rules — nothing plays the
 * role `knowledge_teach`'s appeal ceremony plays for taught policies). `undefined`
 * for a path that does not exist at `ref` — a document the branch added is not yet a
 * team decision either, and one it deleted is `ingestDocs`'s own separate concern
 * (`lore-ok[a2f4d4f9]`), not this function's.
 *
 * `ref` must already be a resolved commit (`resolveInto`, above) — never a client
 * string reaching `git` unvalidated (D-61). `path` is `ref:path`, one argv element,
 * because that is the only syntax `git show`/`git rev-parse` give a blob at a ref;
 * it is never client-supplied either, always one of `discoverable`'s own file walk.
 */
export async function readAtRef(
  worktree: string,
  ref: string,
  path: string,
): Promise<{ readonly content: string; readonly blob: string } | undefined> {
  const at = `${ref}:${path}`;
  const content = await gitMaybe(worktree, ["show", at]);
  if (content === undefined) return undefined;
  const blob = await gitMaybe(worktree, ["rev-parse", "--verify", "--quiet", at]);
  return blob === undefined ? undefined : { content, blob };
}

/**
 * Render the diff for a prompt, with everything the reviewer must not assume away.
 *
 * The untracked list and the truncation notice are part of the prompt rather than
 * metadata, because a reviewer that never sees them cannot account for them.
 */
/**
 * Does the branch still merge into the base as it now stands?
 *
 * `undefined` means genuinely unknown and must never be rendered as safe.
 */
async function mergeCheck(worktree: string, base: string): Promise<boolean | undefined> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      "git",
      ["merge-tree", "--write-tree", base, "HEAD"],
      {
        cwd: worktree,
        maxBuffer: 64 * 1024 * 1024,
        // The same bound every other git call gets. Raw `execFile` is used here only
        // to read merge-tree's exit code, which the wrapper discards — the timeout is
        // not part of what needed bypassing, and without it a hung git holds the
        // round open with nothing to say.
        timeout: 120_000,
        env: { ...process.env, GIT_CEILING_DIRECTORIES: worktree },
      },
      (err) => {
        if (err === null) return resolve(true);
        const code = (err as unknown as { code?: number }).code;
        resolve(code === 1 ? false : undefined);
      },
    );
  });
}

export function renderDiff(d: ReviewDiff): string {
  if (d.scopePath !== undefined) return renderFolderDiff(d, d.scopePath);
  // Spelled out, because naming the base was not enough. A reviewer given
  // `Base: main (merge-base abc123)` went and ran `git diff main..HEAD` itself,
  // got the two-dot picture, and reported at high severity that the branch had
  // bundled a 70-file refactor from an unrelated ticket. The branch was one commit
  // and twenty files; the base had moved 22 commits ahead, and two dots render that
  // as the branch deleting everything the base gained. The alarm was right and the
  // diagnosis was invented — so the true fact is stated here instead.
  const parts = [
    `Base: ${d.base}, at merge-base ${d.mergeBase}.`,
    "",
    "THIS DIFF IS THE CHANGE THE BRANCH INTRODUCES — three-dot, exactly what a squash",
    `merge would apply. Reproduce it with:  git diff ${d.mergeBase}`,
    "",
    "Do NOT recompute it as `git diff <base>..HEAD`. Two dots is a CHECKOUT difference,",
    "not this branch's work: every commit the base gained since the fork shows up as this",
    "branch deleting things it never touched. In this worktree it is doubly misleading —",
    "local branch refs come from a mirror and are frozen at clone time.",
    // Everything below is computed, not inferred. A reviewer asked to derive these
    // from the diff alone has got them wrong: told only "Base: main", one reported a
    // one-commit branch as having bundled a seventy-file refactor from another
    // ticket. Facts a command can answer are answered by the command.
    "",
    d.changedSource > 0 && d.changedTests === 0
      ? `${d.changedSource} source file(s) changed and NO test file changed. Ask whether that is right.`
      : `${d.changedSource} source file(s) and ${d.changedTests} test file(s) changed.`,
    "",
    `THIS BRANCH IS ${d.commits.length} COMMIT(S):`,
    ...(d.commits.length > 0 ? d.commits.map((c) => `  ${c}`) : ["  (none — the branch is at the fork point)"]),
    ...(d.behindBy > 0
      ? [
          "",
          `THE BASE HAS MOVED ${d.behindBy} COMMIT(S) AHEAD.`,
          d.mergesClean === undefined
            ? "  Whether it still merges could not be determined — treat that as unknown, not as fine."
            : d.mergesClean
              ? "  It still merges cleanly into the base as it now stands (checked in memory, nothing written)."
              : "  IT NO LONGER MERGES CLEANLY into the base as it now stands.",
          ...(d.overlap.length > 0
            ? [
                `  ${d.overlap.length} file(s) changed by BOTH this branch and the base since they diverged,`,
                "  with what the BASE did to each — read the branch's version against these:",
                ...d.overlap.flatMap((o) => [
                  `    ${o.file}`,
                  ...(o.baseCommits.length > 0
                    ? o.baseCommits.map((c) => `        base: ${c}`)
                    : ["        base: (no commit touches it directly — check a rename or a move)"]),
                ]),
                "  A clean textual merge is not a working one: a branch calling a helper the base has since",
                "  deleted conflicts with nothing. If one of those base commits removed or renamed something",
                "  this branch still uses, that is a finding and the diff above cannot show it.",
              ]
            : ["  No file was touched by both sides, so the overlap risk is low."]),
          "",
          "  The diff above is correct, but it was computed at the fork point: nothing here has been",
          "  checked against the base as it now stands.",
        ]
      : []),
    "",
    d.stat,
  ];

  appendTail(parts, d);
  return parts.join("\n");
}

/**
 * The untracked list, the truncation notice, and the patch itself — identical in
 * both diff shapes (branch-vs-`into`, and D-130's whole-tree read), so it is written
 * once rather than kept in sync between them by hand.
 */
function appendTail(parts: string[], d: ReviewDiff): void {
  if (d.untracked.length > 0) {
    parts.push(
      "",
      `UNTRACKED — ${d.untracked.length} file(s) not in the diff below, contents not shown:`,
      ...d.untracked.map((f) => `  ${f}`),
    );
  }
  if (d.truncated) {
    parts.push(
      "",
      `WARNING: the diff is ${d.totalChars} characters and was cut to ${MAX_DIFF_CHARS}.`,
      "You have NOT seen the whole change. Read the rest from the worktree before concluding anything.",
    );
  }
  if (d.submoduleExpansionFailed.length > 0) {
    parts.push(
      "",
      `WARNING: ${d.submoduleExpansionFailed.length} submodule(s) changed but could not be expanded — ` +
        `this worktree does not have their objects (usually a private remote lore's container has no ` +
        `credentials for, D-65): ${d.submoduleExpansionFailed.join(", ")}.`,
      "The lines below for these are a bare gitlink pointer change, NOT their inner diff. Do not call this " +
        "low-risk from what you can see here — the real change inside these submodules is unread.",
    );
  }

  parts.push("", "--- DIFF ---", d.patch);
}

/**
 * D-130: a full read of `path`, not a diff against a prior version.
 *
 * The branch-mode framing above ("THIS DIFF IS THE CHANGE THE BRANCH INTRODUCES",
 * a commit list, a fork point) is actively wrong here — there is no prior version,
 * no commits, no fork point, and telling a model there is invites it to treat a
 * stable, unremarkable folder as a suspicious zero-history branch. Every line in
 * the patch below is shown as added because that is how a whole tree renders as a
 * diff against nothing, not because any of it is new.
 */
function renderFolderDiff(d: ReviewDiff, path: string): string {
  // lore-ok[d1831d70]: fixed here, same round it was raised — NOT `.toUpperCase()`
  // on the whole sentence, which included the interpolated path, so `src/PayRoll`
  // printed as `SRC/PAYROLL` in the one sentence whose job is telling a tier what to
  // actually read or re-read (see continuedPrompt's "re-read the files you care
  // about at the path"). Emphasis is static caps around the path, not a transform
  // applied to it. Verified directly: whole-tree-diff.test.ts's "names the scoped
  // path in the header, in its real case".
  const where = path === "." ? "THE WHOLE WORKTREE" : `\`${path}\``;
  const parts = [
    `THIS IS A FULL READ OF ${where} — NOT A DIFF AGAINST A PRIOR VERSION.`,
    "",
    "There is no earlier tree to compare against, no base, no commit history for this review to reason",
    "about. Every line in the patch below is shown as added because that is how a complete tree renders",
    "as a diff, not because any of it is new or recently written. Judge it as the code that exists, not",
    "as a change someone just made.",
    "",
    d.changedSource > 0 && d.changedTests === 0
      ? `${d.changedSource} source file(s), and NO test file. Ask whether that is right.`
      : `${d.changedSource} source file(s) and ${d.changedTests} test file(s).`,
    "",
    d.stat,
  ];
  appendTail(parts, d);
  return parts.join("\n");
}
