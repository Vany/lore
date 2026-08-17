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
});
