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

/** The repository under test. One `lore.db` serves many, and the median is per repo. */
const REPO = "repo-under-test";

/** `n` runs of `tier` on `repo`, latencies spread evenly between `lo` and `hi` seconds. */
function runs(tier: string, n: number, lo: number, hi: number, outcome = "clean", repo = REPO): void {
  for (let i = 0; i < n; i++) {
    const ms = Math.round((lo + ((hi - lo) * i) / Math.max(1, n - 1)) * 1000);
    store.db
      .prepare(
        "INSERT INTO usage(review_id, repo_id, tier, model, input_tokens, cached_tokens, output_tokens," +
          " cost_usd, latency_ms, outcome, at) VALUES('r', ?, ?, 'm', 0, 0, 0, 0, ?, ?, '2026-08-06T00:00:00.000Z')",
      )
      .run(repo, tier, ms, outcome);
  }
}

beforeEach(() => {
  store = new Store(":memory:");
});

describe("paceFor", () => {
  it("gives the median of a tier with enough consistent runs", () => {
    runs("t1", 40, 200, 400);
    const pace = paceFor(store, "t1", REPO);
    expect(pace?.tier).toBe("t1");
    expect(pace?.runs).toBe(40);
    expect(Math.round((pace?.ms ?? 0) / 1000)).toBeGreaterThan(280);
    expect(Math.round((pace?.ms ?? 0) / 1000)).toBeLessThan(320);
  });

  // THE BUG THIS FIELD SHIPPED WITH, in Vany's words: "what happens if we will not fit
  // in time? will the user wait another 300 secs when the response is almost here?"
  //
  // Yes, it did. The interval was the median whatever the clock said, so a 400s round
  // against a 323s median sent the client away at 323s, found it still running, and
  // said 323s AGAIN — returning at 646s for an answer that existed at 400. On t2, whose
  // median is 820s, a 900s round put the client back at 1,640s: twelve minutes with the
  // answer already written.
  it("shrinks the wait as the round outlives the median", () => {
    runs("t1", 40, 200, 400);
    const fresh = paceFor(store, "t1", REPO)?.ms ?? 0;
    const late = paceFor(store, "t1", REPO, 300_000)?.ms ?? 0;
    expect(late).toBeLessThan(fresh);
    // 300s in, on a distribution ending at 400s, what is left is under two minutes.
    expect(late / 1000).toBeLessThan(120);
  });

  it("is the plain median before the round has started", () => {
    runs("t1", 40, 200, 400);
    expect(paceFor(store, "t1", REPO, 0)?.ms).toBe(paceFor(store, "t1", REPO)?.ms);
  });

  // Surviving past the median is evidence about which half of the distribution this
  // round is in. Throwing it away is what cost the twelve minutes.
  it("never sends a client past the point the answer is likely to arrive", () => {
    runs("t1", 40, 200, 400);
    for (const elapsedS of [100, 200, 250, 300, 350]) {
      const wait = paceFor(store, "t1", REPO, elapsedS * 1000);
      expect(elapsedS + (wait?.ms ?? 0) / 1000).toBeLessThan(400 + 31);
    }
  });

  // Past every completed run there is no distribution left to ask, and inventing one
  // at exactly the moment the data ran out is how the original bug read.
  it("says plainly when a round has outlasted every run of its tier", () => {
    runs("t1", 40, 200, 400);
    const pace = paceFor(store, "t1", REPO, 900_000);
    expect(pace?.overdue).toBe(true);
    expect(paceNote(pace)).toMatch(/no measurement left to offer/i);
    // And NOT a sign of failure: deep rounds have a long tail, and a client told
    // otherwise reports lore as broken.
    expect(paceNote(pace)).toMatch(/NOT a sign that anything is wrong/);
  });

  // AND IT SAYS WHAT THE CLOCK STARTED ON, because that sentence has already been wrong
  // once. Elapsed is measured from the TIER's own start; the note claimed it counted
  // "from when the round began" — a client that had been waiting since `review_start`
  // reads that as including T0, so on a repository whose T0 takes ~21 minutes the note's
  // only offered explanation cannot account for the gap, the reassurance collapses, and
  // it reports lore as broken. Which is the failure this whole field exists to remove.
  it("says which clock the overdue claim is about, and it is the tier's", () => {
    runs("t2", 40, 200, 400);
    const note = paceNote(paceFor(store, "t2", REPO, 900_000));
    expect(note).toMatch(/counts from when t2 itself began/);
    // The two things that would make it a lie again: claiming the review's clock, or
    // implying the tier has been working the whole time.
    expect(note).not.toMatch(/from when the round began|since you started/i);
    expect(note).toMatch(/not necessarily working longer/i);
  });

  // The arithmetic tends to zero as a round ages; two seconds is the retry loop this
  // replaced, wearing a measured number.
  it("never suggests an interval short enough to be a busy loop", () => {
    runs("t1", 40, 200, 400);
    for (const elapsedS of [395, 399, 500, 5000]) {
      expect((paceFor(store, "t1", REPO, elapsedS * 1000)?.ms ?? 0)).toBeGreaterThanOrEqual(30_000);
    }
  });

  // D-58's rule: with too little data, say nothing rather than guessing. A default
  // interval would be indistinguishable from a measured one to whoever reads it.
  it("refuses on a thin sample", () => {
    runs("t3", 12, 120, 200);
    expect(paceFor(store, "t3", REPO)).toBeUndefined();
  });

  // The live case from this deployment: t3 at n=12 spanning 126s to 1691s, which is
  // early refusals and real reviews pooled. A median of two populations is arithmetic,
  // not knowledge.
  it("refuses when the distribution is too wide to have a middle", () => {
    runs("t2", 40, 10, 1600);
    expect(paceFor(store, "t2", REPO)).toBeUndefined();
  });

  // A quota refusal returns in seconds. Pooling those with real reviews drags the
  // median toward a number describing nothing anyone is waiting for.
  it("ignores failed runs, which measure how fast a tier can die", () => {
    runs("t1", 30, 300, 400);
    runs("t1", 30, 1, 3, "failed");
    const pace = paceFor(store, "t1", REPO);
    expect(pace?.runs).toBe(30);
    expect((pace?.ms ?? 0) / 1000).toBeGreaterThan(280);
  });

  it("says nothing about a tier that has never run", () => {
    expect(paceFor(store, "t9", REPO)).toBeUndefined();
  });

  // ONE `lore.db` SERVES EVERY REPOSITORY A WORKGROUP PROVISIONS, and `paceNote` tells
  // each client the number was "measured across N completed runs on this repository".
  // Pooled, it was not: a monorepo's 741 KB branches and our own 80 KB diffs took the
  // same tier wildly different times and were averaged into one answer given to both.
  // `usage.repo_id` was written the whole time; only the read ignored it.
  it("measures the repository it is answering about, not the database", () => {
    runs("t1", 40, 200, 400);
    runs("t1", 40, 1500, 1700, "clean", "some-other-repo");

    const mine = paceFor(store, "t1", REPO);
    expect(mine?.runs).toBe(40);
    expect((mine?.ms ?? 0) / 1000).toBeLessThan(320);

    const theirs = paceFor(store, "t1", "some-other-repo");
    expect((theirs?.ms ?? 0) / 1000).toBeGreaterThan(1500);
  });

  // A repository below the floor gets NO number rather than another repository's, which
  // is the honest cost of scoping and the same rule the thin-sample refusal already makes.
  it("refuses for a repository with too few runs of its own", () => {
    runs("t1", 40, 200, 400);
    runs("t1", 5, 200, 400, "clean", "barely-used-repo");
    expect(paceFor(store, "t1", "barely-used-repo")).toBeUndefined();
  });

  // `runs` is the reader's check on how much to trust the number, and it grew more
  // confident-looking exactly as the evidence behind it shrank: a t2 round 1,500s in is
  // compared against the two runs that lasted that long, not against all 34.
  it("reports how many runs the conditional median actually came from", () => {
    runs("t1", 40, 200, 400);
    expect(paceFor(store, "t1", REPO)?.runs).toBe(40);

    const late = paceFor(store, "t1", REPO, 350_000);
    expect(late?.runs).toBeLessThan(40);
    expect(late?.sample).toBe(40);
    expect(paceNote(late)).toContain(`the ${String(late?.runs ?? 0)} runs`);
  });
});

describe("paceNote", () => {
  it("tells a client what to DO, not just a number", () => {
    runs("t1", 40, 200, 400);
    const note = paceNote(paceFor(store, "t1", REPO));
    expect(note).toMatch(/ONE CALL/);
    expect(note).toContain("t1");
    expect(note).toContain("40");
    // The number SHRINKS as the round ages, and a client that caches the first one
    // waits twice as long as it needs to. That has to be said, not implied.
    expect(note).toMatch(/READ THIS FIELD AGAIN EVERY TIME/);
    expect(note).toMatch(/do not reuse the number/i);
  });

  it("admits there is no number rather than inventing a default", () => {
    const note = paceNote(undefined);
    expect(note).toMatch(/no measured interval/i);
    expect(note).toMatch(/MINUTES, not seconds/);
    expect(note).not.toMatch(/\d+s/);
  });
});
