/**
 * Running the target's test suite, in a container that holds nothing worth stealing.
 *
 * Greptile built an execution layer because running code finds what reading it
 * cannot. But `npm test` executes whatever the repo and its entire dependency tree
 * say, lifecycle scripts included — **the threat is not the teammate, it is the
 * dependency tree.**
 *
 * The service container holds the attestation signing key and the knowledge
 * database. One malicious `postinstall` in there reads all of it at once. So this
 * runs somewhere else entirely: no secrets, no host access, resource limits, hard
 * timeout, destroyed after (D-24).
 *
 * The worktree goes in; findings come out; nothing else crosses.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../core/paths.ts";
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
  /**
   * The uid/gid the sandbox runs as, matching the service's own.
   *
   * See `--user` in `baseArgs`: the shared cache and scratch directories outlive a
   * review, and root-owned leftovers in them break the next one.
   */
  readonly uid: number;
  readonly gid: number;
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
  cacheRoot: join(dataDir(), "npm-cache"),
  scratchRoot: join(dataDir(), "scratch"),
  // The uid lore is actually running as, asked of the process rather than configured
  // — a second place to write it down is a second place for it to disagree.
  uid: typeof process.getuid === "function" ? process.getuid() : 1000,
  gid: typeof process.getgid === "function" ? process.getgid() : 1000,
  // A monorepo typechecking 30+ packages through turbo fans out hard, and 2g
  // OOM-killed it — which arrives as exit 137 and reads as a failing gate unless
  // something checks. Raised to what the deployment host can spare; the kill is
  // still reported honestly if it happens anyway.
  memory: "6g",
  cpus: "2",
  // A hung suite otherwise holds a review slot forever, and looks like a slow
  // review rather than a stuck one.
  timeoutMs: 15 * 60_000,
  runtime: "docker",
};

/**
 * Cache key: identical lockfiles share an install. Installs dominate T0 otherwise.
 *
 * Keyed on the lockfile the CHOSEN manager installs from, never on whichever one is
 * found first — see `Toolchain.lockfile` for what the disagreement cost.
 */
export async function lockfileKey(worktree: string): Promise<string> {
  const cmds = await commandsFor(worktree);
  const name = cmds?.lockfile;
  if (name === undefined) return "no-lockfile";
  const content = await readFile(join(worktree, name)).catch(() => undefined);
  return content === undefined
    ? "no-lockfile"
    : createHash("sha256").update(content).digest("hex").slice(0, 16);
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
    // particular: no signing key, no database, no tokens.
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
    // RUN AS LORE'S OWN UID, NOT ROOT.
    //
    // Not a security control — the container already has no capabilities, no network
    // and no host filesystem, and the threat here is a CARELESS test suite rather
    // than a hostile one. It is an ownership problem: `cacheRoot` and `scratchRoot`
    // live under the data directory and are REUSED across reviews, so a suite running
    // as root leaves root-owned files that lore (uid 1000) then cannot rewrite or
    // clean up. The next review fails on a permission error in a directory it owns,
    // which reads as a broken sandbox rather than as leftovers.
    //
    // Matching the service's own uid is what makes the two agree; the directories are
    // created by lore, so they are already writable by it.
    "--user", `${cfg.uid}:${cfg.gid}`,
    "-e", "CI=1",
    "-e", "NO_COLOR=1",
    // Where a self-provisioning package manager keeps the version the project
    // ASKED for, on the one mount that survives between phases.
    //
    // pnpm honours `packageManager: pnpm@9.15.0` by fetching that exact version on
    // first use. Install has network and the later phases do not, so with this
    // pointing at the container's own filesystem the fetch succeeded during install,
    // was thrown away with the container, and then failed under `--network none` —
    // reported as `pnpm run typecheck` FAILING. A false high-severity finding
    // against a branch whose typecheck passes is worse than not running it at all.
    "-e", "XDG_DATA_HOME=/work/node_modules/.xdg",
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
 * Which package manager this repository actually uses, chosen by its lockfile.
 *
 * T0 runs the TARGET's own tooling (D-8), and that has to include how it installs.
 * A pnpm monorepo cannot be installed by npm — `packageManager` and a `preinstall`
 * guard both refuse it — and the failure is not confined to the suite: `tsc` and
 * `eslint` resolve through `node_modules`, so an install that does not happen takes
 * the whole deterministic tier with it.
 *
 * `undefined` means we recognise the lockfile and cannot honour it. That is reported
 * as an unavailable engine, never as a clean run.
 */
export interface Toolchain {
  readonly name: string;
  /**
   * The lockfile this manager installs from — and therefore the ONLY file the cache
   * key may be derived from.
   *
   * These were two lists in two functions with opposite precedence: the key took
   * `package-lock.json` first, the installer took `pnpm-lock.yaml` first. A repo
   * carrying both got a key from one file while installing from the other, so a
   * change to the lockfile that mattered left the key untouched and the previous
   * `node_modules` was reused — a review running against dependencies that are not
   * the branch's, silently.
   */
  readonly lockfile: string | undefined;
  readonly install: string;
  /** `<pm> run <script>`, for scripts the target declares itself. */
  readonly run: (script: string) => string;
}

export async function toolchain(worktree: string): Promise<Toolchain | undefined | "npm"> {
  const has = async (f: string) => (await readFile(join(worktree, f)).catch(() => undefined)) !== undefined;

  // Order matters only where a repo carries two lockfiles, which is itself a mess;
  // the most specific manager wins so we do not silently pick the wrong one.
  if (await has("pnpm-lock.yaml")) {
    return {
      name: "pnpm",
      lockfile: "pnpm-lock.yaml",
      install: "pnpm install --frozen-lockfile || pnpm install",
      run: (script) => `pnpm run ${script}`,
    };
  }
  if (await has("yarn.lock")) {
    return {
      name: "yarn",
      lockfile: "yarn.lock",
      install: "yarn install --immutable || yarn install",
      run: (script) => `yarn run ${script}`,
    };
  }
  // Bun is a different runtime, not just a different installer, and is not in the
  // sandbox image. Saying so beats installing with npm and reporting whatever that
  // produces as though it were the project's own suite.
  if ((await has("bun.lock")) || (await has("bun.lockb"))) return undefined;
  return "npm";
}

const NPM: Toolchain = {
  name: "npm",
  lockfile: "package-lock.json",
  install: "npm ci --no-audit --no-fund || npm install --no-audit --no-fund",
  run: (script) => `npm run --silent ${script}`,
};

/** The commands to use, with npm as the default for a repo with no lockfile. */
export async function commandsFor(worktree: string): Promise<Toolchain | undefined> {
  const t = await toolchain(worktree);
  return t === undefined ? undefined : t === "npm" ? NPM : t;
}

/**
 * Run one command in the sandbox.
 *
 * `network` is on ONLY for the install: a registry needs it, and a test — or a
 * typecheck, or a lint — that reaches the internet is not a check of this change.
 * Everything else is the same container shape: sources read-only at /src, a
 * throwaway copy at /work, the shared install at /work/node_modules, no
 * capabilities, no new privileges, bounded cpu/memory/pids, and a hard timeout.
 */
export async function runInSandbox(
  cfg: SandboxConfig,
  worktree: string,
  cacheDir: string,
  scratch: string,
  script: string,
  network: boolean,
): Promise<ToolResult> {
  return runTool(
    worktree,
    cfg.runtime,
    [
      ...baseArgs(cfg, worktree, cacheDir, scratch),
      ...(network ? [] : ["--network", "none"]),
      cfg.image,
      "sh",
      "-lc",
      // Re-synced every time: install may rewrite a lockfile, and each phase must
      // see exactly the sources under review rather than what the last one left.
      `${SYNC} && ${script}`,
    ],
    cfg.timeoutMs,
  );
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
export async function install(
  cfg: SandboxConfig,
  worktree: string,
  cacheDir: string,
  scratch: string,
  cmds: Toolchain,
): Promise<ToolResult> {
  return runTool(
    worktree,
    cfg.runtime,
    [
      ...baseArgs(cfg, worktree, cacheDir, scratch),
      cfg.image,
      "sh",
      "-lc",
      `${SYNC} && (${cmds.install})`,
    ],
    cfg.timeoutMs,
  );
}

