/**
 * When a session is compacted, and when it is left alone.
 *
 * The threshold is Vany's — two thirds of the tier's context window — and both of its
 * refusals matter more than the arithmetic. Compacting on a guess would throw away the
 * model's reasoning, which is the whole thing continuity exists to keep; and measuring
 * against the wrong number would compact on the first turn and every turn after.
 */

import { describe, expect, it } from "vitest";
import { COMPACT_AT, sessionKey, shouldCompact } from "./continuity.ts";

describe("the 2/3 rule", () => {
  const WINDOW = 262_144;

  it("leaves a session alone below the threshold", () => {
    expect(shouldCompact(WINDOW / 2, WINDOW)).toBe(false);
    expect(shouldCompact(Math.floor(WINDOW * COMPACT_AT) - 1, WINDOW)).toBe(false);
  });

  it("compacts at the threshold and above", () => {
    expect(shouldCompact(Math.ceil(WINDOW * COMPACT_AT), WINDOW)).toBe(true);
    expect(shouldCompact(WINDOW, WINDOW)).toBe(true);
  });

  /**
   * A tier whose window we cannot read gets the behaviour it had before this existed.
   * Guessing a window and compacting against it would discard reasoning on a false alarm —
   * the same reasoning `settledBlock` already fails to reconstruct.
   */
  it("refuses to compact on an unknown window, rather than guessing one", () => {
    expect(shouldCompact(200_000, undefined)).toBe(false);
    expect(shouldCompact(undefined, WINDOW)).toBe(false);
    expect(shouldCompact(undefined, undefined)).toBe(false);
  });

  // A window of zero is a measurement that failed, not a window. Multiplying it gives a
  // threshold of zero, which would compact every session on every turn for ever.
  it("treats a zero window as no measurement", () => {
    expect(shouldCompact(1, 0)).toBe(false);
    expect(shouldCompact(1, -5)).toBe(false);
  });
});

describe("session addressing", () => {
  const M = "kimi-for-coding/k3";

  /**
   * One session per REVIEW, TIER and MODEL. Not per review — t1's conversation and t2's
   * are different models with different judgement, and merging them is exactly the failure
   * the ladder exists to prevent (D-1, D-49). Not per tier — two reviews share nothing.
   */
  it("separates tiers within a review, and reviews within a tier", () => {
    expect(sessionKey("rev1", "t1", M)).not.toBe(sessionKey("rev1", "t2", M));
    expect(sessionKey("rev1", "t2", M)).not.toBe(sessionKey("rev2", "t2", M));
    expect(sessionKey("rev1", "t2", M)).toBe(sessionKey("rev1", "t2", M));
  });

  /**
   * AND SEPARATES A TIER FROM ITS OWN FALLBACK, which is the case that broke it.
   *
   * A tier running on its twin keeps its id and changes its model, so keying on (review,
   * tier) handed the primary's session to the fallback: the fallback model got the
   * CONTINUED prompt on first contact — "the author has answered", to a reviewer that had
   * never read the code — and opencode, which ties a session to the model that opened it,
   * answered a call addressed to `zai-coding-plan` with OpenRouter's 402. The route lore
   * reported as tried was not the route that answered, which makes `unpayable` a claim
   * about a call nobody made.
   */
  it("gives a tier's fallback its own session", () => {
    expect(sessionKey("rev1", "t2", "kimi-for-coding/k3")).not.toBe(
      sessionKey("rev1", "t2", "openrouter/moonshotai/kimi-k3"),
    );
    expect(sessionKey("rev1", "t2", "openrouter/moonshotai/kimi-k3")).not.toBe(
      sessionKey("rev1", "t2", "zai-coding-plan/glm-5.2"),
    );
  });

  /**
   * `release` finds a review's sessions by prefix and `keptReviews` reads back to the
   * FIRST colon, so the review id has to be the head of the key and the separator has to
   * be one a review id cannot contain — otherwise releasing `rev1` could match `rev10`,
   * and a model id (which carries slashes, never colons) could be mistaken for the tail.
   */
  it("is prefixed by the review id, which is what release matches on", () => {
    expect(sessionKey("rev1", "t2", M).startsWith("rev1:")).toBe(true);
    expect(sessionKey("rev10", "t2", M).startsWith("rev1:")).toBe(false);
    expect(sessionKey("rev1", "t2", M).slice(0, sessionKey("rev1", "t2", M).indexOf(":"))).toBe("rev1");
  });
});
