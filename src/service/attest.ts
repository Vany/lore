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
    // same omission turned up; the first six were documentation, and an
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
  // by the first review ever to pass, and `?? "unknown"` was how.
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
  // THE TIERS THAT READ THE SIGNED TREE, not the tiers that ever ran on this review.
  // Since a closed tier is not re-run after a fix (D-6, revised 2026-08-07), those are
  // different sets: a finding from t1, answered while the ladder had reached t3, is
  // re-read by t3 alone. Counting every tier that ever ran would claim more scrutiny
  // than the tree in this signature actually received, and the attestation is the one
  // output whose whole value is that it can be trusted.
  const onTree = store.tiersOnTree(reviewId, review.treeHash);
  const tiers = onTree.length;
  const everyTier = countTiers(store, reviewId);
  const skipped = review.ladder.unavailable ?? [];
  const sole = review.ladder.soleVendor;
  const spread = review.ladder.vendorSpread;

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
    sole === undefined
      ? // THE PARTIAL COLLAPSE IS ALSO A CAVEAT, and it had no way to be said here.
        //
        // Only the total one had a field, so three tiers read by two vendors signed as if
        // three independent opinions had looked — in the one output whose entire value is
        // that it can be trusted, and against exactly the number a reader takes as a proxy
        // for rigour. D-117 made this the common shape rather than a rarity.
        spread === undefined
        ? undefined
        : `${String(spread.distinct)} vendor(s) read this across ${String(spread.tiers)} tiers ` +
          `(${spread.vendors.join(", ")}), so they are not ${String(spread.tiers)} independent opinions`
      : `every tier that ran was ${sole}, so these are not independent opinions`,
    // Named, not merely subtracted. A reader comparing "2 tiers" here against a trail
    // showing three would otherwise think the line was wrong; it is the trail that
    // includes tiers with no trusted read of THIS tree.
    //
    // lore-ok[20310406]: worded outcome-neutral on purpose. The gap covers three
    // different reasons now, not one: a tier that read a genuinely earlier tree and
    // was never re-run (D-6), a tier whose only run against this exact tree was
    // interrupted/failed/unpayable/stopped (tiersOnTree excludes all four), and a
    // tier whose run failed outright with no tree recorded at all. "Read an earlier
    // tree" was false for the second and third cases — this line no longer claims
    // to know which of the three happened, only that none of them left a read worth
    // trusting.
    tiers >= everyTier
      ? undefined
      : `${String(everyTier - tiers)} tier(s) never left a trusted read of this tree`,
  ].filter((c) => c !== undefined);

  const named = onTree.length === 0 ? "no tier" : onTree.join(", ");
  // PARTIAL IS THE LADDER'S VERDICT, NOT THIS FILE'S OPINION OF IT (D-88).
  //
  // Every caveat above used to end in "so this is PARTIAL", back when any skipped tier
  // forbade a pass. Since D-88 a tier skipped BELOW one that answered does not weaken the
  // verdict — its work was done again above it — so a review can reach `passed` with a
  // caveat attached, and stamping PARTIAL on it would be the mirror of the sin this line
  // exists to prevent: understating a review that was complete, in the one output whose
  // value is that it can be trusted.
  //
  // Read from the STATE rather than re-derived from `skipped`. The rule for what a skip
  // costs lives in `step()`; a second copy here would be free to disagree with the
  // verdict it is attesting, which is worse than either answer alone.
  //
  // The caveats themselves are printed either way. Disclosure never depended on the
  // verdict and must not start to — a signed line that quietly stopped naming a tier it
  // did not run is exactly what a reader has no other way to detect.
  // TWO INDEPENDENT SOURCES OF PARTIAL, and keying only off the verdict conflated them.
  //
  //   * the LADDER's verdict — a tier above the one that answered never ran, or every
  //     tier that ran was one vendor. That is `passed_partial`, and D-88 decides it.
  //   * the SIGNED TREE — a tier's only read of THIS tree was not one worth trusting:
  //     it may have read a genuinely EARLIER tree and, since a closed tier is not
  //     re-run after a fix (D-6), never re-read this one; or it ran against this
  //     exact tree but was interrupted, failed, unpayable, or stopped, which
  //     `tiersOnTree` now excludes. Either way that is a fact about what this
  //     signature covers, it is true on a full `passed`, and no ladder state
  //     records it.
  //
  // The second is why this cannot simply read the state: a `passed` whose t1 verdict was
  // given against a tree two fixes ago is genuinely partial COVER of the tree being
  // signed, whatever the verdict says. A test caught me collapsing them.
  const partial = review.state === "passed_partial" || tiers < everyTier;
  const scope =
    caveats.length === 0
      ? `${tiers} tiers (${named})`
      : `${tiers} tiers (${named}) — ${caveats.join("; ")}${partial ? ", so this is PARTIAL" : ""}`;

  // D-130, found by lore's own review of D-130 (medium, CWE-1078): a folder review's
  // tiers read only `reviewPath`, but `review.treeHash` is the WHOLE WORKTREE's tree
  // — hashed the same way for every review, folder or diff (D-40). Without this, "lore:
  // reviewed tree X" reads as a claim about everything at X, and a reader — or
  // automation gating a merge on the signature — has no way to tell a scoped read from
  // a full one without leaving the signed line for the unsigned audit trail. Named here
  // instead, in the one output whose whole value is that it can be trusted on its own.
  const scopedTo = review.reviewPath === undefined ? "" : ` (scoped to ${review.reviewPath})`;
  const line =
    `lore: reviewed tree ${review.treeHash}${scopedTo} against this repo's rules and lore's own — ` +
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
  const total = store.findingCount(reviewId);
  // Counted per FINDING, by its LATEST verdict — the same rule `settledFingerprints`
  // uses. Counting verdict rows was wrong twice over, and the first attestation ever
  // produced showed both: verdicts are append-only, so a justification carried
  // forward each round (D-51) added a row per round, and one finding was reported as
  // "1 findings, 0 fixed, 3 justified". A finding rejected and then accepted would
  // likewise have been counted under both. An attestation is a claim about findings,
  // not about how many times we wrote a row.
  const verdicts = store.latestVerdictCounts(reviewId);

  let fixed = 0;
  let justified = 0;
  for (const v of verdicts) {
    if (v.verdict === "fixed") fixed += v.c;
    if (v.verdict === "justified-accepted") justified += v.c;
  }
  return { raised: total, fixed, justified };
}

function countTiers(store: Store, reviewId: string): number {
  return store.tiersThatRan(reviewId);
}
