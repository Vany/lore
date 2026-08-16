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
import { absent } from "./optional.ts";

/** Declared **worst first**: the index into this array is the severity rank (D-50). */
export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Caps exist to enforce the shape, not to save bytes.
 *
 * `claim` is one sentence because a finding that sprawls cannot be compared with
 * another finding, and because output tokens are ~77% of the top tier's cost once
 * input is cached — a reviewer that writes essays instead of records costs several
 * times more at every tier, forever (SPEC D-29).
 *
 * **300 → 500 on 2026-08-05, on the evidence of four failures.** Every recorded
 * violation was a *sentence* — one clause too many, never an essay — and the shape
 * the cap defends was never actually under attack:
 *
 *   | occurrence | length | over |
 *   |---|---|---|
 *   | earlier | 325 | 25 |
 *   | t2 round 5, first reply | 358 | 58 |
 *   | t2 round 5, retry | 314 | **14** |
 *
 * That retry is the argument. The model was told the exact rule, cut 44 characters,
 * and still missed — so the retry does not converge here, and the cost of holding
 * the line is a discarded reply, not a shorter one. The last one discarded a real
 * defect: `openFindings` had no latest-verdict gate. It was thrown away for being 58
 * characters long, and recovered only because the error message quoted it.
 *
 * 500 keeps the shape (one long sentence, ~70 words — still a record, not a
 * paragraph) and clears the observed maximum by 40%. It stays four times smaller
 * than `TEXT_MAX`, so `claim` remains the field that must be short and `evidence`
 * the one that may be long. Raised rather than truncated because a claim silently
 * cut mid-clause is a finding that says something its author did not.
 */
export const CLAIM_MAX = 500;
const TEXT_MAX = 2000;

export const FindingSchema = z
  .object({
    /** Repo-relative path. Absolute paths are rejected below. */
    file: z.string().min(1).max(1024),

    /** 1-indexed. Optional: file-level findings have no line. */
    line: absent(z.number().int().positive()),

    /**
     * Enclosing function/class/method. Optional, but load-bearing when present:
     * it is what keeps a finding's identity stable while line numbers shift
     * (see fingerprint.ts).
     */
    symbol: absent(z.string().min(1).max(256)),

    /**
     * COERCED, NEVER REFUSED — because refusing it throws the whole finding away.
     *
     * `z.enum(SEVERITIES)` rejected anything else, and a rejected finding fails the whole
     * object: the model had read the code, found a real defect, and its report was
     * discarded at the door over one word. Observed on this repository — t1 raised a
     * `critical` finding about an unbounded round loop, the parse failed, and what reached
     * the client was a `checks_skipped` line saying a finding existed and could not be
     * shown. Honest, and still a review that found something and said nothing, which is
     * INV-1 exactly.
     *
     * The scale is deliberately three (D-50) and stays three; a model that reaches for a
     * fourth word is expressing urgency, not proposing a taxonomy. So the word is mapped
     * and the finding survives.
     *
     * ANYTHING UNRECOGNISED BECOMES `high`, not `low`. A severity nobody planned for is
     * more likely to be an escalation than a nit — `critical`, `blocker`, `severe` all
     * point one way — and `severityRank` already ranks an unknown value FIRST for the same
     * reason: burying it is how it goes unread.
     */
    severity: z.preprocess((v) => {
      if (typeof v !== "string") return v;
      const word = v.trim().toLowerCase();
      if ((SEVERITIES as readonly string[]).includes(word)) return word;
      if (word === "moderate" || word === "med") return "medium";
      if (word === "info" || word === "informational" || word === "minor" || word === "trivial" || word === "nit") {
        return "low";
      }
      return "high";
    }, z.enum(SEVERITIES)),

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
    // "No CWE applies" is read as ABSENT however the model writes it — omitted,
    // `""`, blank, or `null` — and never as malformed. `absent` is what makes that
    // true, and it is shared with every other optional field for the reason its own
    // header gives: this exact behaviour was written here first, as a preprocess on
    // this one field, and the three fields that needed it identically did not get it.
    //
    // Observed, and expensive: glm-4.7 returned two real findings, one of them a
    // genuine hole in a fix made an hour earlier, and lore binned the lot over a
    // zero-length field on the second one. The model had already been paid for.
    //
    // Blank is forgiven; WRONG is still rejected. "CWE-abc" means the reviewer and
    // this schema disagree about the vocabulary, which is drift worth failing on.
    //
    // The table of every accepted and rejected form is in finding.test.ts, NOT in
    // this comment. It lived here once, as prose, while nothing executed it — which
    // is how a refactor could have deleted the preprocess with the suite still green
    // A comment is a claim nobody runs.
    cwe: absent(z.string().regex(/^CWE-\d+$/, "cwe must look like CWE-89")),
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

/**
 * Rank a severity, lower being worse.
 *
 * Nothing about these three words orders itself, and the obvious order is wrong: as
 * text `"low" < "medium"`, which is how every findings query ranked them until
 * 2026-08-03 — a low-severity finding presented ahead of a medium one everywhere,
 * including in the `highest` field of `review.inbox` (D-50). The rank is the position
 * in `SEVERITIES` so that adding a severity cannot leave a stale rank table behind,
 * and so the SQL in store/schema.ts can be generated from the same array.
 *
 * An unrecognised severity ranks -1, i.e. **first**. It can only come from a row
 * written around the schema, and the top of the list is where someone will see it;
 * ranked last it would read as a low-severity nit and would sit exactly where
 * truncation drops things.
 */
export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

/** What ordering needs. T0's findings have no fingerprint, so this is not `RecordedFinding`. */
type Orderable = Pick<Finding, "severity" | "file" | "line">;

/**
 * Compare two findings for presentation: worst severity first, then file, then line.
 *
 * For lists the store never touched — T0's findings, which carry no fingerprint.
 *
 * It APPROXIMATES `FINDING_ORDER_SQL` rather than matching it, and the gaps are
 * known rather than assumed:
 *
 *   * file comparison is JS UTF-16 order, SQLite's is BINARY (UTF-8). They disagree
 *     above the BMP — a path containing an emoji or a rarer CJK extension can sort
 *     differently here than it did in SQL.
 *   * `severityRank` returns -1 (via `indexOf`) for a severity outside `SEVERITIES`,
 *     so two DIFFERENT unrecognised values tie here while SQL's `ELSE -1` ties them
 *     too — the tie is consistent, but neither side breaks it the same way.
 *   * SQL breaks remaining ties on fingerprint; a bare `Finding` has none.
 *
 * `Array.sort` is stable, so re-sorting a store-ordered list preserves the store's
 * decision wherever this comparator is indifferent. That is why it is safe to apply
 * to either kind of list — not because the two orderings are identical.
 *
 * A file-level finding (no line) sorts before located ones in the same file, matching
 * SQLite's NULL-first. `line` is schema-constrained positive, so mapping a missing
 * line to 0 cannot collide with a real one — a raw write bypassing the schema could
 * still tie, which is a fault in the writer.
 */
export function compareFindings(a: Orderable, b: Orderable): number {
  if (a.severity !== b.severity) return severityRank(a.severity) - severityRank(b.severity);
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return (a.line ?? 0) - (b.line ?? 0);
}

/**
 * The worst severity present, or `undefined` if there is nothing to rank.
 *
 * Computed rather than read off the front of a list: `review.inbox` used to take the
 * first row and call it the highest, which was only true for as long as the query
 * really was sorted worst-first — and it was not.
 */
export function worstSeverity(severities: readonly Severity[]): Severity | undefined {
  let worst: Severity | undefined;
  for (const s of severities) {
    if (worst === undefined || severityRank(s) < severityRank(worst)) worst = s;
  }
  return worst;
}
