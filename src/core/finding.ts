/**
 * A finding: one defect, stated so it can be *tracked* rather than merely read.
 *
 * Why a record and not prose: prose cannot be deduped, adjudicated, or carried
 * between rounds, so a ladder built on it re-litigates every point at every tier
 * and never converges. That is the central limitation of the bash predecessor this
 * replaces. Every reviewer — deterministic tool or model — emits these instead.
 *
 * This type is the wire contract with the models, so the schema is what we put in
 * their prompt and what we validate their output against. There is deliberately
 * only one shape: a separate internal representation would drift from the one the
 * models were asked for, and the drift would be invisible.
 *
 * SPEC: spec/review-ladder.md §3
 */

import * as z from "zod";

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Caps exist to enforce the shape, not to save bytes.
 *
 * `claim` is one sentence because a finding that sprawls cannot be compared with
 * another finding, and because output tokens are ~77% of the top tier's cost once
 * input is cached — a reviewer that writes essays instead of records costs several
 * times more at every tier, forever (SPEC D-29).
 */
const CLAIM_MAX = 300;
const TEXT_MAX = 2000;

export const FindingSchema = z
  .object({
    /** Repo-relative path. Absolute paths are rejected below. */
    file: z.string().min(1).max(1024),

    /** 1-indexed. Optional: file-level findings have no line. */
    line: z.number().int().positive().optional(),

    /**
     * Enclosing function/class/method. Optional, but load-bearing when present:
     * it is what keeps a finding's identity stable while line numbers shift
     * (see fingerprint.ts).
     */
    symbol: z.string().min(1).max(256).optional(),

    severity: z.enum(SEVERITIES),

    /** What is wrong, in one sentence. */
    claim: z.string().min(1).max(CLAIM_MAX),

    /** Where the proof is — file:line references, quoted code. */
    evidence: z.string().min(1).max(TEXT_MAX),

    /** Concrete inputs or state → the wrong outcome. */
    failureScenario: z.string().min(1).max(TEXT_MAX),

    /**
     * Optional CWE id, e.g. "CWE-89". Optional because most review findings are
     * not security weaknesses, and forcing a taxonomy onto "this test would pass
     * without its fix" would be theatre. When present it is the shared vocabulary
     * that lets two tiers, and the scanners, talk about the same defect (D-44).
     */
    cwe: z
      .string()
      .regex(/^CWE-\d+$/, "cwe must look like CWE-89")
      .optional(),
  })
  // Strict: an unexpected key means our prompt and this schema have drifted apart.
  // Silently dropping it would hide that drift for as long as it took someone to
  // notice the findings had quietly got worse. The reviewer gets one retry
  // (spec/review-ladder.md §3) and then the review fails loudly.
  .strict()
  .refine((f) => !f.file.startsWith("/") && !f.file.includes(".."), {
    message: "file must be repo-relative and must not escape the repo",
    path: ["file"],
  });

export type Finding = z.infer<typeof FindingSchema>;

/**
 * Parse a candidate finding, throwing on anything malformed.
 *
 * Loud by design: an unparseable review is a failed review, never a clean one
 * (INV-1). This is the most likely path by which a "green" run could silently
 * mean nothing.
 */
export function parseFinding(input: unknown): Finding {
  return FindingSchema.parse(input);
}

/**
 * Normalise a claim for identity purposes.
 *
 * Deliberately shallow — case, whitespace and trailing punctuation only. Those are
 * the variations that carry no meaning. Anything deeper (stemming, synonyms) would
 * be false confidence: it would silently merge findings that differ in ways we did
 * not model, and a wrongly-merged finding is one that never gets fixed.
 */
export function normalizeClaim(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "");
}
