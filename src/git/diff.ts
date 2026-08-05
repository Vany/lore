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
export const MAX_DIFF_CHARS = 600_000;

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
  const changedFiles = await gitLines(worktree, ["diff", "--name-only", mergeBase]);
  const behindBy = Number(
    (await gitMaybe(worktree, ["rev-list", "--count", `HEAD..${resolved}`])) ?? "0",
  );

  const truncated = rawPatch.length > MAX_DIFF_CHARS;
  const patch = truncated
    ? `${rawPatch.slice(0, MAX_DIFF_CHARS)}\n\n[DIFF TRUNCATED at ${MAX_DIFF_CHARS} of ${rawPatch.length} characters — read the rest from the worktree directly. If this is unexpectedly large, the base ref is probably wrong.]`
    : rawPatch;

  return {
    base,
    mergeBase,
    behindBy: Number.isFinite(behindBy) ? behindBy : 0,
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
    ...(d.behindBy > 0
      ? [
          "",
          `THE BRANCH IS ${d.behindBy} COMMIT(S) BEHIND ${d.base}. That is worth a finding on its own if it`,
          "is large: the diff above is correct, but it was computed against the fork point, so it cannot",
          "show a conflict with work the base has gained since. Nothing here has been tested against the",
          "base as it now stands.",
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
