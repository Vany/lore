/**
 * `applyPatch` — the path every client fix travels, and it had no test.
 *
 * Both cases here come from driving a real review as a client on 2026-08-06. An agent
 * that cannot submit cannot continue a review, so the loop simply stops, and the
 * message it stops on is the entire diagnosis available to a party on another machine
 * with no shell here.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch } from "./repo.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-apply-"));
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
  // The trailing whitespace-only line is the point of the fixture, not an accident.
  writeFileSync(join(dir, "f.txt"), "a\nb\nc\n \n");
  g("add", "-A");
  g("commit", "-qm", "x");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A well-formed diff whose last line is a whitespace-only context line.
 *
 * `"  "` is two characters and both are load-bearing: the first is the diff's context
 * marker, the second is the file's actual content — the line really is one space. I
 * wrote it with one space the first time and the patch legitimately did not apply,
 * which is the same confusion the bug this fixture is about arises from.
 */
const WELL_FORMED = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,4 +1,5 @@", " a", "+X", " b", " c", "  ", ""].join("\n");

/**
 * The same diff after transit ate the trailing blank.
 *
 * An agent composes the diff as a tool-call argument and the final whitespace-only
 * line is stripped somewhere on the way, leaving the hunk one line shorter than its
 * `@@` header claims.
 */
const DAMAGED = WELL_FORMED.replace(/ {2}\n$/, "");

describe("applyPatch", () => {
  it("applies a well-formed diff", async () => {
    await applyPatch(dir, WELL_FORMED);
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("a\nX\nb\nc\n \n");
  });

  // Plain `git apply` rejects this as `corrupt patch at line 66` — a line number in a
  // string the client composed in memory and cannot open. Verified before fixing:
  // without --recount this throws, with it the diff applies correctly.
  it("survives a diff whose trailing whitespace line was lost in transit", async () => {
    await applyPatch(dir, DAMAGED);
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toContain("X");
  });

  // Leniency about hunk arithmetic is safe ONLY because the tree hash is checked
  // afterwards (D-40). This pins that the recount does not invent content.
  it("produces exactly the tree the well-formed diff would have", async () => {
    const other = mkdtempSync(join(tmpdir(), "lore-apply2-"));
    try {
      execFileSync("cp", ["-R", `${dir}/.`, other]);
      await applyPatch(dir, DAMAGED);
      await applyPatch(other, WELL_FORMED);
      const tree = (d: string) =>
        execFileSync("git", ["-c", "core.autocrlf=false", "diff"], { cwd: d, encoding: "utf8" });
      expect(tree(dir)).toBe(tree(other));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("what a failed apply tells the client", () => {
  // "corrupt patch at line 66" points into the client's own payload. The message has
  // to name the FAULT, because the reader cannot look at the location.
  it("names the malformation rather than a line number, for an unreadable diff", async () => {
    const garbage = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,9 +1,9 @@", " a", "+X", ""].join("\n");
    const err = await applyPatch(dir, garbage).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/line count does not match|does not apply/i);
    expect(err?.message).toMatch(/trailing whitespace|different base/i);
  });

  // Whatever the fault, the client must know whether to resend everything or the
  // remainder. A half-applied tree is the state this path exists to refuse.
  it("always says nothing was applied", async () => {
    const wrongBase = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,2 +1,2 @@", "-zzz", "+yyy", ""].join("\n");
    const err = await applyPatch(dir, wrongBase).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/Nothing was applied/);
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("a\nb\nc\n \n");
  });
});
