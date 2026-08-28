/**
 * The T0 tier: run every deterministic engine the review type asks for.
 *
 * The important output is not just the findings — it is also the honest list of
 * what could **not** be run. A repo with no typechecker is a fact the model tiers
 * need, because it tells them what they must look for themselves. Silently
 * reporting "T0 clean" for a repo where nothing ran would be the purest form of
 * INV-1's failure.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { compareFindings, type Finding } from "../core/finding.ts";
import type { T0Engine } from "../core/review-type.ts";
import { detect, parseCargoJson, parseEslint, parseTsc, runEngine, type EngineOutcome } from "./engines.ts";
import {
  cargoLockKey,
  commandsFor,
  DEFAULT_SANDBOX,
  detectEcosystems,
  install,
  lockfileKey,
  runInSandbox,
  SANDBOX_CWD,
  type SandboxConfig,
  type Toolchain,
} from "./sandbox.ts";

export interface T0Result {
  readonly findings: readonly Finding[];
  readonly outcomes: readonly EngineOutcome[];
  /** Engines that did not run, and why. Goes into the model prompt verbatim. */
  readonly unavailable: readonly string[];
  /**
   * Optional engines with nothing to do — logged, never reported as a gap.
   *
   * Kept separate from `unavailable` so the list a client repeats to its user stays
   * worth reading. See `EngineOutcome.skipped`.
   */
  readonly skipped: readonly string[];
  /**
   * True when ANY engine this round was interrupted rather than genuinely absent
   * — see `EngineOutcome.interrupted`. Round-level rather than per-engine: a
   * caller deciding whether to trust THIS ROUND's silence about a previously
   * open finding cannot know, without a schema change this fix does not make,
   * which specific engine originally raised it — so ANY interruption this round
   * withholds trust from all of T0's silence for it, not just the interrupted
   * engine's. Costs an auto-settle on an unrelated engine only on the rare round
   * something was actually cut short; a permanently unconfigured engine (which
   * never sets `interrupted`) never pays it.
   */
  readonly interrupted: boolean;
}

export interface T0Options {
  readonly engines: readonly T0Engine[];
  /**
   * The files this review changed, for the engines that match one file at a time (D-92).
   *
   * Absent means the whole tree, which is what every caller did before this existed and
   * what a caller that cannot compute a diff should keep doing.
   */
  readonly files?: readonly string[];
  readonly sandbox?: SandboxConfig;
}

/**
 * Serialises installs that share a cache directory, and only those.
 *
 * In-process because the workers are loops in one process (`Worker.start`). A second
 * lore process on the same data directory would need a file lock; there is not one,
 * and this comment is the record of that limit rather than a claim it is handled.
 */
const installing = new Map<string, Promise<unknown>>();

export async function withInstallLock<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = installing.get(cacheDir) ?? Promise.resolve();
  // `.then(fn, fn)` on both arms: a failed install must not wedge the queue behind it
  // for ever. The next caller runs regardless of how the last one ended.
  const queued = previous.then(fn, fn);
  // What the NEXT caller chains onto — swallowing the outcome, since a rejection here
  // is the caller's to handle, not the lock's. Held in its own variable because the
  // cleanup below compares identity, and comparing against `queued` would never match.
  const guard = queued.then(
    () => undefined,
    () => undefined,
  );
  installing.set(cacheDir, guard);
  try {
    return await queued;
  } finally {
    // Only if nothing has queued behind us; otherwise the map still names their turn.
    if (installing.get(cacheDir) === guard) installing.delete(cacheDir);
  }
}

/**
 * Is an install (or a reader queued behind one, per `withInstallLock`'s own comment
 * — "THE LOCK COVERS THE READERS TOO") in flight for this cache directory right now?
 *
 * Exported for `ops/retention.ts` — found by lore's own review, fingerprint
 * ffbda1f7: the sandbox-cache sweep called `rm` on a cache directory with no reference to this map
 * at all, so an old-but-still-mid-install directory (the exact case a long cold
 * install, or a burst of reviews queued behind one, produces) could be deleted while
 * `tsc`/`eslint` were reading it — the "half-written node_modules" failure this
 * lock's own comment already documents once, reopened one caller over. Both live in
 * the SAME process (`service/main.ts` calls the worker loops and the retention sweep
 * alike), so this is the coordination the module comment above says a cross-process
 * lock would need — it is not that, and does not need to be.
 */
export function isInstalling(cacheDir: string): boolean {
  return installing.has(cacheDir);
}

export async function runT0(worktree: string, opts: T0Options): Promise<T0Result> {
  // FILES THAT STILL EXIST, because a branch's diff names the ones it DELETED too.
  // `git diff --name-only` lists them and they are not in the worktree, and semgrep
  // treats a missing scanning root as fatal (`InvalidScanningRootError`, exit 2) — so a
  // single deleted file killed the entire semgrep run, and the failure surfaced as
  // "semgrep produced unparseable output", which points at the wrong thing entirely.
  //
  // Filtered here rather than in the caller: this is the layer that holds the worktree,
  // and a caller computing a diff has no reason to know which engines read the disk.
  const files = opts.files?.filter((f) => existsSync(join(worktree, f)));

  // HOST ENGINES RUN CONCURRENTLY WITH BOTH SANDBOXED PHASES, not before them (D-127).
  //
  // All three share no state: host engines are lore's own binaries reading `worktree`
  // read-only, and each sandboxed phase works entirely inside its OWN `/work` copy and
  // its own cache (`sandboxed()`'s node_modules, `sandboxedCargo()`'s `.cargo` — D-131,
  // separate scratch directories too, so their independent `SYNC` steps cannot race
  // each other). Before D-127 host and sandbox ran one after the other, so a two-second
  // ast-grep/semgrep pair sat and waited for an unrelated multi-minute install for no
  // reason beyond the order they happened to be written in. Engines within each group
  // are independent of each other too — same reasoning, `Promise.all` rather than a
  // loop.
  const sandboxedNames = new Set<T0Engine>(["tsc", "eslint", "cargo-check", "cargo-clippy"]);
  const hostEngines = opts.engines.filter((e) => !sandboxedNames.has(e));
  const [hostOutcomes, sandboxOutcomes, cargoOutcomes] = await Promise.all([
    Promise.all(hostEngines.map((engine) => runEngine(worktree, engine, files))),
    sandboxed(worktree, opts.sandbox ?? DEFAULT_SANDBOX, opts.engines),
    sandboxedCargo(worktree, opts.sandbox ?? DEFAULT_SANDBOX, opts.engines),
  ]);
  const outcomes = [...hostOutcomes, ...sandboxOutcomes, ...cargoOutcomes];

  const skipped = outcomes.filter((o) => o.skipped !== undefined).map((o) => o.skipped ?? "");
  // Said once, to the operator's log, so an optional engine's absence is visible to
  // someone who could act on it without becoming noise in the client's report.
  if (skipped.length > 0) console.error(`[lore:log] t0 optional engines idle — ${skipped.join("; ")}`);

  return {
    findings: outcomes.flatMap((o) => o.findings),
    outcomes,
    unavailable: outcomes
      .filter((o) => o.unavailable !== undefined)
      .map((o) => `${o.engine}: ${o.unavailable ?? ""}`),
    skipped,
    interrupted: outcomes.some((o) => o.interrupted === true),
  };
}


/**
 * Everything that needs `node_modules`, in one sandboxed session.
 *
 * `tsc` and `eslint` resolve their binaries out of the TARGET's dependency tree, so
 * running them is executing code the target controls. D-24 puts that in the sandbox
 * and nowhere else — the service container holds the knowledge base, the signing key
 * and every provider credential. They used to run on the host through `npx`, which
 * meant a `postinstall`-shaped risk had a second door with no lock on it.
 *
 * One install serves all three phases: installs dominate T0's wall-clock, and doing
 * it once per review is the difference between this being affordable and not.
 *
 * **The target's own script wins where it declares one.** A monorepo's answer to
 * "does this typecheck" is `turbo run typecheck` across 33 packages, not one `tsc`
 * at a root that has no `tsconfig.json`. When a script runs, its output is not a
 * format we can parse into per-line findings, so a failure becomes ONE finding
 * carrying the output — honest, and far better than reporting nothing.
 */
async function sandboxed(
  worktree: string,
  cfg: SandboxConfig,
  engines: readonly T0Engine[],
): Promise<EngineOutcome[]> {
  const wanted = engines.filter((e) => e === "tsc" || e === "eslint");
  if (wanted.length === 0) return [];

  // SKIPPED, NOT UNAVAILABLE, when there is no npm-family manifest anywhere
  // within one level — the exact mirror of `sandboxedCargo`'s own "not a Rust
  // project" case (fingerprint c37f7c9b), unfixed here until lore's own review
  // asked why: a pure Rust/Go/Python repo told "tsc: not a JS/TS project" on
  // every single round forever is precisely the always-identical noise that
  // fix moved to the operator's log for cargo, and the client-facing NOT RUN
  // list only stays worth reading while it does not carry that (fingerprints
  // 0691f313, 6eae08da). Checked with `detectEcosystems` DIRECTLY, before ever
  // calling `commandsFor`, so every OTHER `ok: false` reason `commandsFor` can
  // still give from here on — a nested, unsupported package.json; bun, which
  // the sandbox image does not carry — is now guaranteed to be a genuine gap
  // about a REAL JS/TS repo, correctly staying `unavailable`.
  const hasNpmManifest = (await detectEcosystems(worktree)).some((f) => f.ecosystem === "npm");
  if (!hasNpmManifest) {
    return wanted.map((engine) => ({
      engine,
      findings: [],
      skipped: `${engine}: no package.json within one level of the worktree root (not a JS/TS project, optional)`,
    }));
  }

  const outcome = await commandsFor(worktree);
  if (!outcome.ok) {
    return wanted.map((engine) => ({ engine, findings: [], unavailable: outcome.why }));
  }
  const cmds = outcome.toolchain;

  const scripts = await packageScripts(worktree);
  const cacheDir = join(cfg.cacheRoot, await lockfileKey(worktree));
  await mkdir(cacheDir, { recursive: true });
  // TOUCHED HERE, UNCONDITIONALLY — found by lore's own review, fingerprint
  // ffbda1f7: retention's sweep judges this directory abandoned by ITS OWN mtime, which `npm ci` refreshes
  // (it recreates node_modules' direct children, which this IS — sandbox.ts mounts
  // `cacheDir` itself as `/work/node_modules`) but a WARM pnpm/yarn install may not: both
  // link through a content-addressable store or `.pnpm`, and a frozen-lockfile install
  // that finds everything already correct can leave node_modules' own listing — and so
  // its mtime — untouched for as long as the lockfile does not change. A cache pnpm
  // reuses every review, silently, would then read as abandoned and be deleted from
  // under a repo that is using it constantly. Recording USE directly, on every call
  // regardless of what the package manager decides to do, is honest where inferring it
  // from a side effect that varies by tool is not.
  await utimes(cacheDir, new Date(), new Date()).catch(() => {
    // Best-effort: a cache directory retention is about to judge is not worth failing
    // the review over if its timestamp cannot be touched.
  });
  const scratch = join(cfg.scratchRoot, basename(worktree));
  await mkdir(scratch, { recursive: true });

  try {
    // ONE INSTALL AT A TIME PER CACHE DIRECTORY.
    //
    // The cache is keyed by LOCKFILE HASH, so every branch of a repository that has
    // not changed its lockfile shares one `node_modules`, mounted read-write into
    // each sandbox. Two reviews of one repo therefore already race; at higher
    // concurrency a whole burst of branches installs into the same directory at once.
    //
    // The failure is not a crash. A half-written `node_modules` makes `tsc` and
    // `eslint` report errors that are not real — reporting the target's own gates as
    // failing when we broke them ourselves, which has already happened here once from
    // a different cause and cost two rounds of confident false claims about someone
    // else's branch.
    //
    // Serialising costs almost nothing after the first one: a warm cache installs in
    // about 200ms, measured. It is the cold install that takes minutes, and that one
    // has to happen exactly once anyway.
    // THE LOCK COVERS THE READERS TOO, not just the writer.
    //
    // It used to wrap `install` alone — and then `tsc` and `eslint` ran outside it,
    // reading the very `node_modules` the next review was free to start rewriting. The
    // race the comment above describes was not removed, only moved one step later:
    // A typechecks against the cache while B installs into it, and A reports errors
    // that are not real, about somebody else's branch, in our own voice.
    //
    // What the LOCK adds is bounded and small — the QUEUEING, on top of whatever
    // install/typecheck/lint already cost on their own. The install is what actually
    // dominates T0's wall-clock, especially cold (spec/deployment.md §3: p90 537s,
    // measured), and that cost is real and paid regardless of this lock; serialising
    // only means a second reviewer sharing the lockfile hash waits in line rather than
    // reading a half-written node_modules. The key is per LOCKFILE HASH — two repos, or
    // two branches with different dependencies, never wait on each other.
    return await withInstallLock(cacheDir, async () => {
      const installed = await install(cfg, worktree, cacheDir, scratch, cmds);
      // `interrupted: installed.timedOut` — found by lore's own review, fingerprint
      // dd36a31b: a timeout is the third way a run does not finish, structurally
      // distinct from a stable absence (docker itself missing), and `ToolResult`
      // already carries it rather than needing a message guessed at.
      if (installed.unavailable !== undefined) {
        return wanted.map((engine) => ({
          engine,
          findings: [],
          unavailable: `install could not run: ${installed.unavailable ?? ""}`,
          interrupted: installed.timedOut,
        }));
      }
      // CHECKED BEFORE `!installed.ok` — found by lore's own review of this same
      // fix, fingerprint bd0f45f3: `install()` calls `runTool` directly, the same
      // shape as the sandboxed calls above it, so a memory-exhausted install (a
      // native module's build step, or a large enough tree on its own) fell into
      // `!installed.ok` below and came out as a confident, high-severity claim that
      // the branch's dependencies do not install — `installed.unavailable` stays
      // undefined for either OOM signal, since exec.ts only sets it for ENOENT or
      // Node's own timeout.
      if (ranOutOfMemory(installed)) {
        return wanted.map((engine) => ({
          engine,
          findings: [],
          unavailable:
            `install (${cmds.name}) did not complete (${installed.code === KILLED ? `killed, exit ${KILLED}` : "ran out of memory"}) — ` +
            `almost always a memory limit, not a fault in the branch. Nothing that needs it is known either way.`,
          interrupted: true,
        }));
      }
      if (!installed.ok) {
        // One finding, not one per engine — it is a single fact about the branch. The
        // others report unavailable, because that is what they are.
        const tail = `${installed.stdout}\n${installed.stderr}`.trim().split("\n").slice(-30).join("\n").slice(0, 2000);
        return wanted.map((engine, i) => ({
          engine,
          findings:
            i > 0
              ? []
              : [
                  {
                    file: "package.json",
                    severity: "high" as const,
                    claim: `dependencies do not install with ${cmds.name}, so nothing that needs them could run`,
                    evidence: tail,
                    failureScenario:
                      "the suite, the typecheck and the lint all resolve through node_modules — none of them ran, so none of their claims exist",
                  },
                ],
          unavailable: `dependencies failed to install with ${cmds.name}`,
        }));
      }

      const out: EngineOutcome[] = [];
      if (wanted.includes("tsc")) out.push(await checkTypes(cfg, worktree, cacheDir, scratch, cmds, scripts));
      if (wanted.includes("eslint")) out.push(await checkLint(cfg, worktree, cacheDir, scratch, cmds, scripts));
      return out;
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Single-quote a value for safe embedding in a `sh -lc` string. The manifest path
 * comes from the branch under review's own directory names — not a value this code
 * chooses, the same reasoning `scopePaths` (engines.ts) already documents for argv
 * paths, applied here because cargo's invocation is a shell STRING, not an argv
 * array, so nothing else stands between an unlucky directory name and word-splitting
 * or worse. Found by lore's own review, fingerprint 2b5a78f6.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The cargo cache mount's container path — a SIBLING of `/work`, never nested
 * inside it. Found by lore's own review, fingerprints a461dd72/54900638: mounting
 * it at `/work/.cargo` put the shared, cross-review cache on cargo's OWN
 * config-discovery path — cargo walks up from the current directory looking for
 * `.cargo/config.toml`, and `SYNC`'s `cp -a /src/. /work/` (dotfiles included)
 * copies a reviewed repo's own committed `.cargo/` INTO that exact mount, which
 * `cp -a` never cleans back out. A repo pinning a registry mirror or build target
 * in `.cargo/config.toml` would silently configure every OTHER review sharing its
 * Cargo.lock hash — cross-branch, potentially cross-repository, contamination in
 * lore's own voice. `/cargo-cache` shares nothing with any path cargo's own
 * discovery walks, and as a side effect a root crate's own `.cargo/config.toml` now
 * reads correctly from its natural, ephemeral, per-review location at
 * `/work/.cargo/config.toml` — populated by `SYNC` like any other source file,
 * once nothing is mounted over it.
 */
const CARGO_MOUNT = "/cargo-cache";

/**
 * Whether a cargo (or rustup-proxied) invocation failed because the TOOL ITSELF
 * is not fully available — a missing binary, a missing rustup component, or an
 * unconfigured default toolchain — rather than a genuine failure of the
 * branch's own gate. Shared by the fetch step and `checkCargo`, found by lore's
 * own review across two rounds, fingerprints f2b0d6c3/c618f5cb/57dea7e8/874b52df.
 *
 * All these shapes fail before cargo/rustup ever reaches the crate's own
 * `Cargo.toml` — dispatch itself is what is broken — so NOTHING project-controlled
 * has run yet and stdout is always empty. Confirmed empirically for two of the
 * three text shapes below (a plain missing subcommand: `cargo <name-that-does-not-
 * exist>` on a real, working cargo, `error: no such command:`, exit 101, 0 stdout
 * bytes; a rustup toolchain missing the clippy component specifically, by
 * temporarily removing it from a real local toolchain and restoring it after:
 * `error: 'cargo-clippy' is not installed for the toolchain '…'`, exit 1, 0
 * stdout bytes). The third — rustup's own long-documented "no default toolchain
 * configured" — was not separately reproduced but shares the identical shape:
 * failing before any project code runs.
 *
 * The empty-stdout requirement is not incidental. A text match alone, on `r.stderr`
 * by itself, would also match a target's own `build.rs` printing similar text as
 * part of a REAL failure — a broken branch's own error swallowed and reported as
 * "no toolchain" instead, the exact class fingerprint 01270153 already fixed once
 * for the fetch step's own "not found" hedge. Empty stdout is not airtight — a
 * contrived `build.rs` could theoretically fail before producing any JSON too —
 * but it is the strongest structural signal available without a dedicated
 * pre-check invocation, and it is the same signal every confirmed shape above
 * actually has.
 */
function cargoToolMissing(r: { readonly code: number; readonly stdout: string; readonly stderr: string }): boolean {
  if (r.stdout.trim() !== "") return false;
  return r.code === 127 || /no such command:|is not installed for the toolchain|no default toolchain configured/i.test(r.stderr);
}

/**
 * Where cargo keeps what it downloads and builds, redirected into the mounted cache
 * rather than each container's own ephemeral `$HOME/.cargo` — without this the
 * fetch's downloads die with the container that made them and `cargo check
 * --offline` in the NEXT container has nothing to resolve from. Found by lore's own
 * review, fingerprint d341a76e: `baseArgs`' cache mount was wired but nothing ever
 * pointed cargo at it. Exported once at the front of every cargo script string,
 * rather than as docker `-e` flags: `runInSandbox`'s `cacheMountPath` parameter
 * already generalises the MOUNT, and threading two more env pairs through it and
 * `baseArgs` for exactly one caller is more machinery than a two-line shell prefix.
 */
const CARGO_ENV = `export CARGO_HOME=${CARGO_MOUNT}/home CARGO_TARGET_DIR=${CARGO_MOUNT}/target;`;

/**
 * Everything cargo needs, in its own sandboxed session (D-131) — separate from
 * `sandboxed()` above in every dimension that matters: own cache (keyed by
 * Cargo.lock, not a JS lockfile), own scratch directory (so its own `SYNC` step
 * cannot race npm's when `runT0` runs both concurrently), no `Toolchain`-style
 * choice to make since it is always cargo.
 *
 * `detectEcosystems`, not `detect()` — see `detect()`'s own comment in engines.ts.
 * This is the nested-aware walk that finds a `teammater`-shaped repo (D-129: plain
 * JS at the root, a real crate one level down), which `detect()`'s root-only check
 * would miss entirely — exactly the case D-129's own `dir` field exists to answer.
 */
async function sandboxedCargo(
  worktree: string,
  cfg: SandboxConfig,
  engines: readonly T0Engine[],
): Promise<EngineOutcome[]> {
  const wanted = engines.filter((e) => e === "cargo-check" || e === "cargo-clippy");
  if (wanted.length === 0) return [];

  // FIRST MATCH WINS — the same bounded choice `commandsFor` already makes for a
  // repo carrying two lockfiles. True multi-crate awareness is out of scope for
  // this slice; `detectEcosystems` itself only ever looks one level deep anyway.
  const found = (await detectEcosystems(worktree)).find((f) => f.ecosystem === "cargo");
  if (found === undefined) {
    // SKIPPED, NOT UNAVAILABLE — found by lore's own review, fingerprint c37f7c9b.
    // `CODE_ARCH.t0` lists cargo-check/cargo-clippy unconditionally, the same way
    // tsc/eslint are — but unlike a JS repo missing its typechecker, "this is not a
    // Rust project" is not a gap the model tiers need told every round; it is
    // exactly ast-grep's own absent-by-nature case (`OPT_IN`'s own comment, above in
    // this file's sibling engines.ts), and belongs in the operator's log, not
    // repeated to the client on 100% of reviews of the JS repos this deployment
    // mostly reviews.
    return wanted.map((engine) => ({
      engine,
      findings: [],
      skipped: `${engine}: no Cargo.toml within one level of the worktree root (not a Rust project, optional)`,
    }));
  }
  const manifest = found.dir === "." ? "Cargo.toml" : `${found.dir}/Cargo.toml`;
  const quotedManifest = shQuote(manifest);

  const cacheDir = join(cfg.cacheRoot, `cargo-${await cargoLockKey(worktree, found.dir)}`);
  await mkdir(cacheDir, { recursive: true });
  // Same reasoning as the npm cache's own touch above: retention's sweep judges
  // this directory abandoned by its own mtime, and a warm cargo cache legitimately
  // may not rewrite every file on every use.
  await utimes(cacheDir, new Date(), new Date()).catch(() => {
    // Best-effort, same as npm's own — not worth failing the review over.
  });
  const scratch = join(cfg.scratchRoot, `${basename(worktree)}-cargo`);
  await mkdir(scratch, { recursive: true });

  try {
    return await withInstallLock(cacheDir, async () => {
      const fetched = await runInSandbox(
        cfg,
        worktree,
        cacheDir,
        scratch,
        `${CARGO_ENV} cargo fetch --manifest-path ${quotedManifest} --locked || cargo fetch --manifest-path ${quotedManifest}`,
        true,
        CARGO_MOUNT,
      );
      if (fetched.unavailable !== undefined) {
        return wanted.map((engine) => ({
          engine,
          findings: [],
          unavailable: `cargo fetch could not run: ${fetched.unavailable ?? ""}`,
          interrupted: fetched.timedOut,
        }));
      }
      if (ranOutOfMemory(fetched)) {
        return wanted.map((engine) => ({
          engine,
          findings: [],
          unavailable:
            `cargo fetch did not complete (${fetched.code === KILLED ? `killed, exit ${KILLED}` : "ran out of memory"}) — ` +
            "almost always a memory limit, not a fault in the branch. Nothing that needs it is known either way.",
          interrupted: true,
        }));
      }
      if (!fetched.ok) {
        // MISSING BINARY, NOT A BROKEN BRANCH — with no toolchain in the sandbox
        // image yet (D-131's own explicit scope boundary), this is what every real
        // review hits right now. `checkTypes`'s bare-tsc branch already drew this
        // same distinction once, fingerprint 1fa9229d: the likelier explanation for
        // this shape of failure is the tool never being installed to begin with,
        // not a defect in this branch's own dependencies.
        //
        // `cargoToolMissing`, not a bare `code === 127` check nor a bare text
        // match on its own — see that function's own doc comment for the full
        // reasoning (fingerprints 01270153, f2b0d6c3, c618f5cb, 57dea7e8,
        // 874b52df, spanning both this step and `checkCargo`'s identical need).
        if (cargoToolMissing(fetched)) {
          return wanted.map((engine) => ({
            engine,
            findings: [],
            unavailable: "cargo is not available in the sandbox image",
          }));
        }
        // One finding, not one per engine — it is a single fact about the branch.
        // `manifest`, not a hardcoded "Cargo.toml" — found by lore's own review as a
        // sibling of fingerprint 47ddd7fa: a nested crate's own manifest is not at
        // the worktree root, and naming the wrong file here is the same rebasing gap
        // that finding is about, one call site over.
        const tail = `${fetched.stdout}\n${fetched.stderr}`;
        const failTail = tail.trim().split("\n").slice(-30).join("\n").slice(0, 2000);
        return wanted.map((engine, i) => ({
          engine,
          findings:
            i > 0
              ? []
              : [
                  {
                    file: manifest,
                    severity: "high" as const,
                    claim: "dependencies do not fetch with cargo, so nothing that needs them could run",
                    evidence: failTail,
                    failureScenario:
                      "cargo check and cargo clippy both resolve through the fetched dependency tree — neither ran, so neither's claims exist",
                  },
                ],
          unavailable: "dependencies failed to fetch with cargo",
        }));
      }

      // lore-ok[d269a60f]: fixed one file over, not by de-duplicating the
      // combination here. `parseCargoJson` (engines.ts) now keeps only
      // `clippy::`-prefixed codes for the clippy engine, so the two `checkCargo`
      // results pushed below never carry the SAME diagnostic to begin with —
      // nothing to de-duplicate at the point they are combined.
      const out: EngineOutcome[] = [];
      if (wanted.includes("cargo-check")) {
        out.push(await checkCargo(cfg, worktree, cacheDir, scratch, manifest, found.dir, "cargo-check", "check"));
      }
      if (wanted.includes("cargo-clippy")) {
        out.push(await checkCargo(cfg, worktree, cacheDir, scratch, manifest, found.dir, "cargo-clippy", "clippy"));
      }
      return out;
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `cargo check` or `cargo clippy --message-format=json`, offline — identical shape
 * for both, unlike `checkTypes`/`checkLint`'s deliberate split, because neither has
 * a "target declared a custom script" branch to choose between: cargo's own root
 * manifest is already the canonical invocation (D-8), workspace members included,
 * with no monorepo-runner indirection needed.
 *
 * ONE HONEST GAP, not silently claimed away: a NESTED crate's own `.cargo/config.toml`
 * is not read. Found by lore's own review, fingerprint 54900638, and confirmed by
 * running real cargo: config discovery walks up from the process's own working
 * directory (`/work`, set once for every engine in `baseArgs`), not from
 * `--manifest-path`'s directory — a root crate's config is read correctly (nothing
 * else sits between `/work` and its `.cargo/`), a nested one's is invisible to this
 * invocation regardless of what it declares. Fixing it needs the working directory
 * itself to move per crate, which is bigger than this slice — named here rather than
 * discovered by a client wondering why a crate's own rustflags never applied.
 */
async function checkCargo(
  cfg: SandboxConfig,
  worktree: string,
  cacheDir: string,
  scratch: string,
  manifest: string,
  dir: string,
  engine: "cargo-check" | "cargo-clippy",
  subcommand: "check" | "clippy",
): Promise<EngineOutcome> {
  // lore-ok[f2b0d6c3]: fixed further down in this same function, at the
  // `cargoToolMissing(r)` check right before the fallback to `scriptFinding` — a
  // missing `cargo-clippy` binary is now told apart from a genuine lint failure
  // before either can reach the opaque, high-severity "fails on this branch"
  // framing. `cargoToolMissing` itself (defined above `sandboxedCargo`) carries
  // the fuller reasoning, including the two rounds of findings that shaped it.
  const r = await runInSandbox(
    cfg,
    worktree,
    cacheDir,
    scratch,
    `${CARGO_ENV} cargo ${subcommand} --manifest-path ${shQuote(manifest)} --offline --message-format=json`,
    false,
    CARGO_MOUNT,
  );
  if (r.unavailable !== undefined) return { engine, findings: [], unavailable: r.unavailable, interrupted: r.timedOut };
  if (ranOutOfMemory(r)) return scriptFinding(engine, `cargo ${subcommand}`, r, manifest);
  // PARSED FROM STDOUT ALONE — cargo's own `--message-format=json` contract keeps
  // the JSONL there and human-readable progress on stderr, unlike tsc's murkier,
  // wrapper-dependent convention `checkTypes` has to allow for. Parsed first: a
  // compiler error is an EXPECTED non-zero exit, not a failure to hide.
  //
  // `dir`, not `worktree` — found by lore's own review, fingerprint 47ddd7fa, and
  // confirmed empirically (a real `cargo check --manifest-path server/Cargo.toml`
  // run from the repo root, against a scratch fixture): cargo reports `file_name`
  // relative to the MANIFEST's own directory, not the repo root and not absolute.
  // `parseCargoJson` rebases onto `dir` itself now; passing the worktree here would
  // have been not just unhelpful but actively wrong for any nested crate.
  const parsed = parseCargoJson(engine, r.stdout, dir);
  if (parsed.length > 0) return { engine, findings: parsed };
  if (r.ok) return { engine, findings: [] };
  // `cargo fetch` already succeeded, so a MISSING CARGO is not the likely
  // explanation here — but `cargo-clippy` is its own binary (cargo discovers
  // subcommands as `cargo-<name>` on PATH, the same convention any third-party
  // subcommand uses), a separate rustup component / distro package from bare
  // cargo, and can be absent when cargo itself works fine. Found by lore's own
  // review, fingerprint f2b0d6c3: without this, an image with cargo but no
  // clippy component would report a false, high-severity "cargo clippy fails on
  // this branch" on every single review, forever, settleable by no code change.
  //
  // `cargoToolMissing`, not a bare text match on its own — see that function's
  // own doc comment. A rustup toolchain that HAS cargo but lacks the clippy
  // component fails a different way than a plain missing binary does (found by
  // lore's own review, fingerprint c618f5cb, and confirmed by actually removing
  // the component from a real local toolchain: `error: 'cargo-clippy' is not
  // installed for the toolchain '…'`, exit 1 — neither the exit code nor the
  // message `cargoToolMissing`'s first version checked), and a text match with
  // no other requirement would also match a target's own `build.rs` printing
  // similar text as part of a genuine failure (fingerprint 57dea7e8) — the same
  // class of over-broad hedge fingerprint 01270153 already fixed once for the
  // fetch step above.
  if (cargoToolMissing(r)) {
    return { engine, findings: [], unavailable: `${subcommand === "clippy" ? "clippy" : "cargo"} is not available in the sandbox image` };
  }
  // By this point `cargo fetch` already succeeded and the tool itself responded,
  // so this is a genuine, opaque failure of the project's own gate.
  return scriptFinding(engine, `cargo ${subcommand}`, r, manifest);
}

/** The scripts a target declares, which are the ones it actually runs. */
async function packageScripts(worktree: string): Promise<Record<string, string>> {
  const raw = await readFile(join(worktree, "package.json"), "utf8").catch(() => undefined);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * A process WE killed did not fail — it did not run.
 *
 * Docker reports SIGKILL as exit 137, and the usual cause here is our own
 * `--memory` limit: a monorepo running `turbo run typecheck` fans out across every
 * package at once. Reporting that as "the project's gate fails on this branch" is a
 * confident false statement about someone else's code — the exact failure INV-1
 * names, made worse by being high severity and pointed at a branch whose typecheck
 * actually passes.
 */
export const KILLED = 137;

/**
 * A memory limit that ends a run one of two CONFIRMED ways — not an exhaustive
 * detector, see the note on `scriptFinding`'s genuine-failure arm below for what
 * this deliberately does not chase. `KILLED` alone only recognises the cgroup's
 * own SIGKILL from OUTSIDE the process, found by lore's own review of the
 * original fix, fingerprint cbb6824f: V8 can also give up on ITS OWN heap ceiling
 * and abort ITSELF — typically exit 134, but the exit code alone is not
 * distinctive (134 is plain SIGABRT, and a real native-module crash could produce
 * it too) — so this also checks for the fatal error V8 actually prints. The
 * ticket that motivated `KILLED` never said which of the two lore's own tsc check
 * hit; only one of them was covered at first.
 *
 * THE FULL PHRASE, NOT THE SHORT ONE — found by lore's own review of that fix,
 * fingerprint 9171c6c9: checked before the parse and regardless of exit code, so
 * matching on the bare words "JavaScript heap out of memory" would treat ANY
 * output containing that sentence as an OOM, target-controlled content included —
 * and after this fix landed, this repository's OWN source (this comment, this
 * file's tests) contains exactly that sentence, discussing it. V8's actual crash
 * always emits the longer, fixed phrase below verbatim (hardcoded in V8 itself,
 * stable across versions); requiring it — rather than a fragment short enough to
 * appear in ordinary prose — is what makes this a signal about the process's own
 * fate rather than a claim about what the target wrote.
 *
 * `!r.ok` GATES THE CONTENT MATCH TOO — found by lore's own review of that fix,
 * fingerprint a7f2d87c: a run that exits 0 is not the process WE killed, whatever
 * its logs happen to contain — a build step that catches and retries a child's
 * OOM, say, then finishes and exits clean. Without this gate, that success would
 * still read as "did not complete." The `KILLED` arm never needed the gate (137
 * cannot be `ok`), but it costs nothing to state once for both.
 */
function ranOutOfMemory(r: { ok: boolean; code: number; stdout: string; stderr: string }): boolean {
  return !r.ok && (r.code === KILLED || `${r.stdout}\n${r.stderr}`.includes("Allocation failed - JavaScript heap out of memory"));
}

/**
 * A failed script becomes one finding carrying its tail. Its output is not a format.
 *
 * `file` defaults to `package.json` — right for every npm-family caller (tsc,
 * eslint), which is what every call site but `checkCargo`'s is. Fingerprint
 * 2060d1f6: `checkCargo`'s own genuine-failure call sites left it at the default,
 * so an opaque cargo failure on a Rust repo with no root `package.json` at all
 * (this module's own named shape, `teammater`) named a file that resolves nowhere
 * — the same never-settles defect the FETCH-failure arm two functions up was
 * already fixed for (fingerprint 47ddd7fa) and this shared helper was missed by.
 */
export function scriptFinding(
  engine: string,
  script: string,
  r: { ok: boolean; stdout: string; stderr: string; code: number },
  file = "package.json",
): EngineOutcome {
  if (ranOutOfMemory(r)) {
    return {
      engine: engine as T0Engine,
      findings: [],
      unavailable:
        `\`${script}\` did not complete (${r.code === KILLED ? `killed, exit ${KILLED}` : "ran out of memory"}) — ` +
        `almost always a memory limit, not a fault in the branch. Nothing it would have found is known either way.`,
      interrupted: true,
    };
  }
  return {
    engine: engine as T0Engine,
    findings: [
      {
        file,
        severity: "high",
        claim: `\`${script}\` fails on this branch`,
        evidence: `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-40).join("\n").slice(0, 2000),
        failureScenario: "this is the project's own gate, and it does not pass",
      },
    ],
  };
}

async function checkTypes(
  cfg: SandboxConfig,
  worktree: string,
  cacheDir: string,
  scratch: string,
  cmds: Toolchain,
  scripts: Record<string, string>,
): Promise<EngineOutcome> {
  if (scripts["typecheck"] !== undefined) {
    const r = await runInSandbox(cfg, worktree, cacheDir, scratch, cmds.run("typecheck"), false);
    // `interrupted: r.timedOut`, fingerprint dd36a31b — same reasoning as the
    // install site above: a timeout is a third way this did not finish.
    if (r.unavailable !== undefined) return { engine: "tsc", findings: [], unavailable: r.unavailable, interrupted: r.timedOut };
    // CHECKED BEFORE THE PARSE, for both signals `ranOutOfMemory` currently
    // confirms — a monorepo's `turbo run typecheck` fans out across every package,
    // and when a memory limit stops it partway through, packages that had ALREADY
    // finished still leave real, parseable tsc output sitting in the buffer.
    // Parsing that first and returning whatever it found — the order below, for
    // every OTHER non-zero exit — would silently turn a run stopped before
    // covering the whole monorepo into what reads as a complete pass with a few
    // findings: exactly the INV-1 shape this file's own OOM handling exists to
    // prevent, reached by skipping past it whenever ANY package happened to report
    // before the process gave out. A client must never have to work out that "some
    // findings, no mention of the rest" meant "we ran out of memory," which is
    // ours to prevent, not theirs to puzzle out.
    //
    // lore-ok[6bc20289]: "for both signals `ranOutOfMemory` currently confirms" is
    // deliberately not a completeness claim — a memory limit can end a run other
    // ways this does not recognise (a Rust-based runner's own allocator message,
    // a Go binary's "fatal error: runtime: out of memory"). Those are real but
    // unbounded — every toolchain a target could run has its own crash text — and
    // chasing them turns a fix for a confirmed incident into an open-ended
    // allowlist with no natural stopping point. (A bare host binary's own SIGKILL
    // used to be a THIRD example here — exec.ts collapsed a signal death to a
    // plain exit code — but that is now translated to the POSIX convention this
    // check already reads, fingerprint 88fccc85/fdf8a29e/1b65dcdd, so it is one
    // less case this lore-ok has to cover.)
    //
    // CORRECTED, fingerprint 24b65f50: an earlier version of this note claimed an
    // undetected case always degrades to a misattributed-but-honest signal — false
    // on the branch four lines down. When `parseTsc` finds SOME real lines before
    // an undetected interruption, `parsed.length > 0` returns them directly,
    // never reaching `scriptFinding` at all — the ORIGINAL bug this whole fix
    // exists for, not a lesser one, for exactly the toolchains this lore-ok
    // declines to chase. Accepted anyway: closing it needs the same unbounded
    // signature-matching this lore-ok already argues against, and this repo's own
    // `turbo` scenario is covered (137 IS `ranOutOfMemory`'s first signal, and now
    // reachable however docker itself reports it — see the SIGKILL note above). A
    // DIFFERENT runner's own kill text, found live, is what should extend it —
    // guessing at one now, unverified, risks the same false confidence this
    // incident started from.
    //
    // SHARPENED, fingerprint 8e820dae: the same undetected case also leaves
    // `interrupted` unset on this path — inherent to the same boundary, not a
    // separate gap: `interrupted` means DETECTED, and this whole note is about
    // the case that, by construction, is not. Extending detection is what would
    // set it, which is exactly the unbounded work declined above.
    if (ranOutOfMemory(r)) return scriptFinding("tsc", `${cmds.name} run typecheck`, r);
    // Still try the structured parse: a monorepo runner usually forwards tsc's own
    // lines, and per-file findings beat one blob whenever we can get them.
    const parsed = parseTsc(`${r.stdout}\n${r.stderr}`);
    if (parsed.length > 0) return { engine: "tsc", findings: parsed };
    return r.ok ? { engine: "tsc", findings: [] } : scriptFinding("tsc", `${cmds.name} run typecheck`, r);
  }
  if (!existsSync(join(worktree, "tsconfig.json"))) {
    return { engine: "tsc", findings: [], unavailable: "no `typecheck` script and no root tsconfig.json" };
  }
  const r = await runInSandbox(cfg, worktree, cacheDir, scratch, "npx --no-install tsc --noEmit --pretty false", false);
  // `interrupted: r.timedOut`, fingerprint dd36a31b.
  if (r.unavailable !== undefined) return { engine: "tsc", findings: [], unavailable: r.unavailable, interrupted: r.timedOut };
  // This branch never routed through `scriptFinding` at all, for ANY non-zero exit
  // — so a run stopped by a memory limit here (single-project `tsc --noEmit`, no
  // monorepo runner involved) fell through to `parseTsc` unconditionally, on output
  // that usually truncates to nothing: `findings: []`, indistinguishable from tsc
  // actually running clean. The sharpest form of the same bug fixed above.
  if (ranOutOfMemory(r)) return scriptFinding("tsc", "npx tsc --noEmit", r);
  // Found by lore's own review, fingerprint fde373d4: the check above closed the
  // memory-limit exit of a wider hole this branch had — an unrelated non-zero exit
  // whose output does not happen to match `TSC_LINE` still fell through to
  // `findings: parseTsc(...)`, empty, with no `unavailable` — a run that never
  // completed, reading as a clean pass.
  const parsed = parseTsc(`${r.stdout}\n${r.stderr}`);
  if (parsed.length > 0) return { engine: "tsc", findings: parsed };
  if (r.ok) return { engine: "tsc", findings: [] };
  // NOT `scriptFinding` here — found by lore's own review of the fix above,
  // fingerprint 1fa9229d: unlike the typecheck-script branch, where the target
  // itself declared this command as its gate, THIS branch runs tsc speculatively —
  // triggered only by a tsconfig.json existing, which a repo can carry for editor
  // support or another tool's path-mapping with no `typescript` devDependency
  // behind it at all. `scriptFinding`'s genuine-failure arm claims "this is the
  // project's own gate, and it does not pass" — too strong when the likelier
  // explanation is that tsc was never installed to begin with, exactly the
  // "a tool that is not there is a check that did not run" distinction exec.ts
  // already draws for the outer, unsandboxed case.
  return {
    engine: "tsc",
    findings: [],
    unavailable: "`npx tsc --noEmit` did not exit cleanly and produced no parseable output — most likely not installed, so nothing is claimed about the branch",
  };
}

async function checkLint(
  cfg: SandboxConfig,
  worktree: string,
  cacheDir: string,
  scratch: string,
  cmds: Toolchain,
  scripts: Record<string, string>,
): Promise<EngineOutcome> {
  if (scripts["lint"] !== undefined) {
    const r = await runInSandbox(cfg, worktree, cacheDir, scratch, cmds.run("lint"), false);
    // `interrupted: r.timedOut`, fingerprint dd36a31b — same reasoning as tsc above.
  if (r.unavailable !== undefined) return { engine: "eslint", findings: [], unavailable: r.unavailable, interrupted: r.timedOut };
    return r.ok ? { engine: "eslint", findings: [] } : scriptFinding("eslint", `${cmds.name} run lint`, r);
  }
  if (!detect(worktree, "eslint")) {
    return { engine: "eslint", findings: [], unavailable: "no `lint` script and no eslint config" };
  }
  const r = await runInSandbox(cfg, worktree, cacheDir, scratch, "npx --no-install eslint . --format json", false);
  // `interrupted: r.timedOut`, fingerprint dd36a31b — same reasoning as tsc above.
  if (r.unavailable !== undefined) return { engine: "eslint", findings: [], unavailable: r.unavailable, interrupted: r.timedOut };
  // Same fix as both `tsc` branches above: checked explicitly rather than left to
  // fall through as "unparseable output" — true in practice (a run cut short by a
  // memory limit usually truncates eslint's single trailing JSON blob), but the
  // wrong REASON reported. "Unparseable" reads as an eslint or config problem; a
  // memory limit is the honest one and points at the right place to fix it.
  if (ranOutOfMemory(r)) return scriptFinding("eslint", "npx eslint .", r);
  // SANDBOX_CWD, NOT `worktree` — eslint's JSON formatter reports `filePath`
  // absolute, and this process ran inside the container with its cwd (and every
  // file it can see) under SANDBOX_CWD, never under the host worktree path.
  // Passing `worktree` here left every sandboxed eslint finding's `file` as the
  // container path verbatim (`/work/src/foo.ts`) — resolvable nowhere on the host,
  // so `scopeOf` could never read it and the finding could never settle. Found by
  // lore's own review, fingerprint 6af88f4d.
  const parsed = parseEslint(r.stdout, SANDBOX_CWD);
  return parsed === undefined
    ? { engine: "eslint", findings: [], unavailable: "eslint produced unparseable output" }
    : { engine: "eslint", findings: parsed };
}

/**
 * How many T0 findings the prompt lists before it stops. Unchanged from when this was
 * written — what changed is *which* ones survive the cut (see below).
 */
const LISTED = 200;

/** Render T0's result for a model prompt. */
/** What a session was last SHOWN of t0, compact enough for a meta row (D-108). */
export interface SeenT0 {
  readonly fingerprint: string;
  readonly file: string;
  readonly line?: number | undefined;
  readonly severity: string;
  readonly claim: string;
}

/**
 * t0 for a session that has already seen a full render: the DELTA, not the repeat.
 *
 * A kept session's fix message used to re-render every still-present finding — dozens of
 * lines the session already holds, on every boundary and every re-pinned round, which is
 * the cold-start tax D-80 removed, paid again in miniature. The session's memory carries
 * the unchanged ones; what it needs is what MOVED: findings the new tree resolved,
 * findings the new tree introduced, and the count that stayed.
 *
 * The NOT-RUN section is never delta'd: an engine that could not run must be said every
 * time, because "nothing checked this" is the one fact repetition cannot cheapen (INV-1).
 */
export function renderT0Delta(prev: readonly SeenT0[], cur: T0Result, fp: (f: Finding) => string): string {
  const parts: string[] = [];
  const prevBy = new Map(prev.map((p) => [p.fingerprint, p]));
  const curBy = new Map(cur.findings.map((f) => [fp(f), f]));
  const fresh = [...curBy.entries()].filter(([k]) => !prevBy.has(k)).map(([, f]) => f);
  // AN INTERRUPTED ROUND'S SILENCE PROVES NOTHING about a previously-seen finding
  // that is absent from `cur.findings` — it may be fixed, or the engine that would
  // have re-raised it simply did not finish. Found by lore's own review of the
  // OOM-kill fix, fingerprint 4a39ae0d: claiming "resolved" here during exactly
  // the round t0 could not confirm is the same false-improvement claim
  // `settleFixed` (reviewer/review.ts) makes with its verdict, aimed at the
  // model's own memory of the review instead of the store — and a session that
  // drops a still-real finding from its memory only recovers it if t0 happens to
  // re-raise it as though it were new.
  const missing = [...prevBy.values()].filter((p) => !curBy.has(p.fingerprint));
  const resolved = cur.interrupted ? [] : missing;
  const unconfirmed = cur.interrupted ? missing : [];
  const unchanged = cur.findings.length - fresh.length;

  if (fresh.length === 0 && resolved.length === 0 && unconfirmed.length === 0) {
    parts.push(
      cur.findings.length === 0
        ? "Deterministic tooling: still nothing."
        : `Deterministic tooling: unchanged — the ${String(unchanged)} issue(s) you already know still stand.`,
    );
  } else {
    parts.push(
      `Deterministic tooling on the new tree: ${String(resolved.length)} resolved, ${String(fresh.length)} new, ` +
        `${String(unchanged)} unchanged` +
        `${unconfirmed.length === 0 ? "" : `, ${String(unconfirmed.length)} unconfirmed (t0 was interrupted)`}.`,
    );
    for (const p of resolved) {
      parts.push(`  resolved: ${p.file}${p.line !== undefined ? `:${String(p.line)}` : ""} — ${p.claim}`);
    }
    if (unconfirmed.length > 0) {
      parts.push("  t0 did not finish this round (see NOT RUN below) — still treat these as open, not resolved:");
      for (const p of unconfirmed) {
        parts.push(`    ${p.file}${p.line !== undefined ? `:${String(p.line)}` : ""} — ${p.claim}`);
      }
    }
    const ordered = [...fresh].sort(compareFindings);
    for (const f of ordered.slice(0, LISTED)) {
      parts.push(`  [${f.severity}] NEW ${f.file}${f.line !== undefined ? `:${String(f.line)}` : ""} — ${f.claim}`);
    }
    if (ordered.length > LISTED) {
      parts.push(`  … and ${String(ordered.length - LISTED)} more new, none more severe than the last line above`);
    }
  }

  if (cur.unavailable.length > 0) {
    parts.push("", "NOT RUN — do not treat these as clean; nothing checked them:", ...cur.unavailable.map((u) => `  ${u}`));
  }
  parts.push("", "Do not re-report anything above. It is already known.");
  return parts.join("\n");
}

export function renderT0(r: T0Result): string {
  const parts: string[] = [];

  if (r.findings.length === 0) {
    parts.push("Deterministic tooling found nothing.");
  } else {
    // Worst first, and sorted BEFORE the cut. These arrive grouped by engine, in the
    // order the review type lists them — `tsc, eslint, ast-grep, semgrep` for
    // code-arch — so 200+ eslint findings used to displace everything semgrep said,
    // including its `high` ones. Those findings are still recorded and still reach
    // the client — `runRound` records all of T0's — but the tier judged the code
    // without having been told about them (D-50).
    const ordered = [...r.findings].sort(compareFindings);
    parts.push(`Deterministic tooling found ${r.findings.length} issue(s):`);
    for (const f of ordered.slice(0, LISTED)) {
      parts.push(`  [${f.severity}] ${f.file}${f.line !== undefined ? `:${f.line}` : ""} — ${f.claim}`);
    }
    if (ordered.length > LISTED) {
      parts.push(`  … and ${ordered.length - LISTED} more, none more severe than the last line above`);
    }
  }

  if (r.unavailable.length > 0) {
    parts.push(
      "",
      "NOT RUN — do not treat these as clean; nothing checked them:",
      ...r.unavailable.map((u) => `  ${u}`),
    );
  }

  parts.push("", "Do not re-report anything above. It is already known.");
  return parts.join("\n");
}
