/**
 * Repository handling: a bare clone per repo, a worktree per review.
 *
 * Worktrees are what let reviews run in parallel against one repo without a lock.
 * The predecessor held a global flock for a whole run; a leaked fd once let a
 * daemon hold it for its entire life, and runs queued behind an orphan for ten
 * hours in silence (INV-5).
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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
/**
 * Does this url authenticate over ssh?
 *
 * `git@host:path` and `ssh://…` do. A local path, `https://` and `git://` do not,
 * and handing them an identity is describing a transport that will not be used.
 */
export function usesSsh(gitUrl: string): boolean {
  if (gitUrl.startsWith("ssh://")) return true;
  if (/^[a-z+]+:\/\//i.test(gitUrl)) return false;
  const colon = gitUrl.indexOf(":");
  const slash = gitUrl.indexOf("/");
  return colon >= 0 && (slash < 0 || colon < slash);
}

/**
 * Tell git which key to authenticate with, and only that key.
 *
 * The deploy key was generated at provisioning and then used by nothing: no
 * `GIT_SSH_COMMAND`, no `core.sshCommand`, no identity anywhere. Every ssh remote
 * therefore failed to clone, silently enough that it went unnoticed while the two
 * repositories that did work were a PUBLIC https url and a local path — so the
 * documented workflow, `make new` then install the deploy key then review a private
 * repository, had never once run end to end (D-62).
 *
 * `IdentitiesOnly=yes` matters as much as `-i`: without it ssh also offers whatever
 * the agent holds, which on a developer machine means authenticating as the person
 * rather than as the read-only deploy key, and a service that can push while
 * believing it cannot.
 *
 * `accept-new` pins the host on first sight and refuses a CHANGE afterwards. Plain
 * `no` would accept a different host silently, which is the one thing host checking
 * exists to prevent.
 */
export function sshCommand(keyPath: string, knownHosts: string): string {
  return [
    "ssh",
    `-i ${keyPath}`,
    "-o IdentitiesOnly=yes",
    `-o UserKnownHostsFile=${knownHosts}`,
    "-o StrictHostKeyChecking=accept-new",
  ].join(" ");
}

export async function ensureBare(paths: RepoPaths, gitUrl: string, keyPath?: string): Promise<void> {
  // Gated on the URL, not merely on a key file existing.
  //
  // "Is there a key on disk" is the wrong question and the right-looking one: keys
  // are generated per repository and older ones exist for repositories that turned
  // out to be a local path or a public https url. Both would have had an ssh command
  // written into their config for a transport they never use — inert, and a false
  // statement in a config file, which is the same wrong-question mistake as asking
  // `rev-parse --git-dir` whether a directory is a repository (D-61).
  const key =
    usesSsh(gitUrl) && keyPath !== undefined && (await stat(keyPath).then(() => true).catch(() => false))
      ? keyPath
      : undefined;
  const env =
    key === undefined ? {} : { GIT_SSH_COMMAND: sshCommand(key, join(dirname(key), "known_hosts")) };

  await mkdir(paths.bare, { recursive: true });
  // Asks whether THIS directory is a repository, not whether one exists somewhere
  // above it. `rev-parse --git-dir` answered the second question: in the empty
  // directory `mkdir` had just created it happily reported the enclosing checkout,
  // so the clone below was skipped as already done and every later command operated
  // on the wrong repository (D-61). `--resolve-git-dir` asks about the path given.
  const isRepo = await gitMaybe(paths.bare, ["rev-parse", "--resolve-git-dir", "."]);
  if (isRepo === undefined) {
    await git(paths.bare, ["clone", "--bare", "--recurse-submodules", gitUrl, "."], 600_000, env);
    await git(paths.bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    // Persisted in the clone's own config, so every later fetch authenticates the
    // same way without the caller having to remember to pass it.
    if (key !== undefined) {
      await git(paths.bare, ["config", "core.sshCommand", sshCommand(key, join(dirname(key), "known_hosts"))]);
    }
  }
  // Always fetch. `git fetch` moves only remote-tracking refs, never local ones —
  // which is how a local `main` once sat 57 commits behind while every session was
  // fetching constantly, turning a one-file branch into a 496-file diff (INV-2).
  await git(paths.bare, ["fetch", "--prune", "--tags", "origin"], 600_000, env);
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
