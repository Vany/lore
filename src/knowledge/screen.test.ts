/**
 * The screen's job is to refuse, and every test here is about the cost of refusing
 * WRONGLY — in both directions, which are not equally expensive.
 *
 * A rule dropped is invisible: it cannot be recovered by reading the document again,
 * nobody knows it is missing, and the reviewer that needed it never learns it existed.
 * A fragment kept costs one line in a prompt. So the fixtures lean on the fail-open
 * paths — an unreachable model, an unparseable reply, an index that means nothing —
 * because those are where a filter turns into a shredder.
 */

import { describe, expect, it } from "vitest";
import type { Tier } from "../core/ladder.ts";
import type { Candidate } from "./ingest.ts";
import { partition, screenFor, screenPrompt, type Ask } from "./screen.ts";

const TIER: Tier = { id: "t1", kind: "model", model: "vendor/cheap", effort: "low", stage: "fast" };

const candidates = (...statements: string[]): readonly Candidate[] =>
  statements.map((statement) => ({ statement, why: undefined }));

/**
 * A reviewer that answers with whatever text is handed to it.
 *
 * A reply that does not parse REJECTS, which is what the real `askFor` does once its one
 * retry is spent — the session throws rather than returning an empty list. Modelling it
 * as an empty list instead would make "the model could not be read" indistinguishable
 * from "the model approved everything", which is the confusion this whole module exists
 * to keep out of the knowledge base.
 */
const SPENT = { raw: "", inputTokens: 1_200, cachedTokens: 900, outputTokens: 40, costUsd: 0, latencyMs: 4_100, retried: false, steps: 2, rejected: [] };

const answering = (text: string): Ask => (_tier, _prompt, _worktree, extract) => {
  const listed = extract(text);
  return listed.ok
    ? Promise.resolve({ ...SPENT, items: listed.items })
    : Promise.reject(new Error(listed.why));
};

const throwing = (message: string): Ask => () => Promise.reject(new Error(message));

describe("screenPrompt", () => {
  it("numbers the statements, because that is all the model has to echo", () => {
    const p = screenPrompt("PROG.md", candidates("Fakes must not be kinder than production", "Cost."));
    expect(p).toContain("1. Fakes must not be kinder than production");
    expect(p).toContain("2. Cost.");
    expect(p).toContain("PROG.md");
  });

  // The instruction that decides every uncertain case, and it must be in the words that
  // say WHY — a model told merely to "be careful" balances the two errors, and they are
  // not balanced.
  it("tells the model the errors are not symmetrical", () => {
    const p = screenPrompt("SPEC.md", candidates("Handles are CSPRNG-generated, never sequential"));
    // `\s+` rather than a literal space: the prompt is a wrapped template, so a phrase
    // straddles a newline and re-wrapping it must not read as deleting it.
    expect(p).toMatch(/KEEP ANYTHING YOU ARE UNSURE ABOUT/);
    expect(p).toMatch(/invisible\s+to\s+everyone\s+for\s+ever/);
    expect(p).toMatch(/do\s+not\s+balance\s+them/i);
  });

  // How this team writes rules, listed so the screen does not refuse the house style.
  it("names the shapes that must NOT be refused", () => {
    const p = screenPrompt("PROG.md", candidates("D-71 — lore reads a test suite and never runs it"));
    expect(p).toMatch(/opening on a code span/);
    expect(p).toMatch(/naming a decision id/);
  });
});

describe("screenFor", () => {
  it("drops what the model numbered and keeps the rest, with the reason it gave", async () => {
    const screen = screenFor(
      answering('```json\n{"not_rules":[{"n":2,"because":"a topic label; the content is elsewhere"}]}\n```'),
      TIER,
      "/tmp/wt",
    );
    const out = await screen("spec/deployment.md", candidates("Every image must be linux/arm64", "Cost."));

    expect(out.ran).toBe(true);
    expect(out.kept.map((c) => c.statement)).toStrictEqual(["Every image must be linux/arm64"]);
    expect(out.refused).toStrictEqual([{ statement: "Cost.", because: "a topic label; the content is elsewhere" }]);
  });

  it("keeps everything when the model refuses nothing", async () => {
    const screen = screenFor(answering('```json\n{"not_rules":[]}\n```'), TIER, "/tmp/wt");
    const out = await screen("PROG.md", candidates("Fakes must not be kinder than production"));
    expect(out.kept).toHaveLength(1);
    expect(out.refused).toStrictEqual([]);
    expect(out.ran).toBe(true);
  });

  // THE FAILURE THAT MUST NOT EMPTY A REPOSITORY'S MEMORY. A quota refusal or a dead
  // provider during ingest would otherwise leave the knowledge base — which is the
  // product — with nothing in it, and the next review would run blind and say nothing
  // about why. `ran: false` is what the caller stamps so the next ingest re-screens.
  it("keeps every candidate and says it did not run when the model is unreachable", async () => {
    const screen = screenFor(throwing("quota exhausted"), TIER, "/tmp/wt");
    const out = await screen("SPEC.md", candidates("A rule never outlives the text that justified it", "Cost."));

    expect(out.ran).toBe(false);
    expect(out.kept).toHaveLength(2);
    expect(out.refused).toStrictEqual([]);
  });

  // An unparseable reply is the same fact as an unreachable model: nothing was screened.
  // It must not read as "the model approved everything", which is what an empty list
  // from a broken reply would look like if the extractor's failure were swallowed.
  it("keeps every candidate when the reply cannot be read", async () => {
    const screen = screenFor(answering("I had trouble with that, sorry."), TIER, "/tmp/wt");
    const out = await screen("SPEC.md", candidates("A rule never outlives the text that justified it"));
    expect(out.kept).toHaveLength(1);
    expect(out.refused).toStrictEqual([]);
  });

  it("asks nothing when there is nothing to ask about", async () => {
    let asked = false;
    const ask: Ask = () => {
      asked = true;
      return Promise.resolve({ ...SPENT, items: [] });
    };
    const out = await screenFor(ask, TIER, "/tmp/wt")("EMPTY.md", []);
    expect(asked).toBe(false);
    expect(out.ran).toBe(true);
  });

  // THESE WERE THE ONLY MODEL CALLS IN THE SYSTEM WITH NO USAGE ROW. The `Ask` type was
  // narrowed to `{items}` — tidy, and it threw the tokens and the latency away, so D-81's
  // own cost claim could not be checked against anything and a cheap-tier screen that
  // decided to go exploring the worktree would burn minutes of quota leaving no trace.
  it("hands back what the session cost, so a screen call is not free by accident", async () => {
    const spent: unknown[] = [];
    const screen = screenFor(
      answering('```json\n{"not_rules":[{"n":1,"because":"a topic label"}]}\n```'),
      TIER,
      "/tmp/wt",
      (u) => spent.push(u),
    );
    await screen("PROG.md", candidates("Cost. Something must happen", "Fakes must not be kinder"));

    expect(spent).toStrictEqual([
      {
        tier: "screen:t1",
        model: "vendor/cheap",
        inputTokens: 1_200,
        cachedTokens: 900,
        outputTokens: 40,
        costUsd: 0,
        latencyMs: 4_100,
        steps: 2,
        refused: 1,
      },
    ]);
  });

  // A session that never completed cost nothing we can attribute, and inventing a zero
  // row for it would put "the screen ran and was free" into the one table an operator
  // reads to answer what it costs.
  it("records nothing when the session did not complete", async () => {
    const spent: unknown[] = [];
    const screen = screenFor(throwing("quota exhausted"), TIER, "/tmp/wt", (u) => spent.push(u));
    await screen("PROG.md", candidates("Fakes must not be kinder than production"));
    expect(spent).toStrictEqual([]);
  });
});

describe("partition", () => {
  // A model answering about item 40 of a 12-item list was not answering about this list.
  // Clamping it to 12 would delete a real rule on the strength of a typo.
  it("discards an index that is not on the list rather than guessing", () => {
    const out = partition(candidates("a must", "b must"), [{ n: 40, because: "whatever" }]);
    expect(out.kept).toHaveLength(2);
    expect(out.refused).toStrictEqual([]);
  });

  it("is one-based, matching what the prompt printed", () => {
    const out = partition(candidates("first must", "second must"), [{ n: 1, because: "x" }]);
    expect(out.kept.map((c) => c.statement)).toStrictEqual(["second must"]);
  });
});
