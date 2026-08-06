/**
 * What we ask a reviewer FOR (D-79).
 *
 * The prompts had no test at all, which is how they drifted into asking for volume:
 * t1 was told "expect obvious defects, report them plainly and cheaply, do not
 * agonise", and the output matched — eleven findings on one commit, all correct and
 * nearly all documentation drift, while one semgrep rule was raised 63 times across
 * this deployment and justified away 63 times.
 *
 * These pin the bar rather than the wording: a prompt that stops asking for
 * consequence, or starts asking for volume again, fails here.
 */

import { describe, expect, it } from "vitest";
import { CODE_ARCH, SECURITY } from "../core/review-type.ts";
import type { Tier } from "../core/ladder.ts";
import { OUTPUT_CONTRACT, reviewPrompt } from "./prompts.ts";

const TIER: Tier = { id: "t1", kind: "model", model: "v/m", stage: "fast" };

/**
 * Collapse whitespace before matching.
 *
 * The prompt is hand-wrapped at ~115 columns, so any phrase long enough to be worth
 * asserting is split across a line break — and a test that fails on where a sentence
 * happens to wrap is a test about formatting, not about what we ask for. Two of these
 * failed that way on the first run.
 */
const flat = (s: string) => s.replace(/\s+/g, " ");

const promptAt = (tierIndex: number, modelTierCount = 3, type = CODE_ARCH) =>
  reviewPrompt({
    tier: TIER,
    tierIndex,
    modelTierCount,
    type,
    worktree: "/wt",
    branch: "feat/x",
    ticket: "do the thing",
    diff: "DIFF",
    t0: "T0",
    knowledge: [],
    settled: [],
  });

describe("the bar for reporting anything", () => {
  // The change D-79 turns on: `failureScenario` was a required field, so a model
  // wrote one for whatever it had already decided to report and a wording nit
  // acquired a plausible consequence on the way out.
  it("makes the failure scenario the test, not a field to fill", () => {
    expect(flat(OUTPUT_CONTRACT)).toMatch(/IS THE TEST, not a field to fill/);
    expect(OUTPUT_CONTRACT).toMatch(/drop it/);
  });

  it.each([0, 1, 2])("states the two tests at tier %i", (i) => {
    const p = promptAt(i);
    expect(p).toMatch(/CONSEQUENCE/);
    expect(p).toMatch(/MISSED/);
    expect(p).toMatch(/concrete inputs or state/);
  });

  // Not "is it subtle". An off-by-one is obvious once pointed at and was still
  // missed — filtering on obviousness would drop most of what a reviewer is good for.
  it("asks whether the AUTHOR would have missed it, not whether it is subtle", () => {
    expect(flat(promptAt(0))).toMatch(/Would the author .* still not have seen it/i);
  });

  // Documents are reviewable (D-11) and drift is real — the same review that produced
  // a pile of wording nits also caught a spec claim that was false because the CODE
  // was wrong. The bar is the same one, not an exemption.
  it("holds prose to the same bar rather than excluding it", () => {
    const p = promptAt(0);
    expect(flat(p)).toMatch(/prose or spec finding clears the same bar/i);
    expect(flat(p)).toMatch(/WHO is misled and INTO DOING WHAT/);
  });

  // The first tier is where "report everything" used to live.
  it("no longer tells the first tier to report cheaply and not agonise", () => {
    expect(promptAt(0)).not.toMatch(/do not agonise/i);
    expect(promptAt(0)).not.toMatch(/report them plainly and cheaply/i);
  });
});

describe("the finding is addressed to the author", () => {
  it("frames each finding as a question with two real answers", () => {
    const p = flat(promptAt(1));
    expect(p).toMatch(/fix it or tell me why it is not a problem/i);
    expect(p).toMatch(/They may be right and you may be wrong/i);
  });

  it("asks for what was found, not for instructions", () => {
    expect(flat(OUTPUT_CONTRACT)).toMatch(/what you would say to the author's face/i);
  });
});

describe("what the ladder still guarantees", () => {
  // A tier's position is information (D-31) and reporting less must not blur it.
  it("still tells the last tier it is the last", () => {
    expect(promptAt(2)).toMatch(/LAST line/);
  });

  it("still tells the first tier it is first", () => {
    expect(promptAt(0)).toMatch(/FIRST model/);
  });

  // Clean must stay an easy answer to give, or the bar just moves the noise.
  it("keeps an empty result a welcome answer", () => {
    expect(flat(OUTPUT_CONTRACT)).toMatch(/means clean.*welcome/i);
    expect(promptAt(0)).toMatch(/Say plainly if it is clean/);
  });

  // The security type's contribution is reachability, not detection (Phase 5).
  it("keeps the security type asking for reachability", () => {
    expect(promptAt(0, 3, SECURITY)).toMatch(/REACHABILITY, not detection/);
  });
});
