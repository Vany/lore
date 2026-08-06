/**
 * Fitting a review to the tier that will read it.
 *
 * `computeDiff` has always truncated at a fixed 600,000 characters and announced it
 * (INV-7) — but that number has no relationship to whoever reads it. A 763 KB branch
 * was cut to 600 KB, which is still ~150k tokens against glm-5-turbo's 200,000-token
 * window, before the system prompt, the knowledge block or a single tool call. The
 * provider answered HTTP 200 with an empty body; the client, told `failed` is often
 * transient, retried five times over two days and then reported that lore's tier was
 * broken. The tier was fine. The truncation was sized to nothing in particular.
 */

import { describe, expect, it } from "vitest";
import { TooLargeForTier } from "../core/errors.ts";
import type { Tier } from "../core/ladder.ts";
import { compactToFit } from "./review.ts";
import type { ReviewerLike, ReviewerResult } from "./opencode.ts";

const TIER: Tier = { id: "t1", kind: "model", model: "vendor/small", stage: "fast" };

/** A reviewer that only knows how big a prompt may be. */
function sized(budget: number | undefined): ReviewerLike {
  return {
    review: (): Promise<ReviewerResult> => {
      throw new Error("not called");
    },
    promptBudgetChars: async () => budget,
  };
}

/** Stands in for `reviewPrompt`: fixed overhead plus the diff. */
const build = (overhead: number) => (diff: string) => `${"P".repeat(overhead)}${diff}`;

describe("compactToFit", () => {
  it("sends the whole diff when it fits", async () => {
    const diff = "D".repeat(1_000);
    const out = await compactToFit(sized(100_000), TIER, diff, build(500));
    expect(out).toContain(diff);
    expect(out).not.toContain("COMPACTED");
  });

  // An unmeasurable tier gets everything, exactly as before this existed. Quietly
  // sending less because a lookup failed would be a silent skip wearing the fix's
  // clothes.
  it("does not compact when the window is unknown", async () => {
    const diff = "D".repeat(500_000);
    const out = await compactToFit(sized(undefined), TIER, diff, build(500));
    expect(out).toContain(diff);
    expect(out).not.toContain("COMPACTED");
  });

  it("shrinks the diff to fit, and never the rest of the prompt", async () => {
    const diff = "D".repeat(500_000);
    const out = await compactToFit(sized(50_000), TIER, diff, build(1_000));
    expect(out.length).toBeLessThanOrEqual(50_000);
    // The fixed part survives whole: cutting the ticket or the ledger would change
    // the question rather than how much code the tier sees.
    expect(out.startsWith("P".repeat(1_000))).toBe(true);
  });

  // A reviewer that does not know it saw a fragment will report clean about code it
  // never read. That is INV-7's whole reason for existing.
  it("tells the reviewer it has not seen the whole change", async () => {
    const out = await compactToFit(sized(50_000), TIER, "D".repeat(500_000), build(1_000));
    expect(out).toContain("COMPACTED FOR THIS TIER");
    expect(out).toContain("YOU HAVE NOT SEEN THE WHOLE CHANGE");
    expect(out).toMatch(/of 500000 characters shown/);
  });

  // COMPACTION FAILING IS AN ERROR, not a skip and not a fragment. If the fixed parts
  // alone overflow the window there is nothing left to cut that would not change the
  // question, and a review that cannot ask the question did not run.
  it("errors when even a compacted prompt cannot fit", async () => {
    const err = await compactToFit(sized(5_000), TIER, "D".repeat(500_000), build(4_900)).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(TooLargeForTier);
    expect(err?.message).toMatch(/cannot hold this review/);
    // It names the fix a reader can act on, rather than a symptom.
    expect(err?.message).toMatch(/smaller range/);
  });

  // The boundary: a diff cut below this is a fragment, and a tier given a fragment
  // produces confident findings about code it mostly did not see.
  it("refuses rather than sending a scrap of diff", async () => {
    // Room for ~1,000 characters of diff after overhead and the notice.
    const err = await compactToFit(sized(10_000), TIER, "D".repeat(500_000), build(8_500)).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(TooLargeForTier);
  });
});
