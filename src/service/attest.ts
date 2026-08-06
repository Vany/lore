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
async function loadOrCreateKey(path: string): Promise<{ privateKey: string; publicKey: string }> {
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
    // Names BOTH attestable states, because `passed` is not the only one and saying
    // so sends a caller to wait for something it may never reach. Seventh place the
    // same omission turned up (d93dec01); the first six were documentation, and an
    // error message is documentation that arrives when someone is already stuck.
    throw new DidNotRun(
      `review is '${review.state}' — attesting it would be a false claim. ` +
        `Only 'passed' and 'passed_partial' can be attested, and only 'passed' is clean.`,
    );
  }
  // No tree, no attestation. The signature's whole subject is a TREE rather than a
  // branch name (D-40), so a line reading "reviewed tree unknown" asserts nothing
  // anyone can check while carrying a real ed25519 signature over it — which is
  // worse than refusing, because it LOOKS verified. That artefact was produced once,
  // by the first review ever to pass, and `?? "unknown"` was how (659c2f50).
  //
  // Recording the hash every round makes this unreachable for new reviews; the guard is
  // for the ones already in the database, and for whatever else might one day leave
  // the column null.
  if (review.treeHash === undefined) {
    throw new DidNotRun(
      `review ${reviewId} passed but recorded no tree hash, so there is nothing to attest to. ` +
        `The signature covers a tree, not a branch name (D-40) — signing "unknown" would look verified ` +
        `while asserting nothing. Re-run the review to record one.`,
    );
  }

  const counts = tally(store, reviewId);
  const tiers = countTiers(store, reviewId);
  const skipped = review.ladder.unavailable ?? [];
  const sole = review.ladder.soleVendor;

  // Deliberately plain. Every number in it can be checked against the audit trail.
  //
  // A partial review says so IN THE SIGNED LINE. Attesting one as though it were
  // complete would be the single most damaging thing this system could do: the
  // attestation is the one output whose entire value is that it can be trusted, and
  // a reader has no other way to tell the difference (D-48, D-49).
  //
  // The tier COUNT is the number a reader will take as a proxy for rigour, and it is
  // exactly the number a single-vendor ladder inflates: three tiers from one model
  // family is one opinion asked three times. So the vendor is named right next to the
  // count that would otherwise mislead.
  const caveats = [
    skipped.length === 0 ? undefined : `${skipped.join(", ")} could not run`,
    sole === undefined ? undefined : `every tier that ran was ${sole}, so these are not independent opinions`,
  ].filter((c) => c !== undefined);

  const scope = caveats.length === 0 ? `${tiers} tiers` : `${tiers} tiers — ${caveats.join("; ")}, so this is PARTIAL`;

  const line =
    `lore: reviewed tree ${review.treeHash} against this repo's rules and lore's own — ` +
    `${scope}, ${counts.raised} findings, ${counts.fixed} fixed, ${counts.justified} justified.`;

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
  // Counted per FINDING, by its LATEST verdict — the same rule `settledFingerprints`
  // uses. Counting verdict rows was wrong twice over, and the first attestation ever
  // produced showed both: verdicts are append-only, so a justification carried
  // forward each round (D-51) added a row per round, and one finding was reported as
  // "1 findings, 0 fixed, 3 justified". A finding rejected and then accepted would
  // likewise have been counted under both. An attestation is a claim about findings,
  // not about how many times we wrote a row.
  const verdicts = store.db
    .prepare(
      `SELECT v.verdict, COUNT(*) AS c FROM verdict v
       WHERE v.review_id = ?
         AND v.id = (SELECT MAX(id) FROM verdict w WHERE w.review_id = v.review_id AND w.fingerprint = v.fingerprint)
       GROUP BY v.verdict`,
    )
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
