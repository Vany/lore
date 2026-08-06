/**
 * Shapes that keep producing bugs here, checked mechanically instead of by reading.
 *
 * Almost nothing found on 2026-08-05/06 was found by lore reviewing itself. I found
 * things by reading and the client found things by using — and they were not
 * unrelated. Two shapes account for most of them, and both are greppable:
 *
 *   * **one thing defined twice, and the copies disagree** — the terminal review
 *     states were written out in FIVE places, and `passed_partial` was missing from
 *     three of them. That silently overwrote a partial pass with `expired` after 48h,
 *     held its worktree for ever, and showed it as permanently open in two views. I
 *     introduced `TERMINAL_SQL` to fix this, fixed the copies I happened to read, and
 *     declared it done — then found two more the next day.
 *
 *   * **something declared that nothing reaches** — `RULE_DIRS` sat beside the
 *     document list looking used, consumed only to scope a rule that could never be
 *     found, so 37 ADRs went unread and the customer's repo had eight rules.
 *
 * A reader believes a constant that looks used. These tests do not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REVIEW_STATES } from "./review-state.ts";

const SRC = new URL("..", import.meta.url).pathname;

function sources(dir = SRC, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const FILES = sources().map((path) => ({ path: path.slice(SRC.length), text: readFileSync(path, "utf8") }));

describe("review states have one definition", () => {
  // A SQL membership test naming states as literals. Every one of these that existed
  // was missing `passed_partial`, because the list was written from memory each time.
  const SPELLED_OUT = /(?:NOT\s+)?IN\s*\(\s*'(?:passed|failed|expired|passed_partial|findings_ready)'[^)]*\)/i;

  it("is never spelled out in a SQL membership test", () => {
    const offenders = FILES.filter((f) => SPELLED_OUT.test(f.text)).map((f) => f.path);
    expect(offenders, `use TERMINAL_SQL (or an explicit derived list) instead of writing the states out:\n  ${offenders.join("\n  ")}`).toStrictEqual([]);
  });

  // The guard above only helps while the derived list is the real one.
  it("derives the SQL form from the same set the type checker sees", async () => {
    const { TERMINAL_SQL } = await import("./review-state.ts");
    const named = TERMINAL_SQL.split(",").map((s) => s.trim().replaceAll("'", ""));
    expect(named).toContain("passed_partial");
    for (const s of named) expect(REVIEW_STATES).toContain(s);
  });
});

describe("an exported constant has a reader", () => {
  /**
   * A constant nothing consumes is worse than one that is absent: it reads as a
   * feature. `RULE_DIRS` was exported, referenced once for scoping, and never used to
   * FIND anything — so the spec promised ADRs were ingested and none ever was.
   *
   * Only `const` collections, which is where this failure mode lives. Types and
   * functions have their own reasons to be exported.
   */
  const DECL = /^export const ([A-Z][A-Z0-9_]+)\s*(?::|=)/gm;

  it("is read somewhere outside the file that declares it", () => {
    const orphans: string[] = [];

    for (const file of FILES) {
      for (const [, name] of file.text.matchAll(DECL)) {
        if (name === undefined) continue;
        const readers = FILES.filter((f) => f.path !== file.path && new RegExp(`\\b${name}\\b`).test(f.text));
        // Declared and consumed only by its own module is fine — it is private in
        // spirit. Declared, exported, and consumed by NOBODY is the trap.
        const usedAtHome = (file.text.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length > 1;
        if (readers.length === 0 && !usedAtHome) orphans.push(`${name} (${file.path})`);
      }
    }

    expect(orphans, `exported, and nothing reads them — delete or wire up:\n  ${orphans.join("\n  ")}`).toStrictEqual([]);
  });
});
