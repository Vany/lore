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
  const resolved = [...prevBy.values()].filter((p) => !curBy.has(p.fingerprint));
  const unchanged = cur.findings.length - fresh.length;

  if (fresh.length === 0 && resolved.length === 0) {
    parts.push(
      cur.findings.length === 0
        ? "Deterministic tooling: still nothing."
        : `Deterministic tooling: unchanged — the ${String(unchanged)} issue(s) you already know still stand.`,
    );
  } else {
    parts.push(
      `Deterministic tooling on the new tree: ${String(resolved.length)} resolved, ${String(fresh.length)} new, ` +
        `${String(unchanged)} unchanged.`,
    );
    for (const p of resolved) {
      parts.push(`  resolved: ${p.file}${p.line !== undefined ? `:${String(p.line)}` : ""} — ${p.claim}`);
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
