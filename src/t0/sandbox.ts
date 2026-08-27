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
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../core/paths.ts";
import { runTool, type ToolResult } from "./exec.ts";

export interface SandboxConfig {
  /** Container image. Must be arm64 on the deployment host (D-33). */
  readonly image: string;
  /**
   * Host directory holding per-lockfile sandbox caches (D-37) — `node_modules` for
   * npm/pnpm/yarn, and cargo's own registry+target cache under a `cargo-`-prefixed
   * subdirectory (D-131), so the two ecosystems' hash buckets can never collide even
   * though they share this one root.
   */
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

/** The hash both `lockfileKey` and `cargoLockKey` key their cache on. */
async function fileHashKey(worktree: string, relPath: string): Promise<string> {
  const content = await readFile(join(worktree, relPath)).catch(() => undefined);
  return content === undefined
    ? "no-lockfile"
    : createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Cache key: identical lockfiles share an install. Installs dominate T0 otherwise.
 *
 * Keyed on the lockfile the CHOSEN manager installs from, never on whichever one is
 * found first — see `Toolchain.lockfile` for what the disagreement cost.
 */
export async function lockfileKey(worktree: string): Promise<string> {
  const cmds = await commandsFor(worktree);
  const name = cmds.ok ? cmds.toolchain.lockfile : undefined;
  return name === undefined ? "no-lockfile" : fileHashKey(worktree, name);
}

/**
 * Cargo's own cache key, mirroring `lockfileKey` above rather than sharing it — the
 * two ecosystems have nothing else in common. Hashes `<dir>/Cargo.lock`, not always
 * the worktree root: `dir` is wherever `detectEcosystems` found the manifest (root,
 * or one level down per D-129 — `teammater`'s `server/` crate keeps its own lock
 * there, not at the repo root). Falls back to `no-lockfile` the same way `lockfileKey`
 * does: a library crate legitimately may not commit one.
 */
export async function cargoLockKey(worktree: string, dir: string): Promise<string> {
  return fileHashKey(worktree, dir === "." ? "Cargo.lock" : join(dir, "Cargo.lock"));
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
 *
 * `cacheMountPath` is where inside `/work` the cache lands — `/work/node_modules`
 * for every existing npm/pnpm/yarn call site (the default, so none of them change),
 * `/work/.cargo` for cargo's (D-131), which needs no `node_modules`-shaped mount at
 * all. `XDG_DATA_HOME` derives from it rather than being hardcoded, which is the
 * more honest generalisation: any tool that self-provisions should do so into
 * whichever mount is the PERSISTENT one, not the throwaway scratch copy, regardless
 * of which ecosystem is asking.
 */
function baseArgs(cfg: SandboxConfig, worktree: string, cacheDir: string, scratch: string, cacheMountPath = "/work/node_modules"): string[] {
  return [
    "run",
    "--rm",
    // Nothing from the host beyond the sources, a scratch copy and the cache. In
    // particular: no signing key, no database, no tokens.
    "-v", `${worktree}:/src:ro`,
    "-v", `${scratch}:/work`,
    // lore-ok[d341a76e]: fixed in runner.ts, not here. The mount alone was never
    // going to be enough — cargo does not read `cacheMountPath` off the filesystem
    // layout, it reads `$CARGO_HOME`/`$CARGO_TARGET_DIR`, and nothing pointed those
    // at this mount. `CARGO_ENV` (runner.ts, exported at the front of every cargo
    // script string `sandboxedCargo`/`checkCargo` build) does that now; this mount
    // is the correct, necessary, but not sufficient other half.
    "-v", `${cacheDir}:${cacheMountPath}`,
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
    "-e", `XDG_DATA_HOME=${cacheMountPath}/.xdg`,
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


/** Does this worktree have `f` at its root? Shared by every existence check below. */
async function has(worktree: string, f: string): Promise<boolean> {
  return (await readFile(join(worktree, f)).catch(() => undefined)) !== undefined;
}

/**
 * Which package manager this repository actually uses, chosen by its lockfile.
 *
 * T0 runs the TARGET's own tooling (D-8), and that has to include how it installs.
 * A pnpm monorepo cannot be installed by npm — `packageManager` and a `preinstall`
 * guard both refuse it — and the failure is not confined to the suite: `tsc` and
 * `eslint` resolve through `node_modules`, so an install that does not happen takes
 * the whole deterministic tier with it.
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

/**
 * `ok: false` means we could not honour this repo as a JS/TS project — and WHY,
 * so a caller can say something true instead of reusing whichever reason happened
 * to be checked last (D-129, found live: a pure-Rust repo, atuin, had no
 * package.json at all, yet `commandsFor` unconditionally fell through to "npm with
 * no lockfile" and queued a real `npm ci` against a tree with nothing for it to
 * install — 15 minutes behind an unrelated review sharing the same empty
 * `no-lockfile` cache bucket, for a repo that was never a JS project). Reported as
 * an unavailable engine, never as a clean run.
 */
export type ToolchainOutcome =
  | { readonly ok: true; readonly toolchain: Toolchain }
  | { readonly ok: false; readonly why: string };

const NPM: Toolchain = {
  name: "npm",
  lockfile: "package-lock.json",
  install: "npm ci --no-audit --no-fund || npm install --no-audit --no-fund",
  run: (script) => `npm run --silent ${script}`,
};

/**
 * The commands to use, or why none apply — npm is the default ONLY once
 * `package.json` confirms this is actually a JS/TS project, not whenever no
 * lockfile matched. Order matters only where a repo carries two lockfiles, which
 * is itself a mess; the most specific manager wins so we do not silently pick the
 * wrong one.
 */
export async function commandsFor(worktree: string): Promise<ToolchainOutcome> {
  // PACKAGE.JSON AT THE ROOT, FIRST, BEFORE ANY LOCKFILE — found by lore's own t2,
  // reviewing this exact function: a lockfile alone used to be treated as enough
  // evidence, on the reasoning that no manager writes one without a `package.json`
  // to install against. True when the lockfile was WRITTEN; not guaranteed to
  // still be true when it is READ — a branch that deletes its manifest but leaves
  // a stale `package-lock.json` behind (a bad merge, a mid-migration commit) would
  // still resolve `ok: true`, and the install this triggers has nothing to
  // install, recreating exactly the wasted-queueing shape D-129 exists to remove.
  // Gating on `package.json` FIRST, once, closes it for all four lockfiles at
  // once rather than as a special case of one; everything below only ever decides
  // WHICH manager, never WHETHER this is a JS project at all.
  if (!(await has(worktree, "package.json"))) {
    // NOT YET "NOT A JS/TS PROJECT" — this function can only drive an install from
    // the worktree ROOT (the sandbox mounts nothing else), so a missing root
    // `package.json` is not yet evidence the repo is not JS/TS at all. Found live,
    // by lore's own t1, on a real repo this deployment reviews: `acdc` keeps its
    // only manifest at `infra/package.json`, no root one — this function said "not
    // a JS/TS project" while `detectEcosystems` (a one-level walk, same file)
    // correctly found it at `infra/`. Reusing that walk here rather than repeating
    // it by hand keeps the two answers from being able to disagree about the same
    // question again. Still `ok: false`: knowing a nested manifest exists is not
    // the same as being able to install from it, which stays the next slice's work.
    const nested = (await detectEcosystems(worktree)).find((f) => f.ecosystem === "npm");
    if (nested !== undefined) {
      return {
        ok: false,
        why: `package.json exists at ${nested.dir}/, not the worktree root — installing from a nested ` +
          "manifest is not supported yet",
      };
    }
    // BOUNDED BY WHAT WAS ACTUALLY CHECKED — found by lore's own t2 beside the
    // finding above: this function (via `detectEcosystems`) only ever looks at the
    // root and one level down, so a manifest two levels deep (`apps/web/package.json`)
    // is genuinely possible and genuinely unseen. Said as a claim about the search,
    // not a claim about the repository — the wording this replaced ("not a JS/TS
    // project", full stop) asserted more than one level of `readdir` can support.
    return {
      ok: false,
      why: "no package.json within one level of the worktree root — not a JS/TS project as far as this checked",
    };
  }

  // FROM HERE, `package.json` IS CONFIRMED AT THE ROOT. Order matters only where a
  // repo carries two lockfiles, which is itself a mess; the most specific manager
  // wins so we do not silently pick the wrong one.
  if (await has(worktree, "pnpm-lock.yaml")) {
    return {
      ok: true,
      toolchain: {
        name: "pnpm",
        lockfile: "pnpm-lock.yaml",
        install: "pnpm install --frozen-lockfile || pnpm install",
        run: (script) => `pnpm run ${script}`,
      },
    };
  }
  if (await has(worktree, "yarn.lock")) {
    return {
      ok: true,
      toolchain: {
        name: "yarn",
        lockfile: "yarn.lock",
        install: "yarn install --immutable || yarn install",
        run: (script) => `yarn run ${script}`,
      },
    };
  }
  // Bun is a different runtime, not just a different installer, and is not in the
  // sandbox image. Saying so beats installing with npm and reporting whatever that
  // produces as though it were the project's own suite.
  if ((await has(worktree, "bun.lock")) || (await has(worktree, "bun.lockb"))) {
    return { ok: false, why: "this repository uses bun, which the sandbox image does not carry" };
  }
  // `package-lock.json`, or no lockfile at all — both are npm once `package.json`
  // is confirmed present, and npm resolves fine from a missing lockfile on its own.
  return { ok: true, toolchain: NPM };
}

export type Ecosystem = "npm" | "cargo";

export interface EcosystemFound {
  readonly ecosystem: Ecosystem;
  /** Repo-relative directory the marker was found in — `"."` for the worktree root. */
  readonly dir: string;
}

/** Noise a one-level walk should not report as a project root in its own right. */
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "vendor"]);

/**
 * Every ecosystem T0 finds evidence of in this worktree, and WHERE — not exactly
 * one, and not only at the root.
 *
 * Independent existence checks rather than a single classification, because a repo
 * can genuinely be more than one at once: teammater's root is plain JS served as
 * static files with no `package.json` anywhere, while its nested `server/` is a
 * real Cargo project. Most repos are exactly one; a repo with neither is neither
 * silently mis-routed nor forced into a default that does not describe it — which
 * is the bug `commandsFor`'s own npm fallback just stopped making.
 *
 * ONE LEVEL DEEP, not arbitrary recursion — found by lore's own t1, reviewing the
 * first version of this function: root-only missed teammater entirely, the exact
 * repository the doc comment above names as the reason this returns a list rather
 * than a single answer. Unlike an npm or cargo WORKSPACE, which always declares its
 * members from a root manifest (so root-only detection is enough to find the
 * declaration, even if walking the members themselves is a later concern),
 * teammater's `server/` is not a workspace member of anything — just an unrelated
 * crate sharing a repository, with nothing at the root marking it. One level catches
 * that real, observed shape without turning this into a general-purpose project-file
 * crawler: deeper nesting and true workspace-aware discovery stay the next slice's
 * problem, which needs manifest paths for `cargo check --manifest-path=...` anyway
 * and is better placed to decide how far to look.
 */
export async function detectEcosystems(worktree: string): Promise<readonly EcosystemFound[]> {
  const found: EcosystemFound[] = [];
  const checkDir = async (dir: string, abs: string): Promise<void> => {
    if (await has(abs, "package.json")) found.push({ ecosystem: "npm", dir });
    if (await has(abs, "Cargo.toml")) found.push({ ecosystem: "cargo", dir });
  };
  await checkDir(".", worktree);
  const entries = await readdir(worktree, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    await checkDir(entry.name, join(worktree, entry.name));
  }
  return found;
}

/**
 * Run one command in the sandbox.
 *
 * `network` is on ONLY for the install: a registry needs it, and a test — or a
 * typecheck, or a lint — that reaches the internet is not a check of this change.
 * Everything else is the same container shape: sources read-only at /src, a
 * throwaway copy at /work, the shared cache mounted at `cacheMountPath` (default
 * `/work/node_modules`; cargo's own callers pass `/work/.cargo` — D-131), no
 * capabilities, no new privileges, bounded cpu/memory/pids, and a hard timeout.
 */
export async function runInSandbox(
  cfg: SandboxConfig,
  worktree: string,
  cacheDir: string,
  scratch: string,
  script: string,
  network: boolean,
  cacheMountPath?: string,
): Promise<ToolResult> {
  return runTool(
    worktree,
    cfg.runtime,
    [
      ...baseArgs(cfg, worktree, cacheDir, scratch, cacheMountPath),
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

