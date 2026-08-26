/**
 * The filter that removes ideas without blunting them.
 *
 * Four demotions, and only one of them drops a proposal. The asymmetry is the whole
 * design: an idea about somewhere else answers a question nobody asked, while a weakly
 * stated idea or one we have already had is still an idea the reader might want — so it
 * is kept, annotated, and ranked last. Silently discarding a generator's output is the
 * failure D-66 settled for findings, and it would be worse here, where the output is
 * meant to be surprising.
 *
 * **The knowledge screen is why the second run is cheaper than the first.** Without it
 * `propose` re-suggests splitting `store.ts` every quarter and costs the same hour of
 * appraisal each time. A codebase that records why it did NOT do things stops
 * re-arguing them, and that half of this idea is worth more than the ideas.
 *
 * SPEC: spec/propose.md §5, §6
 */

import type { KnowledgeItem } from "../store/store.ts";
import { inScope, type Demotion, type Proposal, type Screened } from "./proposal.ts";

/** How much of a statement must appear in an idea before we call it the same idea. */
const MIN_OVERLAP = 0.5;

/**
 * How many meaningful terms a statement needs before it can identify anything.
 *
 * Four was too few, and the failure was measured on the first real run: the ingested
 * rule *"The prompts do not ask for that, and the output shows it"* reduces to
 * `{ask, output, prompt, show}`, and three of those four turned up in an unrelated
 * 200-word paragraph about a budget guard. Three common words inside a long idea is
 * noise, not a restatement — and the idea was hidden behind a decision that had
 * nothing to do with it.
 */
const MIN_TERMS = 6;

/** And an absolute floor, so a long statement cannot match on its filler alone. */
const MIN_SHARED = 5;

/** Words too common to carry meaning when matching an idea against a decision. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "that", "this", "for", "on", "with",
  "as", "by", "be", "are", "was", "not", "no", "we", "should", "would", "must", "can", "from",
]);

/**
 * Words that carry meaning, singularised.
 *
 * The trailing `s` is stripped because "surfaces" and "surface" are the same idea and a
 * screen that misses a decision it has already made over a plural is unreliable in the
 * most uninteresting way possible. Crude on purpose — a real stemmer would raise the
 * false-match rate, and a false match is the one failure here that costs the reader
 * something they will never know they lost.
 */
function terms(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );
}

/**
 * Does this idea restate that rule?
 *
 * Deliberately crude, and deliberately biased toward NOT matching. A false match hides a
 * new idea behind an old decision, which is the one failure this screen can cause and
 * the expensive one — the reader never sees what they were not shown. A missed match
 * only costs them a paragraph they recognise.
 */
export function restates(idea: string, statement: string): boolean {
  const a = terms(statement);
  if (a.size < MIN_TERMS) return false;
  const b = terms(idea);
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit >= MIN_SHARED && hit / a.size >= MIN_OVERLAP;
}

/**
 * Rank and annotate. Order out is the order the document prints.
 *
 * Survivors first, then everything demoted, then the unappraisable — and within each
 * group the input order, so a run is reproducible against its own transcript.
 */
export function screen(
  proposals: readonly Proposal[],
  folder: string,
  knowledge: readonly KnowledgeItem[],
  /**
   * Does this path exist in the tree that was read?
   *
   * Optional so the pure tests need no filesystem; when absent, paths are taken on
   * trust and nothing is annotated — which is exactly what the first sweep did, and
   * why four proposals shipped naming files that were never there.
   */
  exists?: (path: string) => boolean,
): readonly Screened[] {
  // A rejection is recorded as a `mistake` — the kinds are rule | fact | mistake, and
  // "we considered X and rejected it because Y" is the mistake we would otherwise make
  // again. The text test catches rejections taught as rules, which is how a person
  // writes one by hand.
  //
  // `do not` and `don't` USED TO BE IN THAT LIST and had to come out. Almost every rule
  // in a codebase is phrased as a prohibition — "reviewers do not write to the repo" —
  // so the pattern classified the whole knowledge base as decisions-against, and any
  // idea unlucky enough to share words with one was reported to the reader as already
  // rejected. Measured on the first real run.
  //
  // `kind !== "fact"` GUARDS THE TEXT MATCH — found by lore's own review, fingerprint
  // dda7d5b7: `run.ts`'s own `knowledgeBlock` (lore-ok 77edbad4) already split `fact`
  // rows out of the prompt as "UNVERIFIED, FROM ONE BRANCH'S FIRST READING", precisely
  // because a bootstrap-derived reading can suppress or bias the ideas this feature
  // exists to generate — but the screen half kept trusting them. `kind === "mistake"`
  // is untouched: that classification is itself a deliberate record, never a fact row
  // guessing at one, so it needs no exclusion.
  const rejected = knowledge.filter(
    (k) => k.kind === "mistake" || (k.kind !== "fact" && /\b(?:considered|rejected|decided against)\b/i.test(k.statement)),
  );
  const taught = knowledge.filter((k) => k.source === "taught");

  const screened = proposals.map((proposal): Screened => {
    const demotions: Demotion[] = [];
    const because: string[] = [];

    const absent = exists === undefined ? [] : proposal.touches.filter((p) => !exists(p));
    // Everything it named is imaginary, so there is no idea here to appraise — the
    // same answer as an idea about somewhere else, for the same reason.
    if (exists !== undefined && proposal.touches.length > 0 && absent.length === proposal.touches.length) {
      demotions.push("out-of-scope");
      because.push(`names only files that do not exist: ${absent.join(", ")}`);
    } else if (absent.length > 0) {
      // Kept: the idea may be sound and one path invented. The reader is told which.
      demotions.push("invented-paths");
      because.push(`names ${String(absent.length)} file(s) that do not exist: ${absent.join(", ")} — read the rest with that in mind`);
    }

    if (!inScope(folder, proposal.touches)) {
      demotions.push("out-of-scope");
      because.push(
        proposal.touches.length === 0
          ? `named no files, so it cannot be placed inside ${folder || "the repository"}`
          : `lands in ${proposal.touches.join(", ")}, none of it inside ${folder}`,
      );
    }

    // Both fields, one demotion: a proposal you cannot appraise is a proposal you cannot
    // appraise, and listing two reasons for it would read as two problems.
    const missing = [
      proposal.settledBy === undefined ? "no measurement that would settle it" : undefined,
      proposal.preserves === undefined ? "does not say what it keeps working" : undefined,
    ].filter((m) => m !== undefined);
    if (missing.length > 0) {
      demotions.push("unappraisable");
      because.push(missing.join("; "));
    }

    // Found missing by lore's own review, fingerprint 287fffa0/67a0c784: `rejects` was
    // read for the knowledge write-back (writeBackRejections, run.ts) and by nothing
    // that decides what the DOCUMENT shows — a critic-rejected idea had no demotion of
    // its own and landed in "Appraise these" exactly like one that survived.
    if (proposal.rejects === true) {
      demotions.push("critic-rejects");
      because.push("the critic's own verdict was that this should not be pursued at all, not merely a disagreement with part of it");
    }

    const decided = rejected.find((k) => restates(proposal.idea, k.statement));
    if (decided !== undefined) {
      demotions.push("already-decided");
      because.push(`this repository decided against it on ${decided.verifiedAt.slice(0, 10)}: ${decided.statement}`);
    }

    const against = taught.find((k) => restates(proposal.idea, k.statement));
    if (against !== undefined && decided === undefined) {
      // Annotated, never dropped. A taught rule can be wrong and a model arguing with
      // one is worth reading — the reader is only told they are arguing with a decision
      // rather than with nothing.
      demotions.push("contradicts-taught");
      because.push(`argues against a taught rule: ${against.statement}`);
    }

    return { proposal, demotions, because };
  });

  const rank = (s: Screened): number => {
    if (s.demotions.length === 0) return 0;
    if (s.demotions.includes("out-of-scope")) return 3;
    if (s.demotions.includes("critic-rejects")) return 3;
    if (s.demotions.includes("unappraisable")) return 2;
    if (s.demotions.includes("invented-paths")) return 2;
    return 1;
  };
  return [...screened].sort((a, b) => rank(a) - rank(b));
}
