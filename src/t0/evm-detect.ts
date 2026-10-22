/**
 * Which Ethereum toolchain a tree uses, if any — read by the EVM sandbox runner (`evm.ts`)
 * and by the host-side advisories engine (`engines.ts`), which must agree on what counts.
 *
 * foundry.toml wins when both are present: a repository carrying both usually builds and
 * tests with forge and keeps hardhat for deployment scripts, and running both would pay for
 * every check twice.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `lockfile` for BOTH: a foundry repo often pins npm dependencies too (OpenZeppelin from npm,
 * TypeScript scripts), and an advisory has to be anchored on the lockfile that exists, or a
 * branch that bumps a vulnerable dependency is read as inheriting it (D-68).
 */
export type EvmFramework =
  | { readonly kind: "foundry"; readonly config: "foundry.toml"; readonly lockfile: string | undefined }
  | { readonly kind: "hardhat"; readonly config: string; readonly lockfile: string | undefined };

const exists = async (worktree: string, f: string) => (await readFile(join(worktree, f)).catch(() => undefined)) !== undefined;

export const HARDHAT_CONFIGS = ["hardhat.config.ts", "hardhat.config.js", "hardhat.config.cjs", "hardhat.config.mjs"] as const;

async function lockfileOf(worktree: string): Promise<string | undefined> {
  for (const l of ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"]) if (await exists(worktree, l)) return l;
  return undefined;
}

export async function detectEvm(worktree: string): Promise<EvmFramework | undefined> {
  if (await exists(worktree, "foundry.toml")) return { kind: "foundry", config: "foundry.toml", lockfile: await lockfileOf(worktree) };
  for (const config of HARDHAT_CONFIGS) {
    if (await exists(worktree, config)) return { kind: "hardhat", config, lockfile: await lockfileOf(worktree) };
  }
  return undefined;
}

/** The same question, synchronously, for callers that only need yes or no (semgrep's pack gate). */
export function isEvmProject(worktree: string): boolean {
  return existsSync(join(worktree, "foundry.toml")) || HARDHAT_CONFIGS.some((c) => existsSync(join(worktree, c)));
}
