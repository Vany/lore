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

  /**
   * ...AND SO DOES EACH OF ITS MEMBERS.
   *
   * The check above passed for the whole of this service's life while three of the
   * nine entries in `CONDITIONS` were dead — `backupStale`, `providerAuthFailed`,
   * `needsHumanAgeing` — because it asks whether the CONTAINER is read, and
   * `CONDITIONS` is read by three modules. `spec/operations.md` §2.1 listed two of
   * them under "page, someone should look now" throughout.
   *
   * That is the shape PROG.md names two bullets down: a test named for a property it
   * does not test. It asserted the setup, not the consequence. A routing table is
   * exactly where this hides, because the table being wired reads as the routes being
   * wired.
   *
   * Members only, on tables declared `as const` — a registry the code dispatches
   * through, not every exported object.
   */
  it("has a caller for every member of an exported routing table", () => {
    const TABLE = /^export const ([A-Z][A-Z0-9_]+)\s*=\s*\{([\s\S]*?)\n\} as const;/gm;
    const MEMBER = /^ {2}([a-zA-Z][a-zA-Z0-9_]*)\s*:/gm;
    const orphans: string[] = [];

    for (const file of FILES) {
      for (const [, table, body] of file.text.matchAll(TABLE)) {
        if (table === undefined || body === undefined) continue;
        for (const [, member] of body.matchAll(MEMBER)) {
          if (member === undefined) continue;
          // `TABLE.member` anywhere, including at home — a table consumed only by its
          // own module is a legitimate shape, an entry consumed by nothing is not.
          const used = new RegExp(`\\b${table}\\.${member}\\b`);
          if (!FILES.some((f) => used.test(f.text))) orphans.push(`${table}.${member} (${file.path})`);
        }
      }
    }

    expect(
      orphans,
      `declared in a routing table and never dispatched to — wire it up or delete it:\n  ${orphans.join("\n  ")}`,
    ).toStrictEqual([]);
  });
});

/**
 * `@#` is a make prefix only at the START of a recipe line.
 *
 * Inside a `\`-continued shell command it is shell text, and `sh` answers
 * `@#: command not found` — exit 127. Written that way in `replica-state`, it made
 * `make status` print the replica in red while it was perfectly level: the
 * wolf-crying failure that monitor exists to avoid, reintroduced by its own fix, and
 * caught only because a status run happened to be watched.
 *
 * Comments about a continued recipe go OUTSIDE it, as `##` above the target.
 */
// A COMMENT'S PROVENANCE DECAYS; ITS INCIDENT DOES NOT.
//
// `PROG.md` requires a guard to carry what it guards against, and that rule kept
// collecting a second half nobody asked for: who reported it, in which round, against
// which commit. That part is bookkeeping, and it rots — a finding fingerprint or a
// `rev_…` id points at a row the retention sweep deleted weeks ago, so the reader is
// sent to look something up that no longer exists.
//
// Checked here rather than trusted, because it accumulated one comment at a time over
// two days and nobody noticed until 80 of them existed.
describe("comments carry the incident, not who reported it", () => {
  const banned: readonly { readonly what: string; readonly rx: RegExp }[] = [
    { what: "attribution to a review tier", rx: /\b(?:raised|caught|found|reported) by (?:t[0-9]|Kimi|GLM|a reviewer)\b/i },
    { what: "a finding fingerprint nobody can look up", rx: /\((?!D-)[0-9a-f]{8}\)/ },
    { what: "a review id nobody can fetch", rx: /\brev_[A-Za-z0-9_-]{16,}/ },
    { what: "a pointer into MEMO's session numbering", rx: /\bMEMO session [0-9]+/ },
  ];

  it.each(banned)("no comment carries $what", ({ rx }) => {
    const offenders: string[] = [];
    for (const file of sources()) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const s = line.trim();
        // `lore-ok[...]` markers are functional and use brackets, never parentheses.
        if (!(s.startsWith("//") || s.startsWith("*")) || s.includes("lore-ok[")) continue;
        // This file names the patterns it bans, so it would fail against itself.
        if (file.endsWith("one-definition.test.ts")) continue;
        if (rx.test(line)) offenders.push(`${file.slice(SRC.length)}:${String(i + 1)}  ${s.slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      `these reach past the Store into SQL — add a named method instead:\n  ${offenders.join("\n  ")}`,
    ).toStrictEqual([]);
  });
});

describe("make recipes do not comment inside a shell continuation", () => {
  it("has no `@#` on a line continuing the previous one", () => {
    const lines = readFileSync(join(SRC, "..", "deploy", "Makefile"), "utf8").split("\n");
    const offenders = lines
      .map((l, i) => ({ l, i, prev: lines[i - 1] ?? "" }))
      .filter(({ l, prev }) => /^\t\s*@#/.test(l) && prev.trimEnd().endsWith("\\"))
      .map(({ l, i }) => `${i + 1}: ${l.trim()}`);
    expect(
      offenders,
      `these are shell text, not make comments — sh answers "@#: command not found":\n  ${offenders.join("\n  ")}`,
    ).toStrictEqual([]);
  });
});

/**
 * A guard applied from a hand-written list is a guard with a hole in it.
 *
 * `$(wrong-directory)` was added to eight targets by naming them one at a time, and
 * `revoke` was left off — so `make tokens` explained where the deployment runs and
 * `make revoke`, three lines below it, answered with compose's bare "service lore is
 * not running" at the moment an operator is killing a leaked credential. Found by a
 * reviewer, not by re-reading the list.
 *
 * Same shape as the terminal states written out in six places: the second copy of a
 * decision always disagrees eventually. Derived here instead — any target that reaches
 * into the running deployment must carry the guard.
 */
describe("every target that touches the deployment is guarded", () => {
  it("has $(wrong-directory) wherever it runs compose against the container", () => {
    const makefile = readFileSync(join(SRC, "..", "deploy", "Makefile"), "utf8");
    // Split into targets: a line starting at column 0 with `name:` begins one.
    const blocks = makefile.split(/\n(?=[a-z][a-z0-9-]*:)/i);
    const unguarded = blocks
      .filter((b) => /\$\(COMPOSE\) exec/.test(b) && !/\$\(wrong-directory\)/.test(b))
      .map((b) => (/^([a-z][a-z0-9-]*):/i.exec(b)?.[1] ?? "?"));
    expect(
      unguarded,
      `these reach into the running container without checking they are pointed at it:\n  ${unguarded.join("\n  ")}`,
    ).toStrictEqual([]);
  });
});

/**
 * One number, two implementations, in two languages.
 *
 * `make status` has to answer whether the replica is behind while the SERVICE IS
 * DOWN — which is exactly when a dead replicator would otherwise go unnoticed — so it
 * cannot be a call into this process, and the predicate genuinely exists twice. That
 * is the shape this file is about, and the honest response is not to pretend
 * otherwise but to make the copies unable to disagree quietly.
 */
describe("the replica threshold agrees with the shell that reimplements it", () => {
  it("matches deploy/Makefile's replica-state", async () => {
    const { REPLICA_BEHIND_SEC } = await import("../ops/heartbeat.ts");
    const makefile = readFileSync(join(SRC, "..", "deploy", "Makefile"), "utf8");
    const m = /behind"?\s*-gt\s*(\d+)/.exec(makefile);
    expect(m?.[1], "deploy/Makefile no longer compares `behind` against a literal — update this check").toBeDefined();
    expect(Number(m?.[1]), `Makefile says ${m?.[1]}s, heartbeat.ts says ${REPLICA_BEHIND_SEC}s`).toBe(
      REPLICA_BEHIND_SEC,
    );
  });
});
