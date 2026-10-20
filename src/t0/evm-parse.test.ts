/**
 * The EVM tools' output as findings. The forge fixtures are real output (forge 1.7.1, the
 * demo project in this change); the others follow each tool's documented JSON and are
 * re-checked against the real tools by the sandbox demo.
 */

import { describe, expect, it } from "vitest";
import { classifyPoc, forgeTestFindings, parseAderyn, parseForgeBuild, parseForgeTest, parseSlither, parseSolhint, vendored } from "./evm-parse.ts";

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
