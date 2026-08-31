/**
 * The two checks that stand between a model's reply and a config file: per-item
 * parsing against the exact candidates offered (`makeTierPickParser`), and the
 * cross-item rule no single item can enforce alone (`validatePicks`).
 *
 * SPEC: spec/review-ladder.md
 */

import { describe, expect, it } from "vitest";
import { makeTierPickParser, validatePicks, type TierPick } from "./suggestion.ts";

const KNOWN = new Set(["openrouter/z-ai/glm-5.2", "openrouter/moonshotai/kimi-k3", "openrouter/openai/gpt-5.6-sol-pro"]);

const pick = (over: Partial<Record<string, unknown>> = {}) => ({
  role: "t1",
  model: "openrouter/z-ai/glm-5.2",
  effort: "medium",
  why: "cheap and reliable",
  ...over,
});

describe("makeTierPickParser", () => {
  const parse = makeTierPickParser(KNOWN);

  it("accepts a well-formed pick naming a known candidate", () => {
    const r = parse(pick(), 0, 3);
    expect("rejected" in r).toBe(false);
  });

  it("rejects a model id that was never offered — a hallucination, not a typo to fix up", () => {
    const r = parse(pick({ model: "openrouter/anthropic/claude-opus-5" }), 0, 3);
    expect("rejected" in r).toBe(true);
  });

  it("rejects a role outside t1/t2/t3", () => {
    const r = parse(pick({ role: "t4" }), 0, 3);
    expect("rejected" in r).toBe(true);
  });

  it("rejects an effort outside the four allowed values", () => {
    const r = parse(pick({ effort: "extreme" }), 0, 3);
    expect("rejected" in r).toBe(true);
  });

  it("rejects a missing model", () => {
    const r = parse(pick({ model: "" }), 0, 3);
    expect("rejected" in r).toBe(true);
  });

  it("defaults 'why' to empty rather than rejecting when the model omits it", () => {
    const { why, ...rest } = pick();
    void why;
    const r = parse(rest, 0, 3);
    expect("rejected" in r).toBe(false);
    if (!("rejected" in r)) expect(r.why).toBe("");
  });
});

const t1: TierPick = { role: "t1", model: "openrouter/z-ai/glm-5.2", effort: "medium", why: "" };
const t2: TierPick = { role: "t2", model: "openrouter/moonshotai/kimi-k3", effort: "high", why: "" };
const t3: TierPick = { role: "t3", model: "openrouter/openai/gpt-5.6-sol-pro", effort: "high", why: "" };

describe("validatePicks", () => {
  it("accepts exactly three picks, one per role, three distinct vendors", () => {
    expect(validatePicks([t1, t2, t3])).toBeUndefined();
  });

  it("rejects fewer than three picks", () => {
    expect(validatePicks([t1, t2])).toMatch(/exactly 3/);
  });

  it("rejects more than three picks", () => {
    expect(validatePicks([t1, t2, t3, t1])).toMatch(/exactly 3/);
  });

  it("rejects two picks for the same role even when the count is right", () => {
    const secondT1: TierPick = { ...t2, role: "t1" };
    expect(validatePicks([t1, secondT1, t3])).toMatch(/one pick per role/);
  });

  /**
   * THE RULE THIS WHOLE FEATURE EXISTS TO ENFORCE (D-32/D-49) — two tiers from the
   * same organisation are one opinion asked twice, however good the models are
   * individually, and this must be caught even when the model's own prompt said the
   * right thing and then picked wrong.
   */
  it("rejects two picks from the same vendor even with three distinct roles", () => {
    const sameVendorT2: TierPick = { ...t2, model: "openrouter/z-ai/glm-5.3" };
    const err = validatePicks([t1, sameVendorT2, t3]);
    expect(err).toMatch(/three different vendors/);
    expect(err).toMatch(/D-32\/D-49/);
  });

  /**
   * THE ENFORCEMENT PATH ITSELF, NOT JUST THE DISPLAYED TABLE — found by lore's own
   * review, fingerprints 119dcfd0/992002a4: the first tilde-alias fix landed only in
   * `catalog.ts`'s own display column, so THIS check — the thing that actually
   * decides whether a ladder gets written — still called bare `vendorOf` and would have
   * accepted `z-ai` alongside `~z-ai` as two independent vendors. Picking a live
   * "-latest" pointer alias id directly (not the catalog's own precomputed field)
   * proves the check itself, not just the table, now treats them as one.
   */
  it("rejects a tilde-aliased pointer route as a distinct vendor from its own real organisation", () => {
    const tildeT2: TierPick = { ...t2, model: "openrouter/~z-ai/glm-5.2-latest" };
    const err = validatePicks([t1, tildeT2, t3]);
    expect(err, "z-ai and ~z-ai must count as the same vendor, not two").toMatch(/three different vendors/);
  });
});
