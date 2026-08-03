/**
 * T0 engines: deterministic checks, normalised into findings.
 *
 * An LLM must never be paid to decide what a typechecker decides for free,
 * deterministically, in one second (D-8). CodeRabbit runs 50+ analysers alongside
 * its model; this is the same idea, and it does double duty — it catches the
 * mechanical defects *and*, by removing them, stops them crowding out the findings
 * only a model can produce.
 *
 * Every engine runs the **target repo's own** configuration. A project's config is
 * what that team actually enforces; imposing ours would manufacture findings they
 * have already rejected.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Severity } from "../core/finding.ts";
import type { T0Engine } from "../core/review-type.ts";
import { queryComponents, toFindings } from "../security/osv.ts";
import { generateSbom } from "../security/sbom.ts";
import { runTool } from "./exec.ts";

export interface EngineOutcome {
  readonly engine: T0Engine;
  readonly findings: readonly Finding[];
  /**
   * Set when the engine could not run. Distinct from "ran and found nothing" —
   * conflating them is the whole of INV-1.
   */
  readonly unavailable?: string;
}

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function finding(f: {
  file: string;
  line?: number;
  severity: Severity;
  claim: string;
  evidence: string;
  failureScenario: string;
  cwe?: string;
}): Finding {
  return {
    file: f.file,
    ...(f.line !== undefined ? { line: f.line } : {}),
    severity: f.severity,
    claim: cap(f.claim.replace(/\s+/g, " ").trim(), 300),
    evidence: cap(f.evidence, 2000),
    failureScenario: cap(f.failureScenario, 2000),
    ...(f.cwe !== undefined ? { cwe: f.cwe } : {}),
  };
}

/** Is this engine configured in the target at all? */
export function detect(worktree: string, engine: T0Engine): boolean {
  switch (engine) {
    case "tsc":
      return existsSync(join(worktree, "tsconfig.json"));
    case "eslint":
      return ["eslint.config.js", "eslint.config.mjs", "eslint.config.ts", ".eslintrc.json", ".eslintrc.cjs"].some(
        (f) => existsSync(join(worktree, f)),
      );
    case "ast-grep":
      return existsSync(join(worktree, "sgconfig.yml")) || existsSync(join(worktree, "sgconfig.yaml"));
    case "semgrep":
      // Semgrep needs no project config: the registry rulesets are the value, and
      // they carry CWE metadata that lands in the same namespace as model findings.
      return true;
    case "sbom":
    case "osv":
      return existsSync(join(worktree, "package.json"));
    case "tests":
      return existsSync(join(worktree, "package.json"));
    default:
      return false;
  }
}

export async function runEngine(worktree: string, engine: T0Engine): Promise<EngineOutcome> {
  if (!detect(worktree, engine)) {
    return { engine, findings: [], unavailable: `${engine} is not configured in this repo` };
  }
  switch (engine) {
    case "tsc":
      return tsc(worktree);
    case "eslint":
      return eslint(worktree);
    case "semgrep":
      return semgrep(worktree);
    case "ast-grep":
      return astGrep(worktree);
    case "sbom":
      return sbom(worktree);
    case "osv":
      return osv(worktree);
    default:
      return { engine, findings: [], unavailable: `${engine} has no runner` };
  }
}

// ------------------------------------------------------------- sbom and osv

/**
 * Enumerate what is shipped.
 *
 * Emits a finding only when the tree *cannot* be enumerated — you cannot security-
 * review dependencies you were unable to list, and reporting that as "no
 * vulnerabilities" would be the worst possible reading of INV-1.
 */
async function sbom(worktree: string): Promise<EngineOutcome> {
  const bom = await generateSbom(worktree);
  if (bom.source === "none") {
    return {
      engine: "sbom",
      findings: [
        finding({
          file: "package.json",
          severity: "medium",
          claim: "the dependency tree could not be enumerated, so it was not checked for known vulnerabilities",
          evidence: bom.note ?? "no SBOM produced",
          failureScenario:
            "every published vulnerability in this tree is unexamined — this is 'not checked', not 'nothing found'",
        }),
      ],
      unavailable: bom.note ?? "no SBOM produced",
    };
  }
  return { engine: "sbom", findings: [] };
}

/**
 * Match the tree against OSV.
 *
 * Produces *candidates*: a vulnerable package is present. Whether the vulnerable
 * path is reachable from this application is the model tiers' job, and it is where
 * both the noise and the value live.
 */
async function osv(worktree: string): Promise<EngineOutcome> {
  const bom = await generateSbom(worktree);
  if (bom.components.length === 0) {
    return { engine: "osv", findings: [], unavailable: bom.note ?? "nothing to query" };
  }
  try {
    const vulnerable = await queryComponents(bom.components);
    return { engine: "osv", findings: toFindings(vulnerable) };
  } catch (e) {
    // A database we could not reach is not a database that said "clean".
    return {
      engine: "osv",
      findings: [],
      unavailable: `OSV query failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ------------------------------------------------------------------------ tsc

const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

async function tsc(worktree: string): Promise<EngineOutcome> {
  const r = await runTool(worktree, "npx", ["--no-install", "tsc", "--noEmit", "--pretty", "false"]);
  if (r.unavailable !== undefined) return { engine: "tsc", findings: [], unavailable: r.unavailable };

  const findings: Finding[] = [];
  for (const raw of `${r.stdout}\n${r.stderr}`.split("\n")) {
    const m = TSC_LINE.exec(raw.trim());
    if (m === null) continue;
    findings.push(
      finding({
        file: m[1] ?? "",
        line: Number(m[2]),
        // It does not compile. Nothing downstream matters until it does.
        severity: "high",
        claim: `${m[4]}: ${m[5] ?? ""}`,
        evidence: raw.trim(),
        failureScenario: "the project does not typecheck, so this cannot ship as-is",
      }),
    );
  }
  return { engine: "tsc", findings };
}

// --------------------------------------------------------------------- eslint

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
}
interface EslintFile {
  filePath: string;
  messages: EslintMessage[];
}

async function eslint(worktree: string): Promise<EngineOutcome> {
  const r = await runTool(worktree, "npx", ["--no-install", "eslint", ".", "--format", "json"]);
  if (r.unavailable !== undefined) return { engine: "eslint", findings: [], unavailable: r.unavailable };

  const parsed = parseJson<EslintFile[]>(r.stdout);
  if (parsed === undefined) {
    return { engine: "eslint", findings: [], unavailable: "eslint produced unparseable output" };
  }

  const findings: Finding[] = [];
  for (const file of parsed) {
    for (const m of file.messages) {
      findings.push(
        finding({
          file: relativise(worktree, file.filePath),
          ...(m.line !== undefined ? { line: m.line } : {}),
          severity: m.severity === 2 ? "medium" : "low",
          claim: `${m.ruleId ?? "eslint"}: ${m.message}`,
          evidence: `eslint ${m.ruleId ?? ""} at ${relativise(worktree, file.filePath)}:${m.line ?? 0}`,
          failureScenario: "violates a rule this project has chosen to enforce",
        }),
      );
    }
  }
  return { engine: "eslint", findings };
}

// -------------------------------------------------------------------- semgrep

interface SemgrepResult {
  path: string;
  start?: { line?: number };
  check_id?: string;
  extra?: { message?: string; severity?: string; metadata?: { cwe?: string | string[] } };
}

async function semgrep(worktree: string): Promise<EngineOutcome> {
  const r = await runTool(
    worktree,
    "semgrep",
    ["--config", "p/security-audit", "--json", "--quiet", "--metrics", "off", "."],
    600_000,
  );
  if (r.unavailable !== undefined) return { engine: "semgrep", findings: [], unavailable: r.unavailable };

  const parsed = parseJson<{ results?: SemgrepResult[] }>(r.stdout);
  if (parsed === undefined) {
    return { engine: "semgrep", findings: [], unavailable: "semgrep produced unparseable output" };
  }

  const findings: Finding[] = [];
  for (const res of parsed.results ?? []) {
    const raw = res.extra?.metadata?.cwe;
    const cweText = Array.isArray(raw) ? raw[0] : raw;
    const cwe = /^(CWE-\d+)/.exec(cweText ?? "")?.[1];
    findings.push(
      finding({
        file: relativise(worktree, res.path),
        ...(res.start?.line !== undefined ? { line: res.start.line } : {}),
        severity: semgrepSeverity(res.extra?.severity),
        claim: `${res.check_id ?? "semgrep"}: ${res.extra?.message ?? "rule matched"}`,
        evidence: `semgrep ${res.check_id ?? ""} at ${relativise(worktree, res.path)}:${res.start?.line ?? 0}`,
        failureScenario: "matches a published pattern for a known weakness class",
        ...(cwe !== undefined ? { cwe } : {}),
      }),
    );
  }
  return { engine: "semgrep", findings };
}

function semgrepSeverity(s: string | undefined): Severity {
  switch ((s ?? "").toUpperCase()) {
    case "ERROR":
    case "CRITICAL":
    case "HIGH":
      return "high";
    case "WARNING":
    case "MEDIUM":
      return "medium";
    default:
      return "low";
  }
}

// ------------------------------------------------------------------- ast-grep

interface SgMatch {
  file: string;
  range?: { start?: { line?: number } };
  ruleId?: string;
  message?: string;
  severity?: string;
}

async function astGrep(worktree: string): Promise<EngineOutcome> {
  const r = await runTool(worktree, "ast-grep", ["scan", "--json"], 300_000);
  if (r.unavailable !== undefined) return { engine: "ast-grep", findings: [], unavailable: r.unavailable };

  const parsed = parseJson<SgMatch[]>(r.stdout);
  if (parsed === undefined) {
    return { engine: "ast-grep", findings: [], unavailable: "ast-grep produced unparseable output" };
  }

  const findings = parsed.map((m) =>
    finding({
      file: relativise(worktree, m.file),
      // ast-grep reports 0-indexed lines; findings are 1-indexed everywhere else.
      ...(m.range?.start?.line !== undefined ? { line: m.range.start.line + 1 } : {}),
      severity: m.severity === "error" ? "medium" : "low",
      claim: `${m.ruleId ?? "ast-grep"}: ${m.message ?? "pattern matched"}`,
      evidence: `ast-grep ${m.ruleId ?? ""} at ${relativise(worktree, m.file)}`,
      failureScenario: "matches a structural rule this project has chosen to enforce",
    }),
  );
  return { engine: "ast-grep", findings };
}

// -------------------------------------------------------------------- helpers

function parseJson<T>(text: string): T | undefined {
  const start = text.indexOf("{") >= 0 ? Math.min(...[text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0)) : text.indexOf("[");
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return undefined;
  }
}

function relativise(worktree: string, p: string): string {
  const prefix = worktree.endsWith("/") ? worktree : `${worktree}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p.replace(/^\.\//, "");
}
