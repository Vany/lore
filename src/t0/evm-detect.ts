/**
 * Which Ethereum toolchain a tree uses, if any — read by the EVM sandbox runner (`evm.ts`)
 * and by the host-side advisories engine (`engines.ts`), which must agree on what counts.
 *
 * foundry.toml wins when both are present: a repository carrying both usually builds and
 * tests with forge and keeps hardhat for deployment scripts, and running both would pay for
 * every check twice.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type EvmFramework =
  | { readonly kind: "foundry"; readonly config: "foundry.toml" }
  | { readonly kind: "hardhat"; readonly config: string; readonly lockfile: string | undefined };

const exists = async (worktree: string, f: string) => (await readFile(join(worktree, f)).catch(() => undefined)) !== undefined;

export const HARDHAT_CONFIGS = ["hardhat.config.ts", "hardhat.config.js", "hardhat.config.cjs", "hardhat.config.mjs"] as const;

export async function detectEvm(worktree: string): Promise<EvmFramework | undefined> {
  if (await exists(worktree, "foundry.toml")) return { kind: "foundry", config: "foundry.toml" };
  for (const config of HARDHAT_CONFIGS) {
    if (!(await exists(worktree, config))) continue;
    let lockfile: string | undefined;
    for (const l of ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"]) {
      if (await exists(worktree, l)) {
        lockfile = l;
        break;
      }
    }
    return { kind: "hardhat", config, lockfile };
  }
  return undefined;
}
