import { describe, expect, it } from "vitest";
import type { Finding } from "./finding.ts";
import { SHORT_LENGTH, fingerprint, shortFingerprint } from "./fingerprint.ts";

const base: Finding = {
  file: "src/pay/hold.ts",
  line: 142,
  symbol: "capturePayment",
  severity: "high",
  claim: "decline path leaves the hold active",
  evidence: "hold released only in the success branch",
  failureScenario: "card declines → funds stay held",
};

describe("fingerprint", () => {
  it("is stable for the same finding", () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  // The property the whole design rests on. Every fix shifts line numbers; if
  // those changed identity, every round would look like fresh discoveries and the
  // ladder would never terminate.
  it("survives the line moving", () => {
    expect(fingerprint({ ...base, line: 900 })).toBe(fingerprint(base));
    expect(fingerprint({ ...base, line: undefined })).toBe(fingerprint(base));
  });

  // A rejected justification returns the finding at raised severity
  // (spec/review-ladder.md §4). It must be recognised as the SAME finding, or it
  // would re-enter the ladder as new work every time it was re-raised.
  it("survives a severity change", () => {
    expect(fingerprint({ ...base, severity: "low" })).toBe(fingerprint(base));
  });

  it("ignores rewording that carries no meaning", () => {
    expect(fingerprint({ ...base, claim: "  Decline path leaves the hold ACTIVE. " })).toBe(
      fingerprint(base),
    );
  });

  it("distinguishes a different claim, file, or symbol", () => {
    expect(fingerprint({ ...base, claim: "hold released twice" })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, file: "src/pay/refund.ts" })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, symbol: "refundPayment" })).not.toBe(fingerprint(base));
  });

  // Two findings with no symbol share a bucket by design: we have no evidence they
  // are different. Pinned so the choice is deliberate rather than accidental.
  it("treats an absent symbol as an empty one", () => {
    const noSymbol = { ...base, symbol: undefined };
    expect(fingerprint(noSymbol)).toBe(fingerprint({ ...noSymbol, symbol: undefined }));
    expect(fingerprint(noSymbol)).not.toBe(fingerprint(base));
  });

  // Without length-prefixed joining these two collide, because the parts run
  // together identically. `claim` is free text, so it can contain any separator we
  // might have picked.
  it("does not let field boundaries be forged", () => {
    const a: Finding = { ...base, claim: "ab", file: "c", symbol: undefined };
    const b: Finding = { ...base, claim: "a", file: "bc", symbol: undefined };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("is a full-length hex sha256", () => {
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("shortFingerprint", () => {
  it("is the leading hex of the full fingerprint", () => {
    expect(shortFingerprint(base)).toBe(fingerprint(base).slice(0, SHORT_LENGTH));
    expect(shortFingerprint(base)).toMatch(/^[0-9a-f]{8}$/);
  });
});
