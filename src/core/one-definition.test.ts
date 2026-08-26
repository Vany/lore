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

import { spawnSync } from "node:child_process";
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

/**
 * A file that is ONE template literal may not contain a stray backtick.
 *
 * `board-page.ts` is the whole operator page in a single template string, and a backtick
 * inside a comment in it ENDS that string. The compiler then reports the wreckage thirty
 * lines later as a missing comma, which names neither the file's real problem nor the
 * habit that caused it. I did it three times in one afternoon quoting identifiers the
 * ordinary way, and a note in the file saying "no backticks here" did not stop the third.
 *
 * So: exactly two, the ones that open and close the page. This runs even when the file no
 * longer parses, because it reads the source as TEXT — which is the whole point, since a
 * test that imports a broken file cannot report on it.
 */
describe("a page held in a template literal has no stray backtick", () => {
  it("has exactly the two that delimit it", () => {
    const page = FILES.find((f) => f.path === "service/board-page.ts");
    expect(page, "board-page.ts is not where this test thinks it is").toBeDefined();
    const ticks = (page?.text.match(/`/g) ?? []).length;
    expect(
      ticks,
      "a backtick inside board-page.ts ends the page string; the compiler reports it far " +
        "from the cause, as a missing comma. Quote identifiers without backticks in this file.",
    ).toBe(2);
  });
});

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
      `these comments carry bookkeeping that will rot — keep the incident, drop the pointer:\n  ${offenders.join("\n  ")}`,
    ).toStrictEqual([]);
  });
});

/**
 * SQL LIVES IN THE STORE. Asserted, because I claimed it was and it was not.
 *
 * Twenty-eight sites outside `store/` were moved behind named methods, and the commit
 * message, `MEMO.md` and `TODO.md` all recorded that "the ratchet became a real
 * invariant — an assertion of an empty list rather than a shrinking one". No such
 * assertion was ever written. What survived was the ratchet's FAILURE MESSAGE, pasted
 * onto the comment-attribution guard above, where it read as nonsense about SQL while
 * scanning for `raised by t3`.
 *
 * That is the worst defect this file exists to catch, committed in this file: a guard
 * everybody believes in, holding nothing. The work was real and nothing was protecting
 * it, so the next hand-written query would have walked straight back in — which is
 * exactly how the twenty-eight accumulated.
 *
 * Why it matters beyond tidiness: a query written at the call site is one the Store
 * cannot maintain. `review.token_hash` was added one join away from the resource clients
 * read, and the client-facing shape of `lore://review/{id}` stayed a function of the
 * schema because the join lived somewhere nobody looked.
 *
 * `ops/status.ts` is the one exemption and it is a real one, not a grandfathering: it
 * opens its own READ-ONLY connection and must answer while the service is down, which is
 * the only time anyone runs it. It never imports the Store at all.
 */
describe("SQL lives in the Store", () => {
  // A query through a Store's handle — `store.db.prepare`, `this.db.prepare` — which is
  // the shape the twenty-eight took. Not `new DatabaseSync`, which is a separate
  // connection and is what `status.ts` legitimately does.
  // `\s*` between the two, because a formatter breaks a long chain across lines and
  // `store.db\n  .prepare(` is EXACTLY the shape the deleted ratchet's own comment named
  // as what defeated its first version. Writing the replacement with the same hole, in
  // the change that restored it, is the failure this file is about — twice over.
  const THROUGH_THE_STORE = /\b(?:store|this|deps\.store|s)\.db\s*\.\s*(?:prepare|exec)\b/;
  const EXEMPT = new Set(["ops/status.ts"]);

  it("is never written through a Store handle outside store/", () => {
    const offenders = FILES.filter(
      (f) => !f.path.startsWith("store/") && !EXEMPT.has(f.path) && THROUGH_THE_STORE.test(f.text),
    ).map((f) => f.path);
    expect(
      offenders,
      `these reach past the Store into SQL — add a named method instead:\n  ${offenders.join("\n  ")}`,
    ).toStrictEqual([]);
  });

  // AN EMPTY LIST, NOT A SHRINKING ONE — which is the sentence that was written down
  // about a test that did not exist. A budget that can be raised is a budget that gets
  // raised; this one cannot be satisfied by adding a line to a number.
  it("has no exemption that is merely historical", () => {
    for (const path of EXEMPT) {
      const f = FILES.find((x) => x.path === path);
      expect(f, `${path} is exempt and does not exist — delete the exemption`).toBeDefined();
      expect(
        f?.text.includes("new DatabaseSync"),
        `${path} is exempt because it opens its OWN read-only connection; if it stopped doing that, ` +
          "the exemption is no longer the thing it was granted for",
      ).toBe(true);
      expect(
        /from "\.\.\/store\/store\.ts"/.test(f?.text ?? ""),
        `${path} imports the Store — then it should use it rather than being exempt`,
      ).toBe(false);
    }
  });
});

/**
 * GIT RUNS THROUGH `git/exec.ts`, and nowhere else. The sibling of the rule above, and
 * absent for exactly as long, which is why it was broken.
 *
 * `service/repin.ts` built its own `promisify(execFile)` and called git with `{ cwd }`
 * and nothing else. What it opted out of was not style:
 *
 *   * **`GIT_CEILING_DIRECTORIES`** (D-61). Git walks UP from `cwd` looking for a
 *     repository, so a missing or empty `bare.git` makes `rev-parse` answer from whatever
 *     ENCLOSES it. That is not hypothetical — it is the recorded incident that put the
 *     ceiling there, where `fetch --prune` ran against the operator's own checkout. In
 *     `repin.ts` the wrong answer decides whether to DESTROY a worktree holding fixes a
 *     client submitted and never committed (D-40): they exist nowhere else.
 *   * **a timeout**, so a git blocked on a lock held the review for ever.
 *   * **`maxBuffer`**, harmless for `rev-parse` and not harmless in general.
 *
 * `propose/cli.ts` had the same runner for the same reason: nothing said not to.
 *
 * The check is on the IMPORT, not on a call shape, because the fault is having a second
 * way to run git at all — every option above is one somebody has to remember, and the
 * whole value of `git/exec.ts` is that nobody has to.
 */
describe("git runs through one runner", () => {
  // `git/exec.ts` IS the runner and `git/repo.ts` and `git/diff.ts` reach for `execFile`
  // deliberately, each with the full option set spelled out, because they need the child
  // handle or a stream rather than a buffered result. Named individually: an exemption
  // that is a directory prefix grows quietly.
  const MAY_SPAWN = new Set(["git/exec.ts", "git/repo.ts", "git/diff.ts", "t0/exec.ts"]);

  // EITHER IMPORT FORM. This matched `from "node:child_process"` only — and this codebase
  // already spawns through `await import("node:child_process")` in two of the four exempt
  // files, so the dynamic form was an equally easy second way that the guard could not
  // see. `repin.ts`, the incident this was written for, happened to use the static form;
  // a ratchet that holds only the door the last defect came through is not a ratchet.
  it("has no second way to spawn a process", () => {
    const offenders = FILES.filter(
      (f) => !MAY_SPAWN.has(f.path) && /node:child_process/.test(f.text),
    ).map((f) => f.path);
    expect(
      offenders,
      "these spawn processes directly and so miss GIT_CEILING_DIRECTORIES, the timeout and maxBuffer that " +
        `every other call gets — import { git } from git/exec.ts instead:\n  ${offenders.join("\n  ")}`,
    ).toStrictEqual([]);
  });

  // The exemption is granted for spelling the options out. If one stops doing that, it is
  // no longer the thing the exemption was granted for — which is how `repin.ts` came to
  // look like a legitimate second runner in the first place.
  it("has no exemption that stopped setting the options it was exempted for", () => {
    for (const path of MAY_SPAWN) {
      const f = FILES.find((x) => x.path === path);
      expect(f, `${path} is exempt and does not exist — delete the exemption`).toBeDefined();
      // ANCHORED TO THE OPTION, NOT THE WORD. `/maxBuffer/` matched the prose in these
      // files' own comments, so an edit could delete the option, keep the comment
      // explaining it, and leave this green — a guard whose failure mode is agreeing
      // with a file that stopped doing the thing. That is the same shape as the ratchet
      // that held nothing, twenty lines up in this file's own history.
      expect(
        /maxBuffer\s*:/.test(f?.text ?? ""),
        `${path} spawns directly and no longer PASSES maxBuffer (a comment mentioning it is not enough); ` +
          "either set it or use git/exec.ts",
      ).toBe(true);
      // `t0/exec.ts` runs the target repo's own tooling, not git, so a git ceiling would
      // mean nothing there — it carries its own env hygiene instead. Every git-running
      // exemption must carry the ceiling.
      if (path !== "t0/exec.ts") {
        expect(
          /GIT_CEILING_DIRECTORIES\s*:/.test(f?.text ?? ""),
          `${path} names GIT_CEILING_DIRECTORIES but no longer SETS it — D-61 says git will climb out of cwd`,
        ).toBe(true);
      }
    }
  });
});

/**
 * A NUL byte makes a source file invisible to every text tool at once.
 *
 * `enrich.ts` carried one inside a string literal — `k.path ?? "\0"` where a space was
 * meant — and the two behave identically, so nothing failed. What broke was every
 * SEARCH: `grep` classifies the file as binary and reports nothing, silently, so
 * `relevantTo` could not be found by name and a doc comment claiming policies were
 * filtered sat above code that did not filter them for as long as nobody executed it.
 *
 * That is worse than a bug, because this repository enforces several of its invariants
 * by grepping its own sources — including the tests in this file. A file that greps as
 * empty passes every one of them.
 */
describe("sources are text", () => {
  it("has no NUL byte in any source file", () => {
    const offenders = sources().filter((f) => readFileSync(f).includes(0)).map((f) => f.slice(SRC.length));
    expect(
      offenders,
      `grep reports NOTHING for these files, including the checks in this suite:\n  ${offenders.join("\n  ")}`,
    ).toStrictEqual([]);
  });
});

/**
 * Where the database is, decided ONCE.
 *
 * `LORE_DATA_DIR` and `LORE_DB_DIR` were read in five places with two different
 * fallbacks — the service defaulted to `/var/lib/lore` and the CLI to `~/.lore`, and the
 * container always sets the variable, which is precisely what kept them from disagreeing
 * anywhere anybody looked.
 *
 * Then the database moved out of the data directory on 2026-08-08 and only three of the
 * readers were updated. `make status` died with `unable to open database file` beside a
 * perfectly healthy service, having looked in a directory that no longer holds one.
 *
 * Same shape as the terminal states written out six times: the second copy of a decision
 * always disagrees eventually, and the disagreement surfaces at the worst moment.
 */
describe("the state directories have one definition", () => {
  it("is read from the environment only in core/paths.ts", () => {
    const offenders = FILES.filter(
      (f) => f.path !== "core/paths.ts" && /process\.env\[.(?:LORE_DATA_DIR|LORE_DB_DIR).\]/.test(f.text),
    ).map((f) => f.path);
    expect(
      offenders,
      `read LORE_DATA_DIR / LORE_DB_DIR directly — call dataDir(), dbDir() or dbPath():\n  ${offenders.join("\n  ")}`,
    ).toStrictEqual([]);
  });

  /**
   * The database is `<dbDir>/lore.db`, and every reader must get it from the same place.
   * A hand-built path is how one of them came to look under the data directory.
   *
   * CODE ONLY. The first version matched the filename anywhere and flagged three files
   * that merely discuss it in prose — a guard that fires on comments is one somebody
   * silences. It looks for the two ways the path is actually constructed: a `join` whose
   * last argument is the filename, and a template or string ending `/lore.db`.
   */
  const BUILT_BY_HAND = /join\([^)]*["'`]lore\.db["'`]\)|[/}]lore\.db["'`]/;

  it("never builds the database path by hand", () => {
    const offenders = FILES.filter((f) => f.path !== "core/paths.ts" && BUILT_BY_HAND.test(f.text)).map((f) => f.path);
    expect(
      offenders,
      `construct the database path themselves — call dbPath():\n  ${offenders.join("\n  ")}`,
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
/**
 * ...AND SO DOES THE WRITE CLOCK, which is the other half of the same duplication.
 *
 * `lastWriteAt` and `deploy/Makefile`'s `replica-state` answer the same question in two
 * languages, for the reason the threshold does: `make status` must work while the service
 * is DOWN. Extending the TypeScript side from five columns to fifteen left the shell at
 * five, so the monitor a person runs and the monitor that pages disagreed about what
 * counts as a write — and the shell one, the one used in an incident, was the blind one.
 *
 * IT COMPARES THE COLUMN LIST AND NOTHING ELSE, which is worth saying because the two
 * halves drifted again immediately in a way this cannot see: on a database that exists
 * and has never been written to, `lastWriteAt` answers `undefined` and the heartbeat says
 * `level`, while the shell printed a red "no database in the volume". Same question,
 * opposite answers, identical column lists. A reader who assumes this guard covers
 * "the two agree" rather than "the two name the same columns" is the next person to be
 * surprised by it.
 */
describe("the write clock agrees with the shell that reimplements it", () => {
  it("names the same timestamp columns on both sides", async () => {
    const store = readFileSync(join(SRC, "store", "store.ts"), "utf8");
    const makefile = readFileSync(join(SRC, "..", "deploy", "Makefile"), "utf8");
    // Bounded by the surrounding CODE, not by brackets: the union's own `MAX(col)`
    // parentheses close before the subquery's does, so any attempt to match the group
    // stops one column in — which is how the first version of this check found nothing
    // and said the store had no union at all.
    const between = (text: string, from: string, to: string): string => {
      const i = text.indexOf(from);
      if (i === -1) return "";
      const j = text.indexOf(to, i);
      return j === -1 ? text.slice(i) : text.slice(i, j);
    };
    const columns = (region: string): string[] =>
      [...region.matchAll(/MAX\((\w+)\)\s+(?:t\s+)?FROM\s+(\w+)/g)]
        .map((m) => `${m[2] ?? ""}.${m[1] ?? ""}`)
        .sort();
    const inStore = columns(between(store, "lastWriteAt(", "return row?.t"));
    expect(inStore.length, "did not find lastWriteAt's union — update this check").toBeGreaterThan(5);
    expect(
      columns(between(makefile, "replica-state:", "\nrept=")),
      "deploy/Makefile's replica-state is blind to writes lastWriteAt counts",
    ).toStrictEqual(inStore);
  });
});

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

/**
 * 2146b6dd, found by lore's own review: README.md's quick start and `deploy/
 * Makefile`'s own preflight both say `cp .env.example .env` / "copy .env.example",
 * but `.gitignore`'s `.env.*` pattern matched the template too — so the file had
 * never once been committed, and `git add -A` (the review loop's own submission
 * step, among others) silently dropped it every time. A reference two files agree
 * on, pointing at something neither could actually produce.
 */
describe("the template README.md and deploy/Makefile both point at is real", () => {
  const root = join(SRC, "..");

  it("names .env.example somewhere neither can act on if it vanishes", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const makefile = readFileSync(join(root, "deploy", "Makefile"), "utf8");
    expect(readme, "update this check if the quick start stops naming the template").toContain(".env.example");
    expect(makefile, "update this check if preflight stops naming the template").toContain(".env.example");
  });

  it("is not swallowed by .gitignore's own .env.* pattern", () => {
    const ignored = spawnSync("git", ["check-ignore", "-q", "deploy/.env.example"], { cwd: root });
    expect(ignored.status, "deploy/.env.example must not be gitignored — that is what 2146b6dd was").toBe(1);
  });

  it("is actually tracked, not merely unignored", () => {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "deploy/.env.example"], { cwd: root });
    expect(tracked.status, "unignored but never `git add`-ed is the same failure from the other side").toBe(0);
  });
});

/**
 * 15be66bd/1be9520f, found by lore's own review: the template's own first-drafted
 * LORE_TIERS named `/opt/lore/deploy/tiers.zai-openai.json`, a path that exists
 * nowhere in the image (Dockerfile: WORKDIR /app, COPY deploy/tiers.*.json
 * ./deploy/) — loadTiers() throws ENOENT reading it, unhandled, at boot. Checked
 * mechanically rather than trusted by inspection a second time: strip the
 * container's own WORKDIR prefix and confirm the named file is one this repository
 * actually ships.
 */
describe("the template's LORE_TIERS names a file the image actually has", () => {
  it("resolves to a real file under deploy/", () => {
    const root = join(SRC, "..");
    const env = readFileSync(join(root, "deploy", ".env.example"), "utf8");
    const m = /^LORE_TIERS=(\S+)/m.exec(env);
    expect(m?.[1], "update this check if the template stops setting LORE_TIERS by default").toBeDefined();
    const path = m?.[1] ?? "";
    expect(path, "must be the container's own WORKDIR, not a host path nothing mounts").toMatch(/^\/app\/deploy\//);
    const named = path.replace(/^\/app\/deploy\//, "");
    expect(
      statSync(join(root, "deploy", named), { throwIfNoEntry: false })?.isFile(),
      `deploy/${named} does not exist — LORE_TIERS names a file this repository does not ship`,
    ).toBe(true);
  });
});

/**
 * 366453ed, generalised: that finding was one missing variable (ZAI2_API_KEY,
 * which docker-compose.yml reads and the recommended ladder's own `helper` and
 * fallback routes depend on) found by inspection. `history` on these findings
 * names the actual pattern — "a defect that recurs is a missing rule" — so this
 * checks the CLASS: every variable docker-compose.yml interpolates from the
 * environment must have a row in the one file an operator is told to copy and
 * fill in, or the two silently disagree about what a deployment needs.
 */
describe("every variable docker-compose.yml reads has a row in the template", () => {
  it("names them all, except the ones nothing sets by hand", () => {
    const root = join(SRC, "..");
    const compose = readFileSync(join(root, "deploy", "docker-compose.yml"), "utf8");
    const env = readFileSync(join(root, "deploy", ".env.example"), "utf8");

    // BUILD-TIME OR HOST-SPECIFIC, never a `.env` row: `LORE_COMMIT`/`LORE_BUILT_AT`
    // come from `deploy/Makefile`'s own STAMP at `make build`, and `LORE_DOCKER_GID`
    // is a Linux-only override with its exact derivation already inline in
    // docker-compose.yml, beside the "permission denied" message that is how an
    // operator who needs it finds it.
    const computed = new Set(["LORE_COMMIT", "LORE_BUILT_AT", "LORE_DOCKER_GID"]);

    const referenced = [...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)[^}]*\}/g)]
      .map((m) => m[1] ?? "")
      .filter((v) => !computed.has(v));
    expect(referenced.length, "update this check if docker-compose.yml stops using ${VAR} interpolation").toBeGreaterThan(5);

    const missing = [...new Set(referenced)].filter((v) => !new RegExp(`^${v}=`, "m").test(env));
    expect(missing, "docker-compose.yml reads these, but .env.example never mentions them").toStrictEqual([]);
  });
});

/**
 * 56ff8c04, found by lore's own review: the template became a real, tracked
 * deployment artifact (fingerprint 2146b6dd) but was never added to `deploy/Makefile`'s
 * `DEPLOY_FILES`, so `make push` never copied it to a remote host and
 * `check-deployed` never noticed — the drift guard's own header comment names
 * exactly this failure shape ("a guard and its remedy disagreeing about scope").
 */
describe("the deploy-file drift guard covers the template it gained", () => {
  it("lists .env.example in DEPLOY_FILES", () => {
    const makefile = readFileSync(join(SRC, "..", "deploy", "Makefile"), "utf8");
    const m = /^DEPLOY_FILES\s*=\s*([\s\S]*?)^\S/m.exec(`${makefile}\n\x00`);
    expect(m?.[1], "update this check if DEPLOY_FILES is no longer assigned this way").toBeDefined();
    expect(m?.[1] ?? "", "the template must be part of what make push/check-deployed compare").toMatch(
      /(?:^|\s)\.env\.example(?:\s|\\)/,
    );
  });
});

/**
 * A DOCBLOCK BELONGS TO WHAT COMES AFTER IT, and two in a row means one is orphaned.
 *
 * Inserting a method just under an existing docblock silently rededicates that block to
 * the new method and leaves the old one describing nothing. It reads fine in a diff — the
 * new code has a comment above it, the old comment is still there — which is why I did it
 * THREE TIMES in one afternoon, twice in the same change. Once the displaced block said
 * *"a fresh session per tier run"* directly above the method that had just stopped doing
 * that: a comment stating the opposite of the code it appears to describe, which is the
 * worst failure this repository has, in the place a reader goes to learn the behaviour.
 *
 * **A BASELINE, NOT A CLEAN BILL.** The check found 24 of these already here across ten
 * files, all genuine. They are not fixed in the change that added this test: each needs a
 * judgement about which declaration the stranded block was written for, and two dozen of
 * those would swamp the diff a reviewer was already reading. So this asserts NO GROWTH per
 * file, and `TODO.md` carries the cleanup. A number that may only go down is worth having
 * even while it is not yet zero — the alternative is a fourth occurrence.
 *
 * The FILE-LEVEL block is exempt: a module docblock followed by the first declaration's
 * docblock is the normal shape, not an orphan.
 */
const ORPHAN_BASELINE: Readonly<Record<string, number>> = {
  "core/cooloff.ts": 1,
  "core/errors.ts": 1,
  "git/diff.ts": 1,
  "git/repo.ts": 1,
  "mcp/server.ts": 1,
  "reviewer/opencode.ts": 3,
  "reviewer/review.ts": 5,
  "store/store.ts": 10,
  "t0/sandbox.ts": 1,
};

function orphanedDocblocks(text: string): number {
  const lines = text.split("\n");
  // Where the file-level block ends, if the file opens with one.
  let lead = -1;
  let k = 0;
  while (k < lines.length && (lines[k] ?? "").trim() === "") k++;
  if ((lines[k] ?? "").trim().startsWith("/**")) {
    for (let m = k; m < lines.length; m++) {
      if (/^\s*\*\/\s*$/.test(lines[m] ?? "")) {
        lead = m;
        break;
      }
    }
  }

  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i === lead || !/^\s*\*\/\s*$/.test(lines[i] ?? "")) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
    if (/^\s*\/\*\*/.test(lines[j] ?? "")) found++;
  }
  return found;
}

describe("no docblock is orphaned by the next one", () => {
  for (const f of FILES) {
    const allowed = ORPHAN_BASELINE[f.path] ?? 0;
    it(`${f.path} has no more than ${String(allowed)}`, () => {
      expect(
        orphanedDocblocks(f.text),
        `${f.path}: a docblock ends and another begins with no code between them, so the ` +
          "first now describes the second one's subject and whatever it was written about " +
          "has no comment left. Move the new member above the block it displaced. " +
          "(This file's baseline may go down, never up.)",
      ).toBeLessThanOrEqual(allowed);
    });
  }

  // The baseline may only shrink, and a file that leaves it must leave this list too —
  // otherwise a stale allowance quietly re-permits the thing it was recording.
  it("has no entry for a file that no longer needs one", () => {
    const stale = Object.keys(ORPHAN_BASELINE).filter((path) => {
      const f = FILES.find((x) => x.path === path);
      return f === undefined || orphanedDocblocks(f.text) === 0;
    });
    expect(stale, "these are clean now; delete their baseline entries").toStrictEqual([]);
  });
});
