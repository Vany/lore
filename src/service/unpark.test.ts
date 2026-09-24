import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_INTERVAL_MS } from "../core/cooloff.ts";
import { UsageError } from "../core/errors.ts";
import { Store } from "../store/store.ts";
import { describePark, parks, parseRequest, renderCleared, renderParks, unpark, type Park } from "./unpark.ts";

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
    expect(describePark(park({ probedAt }), now)).toContain(`lore's guess: the first review after ${next} re-tests it`);
  });

  it("says a guessed route never probed is re-tested by the next review", () => {
    expect(describePark(park({}), now)).toContain("the next review that needs it re-tests it");
  });

  /** The case the command exists for: nothing re-asks before `until` (D-91). */
  it("says a stated route is never re-tested before its time", () => {
    expect(describePark(park({ stated: true }), now)).toContain("provider-stated: never re-tested before 2026-09-25T07:02:27.527Z");
  });

  it("says a stated tier is skipped by reviews but still probed (D-94)", () => {
    const line = describePark(park({ kind: "tier", id: "t3", stated: true, probedAt: "2026-09-24T14:00:00.000Z" }), now);
    expect(line).toContain("provider-stated: reviews skip this tier; the next review that needs it re-tests it");
  });

  it("says a guessed tier binds only the background screen", () => {
    expect(describePark(park({ kind: "tier", id: "t3" }), now)).toContain("reviews ignore it; only the background screen waits");
  });

  it("says an expired mark blocks nothing", () => {
    expect(describePark(park({ until: "2026-09-22T00:00:00.000Z" }), now)).toContain("expired: blocks nothing now");
  });

  /** A route's mark records its kind (D-143); a tier's does not, so a tier gets no label rather than a guessed one. */
  it("labels a route's refusal and never a tier's", () => {
    expect(describePark(park({ auth: true }), now)).toContain("[credential rejected,");
    expect(describePark(park({}), now)).toContain("[quota,");
    const tier = describePark(park({ kind: "tier", id: "t3" }), now);
    expect(tier).not.toContain("quota,");
    expect(tier).not.toContain("credential rejected");
  });
});

describe("rendering", () => {
  const now = Date.parse("2026-09-24T15:10:00.000Z");

  it("says plainly when nothing is parked", () => {
    expect(renderParks([], now)).toBe("nothing parked — lore is not refusing to ask anything.\n");
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
    for (const text of [renderParks([p], now), renderCleared([p], now)]) {
      expect(text).toContain("starting over from a single failure");
      expect(text).not.toContain("intact");
    }
    expect(renderCleared([p], now)).toContain("1 mark(s) cleared");
  });
});
