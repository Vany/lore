/**
 * The EVM tools' output as findings. The forge fixtures are real forge 1.7.1 output (the
 * host's); the pinned 1.8.5 produced the same shapes in the sandbox demo, as did the other
 * tools — see the header of evm-parse.ts.
 */

import { describe, expect, it } from "vitest";
import { classifyMochaPoc, classifyPoc, installFailure, forgeTestFindings, matchSolcBugs, mochaFindings, parseAderyn, parseForgeBuild, parseForgeTest, parseHardhatCompile, parseMocha, parseSlither, parseSolhint, vendored } from "./evm-parse.ts";

describe("forge build", () => {
  const out = JSON.stringify({
    errors: [
      { sourceLocation: { file: "lib/forge-std/src/StdStorage.sol", start: 1, end: 2 }, type: "Warning", severity: "warning", message: "deprecated", formattedMessage: "Warning: deprecated" },
      { sourceLocation: { file: "src/Bad.sol", start: 25, end: 26 }, type: "ParserError", severity: "error", message: "Expected type name", formattedMessage: "ParserError: Expected type name\n --> src/Bad.sol:1:26:\n  |\n1 | contract X { function f( }" },
    ],
  });
  it("raises compile errors, at their line, and ignores warnings", () => {
    const f = parseForgeBuild(out) ?? [];
    expect(f.map((x) => [x.file, x.line, x.severity])).toStrictEqual([["src/Bad.sol", 1, "high"]]);
    expect(f[0]?.claim).toBe("solc: Expected type name");
  });
  it("refuses output that is not forge's", () => {
    expect(parseForgeBuild("Error: something went wrong")).toBeUndefined();
  });
});

describe("forge test", () => {
  const out = JSON.stringify({
    "test/EtherStore.t.sol:EtherStoreTest": {
      test_results: {
        "test_depositThenWithdraw()": { status: "Failure", reason: "balance kept: 0 != 1" },
        "test_ok()": { status: "Success", reason: null },
        "testFork_mainnet()": { status: "Failure", reason: "could not instantiate forked environment with provider" },
      },
    },
  });
  it("raises a failing test, and does not blame the branch for a test that needed the network", () => {
    const r = parseForgeTest(out);
    expect(r?.ran).toBe(3);
    const f = forgeTestFindings(r?.failures ?? []);
    expect(f.map((x) => [x.file, x.claim])).toStrictEqual([["test/EtherStore.t.sol", "forge-test: EtherStoreTest.test_depositThenWithdraw() fails"]]);
    expect(r?.failures.filter((x) => x.needsNetwork).map((x) => x.test)).toStrictEqual(["testFork_mainnet()"]);
  });
  it("refuses a status it does not know, rather than calling every test failed", () => {
    const odd = JSON.stringify({ "test/A.t.sol:A": { test_results: { "test_x()": { status: "Passed", reason: null } } } });
    expect(parseForgeTest(odd)).toBeUndefined();
  });
});

describe("slither", () => {
  const out = JSON.stringify({
    success: true,
    results: {
      detectors: [
        { check: "reentrancy-eth", impact: "High", confidence: "Medium", description: "Reentrancy in EtherStore.withdraw() (src/EtherStore.sol#12-18):\n\tExternal calls...", elements: [{ source_mapping: { filename_relative: "src/EtherStore.sol", lines: [12, 13, 14] } }] },
        { check: "low-level-calls", impact: "Informational", description: "Low level call", elements: [{ source_mapping: { filename_relative: "src/EtherStore.sol", lines: [15] } }] },
        { check: "reentrancy-eth", impact: "High", description: "in a dependency", elements: [{ source_mapping: { filename_relative: "lib/openzeppelin/X.sol", lines: [1] } }] },
      ],
    },
  });
  it("raises High and Medium, counts the rest as notes, and never reports a dependency", () => {
    const r = parseSlither(out);
    expect(r?.findings.map((f) => [f.file, f.line, f.severity])).toStrictEqual([["src/EtherStore.sol", 12, "high"]]);
    expect(r?.findings[0]?.claim).toMatch(/^reentrancy-eth: Reentrancy in EtherStore\.withdraw\(\)/);
    expect(r?.notes).toBe(1);
  });
  it("reads a clean run as clean, and garbage as unknown", () => {
    expect(parseSlither(JSON.stringify({ success: true, results: {} }))).toStrictEqual({ findings: [], notes: 0 });
    expect(parseSlither("Traceback (most recent call last)")).toBeUndefined();
  });
});

describe("aderyn and solhint", () => {
  it("raises aderyn's high issues at medium, outside dependencies", () => {
    const r = parseAderyn(JSON.stringify({
      high_issues: { issues: [{ title: "Reentrancy", detector_name: "reentrancy-state-change", instances: [{ contract_path: "src/A.sol", line_no: 9 }, { contract_path: "lib/x/B.sol", line_no: 1 }] }] },
      low_issues: { issues: [{ title: "x", instances: [{}, {}] }] },
    }));
    expect(r?.findings.map((f) => [f.file, f.line, f.severity])).toStrictEqual([["src/A.sol", 9, "medium"]]);
    expect(r?.notes).toBe(2);
  });
  it("raises solhint errors only", () => {
    const f = parseSolhint(JSON.stringify([
      { filePath: "src/A.sol", line: 3, severity: "Error", message: "Avoid tx.origin", ruleId: "avoid-tx-origin" },
      { filePath: "src/A.sol", line: 4, severity: "Warning", message: "style", ruleId: "quotes" },
      // solhint 6.2.5 ends its array with a summary object (seen in the sandbox).
      { conclusion: "2 problem/s (1 error/s, 1 warning/s)" },
    ]));
    expect(f?.map((x) => [x.claim, x.severity])).toStrictEqual([["avoid-tx-origin: Avoid tx.origin", "low"]]);
  });
  it("knows vendored paths", () => {
    expect([vendored("lib/forge-std/src/Test.sol"), vendored("node_modules/@oz/x.sol"), vendored("src/lib/Math.sol")]).toStrictEqual([true, true, false]);
  });
});

describe("a reviewer's PoC", () => {
  const run = (results: Record<string, { status: string; reason: string | null }>) =>
    JSON.stringify({ "test/LorePoc_ab.t.sol:Poc": { test_results: results } });
  it("confirms when it fails, refutes when it passes", () => {
    expect(classifyPoc(run({ "test_drain()": { status: "Failure", reason: "drained: 2 ether" } })).kind).toBe("confirmed");
    expect(classifyPoc(run({ "test_drain()": { status: "Success", reason: null } })).kind).toBe("refuted");
  });
  it("proves nothing when it could not run — never withdraws on that", () => {
    expect(classifyPoc("Error: Compiler run failed").kind).toBe("inconclusive");
    expect(classifyPoc(JSON.stringify({})).kind).toBe("inconclusive");
    expect(classifyPoc(run({ "testFork()": { status: "Failure", reason: "could not instantiate forked environment" } })).kind).toBe("inconclusive");
  });
});

// Real output: hardhat 2.22.19 in the EVM sandbox, 2026-10-21.
describe("hardhat compile", () => {
  const log = [
    "ParserError: Expected type name",
    " --> contracts/Broken.sol:1:31:",
    "  |",
    "1 | contract Broken { function f( }",
    "  |                               ^",
    "",
    "",
    "Error HH600: Compilation failed",
    "",
    "HardhatError: HH600: Compilation failed",
    "    at SimpleTaskDefinition.action (/work/node_modules/hardhat/src/builtin-tasks/compile.ts:499:15)",
  ].join("\n");
  it("raises solc's error at its line, never hardhat's own wrapper", () => {
    const f = parseHardhatCompile(log, 1) ?? [];
    expect(f.map((x) => [x.file, x.line, x.claim])).toStrictEqual([["contracts/Broken.sol", 1, "solc: ParserError: Expected type name"]]);
  });
  it("is clean on exit 0, and unknown when it failed with no compiler error in it", () => {
    expect(parseHardhatCompile("Compiled 3 Solidity files successfully", 0)).toStrictEqual([]);
    expect(parseHardhatCompile("Error HH8: There's one or more errors in your config file", 1)).toBeUndefined();
  });
});

describe("hardhat test (mocha JSON)", () => {
  const json = JSON.stringify({
    stats: { suites: 2, tests: 4, passes: 3, pending: 0, failures: 1 },
    failures: [{ title: "returns a deposit", fullTitle: "Vault returns a deposit", file: "/work/test/Vault.ts", err: { message: "expected 0 to equal 1." } }],
  });
  it("raises the failing test against its file, relative to the project", () => {
    const r = parseMocha(json);
    expect([r?.ran, r?.passed]).toStrictEqual([4, 3]);
    expect(mochaFindings(r?.failures ?? []).map((f) => [f.file, f.claim])).toStrictEqual([["test/Vault.ts", "hardhat-test: Vault returns a deposit fails"]]);
  });
  it("judges a hardhat PoC by the same rule as a forge one", () => {
    expect(classifyMochaPoc(json).kind).toBe("confirmed");
    expect(classifyMochaPoc(JSON.stringify({ stats: { tests: 1, passes: 1 }, failures: [] })).kind).toBe("refuted");
    expect(classifyMochaPoc("").kind).toBe("inconclusive");
    expect(classifyMochaPoc(JSON.stringify({ stats: { tests: 1 }, failures: [{ fullTitle: "x", err: { message: "getaddrinfo EAI_AGAIN mainnet.infura.io" } }] })).kind).toBe("inconclusive");
  });
});

describe("known compiler bugs", () => {
  const bugs = [
    { uid: "SOL-1", name: "HighWithOptimizer", summary: "a high one", severity: "high", conditions: { optimizer: true } },
    { uid: "SOL-2", name: "MediumAlways", summary: "a ``medium`` one", severity: "medium" },
    { uid: "SOL-3", name: "LowAlways", summary: "a low one", severity: "low" },
    { uid: "SOL-4", name: "ViaIROnly", summary: "via-IR", severity: "medium/high", conditions: { viaIR: true } },
  ];
  const byVersion = { "0.8.19": { bugs: ["HighWithOptimizer", "MediumAlways", "LowAlways", "ViaIROnly"] }, "0.8.28": { bugs: ["MediumAlways"] } };
  it("raises what the settings allow, one step below the bug's own severity, and never the low ones", () => {
    const f = matchSolcBugs([{ version: "0.8.19", optimizer: true, viaIR: false }, { version: "0.8.28", optimizer: false, viaIR: false }], bugs, byVersion, "hardhat.config.ts");
    expect(f.map((x) => [x.claim.split(":")[0], x.severity, x.file])).toStrictEqual([
      ["solc-bug-HighWithOptimizer", "medium", "hardhat.config.ts"],
      ["solc-bug-MediumAlways", "low", "hardhat.config.ts"],
      ["solc-bug-MediumAlways", "low", "hardhat.config.ts"],
    ]);
    expect(f[1]?.claim).toContain("a `medium` one");
  });
  it("rules out a bug whose condition the build does not meet", () => {
    const f = matchSolcBugs([{ version: "0.8.19", optimizer: false, viaIR: false }], bugs, byVersion, "foundry.toml");
    expect(f.map((x) => x.claim.split(":")[0])).toStrictEqual(["solc-bug-MediumAlways"]);
  });
});

// The sandbox holds no secrets by design (D-24), so an install that needed one did not fail
// because of the branch. Real error lines from yarn v1, npm and git.
describe("why an install failed", () => {
  it("names a missing credential as the environment, not the branch", () => {
    for (const line of [
      "error An unexpected error occurred: \"https://npm.pkg.github.com/@acme%2fvault: Request failed \\\"401 Unauthorized\\\"\".",
      "npm error code E401",
      "npm ERR! code E403",
      "npm error code ENEEDAUTH",
      "fatal: could not read Username for 'https://github.com': No such device or address",
      "git@github.com: Permission denied (publickey).",
    ]) expect(installFailure(line), line).toBe("credentials");
  });
  it("names an unreachable registry as the network", () => {
    expect(installFailure("error An unexpected error occurred: getaddrinfo EAI_AGAIN registry.yarnpkg.com")).toBe("network");
  });
  it("blames the branch for a lockfile that does not match", () => {
    expect(installFailure("error Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`.")).toBe("branch");
  });
});
