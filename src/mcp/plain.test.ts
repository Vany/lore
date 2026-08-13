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

  it("calls a stand-in a stand-in, not a procurement event", () => {
    const raw =
      "t2 was answered by zai-coding-plan/glm-5.2 rather than kimi-for-coding/k3 — the subscription is out of " +
      "quota, so the same model was asked through a metered provider";
    const out = forClient(raw);
    expect(out).toContain("stand-in");
    expect(out).toContain("counts in full");
    expect(out).not.toMatch(/zai-coding-plan|kimi-for-coding|metered/);
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
