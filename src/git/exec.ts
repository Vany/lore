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
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DidNotRun } from "../core/errors.ts";
import { dataDir } from "../core/paths.ts";

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
 * DELIVERED AS ENV, NOT AS `git config`, and not baked into the image: the data directory
 * is `LORE_DATA_DIR`, which compose sets to the HOST's path so both sides agree — a build
 * time `safe.directory` would name a path this deployment never uses. `GIT_CONFIG_*`
 * applies to the invocation, needs no writable HOME, and travels to every call site that
 * spawns git with this env rather than only the ones that read a config file.
 *
 * SCOPED TO WHAT LORE OWNS, and the first version was not. It said `safe.directory=*`, on
 * the stated ground that "every path it hands git is one it created itself" — which is
 * FALSE, as this change's own review proved at HIGH twice.
 *
 * `lore review --target <path>` takes a checkout from whoever runs it, and `treeHash`
 * opens with `git add -A` in that directory. So a blanket exemption did not merely let
 * lore READ a foreign repository: it let lore WRITE one it does not own — staging every
 * uncommitted change in somebody else's working tree — which D-2 forbids outright and
 * INV-9 forbids again. Worse, `add -A` runs that repository's own configured filters, and
 * executing code out of a repository you were induced to point at IS the attack git's
 * ownership check exists to stop. Disabling it globally handed that back on a shared
 * machine, in the one code path where lore writes.
 *
 * So the exemption covers `dataDir()` and nothing else — the tree lore creates, populates
 * and hands to itself. A CLI target outside it keeps git's check, which is the correct
 * answer there: if git will not touch a stranger's repository, neither should lore.
 *
 * The trailing `/*` is git's documented prefix form and is verified against the git in
 * this image (2.39.5) rather than assumed.
 */
function ownershipExemptionFor(cwd: string): Readonly<Record<string, string>> {
  const root = resolve(dataDir());
  const here = resolve(cwd);
  if (here !== root && !here.startsWith(root + sep)) return {};
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: root,
    GIT_CONFIG_KEY_1: "safe.directory",
    // Everything beneath it: a worktree's repository resolves to the bare clone, so
    // exempting only the directory git was pointed at would leave the bare refused.
    GIT_CONFIG_VALUE_1: `${root}/*`,
  };
}

/** The environment every git invocation in this service runs under. */
export function gitEnv(cwd: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    ...process.env,
    GIT_CEILING_DIRECTORIES: cwd,
    ...ownershipExemptionFor(cwd),
    ...extra,
  } as Record<string, string>;
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
