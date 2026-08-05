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
export const MAX_OVERLAP = 10;
const MAX_COMMITS_PER_FILE = 4;
const MAX_DIFF_CHARS = 600_000;

export interface ReviewDiff {
  readonly base: string;
  readonly mergeBase: string;
  readonly stat: string;
  readonly patch: string;
  readonly truncated: boolean;
  readonly totalChars: number;
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

export async function computeDiff(worktree: string, base: string): Promise<ReviewDiff> {
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
  const resolved = (await gitMaybe(worktree, ["rev-parse", "--verify", "--quiet", `origin/${base}^{commit}`]))
    ?? base;

  const mergeBase =
    (await gitMaybe(worktree, ["merge-base", resolved, "HEAD"])) ??
    (await gitMaybe(worktree, ["rev-parse", resolved])) ??
    resolved;

  // --submodule=diff expands a gitlink bump into the submodule's own diff. Without
  // it a two-line pointer change can hide thousands of lines, and the reviewer
  // would call it low-risk having never seen it (D-36).
  const { stdout: rawPatch } = await git(worktree, [
    "diff",
    "--submodule=diff",
    "--no-color",
    mergeBase,
  ]);
  const { stdout: stat } = await git(worktree, ["diff", "--stat", "--submodule=short", mergeBase]);

  const untracked = await gitLines(worktree, ["ls-files", "--others", "--exclude-standard"]);
  const changedFilesFrom = await gitLines(worktree, ["diff", "--name-only", mergeBase]);
  const changedFiles = changedFilesFrom;
  const behindBy = Number(
    (await gitMaybe(worktree, ["rev-list", "--count", `HEAD..${resolved}`])) ?? "0",
  );

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
  const mergesClean = await mergeCheck(worktree, resolved);

  const baseTouched = new Set(await gitLines(worktree, ["diff", "--name-only", mergeBase, resolved]));
  const overlapFiles = changedFilesFrom.filter((f) => baseTouched.has(f));

  // Capped: a monorepo can overlap in dozens of files, and this is read by a model
  // whose context is the budget. The cut is announced where it is rendered.
  const overlap: OverlapFile[] = [];
  for (const file of overlapFiles.slice(0, MAX_OVERLAP)) {
    const baseCommits = (
      await gitLines(worktree, ["log", "--format=%h %s", `${mergeBase}..${resolved}`, "--", file])
    )
      .filter((l) => l.length > 0)
      .slice(0, MAX_COMMITS_PER_FILE);
    overlap.push({ file, baseCommits });
  }

  // A branch that changes source and no tests is a question worth asking every time,
  // and one a reviewer should never have to derive from a file list that may be cut.
  const isTest = (f: string) => /(\.test\.|\.spec\.|(^|\/)tests?\/|__tests__)/.test(f);
  const changedTests = changedFilesFrom.filter(isTest).length;

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
    changedSource: changedFilesFrom.length - changedTests,
    stat: stat.trim(),
    patch,
    truncated,
    totalChars: rawPatch.length,
    untracked,
    changedFiles: [...changedFiles, ...untracked],
  };
}

/** git blob sha of a working-tree file — the coarse half of a verdict's scope. */
export async function blobSha(worktree: string, path: string): Promise<string | undefined> {
  return gitMaybe(worktree, ["hash-object", "--", path]);
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

  parts.push("", "--- DIFF ---", d.patch);
  return parts.join("\n");
}
