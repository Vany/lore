/**
 * Which Ethereum toolchain a tree uses — and which lockfile pins its npm dependencies, which
 * a FOUNDRY repo often has too (OpenZeppelin from npm, scripts in TypeScript).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectEvm } from "./evm-detect.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lore-evm-detect-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("detectEvm", () => {
  it("finds a foundry repo's npm lockfile, so advisories anchor on the file that exists", async () => {
    writeFileSync(join(dir, "foundry.toml"), "[profile.default]\n");
    writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");
    expect(await detectEvm(dir)).toStrictEqual({ kind: "foundry", config: "foundry.toml", lockfile: "yarn.lock" });
  });
  it("prefers foundry when both are present, and reads hardhat's lockfile when only hardhat is", async () => {
    writeFileSync(join(dir, "hardhat.config.ts"), "export default {};\n");
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(await detectEvm(dir)).toStrictEqual({ kind: "hardhat", config: "hardhat.config.ts", lockfile: "package-lock.json" });
    writeFileSync(join(dir, "foundry.toml"), "[profile.default]\n");
    expect((await detectEvm(dir))?.kind).toBe("foundry");
  });
  it("is nothing for a tree with neither", async () => {
    expect(await detectEvm(dir)).toBeUndefined();
  });
});
