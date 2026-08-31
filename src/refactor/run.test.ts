/**
 * The run, against a scripted model — mirrors `propose/run.test.ts`'s fixture shape.
 *
 * Weighted toward what a silent failure would cost: one fan-out tier dying must not
 * sink the other's paid-for answer, every tier dying must refuse loudly, and a combiner
 * that fails or misbehaves must fall back to the raw, uncombined sets rather than
 * discarding real suggestions that were already paid for.
 *
 * SPEC: spec/refactor.md
 */

import { beforeEach, describe, expect, it } from "vitest";
import { DidNotRun } from "../core/errors.ts";
import type { Tier } from "../core/ladder.ts";
import type { Listed, SessionResult } from "../reviewer/opencode.ts";
import { Store } from "../store/store.ts";
import { suggestRefactors, type RefactorDeps, type RefactorInput } from "./run.ts";

const T1: Tier = { id: "t1", kind: "model", model: "zai-coding-plan/glm-5-turbo", stage: "fast" };
const T2: Tier = { id: "t2", kind: "model", model: "kimi-for-coding/k3", stage: "deep", refactor: true };
const T3: Tier = { id: "t3", kind: "model", model: "openai/gpt-5.6-terra", stage: "deep", refactor: true };
const TIERS = [T1, T2, T3];

const SUGGESTION_A = {
  title: "Split the store's query surface from its migration surface",
  area: ["src/store/store.ts"],
  rationale: "the two are read by entirely different callers",
  roughSize: "medium",
};
const SUGGESTION_B = {
  title: "Extract the retry loop into its own module",
  area: ["src/store/store.ts", "src/store/schema.ts"],
  rationale: "it is duplicated across three call sites",
};

let store: Store;
let repoId: string;
let asked: { tier: string; prompt: string }[];

/** A session that returns `replies` in order, keyed by tier id; `null` throws. */
function scripted(replies: Record<string, readonly unknown[] | null>) {
  return async <T>(
    tier: Tier,
    prompt: string,
    _worktree: string,
    extract: (text: string) => Listed<T>,
    _contract: string,
  ): Promise<SessionResult<T>> => {
    asked.push({ tier: tier.id, prompt });
    const reply = replies[tier.id];
    if (reply === null || reply === undefined) throw new Error("the provider refused");
    const r = extract(`\`\`\`json\n${JSON.stringify({ suggestions: reply })}\n\`\`\``);
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

const input = (over: Partial<RefactorInput> = {}): RefactorInput => ({
  folder: "src/store",
  commit: "abc1234",
  worktree: process.cwd(),
  tiers: TIERS,
  ...over,
});

const deps = (ask: RefactorDeps["ask"]): RefactorDeps => ({ store, repoId, ask });

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
  asked = [];
});

describe("the fan-out", () => {
  it("asks every tier marked refactor: true, and only those", async () => {
    await suggestRefactors(
      deps(scripted({ t2: [SUGGESTION_A], t3: [SUGGESTION_B], t1: [SUGGESTION_A, SUGGESTION_B] })),
      input(),
    );
    expect(asked.filter((a) => a.tier === "t2" || a.tier === "t3")).toHaveLength(2);
    // t1 is asked once too, but only to combine — never as a fan-out member.
    expect(asked.filter((a) => a.tier === "t1")).toHaveLength(1);
  });

  it("refuses loudly when no tier is configured for refactor suggestions", async () => {
    await expect(
      suggestRefactors(deps(scripted({})), input({ tiers: [T1] })),
    ).rejects.toThrow(DidNotRun);
  });

  it("one tier failing does not sink the other's paid-for answer", async () => {
    const r = await suggestRefactors(
      deps(scripted({ t2: null, t3: [SUGGESTION_B], t1: [SUGGESTION_B] })),
      input(),
    );
    const t2 = r.sources.find((s) => s.tier === "t2");
    const t3 = r.sources.find((s) => s.tier === "t3");
    expect(t2?.ok).toBe(false);
    expect(t2?.error).toContain("the provider refused");
    expect(t3?.ok).toBe(true);
    expect(r.combined).toBe(true);
    expect(r.suggestions.map((s) => s.title)).toStrictEqual([SUGGESTION_B.title]);
  });

  it("refuses loudly when every tier fails — nothing to combine", async () => {
    await expect(
      suggestRefactors(deps(scripted({ t2: null, t3: null })), input()),
    ).rejects.toThrow(DidNotRun);
  });

  it("both tiers looking and finding nothing is a complete answer, not a combiner call", async () => {
    const r = await suggestRefactors(deps(scripted({ t2: [], t3: [] })), input());
    expect(r.suggestions).toStrictEqual([]);
    expect(r.combined).toBe(true);
    expect(asked.some((a) => a.tier === "t1")).toBe(false);
  });
});

describe("the combine step", () => {
  it("carries the merged set from t1, not the raw union", async () => {
    const MERGED = { ...SUGGESTION_A, rationale: "merged: seen from both angles" };
    const r = await suggestRefactors(
      deps(scripted({ t2: [SUGGESTION_A], t3: [SUGGESTION_A], t1: [MERGED] })),
      input(),
    );
    expect(r.combined).toBe(true);
    expect(r.suggestions).toStrictEqual([MERGED]);
  });

  it("falls back to the raw sets when t1 is not configured, and says so", async () => {
    const r = await suggestRefactors(
      deps(scripted({ t2: [SUGGESTION_A], t3: [SUGGESTION_B] })),
      input({ tiers: [T2, T3] }),
    );
    expect(r.combined).toBe(false);
    expect(r.combinerNote).toContain("no usable t1");
    expect(r.suggestions.map((s) => s.title).sort()).toStrictEqual(
      [SUGGESTION_A.title, SUGGESTION_B.title].sort(),
    );
  });

  it("falls back to the raw sets when t1 fails, rather than discarding paid-for suggestions", async () => {
    const r = await suggestRefactors(
      deps(scripted({ t2: [SUGGESTION_A], t3: [SUGGESTION_B], t1: null })),
      input(),
    );
    expect(r.combined).toBe(false);
    expect(r.combinerNote).toContain("t1 failed to combine");
    expect(r.suggestions).toHaveLength(2);
  });

  it("falls back to the raw sets when t1 returns nothing from a non-empty input", async () => {
    const r = await suggestRefactors(
      deps(scripted({ t2: [SUGGESTION_A], t3: [SUGGESTION_B], t1: [] })),
      input(),
    );
    expect(r.combined).toBe(false);
    expect(r.combinerNote).toContain("no merged suggestions");
    expect(r.suggestions).toHaveLength(2);
  });
});

describe("a tier that could not run is reported, never silently absent (INV-1)", () => {
  it("records a failed fan-out tier's reason on its own source entry", async () => {
    const r = await suggestRefactors(
      deps(scripted({ t2: null, t3: [SUGGESTION_A], t1: [SUGGESTION_A] })),
      input(),
    );
    const t2 = r.sources.find((s) => s.tier === "t2");
    expect(t2?.ok).toBe(false);
    expect(t2?.error).toBeDefined();
  });
});
