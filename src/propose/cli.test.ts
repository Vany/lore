/**
 * The two pieces of `propose/cli.ts` cheap enough to test alone, without the full
 * `proposeCli` flow (a real store, worktree and reviewer). `proposeCli` itself has no
 * test file — a pre-existing gap, not closed here (see run.test.ts's own header for
 * the same call made about `run.ts`'s money-spending flow).
 *
 * SPEC: spec/propose.md §1
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../core/errors.ts";
import { freePath, parseLenses } from "./cli.ts";

describe("parseLenses", () => {
  it("returns every lens when nothing was asked for", () => {
    expect(parseLenses(undefined)).toStrictEqual(["data", "failure", "seams", "greenfield"]);
  });

  it("refuses an unknown name rather than ignoring it", () => {
    expect(() => parseLenses("seams,vibes")).toThrow(UsageError);
  });

  /**
   * Fingerprint 268bd330: `--lens seams,seams` ran the identical prompt twice, paying
   * for a proposer and a critic on one vantage — an equally-wrong sibling of the
   * unknown-name case just above, which this function already refuses.
   */
  it("deduplicates a repeated name rather than running it twice", () => {
    expect(parseLenses("seams,data,seams")).toStrictEqual(["seams", "data"]);
  });
});

describe("freePath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lore-propose-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the plain name when nothing occupies it", async () => {
    expect(await freePath(dir, "2026-08-26-abc1234-src-store")).toBe(join(dir, "2026-08-26-abc1234-src-store.md"));
  });

  /**
   * Fingerprint 41c8217a: the document's name is date+sha+folder only, so two runs
   * sharing all three — different `--mode`, a different `--lens` subset, or just a
   * second look — collided on one path and the second `writeFile` silently destroyed
   * the first run's paid-for document.
   */
  it("never returns a path that already exists", async () => {
    const base = "2026-08-26-abc1234-src-store";
    await writeFile(join(dir, `${base}.md`), "first run", "utf8");
    const second = await freePath(dir, base);
    expect(second).toBe(join(dir, `${base}-2.md`));

    await writeFile(second, "second run", "utf8");
    const third = await freePath(dir, base);
    expect(third).toBe(join(dir, `${base}-3.md`));
  });
});
