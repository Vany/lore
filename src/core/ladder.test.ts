import { describe, expect, it } from "vitest";
import { DEFAULT_TIERS, anyTierRan, initialState, loadTiers, markUnavailable, settle, step, vendorOf, type LadderState } from "./ladder.ts";

const clean = (state: LadderState) => step({ state, raised: [] });

describe("step", () => {
  it("starts at the first model tier, not at T0", () => {
    expect(DEFAULT_TIERS[initialState().cursor]?.id).toBe("t1");
  });

  it("reports new findings and resets to the cheapest model tier", () => {
    // Get to t2 first, so the reset is observable rather than a no-op.
    const atT2 = clean(initialState()).state;
    expect(DEFAULT_TIERS[atT2.cursor]?.id).toBe("t2");

    const r = step({ state: atT2, raised: ["aaa"] });
    expect(r.decision.kind).toBe("findings");
    // A fix is unreviewed code; the cheapest tier is the cheapest regression check.
    expect(DEFAULT_TIERS[r.state.cursor]?.id).toBe("t1");
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

  it("stops on the global bound", () => {
    let s = initialState();
    const limits = { perTierRounds: 99, globalRounds: 3 };
    for (let i = 0; i < 3; i++) s = step({ state: s, raised: [`f${i}`], limits }).state;
    const r = step({ state: s, raised: ["f9"], limits });
    expect(r.decision).toStrictEqual({ kind: "stopped", bound: "global" });
  });

  it("terminates from any starting point", () => {
    // The whole design rests on this: whatever the reviewers do, the loop ends.
    for (const raised of [[], ["a"], ["a", "b"]]) {
      let s = initialState();
      let decision = step({ state: s, raised }).decision;
      let guard = 0;
      while (decision.kind === "findings" || decision.kind === "escalate" || decision.kind === "fastClean") {
        const r = step({ state: s, raised });
        s = r.state;
        decision = r.decision;
        if (++guard > 100) break;
      }
      expect(guard).toBeLessThan(100);
      expect(["passed", "stopped", "needsHuman"]).toContain(decision.kind);
    }
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

  it("resets past unavailable tiers after a fix", () => {
    const s = markUnavailable(initialState(), "t1");
    const r = step({ state: s, raised: ["new"] });
    // t1 is unpayable, so the cheapest REACHABLE tier is where a fix goes back to.
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
