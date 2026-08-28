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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Severity } from "../core/finding.ts";
import type { T0Engine } from "../core/review-type.ts";
import { gitlinks } from "../git/repo.ts";
import { commitToFindings, queryCommit, queryComponents, toFindings } from "../security/osv.ts";
import { generateSbom } from "../security/sbom.ts";
import { runTool } from "./exec.ts";
import { SKIP_DIRS } from "./sandbox.ts";

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
  /**
   * True when an engine ATTEMPTED to run and did not finish — killed, ran out of
   * memory, timed out — as opposed to `unavailable` alone, which also covers a
   * STABLE absence (no config, not installed) that says nothing about whether this
   * ROUND's silence can be trusted.
   *
   * Found by lore's own review of the OOM-kill fix, fingerprints dd98f788 and
   * 4a39ae0d: `settleFixed` (reviewer/review.ts) treats T0's silence about a
   * previously open finding as proof it is fixed, and `renderT0Delta` tells a kept
   * session the same previously-seen finding "resolved" — both on the reasoning
   * that T0 re-scans the whole worktree every round. True for a genuinely absent
   * config, which does not change round to round; false for a run that was cut
   * short, which says nothing about the code either way. Consumers that need to
   * know whether THIS round's silence means anything read this, not `unavailable`.
   */
  readonly interrupted?: boolean;
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
 *
 * `:` IS IN THE BODY CLASS TOO, for the same reason `@` had to be: clippy's own rule
 * ids are module-path-shaped (`clippy::needless_return`), and without this a clippy
 * finding read back as no class at all — the identical D-83 failure the leading `@`
 * was added to fix, reopened for a different punctuation mark. Traced by hand against
 * every existing "gives no class to a claim that is a sentence" case in
 * `engines.test.ts`: none of them regain a class, because each already fails the match
 * before reaching where a `:` would matter — a leading backtick, a space, or a second
 * `@` mid-string, none of which involve the newly-allowed character.
 */
const RULE_CLASS = /^(@?[A-Za-z][A-Za-z0-9._/:-]*):\s/;

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
 *
 * THE WARNING GOES FIRST, THE SITE LIST SECOND — found by lore's own review,
 * fingerprint 2aae6ed2. `finding()` caps evidence at 2000 chars from the tail
 * (`cap()`), so whichever half is written second is what a rule with enough
 * matches in one file loses — and the ORIGINAL order put the unbounded site
 * list first, meaning the count and the "fixing the first does not fix the
 * rest" warning silently disappeared exactly on the files with the most sites,
 * where losing it matters most. Same rule this file's own sibling
 * (`core/finding.ts`, the note-before-evidence fix) already states: "whatever a
 * later tail-clamp must not lose goes first, and the sacrificial content goes
 * last" — the individual `file:line` entries are the sacrificial content here,
 * not the warning.
 */
function sitesEvidence(tool: string, rule: string, file: string, lines: readonly number[]): string {
  const at = lines.map((l) => `${file}:${String(l)}`).join(", ");
  if (lines.length < 2) return `${tool} ${rule} at ${at}`;
  return (
    `${String(lines.length)} SEPARATE SITES IN THIS FILE. Fixing the first does not fix the rest — ` +
    "answer the whole set, and prefer a change that makes the pattern safe by construction over arguing " +
    `each site's inputs.\n${tool} ${rule} at ${at}`
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

// lore-ok[6b8b5c00]: EVERY ECOSYSTEM sbom.ts CAN ENUMERATE, not just npm's. A
// pure Go/PyPI/Rust/Maven/RubyGems repo has no package.json, so gating on it
// alone reported both `sbom` and `osv` "not configured" — even with cdxgen
// installed, which is exactly the tool sbom.ts builds to enumerate the other
// five ecosystems. One manifest name per ecosystem, mirroring the set
// `security/sbom.ts`'s own `Ecosystem` type names.
const ECOSYSTEM_MANIFESTS = ["package.json", "go.mod", "Cargo.toml", "pom.xml", "requirements.txt", "pyproject.toml", "Gemfile"];

// Both config systems, because a target's OWN eslint version — never checked
// here, only ITS config files — decides which one actually applies. Flat config
// (`eslint.config.*`) is the default since ESLint 9 and the only one ESLint 10+
// understands without the `@eslint/eslintrc` compat package; eslintrc mode
// (`.eslintrc.*`, `eslintConfig` in package.json) is deprecated but still what a
// great many real repos, pinned to ESLint 8/9, actually run. `detect()` cannot
// know which; it can at least stop missing the legacy names it already claims to
// recognise two of. Verified against ESLint's own current docs and the VS Code
// ESLint extension's own supported-file list, not assumed from memory.
const ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc",
];

/**
 * Fingerprint 78c3f83f: the file-name list above was missing `.eslintrc.js` —
 * the FIRST name in eslint's own eslintrc-mode resolution order and the most
 * common legacy config in the wild — plus its `.yml`/`.yaml`/bare siblings and
 * flat config's `.cjs` variant. A repo configured only through one of those was
 * told "no eslint config", false, and eslint never ran. `package.json`'s
 * `eslintConfig` key is the other legal location this list cannot express as a
 * bare filename; checked here by actually reading the one file every JS/TS repo
 * already has, not by adding a new file-existence check that would still miss it.
 */
function hasEslintConfig(worktree: string): boolean {
  if (ESLINT_CONFIG_FILES.some((f) => existsSync(join(worktree, f)))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8")) as { eslintConfig?: unknown };
    return pkg.eslintConfig !== undefined;
  } catch {
    return false;
  }
}

/**
 * The repo-relative path of the first `ECOSYSTEM_MANIFESTS` name found at the
 * root OR one level down — the same shallow walk `detectEcosystems`
 * (`sandbox.ts`) already does for cargo/npm's execution routing, applied here to
 * the FULL manifest list `sbom`/`osv` actually care about (that function only
 * ever checks npm and cargo, so it cannot answer this question directly).
 * Synchronous, unlike `detectEcosystems`, so `detect()` — a plain boolean
 * predicate every caller already treats as free — does not need to become async
 * just to gain this.
 *
 * ROOT-ONLY used to be the whole check, so a repo whose only manifest sits one
 * level down (this deployment's own `acdc`, `infra/package.json`, no root
 * manifest at all — `sandbox.test.ts`'s own fixture for exactly this shape) was
 * told sbom/osv were "not configured", false: `cdxgen` scans recursively from cwd
 * and would have found it. Found by lore's own review, fingerprint 89c15f09.
 *
 * Returns the PATH rather than a bare boolean so `sbom()`'s own "could not
 * enumerate" finding (fingerprint 049efb31, a direct follow-on this same
 * one-level walk exposed: its own file fallback re-checked the root only,
 * disagreeing with the gate that just decided to run it) can name whichever
 * manifest actually exists instead of re-deriving — and re-narrowing — the
 * same answer a second, inconsistent way.
 */
function findManifestNearby(worktree: string): string | undefined {
  const root = ECOSYSTEM_MANIFESTS.find((f) => existsSync(join(worktree, f)));
  if (root !== undefined) return root;
  const entries = (() => {
    try {
      return readdirSync(worktree, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const nested = ECOSYSTEM_MANIFESTS.find((f) => existsSync(join(worktree, entry.name, f)));
    if (nested !== undefined) return join(entry.name, nested);
  }
  return undefined;
}

function hasManifestNearby(worktree: string): boolean {
  return findManifestNearby(worktree) !== undefined;
}

export function detect(worktree: string, engine: T0Engine): boolean {
  switch (engine) {
    case "tsc":
      return existsSync(join(worktree, "tsconfig.json"));
    case "eslint":
      return hasEslintConfig(worktree);
    // ROOT-ONLY, like tsc's tsconfig.json check above — the same shallow signal
    // detect() gives every engine. It is not where nested-crate awareness lives:
    // `sandboxedCargo()` (runner.ts) uses `detectEcosystems`'s own one-level walk for
    // the actual execution decision, the same way `commandsFor` already does for npm's
    // nested-manifest case.
    case "cargo-check":
    case "cargo-clippy":
      return existsSync(join(worktree, "Cargo.toml"));
    case "ast-grep":
      return existsSync(join(worktree, "sgconfig.yml")) || existsSync(join(worktree, "sgconfig.yaml"));
    case "semgrep":
      // Semgrep needs no project config: the registry rulesets are the value, and
      // they carry CWE metadata that lands in the same namespace as model findings.
      return true;
    case "sbom":
      return hasManifestNearby(worktree);
    case "osv":
      // Not the same condition as `sbom`, though it was written as one.
      //
      // OSV queries packages FROM the SBOM and submodules by commit. A repository
      // that vendors purely by gitlink has no manifest at all, so sharing the gate
      // skipped the whole engine — the vulnerability check declining to run on the
      // exact repository shape it was built for (D-36), and reporting nothing, which
      // is the reading INV-1 forbids.
      return hasManifestNearby(worktree) || existsSync(join(worktree, ".gitmodules"));
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

/**
 * The paths to hand an engine, or `["."]` when there are too many or none.
 *
 * lore-ok[3ce0faea]: the finding is right and the fix is in `runT0`, one layer up. A
 * branch's diff names the files it DELETED as well as the ones it changed, those paths
 * are not in the worktree, and semgrep treats a missing scanning root as fatal — one
 * deleted file would kill the whole run and surface as "semgrep produced unparseable
 * output", pointing at the wrong thing entirely.
 *
 * Filtering here was the wrong place and I tried it first: this function has no worktree,
 * so it cannot ask whether a path exists without being handed a second argument that only
 * one caller could supply. `runT0` already holds the worktree and is the single point
 * every engine's scope passes through, so the check happens there, once, before any
 * engine is called. This function keeps the concern it can actually answer — how many
 * paths are too many for an argv.
 */
export function scopePaths(scope: Scope): readonly string[] {
  if (scope === undefined || scope.length === 0 || scope.length > MAX_SCOPED_PATHS) return ["--", "."];
  // `--` AND `./`, because these paths come from the BRANCH UNDER REVIEW and a filename
  // is not a value we choose. Before D-92 the only positional was the constant `"."`;
  // splicing repo-relative names onto the argv made a root file called `--config` parse
  // as an option — and eat the NEXT path as its value, which a second file in the same
  // branch could supply as a crafted ruleset. `git add --` will commit such a name
  // happily.
  //
  // Both guards, not one: `--` is the standard terminator and every CLI here honours it,
  // and `./` makes the path unmistakably a path even if some future engine does not.
  return ["--", ...scope.map((p) => (p.startsWith("./") || p.startsWith("/") ? p : `./${p}`))];
}

export async function runEngine(worktree: string, engine: T0Engine, scope?: Scope): Promise<EngineOutcome> {
  // Refused rather than defaulted. These resolve their binary out of the target's
  // own dependency tree (tsc/eslint via node_modules) or fully compile and RUN
  // target-controlled code (cargo-check/cargo-clippy: a build.rs or proc-macro
  // executes natively during a check, not just a script) — so the service must
  // never run any of them — `runner.ts` drives them inside the sandbox. Falling
  // through to "has no runner" would read as a missing feature instead of a
  // boundary (D-24).
  if (engine === "tsc" || engine === "eslint" || engine === "cargo-check" || engine === "cargo-clippy") {
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
    // driven by `runner.ts` inside the same container the suite uses. `semgrep` and
    // `ast-grep` stay: those genuinely are lore's own binaries reading files, no
    // install needed. `sbom`'s PRIMARY path is not the same shape — it runs
    // `cdxgen`, third-party code from npm, via `runTool` in `security/sbom.ts` —
    // but it needs no INSTALL either (`npx` resolves it on demand), and `runTool`'s
    // own default env is what keeps this safe now rather than the identity of the
    // binary (fingerprint 72871cca: this comment used to be the false half of that
    // claim). `osv` queries a database directly and runs no external tool at all.
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
          // lore-ok[b03d0b1e]: WHICHEVER MANIFEST ACTUALLY EXISTS, not a
          // hardcoded npm path. `detect()`'s own widening above means this
          // branch is now reachable on a pure Go/PyPI/Rust/Maven/RubyGems
          // repo, where "package.json" names a file that was never there,
          // violating Finding.file's own repo-relative-path contract the same
          // way a sentence in this exact field already violated it once
          // before.
          //
          // `findManifestNearby`, not a bare root-only re-check — fingerprint
          // 049efb31: `detect()` gates this engine on `hasManifestNearby`'s
          // one-level walk, so a root-only re-check here disagreed with the
          // very gate that let this branch run, on the exact repo shape
          // (`acdc`) that gate was fixed for.
          file: findManifestNearby(worktree) ?? "package.json",
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
  // `bom.incomplete` READ HERE TOO, not only above — a SBOM that mostly enumerated
  // fine can still carry it, when some components were dropped (an unrecognised
  // ecosystem, a malformed entry — see `generateSbom`'s own callers), and gating
  // this read on `source === "none"` discarded it silently: a partial enumeration
  // read as a complete one, the same INV-1 shape the whole-tree case above already
  // refuses to make. Deliberately not `bom.note`: that field is a methodology
  // caveat true on EVERY fallback-path run (see its own doc comment in sbom.ts),
  // and surfacing it here would report "NOT RUN" on a SBOM that did run.
  return { engine: "sbom", findings: [], ...(bom.incomplete !== undefined ? { unavailable: bom.incomplete } : {}) };
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
      // lore-ok[e3951d35]: `bom.incomplete` CHECKED FIRST. cdxgen can enumerate N
      // raw components and drop every one as unqueryable (a Composer/NuGet-only
      // tree) — `components.length` is 0 either way, but "12 of 12 dropped,
      // nothing checked" and "nothing here to check" are different claims, and
      // only the former is true when `incomplete` is set. `sbom()` (above)
      // already gets this right on the exact same tree; this made osv's own line
      // in checks_skipped false on it.
      return { engine: "osv", findings: [], unavailable: bom.incomplete ?? bom.note ?? "nothing to query" };
    }

    if (bom.components.length > 0) findings.push(...toFindings(await queryComponents(bom.components)));
    for (const link of links) {
      findings.push(...commitToFindings(link.path, link.commit, await queryCommit(link.commit)));
    }
    // `bom.incomplete` READ HERE TOO — the same gap as `sbom()`'s own above: a
    // SBOM that mostly enumerated fine can still carry it (some components
    // dropped for an unrecognised ecosystem or a malformed entry), and the direct
    // return below used to discard it whenever ANY component existed to query —
    // a partial enumeration read as a complete one. Deliberately not `bom.note`:
    // see `sbom()`'s own comment on this, just above.
    return { engine: "osv", findings, ...(bom.incomplete !== undefined ? { unavailable: bom.incomplete } : {}) };
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

/**
 * A monorepo runner's own per-line prefix, stripped from a captured file.
 *
 * `TSC_LINE`'s file capture is unanchored — it takes whatever precedes the first
 * `(line,col):`, which is correct for tsc's OWN plain output but not for what
 * reaches this parser in practice: `checkTypes`'s `scripts["typecheck"]` branch
 * feeds a monorepo task runner's stdout straight through (its own comment says so
 * — "a monorepo runner usually forwards tsc's own lines"), and Turborepo prefixes
 * every line with `<package>:<task>:` by default (`--log-prefix=auto`, active on
 * piped/non-TTY output — which `docker run`'s stdout always is here). Unstripped,
 * `web:typecheck: src/a.ts(3,7): error TS2322: ...` records `finding.file` as
 * `"web:typecheck: src/a.ts"` — resolvable nowhere, so `scopeOf` can never read it
 * and the finding can never settle. General rather than turbo-specific: strips ANY
 * number of leading `label:` segments followed by whitespace, so pnpm's `-r`
 * prefix or nx's own task-runner prefix are handled the same way without needing
 * to name each one. Found by lore's own review, fingerprint 25327c6b.
 */
function stripRunnerPrefix(file: string): string {
  return file.replace(/^(?:[\w@./-]+:)+\s+/, "");
}

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
    file: stripRunnerPrefix(m[1] ?? ""),
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

// ---------------------------------------------------------------------- cargo

/**
 * One line of `cargo check --message-format=json` / `cargo clippy --message-format=json`.
 *
 * Schema verified against the Cargo Book and rustc's own JSON diagnostic docs, not
 * assumed from memory: `reason: "compiler-message"` wraps a nested `message` object
 * shaped like rustc's own diagnostic (`code: {code, explanation} | null`, not a bare
 * string), and `spans[]` carries `is_primary`/`file_name`/`line_start`. `note`/`help`
 * level diagnostics only ever appear nested inside a parent's `children` array — never
 * as their own top-level `reason: "compiler-message"` entries — so filtering top-level
 * entries to `level === "error" | "warning"` already excludes them without needing to
 * read `children` at all.
 */
interface CargoSpan {
  file_name: string;
  line_start: number;
  is_primary: boolean;
}
interface CargoMessage {
  message: string;
  code: { code: string } | null;
  level: string;
  spans: CargoSpan[];
}
interface CargoEntry {
  reason: string;
  message?: CargoMessage;
}

/**
 * Parse `cargo check`/`cargo clippy --message-format=json`. Shared: both emit the
 * same shape.
 *
 * `dir` is the crate's own directory relative to the worktree root ("." for a root
 * crate, "server" for one found one level down — `detectEcosystems`' own shape) —
 * NOT the worktree itself. Found by lore's own review, fingerprint 47ddd7fa, and
 * confirmed empirically against a real `cargo check --manifest-path <nested>`
 * invocation: `file_name` in a span comes back relative to the MANIFEST's own
 * directory, never the worktree root and never absolute, so a nested crate's
 * finding needs `dir` prefixed back on or it names a file that does not exist at
 * the path it claims.
 */
export function parseCargoJson(engine: "cargo-check" | "cargo-clippy", stdout: string, dir: string): Finding[] {
  const messages: CargoMessage[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let entry: CargoEntry;
    try {
      entry = JSON.parse(trimmed) as CargoEntry;
    } catch {
      continue;
    }
    if (entry.reason === "compiler-message" && entry.message !== undefined) messages.push(entry.message);
  }

  // ERROR/WARNING ONLY. A whole-crate summary ("aborting due to 2 previous errors")
  // carries no span and no information beyond the individual diagnostics already
  // reported — dropped rather than turned into a finding with no site, matching how
  // every other engine here only ever produces site-anchored findings.
  //
  // CLIPPY-NAMESPACED CODES ONLY, for the clippy engine — found by lore's own
  // review, fingerprint d269a60f, and confirmed empirically: `clippy-driver` IS
  // `rustc` with an extra lint pass layered on, so `cargo clippy`'s own JSON
  // stream carries every ordinary rustc diagnostic `cargo check` would ALSO
  // report (a plain `unused_variables` warning came back byte-identical from
  // both, same fixture, same message, same code) — `ruleClaim` then makes the
  // two ENGINES' claims for that one diagnostic literally identical strings,
  // shown to the model tier twice in one prompt with no dedup at that layer
  // (only the store's `ON CONFLICT DO NOTHING` and `renderT0Delta`'s later
  // fingerprint map catch it, neither of which the FIRST round's prompt goes
  // through). Kept to `clippy::`-prefixed codes for this engine; `cargo-check`
  // stays the sole, authoritative source for everything else. Nothing is lost:
  // clippy cannot even reach its own lint pass on code that fails to compile, so
  // every compile error it would report, `cargo-check`'s own independent
  // invocation already does.
  const diagnostics = messages.filter((m) => {
    if (m.level !== "error" && m.level !== "warning") return false;
    if (engine === "cargo-clippy") return m.code?.code.startsWith("clippy::") ?? false;
    return true;
  });
  const flat = diagnostics.flatMap((m) => {
    const primary = m.spans.find((s) => s.is_primary);
    if (primary === undefined) return [];
    // lore-ok[eaea5664]: plausible, and I could not settle it — not fixed. The
    // 47ddd7fa verification above is real but narrower than this rebase: it ran
    // `cargo check --manifest-path` against a SINGLE nested crate, never a
    // WORKSPACE manifest (one Cargo.toml, members below it). Whether a member's
    // own `file_name` comes back relative to the workspace root (this rebase is
    // already correct) or relative to the MEMBER's own directory (it is not, and
    // `message.package_id` — present in the schema, read by nothing here — would
    // be the fix, itself needing either a `cargo metadata` call to resolve it to
    // a path or correct parsing of its own format, both unverified here too) is
    // genuinely unclear to me without running real cargo against a real
    // workspace, which this sandbox cannot do yet (D-131's own scope: no
    // toolchain in the image). Guessing at a rebase I cannot test risks trading
    // a real bug for an equally untested wrong one. Named here, not fixed here,
    // for the same reason SPEC.md's own D-131 entry already gives this whole
    // function's verification: "deferred to whichever follow-up adds the
    // toolchain... this repo's own D-77 verification step for that change."
    const file = dir === "." ? primary.file_name : `${dir}/${primary.file_name}`;
    return [{ m, file, line: primary.line_start }];
  });

  // GROUPED LIKE THE PATTERN ENGINES — see `bySite`. clippy in particular repeats one
  // lint many times in one file at least as often as eslint does.
  return bySite(flat, ({ m, file, line }) => ({
    claim: ruleClaim(m.code?.code, m.message, engine),
    file,
    line,
  })).map(({ match: { m }, file, lines }) => {
    const first = lines[0];
    return finding({
      file,
      ...(first !== undefined && first > 0 ? { line: first } : {}),
      severity: m.level === "error" ? "high" : "medium",
      claim: ruleClaim(m.code?.code, m.message, engine),
      evidence: sitesEvidence(engine, m.code?.code ?? "", file, lines),
      failureScenario:
        m.level === "error"
          ? "the project does not compile, so this cannot ship as-is"
          : "violates a lint this project's own toolchain flags",
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
  // `interrupted: r.timedOut` — found by lore's own review, fingerprint dd36a31b:
  // a timeout is the third way a run does not finish, alongside a kill and OOM,
  // and `ToolResult` already carries it as a structured flag rather than a message
  // to guess from. `unavailable` alone does not distinguish it from a stable
  // absence (no rules configured), which must NOT withhold trust from this round.
  if (r.unavailable !== undefined) return { engine: "semgrep", findings: [], unavailable: r.unavailable, interrupted: r.timedOut };
  // Found by lore's own review of the t0/runner.ts OOM fix, fingerprint 10986564:
  // the same wrong-reason defect that fix removed from checkTypes/checkLint stood
  // here too. semgrep runs on the HOST, not the sandbox, so this is never the
  // `--memory` cgroup specifically — but a SIGKILL (137), most often an OOM-killer
  // reacting to memory pressure wherever this process runs, still truncates the
  // JSON the same way, and "unparseable output" points at semgrep's config rather
  // than the actual cause.
  if (r.code === 137) {
    return {
      engine: "semgrep",
      findings: [],
      unavailable: "semgrep was killed (exit 137) — most likely a memory limit, not a fault in the branch",
      interrupted: true,
    };
  }
  const parsed = parseSemgrep(r.stdout, worktree);
  if (parsed === undefined) {
    return { engine: "semgrep", findings: [], unavailable: "semgrep produced unparseable output" };
  }
  const { findings, unread } = parsed;
  // `interrupted: unread.length > 0` — a file semgrep could not parse is a site it
  // did not finish reading, the same fact `interrupted`'s own doc comment names
  // for a kill or a timeout, and `parseSemgrep`'s own comment already says so
  // ("the same fact"). Without it, `settleFixed`/`renderT0Delta` (both gate on
  // `interrupted`, never on `unavailable`) treated this round's silence about the
  // skipped file as proof any finding there was fixed — the exact false-resolved
  // claim the OOM-kill fix (fingerprints dd98f788/4a39ae0d) exists to prevent, for
  // a second way a file can go unread. Found by lore's own review, fingerprint
  // 3acaef31.
  //
  // lore-ok[f30f0b2f]: real cost, correctly reused mechanism, not fixed here. A
  // permanently-unparseable file (checked-in minified vendor code) makes this
  // TRUE on every round for the life of that review, not the "rare round" T0Result
  // .interrupted's own doc prices — round-level is `interrupted`'s EXISTING
  // architecture (`runT0`'s `outcomes.some(...)`, already true for a rare OOM/
  // timeout before this fix ever touched semgrep), and this fix correctly reuses
  // it rather than inventing a second mechanism; what changed is FREQUENCY, not
  // correctness — a stable fact now trips a flag priced for a transient one. A
  // real fix needs one of two bigger changes than this finding's own severity
  // (low) warrants rushing: per-finding rather than round-level interrupted
  // tracking, or persisting which files were ALREADY known-unparseable last round
  // so an unchanged set stops re-tripping it. Both are real future work; neither
  // is a same-round patch I am confident enough in to ship blind. The cost is
  // real but SAFE — more manual settling, never a false auto-settle — which is
  // the same trade every other `interrupted` cause in this file already makes.
  return {
    engine: "semgrep",
    findings,
    ...(unread.length === 0 ? {} : { unavailable: unread.join("\n"), interrupted: true }),
  };
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
  // Same fix as semgrep above, fingerprint dd36a31b.
  if (r.unavailable !== undefined) return { engine: "ast-grep", findings: [], unavailable: r.unavailable, interrupted: r.timedOut };
  // Same fix as semgrep above, fingerprint 10986564.
  if (r.code === 137) {
    return {
      engine: "ast-grep",
      findings: [],
      unavailable: "ast-grep was killed (exit 137) — most likely a memory limit, not a fault in the branch",
      interrupted: true,
    };
  }
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
