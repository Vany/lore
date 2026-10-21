/**
 * What the EVM tools say, as findings. Pure, so each shape has a test (`evm-parse.test.ts`).
 *
 * Every shape was read off the tools themselves, not from docs: the forge fixtures in the
 * tests are forge 1.7.1's (the host's), and the pinned forge 1.8.5 then produced the same
 * shapes in the EVM sandbox — `Success` and `Failure` both, the failure from a PoC — as did
 * slither 0.11.6, aderyn 0.6.8 and solhint 6.2.5 (2026-10-20). Every parser refuses what it
 * does not recognise rather than reading it as "found nothing" (INV-1).
 *
 * VENDORED CODE IS NOT THE BRANCH'S. `lib/` (foundry's git dependencies) and `node_modules/`
 * hold other people's contracts; a detector firing inside OpenZeppelin is not a finding about
 * this repository, and reporting it would bury the branch's own under hundreds of them.
 * Dropped by path here, the one place every analyser's output passes through.
 */

import type { Finding, Severity } from "../core/finding.ts";
import { bySite, finding, ruleClaim, sitesEvidence } from "./engines.ts";

/** Paths whose contracts are someone else's — never findings about the branch. */
export function vendored(file: string): boolean {
  return /^(lib|node_modules|dependencies)\//.test(file) || file.includes("/node_modules/");
}

const parse = (text: string): unknown => {
  const start = text.indexOf("{");
  const startArr = text.indexOf("[");
  const at = startArr >= 0 && (start < 0 || startArr < start) ? startArr : start;
  if (at < 0) return undefined;
  try {
    return JSON.parse(text.slice(at)) as unknown;
  } catch {
    return undefined;
  }
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `forge build --json`: compile ERRORS only. Warnings are the compiler's opinion, not a gate. */
export function parseForgeBuild(stdout: string): readonly Finding[] | undefined {
  const d = parse(stdout);
  if (!isObj(d)) return undefined;
  const errors = Array.isArray(d["errors"]) ? d["errors"] : [];
  const out: Finding[] = [];
  for (const e of errors) {
    if (!isObj(e) || e["severity"] !== "error") continue;
    const loc = isObj(e["sourceLocation"]) ? e["sourceLocation"] : {};
    const file = typeof loc["file"] === "string" ? loc["file"] : "foundry.toml";
    const formatted = typeof e["formattedMessage"] === "string" ? e["formattedMessage"] : String(e["message"] ?? "");
    const line = /-->\s*[^:\n]+:(\d+):/.exec(formatted)?.[1];
    out.push(
      finding({
        file,
        ...(line === undefined ? {} : { line: Number(line) }),
        severity: "high",
        claim: ruleClaim("solc", String(e["message"] ?? "compile error"), "solc"),
        evidence: formatted.trim().slice(0, 1500),
        failureScenario: "the contracts do not compile, so nothing built from them — tests, deployments, analysis — exists",
      }),
    );
  }
  return out;
}

/** One forge test result that did not pass, and whether the sandbox, not the code, failed it. */
export interface ForgeTestFailure {
  readonly file: string;
  readonly contract: string;
  readonly test: string;
  readonly reason: string;
  /** A fork or RPC test cannot pass offline — the test did not run, it did not fail. */
  readonly needsNetwork: boolean;
}

/** `forge test --json`: `{"<path>:<Contract>": {test_results: {<name>: {status, reason}}}}`. */
export function parseForgeTest(stdout: string): { readonly failures: readonly ForgeTestFailure[]; readonly ran: number } | undefined {
  const d = parse(stdout);
  if (!isObj(d)) return undefined;
  const failures: ForgeTestFailure[] = [];
  let ran = 0;
  for (const [key, suite] of Object.entries(d)) {
    if (!isObj(suite) || !isObj(suite["test_results"])) continue;
    const [file = key, contract = ""] = key.split(":");
    for (const [test, r] of Object.entries(suite["test_results"])) {
      if (!isObj(r)) continue;
      ran++;
      if (r["status"] === "Success" || r["status"] === "Skipped") continue;
      // A status this reader does not know is NOT a failure: counted as one, a renamed status
      // in a forge release would report every test in a project as a failing high finding.
      // The whole result is refused instead, and the engine says it could not read forge.
      if (r["status"] !== "Failure") return undefined;
      const reason = typeof r["reason"] === "string" ? r["reason"] : "failed with no reason given";
      failures.push({
        file, contract, test, reason,
        needsNetwork: /fork|rpc|could not instantiate|connection refused|dns|network/i.test(reason),
      });
    }
  }
  return { failures, ran };
}

export function forgeTestFindings(failures: readonly ForgeTestFailure[]): readonly Finding[] {
  return failures
    .filter((f) => !f.needsNetwork)
    .map((f) =>
      finding({
        file: f.file,
        severity: "high",
        claim: ruleClaim("forge-test", `${f.contract}.${f.test} fails`, "forge-test"),
        evidence: `forge test: ${f.contract}.${f.test} — ${f.reason}`.slice(0, 1500),
        failureScenario: "the project's own test asserts behaviour the contracts on this branch do not have",
      }),
    );
}

/** slither's impact names, mapped onto lore's scale: High/Medium block; Low/Informational are notes. */
const SLITHER_SEVERITY: Readonly<Record<string, Severity | undefined>> = { High: "high", Medium: "medium" };

/**
 * `slither . --json -`: `results.detectors[]` with `check`, `impact`, `description` and
 * `elements[].source_mapping`. Low and Informational are counted, never raised — the brief's
 * scale makes them advice, and slither's informational detectors fire on nearly every file.
 */
export function parseSlither(stdout: string): { readonly findings: readonly Finding[]; readonly notes: number } | undefined {
  const d = parse(stdout);
  if (!isObj(d) || !isObj(d["results"])) return isObj(d) && d["success"] === true ? { findings: [], notes: 0 } : undefined;
  const detectors = Array.isArray(d["results"]["detectors"]) ? d["results"]["detectors"] : [];
  let notes = 0;
  const hits: { check: string; description: string; severity: Severity; file: string; line: number }[] = [];
  for (const det of detectors) {
    if (!isObj(det)) continue;
    const severity = SLITHER_SEVERITY[String(det["impact"])];
    const elements = Array.isArray(det["elements"]) ? det["elements"] : [];
    const first = elements.find((e) => isObj(e) && isObj(e["source_mapping"]));
    const sm = isObj(first) && isObj(first["source_mapping"]) ? first["source_mapping"] : {};
    const file = typeof sm["filename_relative"] === "string" ? sm["filename_relative"] : "";
    if (file === "" || vendored(file)) continue;
    if (severity === undefined) {
      notes++;
      continue;
    }
    const lines = Array.isArray(sm["lines"]) ? sm["lines"].filter((n): n is number => typeof n === "number") : [];
    hits.push({ check: String(det["check"] ?? "slither"), description: String(det["description"] ?? "").trim(), severity, file, line: lines[0] ?? 0 });
  }
  const findings: Finding[] = [];
  for (const { match: h, file, lines } of bySite(hits, (h) => ({ claim: ruleClaim(h.check, firstLine(h.description), "slither"), file: h.file, line: h.line }))) {
    findings.push(
      finding({
        file,
        ...(lines[0] !== undefined && lines[0] > 0 ? { line: lines[0] } : {}),
        severity: h.severity,
        claim: ruleClaim(h.check, firstLine(h.description), "slither"),
        evidence: `${sitesEvidence("slither", h.check, file, lines)}\n${h.description}`.slice(0, 1500),
        failureScenario: "matches a slither detector for a known smart-contract weakness class",
      }),
    );
  }
  return { findings, notes };
}

/** aderyn's report: `{high_issues: {issues: [{title, detector_name, instances: [{contract_path, line_no}]}]}}`. */
export function parseAderyn(report: string): { readonly findings: readonly Finding[]; readonly notes: number } | undefined {
  const d = parse(report);
  if (!isObj(d)) return undefined;
  const issues = (k: string): readonly unknown[] => {
    const v = d[k];
    return isObj(v) && Array.isArray(v["issues"]) ? v["issues"] : [];
  };
  let notes = 0;
  for (const i of issues("low_issues")) if (isObj(i)) notes += Array.isArray(i["instances"]) ? i["instances"].length : 1;
  const hits: { rule: string; title: string; file: string; line: number }[] = [];
  for (const i of issues("high_issues")) {
    if (!isObj(i)) continue;
    for (const inst of Array.isArray(i["instances"]) ? i["instances"] : []) {
      if (!isObj(inst) || typeof inst["contract_path"] !== "string" || vendored(inst["contract_path"])) continue;
      hits.push({ rule: String(i["detector_name"] ?? "aderyn"), title: String(i["title"] ?? ""), file: inst["contract_path"], line: Number(inst["line_no"] ?? 0) });
    }
  }
  // aderyn's "high" is its own word for a pattern, and its detectors are noisier than
  // slither's: raised at medium, so it gates without outranking a confirmed defect.
  return {
    notes,
    findings: bySite(hits, (h) => ({ claim: ruleClaim(h.rule, h.title, "aderyn"), file: h.file, line: h.line })).map(({ match: h, file, lines }) =>
      finding({
        file,
        ...(lines[0] !== undefined && lines[0] > 0 ? { line: lines[0] } : {}),
        severity: "medium",
        claim: ruleClaim(h.rule, h.title, "aderyn"),
        evidence: sitesEvidence("aderyn", h.rule, file, lines),
        failureScenario: "matches an aderyn detector for a known smart-contract weakness class",
      }),
    ),
  };
}

/** `solhint -f json`: an array of `{filePath, line, severity, message, ruleId}`. Errors only. */
export function parseSolhint(stdout: string): readonly Finding[] | undefined {
  const d = parse(stdout);
  if (!Array.isArray(d)) return undefined;
  const hits: { rule: string; message: string; file: string; line: number }[] = [];
  for (const r of d) {
    if (!isObj(r) || String(r["severity"]).toLowerCase() !== "error") continue;
    const file = String(r["filePath"] ?? "");
    if (file === "" || vendored(file)) continue;
    hits.push({ rule: String(r["ruleId"] ?? "solhint"), message: String(r["message"] ?? ""), file, line: Number(r["line"] ?? 0) });
  }
  // The project's own lint rules: low, the same weight eslint's carry.
  return bySite(hits, (h) => ({ claim: ruleClaim(h.rule, h.message, "solhint"), file: h.file, line: h.line })).map(({ match: h, file, lines }) =>
    finding({
      file,
      ...(lines[0] !== undefined && lines[0] > 0 ? { line: lines[0] } : {}),
      severity: "low",
      claim: ruleClaim(h.rule, h.message, "solhint"),
      evidence: sitesEvidence("solhint", h.rule, file, lines),
      failureScenario: "breaks a lint rule this project configured for itself",
    }),
  );
}

const firstLine = (s: string): string => (s.split("\n")[0] ?? s).slice(0, 200);

/** What a reviewer's proof-of-concept test said about its own finding, run on this tree. */
export type PocOutcome =
  | { readonly kind: "confirmed"; readonly detail: string }
  | { readonly kind: "refuted"; readonly detail: string }
  | { readonly kind: "inconclusive"; readonly detail: string };

/**
 * A PoC is a test that FAILS because of the defect. Failing confirms the finding; passing
 * refutes it — the reviewer's own evidence says the behaviour holds. Anything else (it did
 * not compile, it ran no test, it needed a network) proves nothing either way, and the
 * finding stands on its words: a PoC that could not run must never withdraw a finding.
 */
export function classifyPoc(stdout: string): PocOutcome {
  const parsed = parseForgeTest(stdout);
  if (parsed === undefined) return { kind: "inconclusive", detail: "the PoC did not compile or forge produced no result" };
  if (parsed.ran === 0) return { kind: "inconclusive", detail: "the PoC contains no test forge ran" };
  if (parsed.failures.some((f) => f.needsNetwork)) return { kind: "inconclusive", detail: "the PoC needs a network the sandbox does not have" };
  const failed = parsed.failures[0];
  if (failed !== undefined) return { kind: "confirmed", detail: `${failed.contract}.${failed.test} fails: ${failed.reason}` };
  return { kind: "refuted", detail: `all ${String(parsed.ran)} PoC test(s) pass on this tree` };
}

/**
 * `hardhat compile`'s text, when it failed: solc's own blocks — `XError: message` then
 * `--> file:line:col:`. `undefined` when it failed and no compiler error is in it (a config
 * error, a plugin that would not load): that is not a fact about the contracts, and saying
 * "does not compile" about it would be a false claim.
 */
export function parseHardhatCompile(log: string, exitCode: number): readonly Finding[] | undefined {
  if (exitCode === 0) return [];
  const out: Finding[] = [];
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\w*Error): (.+)$/.exec((lines[i] ?? "").trim());
    if (head?.[1] === undefined || head[2] === undefined || head[1] === "Error" || head[1] === "HardhatError") continue;
    const loc = /-->\s*([^:\s]+\.sol):(\d+):\d+/.exec(lines.slice(i + 1, i + 4).join("\n"));
    if (loc?.[1] === undefined || vendored(loc[1])) continue;
    out.push(
      finding({
        file: loc[1],
        line: Number(loc[2]),
        severity: "high",
        claim: ruleClaim("solc", `${head[1]}: ${head[2]}`, "solc"),
        evidence: lines.slice(i, i + 8).join("\n").slice(0, 1500),
        failureScenario: "the contracts do not compile, so nothing built from them — tests, deployments, analysis — exists",
      }),
    );
  }
  return out.length > 0 ? out : undefined;
}

/** One mocha test that did not pass, from the JSON reporter. */
export interface MochaFailure {
  readonly file: string;
  readonly title: string;
  readonly message: string;
  readonly needsNetwork: boolean;
}

/** The mocha JSON reporter: `{stats: {tests, passes, failures}, failures: [{fullTitle, file, err}]}`. */
export function parseMocha(json: string, root = "/work/"): { readonly ran: number; readonly passed: number; readonly failures: readonly MochaFailure[] } | undefined {
  const d = parse(json);
  if (!isObj(d) || !isObj(d["stats"])) return undefined;
  const failures: MochaFailure[] = [];
  for (const f of Array.isArray(d["failures"]) ? d["failures"] : []) {
    if (!isObj(f)) continue;
    const err = isObj(f["err"]) ? f["err"] : {};
    const message = String(err["message"] ?? "failed with no message");
    const file = String(f["file"] ?? "test").replace(root, "");
    failures.push({ file, title: String(f["fullTitle"] ?? f["title"] ?? "?"), message, needsNetwork: /fork|rpc|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/i.test(message) });
  }
  return { ran: Number(d["stats"]["tests"] ?? 0), passed: Number(d["stats"]["passes"] ?? 0), failures };
}

export function mochaFindings(failures: readonly MochaFailure[]): readonly Finding[] {
  return failures
    .filter((f) => !f.needsNetwork)
    .map((f) =>
      finding({
        file: f.file,
        severity: "high",
        claim: ruleClaim("hardhat-test", `${f.title} fails`, "hardhat-test"),
        evidence: `hardhat test: ${f.title} — ${f.message}`.slice(0, 1500),
        failureScenario: "the project's own test asserts behaviour the contracts on this branch do not have",
      }),
    );
}

/** A hardhat PoC's verdict on its own finding, by the same rule as a forge one (`classifyPoc`). */
export function classifyMochaPoc(json: string): PocOutcome {
  const r = parseMocha(json);
  if (r === undefined) return { kind: "inconclusive", detail: "the PoC did not load or mocha produced no result" };
  if (r.ran === 0) return { kind: "inconclusive", detail: "the PoC contains no test mocha ran" };
  if (r.failures.some((f) => f.needsNetwork)) return { kind: "inconclusive", detail: "the PoC needs a network the sandbox does not have" };
  const failed = r.failures[0];
  if (failed !== undefined) return { kind: "confirmed", detail: `${failed.title} fails: ${failed.message}` };
  return { kind: "refuted", detail: `all ${String(r.ran)} PoC test(s) pass on this tree` };
}

/** One compilation a project ran, from its build-info: the exact version and the settings bugs depend on. */
export interface SolcBuild {
  readonly version: string;
  readonly optimizer: boolean;
  readonly viaIR: boolean;
}

interface SolcBug {
  readonly uid?: string;
  readonly name: string;
  readonly summary?: string;
  readonly severity?: string;
  readonly link?: string;
  readonly conditions?: Readonly<Record<string, unknown>>;
}

/**
 * The Solidity team's bug list, against the compilers this project actually used.
 *
 * A known bug needs a pattern in the code as well as the compiler; lore cannot tell whether
 * the code uses it, so these are QUESTIONS for the model tiers, not proof: a high-severity
 * compiler bug is raised at medium, a medium at low, and low/very-low bugs are not raised at
 * all. A condition lore can read from the build settings (optimizer, viaIR, yulOptimizer)
 * rules a bug out when unmet; one it cannot (evmVersion) is treated as met — conservative,
 * because a missed compiler bug is the worse error.
 */
export function matchSolcBugs(
  builds: readonly SolcBuild[],
  bugs: readonly SolcBug[],
  byVersion: Readonly<Record<string, { readonly bugs?: readonly string[] }>>,
  configFile: string,
): readonly Finding[] {
  const byName = new Map(bugs.map((b) => [b.name, b]));
  const out = new Map<string, Finding>();
  for (const b of builds) {
    for (const name of byVersion[b.version]?.bugs ?? []) {
      const bug = byName.get(name);
      if (bug === undefined) continue;
      const c = bug.conditions ?? {};
      if (c["optimizer"] === true && !b.optimizer) continue;
      if (c["yulOptimizer"] === true && !b.optimizer) continue;
      if (c["viaIR"] === true && !b.viaIR) continue;
      if (c["viaIR"] === false && b.viaIR) continue;
      const sev = String(bug.severity ?? "");
      const severity = /high/.test(sev) ? "medium" : /^medium|low\/medium/.test(sev) ? "low" : undefined;
      if (severity === undefined) continue;
      const key = `${name}@${b.version}`;
      if (out.has(key)) continue;
      out.set(
        key,
        finding({
          file: configFile,
          severity,
          claim: ruleClaim(`solc-bug-${name}`, `solc ${b.version} has a known ${sev}-severity bug: ${(bug.summary ?? name).replace(/``/g, "`")}`, "solc-bugs"),
          evidence: `${bug.uid ?? name} (${sev}) affects solc ${b.version}, which this project compiles with${b.optimizer ? " (optimizer on)" : ""}${b.viaIR ? " (via IR)" : ""}. ${bug.link ?? ""}`.trim().slice(0, 1500),
          failureScenario: "code using the pattern this bug concerns compiles to behaviour other than what the source says — check whether any contract here uses it, or move to a compiler without the bug",
        }),
      );
    }
  }
  return [...out.values()];
}
