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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REVIEW_STATES, isAttestable, isTerminal } from "../core/review-state.ts";
import { RESOURCE_DOCS, REVIEW_PROMPT_TEXT, TOOL_DOCS } from "./docs.ts";

/** Every string a client is ever shown, so no document can be quietly excluded. */
const ALL_DOCS: readonly [string, string][] = [
  ...Object.entries(TOOL_DOCS).map(([k, v]) => [`TOOL_DOCS.${k}`, v] as [string, string]),
  ...Object.entries(RESOURCE_DOCS).map(([k, v]) => [`RESOURCE_DOCS[${k}]`, v.text] as [string, string]),
  ["REVIEW_PROMPT_TEXT", REVIEW_PROMPT_TEXT("b", "i", "t")],
];

// THE MOST EXPENSIVE INSTRUCTION THIS SERVICE EVER SHIPPED, and it was in seven
// strings. "Poll again in 10s, backing off to 60s" against a measured t1 median of 323s
// and t2 of 820s tells a client to make seven to fifteen calls that cannot return
// anything — and for an agent client each is a turn. The interval now comes from
// `check_back_note`, computed per tier from real round times, so no document may carry
// a hard-coded one: two sources for the same number is how they come to disagree.
describe("no document hard-codes a polling interval", () => {
  it.each(ALL_DOCS)("%s names no fixed seconds to poll at", (_name, text) => {
    const intervals = text.match(/\b\d+\s*s\b(?![a-z])/gi) ?? [];
    expect(intervals).toStrictEqual([]);
  });

  it.each(ALL_DOCS)("%s does not tell a client to back off", (_name, text) => {
    expect(text).not.toMatch(/back(ing)? off/i);
  });
});

// THE INTERVAL IS NOT A CONSTANT, AND A DOCUMENT THAT IMPLIES IT IS COSTS REAL TIME.
//
// `check_back_after_ms` answers "how much longer FROM HERE", so it shrinks every time a
// client comes back and finds the round still going. The first version returned the
// median whatever the clock said, and the texts described it as "the median round for
// the tier" — so a client that cached it waited a second full median for an answer that
// already existed: over ten minutes on the deep tier.
//
// The behaviour is fixed. This is here because the DOCUMENT is what a client acts on,
// and the sentence that caused the loss was a description, not the code.
describe("the texts say the wait shrinks, and never to cache it", () => {
  const mentions = ALL_DOCS.filter(([, text]) => text.includes("check_back_note"));

  it("is described somewhere at all", () => {
    expect(mentions.length).toBeGreaterThan(0);
  });

  it.each(mentions)("%s tells the client to read it again rather than reuse it", (_name, text) => {
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toMatch(/re-?read it|read it again|read it every time|READ IT AGAIN|re-read the interval/i);
    expect(flat).toMatch(/never reuse|do not cache|do not reuse|never cache/i);
  });

  it.each(mentions)("%s does not call it a fixed property of the tier", (_name, text) => {
    // "the median round for the tier now working" was the sentence that invited caching.
    expect(text.replace(/\s+/g, " ")).not.toMatch(/the median round for the tier/i);
  });
});

// A SESSION ENDS AND TAKES ITS SUBSCRIPTION WITH IT; the review does not end with it.
// D-70 measured abandonment as the dominant cause of wasted reviews, and no
// notification can reach a client that has gone — so the only thing that closes the
// loop is the next session asking what is waiting. Both loop documents must say so
// before they say anything else, because a client reads them top-down.
describe("the loop starts by asking what is already waiting", () => {
  const loops: readonly [string, string][] = [
    ["RESOURCE_DOCS[lore://docs/workflow]", RESOURCE_DOCS["lore://docs/workflow"]?.text ?? ""],
    ["REVIEW_PROMPT_TEXT", REVIEW_PROMPT_TEXT("b", "i", "t")],
  ];

  it.each(loops)("%s opens with review_inbox, before review_start", (_name, text) => {
    const inbox = text.indexOf("review_inbox");
    const start = text.indexOf("review_start");
    expect(inbox).toBeGreaterThan(-1);
    expect(inbox).toBeLessThan(start);
  });
});

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
    // WAS: ["poll", "failed is often transient", "TRANSIENT"].
    //
    // That sentence — "an identical retry frequently succeeds" — was followed
    // exactly by a client: five attempts on one branch across two days, then a report
    // to its user that lore's tier was broken. It was not; the branch exceeded that
    // tier's context window and nothing in the message said so. The advice was wrong
    // and the client was right to trust it, so the cap is the contract now.
    ["poll", "a retry is bounded, because an unbounded one looped", "RETRY AT MOST ONCE"],
    ["poll", "stop rather than diagnose lore yourself", "Diagnosing lore is not your job"],
    ["poll", "a recurrence count is an instruction, not an adjective", 'WHAT TO DO WITH "seen N×'],
    ["poll", "a compacted diff narrows what a pass covers", "could not hold your whole diff"],
    ["submit", "this is how a review continues", "THIS IS HOW A REVIEW CONTINUES"],
    ["query", "empty means not bootstrapped yet (D-35)", "count: 0"],
    ["submit", "choose on truth, not on which answer is cheaper (D-73)", "CHOOSE ON WHETHER THE FINDING IS TRUE"],
    ["submit", "a marker at the site is safe now (D-73)", "safe to write at the site"],
  ])("%s tells the client: %s", (tool, _why, needle) => {
    expect(TOOL_DOCS[tool as keyof typeof TOOL_DOCS]).toContain(needle);
  });
});

/**
 * THE SUBSCRIBE CALL TRAVELS IN THE REPLY, ASSEMBLED.
 *
 * The docs described the shape with a `<review_id>` placeholder and left the client to
 * build it. That is a tax charged at exactly the wrong moment — the reply that says "go
 * away and wait" is the one a client acts on immediately — and the observed behaviour is
 * that clients skip it and fall into a sleep-poll loop, which is the most expensive thing
 * they can do here.
 *
 * Checked mechanically because the two halves are in different files: a reply carrying a
 * malformed call is worse than one carrying none, since a client that copies it verbatim
 * gets a silent stream and concludes lore is quiet.
 */
describe("the subscribe call handed to a client", () => {
  it("is the real method and the real resource template", () => {
    // `subscriptions/listen` and `resourceSubscriptions` are the protocol's spelling, and
    // `lore://review/{id}` is what `RESOURCE_DOCS` and the template registration use.
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(src).toContain('method: "subscriptions/listen"');
    expect(src).toContain("resourceSubscriptions: [`lore://review/${reviewId}`]");
  });

  // The prose must not carry a second copy of the shape: one of them would be wrong
  // eventually, and the doc is the one nobody executes.
  it("is not also spelled out in the docs it replaced", () => {
    expect(TOOL_DOCS.start).not.toContain("resourceSubscriptions");
    expect(TOOL_DOCS.start, "the docs point at the field instead").toContain("`subscribe`");
  });
});
