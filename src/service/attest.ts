/**
 * The attestation: one signed line saying what was done.
 *
 * It asserts **what was checked**, never that the code is correct. "Our models
 * stopped finding things" does not imply "no defects remain", and the first bug
 * shipped behind an overclaiming badge is the one that discredits the whole
 * service. The facts are impressive enough on their own precisely because they are
 * checkable.
 *
 * The signature covers a **tree hash, not a branch name** (D-40). If the branch has
 * moved since, the attestation does not describe what is there now.
 *
 * SPEC: D-15, spec/mcp-api.md §7
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DidNotRun } from "../core/errors.ts";
import { isAttestable } from "../core/review-state.ts";
import type { Store } from "../store/store.ts";

export interface Attestation {
  readonly line: string;
  readonly signature: string;
  readonly publicKey: string;
}

/**
 * Load the signing key, creating it on first use.
 *
 * Lives in the backed-up volume: losing it invalidates nothing already issued
 * (those signatures still verify against the published public key) but means every
 * future attestation is signed by a stranger.
 */
export async function loadOrCreateKey(path: string): Promise<{ privateKey: string; publicKey: string }> {
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing !== undefined) {
    const priv = createPrivateKey(existing);
    return { privateKey: existing, publicKey: createPublicKey(priv).export({ type: "spki", format: "pem" }).toString() };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, pem, { mode: 0o600 });
  return { privateKey: pem, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

export async function attest(store: Store, reviewId: string, principal: string, keyPath: string): Promise<Attestation> {
  const review = store.getReview(reviewId, principal);
  if (review === undefined) throw new DidNotRun(`review ${reviewId} not found`);
  if (!isAttestable(review.state)) {
    throw new DidNotRun(`review is '${review.state}', not 'passed' — attesting it would be a false claim`);
  }

  const counts = tally(store, reviewId);
  const tiers = countTiers(store, reviewId);

  // Deliberately plain. Every number in it can be checked against the audit trail.
  const line =
    `lore: reviewed tree ${review.treeHash ?? "unknown"} against this repo's rules and lore's own — ` +
    `${tiers} tiers, ${counts.raised} findings, ${counts.fixed} fixed, ${counts.justified} justified.`;

  const { privateKey, publicKey } = await loadOrCreateKey(keyPath);
  const signature = sign(null, Buffer.from(line, "utf8"), createPrivateKey(privateKey)).toString("base64");

  return { line, signature, publicKey };
}

export function verifyAttestation(a: Attestation): boolean {
  return verify(null, Buffer.from(a.line, "utf8"), createPublicKey(a.publicKey), Buffer.from(a.signature, "base64"));
}

export function render(a: Attestation): string {
  return `${a.line}  [ed25519:${a.signature}]`;
}

function tally(store: Store, reviewId: string): { raised: number; fixed: number; justified: number } {
  const row = store.db
    .prepare("SELECT COUNT(*) AS c FROM finding WHERE review_id = ?")
    .get(reviewId) as Record<string, number | bigint> | undefined;
  const verdicts = store.db
    .prepare("SELECT verdict, COUNT(*) AS c FROM verdict WHERE review_id = ? GROUP BY verdict")
    .all(reviewId) as Record<string, string | number | bigint>[];

  let fixed = 0;
  let justified = 0;
  for (const v of verdicts) {
    const c = Number(v["c"] ?? 0);
    if (v["verdict"] === "fixed") fixed += c;
    if (v["verdict"] === "justified-accepted") justified += c;
  }
  return { raised: Number(row?.["c"] ?? 0), fixed, justified };
}

function countTiers(store: Store, reviewId: string): number {
  const row = store.db
    .prepare("SELECT COUNT(DISTINCT tier) AS c FROM tier_run WHERE review_id = ?")
    .get(reviewId) as Record<string, number | bigint> | undefined;
  return Number(row?.["c"] ?? 0);
}
