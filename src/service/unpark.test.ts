import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../core/errors.ts";
import { Store } from "../store/store.ts";
import { LEGEND, describePark, parks, parseRequest, renderCleared, renderParks, unpark, type Park } from "./unpark.ts";

const mark = (over: Partial<Park>): Park => ({
  kind: "route",
  id: "openai/gpt-5.6-sol",
  until: "2026-09-25T07:02:27.527Z",
  why: "The usage limit has been reached",
  failures: 5,
  stated: false,
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
 * FACTS PER MARK, RULES ONCE (D-155). Every prediction the first versions made — "the next
 * review re-tests it", "still stands in front of what you cleared" — was a second copy of
 * review.ts's routing that review kept finding the next branch of. A mark's line now says
 * only what the mark is.
 */
describe("describePark", () => {
  const now = Date.parse("2026-09-24T15:10:00.000Z");

  it("says what the mark is: kind, who named the wait, failures, until, last probe, why", () => {
    const line = describePark(mark({ probedAt: "2026-09-24T15:02:24.925Z" }), now);
    expect(line).toContain(
      "route openai/gpt-5.6-sol  [quota, lore's guess, 5 failure(s), in force until 2026-09-25T07:02:27.527Z, " +
        "last probed 2026-09-24T15:02:24.925Z]",
    );
    expect(line).toContain("why: The usage limit has been reached");
  });

  it("names a rejected credential, a provider's statement, an expiry and a mark never probed", () => {
    const line = describePark(mark({ auth: true, stated: true, until: "2026-09-22T00:00:00.000Z" }), now);
    expect(line).toContain("[credential rejected, provider-stated, 5 failure(s), expired 2026-09-22T00:00:00.000Z, never probed]");
  });

  /** A route's mark records its kind (D-143); a tier's does not, so a tier gets no label rather than a guessed one. */
  it("labels a route's refusal and never a tier's", () => {
    const tier = describePark(mark({ kind: "tier", id: "t3", stated: true }), now);
    expect(tier).toContain("tier  t3  [provider-stated, 5 failure(s),");
    expect(tier).not.toContain("quota");
    expect(tier).not.toContain("credential rejected");
  });

  it("predicts nothing", () => {
    for (const p of [mark({}), mark({ stated: true }), mark({ kind: "tier", id: "t3" }), mark({ id: "openrouter/openai/gpt-5.6-sol" })]) {
      expect(describePark(p, now)).not.toMatch(/re-tests|probes it|in front of|skip|waits out|next review/);
    }
  });
});

describe("rendering", () => {
  const now = Date.parse("2026-09-24T15:10:00.000Z");

  it("says plainly when nothing is parked", () => {
    expect(renderParks([], now)).toBe("nothing parked — lore is not refusing to ask anything.\n");
  });

  /** The two cases a clear exists for are the ones the legend must never leave out. */
  it("states the rules once, including the two that only a clear can cut short", () => {
    const text = renderParks([mark({})], now);
    expect(text).toContain(LEGEND);
    expect(LEGEND).toContain("a route the provider stated a reset for (D-91)");
    expect(LEGEND).toContain("a route that is only a fallback");
    // Found by lore's own review, fingerprint 28b49f21: the metered gate is a toggle, not a
    // clock, so it has its own line and says what does and does not help.
    expect(LEGEND).toContain("Never asked while metered use is off, mark or no mark (D-117): a metered route in a pool,");
    expect(LEGEND).toContain("LORE_ALLOW_METERED=1 does.");
    // Found by lore's own review, fingerprints 9abac845 and dc7ce659: `exemptLiteral` ungates
    // a metered route written as a tier's own literal model, so the gate line must say so.
    expect(LEGEND).toContain("A metered route you wrote as a tier's\n  own model is your choice, and is asked like any other primary.");
    expect(LEGEND).not.toContain("or is metered while metered use is off");
    expect(text).toContain("If you fixed what a mark names, clear it: --route <prefix>, --tier <prefix>, or --all.");
  });

  /** The draft said a re-park kept its failure count "intact". It does not; the text must not say so. */
  it("tells the truth about what a re-park costs", () => {
    for (const text of [renderParks([mark({})], now), renderCleared([mark({})], [], now)]) {
      expect(text).toContain("starting over from a single failure");
      expect(text).not.toContain("intact");
    }
    expect(renderCleared([mark({})], [], now)).toContain("1 mark(s) cleared");
  });

  /**
   * Found by lore's own review, fingerprint 05e651dd: a mark just deleted must not be
   * described as holding anything. Its line after a clear is its facts as they were, and
   * nothing about what lore will do with it.
   */
  it("says nothing about what lore would do with a mark it just deleted", () => {
    const text = renderCleared([mark({ id: "openai/gpt-5.6-terra", auth: true, until: "2026-09-22T00:00:00.000Z" })], [], now);
    expect(text).toContain("cleared route openai/gpt-5.6-terra");
    expect(text).not.toContain("kept for its failure count");
  });

  it("lists what is still in force after a clear, with the rules to read it by", () => {
    const t3 = mark({ kind: "tier", id: "t3", stated: true, why: "the provider said its limit resets then" });
    const text = renderCleared([mark({})], [t3], now);
    expect(text).toContain("Still in force:");
    expect(text).toContain("tier  t3  [provider-stated,");
    expect(text).toContain(LEGEND);
  });

  /**
   * Found by lore's own review, fingerprint 1bf96fd2: with only expired marks left, a clear
   * said "Nothing else is parked" — and the very next listing showed them, since an expired
   * mark is kept for its failure count. What is true is that nothing else is in FORCE.
   */
  it("says nothing else is in force — not that nothing is parked — when only expired marks remain", () => {
    const expired = mark({ id: "kimi-for-coding/k3", until: "2026-09-18T13:06:41.835Z" });
    const text = renderCleared([mark({})], [expired], now);
    expect(text).toContain("Nothing else is in force.");
    expect(text).not.toContain("Nothing else is parked");
    expect(renderCleared([mark({})], [], now)).toContain("Nothing else is in force.");
  });
});
