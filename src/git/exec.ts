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

export async function git(cwd: string, args: readonly string[], timeoutMs = 120_000): Promise<GitResult> {
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
      env: { ...process.env, GIT_CEILING_DIRECTORIES: cwd },
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
