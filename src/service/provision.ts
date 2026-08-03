/**
 * Provisioning: `make new NAME=vany GIT=git@github.com:org/repo.git`
 *
 * Three things happen, and the order matters:
 *
 *  1. a **read-only deploy key is generated server-side**. The private half never
 *     leaves this machine, and we never ask anyone for a personal SSH key — a
 *     service holding a personal key holds everything that key opens.
 *  2. an opaque bearer token is minted, shown **once**, and stored only as a hash.
 *     A database backup should not be a set of live credentials.
 * Bootstrapping the knowledge base (D-35) deliberately does **not** happen here.
 * The deploy key exists but a human has not yet added it to the repository, so
 * there is nothing to clone. It runs on the first review instead, which is the
 * first moment the code is actually readable.
 *
 * SPEC: spec/mcp-api.md §1
 */

import { execFile } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { grantToken } from "../mcp/auth.ts";
import type { Store } from "../store/store.ts";

const run = promisify(execFile);

export interface Provisioned {
  readonly repoId: string;
  readonly principal: string;
  /** Shown once. Never recoverable from the database. */
  readonly token: string;
  /** Add this to the repo as a READ-ONLY deploy key. */
  readonly deployPublicKey: string;
  readonly clientConfig: string;
}

export async function provision(opts: {
  store: Store;
  name: string;
  gitUrl: string;
  keysDir: string;
  publicUrl: string;
}): Promise<Provisioned> {
  const repo = opts.store.upsertRepo(repoName(opts.gitUrl), opts.gitUrl);

  await mkdir(opts.keysDir, { recursive: true, mode: 0o700 });
  const keyPath = join(opts.keysDir, `${repo.id}_ed25519`);

  const pub = await readFile(`${keyPath}.pub`, "utf8").catch(async () => {
    await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `lore:${repo.name}`, "-f", keyPath]);
    return readFile(`${keyPath}.pub`, "utf8");
  });

  const token = grantToken(opts.store, repo.id, opts.name, `provisioned for ${opts.name}`);

  return {
    repoId: repo.id,
    principal: opts.name,
    token,
    deployPublicKey: pub.trim(),
    clientConfig: clientConfig(opts.publicUrl),
  };
}

/**
 * The paste-able client entry.
 *
 * The secret sits in a **header**, not the URL: the MCP spec forbids tokens in the
 * query string, and URLs end up in proxy logs and committed configs regardless
 * (D-21).
 */
function clientConfig(publicUrl: string): string {
  return JSON.stringify(
    {
      mcp: {
        lore: {
          type: "remote",
          url: publicUrl,
          headers: { Authorization: "Bearer {env:LORE_TOKEN}" },
        },
      },
    },
    null,
    2,
  );
}

export function renderProvisioned(p: Provisioned): string {
  return [
    "",
    "Provisioned.",
    "",
    "1. Add this as a READ-ONLY deploy key on the repository:",
    "",
    `   ${p.deployPublicKey}`,
    "",
    "2. Set LORE_TOKEN in the client environment. This is shown ONCE and is not",
    "   recoverable — only its hash is stored.",
    "",
    `   export LORE_TOKEN=${p.token}`,
    "",
    "3. Add to the MCP client config:",
    "",
    p.clientConfig
      .split("\n")
      .map((l) => `   ${l}`)
      .join("\n"),
    "",
  ].join("\n");
}

function repoName(gitUrl: string): string {
  const m = /([^/:]+?)(?:\.git)?$/.exec(gitUrl.trim());
  return m?.[1] ?? gitUrl;
}
