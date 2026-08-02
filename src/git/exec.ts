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
