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
import { mkdir, readFile, rm } from "node:fs/promises";
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
  runTests as runTestsIn,
  testFindings,
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
}

export interface T0Options {
  readonly engines: readonly T0Engine[];
  readonly sandbox?: SandboxConfig;
  /** Tests are opt-in per deployment: they execute arbitrary project code. */
  readonly runTests?: boolean;
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

export async function runT0(worktree: string, opts: T0Options): Promise<T0Result> {
  const outcomes: EngineOutcome[] = [];

  // Host-safe engines only: lore's own binaries, reading files.
  for (const engine of opts.engines) {
    if (engine === "tsc" || engine === "eslint" || engine === "tests") continue;
    outcomes.push(await runEngine(worktree, engine));
  }

  // Everything that needs the target's node_modules runs in the sandbox, together,
  // off one install.
  outcomes.push(
    ...(await sandboxed(worktree, opts.sandbox ?? DEFAULT_SANDBOX, opts.engines, opts.runTests === true)),
  );

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
  runTests: boolean,
): Promise<EngineOutcome[]> {
  const wanted = engines.filter((e) => e === "tsc" || e === "eslint" || e === "tests");
  if (wanted.length === 0) return [];

  const cmds = await commandsFor(worktree);
  if (cmds === undefined) {
    return wanted.map((engine) => ({
      engine,
      findings: [],
      unavailable: "this repository uses bun, which the sandbox image does not carry",
    }));
  }

  const scripts = await packageScripts(worktree);
  const cacheDir = join(cfg.cacheRoot, await lockfileKey(worktree));
  await mkdir(cacheDir, { recursive: true });
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
    const installed = await withInstallLock(cacheDir, () => install(cfg, worktree, cacheDir, scratch, cmds));
    if (installed.unavailable !== undefined) {
      return wanted.map((engine) => ({
        engine,
        findings: [],
        unavailable: `install could not run: ${installed.unavailable ?? ""}`,
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
    if (wanted.includes("tests")) {
      out.push(
        runTests
          ? await suite(cfg, worktree, cacheDir, scratch, cmds, scripts)
          : { engine: "tests", findings: [], unavailable: "test execution is disabled for this deployment" },
      );
    }
    return out;
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

/** A failed script becomes one finding carrying its tail. Its output is not a format. */
export function scriptFinding(
  engine: string,
  script: string,
  r: { stdout: string; stderr: string; code: number },
): EngineOutcome {
  if (r.code === KILLED) {
    return {
      engine: engine as T0Engine,
      findings: [],
      unavailable:
        `\`${script}\` was killed (exit ${KILLED}) — almost always the sandbox memory limit, ` +
        `not a fault in the branch. Nothing it would have found is known either way.`,
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
  return { engine: "tsc", findings: parseTsc(`${r.stdout}\n${r.stderr}`) };
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
  const parsed = parseEslint(r.stdout, worktree);
  return parsed === undefined
    ? { engine: "eslint", findings: [], unavailable: "eslint produced unparseable output" }
    : { engine: "eslint", findings: parsed };
}

async function suite(
  cfg: SandboxConfig,
  worktree: string,
  cacheDir: string,
  scratch: string,
  cmds: Toolchain,
  scripts: Record<string, string>,
): Promise<EngineOutcome> {
  if (scripts["test"] === undefined) {
    return { engine: "tests", findings: [], unavailable: "this repository declares no `test` script" };
  }
  const tests = await runTestsIn(cfg, worktree, cacheDir, scratch, cmds);
  if (tests.unavailable !== undefined && !tests.timedOut) {
    return { engine: "tests", findings: [], unavailable: tests.unavailable };
  }
  // A timeout IS a fact about the suite and stays a finding — "did not finish" and
  // "fails" are different claims and both are the branch's. A KILL is ours: the
  // memory limit stopping a fan-out says nothing about the tests.
  if (tests.code === KILLED && !tests.timedOut) {
    return {
      engine: "tests",
      findings: [],
      unavailable: `the suite was killed (exit ${KILLED}) — almost always the sandbox memory limit, not a failing test`,
    };
  }
  return { engine: "tests", findings: testFindings(tests) };
}


/**
 * How many T0 findings the prompt lists before it stops. Unchanged from when this was
 * written — what changed is *which* ones survive the cut (see below).
 */
const LISTED = 200;

/** Render T0's result for a model prompt. */
export function renderT0(r: T0Result): string {
  const parts: string[] = [];

  if (r.findings.length === 0) {
    parts.push("Deterministic tooling found nothing.");
  } else {
    // Worst first, and sorted BEFORE the cut. These arrive grouped by engine, in the
    // order the review type lists them — `tsc, eslint, ast-grep, semgrep, tests` for
    // code-arch — so 200+ eslint findings used to displace everything every later
    // engine said: semgrep's `high` findings, and the two the tests stage raises
    // (`installAndTest` above, and `testFindings` in sandbox.ts). Those findings are
    // still recorded and still reach the client — `runRound` records all of T0's —
    // but the tier judged the code without being told the suite fails (D-50).
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
