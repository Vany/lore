/**
 * The kitchen stays in the kitchen — tested on the REAL strings that crossed the
 * boundary this week, not on invented ones. Each of these was read by a person who
 * could act on none of it.
 */

import { describe, expect, it } from "vitest";
import { forClient } from "./plain.ts";

describe("forClient", () => {
  it("strips the runtime, the API framing and the billing upsell from a quota refusal", () => {
    const raw =
      "t2 did not look at this code — tier t2 (kimi-for-coding/k3) refused on quota: opencode returned 403: " +
      "APIError: You've reached your usage limit for this billing cycle. Your quota will be refreshed in the " +
      "next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing";
    const out = forClient(raw);
    expect(out).toContain("tier t2 was out of capacity");
    expect(out).toContain("usage limit for this billing cycle");
    expect(out).not.toMatch(/opencode|APIError|kimi-for-coding|https?:/);
  });

  // The string that crossed the boundary on 2026-08-14, verbatim: an OAuth token died
  // and the client read five words of kitchen before the fact started. Any error CLASS
  // is framing, not only APIError — and the route that owns the credential is
  // procurement, so it goes too.
  it("strips the error class and the route from a dead-credential reason", () => {
    const raw =
      "openai/gpt-5.6-terra rejected our credentials — tier t3 (openai/gpt-5.6-terra): opencode returned 500: " +
      "UnknownError: Token refresh failed: 401";
    const out = forClient(raw);
    expect(out).toContain("credentials for this tier's provider were rejected");
    expect(out).toContain("tier t3");
    expect(out).not.toMatch(/opencode|UnknownError|gpt-5\.6/);
  });

  it("turns the deadline overrun into a sentence about time, not about opencode", () => {
    const out = forClient("tier t3 (openai/gpt-5.6-terra) failed: opencode ran past 2700s without finishing");
    expect(out).toBe("tier t3 failed: the reviewing model did not finish within its 2700s limit");
  });

  it("names the runtime outage without the container's DNS details", () => {
    const out = forClient(
      "tier t2 could not reach opencode at http://opencode:4096 (getaddrinfo ENOTFOUND opencode) — is a server " +
        "running there? Nothing about the code was learned; the round is requeued.",
    );
    expect(out).toContain("lore's model runtime was unreachable");
    expect(out).toContain("Nothing about the code was learned");
    expect(out).not.toMatch(/opencode|getaddrinfo|4096/);
  });

  // Found by lore's own review of the D-109 rung: this exact note is what a mixed rung
  // produces (one member skipped, one still running) and it embedded the D-105
  // route-by-route breakdown — including every vendor and route tried — as `e.message`,
  // via a note that had also lost its own "tier " prefix so the paren-strip rule could
  // not fire either.
  it("strips both the missing tier prefix and the raw route breakdown from a SKIPPED note", () => {
    const raw =
      "tier t2 (kimi-for-coding/k3) could not answer on either attempt and was SKIPPED — its work passed to " +
      "the next tier. Anything only t2 would have caught is unexamined, and this review is evidence from one " +
      "fewer independent vendor. Last error: no route for tier t2 could run: kimi-for-coding/k3: Weekly/Monthly " +
      "Limit Exhausted; openrouter/moonshotai/kimi-k3: Insufficient credits";
    const out = forClient(raw);
    expect(out).toContain("tier t2 could not answer");
    expect(out).toContain("tier t2 had no working route");
    expect(out).not.toMatch(/kimi-for-coding|openrouter|moonshotai/);
  });

  // The synthetic pre-call refusal, thrown when every route's own backoff has not yet
  // passed — no call was even made. The comeback time is worth keeping; the route list
  // it is choosing between is not.
  it("keeps the comeback time and drops the route list from an all-parked refusal", () => {
    const raw =
      "tier t2 did not look at this code — no route for tier t2 has quota: kimi-for-coding/k3, " +
      "openrouter/moonshotai/kimi-k3 — each refused recently and is not asked again until its backoff passes. " +
      "The earliest comes back at 2026-08-14T18:00:00.000Z.";
    const out = forClient(raw);
    expect(out).toContain("tier t2 has no route with quota");
    expect(out).toContain("2026-08-14T18:00:00.000Z");
    expect(out).not.toMatch(/kimi-for-coding|openrouter|moonshotai/);
  });

  it("calls a stand-in a stand-in, not a procurement event", () => {
    const raw =
      "t2 was answered by zai-coding-plan/glm-5.2 rather than kimi-for-coding/k3 — the subscription is out of " +
      "quota, so the same model was asked through a metered provider";
    const out = forClient(raw);
    expect(out).toContain("stand-in");
    expect(out).toContain("counts in full");
    expect(out).not.toMatch(/zai-coding-plan|kimi-for-coding|metered/);
  });

  // THE VERBATIM STRING that crashed rev_WNGAGhU5 — a review started against a base
  // branch the repository does not have. Before crashes were reported at all this went
  // only to a job column; the moment it reached the client it brought lore's own disk
  // layout and git plumbing with it.
  it("keeps the fact and drops lore's disk and git's plumbing from a crashed round", () => {
    const raw =
      "git diff --submodule=diff --no-color main failed in " +
      "/Users/vany/l/rev/lore/data/repos/b0411f5a-7481-44d0-9efd-3d1e8d2c6ae1/wt/rev_WNGAGhU5YO49xGVutoz7c1wz: " +
      "fatal: ambiguous argument 'main': unknown revision or path not in the working tree.";
    const out = forClient(raw);
    expect(out, "the actionable fact survives").toContain("unknown revision");
    expect(out, "and which ref it was about").toContain("main");
    expect(out, "the host's filesystem does not").not.toMatch(/\/Users|\/var\/lib|repos\/|wt\//);
    expect(out).not.toContain("fatal:");
  });

  // A reason no rule matches passes through untouched: hiding an unknown reason would
  // be worse than leaking its vocabulary (INV-1 prefers ugly truth to tidy silence).
  it("leaves an unrecognised reason exactly as it was", () => {
    const raw = "eslint: no `lint` script and no eslint config";
    expect(forClient(raw)).toBe(raw);
  });

  // Idempotent, so poll and inbox can share it without bookkeeping.
  it("is the identity on its own output", () => {
    const raw = "tier t3 (openai/gpt-5.6-terra) failed: opencode ran past 2700s without finishing";
    expect(forClient(forClient(raw))).toBe(forClient(raw));
  });
});
