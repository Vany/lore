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

describe("propose refuses to compete with the product", () => {
  // A proposer session costs what a deep review costs and has no diff to anchor it.
  // Eight of them empties a rolling window, and an exhausted window stalls EVERY review
  // in the system. Reviews are the product; this is inspiration.
  it("will not start while a review is running, and names it", async () => {
    store.createReview({
      id: "rev1", repoId, principal: "alice", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
    await expect(propose({ store, repoId, ask: scripted([[IDEA]]) }, input())).rejects.toThrow(/feat\/x/);
    expect(asked).toStrictEqual([]);
  });

  // `fast_clean` looks idle and is not: the deep round is already queued against that
  // worktree, which is the same trap review_submit's refusal names.
  it("counts fast_clean as running", async () => {
    store.createReview({
      id: "rev1", repoId, principal: "alice", branch: "feat/y", intoRef: "main",
      ticket: "t", type: "code-arch", state: "fast_clean", ladder: initialState(),
    });
    await expect(propose({ store, repoId, ask: scripted([[IDEA]]) }, input())).rejects.toThrow(/refusing to start/);
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
