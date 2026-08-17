import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ladderChanged, clientDeliveredWork, DEFAULT_TIERS, anyTierRan, initialState, loadTiers, loadPools, loadHelper, markAnsweredBy, markUnavailable, concreteRoute, exemptLiteral, noRouteBecause, vendorCollapse, fallbackRoutes, poolOrder, routesFor, rungKey, rungMembers, settle, withQuota, soleVendorOf, step, vendorOf, type Decision, type LadderState, type Tier, ladderFingerprint } from "./ladder.ts";

const clean = (state: LadderState) => step({ state, raised: [] });

describe("step", () => {
  it("starts at the first model tier, not at T0", () => {
    expect(DEFAULT_TIERS[initialState().cursor]?.id).toBe("t1");
  });

  // A CLOSED TIER STAYS CLOSED. This used to reset to t1, on the grounds that a fix is
  // unreviewed code — and the effect was that t1 ruled on justifications for findings
  // t2 had raised, four times in one review of this repository. `settle()` runs on
  // whichever tier the round is on, so the reset handed D-10's ruling to a cheaper
  // model that never asked the question. Revised 2026-08-07.
  it("reports new findings and stays on the tier that raised them", () => {
    // Get to t2 first, so "stays" is observable rather than a no-op.
    const atT2 = clean(initialState()).state;
    expect(DEFAULT_TIERS[atT2.cursor]?.id).toBe("t2");

    const r = step({ state: atT2, raised: ["aaa"] });
    expect(r.decision.kind).toBe("findings");
    expect(DEFAULT_TIERS[r.state.cursor]?.id).toBe("t2");
  });

  it("treats a tier that only re-raises settled findings as clean", () => {
    const state = settle(initialState(), ["aaa", "bbb"]);
    expect(step({ state, raised: ["aaa", "bbb"] }).decision.kind).toBe("fastClean");
  });

  it("crossing from the fast stage into the deep stage is its own outcome", () => {
    // fast_clean is the state a client is most likely to misread as passed.
    expect(clean(initialState()).decision.kind).toBe("fastClean");
  });

  it("escalates within the deep stage", () => {
    const atT2 = clean(initialState()).state;
    const r = clean(atT2);
    expect(r.decision).toStrictEqual({ kind: "escalate", next: DEFAULT_TIERS[3] });
  });

  it("passes only when the top tier is clean", () => {
    let s = initialState();
    s = clean(s).state; // t1 -> t2
    s = clean(s).state; // t2 -> t3
    expect(clean(s).decision.kind).toBe("passed");
  });

  it("never passes while a human question is open", () => {
    let s = initialState();
    s = clean(s).state;
    s = clean(s).state;
    const r = step({ state: s, raised: [], needsHuman: true });
    expect(r.decision.kind).toBe("needsHuman");
  });

  // Derived from the caller's current view, never accumulated. Sticky would
  // deadlock: once a conflict appeared the review could never pass again, even
  // after a human settled it. A question with no way to answer it is a trap.
  it("clears needsHuman once the caller reports it resolved", () => {
    const flagged = step({ state: initialState(), raised: [], needsHuman: true });
    expect(flagged.decision.kind).toBe("needsHuman");
    expect(flagged.state.needsHuman).toBe(true);

    const cleared = step({ state: flagged.state, raised: [], needsHuman: false });
    expect(cleared.state.needsHuman).toBe(false);
    expect(cleared.decision.kind).not.toBe("needsHuman");
  });

  it("keeps blocking while the caller still reports it open", () => {
    const flagged = step({ state: initialState(), raised: [], needsHuman: true });
    expect(step({ state: flagged.state, raised: [], needsHuman: true }).decision.kind).toBe("needsHuman");
  });

  // Hitting a bound is NOT a pass. A review that ran out of budget learned nothing
  // about the code it never reached.
  it("stops on the per-tier bound", () => {
    let s = initialState();
    for (let i = 0; i < 3; i++) s = step({ state: s, raised: [`f${i}`] }).state;
    const r = step({ state: s, raised: ["f9"] });
    expect(r.decision).toStrictEqual({ kind: "stopped", bound: "perTier" });
  });

  // The other half of that rule, and the one that cost a real review. The cap
  // bounds *going round again with the same tier*; a clean tier has stopped going
  // round. Checked alongside the global budget, it fell on the clean round too and
  // binned a result we had already paid 485s and 29 turns for.
  it("does not stop on the per-tier bound when the tier came back clean", () => {
    let s = initialState();
    for (let i = 0; i < 3; i++) s = step({ state: s, raised: [`f${i}`] }).state;
    expect(s.tierRounds["t1"]).toBe(3); // the next round is the one that used to stop

    const r = step({ state: s, raised: [] });
    expect(r.decision.kind).toBe("fastClean"); // escalates into the deep stage
    expect(r.state.tierRounds["t1"]).toBe(4); // over the cap, and that is fine
  });

  it("stops on the global bound", () => {
    let s = initialState();
    const limits = { perTierRounds: 99, globalRounds: 3 };
    for (let i = 0; i < 3; i++) s = step({ state: s, raised: [`f${i}`], limits }).state;
    const r = step({ state: s, raised: ["f9"], limits });
    expect(r.decision).toStrictEqual({ kind: "stopped", bound: "global" });
  });

  /**
   * THE BOUNDS COUNT ARGUING, NOT WORKING (D-114).
   *
   * Both used to count a review's whole life, which is right for a snapshot gate and
   * fatal for the incremental review D-112 opened up: a review that follows the work
   * accumulates rounds BECAUSE someone keeps feeding it, and would be stopped at twelve
   * for succeeding. New work restarts the count; nothing else does.
   */
  it("restarts the bounds when the client delivers work, and not otherwise", () => {
    let s = initialState();
    const limits = { perTierRounds: 99, globalRounds: 3 };
    for (let i = 0; i < 3; i++) s = step({ state: s, raised: [`f${i}`], limits }).state;

    // One round short of the wall, the client submits — so the ladder gets a full budget
    // for the new material rather than dying on the round that would have judged it.
    s = clientDeliveredWork(s);
    expect(s.workRound, "the floor is where the work arrived").toBe(3);
    expect(s.tierRounds, "and the per-tier counters go with it").toStrictEqual({});

    const after = step({ state: s, raised: ["f9"], limits });
    expect(after.decision.kind, "the round that used to be the wall").not.toBe("stopped");
    expect(after.state.round, "while the audit trail keeps counting up").toBe(4);
  });

  /**
   * THE REDUCER ONLY — the gate that decides WHEN to call it lives in `review_submit`,
   * and is held by `service/submit-gate.test.ts`, which drives the real tool against a
   * real worktree with a patch that applies and changes nothing.
   *
   * Named for that deliberately. This test first claimed to cover the no-op-submit fix
   * and covered the reducer it is implemented with, which is the "named for a property it
   * does not test" shape — and it would have stayed green through a refactor that dropped
   * the gate and reopened the unbounded loop.
   */
  it("moves the floor when told, and only then", () => {
    const s = { ...initialState(), round: 7 };
    expect(clientDeliveredWork(s).workRound, "told: the floor moves").toBe(7);
    // Not told — the shape of every no-op submit after the fix — leaves the floor where
    // it was, so the budget keeps counting down to a stop.
    expect(s.workRound, "not told: nothing moved").toBeUndefined();
  });

  /**
   * TERMINATION IS THE PROPERTY THIS MUST NOT COST. A review nobody feeds still stops,
   * and it stops in the same number of rounds it always did — the floor only moves when
   * work arrives, so a ladder arguing with itself gets exactly the old budget.
   */
  it("still stops when no work arrives, at the same distance from the floor", () => {
    const limits = { perTierRounds: 99, globalRounds: 3 };
    let s = clientDeliveredWork({ ...initialState(), round: 40 });
    for (let i = 0; i < 3; i++) s = step({ state: s, raised: [`f${i}`], limits }).state;
    expect(step({ state: s, raised: ["f9"], limits }).decision).toStrictEqual({
      kind: "stopped",
      bound: "global",
    });
  });

  // The whole design rests on this: whatever the reviewers do, the loop ends.
  //
  // Driven with a DIFFERENT input every round, because the dangerous case is not a
  // tier repeating itself — fingerprint dedup handles that — it is a tier that
  // PARAPHRASES. §3.1.1 says so outright: a re-worded claim hashes differently and
  // reads as fresh work, so dedup is not what bounds this loop; the per-tier and
  // global caps are. A constant `raised` set never tests the thing that holds.
  //
  // Deterministic PRNG so a failure reproduces from the seed printed with it.
  const lcg = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  it.each([1, 7, 42, 1337, 90210])("terminates under adversarial input (seed %i)", (seed) => {
    const rand = lcg(seed);
    let s = initialState();
    let decision: Decision = { kind: "findings" };
    let guard = 0;

    while (decision.kind === "findings" || decision.kind === "escalate" || decision.kind === "fastClean") {
      // Every round: sometimes clean, sometimes a rehash of settled work, and
      // sometimes an entirely new fingerprint — the paraphrase case.
      const roll = rand();
      const raised =
        roll < 0.3 ? [] : roll < 0.6 ? [...s.settled].slice(0, 2) : [`fresh-${guard}-${Math.floor(rand() * 1e6)}`];

      const r = step({
        state: s,
        raised,
        // A human question that opens and closes, and tiers that fall over.
        ...(rand() < 0.15 ? { needsHuman: true } : {}),
      });
      s = r.state;
      decision = r.decision;

      // Settling some of what was raised, as a real round does.
      if (rand() < 0.5 && raised.length > 0) s = settle(s, raised.slice(0, 1));

      if (++guard > 200) break;
    }

    expect(guard, `seed ${seed} did not terminate`).toBeLessThanOrEqual(200);
    expect(["passed", "passedPartial", "stopped", "needsHuman"]).toContain(decision.kind);
  });

  // The bound is not merely "eventually" — it is the global cap, and a paraphrasing
  // tier must hit it rather than wandering close to it.
  it("stops a tier that paraphrases for ever, at the global bound", () => {
    let s = initialState();
    let decision: Decision = { kind: "findings" };
    let round = 0;
    while (decision.kind === "findings" && round < 100) {
      const r = step({ state: s, raised: [`paraphrase-${round++}`] });
      s = r.state;
      decision = r.decision;
    }
    expect(decision.kind).toBe("stopped");
    if (decision.kind === "stopped") expect(["perTier", "global"]).toContain(decision.bound);
  });
});

describe("tiers nobody can pay for (D-48)", () => {
  it("steps over an unavailable tier instead of stopping", () => {
    // t2 unpayable: a clean t1 lands on t3, skipping the gap. The decision is
    // `fastClean` rather than `escalate` because t1→t3 still crosses the
    // fast→deep boundary — the stage transition is unaffected by the skip.
    const s = markUnavailable(initialState(), "t2");
    const r = step({ state: s, raised: [] });
    expect(DEFAULT_TIERS[r.state.cursor]?.id).toBe("t3");
    expect(r.decision.kind).toBe("fastClean");
  });

  /**
   * A SKIP ABOVE THE TIER THAT PASSED still costs the verdict, and this is the half
   * D-88 did not relax. Nothing read this code at t3's level, so "we did everything we
   * can" is the honest claim and "every tier agreed" is not.
   */
  it("reaches passedPartial when the skipped tier was ABOVE the one that passed", () => {
    let s = markUnavailable(initialState(), "t3");
    s = step({ state: s, raised: [] }).state; // t1 -> t2
    const r = step({ state: s, raised: [] });
    expect(r.decision).toStrictEqual({ kind: "passedPartial", skipped: ["t3"] });
  });

  /**
   * D-88. Vany: *"quota on t1 must allow to skip it and start t2. passing of t2 must
   * make t1 not needed."*
   *
   * The ladder is a gate — dearer tiers only see code the cheaper ones already passed —
   * so a cheaper tier's absence makes the review DEARER, not less certain. t2 and t3 read
   * everything t1 would have, and they are two distinct vendors, so D-49 has nothing to
   * say either.
   */
  it("reaches a full pass when the skipped tier was BELOW the ones that passed", () => {
    // Walked to the end rather than stepped a fixed number of times: `markUnavailable`
    // does not move the cursor, so how many steps this takes is an implementation detail
    // and hard-coding it makes the test pass for the wrong reason when it changes.
    let s = markUnavailable(initialState(), "t1");
    let d = step({ state: s, raised: [] }).decision;
    for (let i = 0; i < 6 && (d.kind === "fastClean" || d.kind === "escalate"); i++) {
      const r = step({ state: s, raised: [] });
      s = r.state;
      d = r.decision;
    }
    expect(d.kind, "t2 and t3 read it, and they are two distinct vendors").toBe("passed");
  });

  /**
   * THE TRAP UNDER D-88, and the reason the pivot is not the cursor.
   *
   * `runRound` promotes a dead tier's work by calling `step` with `raised: []`, so a tier
   * that FAILED arrives here looking exactly like one that came back clean — except for
   * its entry in `unavailable`. When that tier is the TOP one, the cursor sits on a tier
   * that never answered, and forgiving everything at or below the cursor would forgive
   * the failure itself and call the review `passed`. That is INV-1 inverted, inside the
   * change that relaxes the rule.
   */
  it("does not forgive the top tier's own failure just because the cursor is on it", () => {
    // Cursor 3 is t3, and t3 is what could not answer — the state `runRound` builds when
    // it promotes a dead top tier.
    const s = { ...markUnavailable(initialState(), "t3"), cursor: 3 };
    const r = step({ state: s, raised: [] });
    expect(r.decision.kind, "nothing read this code at t3's level").toBe("passedPartial");
  });

  it("still reaches a full pass when nothing was skipped", () => {
    let s = initialState();
    s = step({ state: s, raised: [] }).state;
    s = step({ state: s, raised: [] }).state;
    expect(step({ state: s, raised: [] }).decision.kind).toBe("passed");
  });

  // Nothing steps BACK any more, so an unpayable tier below the cursor is simply not
  // in the way. The cursor stays where the finding was raised, whatever is unavailable
  // beneath it.
  it("does not step back over an unavailable tier after a fix", () => {
    const atT2 = clean(initialState()).state;
    const s = markUnavailable(atT2, "t1");
    const r = step({ state: s, raised: ["new"] });
    expect(DEFAULT_TIERS[r.state.cursor]?.id).toBe("t2");
  });

  // If nothing could run there is no review, and calling that a partial pass is
  // exactly the "did not run reported as found nothing" INV-1 forbids.
  it("knows when no tier could run at all", () => {
    expect(anyTierRan(DEFAULT_TIERS, ["t1", "t2", "t3"])).toBe(false);
    expect(anyTierRan(DEFAULT_TIERS, ["t1", "t2"])).toBe(true);
  });

  it("does not record the same tier twice", () => {
    const s = markUnavailable(markUnavailable(initialState(), "t2"), "t2");
    expect(s.unavailable).toStrictEqual(["t2"]);
  });
});

// The reviewer that found this was right: loadTiers warned about a single-vendor
// ladder and then let the review pass anyway, which made the warning decorative.
describe("single-vendor ladders cannot pass (D-49)", () => {
  const ONE_VENDOR: readonly Tier[] = [
    { id: "t0", kind: "deterministic", stage: "fast" },
    { id: "t1", kind: "model", model: "zai-coding-plan/glm-4.7", effort: "medium", stage: "fast" },
    { id: "t2", kind: "model", model: "zai-coding-plan/glm-5.2", effort: "high", stage: "deep" },
    { id: "t3", kind: "model", model: "zai-coding-plan/glm-5.2", effort: "max", stage: "deep" },
  ];

  const runClean = (tiers: readonly Tier[]) => {
    let s = initialState(tiers);
    let d = step({ state: s, raised: [], tiers }).decision;
    for (let i = 0; i < 5 && (d.kind === "fastClean" || d.kind === "escalate"); i++) {
      const r = step({ state: s, raised: [], tiers });
      s = r.state;
      d = r.decision;
    }
    return d;
  };

  it("reaches passedPartial naming the vendor, never passed", () => {
    expect(runClean(ONE_VENDOR)).toStrictEqual({
      kind: "passedPartial",
      skipped: [],
      soleVendor: "z-ai",
      // `soleVendor` is kept and still means what it always did — every tier was one
      // vendor. It is now the extreme case of the spread beside it, so a client reading
      // the old field is never told anything false.
      vendorSpread: { distinct: 1, tiers: 3, vendors: ["z-ai"] },
    });
  });

  /**
   * TWO VENDORS ACROSS THREE TIERS IS ALSO NOT THREE OPINIONS (D-49, widened 2026-08-17).
   *
   * The rule asked only "are they ALL the same", so the whole range between three
   * independent opinions and one opinion asked three times was worth nothing to the
   * verdict. D-117 made that range the common case: when a subscription dies the free
   * fallback is by construction another plan from a vendor already in the ladder, because
   * that is why it is free.
   *
   * Observed on lore's own review of D-121, which passed CLEAN on exactly this shape:
   * t1 `zai-coding-plan/glm-5.3` and t2 answered by `zai-coding-plan2/glm-5.2` are both
   * z-ai, t3 was OpenAI. Vany, asked what it should be worth: downgrade on any collapse.
   */
  it("refuses a clean pass when two tiers shared a vendor and a third did not", () => {
    const TWO_OF_THREE: readonly Tier[] = [
      { id: "t0", kind: "deterministic", stage: "fast" },
      { id: "t1", kind: "model", model: "zai-coding-plan/glm-5.3", effort: "medium", stage: "fast" },
      { id: "t2", kind: "model", model: "zai-coding-plan2/glm-5.2", effort: "high", stage: "deep" },
      { id: "t3", kind: "model", model: "openai/gpt-5.6-terra", effort: "high", stage: "deep" },
    ];
    const d = runClean(TWO_OF_THREE);
    expect(d.kind, "two opinions, three tiers").toBe("passedPartial");
    // NOT `soleVendor`: it would be a lie here, and the old field keeps its old meaning.
    expect(d).not.toHaveProperty("soleVendor");
    expect(d).toHaveProperty("vendorSpread", { distinct: 2, tiers: 3, vendors: ["z-ai", "openai"] });
  });

  /**
   * A TIER THAT RAN ON TWO VENDORS GOT TWO OPINIONS, and the old accounting forgot one.
   *
   * `answeredBy` is last-write-wins — it exists so a warm session is not abandoned, and it
   * must forget. Independence borrowed it and inherited the forgetting: a tier that ran on
   * Kimi for five rounds and Z.ai for two reported only Z.ai, so the verdict claimed a
   * collapse most of the review did not have. Reverse the order and it claims three
   * independent opinions while one vendor read the code twice. Wrong in both directions,
   * and invisible from outside the service.
   *
   * `readBy` accumulates, so the union is the answer. Vany, asked what independence should
   * be measured over: every vendor that read the review.
   */
  it("counts a vendor that read at some point, not only the one currently on the tier", () => {
    const THREE: readonly Tier[] = [
      { id: "t0", kind: "deterministic", stage: "fast" },
      { id: "t1", kind: "model", model: "zai-coding-plan/glm-5.3", effort: "medium", stage: "fast" },
      { id: "t2", kind: "model", model: "kimi-for-coding/k3", effort: "high", stage: "deep" },
      { id: "t3", kind: "model", model: "openai/gpt-5.6-terra", effort: "high", stage: "deep" },
    ];
    // Rounds 1-5: t2 answered on its own Kimi plan. Round 6: the plan died and Z.ai covered
    // for it. `answeredBy` is last-write-wins, so it now says z-ai and has forgotten
    // Moonshot entirely — which is correct for stickiness and wrong for independence.
    let s = initialState(THREE);
    s = markAnsweredBy(s, "t2", "kimi-for-coding/k3");
    s = markAnsweredBy(s, "t2", "zai-coding-plan2/glm-5.2");

    expect(
      vendorCollapse(THREE, [], s.answeredBy ?? {}),
      "read through the forgetting field alone, this looks like a collapse",
    ).toBeDefined();

    expect(
      vendorCollapse(THREE, [], s.answeredBy ?? {}, s.readBy ?? {}),
      "but Moonshot did read this code, so three vendors did",
    ).toBeUndefined();
  });

  /**
   * A LADDER OF ONE MODEL TIER HAS ONE VENDOR BY CONSTRUCTION, and that is not a collapse.
   *
   * `distinct < tiers` would have been the obvious test and would have refused `passed` to
   * every single-tier configuration for a property it cannot have. The collapse is a
   * REPEAT — the same vendor reading the code twice.
   */
  it("does not punish a one-tier ladder for having one vendor", () => {
    const ONE_TIER: readonly Tier[] = [
      { id: "t0", kind: "deterministic", stage: "fast" },
      { id: "t1", kind: "model", model: "openai/gpt-5.6-terra", effort: "high", stage: "fast" },
    ];
    expect(runClean(ONE_TIER).kind).toBe("passed");
  });

  it("still passes outright when the vendors really are distinct", () => {
    expect(runClean(DEFAULT_TIERS).kind).toBe("passed");
  });

  // The question is whose opinion we actually got, not whose we configured. A
  // three-vendor ladder with two tiers unpayable really did get one vendor's view,
  // and saying otherwise counts work nobody did (INV-1).
  it("counts vendors among tiers that could run, not tiers that were configured", () => {
    expect(soleVendorOf(DEFAULT_TIERS)).toBeUndefined();
    expect(soleVendorOf(DEFAULT_TIERS, ["t2", "t3"])).toBe("z-ai");
  });

  it("reports both weaknesses at once when a tier was also skipped", () => {
    let s = markUnavailable(initialState(ONE_VENDOR), "t3");
    s = step({ state: s, raised: [], tiers: ONE_VENDOR }).state; // t1 -> t2
    expect(step({ state: s, raised: [], tiers: ONE_VENDOR }).decision).toStrictEqual({
      kind: "passedPartial",
      skipped: ["t3"],
      soleVendor: "z-ai",
      vendorSpread: { distinct: 1, tiers: 2, vendors: ["z-ai"] },
    });
  });

  it("carries the vendor in the state, so the attestation can name it", () => {
    expect(initialState(ONE_VENDOR).soleVendor).toBe("z-ai");
    expect(initialState(DEFAULT_TIERS).soleVendor).toBeUndefined();
  });
});

describe("vendorOf", () => {
  // Two id shapes, vendor in a different position in each. Reading position 1
  // blindly compares glm-4.7 against glm-5.2 and calls them different vendors —
  // silently disabling the single-vendor warning, which is the whole point of it.
  it("reads the vendor from a gateway-qualified id", () => {
    expect(vendorOf("openrouter/z-ai/glm-5.2")).toBe("z-ai");
    expect(vendorOf("openrouter/moonshotai/kimi-k3")).toBe("moonshotai");
  });

  // The POSITION rule, pinned on an id no alias touches, so this keeps testing the parse
  // rather than the alias table.
  it("reads the vendor from a direct id", () => {
    expect(vendorOf("acme/model-1")).toBe("acme");
    expect(vendorOf("gateway/acme/model-1")).toBe("acme");
  });

  /**
   * ONE VENDOR REACHED UNDER SEVERAL NAMES IS STILL ONE VENDOR.
   *
   * A subscription and the same company's OpenRouter listing are different strings for
   * one trainer, and two subscriptions to that company are the same again — a second plan
   * buys quota, not a second opinion.
   *
   * Harmless while only CONFIGURED models were compared, because those names are stable.
   * The moment fallbacks fed into the count (`answeredBy`), a tier falling back to its own
   * OpenRouter twin changed the string it contributed — so an all-Z.AI ladder could count
   * two vendors and allow `passed`. That is this function's own failure, reached through
   * the door the fallback list opened.
   */
  it("folds a vendor's several names onto one", () => {
    expect(vendorOf("zai-coding-plan/glm-5.2")).toBe("z-ai");
    expect(vendorOf("openrouter/z-ai/glm-5.2")).toBe("z-ai");
    expect(vendorOf("zai/glm-5.2")).toBe("z-ai");
    expect(vendorOf("kimi-for-coding/k3")).toBe("moonshotai");
    expect(vendorOf("openrouter/moonshotai/kimi-k3")).toBe("moonshotai");
    // A SECOND SUBSCRIPTION to the same company is not a second vendor.
    expect(vendorOf("zai-coding-plan2/glm-5.2")).toBe("z-ai");
  });

  /**
   * AN UNKNOWN ID STANDS FOR ITSELF, which over-counts vendors rather than under-counting
   * them. Guessing that two ids are one company because they look alike is how a rule
   * that has to be exactly right becomes approximately right; the safe direction for a
   * rule that gates `passed` is the one that says "not independent".
   */
  it("leaves an id it does not know alone", () => {
    expect(vendorOf("some-new-plan/some-model")).toBe("some-new-plan");
  });

  it("sees two GLM models from one vendor as one vendor", () => {
    expect(new Set(["zai/glm-4.7", "zai/glm-5.2"].map(vendorOf)).size).toBe(1);
  });
});

describe("loadTiers", () => {
  it("falls back to the default ladder when unconfigured", () => {
    expect(loadTiers("")).toStrictEqual(DEFAULT_TIERS);
    expect(loadTiers(undefined)).toStrictEqual(DEFAULT_TIERS);
  });

  it("accepts inline JSON", () => {
    const tiers = loadTiers('[{"id":"t0","kind":"deterministic","stage":"fast"},{"id":"t1","kind":"model","model":"zai/glm-5.2","stage":"fast"}]');
    expect(tiers.map((t) => t.id)).toStrictEqual(["t0", "t1"]);
  });

  // Falling back to the default on a malformed config would review with a
  // different set of models than the operator configured — a divergence nobody
  // notices until the bill or the findings look wrong.
  it("throws rather than falling back to the default", () => {
    expect(() => loadTiers('[{"id":"t1","kind":"model","stage":"fast"}]')).toThrow(/must name a model/);
    expect(() => loadTiers('[{"id":"t0","kind":"deterministic","stage":"fast"}]')).toThrow(/no model tier/);
    expect(() => loadTiers("[]")).toThrow();
  });

  it("rejects keys it does not know, rather than ignoring them", () => {
    expect(() =>
      loadTiers('[{"id":"t1","kind":"model","model":"zai/glm-5.2","stage":"fast","temperature":0.7}]'),
    ).toThrow();
  });
});

describe("settle", () => {
  it("accumulates without duplicating", () => {
    const s = settle(settle(initialState(), ["a", "b"]), ["b", "c"]);
    expect([...s.settled].sort()).toStrictEqual(["a", "b", "c"]);
  });
});

/**
 * A PIN'S FORMAT CHANGING IS NOT A LADDER CHANGING.
 *
 * The pin exists so a review cannot resume on a different reviewer wearing the same tier
 * name — `tier_run` records only the id, so that would corrupt the audit trail rather
 * than merely crash. Refusing is deliberately expensive, which is why it must be right.
 *
 * Adding `effort` and `stage` to the pin refused every review open at the deploy,
 * including one that had cost half an evening of model time on this repository. The
 * tiers were identical; only the spelling had grown. The comment above
 * `ladderFingerprint` warned about this exact shape two lines before the code that did it.
 */
describe("comparing a stored ladder pin with the running one", () => {
  const OLD = "t0:deterministic,t1:zai/glm,t2:kimi/k3";
  const NEW = "t0:deterministic:-:fast,t1:zai/glm:medium:fast,t2:kimi/k3:high:deep";

  it("does not refuse a pin that merely gained fields", () => {
    expect(ladderChanged(OLD, NEW)).toBe(false);
  });

  it("still refuses a tier repointed at another model, at either format", () => {
    expect(ladderChanged(OLD, "t0:deterministic:-:fast,t1:openai/gpt:medium:fast,t2:kimi/k3:high:deep")).toBe(true);
    expect(ladderChanged(NEW, "t0:deterministic:-:fast,t1:openai/gpt:medium:fast,t2:kimi/k3:high:deep")).toBe(true);
  });

  it("still refuses a tier renamed", () => {
    expect(ladderChanged(OLD, "t0:deterministic:-:fast,tA:zai/glm:medium:fast,t2:kimi/k3:high:deep")).toBe(true);
  });

  // A gained or lost tier moves every cursor after it, which is the corruption the whole
  // check exists for — so the count matters at any format.
  it("refuses a ladder that gained or lost a tier", () => {
    expect(ladderChanged(OLD, `${NEW},t3:openai/terra:high:deep`)).toBe(true);
    expect(ladderChanged(OLD, "t0:deterministic:-:fast,t1:zai/glm:medium:fast")).toBe(true);
  });

  // The fields the NEW pin added are compared once both sides have them: that is the
  // whole point of adding them, and D-29 makes effort a deliberate lever.
  it("refuses an effort change once both pins record it", () => {
    expect(ladderChanged(NEW, NEW.replace("medium", "max"))).toBe(true);
  });
});

/**
 * `skip_if_quota` — optional, and absent means exactly what it meant before.
 *
 * A retry only pays for itself when the fault might be transient, and an exhausted plan
 * is not: Z.ai answers "Weekly/Monthly Limit Exhausted, resets at …", which does not
 * become untrue by asking again. Each attempt costs the full deadline, so on a metered
 * subscription the retry is 45 minutes of wall-clock spent to re-learn a fact with a
 * published expiry date.
 */
describe("skip_if_quota in the tier config", () => {
  const tier = (extra: string) => `[{"id":"t0","kind":"deterministic","stage":"fast"},
    {"id":"t1","kind":"model","model":"zai/glm","stage":"fast"${extra}},
    {"id":"t2","kind":"model","model":"kimi/k3","stage":"deep"}]`;

  it("is accepted and read back", () => {
    const tiers = loadTiers(tier(`,"skip_if_quota":true`));
    expect(tiers.find((t) => t.id === "t1")?.skip_if_quota).toBe(true);
  });

  // Optional: every ladder written before this field keeps working unchanged, which is
  // the whole reason it is not mandatory.
  it("is absent by default rather than false", () => {
    expect(loadTiers(tier(""))?.find((t) => t.id === "t1")?.skip_if_quota).toBeUndefined();
  });

  it("is still refused when it is not a boolean", () => {
    expect(() => loadTiers(tier(`,"skip_if_quota":"yes"`))).toThrow(/malformed/i);
  });

  /**
   * NOT IN THE PIN, deliberately.
   *
   * `ladderFingerprint` refuses to resume a review whose tiers changed meaning — a
   * different model wearing the same name. This changes neither which model is called nor
   * how it is asked, so pinning it would refuse every open review at the next config
   * change over a policy the review does not depend on. That is the failure the pin
   * itself caused on 2026-08-08 when `effort` was added to it.
   */
  it("does not change the ladder pin", () => {
    const withFlag = loadTiers(tier(`,"skip_if_quota":true`));
    const without = loadTiers(tier(""));
    expect(ladderFingerprint([...withFlag])).toBe(ladderFingerprint([...without]));
  });
});

describe("the conversation flag", () => {
  const tier = (extra: string) => `[{"id":"t0","kind":"deterministic","stage":"fast"},
    {"id":"t1","kind":"model","model":"m","stage":"fast"${extra}}]`;

  it("is carried through, and absent when unset", () => {
    expect(loadTiers(tier(`,"conversation":true`))[1]?.conversation).toBe(true);
    expect(loadTiers(tier(""))[1]?.conversation).toBeUndefined();
  });

  it("is refused when it is not a boolean", () => {
    expect(() => loadTiers(tier(`,"conversation":"yes"`))).toThrow(/malformed/i);
  });

  /**
   * NOT IN THE PIN, for the same reason `skip_if_quota` is not: it changes neither which
   * model is called nor what it is asked, only whether that model keeps its session
   * between rounds. Pinning it would refuse every open review the moment the flag was
   * flipped — and a review that loses its session map falls back to a cold start anyway,
   * which is the behaviour the pin would be protecting.
   */
  it("does not change the ladder pin", () => {
    expect(ladderFingerprint([...loadTiers(tier(`,"conversation":true`))]))
      .toBe(ladderFingerprint([...loadTiers(tier(""))]));
  });
});

/**
 * THE LADDERS WE ACTUALLY DEPLOY, PARSED BY THE PARSER THAT WILL PARSE THEM.
 *
 * `loadTiers` throws on a malformed ladder rather than falling back to the default, which
 * is right — reviewing with a different set of models than the operator configured is the
 * divergence nobody notices until the bill looks wrong. The consequence is that a typo in
 * a deploy file is a boot failure, and the suite never read those files, so the whole
 * class was invisible until the container was already restarting.
 *
 * Caught here in the act: adding `conversation` to the deploy configs before the schema
 * knew the key would have crash-looped the service on the next deploy — `.strict()` calls
 * an unknown key malformed. That is the same shape as the LORE_CONCURRENCY loop earlier
 * the same day, which took the service down for twenty minutes.
 *
 * Every file, by directory listing rather than by name: a config nobody remembered to add
 * here is exactly the one that breaks.
 */
describe("the shipped ladders", () => {
  const files = readdirSync("deploy").filter((f) => f.startsWith("tiers.") && f.endsWith(".json"));

  it("finds some to check", () => {
    expect(files.length, "a rename that empties this list would make every test below vacuous").toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} loads, and every model tier is complete`, () => {
      const tiers = loadTiers(`deploy/${f}`);
      expect(tiers.length).toBeGreaterThan(0);
      for (const t of tiers) {
        if (t.kind === "model") expect(t.model, `${t.id} names no model`).toBeTruthy();
      }
    });
  }
});

/**
 * A CHAIN OF FALLBACKS, and the two ways to write one wrong.
 *
 * The list arrived on 2026-08-12 because a single twin stopped being enough: OpenRouter
 * ran to zero and every deep tier's only spare route was as out as the plan it covered.
 */
describe("the fallback list", () => {
  const tier = (fallback: string) => `[{"id":"t0","kind":"deterministic","stage":"fast"},
    {"id":"t1","kind":"model","model":"a/one","stage":"fast","fallback":${fallback}}]`;

  it("keeps the order it was written in", () => {
    expect(loadTiers(tier(`["b/two","c/three"]`))[1]?.fallback).toStrictEqual(["b/two", "c/three"]);
  });

  /**
   * THE OLD SHAPE STILL LOADS. `loadTiers` throws on anything malformed, so refusing a
   * bare string outright would turn a stale `LORE_TIERS` into a boot crash-loop — which
   * this repository did to itself once already this week over exactly this kind of key.
   * Normalised at load, so nothing downstream ever sees two shapes.
   */
  it("accepts the single string it used to be, as a one-entry list", () => {
    expect(loadTiers(tier(`"b/two"`))[1]?.fallback).toStrictEqual(["b/two"]);
  });

  it("is absent when it is not configured", () => {
    const plain = `[{"id":"t0","kind":"deterministic","stage":"fast"},
      {"id":"t1","kind":"model","model":"a/one","stage":"fast"}]`;
    expect(loadTiers(plain)[1]?.fallback).toBeUndefined();
  });

  /**
   * A ROUTE CANNOT COVER FOR ITSELF. The chain is only walked because a provider said
   * QUOTA, so the tier's own model can only refuse again — a real call spent buying a
   * certainty, in the outage the list was written for. I wrote exactly this into a deploy
   * ladder while adding the feature, which is why it is refused rather than filtered.
   */
  it("refuses a tier that lists its own model", () => {
    expect(() => loadTiers(tier(`["a/one"]`))).toThrow(/fallback for itself|twice over/i);
  });

  it("refuses the same route named twice", () => {
    expect(() => loadTiers(tier(`["b/two","b/two"]`))).toThrow(/twice over|fallback for itself/i);
  });

  it("refuses an empty list, which is a configuration that means nothing", () => {
    expect(() => loadTiers(tier(`[]`))).toThrow(/malformed/i);
  });
});

/**
 * INDEPENDENCE IS ABOUT WHO READ THE CODE, not about who the config named.
 *
 * The two agreed for as long as every fallback was the same model by another route: a
 * kimi tier answered by kimi-through-OpenRouter is still kimi's opinion. They stopped
 * agreeing on 2026-08-12, when a fallback chain was allowed to end at a DIFFERENT model on
 * a plan that is still paying — and the deployed ladder now has both deep tiers ending at
 * `zai-coding-plan/glm-5.2`, which is the model t1 already runs.
 *
 * So a fully degraded ladder is one model asked three times, while the tier list still
 * reads as three vendors. `passed` in that state is this product's central claim, false.
 */
describe("the vendor behind a review is the one that answered", () => {
  const THREE: readonly Tier[] = [
    { id: "t0", kind: "deterministic", stage: "fast" },
    { id: "t1", kind: "model", model: "zai-coding-plan/glm-5.2", stage: "fast" },
    { id: "t2", kind: "model", model: "kimi-for-coding/k3", stage: "deep" },
    { id: "t3", kind: "model", model: "openai/gpt-5.6-terra", stage: "deep" },
  ];

  it("reads three vendors when each tier ran on its own model", () => {
    expect(soleVendorOf(THREE)).toBeUndefined();
  });

  it("sees ONE vendor when every deep tier fell back to the model t1 runs", () => {
    const answeredBy = { t2: "zai-coding-plan/glm-5.2", t3: "zai-coding-plan/glm-5.2" };
    expect(
      soleVendorOf(THREE, [], answeredBy),
      "three tiers, one model, and the config still says three vendors",
    ).toBe(vendorOf("zai-coding-plan/glm-5.2"));
  });

  // The ordinary day: a tier that answered on its own model records nothing, so an
  // absent map has to mean exactly what it meant before this existed.
  it("is unchanged by an empty map, and by a state that predates it", () => {
    expect(soleVendorOf(THREE, [], {})).toBeUndefined();
    expect(soleVendorOf(THREE)).toBeUndefined();
  });

  /**
   * A tier answered by the SAME vendor through another route does not change the count —
   * which is the case the original check was right about, and the reason it stood for as
   * long as it did.
   */
  it("still reads three when a tier used its own model's twin", () => {
    expect(soleVendorOf(THREE, [], { t2: "openrouter/moonshotai/kimi-k3" })).toBeUndefined();
  });

  /**
   * THE HOLE THE FALLBACK LIST OPENED, closed by folding a vendor's names together.
   *
   * Every tier here is Z.AI, so this ladder is one opinion however it runs. With t2
   * answered through OpenRouter its string became `z-ai` while t1's stayed
   * `zai-coding-plan` — two names, one company, and `soleVendorOf` would have reported
   * "independent enough" and allowed `passed`.
   */
  it("is not fooled by one vendor reached through two routes", () => {
    const ALL_ZAI: readonly Tier[] = [
      { id: "t1", kind: "model", model: "zai-coding-plan/glm-5-turbo", stage: "fast" },
      { id: "t2", kind: "model", model: "zai-coding-plan/glm-5.2", stage: "deep" },
    ];
    expect(soleVendorOf(ALL_ZAI), "configured, it was always one vendor").toBe("z-ai");
    expect(
      soleVendorOf(ALL_ZAI, [], { t2: "openrouter/z-ai/glm-5.2" }),
      "and falling back to the same company's gateway does not make it two",
    ).toBe("z-ai");
  });

  it("records the answering model without disturbing the rest of the state", () => {
    const before = initialState(THREE);
    const after = markAnsweredBy(before, "t2", "zai-coding-plan/glm-5.2");
    expect(after.answeredBy).toStrictEqual({ t2: "zai-coding-plan/glm-5.2" });
    expect(after.cursor).toBe(before.cursor);
    expect(after.settled).toStrictEqual(before.settled);
    // Two tiers falling back accumulate rather than replace.
    expect(markAnsweredBy(after, "t3", "zai-coding-plan/glm-5.2").answeredBy).toStrictEqual({
      t2: "zai-coding-plan/glm-5.2",
      t3: "zai-coding-plan/glm-5.2",
    });
  });
});

/**
 * A NICKNAME IS THE MODEL; THE LIST IS THE ROUTES TO IT.
 *
 * Two subscriptions to one company are one reviewer reachable two ways — the same
 * opinion, twice the quota. `fallback` could not express that: it had to carry both "the
 * same model somewhere else" and "something else entirely", with position as the only
 * hint which was meant.
 */
describe("model pools", () => {
  const file = (models: string, tierModel: string) => `{
    "models": ${models},
    "tiers": [{"id":"t0","kind":"deterministic","stage":"fast"},
              {"id":"t1","kind":"model","model":"${tierModel}","stage":"fast"}]
  }`;
  const POOL = `{"GLM5.2": ["zai-coding-plan/glm-5.2", "zai-coding-plan2/glm-5.2"]}`;

  it("loads a ladder that defines pools, and one that does not", () => {
    expect(loadPools(file(POOL, "GLM5.2"))["GLM5.2"]).toStrictEqual([
      "zai-coding-plan/glm-5.2",
      "zai-coding-plan2/glm-5.2",
    ]);
    // The bare-array shape every deployed config had before nicknames still loads, and
    // brings no pools. Refusing it would turn a stale LORE_TIERS into a boot crash-loop.
    expect(loadPools(`[{"id":"t0","kind":"deterministic","stage":"fast"},
      {"id":"t1","kind":"model","model":"a/one","stage":"fast"}]`)).toStrictEqual({});
  });

  it("expands a tier's nickname to its routes, and a plain id to itself", () => {
    const pools = { GLM5: ["p1/glm", "p2/glm"] };
    const tier = (model: string): Tier => ({ id: "t1", kind: "model", model, stage: "fast" });
    expect(routesFor(tier("GLM5"), pools)).toStrictEqual(["p1/glm", "p2/glm"]);
    expect(routesFor(tier("openrouter/z-ai/glm-5.2"), pools)).toStrictEqual(["openrouter/z-ai/glm-5.2"]);
  });

  /**
   * A MISTYPED NICKNAME WOULD OTHERWISE BE HANDED TO OPENCODE as a model id and come back
   * as a provider error in the middle of somebody's review — the same fault the startup
   * fallback check exists to pull forward to a moment when someone is watching.
   */
  it("refuses a tier that names a pool which does not exist", () => {
    expect(() => loadTiers(file(POOL, "GLM52"))).toThrow(/neither a provider\/model id nor one of the defined pools/);
  });

  // Only where nicknames exist: a ladder with no pools has none to mistype, and its model
  // ids are whatever they have always been.
  it("leaves a pool-less ladder's model ids alone", () => {
    expect(() => loadTiers(`[{"id":"t0","kind":"deterministic","stage":"fast"},
      {"id":"t1","kind":"model","model":"m","stage":"fast"}]`)).not.toThrow();
  });

  it("refuses a route listed twice in one pool", () => {
    expect(() => loadTiers(file(`{"GLM5.2": ["p/glm", "p/glm"]}`, "GLM5.2"))).toThrow(/same route twice/);
  });

  it("refuses a pool entry that is not a provider/model id", () => {
    expect(() => loadTiers(file(`{"GLM5.2": ["glm"]}`, "GLM5.2"))).toThrow(/not a provider\/model id/);
  });

  /**
   * EVERY ORDER, AND NO ROUTE LOST. Random is the honest policy because nothing publishes
   * how much of a subscription is left; what must not happen is a shuffle that drops or
   * duplicates a route, which is how a "random" pick quietly becomes a fixed one.
   */
  it("shuffles without losing or duplicating a route", () => {
    const routes = ["a/1", "b/2", "c/3", "d/4"];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const out = poolOrder(routes);
      expect([...out].sort()).toStrictEqual([...routes].sort());
      seen.add(out.join(","));
    }
    expect(seen.size, "200 shuffles of four routes should not all agree").toBeGreaterThan(1);
  });

  it("is deterministic when the randomness is", () => {
    expect(poolOrder(["a/1", "b/2", "c/3"], () => 0)).toStrictEqual(poolOrder(["a/1", "b/2", "c/3"], () => 0));
    expect(poolOrder(["a/1"], () => 0.99)).toStrictEqual(["a/1"]);
    expect(poolOrder([], () => 0.5)).toStrictEqual([]);
  });
});

/**
 * OPTIMISTIC UNTIL A PROVIDER SAYS OTHERWISE.
 *
 * Vany: *"at the start assume all connections have quota, and clarify if it is; and if it
 * is not, what time of release when it rejects to work."* Nothing here is inferred from a
 * plan's name or the calendar — a route is believed good until a call to it refuses, and
 * the refusal carries the time it comes back.
 */
describe("which routes are believed to have quota", () => {
  const R = ["p1/glm", "p2/glm", "p3/glm"];
  const NOW = "2026-08-12T12:00:00.000Z";
  const LATER = "2026-08-12T18:00:00.000Z";
  const EARLIER = "2026-08-12T13:00:00.000Z";
  const PAST = "2026-08-12T09:00:00.000Z";

  it("believes every route nobody has seen refuse", () => {
    expect(withQuota(R, () => undefined, NOW)).toStrictEqual({ usable: R });
  });

  it("drops a route a provider said is out until later", () => {
    const known = (m: string) => (m === "p2/glm" ? { until: LATER, stated: true } : undefined);
    expect(withQuota(R, known, NOW).usable).toStrictEqual(["p1/glm", "p3/glm"]);
  });

  it("takes a route back once its stated reset has passed", () => {
    const known = (m: string) => (m === "p2/glm" ? { until: PAST, stated: true } : undefined);
    expect(withQuota(R, known, NOW).usable).toStrictEqual(R);
  });

  /**
   * A GUESSED BACKOFF PARKS THE ROUTE TOO — Vany: *"I do not want a regular check for
   * quota if nothing happens."* The first version held D-90's tier rule here (a guess may
   * not skip a call), and the measured price was two refused kimi calls per t2 round,
   * every round, to learn nothing. Skipping a ROUTE loses no coverage while a twin or a
   * fallback answers; the recheck is the backoff expiring, not a schedule.
   */
  it("parks a route whose refusal named no reset, until the backoff passes", () => {
    const guessed = (m: string) => (m === "p2/glm" ? { until: LATER, stated: false } : undefined);
    expect(withQuota(R, guessed, NOW).usable).toStrictEqual(["p1/glm", "p3/glm"]);
    // And hands it back the moment the backoff has run out — that IS the recheck.
    const expired = (m: string) => (m === "p2/glm" ? { until: PAST, stated: false } : undefined);
    expect(withQuota(R, expired, NOW).usable).toStrictEqual(R);
  });

  /**
   * WHEN NOTHING IS LEFT, SAY WHEN IT COMES BACK. That is the answer to "we have no model
   * for this" that a reader can act on, and it is the EARLIEST of them — the first moment
   * the tier can run again, not the last.
   */
  it("reports the soonest release when every route is out", () => {
    const known = (m: string) => ({ until: m === "p2/glm" ? EARLIER : LATER, stated: true });
    expect(withQuota(R, known, NOW)).toStrictEqual({ usable: [], until: EARLIER });
  });

  it("offers no time while any route can still be asked", () => {
    const known = (m: string) => (m === "p1/glm" ? { until: LATER, stated: true } : undefined);
    expect(withQuota(R, known, NOW).until).toBeUndefined();
  });
});

/**
 * WHAT THE STARTUP CHECK ASKS OPENCODE ABOUT (D-93).
 *
 * It asked with the raw config entries until a fallback named a pool — then it asked
 * after `GLM5.2`, which is not a model id, and ticketed that opencode could not reach it.
 * A check that cries wolf about a healthy fallback is worse than no check at all.
 */
describe("the routes a ladder's fallbacks can reach", () => {
  const pools = { "GLM5.2": ["zai-coding-plan/glm-5.2", "zai-coding-plan2/glm-5.2"] };
  const tiers: readonly Tier[] = [
    { id: "t0", kind: "deterministic", stage: "fast" },
    { id: "t1", kind: "model", model: "GLM5.2", stage: "fast", fallback: ["openrouter/z-ai/glm-5.2"] },
    { id: "t2", kind: "model", model: "kimi-for-coding/k3", stage: "deep", fallback: ["openrouter/moonshotai/kimi-k3", "GLM5.2"] },
  ];

  it("expands a nickname and never reports the nickname itself", () => {
    const out = fallbackRoutes(tiers, pools);
    expect(out).toContain("zai-coding-plan2/glm-5.2");
    expect(out, "a nickname is not something opencode can be asked about").not.toContain("GLM5.2");
    expect(out).toContain("openrouter/moonshotai/kimi-k3");
  });

  it("names each route once, however many tiers reach for it", () => {
    expect(new Set(fallbackRoutes(tiers, pools)).size).toBe(fallbackRoutes(tiers, pools).length);
  });

  it("is empty for a ladder that configures no fallback", () => {
    expect(fallbackRoutes([{ id: "t1", kind: "model", model: "a/one", stage: "fast" }], {})).toStrictEqual([]);
  });
});

/**
 * ONE ROUTE FOR THE CALLERS THAT ARE NOT A ROUND — the screen, the bootstrap survey, the
 * proposer. Each of them hands one model id to opencode, and a pool NAME is not one.
 */
describe("resolving a tier to one concrete route", () => {
  const pools = { "GLM5.2": ["zp1/glm-5.2", "zp2/glm-5.2"] };
  const tier = (model: string): Tier => ({ id: "t1", kind: "model", model, stage: "fast" });

  it("hands a concrete model through untouched", () => {
    expect(concreteRoute(tier("a/one"), pools, () => undefined)).toBe("a/one");
  });

  it("resolves a nickname to one of its routes", () => {
    const out = concreteRoute(tier("GLM5.2"), pools, () => undefined);
    expect(["zp1/glm-5.2", "zp2/glm-5.2"]).toContain(out);
  });

  it("avoids a parked route, and answers undefined when everything is", () => {
    const parked = (m: string) => (m === "zp1/glm-5.2" ? { until: "2126-01-01T00:00:00.000Z", stated: false } : undefined);
    expect(concreteRoute(tier("GLM5.2"), pools, parked)).toBe("zp2/glm-5.2");
    const all = () => ({ until: "2126-01-01T00:00:00.000Z", stated: false });
    expect(concreteRoute(tier("GLM5.2"), pools, all), "no model for this, said as undefined").toBeUndefined();
  });

  /**
   * THE OTHER INDIRECTION THAT PRODUCES A PAID ROUTE (D-117).
   *
   * Gating `runRound` alone left this open, and its callers are the hourly screen, the
   * bootstrap survey and `propose` (proposer AND critics) — none of which has any reason
   * to think about money. Every one of them could hand opencode a metered route while the
   * deployment was documented as never paying, once an hour, indefinitely, silently.
   */
  const metered = { "GLM5.2": ["zp1/glm-5.2", "openrouter/z-ai/glm-5.2"] };

  it("does not pick a metered pool route unless the operator allowed it", () => {
    // The free sibling is parked, so the metered one is the ONLY route left — which is
    // the dead-subscription case, and the one where the old code always paid.
    const parked = (m: string) => (m === "zp1/glm-5.2" ? { until: "2126-01-01T00:00:00.000Z", stated: false } : undefined);
    expect(concreteRoute(tier("GLM5.2"), metered, parked, Math.random, false)).toBeUndefined();
    expect(concreteRoute(tier("GLM5.2"), metered, parked, Math.random, true)).toBe("openrouter/z-ai/glm-5.2");
  });

  // TWENTY DRAWS, because the pick shuffles: with both routes alive, one call proves
  // nothing about which the shuffle could have chosen.
  it("never draws the metered sibling while both are alive", () => {
    for (let i = 0; i < 20; i++) {
      expect(concreteRoute(tier("GLM5.2"), metered, () => undefined, Math.random, false)).toBe("zp1/glm-5.2");
    }
  });

  // The same exemption as the round's: a literal metered id IS the operator's choice —
  // PROVIDED a person wrote the ladder it is in. `LORE_TIERS` is set by the suite's own
  // config, so this is that case.
  it("hands a literally-configured metered model through, gate or no gate", () => {
    expect(concreteRoute(tier("openrouter/z-ai/glm-5.2"), metered, () => undefined, Math.random, false))
      .toBe("openrouter/z-ai/glm-5.2");
  });

  /**
   * THE BUILT-IN LADDER IS NOBODY'S CHOICE, and exempting it made the gate inert on the
   * configuration this repository SHIPS.
   *
   * `DEFAULT_TIERS` is three literal `openrouter/` models and `deploy/docker-compose.yml`
   * passes a blank `LORE_TIERS`, which means exactly that default. Under the first version
   * of the rule — "a literal id is the operator's decision" — every one of those was
   * exempt, so `LORE_ALLOW_METERED=0` filtered nothing and every call billed, while README,
   * SPEC, TODO, MEMO and the compose comment all promised no charging route is ever called.
   *
   * Vany, asked which way to resolve it: exempt only an operator-written ladder.
   */
  it("does not exempt a literal metered model from the ladder lore ships with", () => {
    const t = tier("openrouter/z-ai/glm-5.2");
    // `source` empty is what an unset LORE_TIERS looks like, which is what the shipped
    // compose passes.
    expect(exemptLiteral(t, {}, ""), "nobody chose this").toBe(false);
    expect(exemptLiteral(t, {}, "/etc/lore/tiers.json"), "somebody did").toBe(true);
    // And a nickname is never exempt however the ladder arrived.
    expect(exemptLiteral(tier("GLM5.2"), metered, "/etc/lore/tiers.json")).toBe(false);
  });

  /**
   * PARKED AND FORBIDDEN ARE ANSWERED DIFFERENTLY — one by a clock, one by a person.
   *
   * The screen and `propose` both said "every route to X is out of quota" whenever
   * `concreteRoute` came back empty, which since the gate can mean the surviving route has
   * quota and is merely disallowed. An operator reads that and waits for a reset that is
   * not the constraint. The rule was already written for the round's own case; the other
   * callers went on sharing the sentence it forbids.
   */
  describe("saying WHY there is no route", () => {
    const parkedFree = (m: string) => (m === "zp1/glm-5.2" ? { until: "2126-01-01T00:00:00.000Z", stated: false } : undefined);

    // NOTHING PERMITTED SURVIVES: the toggle really is the only remedy, so say so.
    it("names the toggle when every route bills per call", () => {
      const allMetered = { "GLM5.2": ["openrouter/z-ai/glm-5.2", "openrouter/moonshotai/glm-5.2"] };
      const why = noRouteBecause(tier("GLM5.2"), allMetered, () => undefined, false) ?? "";
      expect(why).toMatch(/bill per call/);
      expect(why).toMatch(/LORE_ALLOW_METERED=1/);
      expect(why, "and says waiting is the wrong move").toMatch(/waiting will not change it/);
      expect(why, "never the sentence that sends someone to wait").not.toMatch(/every route to .* is out of quota/);
    });

    /**
     * BOTH CAUSES AT ONCE, and the first version got this wrong in the dangerous
     * direction. The branch was "any route was gated", which is true here — and told an
     * operator that waiting would not help and pointed them at a deployment-wide money
     * toggle, to work around a parked free route that returns by itself when its backoff
     * lifts. The money channel is the one this project insists must be exactly right.
     */
    it("says waiting DOES help when a free route survives the gate and is only parked", () => {
      const why = noRouteBecause(tier("GLM5.2"), metered, parkedFree, false) ?? "";
      expect(why, "the permitted route is parked, not forbidden").toMatch(/out of quota/);
      expect(why, "and the backoff is what clears it").toMatch(/backoff/);
      expect(why, "so it must NOT send anyone to the toggle").not.toMatch(/waiting will not change it/);
      // The metered route is still named — an operator seeing only "out of quota" would
      // not know a second route existed and was refused on purpose.
      expect(why).toMatch(/openrouter\/z-ai\/glm-5\.2/);
    });

    it("still says out of quota when that is genuinely why", () => {
      const allParked = () => ({ until: "2126-01-01T00:00:00.000Z", stated: false });
      expect(noRouteBecause(tier("GLM5.2"), pools, allParked, false) ?? "").toMatch(/out of quota/);
    });

    it("explains nothing when a route was found", () => {
      expect(noRouteBecause(tier("GLM5.2"), pools, () => undefined, false)).toBeUndefined();
    });
  });
});

describe("a pool may not mix models", () => {
  const file = (models: string) => `{
    "models": ${models},
    "tiers": [{"id":"t0","kind":"deterministic","stage":"fast"},
              {"id":"t1","kind":"model","model":"GLM5.2","stage":"fast"}]
  }`;

  /**
   * A pool's routes are interchangeable BY DEFINITION — the session key treats a re-pick
   * as the same conversation partner, and "twice the quota, one opinion" is the sentence
   * the feature was sold on. A pool mixing glm-5.2 with kimi-k3 makes tier identity mean
   * nothing, so it is refused at load, where somebody is watching.
   */
  it("refuses a pool whose routes name different models", () => {
    expect(() => loadTiers(file(`{"GLM5.2": ["zp1/glm-5.2", "kimi/k3"]}`))).toThrow(/mixes different models/);
  });

  it("accepts the same model reached through a gateway path", () => {
    expect(() => loadTiers(file(`{"GLM5.2": ["zai-coding-plan/glm-5.2", "openrouter/z-ai/glm-5.2"]}`))).not.toThrow();
  });
});

/**
 * RUNGS (D-109): tiers that run together, written as a nested array in the file.
 *
 * The syntax is the nesting alone — `rung` is loader-stamped, never hand-written —
 * because a hand-assigned number could collide with a flat index and silently group
 * tiers nobody grouped.
 */
describe("a rung in the ladder file", () => {
  const RUNG_FILE = `[
    {"id":"t0","kind":"deterministic","stage":"fast"},
    {"id":"t1","kind":"model","model":"zai/glm-5.2","stage":"fast"},
    [{"id":"t2","kind":"model","model":"kimi/k3","stage":"deep","conversation":true},
     {"id":"t3","kind":"model","model":"openai/terra","stage":"deep","conversation":true}]
  ]`;

  it("flattens the nesting and stamps each member with the rung's first flat index", () => {
    const tiers = loadTiers(RUNG_FILE);
    expect(tiers.map((t) => t.id)).toStrictEqual(["t0", "t1", "t2", "t3"]);
    expect(tiers[2]?.rung, "the deep rung starts at flat index 2").toBe(2);
    expect(tiers[3]?.rung).toBe(2);
    expect(tiers[1]?.rung, "a tier that runs alone is not stamped").toBeUndefined();
  });

  it("treats a one-member array as a tier that runs alone", () => {
    const tiers = loadTiers(`[
      {"id":"t0","kind":"deterministic","stage":"fast"},
      [{"id":"t1","kind":"model","model":"zai/glm-5.2","stage":"fast"}]
    ]`);
    expect(tiers[1]?.rung).toBeUndefined();
  });

  it("refuses a rung that mixes fast and deep members", () => {
    expect(() =>
      loadTiers(`[
        {"id":"t0","kind":"deterministic","stage":"fast"},
        [{"id":"t1","kind":"model","model":"a/m","stage":"fast","conversation":true},
         {"id":"t2","kind":"model","model":"b/m","stage":"deep","conversation":true}]
      ]`),
    ).toThrow(/mixes fast and deep/);
  });

  it("refuses a deterministic member — t0 already runs at the head of every round", () => {
    expect(() =>
      loadTiers(`[
        [{"id":"t0","kind":"deterministic","stage":"deep"},
         {"id":"t2","kind":"model","model":"b/m","stage":"deep","conversation":true}]
      ]`),
    ).toThrow(/deterministic and cannot share a rung/);
  });

  it("refuses a member without conversation — no boundary, nowhere safe to deliver", () => {
    expect(() =>
      loadTiers(`[
        [{"id":"t2","kind":"model","model":"a/m","stage":"deep","conversation":true},
         {"id":"t3","kind":"model","model":"b/m","stage":"deep"}]
      ]`),
    ).toThrow(/not `conversation: true`/);
  });

  it("refuses two tiers wearing one id, grouped or not", () => {
    expect(() =>
      loadTiers(`[
        {"id":"t1","kind":"model","model":"a/m","stage":"fast"},
        {"id":"t1","kind":"model","model":"b/m","stage":"fast"}
      ]`),
    ).toThrow(/both called 't1'/);
  });

  it("pins the grouping, spelled so a solo tier fingerprints as it always did", () => {
    const grouped = ladderFingerprint([...loadTiers(RUNG_FILE)]);
    expect(grouped).toContain("t2:kimi/k3:-:deep:r2");
    expect(grouped).toContain("t3:openai/terra:-:deep:r2");
    expect(grouped).toContain("t1:zai/glm-5.2:-:fast:r-");
    // A regroup IS a ladder change once both pins record grouping; an old four-field
    // pin has no opinion, exactly like every other field the pin has ever gained.
    const solo = ladderFingerprint([...loadTiers(RUNG_FILE)].map(({ rung: _r, ...t }) => t as Tier));
    expect(ladderChanged(grouped, solo)).toBe(true);
    expect(ladderChanged("t0:deterministic:-:fast,t1:zai/glm-5.2:-:fast,t2:kimi/k3:-:deep,t3:openai/terra:-:deep", grouped)).toBe(false);
  });
});

describe("the ladder walks rungs (D-109)", () => {
  const T: readonly Tier[] = [
    { id: "t0", kind: "deterministic", stage: "fast" },
    { id: "t1", kind: "model", model: "a/m", stage: "fast" },
    { id: "t2", kind: "model", model: "b/m", stage: "deep", conversation: true, rung: 2 },
    { id: "t3", kind: "model", model: "c/m", stage: "deep", conversation: true, rung: 2 },
  ];

  it("bills every member that ran, and only them", () => {
    const r = step({ state: initialState(T), raised: ["f1"], tiers: T, ran: ["t2", "t3"] });
    expect(r.state.tierRounds).toStrictEqual({ t2: 1, t3: 1 });
    expect(r.decision.kind).toBe("findings");
  });

  it("escalates past the WHOLE rung when it is clean, and passes at the top", () => {
    // t1 clean → the next stop is the rung; the rung clean → nothing above → passed.
    const atRung = step({ state: initialState(T), raised: [], tiers: T });
    expect(atRung.decision.kind).toBe("fastClean");
    expect(atRung.state.cursor, "the cursor lands on the rung's first member").toBe(2);

    const done = step({ state: atRung.state, raised: [], tiers: T, ran: ["t2", "t3"] });
    expect(done.decision.kind).toBe("passed");
  });

  it("keeps the per-tier cap as the rung's iteration bound", () => {
    let state = step({ state: initialState(T), raised: [], tiers: T }).state; // to the rung
    let last: Decision | undefined;
    for (let i = 0; i < 5; i++) {
      const r = step({ state, raised: [`fresh-${String(i)}`], tiers: T, ran: ["t2", "t3"] });
      state = r.state;
      last = r.decision;
      if (last.kind === "stopped") break;
    }
    expect(last).toStrictEqual({ kind: "stopped", bound: "perTier" });
  });

  it("answers rung membership from the stamp, and from the index for everyone else", () => {
    expect(rungKey(T, 2)).toBe(2);
    expect(rungKey(T, 3)).toBe(2);
    expect(rungKey(T, 1)).toBe(1);
    expect(rungMembers(T, 2).map((t) => t.id)).toStrictEqual(["t2", "t3"]);
    expect(rungMembers(T, 3).map((t) => t.id), "from either member's seat").toStrictEqual(["t2", "t3"]);
    expect(rungMembers(T, 2, ["t2"]).map((t) => t.id), "an unpayable member is not a runner").toStrictEqual(["t3"]);
    expect(rungMembers(T, 1).map((t) => t.id)).toStrictEqual(["t1"]);
  });
});

/**
 * THE HELPER MODEL: work that needs a GLM but is not a review.
 *
 * Vany: *"if we need just GLM, to understand something, not for review, use 5.2 from the
 * small subscription for this."* The screen, the bootstrap survey and the proposer all
 * borrowed the first model TIER, so housekeeping competed for the gate tier's seat — the
 * one every review's first round runs on.
 */
describe("the helper model", () => {
  const file = (extra: string) => `{
    ${extra}
    "tiers": [{"id":"t0","kind":"deterministic","stage":"fast"},
              {"id":"t1","kind":"model","model":"zai-coding-plan/glm-5.3","stage":"fast"}]
  }`;

  it("is read from the ladder file when named", () => {
    expect(loadHelper(file(`"helper": "zai-coding-plan2/glm-5.2",`))).toBe("zai-coding-plan2/glm-5.2");
  });

  // Absent means the old behaviour — borrow the first model tier — so every config
  // written before this key keeps working unchanged.
  it("is undefined when the file does not name one", () => {
    expect(loadHelper(file(""))).toBeUndefined();
  });

  // It is NOT a tier: naming it must not add a reviewer, move a cursor, or change what
  // the pin covers, or a config gains an opinion nobody asked it for.
  it("does not become a tier or change the ladder's pin", () => {
    const withHelper = loadTiers(file(`"helper": "zai-coding-plan2/glm-5.2",`));
    const without = loadTiers(file(""));
    expect(withHelper.map((t) => t.id)).toStrictEqual(["t0", "t1"]);
    expect(ladderFingerprint([...withHelper])).toBe(ladderFingerprint([...without]));
  });
});
