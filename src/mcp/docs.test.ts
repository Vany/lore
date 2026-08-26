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
import { everyClientDocument, RESOURCE_DOCS, REVIEW_PROMPT_TEXT, TOOL_DOCS } from "./docs.ts";

/**
 * Every string a client is ever shown, from the module that owns them.
 *
 * It was assembled here, and then a second copy was assembled in `http.test.ts` when one
 * of these guards moved — except that copy was `TOOL_DOCS` alone, so `REVIEW_PROMPT_TEXT`
 * and every resource doc silently left the corpus while a comment said the guard had only
 * moved. One list, beside the documents, is the fix.
 */
const ALL_DOCS: readonly (readonly [string, string])[] = everyClientDocument();

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
    ["REVIEW_PROMPT_TEXT", REVIEW_PROMPT_TEXT({ branch: "b", into: "i" }, "t")],
  ];

  it.each(loops)("%s opens with review_inbox, before review_start", (_name, text) => {
    const inbox = text.indexOf("review_inbox");
    const start = text.indexOf("review_start");
    expect(inbox).toBeGreaterThan(-1);
    expect(inbox).toBeLessThan(start);
  });

  // Both of these render the same six-step loop as a numbered list; a step cut during
  // an edit leaves a gap (0, 1, 2, 4, 5, 6 — no 3) that reads as a missing step rather
  // than a renumbering nobody did. Checked mechanically so a future edit to one number
  // cannot silently reopen it.
  it.each(loops)("%s numbers its loop 0 through 5, with no gap", (_name, text) => {
    const steps = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(steps).toStrictEqual([0, 1, 2, 3, 4, 5]);
  });

  // D-130: folder mode is the alternative to a diff, and the static reference doc is
  // the one place an agent following "the documented way" would look for it before it
  // has chosen a mode — found missing here once already, across the change that
  // introduced folder mode. REVIEW_PROMPT_TEXT is deliberately NOT in this check: it
  // renders ONE already-chosen mode's call (see the standalone tests below), not both
  // as alternatives, so a diff-mode sample legitimately never mentions "folder".
  it("RESOURCE_DOCS[lore://docs/workflow] mentions folder mode as an alternative to into", () => {
    expect(RESOURCE_DOCS["lore://docs/workflow"]?.text ?? "").toMatch(/mode: "folder"/);
  });

  it("REVIEW_PROMPT_TEXT renders the folder-mode call when mode is folder", () => {
    const text = REVIEW_PROMPT_TEXT({ branch: "b", mode: "folder", path: "src" }, "t");
    expect(text).toMatch(/mode: "folder"/);
    expect(text).toContain('path: "src"');
  });
});

describe("the docs name tools that exist", () => {
  it.each(ALL_DOCS)("%s uses no dotted tool name", (_name, text) => {
    // `review.poll` is what SPEC calls it in prose and is not callable. Matching the
    // stem lets a doc say "a review's poll" while catching the tool-shaped form.
    const dotted = text.match(/\b(?:review|knowledge)\.[a-z_]+/g) ?? [];
    expect(dotted).toStrictEqual([]);
  });

  // THE "ONLY NAMES REGISTERED TOOLS" CHECK MOVED to `http.test.ts`, where a live
  // `tools/list` can feed it — over EVERY document, via `everyClientDocument()`.
  //
  // Here it compared against ten names typed out by hand, because this file has no
  // server to ask. The server registers twelve. So it aged into the opposite of a
  // drift guard: `review_cancel` had existed for weeks, and the first doc to tell a
  // client to call it was failed for naming a tool that does not exist. A guard
  // holding its own stale copy of the truth defends the copy.
  //
  // AND THE FIRST VERSION OF THAT MOVE NARROWED IT, which is why the corpus is now a
  // function beside the documents rather than a list beside a test: the moved check
  // scanned `TOOL_DOCS` alone, so `REVIEW_PROMPT_TEXT` and every resource doc left the
  // guard silently while this comment said it had only moved. A sentence claiming
  // coverage is exactly as dangerous as a test claiming it.
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
    ["REVIEW_PROMPT_TEXT", REVIEW_PROMPT_TEXT({ branch: "b", into: "i" }, "t")],
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
    ["REVIEW_PROMPT_TEXT", REVIEW_PROMPT_TEXT({ branch: "b", into: "i" }, "t")],
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
    // WAS: "the host refreshes the mirror, not you". Vany, 2026-08-14: the mirror is
    // lore's mechanism and the client's only requirement is that the code reached
    // ORIGIN — so the texts stopped mentioning it at all, and this pin now guards the
    // replacement sentence rather than the leak.
    ["start", "origin is the only requirement (D-65 revised)", "your code has reached ORIGIN"],
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
    ["attest", "a folder review's line names its scope (D-130)", "scoped to"],
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
/**
 * NOTHING SUBSCRIPTION-SHAPED REACHES A CLIENT (D-103).
 *
 * These tests once asserted the opposite: that every reply carried a ready-made
 * `subscribe` frame and a `subscribe_filter`, and that the prose pointed at them. The
 * mechanism is still there — the server declares the capability, honours
 * `subscriptions/listen`, and wakes subscribers on state changes — but no client we serve
 * can use it yet, and advertising it made every reply lead with an instruction the reader
 * must fail at before finding the interval it actually needed.
 *
 * Vany: *"we are keeping our subscription mechanism, but it is not yet ready in the
 * client — the client can only poll. So we ask the client to poll, and keep the
 * subscribing model hidden."*
 *
 * So the property is now the absence, and it is worth a test because the words are easy to
 * put back one paragraph at a time.
 */
describe("the docs ask a client to poll, and mention nothing it cannot do", () => {
  it.each(ALL_DOCS)("%s offers no subscription a client cannot use", (_name, text) => {
    expect(text).not.toContain("resourceSubscriptions");
    expect(text).not.toContain("subscriptions/listen");
    expect(text, "an SDK helper a polling client has no use for").not.toContain("listen()");
    expect(text).not.toContain("subscribe_filter");

    // THE CONCEPT, NOT FOUR LITERAL STRINGS. The first version of this guard checked the
    // wire names only, and `TOOL_DOCS.inbox` sailed past it saying "your subscription ends
    // with you" — naming the hidden mechanism to a client with no way to create one, in
    // the first document it is told to read. Raised by lore's own t2.
    //
    // The provider sense is a different word doing a different job: a flat-rate plan with
    // a quota, which clients are legitimately told about when a tier falls back to a
    // metered route. So it is the VERB and the client-side noun that are banned here.
    const flat = text.replace(/\s+/g, " ");
    expect(flat, "tells a client to subscribe").not.toMatch(/\bsubscribe\b|\bsubscribing\b|\bsubscriber\b/i);
    expect(flat, "implies the client holds one").not.toMatch(/your subscription|a subscription (to|carries|has)/i);
  });

  // The replacement has to be PRESENT, not merely the old text absent: a doc that removed
  // the subscribe advice and said nothing instead would leave a client with no interval
  // and the sleep-poll loop this whole surface exists to prevent.
  it("tells a client how long to wait instead", () => {
    expect(TOOL_DOCS.start).toContain("check_back_after_ms");
    expect(TOOL_DOCS.poll).toContain("check_back_after_ms");
    expect(TOOL_DOCS.start, "and that it is bounded").toMatch(/never more than two minutes/);
  });

  // The capability itself is untouched, and that is the point of hiding rather than
  // deleting: a client that gains support gets woken with no server change.
  it("keeps the mechanism the server still serves", () => {
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(src, "still declared").toContain("resources: { subscribe: true }");
  });

  // spec/mcp-api.md's own example drifted to the WRAPPED shape once (cfac0ddd) —
  // accepted and acknowledged over the wire, and never delivers. subscribe.test.ts
  // proved only the unwrapped shape is honoured ("after I guessed wrong in both
  // directions"); this pins the spec's literal JSON against what subscribeTo actually
  // emits, so a hand-edit cannot drift back without failing here.
  it("spec/mcp-api.md's subscribe example matches the shape subscribeTo emits", () => {
    const spec = readFileSync(new URL("../../spec/mcp-api.md", import.meta.url), "utf8");
    const section = /^### 2\.0\.1 .*$([\s\S]*?)^### 2\.0\.2/m.exec(spec)?.[1] ?? "";
    expect(section, "section 2.0.1 moved or was renamed").not.toBe("");
    const block = /```jsonc\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
    expect(block, "no jsonc example found in 2.0.1").not.toBe("");
    const parsed = JSON.parse(block) as { method?: string; params?: Record<string, unknown> };
    expect(parsed.method).toBe("subscriptions/listen");
    expect(parsed.params, "wrapped in a notifications key — the wire never honours that shape").toStrictEqual({
      resourceSubscriptions: ["lore://review/<id>"],
    });

    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(src, "subscribeTo itself must emit the unwrapped shape").toContain(
      "params: { resourceSubscriptions: [reviewUri(reviewId)] }",
    );
  });
});

/**
 * `spec/mcp-api.md` §2 lists the tools. That list was WRONG in two ways at once.
 *
 * It said "Ten", listed eleven, and omitted `review_cancel` entirely — a tool that has
 * been registered, documented in `TOOL_DOCS` and callable by every client for as long as
 * it has existed. The table is what a person reads to learn what this service offers, so
 * a tool missing from it is a tool nobody knows to use, and a count that disagrees with
 * its own rows is a document nobody has read carefully in a while.
 *
 * Drift is a defect whichever side moved (D-11), and this side moves by hand. So the
 * count and the rows are both read back from the file and compared against what the
 * server actually registers.
 */
describe("the tool table in spec/mcp-api.md", () => {
  const spec = readFileSync(new URL("../../spec/mcp-api.md", import.meta.url), "utf8");
  const registered = [
    ...readFileSync(new URL("./server.ts", import.meta.url), "utf8").matchAll(
      /server\.registerTool\(\s*"([a-z_]+)"/g,
    ),
  ].map((m) => m[1] ?? "");

  it("lists every tool the server registers", () => {
    // SCOPED TO SECTION 2's OWN TABLE. Matching backticked snake_case row openers across
    // the whole document swept up §2.5's three-valued `stopped_in_flight` table — `true`,
    // `false`, `null` — and reported them as undocumented tools. A check that fails for a
    // reason unrelated to the thing it guards gets disabled, not fixed.
    const section = /^## 2\. Tools$([\s\S]*?)^#/m.exec(spec)?.[1] ?? "";
    expect(section, "section 2 moved or was renamed").not.toBe("");
    const listed = [...section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1] ?? "");
    expect([...registered].sort()).toStrictEqual([...listed].sort());
  });

  // The sentence above the table counts them, and a hand-written count is a fact that
  // rots on its own. "Ten" survived two tools being added.
  it("counts them correctly in words", () => {
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
      "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
    const claimed = /^(\w+), registered with \*\*underscores\*\*/m.exec(spec)?.[1] ?? "";
    expect(claimed.toLowerCase()).toBe(words[registered.length]);
  });
});
