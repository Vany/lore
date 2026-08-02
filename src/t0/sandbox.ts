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
  readonly memory: string;
  readonly cpus: string;
  readonly timeoutMs: number;
  /** `docker` or `podman`; both are installed on the dev machine. */
  readonly runtime: string;
}

export const DEFAULT_SANDBOX: SandboxConfig = {
  image: "node:24-alpine",
  cacheRoot: "/var/lib/lore/npm-cache",
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

function baseArgs(cfg: SandboxConfig, worktree: string, cacheDir: string): string[] {
  return [
    "run",
    "--rm",
    // Nothing from the host beyond the worktree and a node_modules cache. In
    // particular: no deploy keys, no database, no tokens.
    "-v", `${worktree}:/work`,
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
 * Install dependencies.
 *
 * Network is on here because a registry install needs it — but no secret is
 * present, so a malicious lifecycle script has nothing to exfiltrate and nowhere
 * to reach on the host. Scripts are NOT disabled, because a repo whose native
 * modules never build would fail its tests for reasons that have nothing to do
 * with the change under review.
 */
export async function install(cfg: SandboxConfig, worktree: string, cacheDir: string): Promise<ToolResult> {
  return runTool(
    worktree,
    cfg.runtime,
    [...baseArgs(cfg, worktree, cacheDir), cfg.image, "sh", "-lc", "npm ci --no-audit --no-fund || npm install --no-audit --no-fund"],
    cfg.timeoutMs,
  );
}

/**
 * Run the suite with **no network at all**.
 *
 * A test that reaches the internet is not a test of this change, and a dependency
 * that phones home during a test run is exactly what we are guarding against.
 */
export async function runTests(cfg: SandboxConfig, worktree: string, cacheDir: string): Promise<ToolResult> {
  return runTool(
    worktree,
    cfg.runtime,
    [...baseArgs(cfg, worktree, cacheDir), "--network", "none", cfg.image, "sh", "-lc", "npm test --silent"],
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
