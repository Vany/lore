/**
 * Running git.
 *
 * One place, so every call gets the same treatment: argument arrays rather than
 * shell strings, a buffer large enough for real diffs, and failures that are loud.
 *
 * No shell, ever. Branch names and refs come from clients over MCP, and a shell
 * would make them executable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DidNotRun } from "../core/errors.ts";

const run = promisify(execFile);

/** A 3 MB diff is not unusual once submodules are expanded. */
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Git's ownership check cannot be allowed to decide whether a review runs.
 *
 * The data directory is a HOST BIND by design (D-60: the T0 sandbox asks the host daemon
 * to bind-mount a worktree by absolute path, so the path must mean the same thing on both
 * sides). On the host those files belong to the operator; in the container the process is
 * a different uid, and the two are reconciled by the file-sharing layer — not by anything
 * lore controls. When that reconciliation slips, git refuses the repository outright with
 * "detected dubious ownership", and every git call in the review path fails at once.
 *
 * Measured 2026-09-08 on `rigid-monorepo`. A client pushed and re-pinned; the round that
 * should have read the new tree died on `git worktree list --porcelain` before it began,
 * and a `t0` in the same window ran twelve minutes and ended `interrupted`. The same
 * command succeeded again minutes later, which is the difficult part: nothing lore can
 * observe separates a repository it must not touch from one whose uid mapping hiccuped.
 *
 * WHY DISABLING THE CHECK IS RIGHT HERE, rather than lax. It defends a SHARED machine —
 * another user planting a repository in a path you are about to run git in. lore runs
 * single-tenant and every path it hands git is one it created itself, under a data
 * directory compose mounts for it. There is no second user to defend against, and with
 * the check in place the service's availability rests on a uid mapping no part of this
 * system owns.
 *
 * DELIVERED AS ENV, NOT AS `git config`, and not baked into the image: the data directory
 * is `LORE_DATA_DIR`, which compose sets to the HOST's path so both sides agree — a build
 * time `safe.directory` would name a path this deployment never uses. `GIT_CONFIG_*`
 * applies to the invocation, needs no writable HOME, and travels to every call site that
 * spawns git with this env rather than only the ones that read a config file.
 */
const OWNERSHIP_CHECK_OFF: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "*",
};

/** The environment every git invocation in this service runs under. */
export function gitEnv(cwd: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { ...process.env, GIT_CEILING_DIRECTORIES: cwd, ...OWNERSHIP_CHECK_OFF, ...extra } as Record<string, string>;
}

export async function git(
  cwd: string,
  args: readonly string[],
  timeoutMs = 120_000,
  /** Extra environment, for the one thing git cannot be told on the command line. */
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", [...args], {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      encoding: "utf8",
      // GIT CANNOT CLIMB OUT OF `cwd` (D-61).
      //
      // Git's default is to walk UP from the working directory until it finds a
      // repository. So a command aimed at a directory that is not one silently
      // retargets at whatever encloses it — and lore's data directory sits inside a
      // checkout in every deployment run from one.
      //
      // Observed 2026-08-04, the first time a local path was reviewed: an empty
      // `bare.git` made `rev-parse --git-dir` report the ENCLOSING repository, so the
      // clone was skipped as unnecessary and `fetch --prune --tags origin` ran
      // against the operator's own working repository. It failed only because that
      // path happened to be mounted read-only. Anywhere writable it would have pruned
      // their refs and tags — lore writing to a user's repo, which D-2 forbids
      // outright and INV-9 forbids again.
      //
      // The ceiling is `cwd` itself, so discovery can find a repository AT `cwd` and
      // nowhere above it. Cheaper and more total than auditing every call site for
      // whether its target exists.
      env: gitEnv(cwd, extraEnv),
    });
    return { stdout, stderr };
  } catch (e) {
    const err = e as { stderr?: string; message?: string; killed?: boolean };
    const detail = (err.stderr ?? err.message ?? "unknown").trim().split("\n").slice(0, 5).join("\n");
    throw new DidNotRun(`git ${args.join(" ")} failed in ${cwd}: ${detail}`, e);
  }
}

/**
 * Run git where a non-zero exit is a legitimate answer rather than a failure —
 * `rev-parse --verify` on a ref that may not exist, for instance.
 *
 * Separate function on purpose: making failure silent by default is how a broken
 * command starts looking like an empty result.
 */
export async function gitMaybe(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await git(cwd, args);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function gitLines(cwd: string, args: readonly string[]): Promise<readonly string[]> {
  const { stdout } = await git(cwd, args);
  return stdout.split("\n").filter((l) => l.length > 0);
}
