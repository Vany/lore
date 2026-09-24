import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_INTERVAL_MS } from "../core/cooloff.ts";
import { UsageError } from "../core/errors.ts";
import { Store } from "../store/store.ts";
import { blockers, describePark, parks, parseRequest, renderCleared, renderParks, unpark, type Ladder, type Park } from "./unpark.ts";

/** The deployed ladder's shape: each tier's primary, plus t1 on a two-plan pool. */
const LADDER: Ladder = {
  tiers: [
    { id: "t0", kind: "deterministic", stage: "fast" },
    { id: "t1", kind: "model", model: "GLM", stage: "fast" },
    { id: "t2", kind: "model", model: "kimi-code-plan-global/k3", stage: "deep" },
    { id: "t3", kind: "model", model: "openai/gpt-5.6-sol", stage: "deep", fallback: ["openrouter/openai/gpt-5.6-sol"] },
  ],
  pools: { GLM: ["zai-coding-plan/glm-5.3", "zai-coding-plan2/glm-5.3"] },
};

const mark = (over: Partial<Park>): Park => ({
  kind: "route",
  id: "openai/gpt-5.6-sol",
  until: "2126-01-01T00:00:00.000Z",
  why: "limit",
  failures: 1,
  stated: true,
  auth: false,
  probedAt: undefined,
  ...over,
});

describe("parseRequest", () => {
  it("lists when nothing is named", () => {
    expect(parseRequest(["unpark"])).toBeUndefined();
  });

  it("names a route, a tier, or both", () => {
    expect(parseRequest(["unpark", "--route", "openai"])).toStrictEqual({ all: false, route: "openai", tier: undefined });
    expect(parseRequest(["unpark", "--tier", "t3"])).toStrictEqual({ all: false, route: undefined, tier: "t3" });
    expect(parseRequest(["unpark", "--route", "openai", "--tier", "t3"])).toStrictEqual({ all: false, route: "openai", tier: "t3" });
  });

  it("takes --all alone", () => {
    expect(parseRequest(["unpark", "--all"])).toStrictEqual({ all: true });
    expect(() => parseRequest(["unpark", "--all", "--route", "openai"])).toThrow(UsageError);
  });

  /**
   * A flag without a value must not fall through to the listing — that would print a list
   * to someone who asked for a clear and believes they got one.
   */
  it("refuses a flag with no value rather than dropping it", () => {
    expect(() => parseRequest(["unpark", "--route"])).toThrow(UsageError);
    expect(() => parseRequest(["unpark", "--route", "--all"])).toThrow(UsageError);
  });

  /** `startsWith("")` is true of every route, so an empty prefix would be `--all` in disguise. */
  it("refuses an empty prefix", () => {
    expect(() => parseRequest(["unpark", "--tier", ""])).toThrow(UsageError);
  });

  /**
   * Found by lore's own review, fingerprint bd6ba0c0: `--rout openai` matched no flag the
   * first version looked for, fell through to the listing and exited 0 — a typo reporting
   * a clear that never happened.
   */
  it("refuses anything it does not know, rather than listing", () => {
    expect(() => parseRequest(["unpark", "--rout", "openai"])).toThrow(/unknown argument '--rout'/);
    expect(() => parseRequest(["unpark", "openai"])).toThrow(/unknown argument 'openai'/);
    expect(() => parseRequest(["unpark", "--route", "a", "--route", "b"])).toThrow(/given twice/);
  });

  it("accepts --db, the one global option that means anything here", () => {
    expect(parseRequest(["unpark", "--db", "/tmp/x.db"])).toBeUndefined();
    expect(parseRequest(["unpark", "--db", "/tmp/x.db", "--all"])).toStrictEqual({ all: true });
  });
});

describe("parks and unpark, against a real store", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
    store.markRouteUnavailable("openai/gpt-5.6-sol", "2126-01-01T00:00:00.000Z", "The usage limit has been reached", 5);
    store.markRouteUnavailable("openai/gpt-5.6-terra", "2020-01-01T00:00:00.000Z", "Token refresh failed: 401", 97, false, true);
    store.markRouteUnavailable("kimi-for-coding/k3", "2126-01-01T00:00:00.000Z", "5-hour usage limit", 1);
    store.markTierUnavailable("t3", "2126-01-01T00:00:00.000Z", "the provider said its limit resets then", 1, true);
  });
  afterEach(() => store.close());

  it("lists both kinds — tiers first — with what each mark says", () => {
    const all = parks(store);
    expect(all.map((p) => `${p.kind}:${p.id}`)).toStrictEqual([
      "tier:t3",
      "route:kimi-for-coding/k3",
      "route:openai/gpt-5.6-sol",
      "route:openai/gpt-5.6-terra",
    ]);
    expect(all.find((p) => p.id === "openai/gpt-5.6-terra")?.auth).toBe(true);
    expect(all.find((p) => p.id === "t3")?.stated).toBe(true);
  });

  /**
   * THE CASE IT WAS WRITTEN FOR: `openai` is what a person who reset OpenAI types, and on
   * that day it matched a second, long-expired `openai/…` mark too. Both go, both are
   * reported, and nothing else is touched.
   */
  it("clears every route a prefix matches, and only routes", () => {
    const cleared = unpark(store, { all: false, route: "openai", tier: undefined });
    expect(cleared.map((p) => p.id).sort()).toStrictEqual(["openai/gpt-5.6-sol", "openai/gpt-5.6-terra"]);
    expect(parks(store).map((p) => p.id)).toStrictEqual(["t3", "kimi-for-coding/k3"]);
  });

  /**
   * The mark is DELETED, so the failure count the next backoff reads is gone with it — the
   * draft of this command promised it stayed "intact", which was false.
   */
  it("forgets the failure count with the mark", () => {
    unpark(store, { all: false, route: "openai/gpt-5.6-sol", tier: undefined });
    expect(store.routeUnavailable("openai/gpt-5.6-sol")).toBeUndefined();
  });

  /** A stated tier mark parks t3 while every route can be clear: the half the draft could not see. */
  it("clears a tier mark, and leaves routes alone", () => {
    const cleared = unpark(store, { all: false, route: undefined, tier: "t3" });
    expect(cleared.map((p) => `${p.kind}:${p.id}`)).toStrictEqual(["tier:t3"]);
    expect(store.tierUnavailable("t3")).toBeUndefined();
    expect(parks(store)).toHaveLength(3);
  });

  it("clears everything with all", () => {
    expect(unpark(store, { all: true })).toHaveLength(4);
    expect(parks(store)).toStrictEqual([]);
  });

  /** Returns nothing and clears nothing — the CLI turns this into an error, never a quiet success. */
  it("matches nothing without touching anything", () => {
    expect(unpark(store, { all: false, route: "anthropic", tier: undefined })).toStrictEqual([]);
    expect(parks(store)).toHaveLength(4);
  });
});

/**
 * The line that says whether lore would ask again on its own — the one an operator reads
 * to decide whether clearing buys anything. Pure, so each case is a literal mark and a
 * fixed clock.
 */
describe("describePark", () => {
  const now = Date.parse("2026-09-24T15:10:00.000Z");
  const park = (over: Partial<Park>): Park => ({
    kind: "route",
    id: "openai/gpt-5.6-sol",
    until: "2026-09-25T07:02:27.527Z",
    why: "refused on quota",
    failures: 5,
    stated: false,
    auth: false,
    probedAt: undefined,
    ...over,
  });

  /** The 2026-09-24 case exactly: a guess, probed eight minutes before the operator arrived. */
  it("gives a guessed route's next re-test time", () => {
    const probedAt = "2026-09-24T15:02:24.925Z";
    const next = new Date(Date.parse(probedAt) + PROBE_INTERVAL_MS).toISOString();
    expect(describePark(park({ probedAt }), now, LADDER)).toContain(`lore's guess, primary of t3: the first review after ${next} that needs it re-tests it`);
  });

  it("says a guessed primary route never probed is re-tested by the next review", () => {
    expect(describePark(park({}), now, LADDER)).toContain("lore's guess, primary of t3: the next review that needs it re-tests it");
  });

  /**
   * Found by lore's own review, fingerprint b13d07f3: D-94's route probe reaches only a
   * tier's PRIMARY. A route that is only a fallback — all three on the deployed ladder — is
   * filtered out of the fallback walk until its backoff runs out, so promising "the next
   * review re-tests it" told the person who had just reset plan 2 to wait hours for nothing.
   */
  it("says a fallback-only route is never probed and waits out its time", () => {
    const line = describePark(park({ id: "openrouter/openai/gpt-5.6-sol" }), now, LADDER);
    expect(line).toContain("lore's guess: not any tier's primary, so no probe reaches it — it waits out 2026-09-25T07:02:27.527Z");
    expect(line).not.toContain("re-tests it");
  });

  it("says so, rather than guessing, when the ladder cannot be read", () => {
    const line = describePark(park({}), now, new Error("LORE_TIERS: bad json"));
    expect(line).toContain("whether any review re-tests it is unknown — the ladder could not be read (LORE_TIERS: bad json)");
  });

  /**
   * The case the command exists for — with the exception lore's own review found
   * (fingerprint e0fa6114): a parked tier's due probe asks every primary route it has,
   * stated marks included, so "never" was wrong whenever the tier is parked too.
   */
  it("says a stated route waits for its time, or for its tier's probe", () => {
    const line = describePark(park({ stated: true }), now, LADDER);
    expect(line).toContain("provider-stated: not re-tested before 2026-09-25T07:02:27.527Z");
    expect(line).toContain("unless t3 is parked too and its probe comes due first");
  });

  it("says a stated tier's primary is skipped by reviews but still probed (D-94)", () => {
    const line = describePark(park({ kind: "tier", id: "t3", stated: true, probedAt: "2026-09-24T14:00:00.000Z" }), now, LADDER);
    expect(line).toContain("provider-stated: reviews skip this tier's primary; the next review that needs it probes it");
  });

  /**
   * Found by lore's own review, fingerprint 3e88004b: the first version said reviews ignore
   * a guessed tier mark. They call the tier — but a due one as a probe, under the probe's
   * shorter deadline, which can cut short a slow call that would otherwise have finished.
   */
  it("says a guessed tier is still called, as a probe when one is due", () => {
    const line = describePark(park({ kind: "tier", id: "t3" }), now, LADDER);
    expect(line).toContain("lore's guess: reviews still call it — the next review as a probe, under the shorter probe deadline");
    expect(line).not.toContain("ignore");
  });

  it("says an expired mark blocks nothing", () => {
    expect(describePark(park({ until: "2026-09-22T00:00:00.000Z" }), now, LADDER)).toContain("expired: blocks nothing now");
  });

  /** A route's mark records its kind (D-143); a tier's does not, so a tier gets no label rather than a guessed one. */
  it("labels a route's refusal and never a tier's", () => {
    expect(describePark(park({ auth: true }), now, LADDER)).toContain("[credential rejected,");
    expect(describePark(park({}), now, LADDER)).toContain("[quota,");
    const tier = describePark(park({ kind: "tier", id: "t3" }), now, LADDER);
    expect(tier).not.toContain("quota,");
    expect(tier).not.toContain("credential rejected");
  });
});

/**
 * Found by lore's own review, fingerprint 59ae6ccc: every remaining mark used to be named
 * a possible blocker, sending an operator to clear unrelated ones and lose their failure
 * counts. The ladder decides instead, in `review.ts`'s own order.
 */
describe("blockers", () => {
  const now = Date.parse("2026-09-24T15:10:00.000Z");

  it("a tier mark stands in front of a route cleared from that tier's primary, and no other", () => {
    const cleared = [mark({})];
    const t3 = mark({ kind: "tier", id: "t3" });
    const t1 = mark({ kind: "tier", id: "t1" });
    const kimi = mark({ id: "kimi-code-plan-global/k3" });
    expect(blockers(cleared, [t3, t1, kimi], LADDER, now)).toStrictEqual([t3]);
  });

  /** A tier's cool-off does not stop its fallback chain, so it blocks nothing cleared from it. */
  /** Found by lore's own review, fingerprint 24b6c2f3: `inCoolOff` needs `stated`. */
  it("a GUESSED tier mark stands in front of nothing", () => {
    expect(blockers([mark({})], [mark({ kind: "tier", id: "t3", stated: false })], LADDER, now)).toStrictEqual([]);
  });

  it("a tier mark does not stand in front of that tier's fallback", () => {
    const cleared = [mark({ id: "openrouter/openai/gpt-5.6-sol" })];
    expect(blockers(cleared, [mark({ kind: "tier", id: "t3" })], LADDER, now)).toStrictEqual([]);
  });

  it("a cleared tier is blocked by its primary route's mark", () => {
    const sol = mark({});
    expect(blockers([mark({ kind: "tier", id: "t3" })], [sol], LADDER, now)).toStrictEqual([sol]);
  });

  /** A free pool twin serves the tier, so one parked plan blocks nothing; both parked do. */
  it("a cleared pooled tier is blocked only when every plan in its pool is parked", () => {
    const plan1 = mark({ id: "zai-coding-plan/glm-5.3" });
    const plan2 = mark({ id: "zai-coding-plan2/glm-5.3" });
    const t1 = [mark({ kind: "tier", id: "t1" })];
    expect(blockers(t1, [plan1], LADDER, now)).toStrictEqual([]);
    expect(blockers(t1, [plan1, plan2], LADDER, now)).toStrictEqual([plan1, plan2]);
  });

  it("an expired mark stands in front of nothing", () => {
    expect(blockers([mark({})], [mark({ kind: "tier", id: "t3", until: "2020-01-01T00:00:00.000Z" })], LADDER, now)).toStrictEqual([]);
  });
});

describe("rendering", () => {
  const now = Date.parse("2026-09-24T15:10:00.000Z");

  it("says plainly when nothing is parked", () => {
    expect(renderParks([], now, LADDER)).toBe("nothing parked — lore is not refusing to ask anything.\n");
  });

  /** The draft said a re-park kept its failure count "intact". It does not; the text must not say so. */
  it("tells the truth about what a re-park costs", () => {
    const p: Park = {
      kind: "route",
      id: "a/b",
      until: "2126-01-01T00:00:00.000Z",
      why: "x",
      failures: 1,
      stated: false,
      auth: false,
      probedAt: undefined,
    };
    for (const text of [renderParks([p], now, LADDER), renderCleared([p], [], now, LADDER)]) {
      expect(text).toContain("starting over from a single failure");
      expect(text).not.toContain("intact");
    }
    expect(renderCleared([p], [], now, LADDER)).toContain("1 mark(s) cleared");
  });

  /**
   * Found by lore's own review, fingerprint 05e651dd. The live case: `--route openai`
   * also clears a long-expired mark, and the listing's "kept for its failure count" was
   * printed about it after the DELETE that removed the count. A cleared mark gets no line
   * about what lore would do with it.
   */
  it("says nothing about what lore would do with a mark it just deleted", () => {
    const expired: Park = {
      kind: "route",
      id: "openai/gpt-5.6-terra",
      until: "2026-09-22T00:00:00.000Z",
      why: "Token refresh failed: 401",
      failures: 97,
      stated: false,
      auth: true,
      probedAt: undefined,
    };
    const text = renderCleared([expired], [], now, LADDER);
    expect(text).toContain("cleared route openai/gpt-5.6-terra");
    expect(text).not.toContain("kept for its failure count");
    expect(text).not.toContain("re-tests it");
    // The listing, where the mark still exists, keeps saying it.
    expect(renderParks([expired], now, LADDER)).toContain("kept for its failure count");
  });

  /**
   * Found by lore's own review, fingerprints ac16d99e and 59ae6ccc: a clear must neither
   * promise the next review asks what a stated tier mark still blocks, nor name unrelated
   * marks as blockers. It says what stands in front of it, off the ladder — or, with no
   * ladder, that it cannot tell.
   */
  it("says what stands in front of a clear, and only that", () => {
    const sol = mark({});
    const t3 = mark({ kind: "tier", id: "t3", why: "the provider said its limit resets then" });
    const t1 = mark({ kind: "tier", id: "t1" });

    const blocked = renderCleared([sol], [t3, t1], now, LADDER);
    expect(blocked).toContain("Still parked, and in front of what you cleared:");
    expect(blocked).toContain("tier  t3");
    expect(blocked, "t1 serves no route that was cleared").not.toContain("tier  t1");

    expect(renderCleared([sol], [t1], now, LADDER)).toContain(
      "Nothing still parked stands in front of these: the next review that reaches them asks them.",
    );
    expect(renderCleared([sol], [], now, LADDER)).toContain("Nothing else is parked: the next review that reaches these asks them.");
  });

  it("says it cannot tell when the ladder cannot be read, rather than guessing", () => {
    const text = renderCleared([mark({})], [mark({ kind: "tier", id: "t3" })], now, new Error("LORE_TIERS: bad json"));
    expect(text).toContain("The ladder could not be read (LORE_TIERS: bad json)");
    expect(text).not.toContain("Still parked, and in front");
    expect(text).not.toContain("the next review that reaches");
  });
});
