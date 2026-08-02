/**
 * Stable identity for a finding.
 *
 * This is what lets the ladder converge: a finding already settled must not
 * re-trigger work when the next tier raises it again (SPEC §3.1, bound 1). Without
 * a stable identity, tier T+1 re-litigates everything tier T resolved, forever.
 *
 * SPEC: spec/review-ladder.md §3.1
 */

import { createHash } from "node:crypto";
import { normalizeClaim, type Finding } from "./finding.ts";

/**
 * Characters shown in a `lore-ok[…]` comment.
 *
 * Short enough to type and read in source; short enough to collide. 8 hex is 32
 * bits, so ~10k findings in one repo carries roughly a 1% chance of some pair
 * sharing a prefix. That is acceptable ONLY because lookup by short id must treat
 * ambiguity as an error rather than picking a winner — the same rule git applies to
 * short object ids. Silently resolving to the wrong finding would close a defect
 * nobody examined.
 */
export const SHORT_LENGTH = 8;

/**
 * `sha256(normalized_claim ‖ file ‖ enclosing_symbol)`
 *
 * Deliberately NOT the line number. Lines shift under every edit, and a finding
 * that moved three lines down is the same finding — keying on position would make
 * every fix look like a fresh discovery and the loop would never terminate.
 *
 * The enclosing symbol is included because it is stable under formatting while
 * still distinguishing two identical claims about different functions in one file.
 * When absent, findings that are file-level (or from a tool that cannot report a
 * symbol) share a bucket, which is the correct behaviour: we have no evidence they
 * are different.
 */
export function fingerprint(finding: Finding): string {
  return createHash("sha256")
    .update(join(normalizeClaim(finding.claim), finding.file, finding.symbol ?? ""))
    .digest("hex");
}

/** The form written into `lore-ok[…]` comments. */
export function shortFingerprint(finding: Finding): string {
  return fingerprint(finding).slice(0, SHORT_LENGTH);
}

/**
 * Length-prefixed join, so no part can impersonate a boundary.
 *
 * With a plain separator, ("ab", "c") and ("a", "bc") hash identically whenever the
 * separator appears inside a part — and a `claim` is free text, so it can contain
 * anything. Cheap to prevent, invisible if it ever happened.
 */
function join(...parts: readonly string[]): string {
  return parts.map((p) => `${p.length}:${p}`).join("");
}
