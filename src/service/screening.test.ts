/**
 * A tier that stopped answering is not asked again (D-90).
 *
 * Vany: *"if t1 is skipped, it must not even initiate screen."* A deadline bounds a
 * wasted call; not making it costs nothing. With Z.ai exhausted the background pass would
 * otherwise hang for 45 minutes every hour, holding a quarter of the provider gate, to
 * re-learn a fact already written down.
 *
 * The fact has to be LEARNED and it has to EXPIRE, and both halves are dangerous in
 * opposite directions: never marking means hanging for ever, and never clearing means a
 * tier we stop using long after it came back — the quieter failure, because nothing looks
 * broken.
 */

import { describe, expect, it } from "vitest";
import type { Tier } from "../core/ladder.ts";
import type { ReviewerLike, SessionResult } from "../reviewer/opencode.ts";
import { EXTRACTOR_VERSION, UNSCREENED } from "../knowledge/ingest.ts";
import { Store } from "../store/store.ts";
import { COOLOFF_CAP_MS, COOLOFF_MS, coolOffMs, screeningPass } from "./screening.ts";

const TIERS: readonly Tier[] = [
  { id: "t0", kind: "deterministic", stage: "fast" },
  { id: "t1", kind: "model", model: "vendor/cheap", effort: "medium", stage: "fast" },
  { id: "t2", kind: "model", model: "other/deep", effort: "high", stage: "deep" },
];

const SPENT = { raw: "", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, retried: false, steps: 1, rejected: [] };

/** A reviewer whose screen call always fails the way an exhausted plan does. */
class Dead implements ReviewerLike {
  calls = 0;
  async review(): Promise<never> {
    throw new Error("not used");
  }
  askFor<T>(): Promise<SessionResult<T>> {
    this.calls++;
    return Promise.reject(new Error("opencode ran past 2700s without finishing"));
  }
}

/** A reviewer that answers, refusing nothing. */
class Alive implements ReviewerLike {
  calls = 0;
  async review(): Promise<never> {
    throw new Error("not used");
  }
  askFor<T>(_t: Tier, _p: string, _w: string, extract: (text: string) => { ok: boolean; items: readonly T[]; rejected: readonly string[]; why: string }): Promise<SessionResult<T>> {
    this.calls++;
    const listed = extract('```json\n{"not_rules":[]}\n```');
    return Promise.resolve({ ...SPENT, items: listed.items } as SessionResult<T>);
  }
}

const seeded = (): { store: Store; repoId: string } => {
  const store = new Store(":memory:");
  const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
  store.addKnowledge({
    repoId, kind: "rule", source: "ingested", statement: "a candidate nobody has judged",
    why: undefined, path: undefined, cwe: undefined, provenance: "SPEC.md",
    sourceBlob: "b1", extractor: UNSCREENED, confidence: 0.8,
  });
  return { store, repoId };
};

const silent = () => undefined;

describe("the cool-off after a tier stops answering", () => {
  it("doubles, and stops doubling at a day", () => {
    expect(coolOffMs(1)).toBe(COOLOFF_MS);
    expect(coolOffMs(2)).toBe(COOLOFF_MS * 2);
    expect(coolOffMs(4)).toBe(COOLOFF_MS * 8);
    expect(coolOffMs(99), "a cap, so a recovered tier is still noticed within a day").toBe(COOLOFF_CAP_MS);
    // Zero and negative are not reachable through the caller, but a bound that inverts
    // on a bad argument is how a cool-off becomes a busy loop.
    expect(coolOffMs(0)).toBe(COOLOFF_MS);
  });

  it("marks the tier down after a pass it could not complete", async () => {
    const { store } = seeded();
    const reviewer = new Dead();

    await screeningPass(store, reviewer, TIERS, silent);

    expect(reviewer.calls, "it tried once — the fact has to be learned from somewhere").toBe(1);
    const down = store.tierUnavailable("t1");
    expect(down?.failures).toBe(1);
    // Parenthesised: `a ?? "" > b` parses as `a ?? ("" > b)` and asserts nothing about
    // `a` at all. The first version of this line did exactly that and passed.
    expect((down?.until ?? "") > new Date().toISOString()).toBe(true);
    store.close();
  });

  /** The whole point: the second hour costs nothing at all. */
  it("does not make the call at all while the cool-off holds", async () => {
    const { store } = seeded();
    const reviewer = new Dead();

    await screeningPass(store, reviewer, TIERS, silent);
    await screeningPass(store, reviewer, TIERS, silent);
    await screeningPass(store, reviewer, TIERS, silent);

    expect(reviewer.calls, "one attempt, then silence until the cool-off expires").toBe(1);
    expect(store.tierUnavailable("t1")?.failures, "and it does not inflate the count for calls it never made").toBe(1);
    store.close();
  });

  it("tries again once the cool-off has expired, and backs off further", async () => {
    const { store } = seeded();
    const reviewer = new Dead();
    await screeningPass(store, reviewer, TIERS, silent);
    // Expire it by hand rather than waiting an hour.
    store.markTierUnavailable("t1", new Date(Date.now() - 1000).toISOString(), "expired", 1);

    await screeningPass(store, reviewer, TIERS, silent);

    expect(reviewer.calls).toBe(2);
    const down = store.tierUnavailable("t1");
    expect(down?.failures).toBe(2);
    expect(
      Date.parse(down?.until ?? "") - Date.now(),
      "the second wait is longer than the first",
    ).toBeGreaterThan(COOLOFF_MS);
    store.close();
  });

  /**
   * THE QUIETER FAILURE. A mark left behind after the tier recovers means lore stops
   * using a working tier, and nothing anywhere looks broken — the screen simply never
   * runs again.
   */
  it("forgets the mark the moment the tier answers", async () => {
    const { store, repoId } = seeded();
    store.markTierUnavailable("t1", new Date(Date.now() - 1000).toISOString(), "stale", 3);

    await screeningPass(store, new Alive(), TIERS, silent);

    expect(store.tierUnavailable("t1"), "no record at all, so the next failure starts from one").toBeUndefined();
    const row = store.db
      .prepare("SELECT extractor FROM knowledge WHERE repo_id = ?")
      .get(repoId) as Record<string, string>;
    expect(row["extractor"], "and the backlog actually drained").toBe(EXTRACTOR_VERSION);
    store.close();
  });

  // The operator view reads this, and an empty list is the healthy answer rather than a
  // missing key — a field that vanishes when things are fine teaches a monitor to ignore
  // its absence.
  it("reports what is currently not being asked, and nothing once it expires", () => {
    const store = new Store(":memory:");
    const future = new Date(Date.now() + 60_000).toISOString();
    store.markTierUnavailable("t1", future, "3 consecutive screen call(s) went unanswered", 3);
    expect(store.unavailableTiers(new Date().toISOString())).toStrictEqual([
      { tier: "t1", until: future, why: "3 consecutive screen call(s) went unanswered" },
    ]);
    store.markTierUnavailable("t1", new Date(Date.now() - 60_000).toISOString(), "over", 3);
    expect(store.unavailableTiers(new Date().toISOString())).toStrictEqual([]);
    store.close();
  });
});
