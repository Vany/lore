/**
 * The docs ARE the interface (spec/agent-docs.md §1), so they are checked like code.
 *
 * Everything here exists because validating the MCP surface against the
 * implementation on 2026-08-04 found four kinds of drift, and each was fixed one
 * instance at a time while the review kept handing back the next one:
 *
 *   * every tool was documented with a DOT (`review.poll`) and registered with an
 *     UNDERSCORE (`review_poll`) — an agent following the docs literally calls
 *     nothing, in ten places including the prompt that drives the whole loop;
 *   * `passed_partial` was mishandled in FIVE separate documents — omitted from the
 *     canonical state list, excluded from attestation, and left out of two loops
 *     that therefore never terminate on it. It has never occurred in production,
 *     which is exactly why every document about it was wrong;
 *   * a promised consequence (a rejected justification returning at higher severity)
 *     that nothing in the system caused.
 *
 * A prose defect is not a small defect here. These tests are the mechanical half —
 * they cannot judge whether wording is *good*, only whether it still describes what
 * the code does.
 */

import { describe, expect, it } from "vitest";
import { REVIEW_STATES, isAttestable, isTerminal } from "../core/review-state.ts";
import { RESOURCE_DOCS, REVIEW_PROMPT_TEXT, TOOL_DOCS } from "./docs.ts";

/** Every string a client is ever shown, so no document can be quietly excluded. */
const ALL_DOCS: readonly [string, string][] = [
  ...Object.entries(TOOL_DOCS).map(([k, v]) => [`TOOL_DOCS.${k}`, v] as [string, string]),
  ...Object.entries(RESOURCE_DOCS).map(([k, v]) => [`RESOURCE_DOCS[${k}]`, v.text] as [string, string]),
  ["REVIEW_PROMPT_TEXT", REVIEW_PROMPT_TEXT("b", "i", "t")],
];

describe("the docs name tools that exist", () => {
  // The registered names, which is the only thing a client can call. Kept here
  // rather than imported because buildServer needs a Principal and a Store, and the
  // point is to compare against the literal wire names.
  const TOOLS = [
    "review_start", "review_poll", "review_submit", "review_attest", "review_inbox",
    "review_vex", "knowledge_query", "knowledge_teach", "knowledge_resolve", "knowledge_escalate",
  ];

  it.each(ALL_DOCS)("%s uses no dotted tool name", (_name, text) => {
    // `review.poll` is what SPEC calls it in prose and is not callable. Matching the
    // stem lets a doc say "a review's poll" while catching the tool-shaped form.
    const dotted = text.match(/\b(?:review|knowledge)\.[a-z_]+/g) ?? [];
    expect(dotted).toStrictEqual([]);
  });

  // Parameter names share the prefix and are not tools. Listed rather than pattern-
  // matched, so a genuinely wrong tool name cannot hide behind a loose rule.
  const NOT_TOOLS = ["review_id"];

  it.each(ALL_DOCS)("%s only names tools that are registered", (_name, text) => {
    const named = new Set(text.match(/\b(?:review|knowledge)_[a-z_]+/g) ?? []);
    const unknown = [...named].filter((n) => !TOOLS.includes(n) && !NOT_TOOLS.includes(n));
    expect(unknown).toStrictEqual([]);
  });
});

describe("the docs describe every state the code can produce", () => {
  const states = RESOURCE_DOCS["lore://docs/states"]?.text ?? "";

  // The canonical reference. A state missing from it is a state a client cannot
  // learn about at all — which is how `passed_partial` went undocumented while
  // being both terminal and attestable.
  //
  // Anchored to the start of a line, because the rows in this resource are
  // `name  description`. A bare `toContain` passes on the word appearing ANYWHERE
  // in the blob — I wrote that first, deleted `passed_partial`'s row to check the
  // test bites, and it did not: the name still occurred in the sentence below the
  // table. A test that survives the defect it was written for is worse than none.
  const rows = new Set(
    states.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? "").filter((w) => w.length > 0),
  );
  it.each(REVIEW_STATES.map((s) => [s]))("lists %s as a row of its own", (state) => {
    expect(rows.has(state)).toBe(true);
  });

  // A loop told to wait for `passed` never returns on `passed_partial`, because it
  // is terminal and cannot become `passed`. Both the workflow resource and the
  // prompt said exactly that.
  const loops: readonly [string, string][] = [
    ["lore://docs/workflow", RESOURCE_DOCS["lore://docs/workflow"]?.text ?? ""],
    ["REVIEW_PROMPT_TEXT", REVIEW_PROMPT_TEXT("b", "i", "t")],
  ];
  it.each(loops)("%s does not tell the client to loop until `passed` alone", (_n, text) => {
    const terminalButNotClean = REVIEW_STATES.filter((s) => isTerminal(s) && s !== "passed");
    // If it describes repeating, it must name the other endings.
    if (/[Rr]epeat until|until the state is/.test(text)) {
      for (const s of terminalButNotClean) expect(text).toContain(s);
    }
  });
});

describe("what the docs promise about attestation is what the code allows", () => {
  const attestable = REVIEW_STATES.filter(isAttestable);

  it("is exactly passed and passed_partial", () => {
    expect(attestable).toStrictEqual(["passed", "passed_partial"]);
  });

  // Said in three places, and for a while two of them were wrong in the same way.
  it.each([
    ["TOOL_DOCS.attest", TOOL_DOCS.attest],
    ["lore://docs/states", RESOURCE_DOCS["lore://docs/states"]?.text ?? ""],
    ["REVIEW_PROMPT_TEXT", REVIEW_PROMPT_TEXT("b", "i", "t")],
  ])("%s does not restrict attestation to `passed` alone", (_n, text) => {
    if (/attest/i.test(text)) expect(text).toContain("passed_partial");
  });
});

// The client is an agent, so these strings ARE the interface — a behaviour change
// that does not reach them leaves a client acting confidently on the old contract.
// Each line below is a behaviour that shipped, pinned to the sentence that tells the
// client about it, so removing one fails here rather than in someone's review.
//
// Matched on fragments that do not wrap in the source: a wrapped phrase would make
// this fail for formatting rather than for content.
describe("every behaviour a client must know about reaches the texts", () => {
  it.each([
    ["start", "a branch gets one review, continued", "ONE REVIEW PER BRANCH"],
    ["start", "lore reads its mirror, not your disk", "PUSH YOUR BRANCH FIRST"],
    ["start", "an abandoned review concludes nothing", "FINISH WHAT YOU START"],
    ["start", "the host refreshes the mirror, not you", "You do not have to refresh anything"],
    ["poll", "needs_human carries the question (D-39)", "open_questions"],
    ["poll", "inherited findings are marked (D-68)", "preexisting"],
    ["poll", "a rejected finding is disclosed (D-66)", "a tier produced a finding the schema refused"],
    ["poll", "recurrence never demotes (D-67)", "never changes"],
    ["poll", "failed is often transient", "TRANSIENT"],
    ["submit", "this is how a review continues", "THIS IS HOW A REVIEW CONTINUES"],
    ["query", "empty means not bootstrapped yet (D-35)", "count: 0"],
  ])("%s tells the client: %s", (tool, _why, needle) => {
    expect(TOOL_DOCS[tool as keyof typeof TOOL_DOCS]).toContain(needle);
  });
});
