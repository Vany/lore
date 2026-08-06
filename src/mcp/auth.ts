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
function mintToken(): string {
  return `${PREFIX}${randomBytes(32).toString("base64url")}`;
}

function hashToken(token: string): string {
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

/** What a token looks like to an operator deciding whether to revoke it. */
export interface TokenRow {
  /** Leading 8 hex of the stored hash — the handle, since the secret is unrecoverable. */
  readonly short: string;
  readonly principal: string;
  readonly repo: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export function listTokens(store: Store): readonly TokenRow[] {
  const rows = store.db
    .prepare(
      "SELECT t.hash, t.principal, t.label, t.created_at, t.revoked_at, r.name AS repo" +
        " FROM token t LEFT JOIN repo r ON r.id = t.repo_id ORDER BY t.created_at",
    )
    .all() as Record<string, string | null>[];
  return rows.map((r) => ({
    short: (r["hash"] ?? "").slice(0, 8),
    principal: r["principal"] ?? "",
    repo: r["repo"] ?? "(unknown)",
    ...(r["label"] === null || r["label"] === undefined ? {} : { label: r["label"] }),
    createdAt: r["created_at"] ?? "",
    ...(r["revoked_at"] === null || r["revoked_at"] === undefined ? {} : { revokedAt: r["revoked_at"] }),
  }));
}

export type RevokeResult =
  | { readonly kind: "revoked"; readonly principal: string; readonly repo: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "already-revoked"; readonly at: string }
  | { readonly kind: "ambiguous"; readonly matches: readonly string[] };

/**
 * Revoke by the leading hex of the stored HASH, not by the token itself.
 *
 * The old signature took the secret — which is shown once at provisioning and stored
 * only as a hash, so an operator who wants to revoke one cannot supply it. That is
 * backwards: you revoke a credential precisely when you do NOT have it, because it
 * leaked, was lost, or belonged to someone who left. It had no caller and no route to
 * one, while `spec/mcp-api.md` §1 promised "an opaque, revocable bearer token" and
 * `make tokens` printed a `revoked_at` column nothing on earth could set.
 *
 * A prefix, with git's rule: **ambiguity is an error, never a winner**. It is the same
 * decision as short fingerprints (`spec/review-ladder.md` §3.1.2), and it matters more
 * here — silently revoking the wrong token locks out a teammate and leaves the leaked
 * one live.
 *
 * `already-revoked` is its own answer rather than a plain failure, so a second run of
 * the same command does not read as "that token was never here".
 */
export function revokeByPrefix(store: Store, prefix: string): RevokeResult {
  if (!/^[0-9a-f]{4,64}$/i.test(prefix)) return { kind: "not-found" };

  const rows = store.db
    .prepare(
      "SELECT t.hash, t.principal, t.revoked_at, r.name AS repo FROM token t" +
        " LEFT JOIN repo r ON r.id = t.repo_id WHERE t.hash LIKE ?",
    )
    .all(`${prefix.toLowerCase()}%`) as Record<string, string | null>[];

  if (rows.length === 0) return { kind: "not-found" };
  if (rows.length > 1) return { kind: "ambiguous", matches: rows.map((r) => (r["hash"] ?? "").slice(0, 12)) };

  const row = rows[0] as Record<string, string | null>;
  const already = row["revoked_at"];
  if (already !== null && already !== undefined) return { kind: "already-revoked", at: already };

  store.db
    .prepare("UPDATE token SET revoked_at = ? WHERE hash = ?")
    .run(new Date().toISOString(), row["hash"] ?? "");
  return { kind: "revoked", principal: row["principal"] ?? "", repo: row["repo"] ?? "(unknown)" };
}

function parseBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}
