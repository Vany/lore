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
 * Anchored at the start, not a bare `.includes()` — found by lore's own review reading
 * this file cold. Two `checks_skipped` writers embed UNTRUSTED text verbatim: a rejected
 * finding's note carries up to 300 characters of the model's own raw JSON
 * (`opencode.ts`'s `parseFindingItem`), and a tier-unavailable note carries a caught
 * error's `.message`. Either can legitimately CONTAIN the substring "was answered by" —
 * this repository reviews itself, and that exact phrase is the ladder's own vocabulary,
 * so a model commenting on this file, or an error message that happens to quote it, would
 * do it — and a bare substring test would then read a genuine coverage loss as "ran
 * anyway" on the operator board, inverting the one guarantee this module exists to keep.
 *
 * `\S+`, not `t\d+`: an earlier version of this fix anchored on the SHAPE of every tier
 * id this deployment happens to use, but `TierSchema` (`core/ladder.ts`) validates a tier
 * id as `z.string().min(1)` with only a uniqueness check — no `t<digits>` constraint. An
 * operator-authored ladder is free to name a tier anything, and the writer always opens
 * with `<tier id> was answered by `, so anchoring on the id's SHAPE rather than its
 * PRESENCE would silently reopen the same mislabel for any tier not shaped like the three
 * shipped configs. Neither untrusted writer's own text opens with a bare token followed
 * immediately by "was answered by" — they open with `finding N of M:` and `tier <id> (…)`
 * — so this stays exact for both directions without depending on id shape at all.
 */
const RAN_ON_OTHER_ROUTE_PREFIX = new RegExp(`^\\S+ ${RAN_ON_OTHER_ROUTE} `);

/**
 * Did this entry mean a check DID NOT RUN?
 *
 * `true` is the default for anything unrecognised, and deliberately so: a new entry whose
 * wording nobody taught this file reads as a loss, which is the safe direction. Guessing
 * the other way would let an unexamined check pass as covered, which is the one mistake
 * INV-1 forbids outright.
 */
export function isCoverageLoss(entry: string): boolean {
  return !RAN_ON_OTHER_ROUTE_PREFIX.test(entry);
}
