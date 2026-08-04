/**
 * Repository handling: a bare clone per repo, a worktree per review.
 *
 * Worktrees are what let reviews run in parallel against one repo without a lock.
 * The predecessor held a global flock for a whole run; a leaked fd once let a
 * daemon hold it for its entire life, and runs queued behind an orphan for ten
 * hours in silence (INV-5).
 */

import { mkdir, rm, stat } from "node:fs/promises";
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
 * `isLocalPath` lived here and is gone (D-63). It existed so provisioning could skip
 * generating a deploy key for a local directory, and so the clone could be told
 * whether to authenticate. Neither caller survives: no key is generated for any url,
 * and `make mirror` clones local paths and remotes with the same command. A
 * classifier nobody branches on is a question a reader must answer for nothing.
 */

/**
 * How long ago the mirror was last fetched from ITS remote (D-63).
 *
 * `undefined` when the question does not apply: the path is not a git repository, or
 * it has no remote to be behind. A repository nobody fetches cannot be stale.
 *
 * Read from `FETCH_HEAD`'s mtime, which git rewrites on every fetch — including the
 * one inside `git pull`, so an operator working normally in the checkout keeps it
 * current without doing anything special.
 */
export async function mirrorFetchedAt(localPath: string): Promise<Date | undefined> {
  const hasRemote = await gitMaybe(localPath, ["config", "--get", "remote.origin.url"]);
  if (hasRemote === undefined) return undefined;
  for (const candidate of [join(localPath, ".git", "FETCH_HEAD"), join(localPath, "FETCH_HEAD")]) {
    const s = await stat(candidate).catch(() => undefined);
    if (s !== undefined) return s.mtime;
  }
  return undefined;
}

/**
 * How stale a mirror may be before lore refuses to review from it.
 *
 * Reviews are driven on demand: the client fetches its checkout and then asks for a
 * review, because lore holds no credentials for the remote and must not (D-62's
 * header, and the reason a personal key is never mounted). The weakness of on-demand
 * is that a client can simply forget — and a review of a stale tree is exactly the
 * failure INV-2 names, where a base 57 commits behind turned a one-file branch into
 * a 496-file diff.
 *
 * So forgetting is made loud rather than prevented. Thirty minutes is long enough to
 * survive a queue and a slow first round, and short enough that "nobody fetched this
 * today" cannot pass.
 */
export const MAX_MIRROR_AGE_MS = 30 * 60_000;

/**
 * The clone must be here already, and recent. lore never fetches it (D-63).
 *
 * `make mirror` clones and fetches on the HOST, where the operator's agent and
 * credentials live. That is the only thing that talks to a remote — which is why
 * lore needs no key, no agent, and no sight of any directory outside its own data
 * (D-62's header: a service holding a key holds everything that key opens).
 *
 * So this does not clone and does not fetch. It checks, and refuses loudly:
 *
 *   * **Missing** is not "clone it now", because there is nothing to clone with. It
 *     is an operator step that has not been taken, and saying so beats a git error
 *     about a host it cannot reach.
 *   * **Stale** is the failure on-demand refresh actually has — a client that forgot.
 *     Reviewing anyway describes a tree that is not the one being merged, which is
 *     INV-2's failure with an attestation over it.
 */
export async function ensureBare(paths: RepoPaths, gitUrl: string): Promise<void> {
  const isRepo = await gitMaybe(paths.bare, ["rev-parse", "--resolve-git-dir", "."]);
  if (isRepo === undefined) {
    throw new DidNotRun(
      `no clone of ${gitUrl} at ${paths.bare}. lore does not clone — it holds no credentials for your ` +
        `remotes by design. Run \`make mirror\` on the host and start the review again.`,
    );
  }

  const fetchedAt = await mirrorFetchedAt(paths.bare);
  if (fetchedAt === undefined) return; // no remote to be behind
  const age = Date.now() - fetchedAt.getTime();
  if (age > MAX_MIRROR_AGE_MS) {
    throw new DidNotRun(
      `the clone of ${gitUrl} was last fetched ${Math.round(age / 60_000)} minutes ago, and lore holds no ` +
        `credentials to fetch it itself. Run \`make mirror\` on the host and start the review again. ` +
        `Reviewing it as it stands would describe a tree that is not what you are merging.`,
    );
  }
}

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

/**
 * Apply a unified diff without committing. The client keeps its own history.
 *
 * Spawned here rather than through `git()` because the patch goes in on stdin, which
 * that wrapper has no way to pass — so this is the one call site the ceiling in D-61
 * did not reach, while SPEC said it applied to "every git invocation". Raised as
 * a88aa1e2 against the commit that introduced the claim. The env is set explicitly
 * below; a reviewer had to find it, which is the argument for the wrapper, not
 * against it.
 */
export async function applyPatch(worktree: string, patch: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "git",
      ["apply", "--whitespace=nowarn", "-"],
      {
        cwd: worktree,
        maxBuffer: 64 * 1024 * 1024,
        // The same ceiling every other invocation gets (D-61): a patch must never be
        // applied to a repository above the worktree it was meant for.
        env: { ...process.env, GIT_CEILING_DIRECTORIES: worktree },
      },
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
