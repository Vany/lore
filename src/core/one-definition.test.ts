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
// SQL LIVES IN THE STORE, and this is the only thing that can keep it there.
//
// Measured before writing this: seven raw `.db.prepare` calls had grown across five
// production files, each one a small missing Store method. Two of them were `SELECT *`
// building `lore://review/{id}` — so the client-facing shape of that resource was a
// function of the schema, and every column a future migration adds would have shipped
// to every client silently, without anyone deciding to publish it.
//
// TESTS ARE DELIBERATELY FREE. A test asserting that a row exists is asking about the
// database on purpose, and forcing those through an API would mean inventing methods
// that only tests call — which `one-definition.test.ts` already fails you for. The
// invariant is about PRODUCTION code, and that is what this checks.
// THE NAME SAYS WHAT IT CHECKS, and the first one did not. It read "no production file
// reaches past the store into SQL" / "has every query behind a named Store method" while
// passing green over twenty-eight raw sites in fourteen files — a suite announcing an
// invariant it deliberately does not hold, which is `PROG.md`'s own rule about test
// names turned on the file that enforces the rules. The property below is the one that
// is true today; the property in the old name is `TODO.md`'s.
describe("SQL past the store only ever shrinks (a ratchet, not a clean bill)", () => {
  it("admits no new file and no new site in an old one", () => {
    const offenders: string[] = [];
    const perFile = new Map<string, number>();
    for (const file of sources()) {
      if (file.endsWith(".test.ts") || file.endsWith("store/store.ts")) continue;
      const src = readFileSync(file, "utf8");
      // MATCHED ON `.db` ITSELF, not on `.db.prepare`. The first version looked for the
      // pair on ONE LINE, and `store.db\n  .prepare(` — what the formatter produces for
      // anything but the shortest query — walked straight past it. That check was
      // written, and its invariant claimed, one file away from a query it could not
      // see: it reported seven sites where a correct count found twenty-eight.
      //
      // A RATCHET, not a clean bill of health, and deliberately so. The debt below is a
      // real conversion and not one to rush into code that has no ladder verdict — but a
      // check that permitted what it means to forbid would be decoration, and a number
      // nobody can see would rot. So the invariant this can honestly enforce today is:
      // NO NEW FILE and NO NEW SITE, and both may only shrink. `TODO.md` carries it to zero.
      //
      // THE SIZE OF THE DEBT IS THE LIST, and is not restated in prose here. This comment
      // said "fifteen files" over a fourteen-entry list — the same number was corrected in
      // `TODO.md` and missed three lines above the thing that disproves it, in the one
      // file this codebase tasks with keeping its own statements true.
      for (const line of src.split("\n")) {
        if (/(?<![A-Za-z0-9_])(?:store|this|i\.store|deps\.store)\.db\b/.test(line)) {
          const rel = file.slice(SRC.length).replace(/^\//, "");
          offenders.push(rel);
          perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
        }
      }
    }
    // Every file below predates the rule. Adding one here is the thing to argue about;
    // removing one needs no permission.
    //
    // COUNTED, not merely listed, and the file-level version was a hole big enough to
    // drive the whole invariant through: `mcp/server.ts` is already on the list, so a
    // thirtieth `store.db.prepare` added to it kept the suite green. A ratchet that only
    // notices new FILES ratchets nothing in the files where the debt actually lives.
    //
    // These numbers came from the regex above rather than by hand; the hand-written
    // first draft was wrong in four files and the check caught itself. They are not
    // totalled anywhere in prose, HERE INCLUDED: a total is the one form the ratchet
    // cannot keep honest, because converting a site — the change this exists to invite
    // — shrinks a count and trips neither assertion, leaving a false figure sitting
    // beside the enforced list with nothing to say which is stale.
    const KNOWN: Readonly<Record<string, number>> = {
      "knowledge/derive.ts": 2, "knowledge/enrich.ts": 2, "mcp/auth.ts": 5, "mcp/server.ts": 1,
      "ops/retention.ts": 2, "ops/spend.ts": 1, "propose/cli.ts": 1, "propose/run.ts": 1,
      "reviewer/review.ts": 2, "security/vex.ts": 1, "service/attest.ts": 3, "service/http.ts": 2,
      "service/main.ts": 2, "service/worker.ts": 3,
    };
    const newcomers = [...new Set(offenders)].filter((f) => !(f in KNOWN)).sort();
    expect(newcomers).toStrictEqual([]);
    // And it only shrinks — in both directions. A file that stops reaching through must
    // leave the list; one that reaches through MORE than it did must be argued for.
    const stale = Object.keys(KNOWN).filter((f) => !perFile.has(f));
    expect(stale).toStrictEqual([]);
    const grown = Object.entries(KNOWN)
      .filter(([f, n]) => (perFile.get(f) ?? 0) > n)
      .map(([f, n]) => `${f}: ${String(n)} -> ${String(perFile.get(f) ?? 0)}`);
    expect(grown).toStrictEqual([]);
  });
});

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
    expect(offenders).toStrictEqual([]);
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
