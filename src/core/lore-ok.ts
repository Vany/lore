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
 * never have settled (b674468b). That is d6d9cd72's failure again — a reason
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
 * wrong while claiming otherwise (11817665). A bare ` *` is a PARAGRAPH BREAK in a
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
 * Only the two comment forms the spec names. Adding `#` for YAML and Python is an
 * obvious future need but not a guess to make now — a marker syntax that silently
 * differs between languages is worse than one that is absent.
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
    if (reason.length > 0) found.push({ short, reason, line: i + 1 });
  }

  for (const m of source.matchAll(HTML_START)) {
    const reason = (m[2] ?? "").replace(/\s+/g, " ").trim();
    if (reason.length === 0) continue;
    found.push({
      short: m[1] ?? "",
      reason,
      line: source.slice(0, m.index).split("\n").length,
    });
  }

  return found.sort((a, b) => a.line - b.line);
}
