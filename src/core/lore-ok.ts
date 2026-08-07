/**
 * The `lore-ok` comment: a proposal of lore, written where the code is.
 *
 * When the client believes a finding is wrong it does not silently skip it — it
 * writes the reason at the site, and the *reviewer* rules on whether the reason
 * holds. Accepted, the reason becomes a fact the codebase knows about itself.
 * Rejected, the finding returns at raised severity.
 *
 *     // lore-ok[a1b2c3d4]: bounded by the caller's schema check at api/route.ts:31,
 *     // so a negative amount cannot reach here.
 *
 *     <!-- lore-ok[a1b2c3d4]: reason -->
 *
 * SPEC: spec/review-ladder.md §4
 */

import { SHORT_LENGTH } from "./fingerprint.ts";

export interface LoreOk {
  /** Short fingerprint linking this comment to the finding it answers. */
  readonly short: string;
  /** Why the author believes the code is correct. */
  readonly reason: string;
  /** 1-indexed line where the marker appears. */
  readonly line: number;
  /**
   * A development rule this reason APPEALS TO, by short id (D-83).
   *
   * `lore-ok[a1b2c3d4]: rule 3f9a2c11 — loopback URLs in tests are not transport`
   *
   * A different claim from the rest of the reason, and the difference is the point. An
   * ordinary justification says *trust my judgement about this line*. An appeal says
   * *you are enforcing a standard this project decided not to enforce* — a claim about
   * the REVIEWER rather than about the code — and it is answerable by pointing at
   * something the team wrote down rather than by arguing again.
   *
   * Parsed out of the reason rather than given its own tool: `review_submit` is already
   * the channel for answering a finding, the marker already travels with the code the
   * reviewer is reading, and the docs are the interface — a fourth thing for an agent to
   * discover costs more than a convention inside a form it already knows.
   */
  readonly rule?: string;
}

/**
 * `rule <id>` opening a reason, with an optional dash before the note.
 *
 * THE FULL SHORT ID, never an abbreviation of it. Four hex characters were accepted, and
 * four hex characters is also `1234` — so *"rule 1234 of the style guide covers this"*,
 * an ordinary justification, was read as an appeal to a rule that does not exist, and the
 * tier was told to judge its central claim as unsupported. The author had cited nothing.
 *
 * There is no cost to requiring all eight: `knowledge_teach` hands back exactly eight as
 * `cite_as`, so nobody is ever in a position to type fewer. A longer paste is taken whole
 * — `policyByShort` matches on prefix, so a full uuid resolves as well as its head.
 */
const APPEAL = new RegExp(
  `^rule\\s+([0-9a-f]{${String(SHORT_LENGTH)}}[0-9a-f-]*)\\s*[—–:-]?\\s*([\\s\\S]*)$`,
  "i",
);

/**
 * Split a cited rule off the front of a reason.
 *
 * The note is kept as the reason and may be empty: *"this is policy R"* is a complete
 * argument, and forcing prose after it would only invite restating the rule.
 */
export function appealOf(reason: string): { readonly rule?: string; readonly reason: string } {
  const m = APPEAL.exec(reason.trim());
  if (m === null) return { reason };
  return { rule: (m[1] ?? "").toLowerCase(), reason: (m[2] ?? "").trim() };
}

const SHORT = `[0-9a-f]{${SHORT_LENGTH}}`;
/** `// lore-ok[abcd1234]: reason` — the rest of the line is the start of the reason. */
const SLASH_START = new RegExp(`^\\s*//\\s*lore-ok\\[(${SHORT})\\]\\s*:\\s*(.*)$`);
/** A `//` comment line with no new marker: a continuation of the reason above. */
const SLASH_CONT = /^\s*\/\/\s?(.*)$/;
/** `<!-- lore-ok[abcd1234]: reason -->`, possibly spanning lines. */
const HTML_START = new RegExp(`<!--\\s*lore-ok\\[(${SHORT})\\]\\s*:\\s*([\\s\\S]*?)-->`, "g");
/**
 * ` * lore-ok[abcd1234]: reason` — the JSDoc/block-comment form.
 *
 * Added because it was silently missing and that cost a justification. This
 * codebase explains itself in `/** ... *\/` blocks, so a long reason lands there by
 * reflex; mine did, `parseLoreOk` skipped it, and the finding it answered could
 * never have settled. That is the same failure again — a reason
 * written in the right place, about the right code, that nothing ever read.
 *
 * It is also what this file already argued for: a marker that works in one comment
 * syntax and silently fails in another is worse than one that is absent.
 */
const STAR_START = new RegExp(`^\\s*\\*\\s*lore-ok\\[(${SHORT})\\]\\s*:\\s*(.*)$`);
/**
 * A ` * ` line continuing the reason. Never the closing `*\/`, and never a blank ` *`.
 *
 * The blank case is the one that matters, and the first version of this got it
 * wrong while claiming otherwise. A bare ` *` is a PARAGRAPH BREAK in a
 * JSDoc block, and matching it meant the continuation ran straight through into
 * whatever prose followed — so a justification silently grew an unrelated paragraph
 * that the reviewer then had to rule on. `(.*\S)` requires at least one
 * non-whitespace character, which is what stops it.
 *
 * `SLASH_CONT` has the same shape and is deliberately left alone: it is not what
 * this finding was about, and changing the behaviour of the form every existing
 * justification uses is not something to do at the end of a long branch. Written
 * down rather than left as a difference someone rediscovers.
 */
const STAR_CONT = /^\s*\*(?!\/)\s?(.*\S)\s*$/;

/**
 * Find every justification in a file.
 *
 * Only the three comment forms the spec names: `//`, ` * ` inside a block, and
 * `<!-- -->`. Adding `#` for YAML and Python is an obvious future need but not a
 * guess to make now — a marker syntax that silently differs between languages is
 * worse than one that is absent. JSON has no comment at all, so a finding there
 * cannot be justified in place; that is open, and in TODO.
 */
export function parseLoreOk(source: string): LoreOk[] {
  const found: LoreOk[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    // Whichever line form this is, it continues in the SAME form: a `//` reason is
    // not continued by a ` * ` line, so two adjacent comment blocks cannot merge.
    const slash = SLASH_START.exec(lines[i] ?? "");
    const star = slash === null ? STAR_START.exec(lines[i] ?? "") : null;
    const start = slash ?? star;
    if (start === null) continue;
    const isStar = slash === null;
    const CONT = isStar ? STAR_CONT : SLASH_CONT;
    const START = isStar ? STAR_START : SLASH_START;

    const short = start[1] ?? "";
    const parts = [start[2] ?? ""];

    // Absorb following comment lines as continuation. Stops at the first line that
    // is not a comment of the same form, or at a line that begins a different
    // justification — two markers must never merge into one reason. For the block
    // form, `*/` is not a continuation, so a reason cannot run past its own comment.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (START.test(next)) break;
      const cont = CONT.exec(next);
      if (cont === null) break;
      parts.push(cont[1] ?? "");
      i = j;
    }

    const reason = parts.join(" ").replace(/\s+/g, " ").trim();
    // A marker with no reason is not a justification. Dropping it silently would
    // let an empty comment close a finding, which is exactly the "write your way
    // past it" failure the reviewer-rules-on-it design exists to prevent.
    if (reason.length > 0) {
      const a = appealOf(reason);
      found.push({ short, reason: a.reason, line: i + 1, ...(a.rule === undefined ? {} : { rule: a.rule }) });
    }
  }

  for (const m of source.matchAll(HTML_START)) {
    const reason = (m[2] ?? "").replace(/\s+/g, " ").trim();
    if (reason.length === 0) continue;
    const a = appealOf(reason);
    found.push({
      short: m[1] ?? "",
      reason: a.reason,
      line: source.slice(0, m.index).split("\n").length,
      ...(a.rule === undefined ? {} : { rule: a.rule }),
    });
  }

  return found.sort((a, b) => a.line - b.line);
}
