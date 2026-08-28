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

/**
 * `n` runs of `tier` on `repo`, latencies spread evenly between `lo` and `hi` seconds.
 *
 * `outcome` defaults to `"ok"` — what `recordUsage`'s own callers actually write for a
 * review-ladder tier that answered (never `"clean"`, a `tier_run`-only value that never
 * reaches this table; see `latenciesFor`'s doc).
 */
function runs(tier: string, n: number, lo: number, hi: number, outcome = "ok", repo = REPO): void {
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
    // CAPPED. The measured median here is ~300s; a client that can only poll is never
    // told to wait more than two minutes (D-103), so this asserts the ceiling rather
    // than the distribution — the distribution is what `runs` and `sample` report.
    expect(Math.round((pace?.ms ?? 0) / 1000)).toBe(119);
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
    // Still capped; what this test is about is WHICH runs fed the median, and `runs`
    // says so — 30, the real ones, not the 30 quota refusals that returned in a second.
    expect(Math.round((pace?.ms ?? 0) / 1000)).toBe(119);
  });

  // Allowlisted, not merely not-"failed" — a row under any OTHER non-answer outcome
  // (this deployment has never written one for a review-ladder tier, but nothing stops
  // a future caller) must be excluded the same way a "failed" one already is.
  it("ignores a non-answer outcome that is not literally 'failed' either", () => {
    runs("t1", 30, 300, 400);
    runs("t1", 30, 1, 3, "interrupted");
    const pace = paceFor(store, "t1", REPO);
    expect(pace?.runs).toBe(30);
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
    // Both distributions kept UNDER the two-minute ceiling, so the two medians are still
    // telling apart — capped at 119 they would be identical and this test would pass
    // while measuring nothing.
    runs("t1", 40, 35, 45);
    runs("t1", 40, 100, 110, "ok", "some-other-repo");

    const mine = paceFor(store, "t1", REPO);
    expect(mine?.runs).toBe(40);
    expect((mine?.ms ?? 0) / 1000).toBeLessThan(60);

    const theirs = paceFor(store, "t1", "some-other-repo");
    expect((theirs?.ms ?? 0) / 1000).toBeGreaterThan(90);
  });

  /**
   * NEVER MORE THAN TWO MINUTES, whatever the distribution says (D-103).
   *
   * Vany: *"if we want to provide a time of polling — it must always be less than 120
   * seconds."* The measured median is honest about when an ANSWER is likely and is the
   * wrong number to hand a client that can only poll: t2's is over twelve minutes, and a
   * client told to come back then leaves a review sitting in `findings_ready` for most of
   * it. Too early costs one wasted call; too late is how reviews are abandoned.
   */
  it("never suggests waiting two minutes or more, however slow the tier is", () => {
    // A tier that genuinely takes twenty minutes a round.
    runs("t3", 40, 1100, 1300);
    const pace = paceFor(store, "t3", REPO);
    expect(pace?.ms).toBeLessThan(120_000);
    // And it is still the honest sample size, so the note can say what it rests on.
    expect(pace?.sample).toBe(40);
  });

  // The floor is unchanged and still the other half of the bound: a client told to come
  // back in two seconds is the busy loop the interval replaced.
  it("still never suggests a busy loop", () => {
    runs("t1", 40, 200, 400);
    const pace = paceFor(store, "t1", REPO, 399_000);
    expect(pace?.ms).toBeGreaterThanOrEqual(30_000);
  });

  // A repository below the floor gets NO number rather than another repository's, which
  // is the honest cost of scoping and the same rule the thin-sample refusal already makes.
  it("refuses for a repository with too few runs of its own", () => {
    runs("t1", 40, 200, 400);
    runs("t1", 5, 200, 400, "ok", "barely-used-repo");
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
  });

  /**
   * THE NOTE MUST NOT PROMISE A NUMBER THAT CANNOT MOVE.
   *
   * This test asserted "READ THIS FIELD AGAIN EVERY TIME… it SHRINKS as the round ages"
   * against a fixture whose median is 300s — five times the cap. So the sentence was
   * pinned by a case that could never demonstrate it, while a real client polling a real
   * t1 round read `119000` four calls running and re-read the number each time exactly as
   * instructed, learning nothing. Measured on lore's own review of this change.
   *
   * The cap itself is right and stays. Vany: *"if we want to provide a time of polling —
   * it must always be less than 120 seconds."* What was wrong is a doc claiming behaviour
   * the field does not have, which is the drift rule applied to prose.
   */
  it("says the interval is the CAP when the measurement is above it", () => {
    runs("t1", 40, 200, 400);
    const pace = paceFor(store, "t1", REPO);
    expect(pace?.capped, "300s median against a 119s cap").toBe(true);
    const note = paceNote(pace);
    expect(note).toMatch(/THIS IS THE CAP, NOT THE MEASUREMENT/);
    expect(note, "and it says not to expect movement yet").toMatch(/rather than shrinking/);
    expect(note, "the shrinking promise is NOT made here").not.toMatch(/It SHRINKS as the round ages/);
  });

  // And where the measurement really is below the cap, the original advice is right and
  // is still given — the fix is a second sentence, not a replacement.
  it("keeps the shrink advice when the measurement is under the cap", () => {
    runs("t2", 40, 40, 60);
    const pace = paceFor(store, "t2", REPO);
    expect(pace?.capped).toBe(false);
    const note = paceNote(pace);
    expect(note).toMatch(/READ THIS FIELD AGAIN EVERY TIME/);
    expect(note).toMatch(/do not reuse the number/i);
  });

  it("admits there is no number rather than inventing a default", () => {
    const note = paceNote(undefined);
    expect(note).toMatch(/no measured interval/i);
    // BOUNDED EVEN WITHOUT DATA (D-103). It used to say "wait MINUTES, not seconds",
    // which is honest about having no median and unbounded about the wait — and a client
    // that can only poll reads that as licence to come back in five. It still refuses to
    // invent a median; it just names a ceiling instead of a vague direction.
    expect(note).toMatch(/about a minute/i);
    expect(note).toMatch(/not seconds/i);
    expect(note, "still no invented median").not.toMatch(/\d+s/);
  });
});
