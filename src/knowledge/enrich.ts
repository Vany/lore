/**
 * Giving a finding its history.
 *
 * *"Seen 4× on this branch; the rule from 2026-07-11 says X"* is a different object
 * from the same finding raised cold. One is a defect; the other is evidence of a
 * pattern, and it tells the reader whether to fix the line or fix the habit.
 *
 * This is where the knowledge layer pays for itself on every review, rather than
 * only when someone thinks to query it.
 *
 * SPEC: spec/knowledge.md §5
 */

import { normalizeClaim } from "../core/finding.ts";
import { jaccard, scopesOverlap, subjectTokens } from "./conflict.ts";
import { rank } from "./ingest.ts";
import type { KnowledgeItem, PriorFinding, RecordedFinding, Store } from "../store/store.ts";

export interface Enrichment {
  /** How many times this defect has been raised in this repo before, ever. */
  readonly priorOccurrences: number;
  /**
   * How the earlier sightings were ANSWERED — which decides what to ask for.
   *
   * A count alone is an adjective and produced nothing: one semgrep rule was raised
   * 63 times across this deployment and justified away 63 times, and no client ever
   * did anything but write the same justification again. The number was never the
   * useful part; the verdicts are (D-79).
   *
   * Repeatedly FIXED means the code keeps doing this and the answer is probably a
   * rule or a helper rather than an Nth manual fix. Repeatedly JUSTIFIED means the
   * check keeps being wrong here, which is a question for a person and not something
   * the author can settle by editing the line again.
   */
  readonly priorFixed: number;
  readonly priorJustified: number;
  /** Rules and past lessons that bear on it. */
  readonly related: readonly KnowledgeItem[];
}

/**
 * Loose enough to catch a paraphrase, tight enough not to attach everything.
 *
 * Shared by `relatedTo` (attaching a rule) and `sameDefectPriors` (counting a prior
 * occurrence): both ask "is this actually about the same thing", just for different
 * stakes.
 */
const RELATED_THRESHOLD = 0.35;

export function enrich(store: Store, repoId: string, finding: RecordedFinding): Enrichment {
  const prior = sameDefectPriors(store, repoId, finding);
  let fixed = 0;
  let justified = 0;
  for (const p of prior) {
    if (p.verdict === "fixed") fixed += 1;
    else if (p.verdict === "justified-accepted") justified += 1;
  }
  return {
    priorOccurrences: prior.length,
    priorFixed: fixed,
    priorJustified: justified,
    related: relatedTo(store, repoId, finding),
  };
}

/**
 * Earlier sightings of THIS SAME DEFECT, across every review of this repo — not
 * merely findings that happen to share a CWE.
 *
 * `store.priorLike` fetches candidates matched on normalised claim OR shared CWE
 * (D-44): CWE catches the same weakness described in different words, which the exact
 * fingerprint cannot. But CWE alone is a weak signal — CWE-20 spans nearly any
 * input-validation defect in the repo — so a CWE-only candidate is corroborated
 * against claim-text similarity before it counts. A normalised-claim match always
 * passes: its token sets are effectively identical, so it clears the threshold
 * trivially and needs no special case.
 *
 * lore-ok[4029f8b3]: found real by lore's own review — `countPrior` used to count
 * every CWE-or-claim candidate unconditionally (see `store.priorLike`'s docs for the
 * full incident). `renderEnrichment` turns `priorOccurrences`/`priorFixed`/
 * `priorJustified` into an escalation ("the check itself may be wrong here — TELL
 * YOUR USER"), so an inflated count was not cosmetic: it told a client to escalate a
 * misfire that never happened, on any finding tagged with a common CWE.
 */
function sameDefectPriors(store: Store, repoId: string, f: RecordedFinding): readonly PriorFinding[] {
  const needle = subjectTokens(f.claim);
  return store
    .priorLike(repoId, f.fingerprint, normalizeClaim(f.claim), f.cwe)
    .filter((p) => jaccard(subjectTokens(p.claim), needle) >= RELATED_THRESHOLD);
}

function relatedTo(store: Store, repoId: string, f: RecordedFinding): readonly KnowledgeItem[] {
  const items = store.knowledgeFor(repoId, undefined, 1000);
  const needle = subjectTokens(`${f.claim} ${f.file}`);

  const scored = items
    .map((k) => ({
      k,
      score:
        (k.cwe !== undefined && k.cwe === f.cwe ? 0.5 : 0) +
        (k.path !== undefined && f.file.startsWith(k.path) ? 0.2 : 0) +
        jaccard(subjectTokens(k.statement), needle),
    }))
    .filter((s) => s.score >= RELATED_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.k);

  return rank(scored);
}

/**
 * One line appended to a finding when its history is worth stating — and it must ASK
 * for something (D-79).
 *
 * This used to say only *"seen 23× before in this repo — this is a pattern, not an
 * incident"*. True, and an adjective: it named a pattern and requested nothing, so a
 * client answered the single line in front of it and saw the same finding again next
 * review. Measured across this deployment: one rule raised 63 times, justified away 63
 * times, never once escalated to a person.
 *
 * The verdicts decide which question to ask, because the two histories want opposite
 * answers — one is a defect the code keeps reintroducing, the other is a check that
 * does not belong here, and only one of them is fixable by editing the line.
 */
export function renderEnrichment(e: Enrichment): string | undefined {
  const parts: string[] = [];
  if (e.priorOccurrences >= 2) {
    const n = e.priorOccurrences;
    if (e.priorJustified > e.priorFixed && e.priorJustified >= 2) {
      // The check is the thing that is wrong. Writing the justification again is
      // still the contract — but silently doing so is what bought 63 repetitions.
      parts.push(
        `raised ${n}× in this repo and justified away ${e.priorJustified}× — the check itself may be wrong here. ` +
          "Answer it as usual, then TELL YOUR USER it keeps misfiring: only a person can decide to stop it",
      );
    } else if (e.priorFixed >= 2) {
      parts.push(
        `fixed ${e.priorFixed}× in this repo already and back again — fix this instance, then ask what keeps ` +
          "producing it. A rule, a lint or a helper is the answer; an Nth manual fix is not",
      );
    } else {
      parts.push(
        `seen ${n}× before in this repo — a pattern rather than an incident. Worth asking why it recurs, ` +
          "not only fixing it here",
      );
    }
  }
  for (const k of e.related.slice(0, 2)) {
    parts.push(
      `${k.source} rule (${k.verifiedAt.slice(0, 10)}): ${k.statement}${k.why === undefined ? "" : ` — because ${k.why}`}`,
    );
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

/**
 * The knowledge a reviewer should be given for this change.
 *
 * Selected against the changed files, not dumped wholesale: everything a repo knows
 * would crowd the diff out of the context window, and a reviewer that cannot see
 * the change reviews nothing. Repo-wide rules are always included — they apply by
 * definition — and path-scoped ones only when the change touches their path.
 *
 * **POLICIES ARE EXCLUDED** (D-83). A development rule says what this project has
 * decided to enforce and what it has decided not to, which is nothing a reviewer needs
 * until somebody cites one — and sixty rules already occupy the space the diff wants.
 * The prompt carries their COUNT instead, and a cited policy's full text arrives with
 * the appeal that cites it, which is the only moment it decides anything.
 */
export function relevantTo(
  store: Store,
  repoId: string,
  changedFiles: readonly string[],
  limit = 60,
): readonly KnowledgeItem[] {
  const all = store.knowledgeFor(repoId, undefined, 1000);
  // lore-ok[372b6bf0,f9559e98]: was a raw `startsWith`, found wrong by lore's own
  // review — see `scopesOverlap`'s own docs (`conflict.ts`), which this now shares.
  // `"src/payroll/adapter.ts".startsWith("src/pay")` is true, so a rule scoped to
  // `src/pay` was handed to every review of `src/payroll/**` as a team decision.
  const chosen = all.filter((k) => k.kind !== "policy" && (k.path === undefined || changedFiles.some((f) => scopesOverlap(f, k.path))));
  return rank(chosen).slice(0, limit);
}
