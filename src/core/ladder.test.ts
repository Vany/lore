import { describe, expect, it } from "vitest";
import { DEFAULT_TIERS, anyTierRan, initialState, loadTiers, markUnavailable, settle, soleVendorOf, step, vendorOf, type Decision, type LadderState, type Tier } from "./ladder.ts";

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

  // "We did everything we can" must never be reported as "every tier agreed".
  it("reaches passedPartial, never passed, when a tier was skipped", () => {
    let s = markUnavailable(initialState(), "t3");
    s = step({ state: s, raised: [] }).state; // t1 -> t2
    const r = step({ state: s, raised: [] });
    expect(r.decision).toStrictEqual({ kind: "passedPartial", skipped: ["t3"] });
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
      soleVendor: "zai-coding-plan",
    });
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
      soleVendor: "zai-coding-plan",
    });
  });

  it("carries the vendor in the state, so the attestation can name it", () => {
    expect(initialState(ONE_VENDOR).soleVendor).toBe("zai-coding-plan");
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

  it("reads the vendor from a direct id", () => {
    expect(vendorOf("zai/glm-5.2")).toBe("zai");
    expect(vendorOf("zai/glm-4.7")).toBe("zai");
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
