/**
 * `checks_skipped` CARRIES TWO DIFFERENT FACTS, and only one of them is a loss.
 *
 * Most entries mean *this check did not run, so anything it would have caught is
 * unexamined* — the reading INV-1 exists to protect. One kind does not: a tier that ran
 * on a route other than its configured one DID look at the code, and its opinion counts
 * in full. The MCP note has said so in prose since the line was added; the operator board
 * printed `did not run:` in front of every entry regardless, so it asserted the opposite
 * of a sentence's own content, on the surface an operator reads first.
 *
 * Vany, seeing it: *"did not run: t1 was answered by zai-coding-plan2/glm-5.2 … glm 5.2 is
 * ok for t1."* Both halves were wrong — the prefix, and the claim that a second Z.ai plan
 * is a different provider.
 *
 * ONE DEFINITION, written beside the phrasing it recognises, on the same reasoning as
 * `ruleClaim`/`engineRuleClass` in `t0/engines.ts`: the writer and every reader go through
 * this file, and a test asserts the round trip rather than the shape. A predicate
 * hand-rolled at each reader is the drift this codebase keeps paying for — and there are
 * three readers already (the board, the MCP note, and anyone summarising a verdict).
 *
 * A STRING TEST IS THE HONEST INSTRUMENT HERE and not a shortcut: `checks_skipped` is a
 * list of prose that is persisted in `tier_run.unavailable` and shipped to clients, so it
 * cannot grow a kind field without changing rows already written and a contract three
 * clients depend on. What it CAN do is have exactly one place that knows the wording.
 */

/**
 * The opening of the line a tier writes when it ran on a route it was not configured for.
 *
 * Exported so the writer builds its sentence from this rather than repeating it, which is
 * what makes the round trip a fact rather than a coincidence.
 */
export const RAN_ON_OTHER_ROUTE = "was answered by";

/**
 * Did this entry mean a check DID NOT RUN?
 *
 * `true` is the default for anything unrecognised, and deliberately so: a new entry whose
 * wording nobody taught this file reads as a loss, which is the safe direction. Guessing
 * the other way would let an unexamined check pass as covered, which is the one mistake
 * INV-1 forbids outright.
 */
export function isCoverageLoss(entry: string): boolean {
  return !entry.includes(RAN_ON_OTHER_ROUTE);
}
