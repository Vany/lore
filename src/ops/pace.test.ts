/**
 * The measured "come back at T", and the two cases where it must refuse.
 *
 * The refusals are the point. A number here is acted on by a client that cannot check
 * it, so the failure mode of a wrong one is invisible: a client that comes back too
 * early burns turns, one that comes back far too late adds latency to every review.
 * Both look like lore working.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { paceFor, paceNote } from "./pace.ts";

let store: Store;

/** `n` runs of `tier`, latencies spread evenly between `lo` and `hi` seconds. */
function runs(tier: string, n: number, lo: number, hi: number, outcome = "clean"): void {
  for (let i = 0; i < n; i++) {
    const ms = Math.round((lo + ((hi - lo) * i) / Math.max(1, n - 1)) * 1000);
    store.db
      .prepare(
        "INSERT INTO usage(review_id, tier, model, input_tokens, cached_tokens, output_tokens," +
          " cost_usd, latency_ms, outcome, at) VALUES('r', ?, 'm', 0, 0, 0, 0, ?, ?, '2026-08-06T00:00:00.000Z')",
      )
      .run(tier, ms, outcome);
  }
}

beforeEach(() => {
  store = new Store(":memory:");
});

describe("paceFor", () => {
  it("gives the median of a tier with enough consistent runs", () => {
    runs("t1", 40, 200, 400);
    const pace = paceFor(store, "t1");
    expect(pace?.tier).toBe("t1");
    expect(pace?.runs).toBe(40);
    expect(Math.round((pace?.ms ?? 0) / 1000)).toBeGreaterThan(280);
    expect(Math.round((pace?.ms ?? 0) / 1000)).toBeLessThan(320);
  });

  // D-58's rule: with too little data, say nothing rather than guessing. A default
  // interval would be indistinguishable from a measured one to whoever reads it.
  it("refuses on a thin sample", () => {
    runs("t3", 12, 120, 200);
    expect(paceFor(store, "t3")).toBeUndefined();
  });

  // The live case from this deployment: t3 at n=12 spanning 126s to 1691s, which is
  // early refusals and real reviews pooled. A median of two populations is arithmetic,
  // not knowledge.
  it("refuses when the distribution is too wide to have a middle", () => {
    runs("t2", 40, 10, 1600);
    expect(paceFor(store, "t2")).toBeUndefined();
  });

  // A quota refusal returns in seconds. Pooling those with real reviews drags the
  // median toward a number describing nothing anyone is waiting for.
  it("ignores failed runs, which measure how fast a tier can die", () => {
    runs("t1", 30, 300, 400);
    runs("t1", 30, 1, 3, "failed");
    const pace = paceFor(store, "t1");
    expect(pace?.runs).toBe(30);
    expect((pace?.ms ?? 0) / 1000).toBeGreaterThan(280);
  });

  it("says nothing about a tier that has never run", () => {
    expect(paceFor(store, "t9")).toBeUndefined();
  });
});

describe("paceNote", () => {
  it("tells a client what to DO, not just a number", () => {
    runs("t1", 40, 200, 400);
    const note = paceNote(paceFor(store, "t1"));
    expect(note).toMatch(/ONE CALL/);
    expect(note).toContain("t1");
    expect(note).toContain("40");
    // It is a fact about the tier, and a client that reads it as a prediction about
    // its own review will conclude something wrong the first time a round runs long.
    expect(note).toMatch(/half of all rounds take longer/i);
  });

  it("admits there is no number rather than inventing a default", () => {
    const note = paceNote(undefined);
    expect(note).toMatch(/no measured interval/i);
    expect(note).toMatch(/MINUTES, not seconds/);
    expect(note).not.toMatch(/\d+s/);
  });
});
