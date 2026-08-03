/**
 * Bearer tokens, scoped to one repo.
 *
 * Behind Tailscale the network already keeps strangers out (D-33), so these are
 * not a perimeter — they are **scoping**: two teammates on the same tailnet still
 * must not read each other's repos, and a `review_id` must be bound to whoever
 * created it.
 *
 * Credentials travel in the `Authorization` header, never the URL. The MCP spec is
 * explicit — *"Access tokens MUST NOT be included in the URI query string"* — and
 * beyond the letter of it, URLs end up in proxy logs and committed client configs
 * (D-21).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store.ts";

export interface Principal {
  readonly principal: string;
  readonly repoId: string;
}

const PREFIX = "lore_";

/** 32 bytes of CSPRNG. Shown once, never stored. */
export function mintToken(): string {
  return `${PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function grantToken(store: Store, repoId: string, principal: string, label?: string): string {
  const token = mintToken();
  store.db
    .prepare("INSERT INTO token(hash, principal, repo_id, label, created_at) VALUES(?, ?, ?, ?, ?)")
    .run(hashToken(token), principal, repoId, label ?? null, new Date().toISOString());
  return token;
}

/**
 * Resolve a bearer header to a principal, or `undefined`.
 *
 * Compared as a hash, in constant time. A token comparison that leaks timing is a
 * slow oracle for the token itself, and this one is only 32 bytes of entropy away
 * from every repo in the workgroup.
 */
export function authenticate(store: Store, header: string | undefined): Principal | undefined {
  const token = parseBearer(header);
  if (token === undefined) return undefined;

  const given = Buffer.from(hashToken(token), "hex");
  const rows = store.db
    .prepare("SELECT hash, principal, repo_id FROM token WHERE revoked_at IS NULL")
    .all() as Record<string, string>[];

  for (const row of rows) {
    const known = Buffer.from(row["hash"] ?? "", "hex");
    if (known.length === given.length && timingSafeEqual(known, given)) {
      return { principal: row["principal"] ?? "", repoId: row["repo_id"] ?? "" };
    }
  }
  return undefined;
}

export function revokeToken(store: Store, token: string): boolean {
  const res = store.db
    .prepare("UPDATE token SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), hashToken(token));
  return Number(res.changes) > 0;
}

function parseBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}
