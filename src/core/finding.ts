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

/**
 * A MODEL THAT REACHES FOR "title"/"detail" HAS THE SHAPE RIGHT, ONLY THE NAMES WRONG —
 * so treat it as a naming drift to repair, not a malformed reply to refuse (D-128).
 *
 * Observed on this repository's own review of D-127, on a CRITICAL finding about a real
 * money-handling bug (`services/clearing-settlement/src/logic/run-reconciliation.ts`):
 * the model wrote `{"title": "...", "detail": "...", "severity": "critical", ...}` instead
 * of `claim`/`evidence`. `.strict()` refused it for the unknown keys, and `claim` being
 * genuinely absent would have refused it a second way even without `.strict()`. It survived
 * only because the retry `opencode.ts` sends on a whole-reply failure happened to land on
 * the right names the second time — a second, independent generation of the same finding,
 * worded differently from the first. Nothing compares a retry's content against the attempt
 * it replaces, so nothing would have noticed had it come back paraphrased worse, missing a
 * detail the first had, or not recovered at all — the actual near-miss was total loss on a
 * critical finding, gambled on a second roll. (Severity itself was never at risk here: D-115
 * maps any unrecognised word, including `critical`, to `high`, on both attempts identically
 * — that part of the story is what lore's own t1 corrected, reviewing this fix, and SPEC
 * D-128 says so.) Closing this at the boundary removes the retry, and the total-loss risk it
 * carries, for the one substitution actually seen — matching every other repair in this
 * file: do not gamble that a second attempt fixes what the first got wrong when the first
 * attempt's own intent is legible right there.
 *
 * DELIBERATELY NARROW. Fires only when the CANONICAL field is missing, so a reply that
 * already got `claim` right and also sent a stray `title` still hits `.strict()` exactly as
 * `finding.test.ts`'s "rejects unknown keys rather than dropping them" expects — an extra
 * field beside otherwise-correct output is a stronger drift signal than a substitution for
 * a genuinely missing one, and this repair does not touch that case. And it repairs the two
 * NAMES actually seen rather than a speculative table of every plausible synonym: `severity`
 * accumulated its synonym list from repeated real incidents (D-115), and this starts the
 * same way, from one.
 */
function repairFieldNames(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const o = input as Record<string, unknown>;
  const usable = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  // MISSING, never WRONG TYPE — asked by lore's own t2, reviewing this repair: should
  // `claim: 7` beside a good `title` be silently overwritten? No. `absent`, undefined and
  // an empty/blank string are all "nothing was said", which is what every other repair in
  // this file already forgives (`cwe`'s "blank is forgiven; WRONG is still rejected" is the
  // named precedent, and `still rejects [89], [{}], [[]] as a cwe` pins the wrong-type half
  // of it). A NUMBER or an OBJECT where a string was asked for is a stronger, more specific
  // drift signal than a naming substitution — it means the reviewer's output does not match
  // the contract's TYPES, not just its NAMES — and letting an alias quietly paper over that
  // would hide the very drift `.strict()` exists to surface. So a wrong-typed canonical
  // field is left exactly alone: not promoted over, and its sibling alias (now genuinely
  // unused) stays present too, so the schema's own rejection names both problems at once.
  const missing = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  // SAME LINE, THIRD FIELD — found by lore's own t2, minutes after `missing()` was written
  // for `claim`/`evidence` and not carried to the field beside them: `usable()` here treated
  // `failureScenario: 42` as "absent", so the backfill below silently overwrote a genuinely
  // present (if wrong-typed) value and then said "lore could not find a distinct failure
  // scenario" — false, one was given. `missing()` closes it the same way: wrong type is left
  // alone for the schema to refuse on its own terms, never quietly overwritten.
  const scenarioMissing = missing(o["failureScenario"]);
  const title = usable(o["title"]) ? o["title"].trim() : undefined;
  const detail = usable(o["detail"]) ? o["detail"].trim() : undefined;
  // ONE REPAIRABLE FIELD IS ENOUGH TO ENTER — found by lore's own t1 against this exact
  // guard. `hasClaim` alone used to return early, so a reply with `claim` right but
  // `evidence` missing and `detail` present (the D-128 substitution one field along, half
  // right instead of all wrong) was never reached: the promotion at `!hasEvidence` below
  // would have handled it, and never got the chance to. Each field's own guard already
  // decides whether IT needs repair; the entry guard's only job is "is there anything here
  // for either of them to do", not "is claim, specifically, already fine".
  const needsClaim = missing(o["claim"]) && title !== undefined;
  const needsEvidence = missing(o["evidence"]) && detail !== undefined;
  if (!needsClaim && !needsEvidence) return input;

  const out: Record<string, unknown> = { ...o };
  const notes: string[] = [];
  // THE DELETE LIVES INSIDE THE GUARD IT BELONGS TO, not after both — found by lore's own
  // t1 against this exact function. `evidence` already valid but `detail` ALSO present
  // (redundant, or genuinely different) used to fall through `!hasEvidence` and reach an
  // unconditional `delete out["detail"]` anyway: a stray field silently vanished with no
  // note, on the one path this file exists to keep loud — the same shape `.strict()` is
  // supposed to catch as drift and never got the chance to. Deleting only where the value
  // was actually consumed leaves an UNUSED alias exactly where it was: a stray key for
  // `.strict()` to name, matching "rejects unknown keys rather than dropping them".
  if (needsClaim) {
    out["claim"] = title;
    notes.push('lore read "title" as "claim" — the reviewer used the wrong field name.');
    delete out["title"];
  }
  if (needsEvidence) {
    out["evidence"] = detail;
    notes.push('lore read "detail" as "evidence" — the reviewer used the wrong field name.');
    delete out["detail"];
  }
  // NO THIRD FIELD TO DRAW FROM — `detail` already went to `evidence` above. Reused rather
  // than left absent: repeating it is a smaller loss than losing the finding, and the note
  // says the two were never actually distinguished, rather than implying they were.
  if (scenarioMissing && usable(out["evidence"])) {
    out["failureScenario"] = out["evidence"];
    notes.push('lore could not find a distinct failure scenario and reused "evidence" for it.');
  }
  if (notes.length === 0) return input;
  // A NOTE IS NOT PROOF, and must never stand in for the field that holds it — found by
  // lore's own t2, reviewing this repair: a reply with `title` alone (no `detail`, no
  // `evidence` under either name) used to fall into this join with nothing real behind it,
  // so `evidence` became JUST the repair note — "lore read title as claim" — which
  // satisfies `z.string().min(1)` and reads as proof of nothing. `repairStructure`'s
  // identical-looking join carried the SAME defect until minutes later in this same
  // review — the required-field check is the Zod parse that runs after every preprocess
  // in this chain, this one and that one both, so neither can assume evidence is already
  // guaranteed by the time it runs. So the note is appended ONLY where real content
  // already exists to attach it to — never fabricated from nothing — and a finding with
  // genuinely no evidence anywhere still fails the required-field check exactly as it
  // would have without any of this, going through the ordinary retry rather than being
  // admitted on a note.
  if (usable(out["evidence"])) {
    // NOTE FIRST, EVIDENCE SECOND — found by lore's own review, sibling of the identical
    // fix `repairStructure` just needed and asserted (`lore-ok[cf3dff66]`) as though this
    // was the only place it applied: this function runs FIRST in the chain
    // (`clampOverlongText(repairStructure(foldOverlongClaim(repairFieldNames(v))))`), so a
    // note appended AFTER a long `detail`/`evidence` here is just as exposed to
    // clampOverlongText's later tail-cut, which keeps the first TEXT_MAX-1 characters and
    // discards the rest.
    out["evidence"] = `${notes.join("\n")}\n\n${String(out["evidence"]).trim()}`;
  }
  return out;
}

/**
 * FOLDED, NEVER REFUSED — the same rule as `severity`, on the field that outlived it.
 *
 * D-115 fixed `severity` and wrote the general rule beside it: *validation at the reviewer
 * boundary must not be able to lose a finding*. `claim` was the other instance and was not
 * fixed with it. Eleven minutes before that commit landed, a review lost a t2 finding to
 * `claim: Too big: expected string to have <=500 characters` — a real defect about a ledger
 * read ordered before a bound check, discarded at the door for length, while the two t3
 * findings beside it were discarded for the severity word. Same review, same cause, one
 * field behind.
 *
 * Raising the cap again is what the previous three occurrences did (300 → 500, D-64), and
 * it does not converge: the retry does not shorten reliably — measured, a model told the
 * exact rule cut 44 characters and still missed by 14 — so every raise buys time until a
 * model writes a longer sentence. This one overshot by well over a hundred characters, not
 * by a clause.
 *
 * Truncating alone is worse and was itself a bug: `t0/engines.ts` and `security/osv.ts`
 * cut claims mid-clause at a hardcoded 300, which is exactly the failure D-64's rationale
 * names — *a claim silently cut mid-clause is a finding that says something its author did
 * not*. So nothing here is silent and nothing is lost: the full claim is carried into
 * `evidence` verbatim, and what stays in `claim` is cut at a word boundary and marked with
 * an ellipsis, so a reader sees both that it was cut and what it said.
 *
 * `evidence` is clamped afterwards because a fold must not trade one refusal for another —
 * an over-long `evidence` would fail `TEXT_MAX` and lose the finding we just saved. The
 * carried claim goes FIRST so it is the tail of the original evidence that gives way.
 *
 * The cap itself is unchanged and the prompt still asks for one sentence: this governs what
 * happens when a model does not comply, not what it is asked for.
 */
function foldOverlongClaim(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const o = input as Record<string, unknown>;
  const claim = o["claim"];
  if (typeof claim !== "string") return input;

  const full = claim.trim();
  if (full.length <= CLAIM_MAX) return input;

  // Cut at the last word boundary before the cap, but only if one falls in the back half —
  // otherwise a single unbroken token would shrink the claim to almost nothing.
  const head = full.slice(0, CLAIM_MAX - 1);
  const lastSpace = head.lastIndexOf(" ");
  const kept = lastSpace > CLAIM_MAX / 2 ? head.slice(0, lastSpace) : head;

  const evidence = typeof o["evidence"] === "string" ? o["evidence"].trim() : "";
  const carried = `Claim in full: ${full}`;
  let joined = evidence ? `${carried}\n\n${evidence}` : carried;
  if (joined.length > TEXT_MAX) joined = `${joined.slice(0, TEXT_MAX - 1)}…`;

  return { ...o, claim: `${kept.trimEnd()}…`, evidence: joined };
}

/**
 * THE LAST THREE REFUSALS THAT COULD COST A FINDING — repaired, and each repair SAID.
 *
 * D-115 (`severity`) and D-116 (`claim`, then `evidence`/`failureScenario`) established
 * the rule: *validation at the reviewer boundary must not be able to lose a finding*.
 * Three refusals survived it, each with a written reason, and the reason was the same in
 * all three: they are DRIFT DETECTORS. A `line` of 0, a `cwe` of `CWE-abc`, an unknown
 * key — each means the model and this schema disagree, and disagreement should be loud.
 *
 * It was loud by discarding the report, which is the trade the two decisions above
 * reversed twice. **The answer is to fail loudly WITHOUT losing the finding**: drop the
 * field that cannot be honoured, keep everything that can, and write what happened where
 * a reader will see it.
 *
 * `evidence` is where it goes, following the precedent `foldOverlongClaim` already set
 * with `Claim in full:` — no new channel to plumb, no new field to keep in sync, and it
 * lands in front of every reader of the finding at once: the client that polls it, the
 * operator board, and the next tier, which is the one that can tell whether the drift
 * matters. `checks_skipped` carries losses; this carries repairs, and a repair is part of
 * the finding rather than a fact about the round.
 *
 * A dropped `line` degrades the finding to file-level, which the schema already supports —
 * strictly more information than no finding at all.
 */
function repairStructure(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const o = input as Record<string, unknown>;
  const notes: string[] = [];
  const out: Record<string, unknown> = { ...o };
  // Tracks every write to `out`, not just the ones that also push a note — a silent
  // whitespace trim changes `out` without having anything worth disclosing.
  let changed = false;

  // A line that is not a usable 1-indexed integer. `absent` already reads null/blank as
  // "no line"; this is the case where the model MEANT a line and named an impossible one.
  const line = o["line"];
  if (line !== undefined && line !== null && line !== "") {
    const bad = typeof line !== "number" || !Number.isInteger(line) || line <= 0;
    if (bad) {
      delete out["line"];
      changed = true;
      notes.push(
        `lore dropped the line the reviewer gave (${JSON.stringify(line)}), which cannot be a 1-indexed ` +
          "line number; this is a file-level finding instead.",
      );
    }
  }

  const cwe = o["cwe"];
  if (typeof cwe === "string" && cwe.trim() !== "") {
    const trimmed = cwe.trim();
    if (/^CWE-\d+$/.test(trimmed)) {
      // WRITE THE TRIM BACK — found by lore's own review. This used to test the trimmed
      // value but leave the padded original in `out`, so "CWE-362 " passed this check
      // (valid once trimmed) and then failed the schema's own untrimmed regex downstream,
      // losing the WHOLE finding — worse than a genuinely malformed cwe like "CWE-abc",
      // which this branch already repairs. No note: padding is not a vocabulary
      // disagreement worth surfacing, the same reasoning hashHunk applies to whitespace.
      // MUST also flip `changed`, not just write `out` — found seconds later, same
      // review: the guard below used to key off `notes.length`, so a silent trim with
      // nothing to disclose changed `out` and then had that change thrown away by
      // `return input`.
      if (trimmed !== cwe) {
        out["cwe"] = trimmed;
        changed = true;
      }
    } else {
      delete out["cwe"];
      changed = true;
      notes.push(
        `lore dropped the CWE the reviewer gave (${JSON.stringify(cwe)}), which is not a CWE id. The ` +
          "reviewer and this schema disagree about that vocabulary — worth looking at, and not worth " +
          "losing this finding over.",
      );
    }
  }

  // `.strict()` IS DELIBERATELY LEFT ALONE, and it is the one that still costs a finding.
  //
  // An unknown key is the strongest drift signal this schema has — it means the prompt and
  // the contract have parted company, which is a bigger fact than any single finding — and
  // reversing it is a real decision rather than an obvious repair. The same treatment would
  // work (drop the keys, say so here), and it is written down as open in SPEC D-116 rather
  // than taken quietly along with the two that are unambiguous.

  if (!changed) return input;
  // A NOTE IS NOT PROOF HERE EITHER — the same fix `repairFieldNames` just needed, found by
  // lore's own t2 on THIS function seconds later: the SPEC text excusing this join called it
  // safe because it "only ever runs on a finding whose evidence this schema already
  // required" — backwards, since the required-field check is the Zod parse AFTER every
  // preprocessing step, including this one. A reply with a bad `line` or `cwe` and no
  // `evidence` anywhere reaches this join with nothing real to attach a note to, and used to
  // get `evidence` fabricated FROM the note alone. Same fix: append only where usable content
  // already exists; a finding with genuinely no evidence still fails the required-field check.
  if (notes.length > 0 && typeof out["evidence"] === "string" && out["evidence"].trim() !== "") {
    // NOTE FIRST, EVIDENCE SECOND — found by lore's own review: this used to append the
    // note AFTER evidence, so on a reply whose evidence already sat near TEXT_MAX,
    // clampOverlongText (which runs after this and cuts the TAIL, keeping the first
    // TEXT_MAX-1 characters) could slice the note off entirely — silently defeating the
    // "marked, never silent" rule this file states twice. Same reasoning
    // `foldOverlongClaim` already applies to its own carried claim: whatever a later
    // tail-clamp must not lose goes first, and the sacrificial content goes last.
    out["evidence"] = `${notes.join("\n")}\n\n${out["evidence"].trim()}`;
  }
  return out;
}

/**
 * THE SAME RULE ON THE TWO FIELDS IT HAD NOT REACHED YET.
 *
 * D-115 fixed `severity`, D-116 fixed `claim`, and `evidence` and `failureScenario` kept
 * the identical defect: `.max(TEXT_MAX)` refuses, and a refusal on one field discards the
 * whole finding. Fixing the third instance one field at a time is how the first two came
 * to exist, so this closes the class instead — every text field a model writes is clamped,
 * and none of them can cost the report.
 *
 * **This one is lossy at the tail and cannot not be.** `claim` had somewhere to go: its
 * full text is carried into `evidence`. `evidence` has nowhere — carrying it into
 * `failureScenario` would just move the same problem one field along and corrupt a field
 * that means something else. So the tail is cut and MARKED, which is the whole difference
 * from the silent mid-clause truncation D-64 condemns: a reader sees that it was cut.
 *
 * Losing the end of an over-long evidence paragraph is a small, visible loss. Losing the
 * finding is a silent total one, and the model has already been paid for it either way.
 */
function clampOverlongText(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const o = input as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = { ...o };
  for (const field of ["evidence", "failureScenario"] as const) {
    const v = o[field];
    if (typeof v !== "string") continue;
    const text = v.trim();
    if (text.length <= TEXT_MAX) continue;
    out[field] = `${text.slice(0, TEXT_MAX - 1).trimEnd()}…`;
    changed = true;
  }
  return changed ? out : input;
}

const FindingObject = z
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
    // lore-ok[d9908e4b]: fixed in repairStructure's cwe branch, not here — a trimmed-valid
    // cwe now writes the trimmed value back to `out` AND flips a `changed` flag the
    // function's own early-return guard now checks, so it survives to the schema's
    // untrimmed regex instead of being silently discarded by `return input`.
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

    /**
     * What is wrong, in one sentence.
     *
     * The cap stays enforced here rather than being widened: `foldOverlongClaim` has
     * already brought any over-long claim inside it, so this is the invariant the store
     * and every consumer rely on, not the gate a model has to clear. An empty claim is
     * still refused — a finding that states nothing is not a finding.
     */
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
  // A SEGMENT, not a substring — found by lore's own review. `.includes("..")` refused any
  // path containing two consecutive dots anywhere, including a legal filename like
  // `docs/api..deprecated.md` (verified: git tracks it without complaint). Only ".." as a
  // whole path SEGMENT — "../x", "a/../b", a trailing "..", or a bare ".." — can escape the
  // repo; splitting on "/" and checking each segment is what the traversal risk actually
  // is, and it is the one field no repair step in this chain covers, so an over-broad guard
  // here discards the whole finding rather than degrading it (the exact trade D-115/D-116
  // reversed twice for every other field).
  .refine((f) => !f.file.startsWith("/") && !f.file.split("/").includes(".."), {
    message: "file must be repo-relative and must not escape the repo",
    path: ["file"],
  });

/**
 * The fold runs BEFORE the object, so an over-long claim never reaches the cap that
 * would refuse it. Wrapping rather than putting the fold on the `claim` field itself,
 * because it has to write `evidence` too, and a field-level preprocess cannot see its
 * siblings. `.strict()` still applies: the spread preserves unknown keys, so prompt/schema
 * drift is still caught.
 */
// FIELD NAMES REPAIR FIRST, because every step after it reads `claim`/`evidence` by name —
// `foldOverlongClaim` no-ops on a finding still calling it `title`, and would fold nothing.
// `claim` folds SECOND, because its fold writes into `evidence` — clamping evidence before
// the carried claim arrives would leave the join to overflow `TEXT_MAX` and lose the
// finding both folds exist to save. `foldOverlongClaim` keeps its own join inside the cap;
// this is the backstop for an evidence the MODEL wrote too long.
// ORDER IS LOAD-BEARING, and each step is tested. The claim fold WRITES into `evidence`;
// `repairStructure` APPENDS to it; the clamp must therefore run last, or a repaired
// finding could overflow `TEXT_MAX` and be lost by the very chain that saved it.
// lore-ok[cf3dff66]: fixed inside `repairStructure` itself, not here — its note now goes
// FIRST and the original evidence SECOND, so this step's own tail-clamp cuts the
// (sacrificial) evidence tail rather than the (load-bearing) repair note. Verified with
// evidence at 1990 chars plus a bad `line`: the note survives intact. Order stays exactly
// as this comment describes; only what `repairStructure` puts first within its own output
// changed.
export const FindingSchema = z.preprocess(
  (v) => clampOverlongText(repairStructure(foldOverlongClaim(repairFieldNames(v)))),
  FindingObject,
);

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
