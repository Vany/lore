/**
 * The run and the document, against a scripted model.
 *
 * Weighted toward what would be expensive or dishonest rather than toward the happy
 * path: the refusal that protects the gate, the budget being counted in sessions, a
 * lens that could not run appearing in the document rather than vanishing from it, and
 * a proposal that nobody criticised saying so.
 *
 * SPEC: spec/propose.md §2, §6, §7
 */

import { beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import type { Tier } from "../core/ladder.ts";
import type { Listed, SessionResult } from "../reviewer/opencode.ts";
import { Store } from "../store/store.ts";
import { renderProposals } from "./render.ts";
import { criticFor, propose, type ProposeInput } from "./run.ts";
import { screen } from "./screen.ts";
import { parseProposal, type Proposal } from "./proposal.ts";

const ZAI: Tier = { id: "t1", kind: "model", model: "zai-coding-plan/glm-5-turbo", stage: "fast" };
const KIMI: Tier = { id: "t2", kind: "model", model: "kimi-for-coding/k3", stage: "deep" };
const TIERS = [ZAI, KIMI];

const IDEA = {
  lens: "seams",
  idea: "Split the store's query surface from its migration surface.",
  touches: ["src/store/store.ts"],
  trueIf: "callers use one or the other",
  costIfWrong: "a week",
  contradictedBy: "PROG.md",
  settledBy: "count the call sites that use both",
  preserves: "every test passes unedited",
};

let store: Store;
let repoId: string;
/** Every prompt the run sent, so the test can assert what was asked and of whom. */
let asked: { tier: string; prompt: string }[];

/** A session that returns `replies` in order; `null` throws, standing for a dead tier. */
function scripted(replies: readonly (unknown[] | null)[]) {
  let n = 0;
  return async <T>(
    tier: Tier,
    prompt: string,
    _worktree: string,
    extract: (text: string) => Listed<T>,
    _contract: string,
  ): Promise<SessionResult<T>> => {
    asked.push({ tier: tier.id, prompt });
    const reply = replies[n++];
    if (reply === null || reply === undefined) throw new Error("the provider refused");
    const r = extract(`\`\`\`json\n${JSON.stringify({ proposals: reply })}\n\`\`\``);
    if (!r.ok) throw new Error(r.why);
    return {
      items: r.items,
      raw: "",
      inputTokens: 1,
      cachedTokens: 0,
      outputTokens: 1,
      costUsd: 0,
      latencyMs: 1,
      retried: false,
      steps: 1,
      rejected: r.rejected,
    };
  };
}

const input = (over: Partial<ProposeInput> = {}): ProposeInput => ({
  lenses: ["seams"],
  folder: "src/store",
  commit: "abc1234",
  worktree: "/wt",
  question: "what would make this better to own?",
  tiers: TIERS,
  budget: 8,
  knowledge: [],
  ...over,
});

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
  asked = [];
});

describe("propose runs beside the product", () => {
  /**
   * IT USED TO REFUSE while any review was in flight, and does not since 2026-08-13 —
   * Vany's call, made while waiting on exactly that refusal. The starvation argument the
   * refusal rested on predates pools and fallback chains (D-93): a burst here now
   * degrades a review to its next route, not to nothing, and D-98 removed every other
   * invisible wait on the same reasoning. `--budget` is the bound, and it is required.
   */
  it("starts while a review is running", async () => {
    store.createReview({
      id: "rev1", repoId, principal: "alice", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
    const r = await propose({ store, repoId, ask: scripted([[IDEA], [IDEA]]) }, input());
    expect(r.sessionsSpent).toBe(2);
  });

  it("starts when every review has concluded", async () => {
    store.createReview({
      id: "rev1", repoId, principal: "alice", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "passed", ladder: initialState(),
    });
    const r = await propose({ store, repoId, ask: scripted([[IDEA], [IDEA]]) }, input());
    expect(r.sessionsSpent).toBe(2);
  });
});

describe("the budget is in sessions, and a critic is a session", () => {
  it("spends two sessions on one lens — proposer and critic", async () => {
    const r = await propose({ store, repoId, ask: scripted([[IDEA], [IDEA]]) }, input());
    expect(r.sessionsSpent).toBe(2);
    expect(asked.map((a) => a.tier)).toStrictEqual(["t2", "t1"]);
  });

  it("stops between lenses rather than half-way through one", async () => {
    const r = await propose(
      { store, repoId, ask: scripted([[IDEA], [IDEA], [IDEA], [IDEA]]) },
      input({ lenses: ["seams", "data", "failure"], budget: 2 }),
    );
    expect(r.sessionsSpent).toBe(2);
    // And the lenses that never ran say so, rather than being absent.
    expect(r.silent.join(" ")).toContain("data");
    expect(r.silent.join(" ")).toContain("failure");
    expect(r.silent.join(" ")).toContain("budget");
  });

  // THE CEILING HAS TO HOLD WHEN EVERY CALL FAILS, and it did not. `sessionsSpent`
  // counts successes, so a session that created an opencode session, sent a prompt,
  // burned tokens and then threw never incremented it — the check never fired and the
  // loop attempted every lens regardless of the budget. Found by `propose` reading its
  // own folder on its first real run, which is the whole argument for the tool.
  it("stops at the budget even when every call fails", async () => {
    const r = await propose(
      { store, repoId, ask: scripted([null, null, null, null]) },
      input({ lenses: ["seams", "data", "failure", "greenfield"], budget: 1 }),
    );
    // ONE attempt, not four.
    expect(asked).toHaveLength(1);
    expect(r.sessionsSpent).toBe(0);
    expect(r.silent.filter((s) => s.includes("budget"))).toHaveLength(3);
  });

  it("counts a failed proposer against the budget before trying the next lens", async () => {
    const r = await propose(
      { store, repoId, ask: scripted([[IDEA], [IDEA], null, [IDEA]]) },
      input({ lenses: ["seams", "data", "failure"], budget: 3 }),
    );
    // seams: proposer + critic = 2. data: proposer fails = 3. failure: over budget.
    expect(asked).toHaveLength(3);
    expect(r.sessionsSpent).toBe(2);
    expect(r.silent.join(" ")).toContain("failure: not run");
  });

  // A budget of 1 buys a proposer and no critic. The idea still comes through — with
  // the fact that nothing challenged it attached to the idea, not to a footnote.
  it("says on the proposal itself when the budget left no critic", async () => {
    const r = await propose({ store, repoId, ask: scripted([[IDEA]]) }, input({ budget: 1 }));
    expect(r.sessionsSpent).toBe(1);
    expect(r.screened[0]?.proposal.contradictedBy).toMatch(/NOT CRITICISED/);
    expect(r.screened[0]?.proposal.contradictedBy).toMatch(/budget ran out/);
  });
});

describe("the critic is a different vendor", () => {
  it("picks a tier from another vendor, not merely another tier", () => {
    expect(criticFor(TIERS, KIMI)?.id).toBe("t1");
    expect(criticFor(TIERS, ZAI)?.id).toBe("t2");
  });

  // Two tiers from one family is one opinion asked twice — the argument that keeps
  // Claude out of the ladder, applied to ideas.
  it("finds nobody when every tier is the same vendor", () => {
    const sameVendor = [ZAI, { ...ZAI, id: "t2", model: "zai-coding-plan/glm-5.2" }];
    expect(criticFor(sameVendor, ZAI)).toBeUndefined();
  });

  /**
   * AND A NICKNAME DOES NOT HIDE THE VENDOR. `vendorOf` on a pool NAME compares the name
   * itself — "GLM5.2" is in no alias table — so a pooled proposer read as its own vendor
   * and could be handed a critic from the same company: one model criticising itself,
   * wearing two names. Resolved through the pools before comparing.
   */
  it("sees through a pool name to the vendor behind it", () => {
    const pools = { "GLM5.2": ["zai-coding-plan/glm-5.2", "zai-coding-plan2/glm-5.2"] };
    const pooled = { ...ZAI, id: "t1", model: "GLM5.2" };
    const zaiConcrete = { ...ZAI, id: "t2", model: "zai-coding-plan/glm-5.2" };
    // Without the pools, the concrete z.ai tier reads as a different vendor than "GLM5.2".
    expect(criticFor([pooled, zaiConcrete], pooled, pools), "same company is not a critic").toBeUndefined();
    expect(criticFor([pooled, KIMI], pooled, pools)?.id).toBe(KIMI.id);
  });

  it("marks a proposal uncriticised when no second vendor exists", async () => {
    const r = await propose(
      { store, repoId, ask: scripted([[IDEA]]) },
      input({ tiers: [ZAI, { ...ZAI, id: "t2", model: "zai-coding-plan/glm-5.2" }] }),
    );
    expect(r.screened[0]?.proposal.contradictedBy).toMatch(/no second vendor/);
  });

  it("carries the CRITIC'S version, since it read the code with the idea in hand", async () => {
    const critique = { ...IDEA, idea: "The critic's restatement, including what was left out." };
    const r = await propose({ store, repoId, ask: scripted([[IDEA], [critique]]) }, input());
    expect(r.screened[0]?.proposal.idea).toBe(critique.idea);
  });

  // Silence from a critic is not agreement, and a document that presented it as
  // "survived a critic" would be asserting something that did not happen.
  it("says so when the critic returned nothing", async () => {
    const r = await propose({ store, repoId, ask: scripted([[IDEA], []]) }, input());
    expect(r.screened[0]?.proposal.contradictedBy).toMatch(/returned nothing, which is not an endorsement/);
  });
});

describe("a lens that did not look is not a lens that found nothing (INV-1)", () => {
  it("records why a lens failed rather than omitting it", async () => {
    const r = await propose({ store, repoId, ask: scripted([null]) }, input());
    expect(r.screened).toStrictEqual([]);
    expect(r.silent.join(" ")).toContain("did not run");
    expect(r.silent.join(" ")).toContain("provider refused");
  });

  it("distinguishes that from a lens that looked and would change nothing", async () => {
    const r = await propose({ store, repoId, ask: scripted([[]]) }, input());
    expect(r.silent.join(" ")).toContain("would change nothing");
    expect(r.silent.join(" ")).not.toContain("did not run");
  });

  it("prints both in the document, under their own heading", () => {
    const doc = renderProposals(
      { repo: "demo", commit: "abc1234", folder: "src/store", mode: "code-arch", lenses: ["seams"], budget: 8, sessionsSpent: 1, at: "2026-08-07T00:00:00.000Z" },
      [],
      ["seams: did not run — the provider refused"],
    );
    expect(doc).toContain("## What did not produce an idea");
    expect(doc).toContain("the provider refused");
  });
});

describe("the document", () => {
  const doc = (proposals: readonly Proposal[], folder = "src/store") =>
    renderProposals(
      { repo: "demo", commit: "abc1234", folder, mode: "code-arch", lenses: ["seams"], budget: 8, sessionsSpent: 2, at: "2026-08-07T00:00:00.000Z" },
      screen(proposals, folder, []),
    );

  // Read weeks later, by which time nobody remembers what was run. A proposal document
  // that cannot say which tree it read is unappraisable the way a finding without a
  // file is — and it must be the SHA, because `master` means something else next week.
  it("names the tree, the folder and what it cost, before any idea", () => {
    const out = doc([parseProposal(IDEA) as Proposal]);
    expect(out).toContain("`abc1234`");
    expect(out).toContain("src/store");
    expect(out).toContain("2 of 8 allowed");
    expect(out.indexOf("abc1234")).toBeLessThan(out.indexOf("Split the store"));
  });

  // The whole defence against three frontier models writing plausibly: a reader decides
  // how they would check BEFORE being persuaded.
  it("prints the measurement before the idea", () => {
    const out = doc([parseProposal(IDEA) as Proposal]);
    expect(out.indexOf("**Settled by:**")).toBeLessThan(out.indexOf("Split the store"));
  });

  it("says plainly when a proposal offered no measurement", () => {
    const { settledBy: _drop, ...without } = IDEA;
    const out = doc([parseProposal(without) as Proposal]);
    expect(out).toContain("cannot be appraised as stated");
    expect(out).toContain("## Unappraisable");
  });

  it("says plainly when a proposal did not state what it preserves", () => {
    const { preserves: _drop, ...without } = IDEA;
    expect(doc([parseProposal(without) as Proposal])).toContain("it may not keep the behaviour");
  });

  it("puts an out-of-scope idea in its own section rather than deleting it", () => {
    const out = doc([parseProposal({ ...IDEA, touches: ["src/mcp/server.ts"] }) as Proposal]);
    expect(out).toContain("## Out of scope, dropped");
    expect(out).toContain("src/mcp/server.ts");
  });

  it("says nothing was found rather than printing an empty section", () => {
    expect(doc([])).toContain("_Nothing._");
  });
});

// Found by lore's own review (77edbad4): this file carries its OWN, second copy of
// reviewer/prompts.ts's knowledgeBlock, and it had the same bug 70b88761/652bb58d
// fixed there — a bootstrap-derived `kind: "fact"` (a model's own unconfirmed
// reading of one branch's code) was rendered under "already knows about itself"
// with no caveat, which could suppress or bias exactly the ideas propose exists to
// generate.
describe("a bootstrap fact is not settled knowledge in a propose prompt (77edbad4)", () => {
  it("puts a fact under an unverified caveat, separate from a taught rule", async () => {
    const rule = store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "the store owns its own migrations",
      why: undefined, path: undefined, cwe: undefined, provenance: undefined,
      sourceBlob: undefined, confidence: 1,
    });
    const fact = store.addKnowledge({
      repoId, kind: "fact", source: "derived", statement: "this module is invoked only by the scheduler",
      why: undefined, path: undefined, cwe: undefined, provenance: "bootstrap:src/store/store.ts",
      sourceBlob: undefined, confidence: 0.5,
    });

    await propose({ store, repoId, ask: scripted([[IDEA], [IDEA]]) }, input({ knowledge: [rule, fact] }));

    const prompt = asked[0]?.prompt ?? "";
    const caveatAt = prompt.indexOf("UNVERIFIED, FROM ONE BRANCH'S FIRST READING");
    expect(caveatAt, "the caveat heading must be present").toBeGreaterThan(-1);
    // The rule block is everything BEFORE the caveat heading; the fact must not
    // appear there, or it would be sitting under "already knows about itself" too.
    const ruleBlock = prompt.slice(0, caveatAt);
    expect(ruleBlock).toContain("the store owns its own migrations");
    expect(ruleBlock, "a fact must not appear under the same heading as a taught rule").not.toContain(
      "invoked only by the scheduler",
    );
    expect(prompt.slice(caveatAt)).toContain("this module is invoked only by the scheduler");
  });
});
