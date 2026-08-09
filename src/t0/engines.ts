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

import { CLAIM_MAX } from "../core/finding.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Severity } from "../core/finding.ts";
import type { T0Engine } from "../core/review-type.ts";
import { gitlinks } from "../git/repo.ts";
import { commitToFindings, queryCommit, queryComponents, toFindings } from "../security/osv.ts";
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
  /**
   * Set when an OPTIONAL engine had nothing to do — a tool that is only meaningful
   * with project-authored rules, in a project that has not written any.
   *
   * Deliberately not `unavailable`. That list is what the client repeats to its user
   * so a `passed` is not over-read, and it only keeps working while every entry is
   * worth reading. ast-grep reported itself missing on every review of every
   * repository lore has ever seen, for a check that never existed — and a list that
   * always contains the same noise is a list nobody reads, including on the day it
   * contains "the test suite did not run".
   *
   * Kept rather than dropped so the operator can still see it in the log.
   */
  readonly skipped?: string;
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
    claim: cap(f.claim.replace(/\s+/g, " ").trim(), CLAIM_MAX),
    evidence: cap(f.evidence, 2000),
    failureScenario: cap(f.failureScenario, 2000),
    ...(f.cwe !== undefined ? { cwe: f.cwe } : {}),
  };
}

/**
 * The engine rule a T0 finding came from, read back off its claim.
 *
 * Every engine here that HAS a rule id writes it the same way — `<id>: <message>` —
 * because that is the only place a `Finding` can carry it: the schema is the wire
 * contract with the models (`core/finding.ts`), and a field meaningless to a model
 * does not belong in the prompt they are given.
 *
 * D-83 needs that id as a first-class thing: an accepted appeal suppresses a rule
 * CLASS for a path, and "the class" is exactly this. Reading it back off a string is
 * an unhappy shape, so `engines.test.ts` asserts every engine's output parses to the
 * id it was built from — the convention is checked, not trusted.
 *
 * Constrained to what a rule id can look like, never a sentence: no spaces before the
 * colon. `tests: \`npm test\` fails on this branch` has one, so a script failure yields
 * no class and can never be suppressed wholesale — which is right. Nothing appeals its
 * way out of "the suite does not pass".
 *
 * THE LEADING `@` IS NOT COSMETIC. Without it `@typescript-eslint/no-floating-promises`
 * and `@next/next/no-img-element` — which is most of the rules a TypeScript project
 * actually enforces — yielded no class at all, so an appeal against one was accepted, the
 * fingerprint settled, and no suppression was recorded. The class went on firing and
 * nothing anywhere said why. D-83 quietly did not work for the common case.
 *
 * It does not re-open the sentence hole. OSV writes `@scope/pkg@1.0.0 is affected by
 * CVE-…: summary`, and the second `@` is outside the character class, so the match ends
 * before the colon it would need.
 */
const RULE_CLASS = /^(@?[A-Za-z][A-Za-z0-9._/-]*):\s/;

/**
 * Write a claim so its rule id can be read back. The one definition of the convention.
 *
 * All four rule-bearing engines went through it independently before this existed, four
 * template literals that happened to agree — and `engineRuleClass` was a fifth copy of
 * the same decision, in the opposite direction. `engines.test.ts` asserts the round trip
 * rather than the shape, so the two cannot drift into disagreeing about one engine.
 */
export function ruleClaim(id: string | undefined, message: string, fallback: string): string {
  return `${id ?? fallback}: ${message}`;
}

export function engineRuleClass(claim: string): string | undefined {
  return RULE_CLASS.exec(claim)?.[1];
}

/**
 * Every site one rule matched in one file, collapsed into one entry.
 *
 * A finding's identity is `sha256(claim, file, symbol)` and deliberately excludes the
 * line — a defect that moved three lines down is the same defect, and keying on position
 * would make every fix look like a fresh discovery. Pattern engines report no symbol, so
 * TWO MATCHES OF ONE RULE IN ONE FILE produced the same fingerprint and the store's
 * `ON CONFLICT DO NOTHING` dropped the second. Silently: the client saw one site, fixed
 * it, and had no way to learn there was another.
 *
 * A customer report of this class arrived on 2026-08-08 — a rule reporting the safe one
 * of two identical XSS sinks and missing the unsafe one, found only by grepping the sink
 * by hand. Their two sites were in different FILES, which lore does distinguish, so this
 * is not what happened to them; it is the same defect one step further in, and it was
 * ours.
 *
 * Grouped rather than fingerprinted by line, which would trade a false negative for
 * permanent churn: every edit above a match would retire one finding and raise an
 * identical one below it. One finding naming all its sites is also what an answer
 * actually addresses — the customer's fix routed both sinks through a single helper.
 *
 * Shared by semgrep and ast-grep because they have the same shape, and a second copy of
 * this decision would be the defect it fixes, written twice.
 */
function bySite<T>(
  matches: readonly T[],
  of: (m: T) => { readonly claim: string; readonly file: string; readonly line: number },
): { readonly match: T; readonly file: string; readonly lines: readonly number[] }[] {
  const groups = new Map<string, { match: T; file: string; lines: number[] }>();
  for (const m of matches) {
    const { claim, file, line } = of(m);
    // KEYED ON THE CLAIM, which is exactly what the fingerprint hashes. Keying on the
    // rule id instead is too coarse for a compiler: two TS2345s carry different messages
    // and are different errors, so merging them would LOSE one — the same harm as the
    // collapse, arrived at from the other side. semgrep collapses precisely because its
    // claim is the rule's generic message, identical at every match.
    const key = `${claim}\u0000${file}`;
    const at = groups.get(key);
    if (at === undefined) groups.set(key, { match: m, file, lines: [line] });
    else at.lines.push(line);
  }
  return [...groups.values()].map((g) => ({ ...g, lines: [...new Set(g.lines)].sort((a, b) => a - b) }));
}

/**
 * The evidence, naming every site, and saying plainly that fixing one is not enough.
 *
 * EVERY SITE LIVES HERE AND NOTHING ABOUT THEM TOUCHES THE CLAIM. The count and the line
 * numbers went into the claim first, so the model's one-line T0 summary would carry them
 * — and the claim IS the fingerprint (`sha256(claim, file, symbol)`). That reintroduced
 * exactly the churn grouping was chosen to avoid, in the same change, under a comment
 * saying it had been avoided: any edit above a multi-site match renumbers the sites,
 * which rewrites the claim, which changes the identity, so the old finding can never
 * settle and a new one is raised in its place for ever.
 *
 * Fixing one of two sites does it too, via the count alone — which is the case where
 * churn hurts most, because it is the moment the author is answering.
 *
 * The client is who acts on this and the client gets the evidence, so nothing is lost
 * that matters. A stable identity is worth more than a denser summary line.
 */
function sitesEvidence(tool: string, rule: string, file: string, lines: readonly number[]): string {
  const at = lines.map((l) => `${file}:${String(l)}`).join(", ");
  return (
    `${tool} ${rule} at ${at}` +
    (lines.length < 2
      ? ""
      : `\n${String(lines.length)} SEPARATE SITES IN THIS FILE. Fixing the first does not fix the rest — ` +
        "answer the whole set, and prefer a change that makes the pattern safe by construction over arguing " +
        "each site's inputs.")
  );
}

/**
 * Engines that mean nothing without project-authored rules.
 *
 * Their absence is not a gap in the review, so it is not reported as one. Contrast
 * `tsc`, `eslint` and `tests`: a JavaScript project without those has a gap, and
 * saying so is the point.
 */
const OPT_IN = new Set<T0Engine>(["ast-grep"]);

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
      return existsSync(join(worktree, "package.json"));
    case "osv":
      // Not the same condition as `sbom`, though it was written as one.
      //
      // OSV queries packages FROM the SBOM and submodules by commit. A repository
      // that vendors purely by gitlink has no `package.json`, so sharing the gate
      // skipped the whole engine — the vulnerability check declining to run on the
      // exact repository shape it was built for (D-36), and reporting nothing, which
      // is the reading INV-1 forbids.
      return existsSync(join(worktree, "package.json")) || existsSync(join(worktree, ".gitmodules"));
    default:
      return false;
  }
}

/**
 * The files this review actually changed, or `undefined` for the whole tree (D-92).
 *
 * Vany: *"and only on this files."* A pattern engine matches one file at a time, so
 * pointing it at the branch's own files instead of a monorepo is the same answer for less
 * money — and it drops the inherited matches in untouched code that D-68 already ranks
 * last and that a team ends up justifying over and over.
 *
 * **`tsc` and `eslint` are deliberately NOT narrowed**, and that is not an oversight.
 * Type checking is whole-program: changing one exported signature breaks its callers, and
 * checking only the changed file is precisely how that class of defect stops being caught
 * — the class a reviewer most wants from a type checker. They also run in the sandbox
 * (`runner.ts`), where the cost is the install and parsing the program, which a subset
 * still pays through its imports.
 */
export type Scope = readonly string[] | undefined;

/**
 * Beyond this many paths, scan the tree instead.
 *
 * An argv is not unbounded and a 900-file branch would build a command line long enough
 * to fail in a way that reads as the engine being broken. Falling back WIDENS coverage,
 * which is the safe direction for a bound nobody can see from outside.
 */
const MAX_SCOPED_PATHS = 200;

/** The paths to hand an engine, or `["."]` when there are too many or none. */
export function scopePaths(scope: Scope): readonly string[] {
  if (scope === undefined || scope.length === 0 || scope.length > MAX_SCOPED_PATHS) return ["."];
  return scope;
}

export async function runEngine(worktree: string, engine: T0Engine, scope?: Scope): Promise<EngineOutcome> {
  // Refused rather than defaulted. These two resolve their binary out of the
  // target's node_modules, so the service must never run them — `runner.ts` drives
  // them inside the sandbox. Falling through to "has no runner" would read as a
  // missing feature instead of a boundary.
  if (engine === "tsc" || engine === "eslint") {
    return {
      engine,
      findings: [],
      unavailable: `${engine} runs in the sandbox, not here — call it through runT0`,
    };
  }
  if (!detect(worktree, engine)) {
    // OPT-IN BY NATURE vs A GAP, and they must not be reported the same way.
    //
    // `unavailable` means "a check that should have run did not", and the client is
    // told to pass it on so a later `passed` is not over-read. That is INV-1 working
    // — but only while the list means something. ast-grep needs project-authored
    // structural rules to say anything at all, and no repository lore has ever met
    // has an `sgconfig.yml`: 5 of 7 runs on the customer's repo reported it missing,
    // every single review, for a check that never existed to be skipped.
    //
    // Reporting that as NOT RUN teaches the reader to skim the list, which is how the
    // one entry that matters — the suite that did not run, the typecheck that could
    // not resolve — gets skimmed too. A tool that is only meaningful when configured
    // is simply absent when it is not.
    if (OPT_IN.has(engine)) return { engine, findings: [], skipped: `${engine}: no rules configured (optional)` };
    return { engine, findings: [], unavailable: `${engine} is not configured in this repo` };
  }
  switch (engine) {
    // tsc and eslint are NOT here. Both resolve their binary out of the target's
    // `node_modules`, so running them means executing code from the dependency tree
    // — which D-24 says happens in the sandbox and never in the service. They are
    // driven by `runner.ts` inside the same container the suite uses. `semgrep`,
    // `ast-grep`, `sbom` and `osv` stay: those are lore's own binaries reading
    // files, and they need no install.
    case "semgrep":
      return semgrep(worktree, scope);
    case "ast-grep":
      return astGrep(worktree, scope);
    // NOT SCOPED, and for a different reason than tsc: these two are about the dependency
    // manifest, not about source files. Narrowing them to the branch's changed files would
    // ask about a lockfile that is usually not among them and get nothing back.
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
  // Two populations, and the second was never queried.
  //
  // Packages come from the SBOM and match on name+version. SUBMODULES have neither:
  // a gitlink is a bare commit, invisible to any lockfile, and OSV's commit query is
  // the only thing that can rule on it. `queryCommit` was written and tested for
  // exactly this and had no caller — so on a repository that vendors by submodule,
  // which is how this workgroup ships (D-36), the security review enumerated
  // `package-lock.json` and reported clean about code it never looked at.
  // ENUMERATION IS INSIDE THE TRY, with the queries.
  //
  // It was `gitlinks(worktree).catch(() => [])`, which turned "I could not enumerate
  // the submodules" into "there are no submodules" — after which the package half
  // still answered and the result was presented as a complete enumeration. That is
  // the silent skip this engine was being fixed to remove, preserved on its error
  // path, and a reviewer raised it against the commit that introduced the fix.
  //
  // Removing the `.catch` alone was not enough and I nearly shipped that: the call sat
  // OUTSIDE the try, so the failure would have escaped `osv()` entirely instead of
  // reporting the engine unavailable — while a comment three lines above claimed it
  // "falls through to the outer catch". A false sentence inside the fix for false
  // sentences. Both halves are in the same try now, which is what makes the claim true.
  const findings: Finding[] = [];
  try {
    const links = await gitlinks(worktree);
    const bom = await generateSbom(worktree);

    if (bom.components.length === 0 && links.length === 0) {
      return { engine: "osv", findings: [], unavailable: bom.note ?? "nothing to query" };
    }

    if (bom.components.length > 0) findings.push(...toFindings(await queryComponents(bom.components)));
    for (const link of links) {
      findings.push(...commitToFindings(link.path, link.commit, await queryCommit(link.commit)));
    }
    return { engine: "osv", findings };
  } catch (e) {
    // A database we could not reach is not a database that said "clean", and a tree we
    // could not enumerate is not a tree with nothing in it.
    //
    // The WHOLE engine is unavailable, even if one half answered. Returning the
    // packages we did get while the submodule query died would present a partial
    // enumeration as a complete one, which is the failure this engine exists to
    // report rather than commit.
    return {
      engine: "osv",
      findings: [],
      unavailable: `OSV enumeration or query failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ------------------------------------------------------------------------ tsc

const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

/** Parse `tsc --noEmit --pretty false` output. Exported so the sandbox can use it. */
export function parseTsc(output: string): Finding[] {
  // GROUPED LIKE THE PATTERN ENGINES, and for the same reason — see `bySite`. The
  // multi-site fix landed on semgrep and ast-grep and not here, leaving the defect the
  // change was written for still live in the tier that runs on every review.
  //
  // Rarer here than in semgrep, because the key is the CLAIM and a compiler's message
  // usually names the types involved — but "Object is possibly 'undefined'" and its like
  // are byte-identical at every occurrence, and those are the ones a file has forty of.
  const matched = output
    .split("\n")
    .map((raw) => ({ raw: raw.trim(), m: TSC_LINE.exec(raw.trim()) }))
    .filter((x): x is { raw: string; m: RegExpExecArray } => x.m !== null);

  return bySite(matched, ({ m }) => ({
    claim: ruleClaim(m[4], m[5] ?? "", "tsc"),
    file: m[1] ?? "",
    line: Number(m[2]),
  })).map(({ match: { m, raw }, file, lines }) => {
    const first = lines[0];
    return finding({
      file,
      ...(first !== undefined && first > 0 ? { line: first } : {}),
      // It does not compile. Nothing downstream matters until it does.
      severity: "high",
      claim: ruleClaim(m[4], m[5] ?? "", "tsc"),
      // The raw compiler line when there is one site: that is what a reader wants, and
      // grouping must not rewrite the single case it was not built for.
      evidence: lines.length < 2 ? raw : sitesEvidence("tsc", m[4] ?? "", file, lines),
      failureScenario: "the project does not typecheck, so this cannot ship as-is",
    });
  });
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

/** Parse `eslint --format json`. Returns undefined when the output is not that. */
export function parseEslint(stdout: string, worktree: string): Finding[] | undefined {
  const parsed = parseJson<EslintFile[]>(stdout);
  if (parsed === undefined) return undefined;

  // GROUPED LIKE THE PATTERN ENGINES — see `bySite`. eslint is the loudest engine here
  // and the most likely to match one rule many times in one file, so the silent collapse
  // this fixes was at its worst exactly where it was least visible.
  const flat = parsed.flatMap((f) => f.messages.map((m) => ({ m, path: relativise(worktree, f.filePath) })));
  return bySite(flat, ({ m, path }) => ({
    claim: ruleClaim(m.ruleId ?? undefined, m.message, "eslint"),
    file: path,
    line: m.line ?? 0,
  })).map(({ match: { m }, file, lines }) => {
    const first = lines[0];
    return finding({
      file,
      ...(first !== undefined && first > 0 ? { line: first } : {}),
      severity: m.severity === 2 ? "medium" : "low",
      claim: ruleClaim(m.ruleId ?? undefined, m.message, "eslint"),
      evidence: sitesEvidence("eslint", m.ruleId ?? "", file, lines),
      failureScenario: "violates a rule this project has chosen to enforce",
    });
  });
}

// -------------------------------------------------------------------- semgrep

interface SemgrepResult {
  path: string;
  start?: { line?: number };
  check_id?: string;
  extra?: { message?: string; severity?: string; metadata?: { cwe?: string | string[] } };
}

/**
 * What semgrep could NOT read, which it reports beside what it found.
 *
 * `type` is a tagged union in an array — `["PartialParsing", [spans]]` — so only the
 * head is a discriminator worth reading.
 */
interface SemgrepError {
  level?: string;
  type?: unknown;
  path?: string;
  message?: string;
}

/**
 * Files semgrep failed to parse, as one line per file.
 *
 * IT EXITS ZERO AND REPORTS `results: []` FOR A FILE IT COULD NOT READ. The failure goes
 * into `errors` at level `warn`, which lore discarded entirely — so a file with one piece
 * of syntax semgrep's parser does not handle was scanned, skipped, and reported as
 * carrying no findings. That is INV-1 inside the deterministic tier, and it is the worst
 * place for it: T0 is what a model tier is told it need not re-derive.
 *
 * Found while reproducing a customer report of this rule class reporting the SAFE site of
 * two identical XSS sinks and missing the unsafe one. The fixture had a bad identifier,
 * semgrep answered `results: [], errors: [PartialParsing]`, and lore would have called
 * that clean — which is the same shape as the report, arrived at by accident.
 */
function semgrepUnread(errors: readonly SemgrepError[]): readonly string[] {
  const byFile = new Map<string, string>();
  for (const e of errors) {
    const kind = Array.isArray(e.type) ? String(e.type[0] ?? "") : String(e.type ?? "");
    // Parse failures only. A rule that could not be fetched is a different problem and
    // semgrep already fails loudly for it; this is about code that was silently skipped.
    if (!/Parsing|Lexical|Syntax/i.test(kind)) continue;
    const file = e.path ?? "(unknown file)";
    if (!byFile.has(file)) byFile.set(file, kind);
  }
  return [...byFile].map(
    ([file, kind]) =>
      `semgrep could not parse ${file} (${kind}) — it was SKIPPED, not found clean. Anything in it is ` +
      "unexamined by every semgrep rule.",
  );
}

async function semgrep(worktree: string, scope?: Scope): Promise<EngineOutcome> {
  const r = await runTool(
    worktree,
    "semgrep",
    ["--config", "p/security-audit", "--json", "--quiet", "--metrics", "off", ...scopePaths(scope)],
    600_000,
  );
  if (r.unavailable !== undefined) return { engine: "semgrep", findings: [], unavailable: r.unavailable };

  const parsed = parseSemgrep(r.stdout, worktree);
  if (parsed === undefined) {
    return { engine: "semgrep", findings: [], unavailable: "semgrep produced unparseable output" };
  }
  const { findings, unread } = parsed;
  return { engine: "semgrep", findings, ...(unread.length === 0 ? {} : { unavailable: unread.join("\n") }) };
}

/**
 * semgrep's JSON, as findings plus what it could not read. Pure, so it has a test.
 *
 * Split out for the reason `parseTsc` and `parseEslint` are: the interesting behaviour is
 * in the parsing, and a function that shells out cannot be exercised. Both defects this
 * fixes — a dropped second site, and a file reported clean that was never parsed — live
 * entirely on this side of the process boundary.
 */
export function parseSemgrep(
  stdout: string,
  worktree: string,
): { readonly findings: readonly Finding[]; readonly unread: readonly string[] } | undefined {
  const parsed = parseJson<{ results?: SemgrepResult[]; errors?: SemgrepError[] }>(stdout);
  if (parsed === undefined) return undefined;
  // WHAT IT COULD NOT READ, in the same channel as an engine that could not run — because
  // it is the same fact. See `semgrepUnread`.
  const unread = semgrepUnread(parsed.errors ?? []);

  const findings: Finding[] = [];
  for (const { match: res, file, lines } of bySite(parsed.results ?? [], (r) => ({
    claim: ruleClaim(r.check_id, r.extra?.message ?? "rule matched", "semgrep"),
    file: relativise(worktree, r.path),
    line: r.start?.line ?? 0,
  }))) {
    const raw = res.extra?.metadata?.cwe;
    const cweText = Array.isArray(raw) ? raw[0] : raw;
    const cwe = /^(CWE-\d+)/.exec(cweText ?? "")?.[1];
    const first = lines[0];
    findings.push(
      finding({
        file,
        ...(first !== undefined && first > 0 ? { line: first } : {}),
        severity: semgrepSeverity(res.extra?.severity),
        claim: ruleClaim(res.check_id, res.extra?.message ?? "rule matched", "semgrep"),
        evidence: sitesEvidence("semgrep", res.check_id ?? "", file, lines),
        failureScenario: "matches a published pattern for a known weakness class",
        ...(cwe !== undefined ? { cwe } : {}),
      }),
    );
  }

  return { findings, unread };
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

async function astGrep(worktree: string, scope?: Scope): Promise<EngineOutcome> {
  const r = await runTool(worktree, "ast-grep", ["scan", "--json", ...scopePaths(scope)], 300_000);
  if (r.unavailable !== undefined) return { engine: "ast-grep", findings: [], unavailable: r.unavailable };

  const parsed = parseJson<SgMatch[]>(r.stdout);
  if (parsed === undefined) {
    return { engine: "ast-grep", findings: [], unavailable: "ast-grep produced unparseable output" };
  }

  // Grouped exactly as semgrep's are, and for the same reason — see `bySite`. ast-grep
  // reports 0-indexed lines; findings are 1-indexed everywhere else.
  const findings = bySite(parsed, (m) => ({
    claim: ruleClaim(m.ruleId, m.message ?? "pattern matched", "ast-grep"),
    file: relativise(worktree, m.file),
    line: (m.range?.start?.line ?? -1) + 1,
  })).map(({ match: m, file, lines }) => {
    const first = lines[0];
    return finding({
      file,
      ...(first !== undefined && first > 0 ? { line: first } : {}),
      severity: m.severity === "error" ? "medium" : "low",
      claim: ruleClaim(m.ruleId, m.message ?? "pattern matched", "ast-grep"),
      evidence: sitesEvidence("ast-grep", m.ruleId ?? "", file, lines),
      failureScenario: "matches a structural rule this project has chosen to enforce",
    });
  });
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
