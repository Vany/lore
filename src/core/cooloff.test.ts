/**
 * When to ask a tier again, and the line between a fact and a guess.
 *
 * lore cannot ask a provider whether it is available — opencode swallows the refusal in
 * the message body (D-84) and publishes it on its event stream (D-91) — so there are
 * exactly two inputs: a call that failed, and the time the provider named if it named one.
 * Those deserve different treatment, and conflating them is what D-90 did before D-91
 * proved the stated time was reachable all along.
 */

import { describe, expect, it } from "vitest";
import { COOLOFF_CAP_MS, COOLOFF_MS, PROBE_INTERVAL_MS, RESET_CAP_MS, RESET_FLOOR_MS, coolOffMs, retryAt, shouldProbe } from "./cooloff.ts";

const NOW = Date.parse("2026-08-09T00:00:00.000Z");

describe("the doubling fallback", () => {
  it("doubles, and stops at a day", () => {
    expect(coolOffMs(1)).toBe(COOLOFF_MS);
    expect(coolOffMs(3)).toBe(COOLOFF_MS * 4);
    expect(coolOffMs(99)).toBe(COOLOFF_CAP_MS);
    // A bound that inverts on a bad argument is how a cool-off becomes a busy loop.
    expect(coolOffMs(0)).toBe(COOLOFF_MS);
    expect(coolOffMs(-5)).toBe(COOLOFF_MS);
  });
});

describe("when the provider names a time", () => {
  // The whole point of D-91: waiting exactly as long as told is both the shortest correct
  // wait and the longest safe one, and no amount of doubling arrives at it.
  it("uses it, and says that it was told", () => {
    const r = retryAt(NOW, 1, "2026-08-10T18:19:09.000Z");
    expect(r.until).toBe("2026-08-10T18:19:09.000Z");
    expect(r.stated).toBe(true);
  });

  it("falls back to the doubling when nothing was said", () => {
    const r = retryAt(NOW, 2, undefined);
    expect(r.until).toBe(new Date(NOW + COOLOFF_MS * 2).toISOString());
    expect(r.stated, "and the caller can tell which it got").toBe(false);
  });

  // A timestamp lore did not compute is input. These two clamps are why one malformed
  // string cannot retire a tier for a year, and why a reset time already in the past
  // cannot turn into a retry loop against a provider still refusing.
  it("never waits longer than a week, whatever it is told", () => {
    const r = retryAt(NOW, 1, "2099-01-01T00:00:00.000Z");
    expect(r.until).toBe(new Date(NOW + RESET_CAP_MS).toISOString());
  });

  it("never waits less than a minute, even for a time already past", () => {
    const r = retryAt(NOW, 1, "2020-01-01T00:00:00.000Z");
    expect(r.until).toBe(new Date(NOW + RESET_FLOOR_MS).toISOString());
  });

  it("treats an unparseable time as nothing said, rather than as now", () => {
    const r = retryAt(NOW, 1, "whenever we feel like it");
    expect(r.stated).toBe(false);
    expect(r.until).toBe(new Date(NOW + COOLOFF_MS).toISOString());
  });
});

/**
 * WHEN TO ASK A COOLED-OFF TIER WHETHER IT IS BACK (D-94).
 *
 * lore hears a tier die on the event stream and had no way to hear one recover: a
 * subscription that came back 81 minutes before its stated reset went on being skipped for
 * all 81, paying a metered provider throughout. The trade that justified never asking has
 * inverted — asking cost 2700s when D-90 was written, about twelve seconds since D-91,
 * against a fallback call that has cost $4.94.
 */
describe("probing a tier that is in cool-off", () => {
  it("asks once the interval has passed, and not before", () => {
    const now = NOW;
    const recent = { probedAt: new Date(now - 60_000).toISOString() };
    const stale = { probedAt: new Date(now - PROBE_INTERVAL_MS - 1).toISOString() };
    expect(shouldProbe(recent, now), "once per interval, not once per review").toBe(false);
    expect(shouldProbe(stale, now)).toBe(true);
  });

  // A mark from before probing existed reads as "never asked", so the first review after a
  // deploy asks once — the same twelve seconds, and immediately right if the tier came
  // back while lore was down.
  it("asks when the mark has never been probed", () => {
    expect(shouldProbe({}, NOW)).toBe(true);
    expect(shouldProbe({ probedAt: "not a date" }, NOW), "an unreadable stamp is not a recent one").toBe(true);
  });

  // No mark at all is not a cool-off: there is nothing to probe, and the tier is called
  // normally by the ordinary path.
  it("has nothing to ask when the tier is not marked down", () => {
    expect(shouldProbe(undefined, NOW)).toBe(false);
  });
});
