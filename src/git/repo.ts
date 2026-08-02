/**
 * Repository handling: a bare clone per repo, a worktree per review.
 *
 * Worktrees are what let reviews run in parallel against one repo without a lock.
 * The predecessor held a global flock for a whole run; a leaked fd once let a
 * daemon hold it for its entire life, and runs queued behind an orphan for ten
 * hours in silence (INV-5).
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DidNotRun } from "../core/errors.ts";
import { git, gitMaybe } from "./exec.ts";

export interface RepoPaths {
  /** Bare clone, shared by every review of this repo. */
  readonly bare: string;
  /** Per-review worktrees. */
  readonly worktrees: string;
}

export function repoPaths(root: string, repoId: string): RepoPaths {
  return { bare: join(root, repoId, "bare.git"), worktrees: join(root, repoId, "wt") };
}

/**
 * Clone if absent, fetch if present.
 *
 * `--recurse-submodules` because a submodule pointer bump is two lines of diff
 * that can carry thousands, and a reviewer shown only the outer diff would
 * confidently call it low-risk having never seen it (D-36).
 */
export async function ensureBare(paths: RepoPaths, gitUrl: string): Promise<void> {
  await mkdir(paths.bare, { recursive: true });
  const isRepo = await gitMaybe(paths.bare, ["rev-parse", "--git-dir"]);
  if (isRepo === undefined) {
    await git(paths.bare, ["clone", "--bare", "--recurse-submodules", gitUrl, "."], 600_000);
    await git(paths.bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  }
  // Always fetch. `git fetch` moves only remote-tracking refs, never local ones —
  // which is how a local `main` once sat 57 commits behind while every session was
  // fetching constantly, turning a one-file branch into a 496-file diff (INV-2).
  await git(paths.bare, ["fetch", "--prune", "--tags", "origin"], 600_000);
}

/**
 * Resolve the base ref, preferring the remote-tracking form.
 *
 * `origin/main` is what CI and the merge will actually compare against, and it
 * needs no local discipline to be correct. A local ref of the same name only
 * happens to be right (INV-2).
 */
export async function resolveBase(gitDir: string, intoRef: string): Promise<string> {
  const candidates = [`origin/${intoRef}`, `refs/remotes/origin/${intoRef}`, intoRef];
  for (const c of candidates) {
    const sha = await gitMaybe(gitDir, ["rev-parse", "--verify", "--quiet", `${c}^{commit}`]);
    if (sha !== undefined && sha.length > 0) return c;
  }
  throw new DidNotRun(`cannot resolve base ref '${intoRef}' — tried ${candidates.join(", ")}`);
}

/** Create a detached worktree at the branch tip. Removed when the review ends. */
export async function addWorktree(paths: RepoPaths, reviewId: string, branch: string): Promise<string> {
  const dir = join(paths.worktrees, reviewId);
  await mkdir(paths.worktrees, { recursive: true });
  const ref = (await gitMaybe(paths.bare, ["rev-parse", "--verify", "--quiet", `origin/${branch}^{commit}`]))
    ?? (await gitMaybe(paths.bare, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]));
  if (ref === undefined) throw new DidNotRun(`branch '${branch}' not found on origin`);
  await git(paths.bare, ["worktree", "add", "--detach", dir, ref], 300_000);
  await git(dir, ["submodule", "update", "--init", "--recursive"], 600_000).catch(() => {
    // Submodules that cannot be initialised are announced by the diff layer rather
    // than failing the review — but they are never silently treated as absent.
  });
  return dir;
}

export async function removeWorktree(paths: RepoPaths, reviewId: string): Promise<void> {
  const dir = join(paths.worktrees, reviewId);
  await git(paths.bare, ["worktree", "remove", "--force", dir]).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}

/**
 * A content hash of the worktree as it stands, including uncommitted and untracked
 * work.
 *
 * The client sends its own hash with each submitted diff and this must match
 * (D-40). Without it, a partial or fuzzy apply leaves us reviewing a tree that
 * exists nowhere — not in git, not on the client's disk — and reporting on it with
 * full confidence.
 *
 * Mutates the worktree's index, which is safe because the index belongs to this
 * review alone.
 */
export async function treeHash(worktree: string): Promise<string> {
  await git(worktree, ["add", "-A"]);
  const { stdout } = await git(worktree, ["write-tree"]);
  return stdout.trim();
}

/** Apply a unified diff without committing. The client keeps its own history. */
export async function applyPatch(worktree: string, patch: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "git",
      ["apply", "--whitespace=nowarn", "-"],
      { cwd: worktree, maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new DidNotRun(`patch did not apply cleanly: ${String(stderr).trim().slice(0, 500)}`, err));
          return;
        }
        resolve();
      },
    );
    child.stdin?.end(patch);
  });
}
