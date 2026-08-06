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
import { OUTPUT_CONTRACT, proseShare, reviewPrompt } from "./prompts.ts";

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

const promptAt = (
  tierIndex: number,
  modelTierCount = 3,
  type = CODE_ARCH,
  over: Partial<Parameters<typeof reviewPrompt>[0]> = {},
) =>
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
    ...over,
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
  // THE FINDING THAT COST A WHOLE REVIEW. t3 asked the question only the ticket makes
  // possible — does this do what was asked — read the diff's own paragraph saying one
  // half was deliberately not built, cited that paragraph as its evidence, and raised
  // the gap as a `medium` anyway. Nothing changed (the answer could only be a lore-ok),
  // and the reset it triggered ate the last three rounds of the global budget: without
  // it the trace ended `t3 clean → passed` at round 10, with it the review stopped at
  // 13. The question stays; ignoring its own answer does not.
  it("refuses a finding whose evidence is the change disclosing its own gap", () => {
    const p = flat(promptAt(0));
    expect(p).toMatch(/NOT ALREADY SAID/);
    expect(p).toMatch(/must NOT report it/);
    // The question itself must survive, or this trades one failure for a worse one.
    expect(p).toMatch(/UNDISCLOSED gap between the ticket and the code is the most valuable/);
    // And a disclosure that is itself false is still a finding.
    expect(p).toMatch(/If the disclosure itself is wrong/);
  });

  // THE PROMPT WAS LYING. `position()` keyed on the tier alone, so on round 11 of this
  // repository's own review t1 was told "You are the FIRST model to see this change" —
  // having read and cleared that tree four times, with t2 and t3 clean behind it. Told
  // it is first, a model behaves like it is first: it re-audits, and on a tree whose
  // only new material is the author's comments, what it finds is comments. Five such
  // re-reads cost 28 minutes — 37% of the review — and produced nothing.
  it("tells a tier that has looked before that this is not a first look", () => {
    const p = flat(promptAt(0, 3, CODE_ARCH, { round: 11, tierRounds: { t1: 4, t2: 3, t3: 1 } }));
    expect(p).not.toMatch(/FIRST model to see this change/);
    expect(p).toMatch(/READ THIS BRANCH 4 time\(s\) already/);
    expect(p).toMatch(/round 11/);
    expect(p).toMatch(/t2×3, t3×1/);
    // The job on a re-read is the ANSWER, not the tree.
    expect(p).toMatch(/AUTHOR'S ANSWER/);
    expect(p).toMatch(/Do NOT re-audit what you already passed/);
    // But NOT a licence to skim: the fix is unreviewed code, and one of tonight's real
    // findings came from exactly such a re-read.
    expect(p).toMatch(/Is the fix ITSELF sound/);
  });

  it("still tells a tier on its first look that it is first", () => {
    const p = flat(promptAt(0, 3, CODE_ARCH, { round: 1, tierRounds: { t1: 0 } }));
    expect(p).toMatch(/FIRST model to see this change/);
    expect(p).not.toMatch(/READ THIS BRANCH/);
  });

  // A reviewer looking at a diff that is almost entirely prose will find prose. Saying
  // what the diff is made of is not a ban on documentation findings — drift is this
  // repo's most common real defect — it prices them against what actually changed.
  it("says when a diff is mostly prose, and what a finding must then name", () => {
    const proseDiff = [
      "+++ b/spec/thing.md",
      ...Array.from({ length: 40 }, (_, i) => `+a documentation line ${String(i)}`),
      "+++ b/src/a.ts",
      "+const x = 1;",
      "+const y = 2;",
    ].join("\n");
    const p = flat(promptAt(0, 3, CODE_ARCH, { diff: proseDiff }));
    expect(p).toMatch(/WHAT THIS CHANGE IS MADE OF/);
    expect(p).toMatch(/42 added lines, 40 are comments or documentation/);
    expect(p).toMatch(/name a READER and what they would DO wrongly/);
  });

  it("stays silent about composition on a diff that is mostly code", () => {
    const codeDiff = ["+++ b/src/a.ts", ...Array.from({ length: 40 }, (_, i) => `+const v${String(i)} = 1;`)].join("\n");
    expect(flat(promptAt(0, 3, CODE_ARCH, { diff: codeDiff }))).not.toMatch(/WHAT THIS CHANGE IS MADE OF/);
  });

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

describe("proseShare", () => {
  it("counts added lines only, never deletions or context", () => {
    const d = ["+++ b/src/a.ts", "+const a = 1;", "-const b = 2;", " const c = 3;"].join("\n");
    expect(proseShare(d)).toStrictEqual({ added: 1, prose: 0 });
  });

  it("treats every added line in a markdown file as prose", () => {
    const d = ["+++ b/SPEC.md", "+# Heading", "+Some sentence.", "+`code in a fence`"].join("\n");
    expect(proseShare(d)).toStrictEqual({ added: 3, prose: 3 });
  });

  it("recognises comment lines inside code files", () => {
    const d = ["+++ b/src/a.ts", "+// why this exists", "+ * continued", "+const a = 1;"].join("\n");
    expect(proseShare(d)).toStrictEqual({ added: 3, prose: 2 });
  });

  // Markdown is half blank lines. Counting them as code would make every prose diff
  // look mixed, which is exactly the misreading this function exists to prevent.
  it("ignores blank added lines entirely", () => {
    const d = ["+++ b/SPEC.md", "+text", "+", "+more"].join("\n");
    expect(proseShare(d)).toStrictEqual({ added: 2, prose: 2 });
  });

  // `+++ b/...` is itself a line starting with `+`. Counting it would inflate every
  // multi-file diff by one per file, and it is the first thing a naive version gets
  // wrong.
  it("does not count the file header as an added line", () => {
    const d = ["diff --git a/x b/x", "--- a/x", "+++ b/src/a.ts", "+const a = 1;"].join("\n");
    expect(proseShare(d)).toStrictEqual({ added: 1, prose: 0 });
  });
});
