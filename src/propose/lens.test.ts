/**
 * The prompts, checked against the contract the code that parses their replies
 * actually enforces — nothing here exercised a model, so nothing caught the gap.
 */

import { describe, expect, it } from "vitest";
import { criticPrompt, type LensInput } from "./lens.ts";

const INPUT: LensInput = {
  lens: "seams",
  folder: "src/store",
  commit: "abc1234",
  worktree: "/wt",
  question: "what would make this better to own?",
  knowledge: "",
};

/**
 * Fingerprint 33be1f60, found by lore's own review: this prompt's field list named
 * five fields and silently omitted two that `parseProposal` (proposal.ts) and
 * `screen` (screen.ts) both depend on — `trueIf`, which parsing hard-rejects when
 * empty, and `touches`, whose absence demotes an otherwise sound, correctly-placed
 * idea out-of-scope. A critic that followed its own instructions exactly could have
 * had its verdict rejected as malformed, or silently drop the proposer's own scope.
 */
describe("criticPrompt asks for every field parseProposal requires", () => {
  it("asks for trueIf, not just the four other required-or-optional fields", () => {
    const out = criticPrompt(INPUT, "some idea");
    expect(out).toMatch(/`trueIf`/);
  });

  // The bare word `touches` is not enough to check — the shared `scope()` section
  // already mentions it in a different sentence, to the proposer and critic alike.
  // What must be new is the FIELD-LIST bullet telling the critic its OWN reply needs
  // one, not just the general scope rule.
  it("tells the critic its own reply must carry touches, not just the general scope rule", () => {
    const out = criticPrompt(INPUT, "some idea");
    expect(out).toMatch(/\* `touches` — the files the change lands in/);
  });
});
