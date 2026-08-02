/**
 * The T0 tier: run every deterministic engine the review type asks for.
 *
 * The important output is not just the findings — it is also the honest list of
 * what could **not** be run. A repo with no typechecker is a fact the model tiers
 * need, because it tells them what they must look for themselves. Silently
 * reporting "T0 clean" for a repo where nothing ran would be the purest form of
 * INV-1's failure.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../core/finding.ts";
import type { T0Engine } from "../core/review-type.ts";
import { runEngine, type EngineOutcome } from "./engines.ts";
import { DEFAULT_SANDBOX, install, lockfileKey, runTests, testFindings, type SandboxConfig } from "./sandbox.ts";

export interface T0Result {
  readonly findings: readonly Finding[];
  readonly outcomes: readonly EngineOutcome[];
  /** Engines that did not run, and why. Goes into the model prompt verbatim. */
  readonly unavailable: readonly string[];
}

export interface T0Options {
  readonly engines: readonly T0Engine[];
  readonly sandbox?: SandboxConfig;
  /** Tests are opt-in per deployment: they execute arbitrary project code. */
  readonly runTests?: boolean;
}

export async function runT0(worktree: string, opts: T0Options): Promise<T0Result> {
  const outcomes: EngineOutcome[] = [];

  for (const engine of opts.engines) {
    if (engine === "tests") continue; // handled below; it needs the sandbox
    outcomes.push(await runEngine(worktree, engine));
  }

  if (opts.engines.includes("tests") && opts.runTests === true) {
    outcomes.push(await runSuite(worktree, opts.sandbox ?? DEFAULT_SANDBOX));
  } else if (opts.engines.includes("tests")) {
    outcomes.push({
      engine: "tests",
      findings: [],
      unavailable: "test execution is disabled for this deployment",
    });
  }

  return {
    findings: outcomes.flatMap((o) => o.findings),
    outcomes,
    unavailable: outcomes
      .filter((o) => o.unavailable !== undefined)
      .map((o) => `${o.engine}: ${o.unavailable ?? ""}`),
  };
}

async function runSuite(worktree: string, cfg: SandboxConfig): Promise<EngineOutcome> {
  const cacheDir = join(cfg.cacheRoot, await lockfileKey(worktree));
  await mkdir(cacheDir, { recursive: true });

  const installed = await install(cfg, worktree, cacheDir);
  if (installed.unavailable !== undefined) {
    return { engine: "tests", findings: [], unavailable: `install could not run: ${installed.unavailable}` };
  }
  if (!installed.ok) {
    // Dependencies that will not install is itself a finding — and on the arm64
    // deployment host it is the specific risk flagged in PLAN.md §4.1.
    return {
      engine: "tests",
      findings: [
        {
          file: "package.json",
          severity: "high",
          claim: "dependencies do not install, so the suite could not be run",
          evidence: `${installed.stdout}\n${installed.stderr}`.trim().split("\n").slice(-30).join("\n").slice(0, 2000),
          failureScenario:
            "nothing that depends on a working install can be verified here — including every claim the tests would have made",
        },
      ],
      unavailable: "dependencies failed to install",
    };
  }

  const tests = await runTests(cfg, worktree, cacheDir);
  if (tests.unavailable !== undefined && !tests.timedOut) {
    return { engine: "tests", findings: [], unavailable: tests.unavailable };
  }
  return { engine: "tests", findings: testFindings(tests) };
}

/** Render T0's result for a model prompt. */
export function renderT0(r: T0Result): string {
  const parts: string[] = [];

  if (r.findings.length === 0) {
    parts.push("Deterministic tooling found nothing.");
  } else {
    parts.push(`Deterministic tooling found ${r.findings.length} issue(s):`);
    for (const f of r.findings.slice(0, 200)) {
      parts.push(`  [${f.severity}] ${f.file}${f.line !== undefined ? `:${f.line}` : ""} — ${f.claim}`);
    }
    if (r.findings.length > 200) parts.push(`  … and ${r.findings.length - 200} more`);
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
