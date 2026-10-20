/**
 * T0 for Ethereum projects: forge build, forge test, slither, aderyn, solhint — every one in
 * the EVM sandbox image (`deploy/sandbox-evm.Dockerfile`), never in the service (D-24: a
 * build compiles and a test RUNS the target's code).
 *
 * THE PHASES, and why only the first has network:
 *   1. install — clone `lib/` git dependencies at the commits the tree pins, and run one
 *      `forge build` so forge fetches the solc its pragmas name. Needs the network.
 *   2. build, test, analysis — `--network none`. A test that forks mainnet fails here, and is
 *      reported as a test that did not run, never as a defect: there is no RPC and no key in
 *      the sandbox, by design (brief, 2026-10-20).
 * `/work` is one scratch copy for the whole run (`cp -a`, never deleted mid-run), so what
 * phase 1 fetched — dependencies, solc under `$HOME/.svm`, forge's cache — is there for the
 * rest. HOME points into it because the sandbox runs as the service's uid, which has no home.
 *
 * A TOOL THAT CANNOT START IS UNAVAILABLE, NEVER A FINDING (#0050, D-158): docker's own
 * failures are already `unavailable` from `runInSandbox`; a missing binary (exit 127) and
 * output no parser recognises are said the same way here.
 *
 * Foundry only. A hardhat project is reported unavailable, loudly, until it is built.
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { T0Engine } from "../core/review-type.ts";
import { gitMaybe } from "../git/exec.ts";
import type { EngineOutcome } from "./engines.ts";
import { classifyPoc, forgeTestFindings, parseAderyn, parseForgeBuild, parseForgeTest, parseSlither, parseSolhint, type PocOutcome } from "./evm-parse.ts";
import { runInSandbox, type SandboxConfig } from "./sandbox.ts";
import type { ToolResult } from "./exec.ts";

export const EVM_ENGINES: readonly T0Engine[] = ["forge-build", "forge-test", "slither", "aderyn", "solhint"];

/** The EVM image, beside the JS one. Built by `make up` like it (the `sandbox-evm` service). */
export const EVM_IMAGE = process.env["LORE_SANDBOX_EVM_IMAGE"] ?? "lore-sandbox:evm";

const ENV = "export HOME=/work/.lore-home FOUNDRY_DISABLE_NIGHTLY_WARNING=1; mkdir -p \"$HOME\";";

const exists = async (worktree: string, f: string) => (await readFile(join(worktree, f)).catch(() => undefined)) !== undefined;

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

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** What became of a sandbox call that did not produce parseable output. */
function didNotRun(engine: T0Engine, what: string, r: ToolResult): EngineOutcome {
  if (r.unavailable !== undefined) return { engine, findings: [], unavailable: `${what} could not run: ${r.unavailable}`, interrupted: r.timedOut };
  if (r.code === 137) return { engine, findings: [], unavailable: `${what} was killed (exit 137) — a memory limit, not the branch`, interrupted: true };
  if (r.code === 127) return { engine, findings: [], unavailable: `${what}: the tool is not in the sandbox image (${EVM_IMAGE})` };
  const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-8).join("\n").slice(0, 800);
  return { engine, findings: [], unavailable: `${what} produced no output lore can read (exit ${String(r.code)}): ${tail}`, interrupted: true };
}

export async function sandboxedEvm(worktree: string, base: SandboxConfig, engines: readonly T0Engine[]): Promise<EngineOutcome[]> {
  const wanted = engines.filter((e) => EVM_ENGINES.includes(e));
  if (wanted.length === 0) return [];
  const foundry = await exists(worktree, "foundry.toml");
  if (!foundry) {
    const hardhat = (await Promise.all(["hardhat.config.ts", "hardhat.config.js", "hardhat.config.cjs", "hardhat.config.mjs"].map((f) => exists(worktree, f)))).some(Boolean);
    if (hardhat) {
      return wanted.map((engine) => ({
        engine,
        findings: [],
        unavailable: `${engine}: this is a hardhat project, and lore runs foundry only — nothing compiled, tested or analysed these contracts`,
      }));
    }
    return wanted.map((engine) => ({ engine, findings: [], skipped: `${engine}: no foundry.toml at the worktree root (not a foundry project, optional)` }));
  }

  return withWorkspace(worktree, base, async (ws) => {
    if ("failed" in ws) return wanted.map((engine) => ({ ...didNotRun(engine, ws.why, ws.failed), interrupted: true }));
    const { offline } = ws;
    const out: EngineOutcome[] = [];

    // Built once, read by everything after it: a branch that does not compile has no tests
    // and nothing to analyse, and saying "slither found nothing" about it would be INV-1.
    const built = await offline("forge build --json");
    const buildFindings = parseForgeBuild(built.stdout);
    const compiles = buildFindings !== undefined && buildFindings.length === 0;
    if (wanted.includes("forge-build")) {
      out.push(buildFindings === undefined ? didNotRun("forge-build", "forge build", built) : { engine: "forge-build", findings: buildFindings });
    }
    const rest = wanted.filter((e) => e !== "forge-build");
    if (!compiles) {
      // Said as what is KNOWN: a build that did not run is not a build that failed, and
      // "the contracts do not compile" about a sandbox that never started would be a false
      // claim about the branch.
      const why = buildFindings === undefined ? "forge build did not run, so nothing after it could" : "the contracts do not compile, so it could not run";
      for (const engine of rest) out.push({ engine, findings: [], unavailable: `${engine}: ${why}`, ...(buildFindings === undefined ? { interrupted: true } : {}) });
      return out;
    }

    if (rest.includes("forge-test")) {
      const r = await offline("forge test --json");
      const parsed = parseForgeTest(r.stdout);
      if (parsed === undefined) out.push(didNotRun("forge-test", "forge test", r));
      else {
        const offlineOnly = parsed.failures.filter((f) => f.needsNetwork);
        out.push({
          engine: "forge-test",
          findings: forgeTestFindings(parsed.failures),
          ...(offlineOnly.length === 0
            ? {}
            : { unavailable: `forge test: ${String(offlineOnly.length)} test(s) need a network the sandbox does not have (fork/RPC) and did NOT run: ${offlineOnly.map((f) => `${f.contract}.${f.test}`).join(", ")}` }),
        });
      }
    }
    if (rest.includes("slither")) {
      // Slither compiles through forge itself (offline: solc is cached). Not `--foundry-ignore-
      // compile`: crytic-compile 0.4.2 cannot read forge 1.8's build-info layout and dies on a
      // missing `.output.json` — found by the first sandbox run.
      const r = await offline("slither . --json - --filter-paths 'lib/|node_modules/' --exclude-dependencies 2>/dev/null");
      const parsed = parseSlither(r.stdout);
      if (parsed === undefined) out.push(didNotRun("slither", "slither", r));
      else {
        if (parsed.notes > 0) console.error(`[lore:log] slither: ${String(parsed.notes)} low/informational note(s), not raised`);
        out.push({ engine: "slither", findings: parsed.findings });
      }
    }
    if (rest.includes("aderyn")) {
      const r = await offline("aderyn . -o /work/.lore-aderyn.json >/dev/null 2>&1; cat /work/.lore-aderyn.json");
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
      // The PROJECT's lint: without a config of its own there is no rule set it chose, and
      // solhint's defaults are style opinions this review was not asked to enforce.
      const configured = (await Promise.all([".solhint.json", ".solhintrc", ".solhintrc.json"].map((f) => exists(worktree, f)))).some(Boolean);
      if (!configured) out.push({ engine: "solhint", findings: [], skipped: "solhint: no .solhint.json in this project (optional)" });
      else {
        const r = await offline("solhint -f json 'src/**/*.sol'");
        const parsed = parseSolhint(r.stdout);
        out.push(parsed === undefined ? didNotRun("solhint", "solhint", r) : { engine: "solhint", findings: parsed });
      }
    }
    return out;
  });
}

/**
 * A foundry project made runnable: the scratch copy, its pinned `lib/` dependencies and the
 * solc its pragmas name, fetched once with network (phase 1). `offline` runs a phase-2
 * script in it with `--network none`. Shared by the t0 engines and the PoC runner, so a
 * round pays for one install however many proofs it checks.
 */
export async function withWorkspace<T>(
  worktree: string,
  base: SandboxConfig,
  fn: (ws: { readonly offline: (script: string) => Promise<ToolResult> } | { readonly failed: ToolResult; readonly why: string }) => Promise<T>,
): Promise<T> {
  const cfg: SandboxConfig = { ...base, image: EVM_IMAGE };
  const scratch = join(cfg.scratchRoot, `${basename(worktree)}-evm`);
  await mkdir(scratch, { recursive: true });
  // No shared cache: `lib/` is per tree. The mount is still required by the sandbox's
  // shape, so it gets a throwaway directory beside the scratch copy.
  const cacheDir = join(cfg.scratchRoot, `${basename(worktree)}-evm-cache`);
  await mkdir(cacheDir, { recursive: true });
  try {
    const deps = await pinnedDeps(worktree);
    const clone = deps
      .map(
        (d) =>
          `if [ -z "$(ls -A ${q(d.path)} 2>/dev/null)" ]; then git clone --quiet ${q(d.url)} ${q(d.path)} && ` +
          `git -C ${q(d.path)} checkout --quiet ${d.sha} && git -C ${q(d.path)} submodule update --init --recursive --quiet || exit 3; fi`,
      )
      .join("; ");
    const fetched = await runInSandbox(cfg, worktree, cacheDir, scratch, `${ENV} ${clone === "" ? "true" : clone}; forge build >/dev/null 2>&1; exit 0`, true, "/lore-unused-cache");
    if (!fetched.ok) {
      const why = fetched.code === 3 ? "a git dependency in lib/ could not be cloned at its pinned commit" : "the install phase did not complete";
      return await fn({ failed: fetched, why });
    }
    return await fn({
      offline: (script) => runInSandbox(cfg, worktree, cacheDir, scratch, `${ENV} export FOUNDRY_OFFLINE=true; ${script}`, false, "/lore-unused-cache"),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Above this a PoC is not run: the finding stands on its words. Proofs are tests, not suites. */
const POC_MAX = 20_000;

/**
 * Run each reviewer-supplied PoC once, in one shared workspace. Each is written into the
 * SCRATCH copy's test directory — never the worktree under review — run alone, and deleted,
 * so one PoC that does not compile cannot break the next (forge compiles every test file).
 * Base64 through the shell, because a PoC is model-written text and must not be able to end
 * a heredoc or quote its way out of the command.
 */
export async function checkPocs(
  worktree: string,
  base: SandboxConfig,
  pocs: readonly { readonly fingerprint: string; readonly source: string }[],
): Promise<ReadonlyMap<string, PocOutcome>> {
  const out = new Map<string, PocOutcome>();
  const runnable = pocs.filter((p) => p.source.length <= POC_MAX);
  for (const p of pocs) if (p.source.length > POC_MAX) out.set(p.fingerprint, { kind: "inconclusive", detail: `the PoC is over ${String(POC_MAX)} characters and was not run` });
  if (runnable.length === 0 || !(await exists(worktree, "foundry.toml"))) {
    for (const p of runnable) out.set(p.fingerprint, { kind: "inconclusive", detail: "no foundry.toml at the worktree root, so there is nothing to run a PoC in" });
    return out;
  }
  return withWorkspace(worktree, base, async (ws) => {
    for (const p of runnable) {
      if ("failed" in ws) {
        out.set(p.fingerprint, { kind: "inconclusive", detail: `the sandbox could not be prepared: ${ws.why}` });
        continue;
      }
      const name = `test/LorePoc_${p.fingerprint.slice(0, 12)}.t.sol`;
      const b64 = Buffer.from(p.source, "utf8").toString("base64");
      const r = await ws.offline(`mkdir -p test && echo ${b64} | base64 -d > ${name} && forge test --match-path ${name} --json; rc=$?; rm -f ${name}; exit $rc`);
      out.set(p.fingerprint, r.unavailable !== undefined ? { kind: "inconclusive", detail: `the PoC could not run: ${r.unavailable}` } : classifyPoc(r.stdout));
    }
    return out;
  });
}
