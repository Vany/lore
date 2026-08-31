/**
 * The orchestration, against a scripted model — mirrors `refactor/run.test.ts`'s fixture
 * shape.
 *
 * Weighted toward what a silent failure would cost: too few candidates must refuse
 * before ever spending a session, and an invalid reply (wrong count, repeated role,
 * repeated vendor, a hallucinated id) must refuse loudly rather than write out a ladder
 * that fails the very rule this feature exists to enforce.
 *
 * SPEC: spec/review-ladder.md
 */

import { beforeEach, describe, expect, it } from "vitest";
import { DidNotRun } from "../core/errors.ts";
import type { Listed, SessionResult } from "../reviewer/opencode.ts";
import type { CatalogModel } from "./catalog.ts";
import { BOOTSTRAP_CALLER, suggestLadder, type LadderSetupDeps } from "./run.ts";

const CATALOG: readonly CatalogModel[] = [
  { id: "openrouter/z-ai/glm-5.2", vendor: "z-ai", costInput: 0.0000006, costOutput: 0.0000022, contextTokens: 128_000 },
  { id: "openrouter/moonshotai/kimi-k3", vendor: "moonshotai", costInput: 0.000003, costOutput: 0.000015, contextTokens: 1_048_576 },
  { id: "openrouter/openai/gpt-5.6-sol-pro", vendor: "openai", costInput: 0.000005, costOutput: 0.00003, contextTokens: 400_000 },
];

const GOOD_REPLY = [
  { role: "t1", model: "openrouter/z-ai/glm-5.2", effort: "medium", why: "cheap gate" },
  { role: "t2", model: "openrouter/moonshotai/kimi-k3", effort: "high", why: "independent vendor" },
  { role: "t3", model: "openrouter/openai/gpt-5.6-sol-pro", effort: "high", why: "strongest available" },
];

let asked: { tier: string; prompt: string }[];

/** A session that returns `reply` (or throws for `null`), mirroring `refactor/run.test.ts`'s own `scripted()`. */
function scripted(reply: readonly unknown[] | null) {
  return async <T>(
    tier: { id: string },
    prompt: string,
    _worktree: string,
    extract: (text: string) => Listed<T>,
    _contract: string,
  ): Promise<SessionResult<T>> => {
    asked.push({ tier: tier.id, prompt });
    if (reply === null) throw new Error("the provider refused");
    const r = extract(`\`\`\`json\n${JSON.stringify({ tiers: reply })}\n\`\`\``);
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

const deps = (catalog: readonly CatalogModel[], reply: readonly unknown[] | null): LadderSetupDeps => ({
  fetchCatalog: async () => catalog,
  ask: scripted(reply),
});

beforeEach(() => {
  asked = [];
});

describe("suggestLadder", () => {
  it("asks the bootstrap-caller model, not any of the candidates", async () => {
    await suggestLadder(deps(CATALOG, GOOD_REPLY));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.tier).toBe(BOOTSTRAP_CALLER.id);
  });

  it("assembles t0 plus the three picks, in role order, on a valid reply", async () => {
    const result = await suggestLadder(deps(CATALOG, GOOD_REPLY));
    expect(result.tiers.map((t) => t.id)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(result.tiers[0]).toEqual({ id: "t0", kind: "deterministic", stage: "fast" });
    expect(result.tiers[1]).toMatchObject({ id: "t1", model: "openrouter/z-ai/glm-5.2", stage: "fast" });
    expect(result.tiers[2]).toMatchObject({ id: "t2", stage: "deep" });
    expect(result.tiers[3]).toMatchObject({ id: "t3", stage: "deep" });
    expect(result.candidateCount).toBe(3);
  });

  it("carries the model's own reasoning in picks, for the printed summary", async () => {
    const result = await suggestLadder(deps(CATALOG, GOOD_REPLY));
    expect(result.picks.find((p) => p.role === "t2")?.why).toBe("independent vendor");
  });

  // Cannot possibly satisfy the three-distinct-vendor rule with fewer than three
  // candidates — refused before a session is even spent asking the impossible.
  it("refuses before asking, when fewer than three usable candidates exist", async () => {
    await expect(suggestLadder(deps(CATALOG.slice(0, 2), GOOD_REPLY))).rejects.toBeInstanceOf(DidNotRun);
    expect(asked, "must not spend a session on a request that cannot succeed").toHaveLength(0);
  });

  it("refuses when the reply names a model outside the offered candidates", async () => {
    const bad = [
      { role: "t1", model: "openrouter/z-ai/glm-5.2", effort: "medium", why: "" },
      { role: "t2", model: "openrouter/anthropic/claude-opus-5", effort: "high", why: "" },
      { role: "t3", model: "openrouter/openai/gpt-5.6-sol-pro", effort: "high", why: "" },
    ];
    await expect(suggestLadder(deps(CATALOG, bad))).rejects.toThrow(/invalid/);
  });

  it("refuses when the reply repeats a vendor across two roles (D-32/D-49)", async () => {
    const sameVendor = [
      { role: "t1", model: "openrouter/z-ai/glm-5.2", effort: "medium", why: "" },
      { role: "t2", model: "openrouter/z-ai/glm-5.2", effort: "high", why: "" },
      { role: "t3", model: "openrouter/openai/gpt-5.6-sol-pro", effort: "high", why: "" },
    ];
    await expect(suggestLadder(deps(CATALOG, sameVendor))).rejects.toThrow(/three different vendors/);
  });

  it("refuses when the provider call itself fails", async () => {
    await expect(suggestLadder(deps(CATALOG, null))).rejects.toThrow(/refused/);
  });
});
