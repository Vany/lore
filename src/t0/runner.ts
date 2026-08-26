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
import { detect, parseEslint, parseTsc, runEngine, type EngineOutcome } from "./engines.ts";
import {
  commandsFor,
  DEFAULT_SANDBOX,
  install,
  lockfileKey,
  runInSandbox,
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

  // HOST ENGINES RUN CONCURRENTLY WITH THE SANDBOX, not before it (D-127).
  //
  // The two share no state: host engines are lore's own binaries reading `worktree`
  // read-only, and the sandbox works entirely inside its own `/work` copy and its own
  // node_modules cache. Before this they ran one after the other, so a two-second
  // ast-grep/semgrep pair sat and waited for an unrelated multi-minute install for no
  // reason beyond the order they happened to be written in. Engines within each group
  // are independent of each other too — same reasoning, `Promise.all` rather than a
  // loop.
  const hostEngines = opts.engines.filter((e) => e !== "tsc" && e !== "eslint");
  const [hostOutcomes, sandboxOutcomes] = await Promise.all([
    Promise.all(hostEngines.map((engine) => runEngine(worktree, engine, files))),
    sandboxed(worktree, opts.sandbox ?? DEFAULT_SANDBOX, opts.engines),
  ]);
  const outcomes = [...hostOutcomes, ...sandboxOutcomes];

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
      if (installed.unavailable !== undefined) {
        return wanted.map((engine) => ({
          engine,
          findings: [],
          unavailable: `install could not run: ${installed.unavailable ?? ""}`,
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

/** A failed script becomes one finding carrying its tail. Its output is not a format. */
export function scriptFinding(
  engine: string,
  script: string,
  r: { ok: boolean; stdout: string; stderr: string; code: number },
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
        file: "package.json",
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
    if (r.unavailable !== undefined) return { engine: "tsc", findings: [], unavailable: r.unavailable };
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
    // a Go binary's "fatal error: runtime: out of memory", a signal death exec.ts's
    // own mapping collapses to a plain exit code). Those are real but unbounded —
    // every toolchain a target could run has its own crash text — and chasing
    // them turns a fix for a confirmed incident into an open-ended allowlist with
    // no natural stopping point. An undetected case still is not silence: it
    // reaches `scriptFinding`'s genuine-failure arm below (a HIGH finding) or, on
    // the bare-invocation branches, `unavailable` — a real signal that something
    // did not go cleanly, misattributing the REASON rather than the ORIGINAL bug
    // this fix exists for (a stopped run silently read as complete and clean).
    // Extended the way cbb6824f and 9171c6c9 already did, if one is found live.
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
  if (r.unavailable !== undefined) return { engine: "tsc", findings: [], unavailable: r.unavailable };
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
    if (r.unavailable !== undefined) return { engine: "eslint", findings: [], unavailable: r.unavailable };
    return r.ok ? { engine: "eslint", findings: [] } : scriptFinding("eslint", `${cmds.name} run lint`, r);
  }
  if (!detect(worktree, "eslint")) {
    return { engine: "eslint", findings: [], unavailable: "no `lint` script and no eslint config" };
  }
  const r = await runInSandbox(cfg, worktree, cacheDir, scratch, "npx --no-install eslint . --format json", false);
  if (r.unavailable !== undefined) return { engine: "eslint", findings: [], unavailable: r.unavailable };
  // Same fix as both `tsc` branches above: checked explicitly rather than left to
  // fall through as "unparseable output" — true in practice (a run cut short by a
  // memory limit usually truncates eslint's single trailing JSON blob), but the
  // wrong REASON reported. "Unparseable" reads as an eslint or config problem; a
  // memory limit is the honest one and points at the right place to fix it.
  if (ranOutOfMemory(r)) return scriptFinding("eslint", "npx eslint .", r);
  const parsed = parseEslint(r.stdout, worktree);
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
