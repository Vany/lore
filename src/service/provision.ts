/**
 * Provisioning: `make new NAME=vany GIT=git@github.com:org/repo.git`
 *
 * One thing happens now, where three used to. An opaque bearer token is minted,
 * shown **once**, and stored only as a hash — a database backup should not be a set
 * of live credentials.
 *
 * **A read-only deploy key is generated again (D-65 supersedes D-63).** D-63 removed
 * it because nothing read it: lore did not fetch, so the key was "a secret created
 * for no reason". lore fetches now — a service cannot tell a client on another
 * machine to go run a Makefile here — so the key is read on every mirror refresh, and
 * the argument that removed it no longer applies.
 *
 * The public half is printed and the private half never leaves this host. Authorizing
 * it is one paste, and until it happens `make mirror` remains the fallback, so a
 * repository is never blocked on it.
 *
 * A **local path** still gets no key, which is the distinction D-62 drew and D-63
 * generalised too far: git reaches those through the filesystem, ssh never runs, and
 * a keypair for one would be exactly the secret-for-no-reason both objected to.
 *
 * Bootstrapping the knowledge base (D-35) deliberately does **not** happen here.
 * There is nothing to read until the mirror exists, so it runs on the first review.
 *
 * SPEC: spec/mcp-api.md §1, SPEC.md D-65
 */

import { ensureDeployKey, isLocalPath } from "../git/keys.ts";
import { grantToken } from "../mcp/auth.ts";
import type { Store } from "../store/store.ts";

export interface Provisioned {
  readonly repoId: string;
  /** What `make mirror REPO=` matches on. */
  readonly repoName: string;
  readonly principal: string;
  /** Shown once. Never recoverable from the database. */
  readonly token: string;
  /** The paste-able `.mcp.json` fragment. */
  readonly clientConfig: string;
  /**
   * The deploy key to authorize, or absent for a local path, which needs none.
   * Safe to print and safe to commit — it is the public half.
   */
  readonly deployKey?: string;
}

export async function provision(opts: {
  store: Store;
  name: string;
  gitUrl: string;
  publicUrl: string;
  keysDir: string;
}): Promise<Provisioned> {
  const repo = opts.store.upsertRepo(repoName(opts.gitUrl), opts.gitUrl);
  const token = grantToken(opts.store, repo.id, opts.name, `provisioned for ${opts.name}`);
  // Generated here rather than lazily on the first fetch so the operator is asked to
  // authorize it while they are still looking at the terminal. Discovering the need
  // later means discovering it as a failed review.
  const key = isLocalPath(opts.gitUrl) ? undefined : await ensureDeployKey(opts.keysDir, repo.id, repo.name);

  return {
    repoId: repo.id,
    repoName: repo.name,
    principal: opts.name,
    token,
    clientConfig: clientConfig(opts.publicUrl),
    ...(key !== undefined ? { deployKey: key.publicKey } : {}),
  };
}

/**
 * The paste-able client entry, in the shape a client actually reads.
 *
 * Every field here was wrong until 2026-08-04, and the output was confident about
 * all of it. It printed a top-level `mcp` key (the file wants `mcpServers`), a type
 * of `remote` (the client knows `stdio`, `sse`, `http`), and a placeholder spelled
 * `{env:LORE_TOKEN}` (the expansion is `${LORE_TOKEN}`). Three fatal errors in nine
 * lines whose entire purpose is to be pasted without thought — and nothing caught
 * it, because no test compared this against a config known to work. One did exist,
 * in this repository's own `.mcp.json`.
 *
 * The secret sits in a **header**, not the url: the MCP spec forbids tokens in the
 * query string, and urls reach proxy logs and committed configs regardless (D-21).
 * It is left as an expansion rather than inlined because `.mcp.json` is the
 * project-scoped file people commit — verified expanding at connect time by pointing
 * a client at a server that echoed the header it received.
 */
function clientConfig(publicUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        lore: {
          type: "http",
          url: publicUrl,
          headers: { Authorization: "Bearer ${LORE_TOKEN}" },
        },
      },
    },
    null,
    2,
  );
}

export function renderProvisioned(p: Provisioned): string {
  const indent = (s: string) => s.split("\n").map((l) => `   ${l}`).join("\n");

  const mirrorStep =
    p.deployKey === undefined
      ? [
          "1. Nothing to authorize — a local path needs no credential. lore clones and",
          "   refreshes it itself, on demand.",
          "",
        ]
      : [
          "1. Authorize this READ-ONLY deploy key on the repository. lore refreshes the",
          "   mirror itself before every review, and cannot without it:",
          "",
          `      ${p.deployKey}`,
          "",
          "   GitHub: Settings → Deploy keys → Add deploy key. Leave 'Allow write",
          "   access' UNTICKED — lore never pushes, and a write key would breach D-2.",
          "   The private half stays on the lore host and is readable by nothing else.",
          "",
          "   Until it is authorized, populate the mirror by hand instead:",
          `      make mirror REPO=${p.repoName}`,
          "",
        ];

  return [
    "",
    "Provisioned.",
    "",
    ...mirrorStep,
    "2. Set LORE_TOKEN in the client environment. This is shown ONCE and is not",
    "   recoverable — only its hash is stored.",
    "",
    `      export LORE_TOKEN=${p.token}`,
    "",
    "3. Add to .mcp.json in the repository being reviewed:",
    "",
    indent(p.clientConfig),
    "",
    "   The expansion is shown because .mcp.json is the file people commit. If",
    "   yours is gitignored, paste the token inline instead — an unset LORE_TOKEN",
    "   expands to nothing and the failure looks like a bad token, not a missing one.",
    "",
    "   A project-scoped server needs approval on first use: run `claude` in that",
    "   directory once and accept it, or `claude mcp list` will report it pending",
    "   and never connect.",
    "",
  ].join("\n");
}

function repoName(gitUrl: string): string {
  const m = /([^/:]+?)(?:\.git)?$/.exec(gitUrl.trim());
  return m?.[1] ?? gitUrl;
}
