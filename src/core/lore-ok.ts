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
    const start = SLASH_START.exec(lines[i] ?? "");
    if (start === null) continue;

    const short = start[1] ?? "";
    const parts = [start[2] ?? ""];

    // Absorb following `//` lines as continuation. Stops at the first line that is
    // not a comment, or at a line that begins a different justification — two
    // markers must never merge into one reason.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (SLASH_START.test(next)) break;
      const cont = SLASH_CONT.exec(next);
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
