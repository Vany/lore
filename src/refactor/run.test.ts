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
  runId: "refactor_test1",
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

  // lore-ok[6253e066]: found by lore's own review — a folder that stays inside the
  // tree but does not exist there used to reach the fan-out prompt anyway, burning two
  // full sessions on a subject that was never in the worktree. `worktree: process.cwd()`
  // is a real directory (this repo) — real enough for `existsSync` to be meaningful.
  it("refuses loudly when the folder does not exist in the worktree, before spending anything", async () => {
    await expect(
      suggestRefactors(deps(scripted({ t2: [SUGGESTION_A], t3: [SUGGESTION_B] })), input({ folder: "this-does-not-exist-anywhere-xyz" })),
    ).rejects.toThrow(DidNotRun);
    expect(asked).toStrictEqual([]);
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

/**
 * THE ROW MOVES WHILE THE RUN IS WORKING (D-139, fingerprint fe6d4318) — found by
 * lore's own review of the board-visibility change: between the worktree cut and the
 * terminal write nothing touched `refactor_run.updated_at`, so the board's stall
 * clock — which has no tier_run table to fold in, unlike a review's own — sat frozen
 * for the whole fan-out however long it legitimately ran, and would have painted a
 * healthy multi-tier fan-out exactly the colour of the hang this whole project exists
 * to catch.
 */
describe("the row's own updated_at moves as the run works", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("touches the row on every fan-out tier's completion, success or failure", async () => {
    const id = "refactor_moveTest1";
    store.createRefactorRun({ id, repoId, principal: "p", commitSha: "abc1234", folder: "src/store" });
    store.db.prepare("UPDATE refactor_run SET updated_at = ? WHERE id = ?").run(ago(60_000), id);
    const before = store.refactorRun(id)?.updatedAt;

    await suggestRefactors(
      deps(scripted({ t2: null, t3: [SUGGESTION_A], t1: [SUGGESTION_A] })),
      input({ runId: id }),
    );

    const after = store.refactorRun(id)?.updatedAt;
    expect(after, "the row moved even though t2 refused").toBeDefined();
    expect(after !== before, "a stale updated_at would leave the board's stall clock frozen").toBe(true);
  });

  it("touches the row after the combine step too", async () => {
    const id = "refactor_moveTest2";
    store.createRefactorRun({ id, repoId, principal: "p", commitSha: "abc1234", folder: "src/store" });
    store.db.prepare("UPDATE refactor_run SET updated_at = ? WHERE id = ?").run(ago(60_000), id);
    const before = store.refactorRun(id)?.updatedAt;

    await suggestRefactors(
      deps(scripted({ t2: [SUGGESTION_A], t3: [SUGGESTION_B], t1: [SUGGESTION_A, SUGGESTION_B] })),
      input({ runId: id }),
    );

    const after = store.refactorRun(id)?.updatedAt;
    expect(after !== before).toBe(true);
  });

  // lore-ok[77cd14ff]: found by lore's own review — the two tests above both end up
  // combining, so a reader could not tell whether askOneTier's own touch calls do
  // anything, or whether the combine step's touch is silently the only one that
  // matters. Scripting both fan-out tiers to answer with an empty list takes the
  // `raw.length === 0` early return (run.ts line 164) BEFORE t1 is ever asked to
  // combine — isolating askOneTier's touches as the only ones that could have moved it.
  it("touches the row from the fan-out alone, when there is nothing to combine", async () => {
    const id = "refactor_moveTest3";
    store.createRefactorRun({ id, repoId, principal: "p", commitSha: "abc1234", folder: "src/store" });
    store.db.prepare("UPDATE refactor_run SET updated_at = ? WHERE id = ?").run(ago(60_000), id);
    const before = store.refactorRun(id)?.updatedAt;

    const result = await suggestRefactors(deps(scripted({ t2: [], t3: [] })), input({ runId: id }));

    expect(result.suggestions, "an empty union should skip the combine call entirely").toEqual([]);
    expect(asked.some((a) => a.tier === "t1"), "t1 must not have been asked to combine nothing").toBe(false);
    const after = store.refactorRun(id)?.updatedAt;
    expect(after !== before, "askOneTier's own touches must be load-bearing on their own").toBe(true);
  });

  // A run whose id matches no row is not this function's problem to notice — the
  // worker created the row before ever calling suggestRefactors, so a mismatch here
  // would mean a bug in the caller, not something to guard against with a throw that
  // would turn a bookkeeping touch into a reason to lose real, paid-for suggestions.
  it("does not throw when the row does not exist", async () => {
    await expect(
      suggestRefactors(deps(scripted({ t2: [SUGGESTION_A], t3: null })), input({ runId: "refactor_never_created" })),
    ).resolves.toBeDefined();
  });
});
