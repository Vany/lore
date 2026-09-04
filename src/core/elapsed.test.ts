/**
 * The buckets are a contract, not cosmetics: the inbox sentence they land in is what a
 * client uses to tell "somebody is mid-fix" from "nobody is coming back".
 */

import { describe, expect, it } from "vitest";
import { elapsedWords } from "./elapsed.ts";

const AT = Date.parse("2026-09-03T12:00:00.000Z");
const ago = (ms: number) => new Date(AT - ms).toISOString();

describe("elapsedWords", () => {
  it.each([
    [30_000, "under a minute"],
    [60_000, "1 minute"],
    [120_000, "2 minutes"],
    [59 * 60_000, "59 minutes"],
    [60 * 60_000, "1 hour"],
    [3 * 3_600_000, "3 hours"],
    [47 * 3_600_000, "47 hours"],
    [48 * 3_600_000, "2 days"],
    [4 * 86_400_000, "4 days"],
  ])("renders %ims ago as %s", (ms, words) => {
    expect(elapsedWords(ago(ms), AT)).toBe(words);
  });

  // SINGULARS, because "1 minutes" in a sentence a client relays to a person is the
  // kind of sloppiness that makes the rest of the sentence look generated.
  it("does not say 1 minutes or 1 hours", () => {
    expect(elapsedWords(ago(60_000), AT)).not.toContain("minutes");
    expect(elapsedWords(ago(3_600_000), AT)).not.toContain("hours");
  });

  // NEVER A CONFIDENT WRONG ANSWER. Both of these used to be the same silent "0
  // minutes" in the first draft, which would have read as "it just moved" — the exact
  // misreading this whole sentence exists to prevent, produced by the guard itself.
  it("says so rather than inventing a duration it cannot compute", () => {
    expect(elapsedWords("not a date", AT)).toBe("an unknown time");
  });

  it("says so when the record is ahead of the clock", () => {
    const future = new Date(AT + 3_600_000).toISOString();
    expect(elapsedWords(future, AT)).toContain("lore's clock and this record disagree");
  });
});
