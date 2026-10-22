/**
 * T0 for Ethereum projects, foundry AND hardhat: build, test, slither, aderyn, solhint and the
 * known-compiler-bug check — every one in the EVM sandbox image
 * (`deploy/sandbox-evm.Dockerfile`), never in the service (D-24: a build compiles and a test
 * RUNS the target's code).
 *
 * THE PHASES, and why only the first has network:
 *   1. install and compile — foundry: clone `lib/` at the commits the tree pins, `forge build`.
 *      hardhat: install from the LOCKFILE (frozen: a review must read what the branch pins,
 *      never what resolves today), then `hardhat compile`. Both fetch their solc here, and
 *      aderyn runs here, because it fetches its own solc too.
 *   2. tests and analysis — `--network none`. A fork test fails here and is reported as a
 *      test that did NOT run, never a defect; there is no RPC and no key in the sandbox.
 * ALL COMPILING IS PHASE 1 for hardhat: offline, `hardhat compile` re-fetches its compiler
 * list and fails on DNS (found by the first sandbox run), so phase 2 reads the result phase 1
 * recorded, tests run on the cached build, and slither reads the artifacts
 * (`--hardhat-ignore-compile`) instead of recompiling with `--force`.
 *
 * `/work` is one scratch copy for the whole run (`cp -a`, never deleted mid-run), so what
 * phase 1 fetched is there for the rest. HOME points into it because the sandbox runs as the
 * service's uid, which has no home.
 *
 * A TOOL THAT CANNOT START IS UNAVAILABLE, NEVER A FINDING (#0050, D-158).
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { T0Engine } from "../core/review-type.ts";
import type { Finding } from "../core/finding.ts";
import { gitMaybe } from "../git/exec.ts";
import { finding, type EngineOutcome } from "./engines.ts";
import { detectEvm, type EvmFramework } from "./evm-detect.ts";
import {
  classifyMochaPoc, classifyPoc, forgeTestFindings, installFailure, matchSolcBugs, mochaFindings, parseAderyn, parseForgeBuild,
  parseForgeTest, parseHardhatCompile, parseMocha, parseSlither, parseSolhint, type PocOutcome, type SolcBuild,
} from "./evm-parse.ts";
import { runInSandbox, type SandboxConfig } from "./sandbox.ts";
import type { ToolResult } from "./exec.ts";

export const EVM_ENGINES: readonly T0Engine[] = ["evm-build", "evm-test", "slither", "aderyn", "solhint", "solc-bugs"];

/** The EVM image, beside the JS one. Built by `make up` like it (the `sandbox-evm` service). */
export const EVM_IMAGE = process.env["LORE_SANDBOX_EVM_IMAGE"] ?? "lore-sandbox:evm";

const ENV = "export HOME=/work/.lore-home FOUNDRY_DISABLE_NIGHTLY_WARNING=1 HARDHAT_DISABLE_TELEMETRY_PROMPT=true CI=true; mkdir -p \"$HOME\";";

const exists = async (worktree: string, f: string) => (await readFile(join(worktree, f)).catch(() => undefined)) !== undefined;
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
/** Model- or lore-written text into the scratch copy, through base64: it cannot end a quote. */
const writeFile = (path: string, text: string) => `echo ${Buffer.from(text, "utf8").toString("base64")} | base64 -d > ${q(path)}`;

/** The git dependencies a foundry tree pins: `.gitmodules` paths and urls, gitlink commits. */
async function pinnedDeps(worktree: string): Promise<readonly { path: string; url: string; sha: string }[]> {
  const modules = await readFile(join(worktree, ".gitmodules"), "utf8").catch(() => "");
  const urls = new Map<string, string>();
  let path: string | undefined;
  for (const line of modules.split("\n")) {
    const p = /^\s*path\s*=\s*(.+?)\s*$/.exec(line)?.[1];
    if (p !== undefined) path = p;
    const u = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1];
    if (u !== undefined && path !== undefined) urls.set(path, u);
  }
  if (urls.size === 0) return [];
  const staged = (await gitMaybe(worktree, ["ls-files", "-s"])) ?? "";
  const out: { path: string; url: string; sha: string }[] = [];
  for (const l of staged.split("\n")) {
    const m = /^160000 ([0-9a-f]{40}) \d+\t(.+)$/.exec(l);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    const url = urls.get(m[2]);
    if (url !== undefined) out.push({ path: m[2], url, sha: m[1] });
  }
  return out;
}

/**
 * The install a hardhat tree's LOCKFILE asks for, frozen. Not the JS sandbox's `commandsFor`:
 * that one falls back to an unfrozen install, which resolves today's versions — a review of
 * contracts must compile exactly what the branch pins, or its CVE and compiler checks describe
 * a tree nobody ships. No lockfile is refused for the same reason.
 */
async function installFor(worktree: string, fw: Extract<EvmFramework, { kind: "hardhat" }>): Promise<string | undefined> {
  switch (fw.lockfile) {
    case "yarn.lock": {
      const text = await readFile(join(worktree, "yarn.lock"), "utf8").catch(() => "");
      return /^__metadata:/m.test(text)
        ? "COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack yarn install --immutable"
        : "yarn install --frozen-lockfile --non-interactive --network-timeout 600000";
    }
    case "package-lock.json":
      return "npm ci --no-audit --no-fund";
    case "pnpm-lock.yaml":
      return "pnpm install --frozen-lockfile";
    default:
      return undefined;
  }
}

/** What became of a sandbox call that did not produce parseable output. */
function didNotRun(engine: T0Engine, what: string, r: ToolResult): EngineOutcome {
  if (r.unavailable !== undefined) return { engine, findings: [], unavailable: `${what} could not run: ${r.unavailable}`, interrupted: r.timedOut };
  if (r.code === 137) return { engine, findings: [], unavailable: `${what} was killed (exit 137) — a memory limit, not the branch`, interrupted: true };
  if (r.code === 127) return { engine, findings: [], unavailable: `${what}: the tool is not in the sandbox image (${EVM_IMAGE})` };
  const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-8).join("\n").slice(0, 800);
  return { engine, findings: [], unavailable: `${what} produced no output lore can read (exit ${String(r.code)}): ${tail}`, interrupted: true };
}

/** A prepared workspace, or why it could not be prepared — and, for that, whether it is the branch's fault. */
type Workspace =
  | { readonly framework: EvmFramework; readonly offline: (script: string) => Promise<ToolResult> }
  | { readonly framework: EvmFramework; readonly failed: ToolResult; readonly why: string; readonly finding?: Finding };

/** The hardhat config, wrapped so mocha writes JSON to a file — in the SCRATCH copy only. */
function mochaWrapper(fw: Extract<EvmFramework, { kind: "hardhat" }>): { readonly file: string; readonly text: string } | undefined {
  const mocha = `mocha: { ...(c.mocha ?? {}), reporter: "json", reporterOptions: { output: "/work/.lore-mocha.json" } }`;
  if (fw.config.endsWith(".ts")) {
    return { file: "hardhat.lore.config.ts", text: `import config from "./hardhat.config";\nconst c: any = (config as any).default ?? config;\nexport default { ...c, ${mocha} };\n` };
  }
  if (fw.config.endsWith(".js") || fw.config.endsWith(".cjs")) {
    return { file: "hardhat.lore.config.cjs", text: `const m = require("./${fw.config}");\nconst c = m.default ?? m;\nmodule.exports = { ...c, ${mocha} };\n` };
  }
  return undefined;
}

export async function sandboxedEvm(worktree: string, base: SandboxConfig, engines: readonly T0Engine[]): Promise<EngineOutcome[]> {
  const wanted = engines.filter((e) => EVM_ENGINES.includes(e));
  if (wanted.length === 0) return [];
  const fw = await detectEvm(worktree);
  if (fw === undefined) {
    return wanted.map((engine) => ({ engine, findings: [], skipped: `${engine}: no foundry.toml or hardhat.config.* at the worktree root (not an Ethereum project, optional)` }));
  }

  return withWorkspace(worktree, base, fw, {}, async (ws) => {
    if ("failed" in ws) {
      // The branch's own fault (its lockfile does not install) is ONE finding, on the build;
      // every other engine says why it could not run. Anything else is the environment.
      const branchFault = ws.finding;
      return wanted.map((engine): EngineOutcome =>
        branchFault === undefined
          ? { ...didNotRun(engine, ws.why, ws.failed), interrupted: true }
          : engine === "evm-build"
            ? { engine, findings: [branchFault], unavailable: `${engine}: ${ws.why}, so nothing that needs them could run` }
            : { engine, findings: [], unavailable: `${engine}: ${ws.why}, so it could not run` },
      );
    }
    const { offline } = ws;
    const out: EngineOutcome[] = [];

    // BUILT ONCE, read by everything after it: a branch that does not compile has no tests and
    // nothing to analyse, and saying "slither found nothing" about it would be INV-1.
    let buildFindings: readonly Finding[] | undefined;
    let built: ToolResult;
    if (fw.kind === "foundry") {
      built = await offline("forge build --build-info --json");
      buildFindings = parseForgeBuild(built.stdout);
    } else {
      // Phase 1 compiled; this reads what it recorded. "rc" first, then the log.
      built = await offline("cat /work/.lore-compile.rc; echo; cat /work/.lore-compile.log");
      const [rc = "", ...log] = built.stdout.split("\n");
      buildFindings = /^\d+$/.test(rc.trim()) ? parseHardhatCompile(log.join("\n"), Number(rc.trim())) : undefined;
    }
    const compiles = buildFindings !== undefined && buildFindings.length === 0;
    if (wanted.includes("evm-build")) {
      out.push(buildFindings === undefined ? didNotRun("evm-build", `${fw.kind} build`, built) : { engine: "evm-build", findings: buildFindings });
    }
    const rest = wanted.filter((e) => e !== "evm-build");
    if (!compiles) {
      // Said as what is KNOWN: a build that did not run is not a build that failed.
      const why = buildFindings === undefined ? `${fw.kind} build did not run, so nothing after it could` : "the contracts do not compile, so it could not run";
      for (const engine of rest) out.push({ engine, findings: [], unavailable: `${engine}: ${why}`, ...(buildFindings === undefined ? { interrupted: true } : {}) });
      return out;
    }

    if (rest.includes("evm-test")) out.push(await runTests(fw, offline));
    if (rest.includes("slither")) {
      // foundry: slither compiles through forge (offline: solc is cached) — not
      // `--foundry-ignore-compile`, because crytic-compile 0.4.2 cannot read forge 1.8's
      // build-info. hardhat: the opposite — recompiling needs the network, so it reads the
      // artifacts phase 1 left.
      const flags = fw.kind === "hardhat" ? "--hardhat-ignore-compile" : "";
      const r = await offline(`rm -f /work/.lore-slither.json; slither . ${flags} --json /work/.lore-slither.json --filter-paths 'lib/|node_modules/' --exclude-dependencies >/dev/null 2>&1; cat /work/.lore-slither.json`);
      const parsed = parseSlither(r.stdout);
      if (parsed === undefined) out.push(didNotRun("slither", "slither", r));
      else {
        if (parsed.notes > 0) console.error(`[lore:log] slither: ${String(parsed.notes)} low/informational note(s), not raised`);
        out.push({ engine: "slither", findings: parsed.findings });
      }
    }
    if (rest.includes("aderyn")) {
      const r = await offline("cat /work/.lore-aderyn.json");
      const parsed = parseAderyn(r.stdout);
      if (parsed === undefined) out.push(didNotRun("aderyn", "aderyn", r));
      else {
        // NOTES, NOT FINDINGS. On the first sandbox run aderyn's HIGH bucket fired
        // `eth-send-unchecked-address` on a correct checks-effects-interactions withdraw to
        // msg.sender — the canonical pattern, so as a gate it would block every correct
        // withdraw function. slither carries the gate; aderyn's hits are logged for the
        // operator, never raised, until one of its detectors earns a place by evidence.
        const hits = parsed.findings.map((f) => `${f.file}:${String(f.line ?? "?")} ${f.claim}`);
        console.error(`[lore:log] aderyn (notes only, not raised): ${String(parsed.findings.length)} high, ${String(parsed.notes)} low${hits.length > 0 ? ` — ${hits.join("; ")}` : ""}`);
        out.push({ engine: "aderyn", findings: [] });
      }
    }
    if (rest.includes("solhint")) {
      // The PROJECT's lint: without a config of its own there is no rule set it chose.
      const configured = (await Promise.all([".solhint.json", ".solhintrc", ".solhintrc.json"].map((f) => exists(worktree, f)))).some(Boolean);
      if (!configured) out.push({ engine: "solhint", findings: [], skipped: "solhint: no .solhint.json in this project (optional)" });
      else {
        const dir = fw.kind === "foundry" ? "src" : "contracts";
        const r = await offline(`solhint -f json '${dir}/**/*.sol'`);
        const parsed = parseSolhint(r.stdout);
        out.push(parsed === undefined ? didNotRun("solhint", "solhint", r) : { engine: "solhint", findings: parsed });
      }
    }
    if (rest.includes("solc-bugs")) out.push(await solcBugs(fw, offline));
    return out;
  });
}

async function runTests(fw: EvmFramework, offline: (s: string) => Promise<ToolResult>): Promise<EngineOutcome> {
  if (fw.kind === "foundry") {
    const r = await offline("forge test --json");
    const parsed = parseForgeTest(r.stdout);
    if (parsed === undefined) return didNotRun("evm-test", "forge test", r);
    const net = parsed.failures.filter((f) => f.needsNetwork);
    return {
      engine: "evm-test",
      findings: forgeTestFindings(parsed.failures),
      ...(net.length === 0 ? {} : { unavailable: `forge test: ${String(net.length)} test(s) need a network the sandbox does not have (fork/RPC) and did NOT run: ${net.map((f) => `${f.contract}.${f.test}`).join(", ")}` }),
    };
  }
  const wrap = mochaWrapper(fw);
  if (wrap === undefined) return { engine: "evm-test", findings: [], unavailable: `hardhat test: lore cannot wrap a ${fw.config} config (only .ts, .js, .cjs), so the tests did NOT run` };
  const r = await offline(`${writeFile(wrap.file, wrap.text)}; rm -f /work/.lore-mocha.json; npx --no-install hardhat --config ${wrap.file} test >/work/.lore-test.log 2>&1; cat /work/.lore-mocha.json`);
  const parsed = parseMocha(r.stdout);
  if (parsed === undefined) {
    const log = await offline("tail -20 /work/.lore-test.log");
    return didNotRun("evm-test", "hardhat test", { ...r, stdout: log.stdout });
  }
  const net = parsed.failures.filter((f) => f.needsNetwork);
  return {
    engine: "evm-test",
    findings: mochaFindings(parsed.failures),
    ...(net.length === 0 ? {} : { unavailable: `hardhat test: ${String(net.length)} test(s) need a network the sandbox does not have (fork/RPC) and did NOT run: ${net.map((f) => f.title).join(", ")}` }),
  };
}

/** Read inside the sandbox: every build-info's compiler and settings, plus the baked bug list. */
const SOLC_BUGS_SCRIPT = `
const fs = require("fs"), path = require("path");
const dirs = ["artifacts/build-info", "out/build-info"].filter((d) => fs.existsSync(d));
const builds = [];
for (const d of dirs) for (const f of fs.readdirSync(d)) {
  if (!f.endsWith(".json") || f.endsWith(".output.json")) continue;
  const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
  const v = j.solcVersion ?? (j.solcLongVersion ?? "").split("+")[0];
  const s = (j.input ?? {}).settings ?? {};
  if (v) builds.push({ version: v, optimizer: !!(s.optimizer ?? {}).enabled, viaIR: !!s.viaIR });
}
process.stdout.write(JSON.stringify({ builds,
  bugs: JSON.parse(fs.readFileSync("/opt/solc-bugs/bugs.json", "utf8")),
  byVersion: JSON.parse(fs.readFileSync("/opt/solc-bugs/bugs_by_version.json", "utf8")) }));
`;

async function solcBugs(fw: EvmFramework, offline: (s: string) => Promise<ToolResult>): Promise<EngineOutcome> {
  const r = await offline(`node -e ${q(SOLC_BUGS_SCRIPT)}`);
  let parsed: { builds?: SolcBuild[]; bugs?: unknown[]; byVersion?: Record<string, { bugs?: string[] }> } | undefined;
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (parsed?.builds === undefined || parsed.bugs === undefined || parsed.byVersion === undefined) return didNotRun("solc-bugs", "the compiler-bug check", r);
  if (parsed.builds.length === 0) return { engine: "solc-bugs", findings: [], unavailable: "solc-bugs: the build left no build-info, so which compiler ran is unknown and nothing was checked" };
  const distinct = [...new Map(parsed.builds.map((b) => [`${b.version}/${String(b.optimizer)}/${String(b.viaIR)}`, b])).values()];
  return { engine: "solc-bugs", findings: matchSolcBugs(distinct, parsed.bugs as Parameters<typeof matchSolcBugs>[1], parsed.byVersion, fw.config) };
}

/**
 * An Ethereum project made runnable (phase 1), then `offline` for phase 2. Shared by the t0
 * engines and the PoC runner, so a round pays for one install however many proofs it checks.
 * `forgePrefetch`: a hardhat project about to run a FORGE PoC needs forge's own solc too.
 */
export async function withWorkspace<T>(
  worktree: string,
  base: SandboxConfig,
  fw: EvmFramework,
  opts: { readonly forgePrefetch?: boolean },
  fn: (ws: Workspace) => Promise<T>,
): Promise<T> {
  const cfg: SandboxConfig = { ...base, image: EVM_IMAGE };
  const scratch = join(cfg.scratchRoot, `${basename(worktree)}-evm`);
  await mkdir(scratch, { recursive: true });
  // No shared cache: dependencies are per tree. The mount is still required by the
  // sandbox's shape, so it gets a throwaway directory beside the scratch copy.
  const cacheDir = join(cfg.scratchRoot, `${basename(worktree)}-evm-cache`);
  await mkdir(cacheDir, { recursive: true });
  const phase2 = (script: string) => runInSandbox(cfg, worktree, cacheDir, scratch, `${ENV} export FOUNDRY_OFFLINE=true; ${script}`, false, "/lore-unused-cache");
  try {
    let script: string;
    if (fw.kind === "foundry") {
      const clone = (await pinnedDeps(worktree))
        .map(
          (d) =>
            `if [ -z "$(ls -A ${q(d.path)} 2>/dev/null)" ]; then git clone --quiet ${q(d.url)} ${q(d.path)} && ` +
            `git -C ${q(d.path)} checkout --quiet ${d.sha} && git -C ${q(d.path)} submodule update --init --recursive --quiet || exit 3; fi`,
        )
        .join("; ");
      // `--build-info`: foundry does not write it by default, and `solc-bugs` reads which
      // compilers ran from it. Without the flag it existed only as a side effect of slither's
      // own compile — so solc-bugs worked only while slither ran first.
      script = `${clone === "" ? "true" : clone}; forge build --build-info >/dev/null 2>&1; aderyn . -o /work/.lore-aderyn.json >/dev/null 2>&1; exit 0`;
    } else {
      const install = await installFor(worktree, fw);
      if (install === undefined) {
        const why = "this hardhat project has no lockfile, and lore installs only what a lockfile pins";
        return await fn({ framework: fw, failed: { ok: false, code: 2, stdout: "", stderr: why, timedOut: false }, why });
      }
      script =
        `${install} > /work/.lore-install.log 2>&1 || { tail -40 /work/.lore-install.log; exit 4; }; ` +
        `npx --no-install hardhat compile > /work/.lore-compile.log 2>&1; echo $? > /work/.lore-compile.rc; ` +
        `aderyn . -o /work/.lore-aderyn.json >/dev/null 2>&1; ` +
        (opts.forgePrefetch === true ? `${HARDHAT_FORGE_ENV} forge build ${HARDHAT_FORGE_FLAGS} >/dev/null 2>&1; ` : "") +
        "exit 0";
    }
    const fetched = await runInSandbox(cfg, worktree, cacheDir, scratch, `${ENV} ${script}`, true, "/lore-unused-cache");
    if (!fetched.ok) {
      if (fetched.code === 3) return await fn({ framework: fw, failed: fetched, why: "a git dependency in lib/ could not be cloned at its pinned commit" });
      if (fetched.code === 4 && fetched.unavailable === undefined) {
        const out = `${fetched.stdout}\n${fetched.stderr}`;
        const cause = installFailure(out);
        if (cause === "network") return await fn({ framework: fw, failed: fetched, why: "the dependency install could not reach its registry (a network failure, not the branch)" });
        if (cause === "credentials") {
          return await fn({ framework: fw, failed: fetched, why: "a dependency needs a credential the sandbox does not hold (a private registry or git dependency — lore's environment, not the branch)" });
        }
        const lockfile = fw.kind === "hardhat" ? (fw.lockfile ?? "package.json") : "package.json";
        return await fn({
          framework: fw,
          failed: fetched,
          why: `dependencies did not install from ${lockfile}`,
          finding: finding({
            file: lockfile,
            severity: "high",
            claim: `dependencies do not install from ${lockfile}, so nothing that needs them could run`,
            evidence: out.trim().split("\n").slice(-30).join("\n").slice(0, 2000),
            failureScenario: "the contracts, their tests and every analysis resolve through the installed dependencies — none of them ran, so none of their claims exist",
          }),
        });
      }
      return await fn({ framework: fw, failed: fetched, why: "the install phase did not complete" });
    }
    return await fn({ framework: fw, offline: phase2 });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * forge, pointed at a HARDHAT layout: sources in contracts/, dependencies in node_modules
 * (forge remaps them by itself), forge-std from the image, and its own out/cache so nothing
 * it writes can be mistaken for hardhat's artifacts.
 */
const HARDHAT_FORGE_ENV = "FOUNDRY_SRC=contracts FOUNDRY_TEST=.lore-poc FOUNDRY_OUT=.lore-forge-out FOUNDRY_CACHE_PATH=.lore-forge-cache";
/** The list-valued settings, as flags: forge refuses `FOUNDRY_LIBS=node_modules` ("expected a sequence"). */
const HARDHAT_FORGE_FLAGS = "--lib-paths node_modules --remappings forge-std/=/opt/forge-std/src/";

/** Above this a PoC is not run: the finding stands on its words. Proofs are tests, not suites. */
const POC_MAX = 20_000;

/** A Solidity PoC is a forge test; anything else is a hardhat (mocha) test in TS or JS. */
const isForgePoc = (source: string) => /^\s*pragma\s+solidity\b/m.test(source);

/**
 * Run each reviewer-supplied PoC once, in one shared workspace. Each is written into the
 * SCRATCH copy — never the worktree under review — run alone, and deleted, so one that does
 * not compile cannot break the next. A foundry project runs forge PoCs; a hardhat project
 * runs hardhat PoCs, and forge PoCs too, with forge pointed at its layout.
 */
export async function checkPocs(
  worktree: string,
  base: SandboxConfig,
  pocs: readonly { readonly fingerprint: string; readonly source: string }[],
): Promise<ReadonlyMap<string, PocOutcome>> {
  const out = new Map<string, PocOutcome>();
  const runnable = pocs.filter((p) => p.source.length <= POC_MAX);
  for (const p of pocs) if (p.source.length > POC_MAX) out.set(p.fingerprint, { kind: "inconclusive", detail: `the PoC is over ${String(POC_MAX)} characters and was not run` });
  const fw = await detectEvm(worktree);
  if (runnable.length === 0 || fw === undefined) {
    for (const p of runnable) out.set(p.fingerprint, { kind: "inconclusive", detail: "no foundry.toml or hardhat.config.* at the worktree root, so there is nothing to run a PoC in" });
    return out;
  }
  const forgePrefetch = fw.kind === "hardhat" && runnable.some((p) => isForgePoc(p.source));
  return withWorkspace(worktree, base, fw, { forgePrefetch }, async (ws) => {
    for (const p of runnable) {
      if ("failed" in ws) {
        out.set(p.fingerprint, { kind: "inconclusive", detail: `the sandbox could not be prepared: ${ws.why}` });
        continue;
      }
      const id = p.fingerprint.slice(0, 12);
      const forge = isForgePoc(p.source);
      let r: ToolResult;
      if (fw.kind === "foundry") {
        if (!forge) {
          out.set(p.fingerprint, { kind: "inconclusive", detail: "a foundry project runs forge PoCs; this one is not Solidity" });
          continue;
        }
        const name = `test/LorePoc_${id}.t.sol`;
        r = await ws.offline(`mkdir -p test && ${writeFile(name, p.source)} && forge test --match-path ${name} --json; rc=$?; rm -f ${name}; exit $rc`);
        out.set(p.fingerprint, r.unavailable !== undefined ? { kind: "inconclusive", detail: `the PoC could not run: ${r.unavailable}` } : classifyPoc(r.stdout));
      } else if (forge) {
        const name = `.lore-poc/LorePoc_${id}.t.sol`;
        r = await ws.offline(`mkdir -p .lore-poc && ${writeFile(name, p.source)} && ${HARDHAT_FORGE_ENV} forge test ${HARDHAT_FORGE_FLAGS} --match-path ${name} --json; rc=$?; rm -f ${name}; exit $rc`);
        out.set(p.fingerprint, r.unavailable !== undefined ? { kind: "inconclusive", detail: `the PoC could not run: ${r.unavailable}` } : classifyPoc(r.stdout));
      } else {
        const wrap = mochaWrapper(fw);
        if (wrap === undefined) {
          out.set(p.fingerprint, { kind: "inconclusive", detail: `lore cannot wrap a ${fw.config} config to run a PoC` });
          continue;
        }
        const name = `test/LorePoc_${id}.${fw.config.endsWith(".ts") ? "ts" : "js"}`;
        r = await ws.offline(
          `${writeFile(wrap.file, wrap.text)}; mkdir -p test && ${writeFile(name, p.source)} && rm -f /work/.lore-mocha.json; ` +
            `npx --no-install hardhat --config ${wrap.file} test ${name} >/dev/null 2>&1; rm -f ${name}; cat /work/.lore-mocha.json`,
        );
        out.set(p.fingerprint, r.unavailable !== undefined ? { kind: "inconclusive", detail: `the PoC could not run: ${r.unavailable}` } : classifyMochaPoc(r.stdout));
      }
    }
    return out;
  });
}
