/**
 * The round trip, not the shape.
 *
 * `checks_skipped` carries two facts that read alike and mean opposite things, and the
 * board printed "did not run:" in front of both — so a line whose own words were "the tier
 * ran and its opinion counts in full" was rendered as a tier that did not run, on the
 * surface an operator reads first.
 *
 * This asserts what `t0/engines.ts` asserts about `ruleClaim`/`engineRuleClass`: that a
 * sentence built by the writer is recognised by the reader. Testing the predicate against
 * hand-written strings would pass while the writer drifted away from it, which is the
 * failure being guarded.
 */

import { describe, expect, it } from "vitest";
import { isCoverageLoss, RAN_ON_OTHER_ROUTE } from "./checks-skipped.ts";

describe("telling a check that did not run from a tier that ran differently", () => {
  // Built the way `runRound` builds it, from the shared constant rather than by copying
  // the wording — which is the whole point of the constant existing.
  const ranAnyway = (tier: string, route: string, configured: string): string =>
    `${tier} ${RAN_ON_OTHER_ROUTE} ${route} rather than ${configured} — the same vendor on another route, ` +
    "because the configured one was unavailable. The tier ran and its opinion counts in full, and nothing " +
    "about this review's independence changed.";

  it("reads back the sentence the writer builds", () => {
    expect(isCoverageLoss(ranAnyway("t1", "zai-coding-plan2/glm-5.2", "zai-coding-plan/glm-5.3"))).toBe(false);
  });

  /**
   * TierSchema (core/ladder.ts) validates a tier id as `z.string().min(1)` with only a
   * uniqueness check — every shipped config happens to use t0-t3, but nothing requires
   * it. Found by lore's own review of a fix to this very predicate: anchoring on the
   * id's SHAPE (`^t\d+`) rather than merely its PRESENCE (`^\S+`) would silently
   * misclassify the writer's own sentence for any operator-chosen id not shaped that way.
   */
  it("reads back the sentence the writer builds for a tier id the shipped configs don't use", () => {
    expect(isCoverageLoss(ranAnyway("review-a", "zp2/glm-5.2", "zp1/glm-5.2"))).toBe(false);
  });

  it("calls a genuine non-coverage line what it is", () => {
    for (const line of [
      "eslint: no `lint` script and no eslint config",
      "t2 produced a finding this review does NOT contain — a fenced JSON block did not parse",
      "tier t1 had no working route — everything configured for it refused or was unreachable",
    ]) {
      expect(isCoverageLoss(line), line).toBe(true);
    }
  });

  /**
   * AN UNRECOGNISED LINE IS A LOSS. A new entry whose wording nobody taught this file must
   * read as unexamined: guessing the other way lets a check that did not run pass as
   * covered, which is the one mistake INV-1 forbids outright.
   */
  it("treats wording it has never seen as a loss", () => {
    expect(isCoverageLoss("something nobody has written yet")).toBe(true);
  });

  /**
   * Found by lore's own review of src/core (D-130 folder mode): the phrase can arrive
   * embedded in text this module does not control — a rejected finding's note carries up
   * to 300 characters of the model's own raw JSON, and a tier-unavailable note carries a
   * caught error's message. Either can legitimately quote RAN_ON_OTHER_ROUTE without being
   * the sentence it names, and lore reviewing its own repository is exactly the case where
   * a model's finding text is likely to say "was answered by" while talking ABOUT this
   * file. A bare substring match used to read all of these as "ran anyway".
   */
  it("still calls it a loss when the phrase arrives buried in untrusted text, not as the sentence itself", () => {
    for (const line of [
      // Shaped like parseFindingItem's rejected-finding note (opencode.ts).
      'finding 2 of 3: Required at "severity" — {"file":"x.ts","claim":"t1 was answered by ' +
        'a fallback route here and the verdict still claims independence"}',
      // Shaped like the tier-unavailable note (review.ts), whose caught error text is
      // never under this module's control.
      "tier t2 (kimi-for-coding/k3) could not answer on either attempt and was SKIPPED — " +
        "its work passed to the next tier. Last error: upstream said t3 was answered by a stand-in",
    ]) {
      expect(isCoverageLoss(line), line).toBe(true);
    }
  });
});
