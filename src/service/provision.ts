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
import { isLocalPath } from "../git/repo.ts";
import { grantToken } from "../mcp/auth.ts";
import type { Store } from "../store/store.ts";

const run = promisify(execFile);

/** Re-exported: url classification belongs to the git layer, callers here already used it. */
export { isLocalPath };

export interface Provisioned {
  readonly repoId: string;
  readonly principal: string;
  /** Shown once. Never recoverable from the database. */
  readonly token: string;
  /**
   * Add this to the repo as a READ-ONLY deploy key.
   *
   * ABSENT for a local path, because there is no remote to add it to. Generating one
   * anyway wrote a private key nobody would ever use and told the operator to perform
   * a step that cannot be performed — output asserting something untrue about what
   * the system had done.
   */
  readonly deployPublicKey: string | undefined;
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

  // No key for a local path. There is nothing to add it to, and a private key
  // written for a repository that will never be reached is a secret created for no
  // reason — the smallest version of the same fault as printing the step.
  const local = isLocalPath(opts.gitUrl);
  let pub: string | undefined;
  if (!local) {
    await mkdir(opts.keysDir, { recursive: true, mode: 0o700 });
    const keyPath = join(opts.keysDir, `${repo.id}_ed25519`);
    pub = await readFile(`${keyPath}.pub`, "utf8").catch(async () => {
      await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `lore:${repo.name}`, "-f", keyPath]);
      return readFile(`${keyPath}.pub`, "utf8");
    });
  }

  const token = grantToken(opts.store, repo.id, opts.name, `provisioned for ${opts.name}`);

  return {
    repoId: repo.id,
    principal: opts.name,
    token,
    deployPublicKey: pub?.trim(),
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
  // The key step is printed only when there IS a key. It used to be printed always,
  // so provisioning a local directory told the operator to install a deploy key on a
  // repository that has no remote — an instruction that cannot be followed, next to
  // two that must be.
  const keyStep =
    p.deployPublicKey === undefined
      ? ["No deploy key: this is a local path, so there is no remote to add one to.", ""]
      : ["1. Add this as a READ-ONLY deploy key on the repository:", "", `   ${p.deployPublicKey}`, ""];
  const n = p.deployPublicKey === undefined ? 0 : 1;

  return [
    "",
    "Provisioned.",
    "",
    ...keyStep,
    `${n + 1}. Set LORE_TOKEN in the client environment. This is shown ONCE and is not`,
    "   recoverable — only its hash is stored.",
    "",
    `   export LORE_TOKEN=${p.token}`,
    "",
    `${n + 2}. Add to the MCP client config:`,
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
