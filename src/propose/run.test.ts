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
import { DidNotRun } from "../core/errors.ts";
import type { Tier } from "../core/ladder.ts";
import type { Listed, SessionResult } from "../reviewer/opencode.ts";
import { Store } from "../store/store.ts";
import { polarity } from "../knowledge/conflict.ts";
import { renderProposals } from "./render.ts";
import { commonScope, criticFor, normalizedTouchPath, propose, type ProposeInput } from "./run.ts";
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

// A REAL worktree (this repo itself), not the imaginary `/wt` this fixture used before
// fingerprint 9b633abb: `propose` now refuses up front when `--folder` does not exist
// in the tree, so a fake path here would refuse every test that does not override it.
// Nothing in this suite actually depends on `src/store/store.ts` being absent.
const input = (over: Partial<ProposeInput> = {}): ProposeInput => ({
  lenses: ["seams"],
  folder: "src/store",
  commit: "abc1234",
  worktree: process.cwd(),
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

/**
 * Fingerprint 9b633abb: nothing checked `--folder` existed in the tree at all. A typo
 * does not fail loud on its own — every proposal lands "outside" a folder that is not
 * there, the whole budget burns on lenses nobody will read, and (since writeBackRejections
 * exists) each one is written back as a false, permanent, confidence-1 rejection.
 */
describe("--folder is checked against the tree before anything is spent", () => {
  it("refuses before asking anything when the folder does not exist", async () => {
    const r = propose({ store, repoId, ask: scripted([[IDEA]]) }, input({ folder: "src/this-does-not-exist" }));
    await expect(r).rejects.toThrow(DidNotRun);
    expect(asked).toHaveLength(0);
  });

  /**
   * Fingerprint 48d3e092: the first version of this guard only checked SOMETHING
   * existed at `join(worktree, folder)` — `--folder ..` resolves to the worktree's own
   * PARENT, which always exists on a real checkout, so it passed straight through to
   * reproduce the exact guaranteed-waste-plus-poisoning run the guard exists to
   * refuse (`inScope` can never match a repo-relative `touches` entry against a path
   * outside the tree either).
   */
  it("refuses a folder that escapes the tree, even though something exists there", async () => {
    const r = propose({ store, repoId, ask: scripted([[IDEA]]) }, input({ folder: ".." }));
    await expect(r).rejects.toThrow(DidNotRun);
    expect(asked).toHaveLength(0);
  });

  it("does not check the repository root, which always exists", async () => {
    const r = await propose({ store, repoId, ask: scripted([[IDEA], [IDEA]]) }, input({ folder: "" }));
    expect(r.sessionsSpent).toBe(2);
  });
});

/**
 * Fingerprint 5b72aabd: `concreteRoute`'s `known` callback used to be `() => undefined`,
 * throwing away the store's own learned route-unavailability state — the same state
 * `review.ts` reads throughout via `store.routeUnavailable`. A route this deployment
 * parked minutes ago would be picked anyway and re-attempted once per lens, each
 * attempt burning real budget for a call certain to fail.
 */
describe("route resolution reads the store's own learned unavailability", () => {
  it("does not attempt a route the store has marked unavailable", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    store.markRouteUnavailable("zai-coding-plan/glm-5-turbo", until, "exhausted", 1);
    const r = propose({ store, repoId, ask: scripted([[IDEA]]) }, input({ tiers: [ZAI] }));
    await expect(r).rejects.toThrow(DidNotRun);
    expect(asked).toHaveLength(0);
  });

  it("attempts a route with no mark against it, same as before", async () => {
    const r = await propose({ store, repoId, ask: scripted([[IDEA]]) }, input({ tiers: [ZAI] }));
    expect(r.sessionsSpent).toBe(1);
  });
});

describe("the budget is in sessions, and a critic is a session", () => {
  it("spends two sessions on one lens — proposer and critic", async () => {
    const r = await propose({ store, repoId, ask: scripted([[IDEA], [IDEA]]) }, input());
    expect(r.sessionsSpent).toBe(2);
    expect(asked.map((a) => a.tier)).toStrictEqual(["t2", "t1"]);
  });

  /**
   * Fingerprint 7429b981: the document's header reports success-counted
   * `sessionsSpent` as spend against `--budget`, but a failed call is still a paid
   * one, fingerprint b1030112 — a run whose critic fails after the proposer succeeds
   * actually spent 2 against the budget and reported 1.
   */
  it("reports sessions ATTEMPTED, not merely succeeded, as the real spend", async () => {
    const r = await propose({ store, repoId, ask: scripted([[IDEA], null]) }, input());
    expect(r.sessionsSpent).toBe(1);
    expect(r.sessionsAttempted).toBe(2);
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

/**
 * Fingerprint b1030112, found by lore's own review: usage was recorded only after a
 * successful `ask`, even though `Reviewer.askFor` deliberately recovers spend from a
 * session that fails mid-exploration and attaches it to the thrown error as `.spent`
 * (`reviewer/opencode.ts`, "Measured 2026-08-09: two t1 attempts ran 45 minutes each
 * against an exhausted plan and our trailing-5h usage read ZERO"). The review path
 * already reads it back this way; this file's own header names "usage is recorded per
 * session" as one of propose's stated money bounds, and it was false on the one path
 * where the spend is real and highest.
 */
describe("a failed call is still a paid one, fingerprint b1030112", () => {
  const failWithSpend = (spent: { input: number; cached: number; output: number; cost: number }) => async () => {
    const e = new Error("the provider refused") as Error & { spent?: typeof spent };
    e.spent = spent;
    throw e;
  };

  it("records a failed proposer's recovered spend, not just silence", async () => {
    const r = await propose(
      { store, repoId, ask: failWithSpend({ input: 500, cached: 100, output: 20, cost: 0.02 }) },
      input({ lenses: ["seams"], budget: 1 }),
    );
    expect(r.sessionsSpent).toBe(0);
    const rows = store.db.prepare("SELECT * FROM usage WHERE repo_id = ?").all(repoId) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["tier"]).toBe("propose:seams");
    expect(rows[0]?.["outcome"]).toBe("failed");
    expect(Number(rows[0]?.["input_tokens"])).toBe(500);
    expect(Number(rows[0]?.["cached_tokens"])).toBe(100);
    expect(Number(rows[0]?.["output_tokens"])).toBe(20);
    expect(Number(rows[0]?.["cost_usd"])).toBe(0.02);
  });

  it("records a failed critic's recovered spend too, under its own tier name", async () => {
    let n = 0;
    const first = scripted([[IDEA]]);
    const ask = async <T>(
      tier: Tier,
      prompt: string,
      worktree: string,
      extract: (text: string) => Listed<T>,
      contract: string,
    ): Promise<SessionResult<T>> => {
      n++;
      if (n === 1) return first(tier, prompt, worktree, extract, contract);
      const e = new Error(`${tier.id} refused`) as Error & { spent?: { input: number; cached: number; output: number; cost: number } };
      e.spent = { input: 900, cached: 0, output: 5, cost: 0.05 };
      throw e;
    };
    await propose({ store, repoId, ask }, input({ lenses: ["seams"], budget: 2 }));
    const rows = store.db.prepare("SELECT * FROM usage WHERE repo_id = ? AND outcome = 'failed'").all(repoId) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["tier"]).toBe("propose-critic:seams");
    expect(Number(rows[0]?.["input_tokens"])).toBe(900);
  });

  // No `.spent` attached (a plain throw, no session ever opened) records nothing — the
  // existing, already-correct silent case, confirmed unchanged.
  it("records nothing when the failure carries no recovered spend", async () => {
    await propose({ store, repoId, ask: scripted([null]) }, input({ lenses: ["seams"], budget: 1 }));
    const rows = store.db.prepare("SELECT * FROM usage WHERE repo_id = ?").all(repoId) as Record<string, unknown>[];
    expect(rows).toHaveLength(0);
  });
});

describe("the critic is a different vendor", () => {
  it("picks a tier from another vendor, not merely another tier", () => {
    expect(criticFor(TIERS, KIMI)[0]?.id).toBe("t1");
    expect(criticFor(TIERS, ZAI)[0]?.id).toBe("t2");
  });

  // Two tiers from one family is one opinion asked twice — the argument that keeps
  // Claude out of the ladder, applied to ideas.
  it("finds nobody when every tier is the same vendor", () => {
    const sameVendor = [ZAI, { ...ZAI, id: "t2", model: "zai-coding-plan/glm-5.2" }];
    expect(criticFor(sameVendor, ZAI)).toStrictEqual([]);
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
    expect(criticFor([pooled, zaiConcrete], pooled, pools), "same company is not a critic").toStrictEqual([]);
    expect(criticFor([pooled, KIMI], pooled, pools)[0]?.id).toBe(KIMI.id);
  });

  /**
   * Fingerprint b56c6982: the FIRST cross-vendor tier by name is not necessarily the
   * first with a usable route today. `criticFor` itself only ranks candidates — this
   * is `propose`'s own fallthrough, tested at that level via `propose` rather than by
   * reaching into `concreteRoute`'s pool internals directly.
   *
   * `openrouter/`-prefixed is the one metered path (D-117, core/ladder.ts) —
   * `concreteRoute` refuses it unless `LORE_ALLOW_METERED` allows it, which this test
   * does not: cleared for its duration (with `LORE_TIERS`, which controls the literal-
   * route exemption) so the result cannot depend on whatever the ambient environment
   * happens to have set.
   */
  it("falls through to a second cross-vendor tier when the first has no usable route", async () => {
    const prevAllow = process.env["LORE_ALLOW_METERED"];
    const prevTiers = process.env["LORE_TIERS"];
    delete process.env["LORE_ALLOW_METERED"];
    delete process.env["LORE_TIERS"];
    try {
      // A real, different vendor (anthropic, via the gateway prefix) — just not a
      // usable ROUTE today, the distinction the old code collapsed. The PROPOSER is
      // `models[models.length - 1]` (run.ts), so it goes LAST — `metered` and KIMI are
      // both candidates for it, tried in this order.
      const metered: Tier = { id: "t3", kind: "model", model: "openrouter/anthropic/claude", stage: "fast" };
      const r = await propose(
        { store, repoId, ask: scripted([[IDEA], [IDEA]]) },
        input({ tiers: [metered, KIMI, ZAI] }),
      );
      expect(r.screened[0]?.proposal.contradictedBy).not.toMatch(/NOT CRITICISED/);
      expect(asked.map((a) => a.tier)).toStrictEqual(["t1", "t2"]);
    } finally {
      if (prevAllow === undefined) delete process.env["LORE_ALLOW_METERED"];
      else process.env["LORE_ALLOW_METERED"] = prevAllow;
      if (prevTiers === undefined) delete process.env["LORE_TIERS"];
      else process.env["LORE_TIERS"] = prevTiers;
    }
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

  /**
   * Fingerprint 84cf95be/006cfc04: e1a18243's fix covered the proposer's own
   * `idea === undefined` branch and not this one — a critic reply PARSING refused (not
   * one that genuinely returned nothing) still said "returned nothing", which is not
   * what happened, even though "not an endorsement" was still the right conclusion
   * either way.
   */
  it("distinguishes that from a critic that replied but nothing parsed", async () => {
    let n = 0;
    const first = scripted([[IDEA]]);
    const ask = async <T>(
      tier: Tier,
      prompt: string,
      worktree: string,
      extract: (text: string) => Listed<T>,
      contract: string,
    ): Promise<SessionResult<T>> => {
      n++;
      if (n === 1) return first(tier, prompt, worktree, extract, contract);
      return {
        items: [],
        raw: "",
        inputTokens: 1,
        cachedTokens: 0,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        retried: true,
        steps: 1,
        rejected: ["seams: 'trueIf' is required and was empty"],
      };
    };
    const r = await propose({ store, repoId, ask }, input());
    expect(r.screened[0]?.proposal.contradictedBy).toMatch(/replied, but nothing parsed/);
    expect(r.screened[0]?.proposal.contradictedBy).toContain("trueIf");
    expect(r.screened[0]?.proposal.contradictedBy).not.toMatch(/read this and returned nothing/);
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

  /**
   * Fingerprint e1a18243: a reply whose only proposal was schema-refused (not a
   * transport failure — the call succeeded, `deps.ask` returns normally) used to read
   * exactly like a proposer that genuinely had nothing to say, even though
   * PROPOSAL_CONTRACT's blessing of `"proposals": []` covers only the second case. The
   * reader appraising the document weeks later could not tell "said nothing" from
   * "said something parsing threw away".
   */
  it("distinguishes that from a lens that replied but parsed to nothing", async () => {
    const allRejected = async <T>(): Promise<SessionResult<T>> => ({
      items: [],
      raw: "",
      inputTokens: 1,
      cachedTokens: 0,
      outputTokens: 1,
      costUsd: 0,
      latencyMs: 1,
      retried: true,
      steps: 1,
      rejected: ["seams: 'trueIf' is required and was empty"],
    });
    const r = await propose({ store, repoId, ask: allRejected }, input({ lenses: ["seams"], budget: 1 }));
    expect(r.silent.join(" ")).toContain("replied, but nothing parsed");
    expect(r.silent.join(" ")).toContain("trueIf");
    expect(r.silent.join(" ")).not.toContain("would change nothing");
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

  /**
   * Fingerprint 287fffa0/67a0c784: a critic-rejected idea had no section of its own and
   * fell into "Appraise these" — the document's most-read section — unmarked as having
   * been rejected at all, even though the knowledge base recorded it as rejected in the
   * same run.
   */
  it("puts a critic-rejected idea in its own section, not in Appraise these", () => {
    const out = doc([parseProposal({ ...IDEA, rejects: true }) as Proposal]);
    expect(out).toContain("## Rejected by its critic");
    const appraiseSection = out.slice(out.indexOf("## Appraise these"), out.indexOf("## Already decided"));
    expect(appraiseSection).not.toContain(IDEA.idea);
  });

  it("says nothing was found rather than printing an empty section", () => {
    expect(doc([])).toContain("_Nothing._");
  });

  // Fingerprint 1efe9c5f, found by lore's own review: an uncriticised proposal (no
  // second vendor configured, or the budget ran out first) has no demotion of its
  // own, so it lands in "Appraise these" alongside genuinely criticised ones. The
  // section's OWN note used to claim every entry there "Survived a critic from a
  // different vendor" — true for most, false for this one, and the per-proposal NOT
  // CRITICISED marker is easy to miss in a section a reader is likely to skim.
  it("does not claim every survivor in 'Appraise these' was criticised", () => {
    const uncriticised = {
      ...IDEA,
      contradictedBy: `${IDEA.contradictedBy} — NOT CRITICISED: no second vendor is configured, so this is one model's unchallenged opinion`,
    };
    const out = doc([parseProposal(uncriticised) as Proposal]);
    expect(out).toContain("## Appraise these");
    expect(out, "the section note must not blanket-claim a critic for every entry").not.toMatch(
      /Survived a critic from a different vendor, in scope/,
    );
    expect(out).toContain("NOT CRITICISED");
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

/**
 * Fingerprint b551376e, Vany's own design call: `propose` is fire-and-forget, with no
 * way to later learn what a person decided about a SURVIVING idea, so only what
 * `propose` itself is certain enough of within its own run can be written back —
 * the screen's own out-of-scope drop, and the critic's own structured `rejects`.
 *
 * `input()`'s own worktree is real (this repo, not a fake path — fingerprint
 * 9b633abb) precisely so `exists` reflects genuine file presence here: the suite
 * needs that to isolate "landed outside the folder" from "the named file is
 * imaginary", a different out-of-scope reason `screen.ts` also produces, and to
 * prove a proposal that is genuinely appraisable writes back nothing at all.
 */
describe("whatever propose itself is certain enough to reject is written back", () => {
  const rejectedRows = () =>
    store.db.prepare("SELECT * FROM knowledge WHERE repo_id = ? AND kind = 'mistake'").all(repoId) as Record<string, unknown>[];

  it("writes back a proposal the screen drops as out-of-scope", async () => {
    const elsewhere = { ...IDEA, touches: ["src/mcp/server.ts"] };
    await propose({ store, repoId, ask: scripted([[elsewhere], [elsewhere]]) }, input());
    const rows = rejectedRows();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.["statement"])).toContain(IDEA.idea);
    expect(String(rows[0]?.["source"])).toBe("derived");
    expect(String(rows[0]?.["why"])).toContain("none of it inside");
  });

  /**
   * Fingerprint bdd42529: a glob (`src/store/*.ts`) reads as "does not exist" under a
   * literal `existsSync`, so the screen used to drop it out-of-scope with the false
   * reason "names only files that do not exist" and write that false fact back as a
   * permanent, confidence-1 knowledge row.
   */
  it("does not treat a glob path as an invented one", async () => {
    const globby = { ...IDEA, touches: ["src/store/*.ts"] };
    const r = await propose({ store, repoId, ask: scripted([[globby], [globby]]) }, input());
    expect(r.screened[0]?.demotions).toStrictEqual([]);
    expect(rejectedRows()).toHaveLength(0);
  });

  it("writes back a proposal the critic structurally rejects, even in scope", async () => {
    const rejected = { ...IDEA, rejects: true };
    await propose({ store, repoId, ask: scripted([[IDEA], [rejected]]) }, input());
    const rows = rejectedRows();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.["why"])).toContain("critic judged it simply wrong");
  });

  it("writes back nothing for a proposal that survives both scope and critic", async () => {
    await propose({ store, repoId, ask: scripted([[IDEA], [IDEA]]) }, input());
    expect(rejectedRows()).toHaveLength(0);
  });

  it("does not re-arm a lesson a person resolved away by re-running over the same tree", async () => {
    const elsewhere = { ...IDEA, touches: ["src/mcp/server.ts"] };
    await propose({ store, repoId, ask: scripted([[elsewhere], [elsewhere]]) }, input());
    await propose({ store, repoId, ask: scripted([[elsewhere], [elsewhere]]) }, input());
    expect(rejectedRows()).toHaveLength(1);
  });

  it("writes a fresh row for a genuinely different sweep of the same tree", async () => {
    const elsewhere = { ...IDEA, touches: ["src/mcp/server.ts"] };
    await propose({ store, repoId, ask: scripted([[elsewhere], [elsewhere]]) }, input());
    await propose({ store, repoId, ask: scripted([[elsewhere], [elsewhere]]) }, input({ commit: "def5678" }));
    expect(rejectedRows()).toHaveLength(2);
  });

  it("scopes the written-back row to the single file the idea names", async () => {
    const elsewhere = { ...IDEA, touches: ["src/mcp/server.ts"] };
    await propose({ store, repoId, ask: scripted([[elsewhere], [elsewhere]]) }, input());
    expect(rejectedRows()[0]?.["path"]).toBe("src/mcp/server.ts");
  });

  /**
   * Fingerprint 790271a9: a `touches` entry stored verbatim — `./src/mcp/server.ts`
   * (a leading `./`, which `exists`/`inScope` both already accept) — creates a `path`
   * no path-scoped consumer (`knowledgeFor`'s SQL, `scopesOverlap`) can ever match,
   * since both require an exact segment boundary. `normalizedTouchPath`'s own unit
   * tests below cover the trailing-slash and leading-`/` forms directly; this proves
   * the write-back actually calls it.
   */
  it("normalizes a touch path with a leading ./ before storing it", async () => {
    const messy = { ...IDEA, touches: ["./src/mcp/server.ts"] };
    await propose({ store, repoId, ask: scripted([[messy], [messy]]) }, input());
    expect(rejectedRows()[0]?.["path"]).toBe("src/mcp/server.ts");
  });

  /**
   * Fingerprint 50a98db3: a rejection over two or more touches used to fall back to
   * repo-wide (`path: undefined`), the same cross-folder leakage 0318670f fixed for
   * the single-touch case, reproduced for the shape most ideas actually have.
   */
  it("scopes a multi-touch rejection to their shared directory, not repo-wide", async () => {
    const spread = { ...IDEA, touches: ["src/mcp/server.ts", "src/mcp/docs.ts"] };
    await propose({ store, repoId, ask: scripted([[spread], [spread]]) }, input());
    expect(rejectedRows()[0]?.["path"]).toBe("src/mcp");
  });

  /**
   * Fingerprint a90601f4: `knowledge/conflict.ts`'s `detectAndRecord` runs over every
   * live row at the start of every review round and pairs opposite-polarity,
   * high-overlap statements as a candidate contradiction — a bare "considered: <idea>"
   * carries the IDEA'S OWN polarity, so a rejected idea that AGREES with a taught rule
   * in substance but differs in phrasing could be read as CONTRADICTING it, parking a
   * future review at `needs_human` over nothing. Exercises the REAL `polarity()`
   * rather than a copy, since the whole point is safety against that exact function.
   */
  it("writes a statement conflict detection cannot read as agreeing or disagreeing with anything", async () => {
    const elsewhere = { ...IDEA, touches: ["src/mcp/server.ts"] };
    await propose({ store, repoId, ask: scripted([[elsewhere], [elsewhere]]) }, input());
    const statement = String(rejectedRows()[0]?.["statement"]);
    expect(polarity(statement)).toBe(0);
  });

  /**
   * Fingerprint 9c49fc0a: `rejects` is documented as the critic's field alone
   * (proposal.ts), but nothing stopped a PROPOSER from setting it too — the shared
   * PROPOSAL_CONTRACT shows the field on every call, proposer and critic alike — and
   * every no-critic fallback spread the proposer's own object unchanged. A budget of 1
   * (the documented "buys a proposer and no critic" case) with a proposer-set
   * `rejects: true` would have written a permanent `mistake` row claiming a critic
   * judged the idea wrong when no critic ever ran.
   */
  it("does not attribute a proposer's own rejects to a critic that never ran", async () => {
    const selfRejecting = { ...IDEA, rejects: true };
    const r = await propose({ store, repoId, ask: scripted([[selfRejecting]]) }, input({ budget: 1 }));
    expect(r.screened[0]?.proposal.contradictedBy).toMatch(/NOT CRITICISED/);
    expect(rejectedRows()).toHaveLength(0);
  });
});

/**
 * Fingerprint 790271a9: the forms `knowledgeFor`'s SQL and `scopesOverlap`'s exact
 * segment-boundary comparison cannot see through, all of which `exists`/`inScope`
 * already accept from a model.
 */
describe("normalizedTouchPath", () => {
  it("strips a leading ./", () => {
    expect(normalizedTouchPath("./src/mcp/server.ts")).toBe("src/mcp/server.ts");
  });

  it("strips a trailing slash", () => {
    expect(normalizedTouchPath("src/mcp/")).toBe("src/mcp");
  });

  it("strips a leading /, the same inertness path.join already gives it (fingerprint 85623b0c)", () => {
    expect(normalizedTouchPath("/src/mcp/server.ts")).toBe("src/mcp/server.ts");
  });

  it("leaves an already-clean path unchanged", () => {
    expect(normalizedTouchPath("src/mcp/server.ts")).toBe("src/mcp/server.ts");
  });

  it("returns undefined for the repository root, matching addKnowledge's own repo-wide convention", () => {
    expect(normalizedTouchPath(".")).toBeUndefined();
    expect(normalizedTouchPath("/")).toBeUndefined();
  });
});

/**
 * Fingerprint 50a98db3: `normalizedTouchPath` alone only ever scoped the single-touch
 * case, falling back to repo-wide for two or more — the MODAL case, since an idea that
 * moves a seam necessarily touches both sides of it (spec/propose.md §1.1).
 */
describe("commonScope", () => {
  it("matches normalizedTouchPath exactly for a single touch", () => {
    expect(commonScope(["src/mcp/server.ts"])).toBe("src/mcp/server.ts");
  });

  it("narrows to the shared directory for touches in the same one", () => {
    expect(commonScope(["src/mcp/server.ts", "src/mcp/docs.ts"])).toBe("src/mcp");
  });

  it("narrows to the shared ancestor for touches in different directories, never repo-wide", () => {
    expect(commonScope(["src/mcp/server.ts", "src/store/store.ts"])).toBe("src");
  });

  it("still returns undefined — genuinely repo-wide — when nothing was named at all", () => {
    expect(commonScope([])).toBeUndefined();
  });

  it("normalizes each touch before comparing them", () => {
    expect(commonScope(["./src/mcp/a.ts", "src/mcp/b.ts"])).toBe("src/mcp");
  });
});
