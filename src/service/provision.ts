/**
 * Provisioning: `make new NAME=vany GIT=git@github.com:org/repo.git`
 *
 * One thing happens now, where three used to. An opaque bearer token is minted,
 * shown **once**, and stored only as a hash — a database backup should not be a set
 * of live credentials.
 *
 * **No key is generated any more (D-63 supersedes D-62).** lore does not clone and
 * does not fetch; `make mirror` does, on the host, as the operator. A deploy key
 * would be a live credential written to disk that nothing ever reads, handed out
 * with an instruction to grant a repository read access to a keypair with no user —
 * strictly worse than none. That is the argument the local-path branch already made
 * ("a secret created for no reason"); D-63 extends it to every url, because now no
 * url is fetched from here.
 *
 * Bootstrapping the knowledge base (D-35) deliberately does **not** happen here.
 * There is nothing to read until the mirror exists, so it runs on the first review.
 *
 * SPEC: spec/mcp-api.md §1, SPEC.md D-63
 */

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
}

export async function provision(opts: {
  store: Store;
  name: string;
  gitUrl: string;
  publicUrl: string;
}): Promise<Provisioned> {
  const repo = opts.store.upsertRepo(repoName(opts.gitUrl), opts.gitUrl);
  const token = grantToken(opts.store, repo.id, opts.name, `provisioned for ${opts.name}`);

  return {
    repoId: repo.id,
    repoName: repo.name,
    principal: opts.name,
    token,
    clientConfig: clientConfig(opts.publicUrl),
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

  return [
    "",
    "Provisioned.",
    "",
    "1. Populate the mirror, out here, as you. lore holds no credentials for your",
    "   remotes by design, so this is the only step that talks to one:",
    "",
    `      make mirror REPO=${p.repoName}`,
    "",
    "   Run it again before each review. A review whose mirror has gone stale is",
    "   refused rather than run against a tree that is not what you are merging.",
    "",
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
