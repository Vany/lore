/**
 * Running the target's test suite, in a container that holds nothing worth stealing.
 *
 * Greptile built an execution layer because running code finds what reading it
 * cannot. But `npm test` executes whatever the repo and its entire dependency tree
 * say, lifecycle scripts included — **the threat is not the teammate, it is the
 * dependency tree.**
 *
 * The service container holds every registered repo's deploy key and the knowledge
 * database. One malicious `postinstall` in there reads all of it at once. So this
 * runs somewhere else entirely: no secrets, no host access, resource limits, hard
 * timeout, destroyed after (D-24).
 *
 * The worktree goes in; findings come out; nothing else crosses.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../core/finding.ts";
import { runTool, type ToolResult } from "./exec.ts";

export interface SandboxConfig {
  /** Container image. Must be arm64 on the deployment host (D-33). */
  readonly image: string;
  /** Host directory holding per-lockfile `node_modules` caches (D-37). */
  readonly cacheRoot: string;
  /**
   * Where the throwaway per-review copy lives.
   *
   * Beside the repositories on purpose, so it is on the same shared volume the
   * containers already mount — the daemon resolves bind paths on the host, and a
   * scratch directory somewhere else would not exist there.
   */
  readonly scratchRoot: string;
  readonly memory: string;
  readonly cpus: string;
  readonly timeoutMs: number;
  /** `docker` or `podman`; both are installed on the dev machine. */
  readonly runtime: string;
}

export const DEFAULT_SANDBOX: SandboxConfig = {
  // Built by `make build`, not pulled: a bare node image ships no git, and a
  // suite that needs git does not refuse to run — it runs and fails for reasons
  // unrelated to the change, which T0 then reports as high-severity findings.
  // Measured on the deployment host: 10 of lore's own 180 tests failed without
  // git; all 180 pass with it.
  image: process.env["LORE_SANDBOX_IMAGE"] ?? "lore-sandbox:node24",
  // Under the data directory, and READ FROM THE ENVIRONMENT rather than hardcoded.
  //
  // These are bind-mounted into a sibling container by the HOST daemon, so the path
  // has to mean the same thing on both sides — a literal `/var/lib/lore` is only
  // correct on a deployment whose data directory happens to be there. Anywhere else
  // it is a path the lore container cannot even create (EACCES), and before that it
  // was a path the host silently mounted as empty.
  cacheRoot: `${process.env["LORE_DATA_DIR"] ?? "/var/lib/lore"}/npm-cache`,
  scratchRoot: `${process.env["LORE_DATA_DIR"] ?? "/var/lib/lore"}/scratch`,
  memory: "2g",
  cpus: "2",
  // A hung suite otherwise holds a review slot forever, and looks like a slow
  // review rather than a stuck one.
  timeoutMs: 15 * 60_000,
  runtime: "docker",
};

/** Cache key: identical lockfiles share an install. Installs dominate T0 otherwise. */
export async function lockfileKey(worktree: string): Promise<string> {
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
    const content = await readFile(join(worktree, name)).catch(() => undefined);
    if (content !== undefined) {
      return createHash("sha256").update(content).digest("hex").slice(0, 16);
    }
  }
  return "no-lockfile";
}

/**
 * Mounts shared by both phases.
 *
 * **The reviewed worktree goes in read-only, at `/src`, and the run happens in a
 * throwaway copy at `/work`.** Two reasons, and the first is not about security:
 *
 * 1. A test suite that writes — snapshots, coverage, build output, a lockfile
 *    npm decides to update — would otherwise mutate the tree under review. Those
 *    files land in the next round's diff and become findings about work nobody
 *    did. A review that invents its own defects is worse than one that misses some.
 * 2. The same read-only bind that opencode gets, for the same reason: a policy the
 *    model or the suite could route around becomes a property of the filesystem.
 *
 * `node_modules` is mounted over the copy from the shared cache, so the copy is
 * source only and installs are shared across reviews with the same lockfile.
 */
function baseArgs(cfg: SandboxConfig, worktree: string, cacheDir: string, scratch: string): string[] {
  return [
    "run",
    "--rm",
    // Nothing from the host beyond the sources, a scratch copy and the cache. In
    // particular: no deploy keys, no database, no tokens.
    "-v", `${worktree}:/src:ro`,
    "-v", `${scratch}:/work`,
    "-v", `${cacheDir}:/work/node_modules`,
    "-w", "/work",
    "--memory", cfg.memory,
    "--cpus", cfg.cpus,
    // Fork bombs are a denial of service against every other review on the box.
    "--pids-limit", "512",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "-e", "CI=1",
    "-e", "NO_COLOR=1",
  ];
}

/**
 * Refresh the scratch copy from the read-only sources.
 *
 * `-a` preserves modes and times so incremental typecheckers are not fooled into
 * rebuilding everything; the `node_modules` mount is left alone because it is the
 * shared cache, not part of the source.
 */
/**
 * Copy the sources into the writable scratch, and FAIL if it does not happen.
 *
 * This was `cp -a /src/. /work/ 2>/dev/null || true`, which swallowed the reason and
 * then reported success, so every later step ran against an empty `/work`. What the
 * operator saw was npm complaining there was no `package-lock.json` in a repository
 * that plainly has one — a true statement about a directory nobody meant to look at,
 * and a full diagnostic dead end.
 *
 * The emptiness check is the load-bearing half. `cp` legitimately exits 0 when the
 * source is empty, and an empty `/src` is exactly what a misconfigured sibling mount
 * produces (see `MOUNT_PATHS_MUST_MATCH` in deploy/docker-compose.yml): the host
 * daemon resolves the path on the HOST, and where it does not exist Docker creates an
 * empty directory rather than refusing.
 */
const SYNC =
  "cp -a /src/. /work/ || { echo 'sandbox: could not copy the sources into /work' >&2; exit 1; }; " +
  "[ -n \"$(ls -A /work 2>/dev/null)\" ] || " +
  "{ echo 'sandbox: /src is EMPTY. The host daemon mounts by HOST path, so this means the worktree path does not exist on the host — LORE_HOST_DATA and the container data dir must be the same path.' >&2; exit 1; }";

/**
 * Install dependencies.
 *
 * Network is on here because a registry install needs it — but no secret is
 * present, so a malicious lifecycle script has nothing to exfiltrate and nowhere
 * to reach on the host. Scripts are NOT disabled, because a repo whose native
 * modules never build would fail its tests for reasons that have nothing to do
 * with the change under review.
 */
export async function install(
  cfg: SandboxConfig,
  worktree: string,
  cacheDir: string,
  scratch: string,
): Promise<ToolResult> {
  return runTool(
    worktree,
    cfg.runtime,
    [
      ...baseArgs(cfg, worktree, cacheDir, scratch),
      cfg.image,
      "sh",
      "-lc",
      `${SYNC} && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund)`,
    ],
    cfg.timeoutMs,
  );
}

/**
 * Run the suite with **no network at all**.
 *
 * A test that reaches the internet is not a test of this change, and a dependency
 * that phones home during a test run is exactly what we are guarding against.
 */
export async function runTests(
  cfg: SandboxConfig,
  worktree: string,
  cacheDir: string,
  scratch: string,
): Promise<ToolResult> {
  return runTool(
    worktree,
    cfg.runtime,
    [
      ...baseArgs(cfg, worktree, cacheDir, scratch),
      "--network", "none",
      cfg.image,
      "sh",
      "-lc",
      // Re-synced because install may have rewritten a lockfile, and because the
      // suite must see exactly the sources under review — not whatever the install
      // phase left behind.
      `${SYNC} && npm test --silent`,
    ],
    cfg.timeoutMs,
  );
}

/**
 * Turn a failing suite into findings.
 *
 * Deliberately coarse: one finding for the suite, not one per assertion. The
 * models get the output and can be specific; T0's job here is to state the fact
 * that the suite fails, which no model should be paid to discover.
 */
export function testFindings(result: ToolResult): readonly Finding[] {
  if (result.ok) return [];

  const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-40).join("\n");
  return [
    {
      file: "package.json",
      severity: "high",
      claim: result.timedOut
        ? "the test suite did not finish within the time limit"
        : "the test suite fails on this branch",
      evidence: tail.slice(0, 2000),
      failureScenario: result.timedOut
        ? "a hang or an unbounded wait; the suite never reports, so nothing downstream can be trusted"
        : "the branch ships with failing tests, so any claim the tests make about it is void",
    },
  ];
}
