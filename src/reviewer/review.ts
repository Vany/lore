/**
 * One round of a review: T0, then the current model tier, then the ladder moves.
 *
 * The reconciliation in step 3 is where the independent-auditor property actually
 * lives. A `lore-ok` comment is a *proposal*; the reviewer ratifies it by not
 * re-raising the finding, and rejects it by raising it again. That needs no extra
 * protocol and no extra output field — silence is assent, and a re-raise is a
 * reasoned refusal. The author never closes its own finding.
 *
 * SPEC: SPEC.md §4, spec/review-ladder.md §4
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_TIERS, anyTierRan, markUnavailable, settle, step, type Decision, type Tier } from "../core/ladder.ts";
import type { Finding } from "../core/finding.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { parseLoreOk } from "../core/lore-ok.ts";
import type { ReviewState } from "../core/review-state.ts";
import type { ReviewType } from "../core/review-type.ts";
import { Exhausted } from "../core/errors.ts";
import { hunkAround, hunkStillPresent, makeScope, type Scope } from "../core/scope.ts";
import { blobSha, computeDiff, renderDiff } from "../git/diff.ts";
import { treeHash } from "../git/repo.ts";
import { detectAndRecord, renderConflicts } from "../knowledge/conflict.ts";
import { promoteRecurring } from "../knowledge/derive.ts";
import { relevantTo } from "../knowledge/enrich.ts";
import { ingestDocs } from "../knowledge/ingest.ts";
import { runT0, renderT0 } from "../t0/runner.ts";
import type { RecordedFinding, Store } from "../store/store.ts";
import type { ReviewerLike } from "./opencode.ts";
import { reviewPrompt } from "./prompts.ts";

export interface RoundInput {
  readonly store: Store;
  readonly reviewer: ReviewerLike;
  readonly reviewId: string;
  readonly principal: string;
  readonly worktree: string;
  readonly type: ReviewType;
  readonly runTests?: boolean;
  /**
   * The deterministic layer, injectable exactly as `reviewer` is.
   *
   * T0 engines are selected by name and shell out, so a test could only switch them
   * off — and every test did (`t0: []`). That blind spot hid a defect where a T0
   * finding could never be justified: no test could produce a deterministic finding
   * and a `lore-ok` in the same round, which is the only arrangement that shows it.
   *
   * Faking the model was never enough. The loop has two sources of findings and they
   * are treated differently, so both have to be fakeable.
   */
  readonly t0?: typeof runT0;
}

export interface RoundResult {
  readonly decision: Decision;
  readonly tier: Tier;
  readonly newFindings: readonly RecordedFinding[];
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  /** Justifications retired because the code they were about changed. */
  readonly expired: readonly string[];
  /** Findings settled as `fixed`: not re-raised by a qualified tier, code moved (D-56). */
  readonly fixed: readonly string[];
  readonly t0Unavailable: readonly string[];
}

export async function runRound(input: RoundInput): Promise<RoundResult> {
  const { store, reviewId, principal, worktree, type } = input;
  const startedAt = new Date().toISOString();

  const review = store.getReview(reviewId, principal);
  if (review === undefined) throw new Error(`review ${reviewId} not found for this principal`);

  const tiers = type.tiers.length > 0 ? type.tiers : DEFAULT_TIERS;
  const tier = tiers[review.ladder.cursor];
  if (tier === undefined) throw new Error(`ladder cursor ${review.ladder.cursor} out of range`);

  // 1. What changed.
  const diff = await computeDiff(worktree, review.intoRef);

  // 2. Deterministic first. An LLM is never paid for what tsc decides for free.
  //
  // Opened before it runs, closed with what happened, for the same reason the model
  // tier is: T0 shells out to tsc, semgrep and a sandboxed test suite, any of which
  // can die, and a crash used to leave no row at all. A reviewer reading this code
  // raised exactly that — "T0 crashes mid-execution, no tier_run row exists, and a
  // reader cannot distinguish 'never ran' from 'ran and died'" — after the model
  // tier's half had been fixed and this half had not.
  const t0RunId = store.openTierRun(reviewId, "t0", review.ladder.round + 1, startedAt);
  let t0;
  try {
    t0 = await (input.t0 ?? runT0)(worktree, {
      engines: type.t0,
      ...(input.runTests !== undefined ? { runTests: input.runTests } : {}),
    });
  } catch (e) {
    store.closeTierRun(t0RunId, "failed");
    throw e;
  }
  store.closeTierRun(t0RunId, t0.findings.length > 0 ? "findings" : "clean", t0.unavailable);

  // 3. Justifications proposed since last round.
  // The changed files PLUS every file that already has an open finding.
  //
  // Changed-files-only was a silent trap. T0 scans the whole worktree, so it raises
  // findings in files the diff never touched — a semgrep rule firing on a test that
  // this branch did not modify. Those findings were then IMPOSSIBLE to justify: the
  // `lore-ok` sat in the source, in the right place, with the right fingerprint, and
  // nothing ever read it. Raised every round, never settled, so the ladder reset for
  // ever and the review could not reach `passed` by any route.
  //
  // Observed on this repo: `d6d9cd72` survived every review of 2026-08-03, and the
  // justification written for it was never once collected.
  //
  // A finding names its own file, which is the honest set to look in — where the
  // finding is, not where the diff is.
  //
  // lore-ok[34a89032]: correct — this was NOT in the ticket, which asked for four
  // other fixes. It stands anyway, and the reason is specific rather than general:
  // it is the fix for the defect that this very review was stuck on. `d6d9cd72`
  // could not be settled by any means while the collector read only changed files,
  // so the ladder could not advance past t1 and no later tier could ever be reached.
  // Reverting it would re-block the review that found it.
  //
  // The process complaint is upheld, not waved away: the ticket should have been
  // amended when the scope grew, and was not. What is being justified here is the
  // code, not the omission — a reviewer noticing an unrequested change against a
  // stated intent is the check working, and it should stay noisy about this.
  // Read ONCE and passed down. `collectJustifications` used to re-run the identical
  // query (5a90207a), which is not just a wasted round trip: two reads of the same
  // rows in one round can disagree, and the file list would then describe a set of
  // findings the collector never saw.
  const open = store.openFindings(reviewId);
  const justifiableFiles = [...new Set([...diff.changedFiles, ...open.map((f) => f.file)])];
  const pending = await collectJustifications(store, reviewId, worktree, justifiableFiles, open);

  // 4. Expire justifications whose code has changed, BEFORE the model tier runs.
  //
  // Without this the ladder rots into rubber-stamping: reasons accumulate, code
  // moves out from under them, and nothing is ever re-examined. An expired verdict
  // does not delete the reason — it stops the reason counting as settled, so the
  // finding may legitimately be raised again.
  const expired = await expireStaleVerdicts(store, reviewId, worktree);

  const settledForPrompt = store
    .settledFingerprints(reviewId)
    .map((fp) => {
      const f = store.openFindings(reviewId).find((o) => o.fingerprint === fp);
      const v = store.latestVerdict(reviewId, fp);
      return f === undefined ? undefined : { finding: f, rationale: v?.rationale };
    })
    .filter((x): x is { finding: RecordedFinding; rationale: string | undefined } => x !== undefined);

  // Re-ingest the repo's own documents. Deterministic and free, and it is what
  // makes a rule die when the paragraph that justified it is deleted (D-20).
  await ingestDocs(store, review.repoId, worktree);
  detectAndRecord(store, review.repoId);

  const prompt = reviewPrompt({
    tier,
    tierIndex: tiers.filter((t) => t.kind === "model").findIndex((t) => t.id === tier.id),
    modelTierCount: tiers.filter((t) => t.kind === "model").length,
    type,
    worktree,
    branch: review.branch,
    ticket: review.ticket,
    diff: renderDiff(diff),
    t0: renderT0(t0),
    // Selected against the changed files, not dumped wholesale: everything a repo
    // knows would crowd the diff out of the context window.
    knowledge: relevantTo(store, review.repoId, diff.changedFiles),
    conflicts: renderConflicts(store, review.repoId),
    settled: [...settledForPrompt, ...pending.map((p) => ({ finding: p.finding, rationale: p.reason }))],
  });

  // Opened BEFORE the model is asked, so the row exists no matter how this ends.
  // `finished_at` stays NULL until it does, which is what lets a reader tell a tier
  // that is working from one that stopped without saying so.
  // Say so BEFORE the money is spent when this diff is beyond anything this tier has
  // ever finished (D-58).
  //
  // Measured 2026-08-04: glm-5.2 at medium completed 21-30 KB in 685-1193s and blew
  // the entire 1800s budget at 69 KB. Discovering that costs a full deep-tier budget
  // to learn nothing, and reports `failed` — honest (INV-1), but honest far too late.
  // INV-7 already announces a truncated diff; nothing announced an oversized one.
  //
  // The ceiling is the tier's own demonstrated best, never a constant: with no
  // evidence it says nothing at all, which is the only honest thing to do with a
  // threshold nobody has calibrated (the trap D-50 names). It warns and proceeds
  // rather than refusing — the tier may well manage it, and a review stopped by a
  // guess is worse than one that runs long.
  const ceiling = store.largestCompletedDiff(tier.id);
  if (ceiling !== undefined && diff.totalChars > ceiling) {
    console.error(
      `[lore:log] ${reviewId}: this diff is ${Math.round(diff.totalChars / 1024)} KB, larger than anything ` +
        `${tier.id} has ever finished (${Math.round(ceiling / 1024)} KB). It may exceed the tier's time budget ` +
        `and fail after spending it. A smaller review scope is the fix, not a longer timeout.`,
    );
  }

  const tierRunId = store.openTierRun(reviewId, tier.id, review.ladder.round + 1, startedAt);

  let result;
  try {
    result = await input.reviewer.review(tier, prompt, worktree);
    // Closed with what this tier FOUND, in the same words T0 uses (line 99). The
    // column answers one question — what did this tier do — and `answered` did not
    // answer it: a tier that replied with nothing and one that replied with six
    // problems both read the same.
    store.closeTierRun(tierRunId, result.findings.length > 0 ? "findings" : "clean");
  } catch (e) {
    // The row is already open, so whatever happens next this tier leaves evidence.
    // Before this existed, a `glm-5.2` call that ran 30 minutes and timed out wrote
    // NOTHING, and the operator view could not tell it from a tier that never
    // started — INV-1 inside the bookkeeping.
    store.closeTierRun(tierRunId, e instanceof Exhausted ? "unpayable" : "failed");
    // A tier nobody can pay for is a limitation, not a failure (D-48). Record it,
    // step over it, and let the ladder finish with what it can afford — but only
    // if something else can still look. If nothing can, there is no review.
    if (!(e instanceof Exhausted)) throw e;

    const withoutTier = markUnavailable(review.ladder, tier.id);
    if (!anyTierRan(tiers, withoutTier.unavailable)) throw e;

    const skipped = step({ state: withoutTier, raised: [], tiers, needsHuman: false });
    // The tree is recorded on THIS path too (e49a67fe). It reaches `passed_partial`,
    // which is attestable — so without it the review would pass and then be refused
    // an attestation for having no tree, which is a regression the guard introduced
    // rather than a fault it caught. T0 and the tiers that could be paid for did read
    // this tree; that is exactly what a partial attestation claims.
    store.updateReview(reviewId, {
      ladder: skipped.state,
      state: toReviewState(skipped.decision),
      treeHash: await treeHash(worktree),
    });
    return {
      decision: skipped.decision,
      tier,
      newFindings: [],
      accepted: [],
      rejected: [],
      expired,
      fixed: [],
      t0Unavailable: [...t0.unavailable, `${tier.id}: ${e.message}`],
    };
  }

  store.recordUsage({
    repoId: review.repoId,
    reviewId,
    tier: tier.id,
    ...(tier.model !== undefined ? { model: tier.model } : {}),
    inputTokens: result.inputTokens,
    cachedTokens: result.cachedTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    // Omitted rather than zeroed when the reviewer could not count its own turns:
    // the column exists to become a distribution of how far reviews explore (D-50),
    // and a failed measurement stored as 0 would be indistinguishable from a review
    // that answered without looking at anything.
    ...(result.steps !== undefined ? { steps: result.steps } : {}),
    diffChars: diff.totalChars,
    outcome: result.retried ? "ok-after-retry" : "ok",
  });

  // 5. Record everything raised this round: T0's findings and the model's.
  const round = review.ladder.round + 1;
  const raised = [
    ...t0.findings.map((f) => ({ f, origin: "t0" })),
    ...result.findings.map((f) => ({ f, origin: tier.id })),
  ];

  const newFindings: RecordedFinding[] = [];
  const raisedFingerprints = new Set<string>();
  /**
   * The MODEL tier's fingerprints alone, which is what may reject a justification.
   *
   * T0 must be excluded and this is not a nicety. A justification is a claim that a
   * finding is wrong, and ruling on it means READING THE REASON. `tsc` and `semgrep`
   * cannot: they pattern-match, deterministically, and re-match every single round.
   *
   * With T0 counted, "the reviewer looked and raised it anyway" was true forever for
   * any deterministic finding — so a T0 false positive could never be justified, never
   * settled, and reset the ladder every round until a bound stopped the review. The
   * loop could not reach `passed` at all. Found by trying to justify one real semgrep
   * false positive on lore's own test suite.
   */
  const modelRaised = new Set<string>();

  for (const { f, origin } of raised) {
    const fp = fingerprint(f);
    raisedFingerprints.add(fp);
    if (origin !== "t0") modelRaised.add(fp);
    // The scope is taken NOW, while the code the finding is about is still the code
    // the tier saw. Without it a later round cannot tell a finding the author fixed
    // from one a tier simply stopped mentioning (D-56).
    const scope = await scopeOf(worktree, f.file, f.line);
    const rec: RecordedFinding = {
      ...f,
      fingerprint: fp,
      origin,
      round,
      firstSeen: new Date().toISOString(),
      ...(scope === undefined ? {} : { scope }),
    };
    if (store.recordFinding(reviewId, rec)) {
      newFindings.push(rec);
    } else {
      // Already on file, so the insert did nothing — but a RE-RAISE changes two
      // things the settling rule depends on, and both describe the last raise rather
      // than the first (D-56). The scope moves with the code; the origin rises to the
      // strongest tier that has confirmed the defect, and never falls.
      const prev = store.db
        .prepare("SELECT origin FROM finding WHERE review_id = ? AND fingerprint = ?")
        .get(reviewId, fp) as Record<string, string> | undefined;
      const stronger = tierRank(tiers, origin) > tierRank(tiers, prev?.["origin"] ?? origin) ? origin : undefined;
      store.refreshFinding(reviewId, fp, scope, stronger);
    }
  }

  // 5b. Carry forward justifications this repo already ratified.
  //
  // THE PRODUCT PREMISE, and it was missing. A fingerprint belongs to the review that
  // raised it, so a reason accepted last week matched nothing this week: every new
  // review re-raised every settled finding and the author re-submitted the same
  // comment forever. `lore` is supposed to remember between sessions; this is the
  // line where a review inherits what an earlier one decided.
  //
  // Two guards, and neither is optional:
  //
  //   * NOT if the model raised it this round. A model that reads the recorded reason
  //     and complains anyway is disagreeing with the lore, and that disagreement is
  //     worth more than the convenience of auto-closing. It falls through to the
  //     normal ruling below, which is where a bad justification gets rejected.
  //   * NOT if the code moved. A reason is about a piece of code and survives exactly
  //     as long as that code does — the same rule `expireStaleVerdicts` applies within
  //     a review, applied across them. Carrying one forward blind is how a ladder
  //     rots into rubber-stamping.
  const carried: string[] = [];
  // See `originalJustification`: the prefix used to nest, once per review.
  for (const fp of raisedFingerprints) {
    if (modelRaised.has(fp)) continue;
    const prior = store.priorAcceptedVerdict(review.repoId, fp, reviewId);
    if (prior?.scope === undefined) continue;

    const file = newFindings.find((f) => f.fingerprint === fp)?.file
      ?? (store.db.prepare("SELECT file FROM finding WHERE review_id = ? AND fingerprint = ?").get(reviewId, fp) as
        | Record<string, string>
        | undefined)?.["file"];
    if (file === undefined) continue;

    const source = await readFile(join(worktree, file), "utf8").catch(() => undefined);
    if (source === undefined || !hunkStillPresent(source, prior.scope.hunk)) continue;

    const origin = originalJustification(prior);
    store.recordVerdict(reviewId, {
      fingerprint: fp,
      verdict: "justified-accepted",
      // The provenance travels with it. A reader six months from now needs to know
      // this was decided elsewhere and inherited, not ruled on by the tier named here.
      rationale: `carried forward from an earlier review of this repo (${origin.at}): ${origin.reason}`,
      scope: prior.scope,
      tier: CARRIED_TIER,
      round,
    });
    carried.push(fp);
  }

  // 6. Rule on the pending justifications. Silence is assent.
  const accepted: string[] = [...carried];
  const rejected: string[] = [];
  for (const p of pending) {
    if (modelRaised.has(p.finding.fingerprint)) {
      // The reviewer looked and raised it anyway: the reason does not hold. A
      // mistaken justification is worse than a bug, because it was trusted.
      //
      // `modelRaised`, never `raisedFingerprints` — only something that can read the
      // reason is entitled to reject it. See the note where the two sets are built.
      rejected.push(p.finding.fingerprint);
      store.recordVerdict(reviewId, {
        fingerprint: p.finding.fingerprint,
        verdict: "justified-rejected",
        rationale: p.reason,
        scope: undefined,
        tier: tier.id,
        round,
      });
    } else {
      accepted.push(p.finding.fingerprint);
      store.recordVerdict(reviewId, {
        fingerprint: p.finding.fingerprint,
        verdict: "justified-accepted",
        rationale: p.reason,
        ...(p.scope !== undefined ? { scope: p.scope } : { scope: undefined }),
        tier: tier.id,
        round,
      });
      // An accepted justification is how the codebase acquires a fact about itself.
      store.addKnowledge({
        repoId: review.repoId,
        kind: "rule",
        source: "derived",
        statement: p.reason,
        why: `accepted justification for: ${p.finding.claim}`,
        path: p.finding.file,
        ...(p.finding.cwe !== undefined ? { cwe: p.finding.cwe } : { cwe: undefined }),
        provenance: p.finding.fingerprint,
        sourceBlob: undefined,
        confidence: 0.7,
      });
    }
  }

  // 6b. Settle what the author FIXED. Silence rules here exactly as it does above,
  // with two guards: only a tier qualified to see it may close it, and the code must
  // actually have moved (D-56).
  const answeredOtherwise = new Set<string>([...pending.map((p) => p.finding.fingerprint), ...expired]);
  const fixed = await settleFixed(
    store, reviewId, worktree, tiers, tier, open, raisedFingerprints, answeredOtherwise, round,
  );

  // 7. A defect that keeps recurring is a missing rule, not N unrelated bugs.
  promoteRecurring(store, review.repoId);

  // 8. Move the ladder.
  // `fixed` belongs here as much as `accepted` does (cadd3821). The store has always
  // counted both as settled — `settledFingerprints` and `openFindings` agree — and the
  // ladder was the only view that did not. That disagreement livelocks: a re-raised
  // fixed fingerprint looks fresh to `step`, which resets the ladder, while
  // `openFindings` excludes it and `undelivered` has already delivered it. The client
  // is told `findings_ready` and handed nothing, for ever, until a bound stops it.
  const withSettled = settle(review.ladder, [...accepted, ...fixed]);
  const stepped = step({
    state: withSettled,
    raised: [...raisedFingerprints],
    tiers,
    needsHuman: store.openConflicts(review.repoId).length > 0,
  });

  // The model tier's row is ALREADY closed — on the success path above, or in the
  // catch. It is deliberately not closed again here.
  //
  // It used to be, with `stepped.decision.kind`, and `closeTierRun` is a plain
  // UPDATE: the second write destroyed the first. The tier's own result was
  // replaced by the LADDER's decision, and `finished_at` was pushed out to include
  // this bookkeeping. Two vocabularies landed in one column — {clean, findings,
  // failed, unpayable} from the tier, {passed, findings, escalate, stopped, ...}
  // from the ladder — so the column no longer answered which question it was for.
  //
  // Not cosmetic. `make status` paints `stopped` red as DID-NOT-RUN, so on
  // 2026-08-03 `rev_UsgaL105JyrNJEBD8L9NwKFX` showed `t1·r4 ✘ stopped 485s` for a
  // round where t1 answered and was CLEAN; the ladder stopped, not the tier. It
  // took a SQL query to find that out. A tier that ran and found nothing, shown as
  // a tier that did not finish, is INV-1 upside down — and the audit trail is where
  // that rule is least allowed to bend.
  //
  // The decision belongs to the review, and that is where it is written, next.
  // The tree the tiers ACTUALLY read, recorded every round.
  //
  // `review_submit` used to be the only writer of this column, so a review that
  // needed no fixes reached `passed` having never recorded one — and the first
  // attestation ever produced said "reviewed tree unknown". An attestation that
  // cannot name the tree it covers is not an attestation; D-40 exists to say the
  // signature covers a tree rather than a branch name, and a null there quietly
  // undoes it. Written here because this is the layer that HAS the worktree and
  // knows the tiers just finished reading it.
  // lore-ok[8afe6f81]: true of commit 10ed157 and not of the tree under review,
  // which carries both the line and its test. The test is the answer to e5700124,
  // raised against that very commit — a fix, a finding, then the test, which is the
  // loop working rather than a gap in it.
  store.updateReview(reviewId, {
    ladder: stepped.state,
    state: toReviewState(stepped.decision),
    treeHash: await treeHash(worktree),
  });

  return {
    decision: stepped.decision,
    tier,
    newFindings,
    accepted,
    rejected,
    expired,
    fixed,
    t0Unavailable: t0.unavailable,
  };
}

/**
 * Where a tier sits in the ladder. `-1` for anything not in it — T0, or a tier a
 * deployment has since removed — which compares below every real tier, so an unknown
 * origin can never out-rank one and quietly gain the right to close findings.
 */
/** The tier stamped on a verdict this code wrote, rather than one a model ruled. */
export const CARRIED_TIER = "carried";

const CARRY_PREFIX = /^carried forward from an earlier review of this repo \(([^)]+)\): /;

/**
 * The decision a carried justification actually rests on.
 *
 * D-51 carries an accepted justification into a later review. Without unwrapping, the
 * carry wraps the previous rationale in its own prefix and a justification surviving
 * N reviews accumulates N prefixes — observed at thirteen on this repository in one
 * day, ~62 characters each, growing without bound and burying the one sentence a
 * reader wants. Unwrapping keeps the ORIGINAL reason and the date it was FIRST
 * decided at constant size; the outer prefix only ever named the previous hop.
 *
 * **Only text this code wrote is unwrapped**, identified by the tier stamped on the
 * verdict. `rationale` otherwise comes verbatim from an author's `lore-ok` comment,
 * and matching the prose would let a legitimate reason that happens to begin
 * "carried forward from an earlier review of this repo (…)" be truncated and
 * re-dated — rewriting what a reviewer actually ratified. Provenance is recognised
 * by a field we control, never by parsing someone else's sentence.
 */
export function originalJustification(prior: {
  readonly rationale: string | undefined;
  readonly createdAt: string;
  readonly tier: string | undefined;
}): { readonly at: string; readonly reason: string } {
  const reason0 = prior.rationale ?? "(no reason recorded)";
  if (prior.tier !== CARRIED_TIER) return { at: prior.createdAt, reason: reason0 };

  // Exactly ONE layer — the one this code adds — never a loop.
  //
  // The tier guard above only proves the OUTERMOST verdict is ours. Everything
  // inside it is opaque: an author's `lore-ok` reason is unrestricted prose and may
  // legitimately begin with this very phrasing, especially now that agents are shown
  // `settled_because` and imitate what they read. Stripping repeatedly would eat
  // into that sentence on the second carry and adopt a date out of the author's own
  // text, rewriting what a reviewer actually ratified — the thing the guard exists
  // to prevent, reached one level down.
  //
  // One strip is also sufficient: carrying adds one prefix and removes one, so the
  // field cannot grow. A rationale that already carries several layers keeps them
  // and stops accumulating, which is the right trade — stale cosmetics beat altering
  // a ratified reason.
  const m = CARRY_PREFIX.exec(reason0);
  return m === null
    ? { at: prior.createdAt, reason: reason0 }
    : { at: m[1] ?? prior.createdAt, reason: reason0.slice(m[0].length) };
}

function tierRank(tiers: readonly Tier[], id: string): number {
  return tiers.findIndex((t) => t.id === id);
}

/**
 * The code a finding is about, as it stands right now.
 *
 * `undefined` when the file cannot be read or the finding names no line — both mean
 * "cannot tell", and every caller treats that as a reason to do nothing rather than
 * as evidence of anything.
 */
async function scopeOf(worktree: string, file: string, line: number | undefined): Promise<Scope | undefined> {
  if (line === undefined) return undefined;
  const source = await readFile(join(worktree, file), "utf8").catch(() => undefined);
  if (source === undefined) return undefined;
  const blob = await blobSha(worktree, file);
  if (blob === undefined) return undefined;
  return makeScope(blob, hunkAround(source, line));
}

/**
 * Settle findings the author FIXED (D-56).
 *
 * The mechanism is the one SPEC already uses for justifications: the reviewer rules
 * by not re-raising. This applies it to the other, and far more common, ending — the
 * author changed the code and the complaint no longer applies. Nothing recorded that
 * before, so `fixed` existed in `VerdictKind` and was written nowhere: a review could
 * pass having fixed three findings and attest "0 fixed", which is the artefact this
 * product exists to produce, understating its own work and implying the findings were
 * ignored.
 *
 * TWO guards, and neither is optional, because silence is weak evidence:
 *
 *   * **Only a QUALIFIED tier's silence counts.** `origin` is the tier that raised
 *     it, and tiers are ordered by cost and strength. t1 not repeating something t3
 *     found says nothing — t1 may simply be unable to see it — so closing a t3
 *     finding on t1's silence would be INV-1 exactly inverted: a review that did not
 *     look, recorded as one that found nothing. Only a tier at or above the origin
 *     may settle it, and T0 settles only its own.
 *   * **The code must have MOVED.** A tier that stops mentioning something whose code
 *     is untouched has changed its mind, which is not a fix; recording it as one puts
 *     a false claim in a signed line. A finding with no recorded scope is skipped for
 *     the same reason — absent means "cannot tell".
 *
 * And it never touches a finding this round answered some OTHER way, which the
 * existing tests caught immediately:
 *
 *   * A `lore-ok` is written INTO the file it defends, so the code moves and a
 *     justification would have been recorded as a fix — losing the reason, and with
 *     it the only record of why the code stands.
 *   * `expireStaleVerdicts` re-opens a finding *because the code moved*, precisely so
 *     it gets looked at again. Closing it here on that same fact would use one
 *     observation to both open and close it, so no justification could ever actually
 *     expire — quietly removing the guard against rubber-stamping (§4.1).
 */
async function settleFixed(
  store: Store,
  reviewId: string,
  worktree: string,
  tiers: readonly Tier[],
  tier: Tier,
  open: readonly RecordedFinding[],
  raised: ReadonlySet<string>,
  /** Fingerprints this round already answered some other way — never also `fixed`. */
  answered: ReadonlySet<string>,
  round: number,
): Promise<readonly string[]> {
  const rank = (id: string) => tierRank(tiers, id);
  const here = rank(tier.id);
  const fixed: string[] = [];

  for (const f of open) {
    if (raised.has(f.fingerprint)) continue;
    if (answered.has(f.fingerprint)) continue;
    if (f.scope === undefined) continue;

    // T0 re-scans the whole worktree every round, so its silence is authoritative
    // for its own findings and means nothing for anyone else's.
    const qualified = f.origin === "t0" ? tier.id === "t0" || here >= 0 : here >= 0 && here >= rank(f.origin);
    if (!qualified) continue;

    // Unreadable is CANNOT TELL, and cannot tell never settles (c037b812). The old
    // condition fell through to `fixed` when the read failed, so a permissions error
    // or a transient I/O fault read as evidence the code had moved — the opposite of
    // what it means. It is the same rule the absent-scope check above already states
    // and it has to hold on both paths, or the weaker one decides.
    const source = await readFile(join(worktree, f.file), "utf8").catch(() => undefined);
    if (source === undefined) continue;
    if (hunkStillPresent(source, f.scope.hunk)) continue;

    store.recordVerdict(reviewId, {
      fingerprint: f.fingerprint,
      verdict: "fixed",
      rationale: `not re-raised by ${tier.id} and the code it named has changed`,
      scope: undefined,
      tier: tier.id,
      round,
    });
    fixed.push(f.fingerprint);
  }
  return fixed;
}

/**
 * Retire accepted justifications whose code has moved on.
 *
 * A justification is a claim about specific code (`spec/review-ladder.md` §4.1).
 * When that code changes the reason may no longer hold, so the verdict stops
 * counting and the finding becomes open again.
 *
 * Recorded as a new verdict rather than by mutating the old one: *why* something
 * was re-opened is exactly the kind of thing that gets re-argued if it is not
 * written down.
 */
async function expireStaleVerdicts(
  store: Store,
  reviewId: string,
  worktree: string,
): Promise<readonly string[]> {
  const gone: string[] = [];

  for (const fingerprint of store.settledFingerprints(reviewId)) {
    const verdict = store.latestVerdict(reviewId, fingerprint);
    // Only justifications expire. A fix is a change to the code itself, not a
    // claim about it, so there is nothing to go stale.
    if (verdict?.verdict !== "justified-accepted" || verdict.scope === undefined) continue;

    const finding = store.db
      .prepare("SELECT file FROM finding WHERE review_id = ? AND fingerprint = ?")
      .get(reviewId, fingerprint) as Record<string, string> | undefined;
    if (finding === undefined) continue;

    const source = await readFile(join(worktree, finding["file"] ?? ""), "utf8").catch(() => undefined);
    const stillThere = source !== undefined && hunkStillPresent(source, verdict.scope.hunk);
    if (stillThere) continue;

    store.recordVerdict(reviewId, {
      fingerprint,
      verdict: "justified-rejected",
      rationale: `expired: the code this reason was about has changed. Previously: ${verdict.rationale ?? "(no reason recorded)"}`,
      scope: undefined,
      tier: "expiry",
      round: 0,
    });
    gone.push(fingerprint);
  }
  return gone;
}

/**
 * Read `lore-ok` comments and match them to the findings they answer.
 *
 * A comment matching two findings is a hard error: resolving ambiguity by picking
 * would close a defect nobody examined.
 *
 * A comment matching NOTHING is skipped and logged, not fatal. Three kinds of marker
 * legitimately match nothing in the current review, and only the last is a mistake:
 *
 *   * a justification accepted by an earlier review — fingerprints belong to the
 *     review that raised them, so this is what every mature repo looks like;
 *   * a documented example of the format (ours says `lore-ok[a1b2c3d4]`);
 *   * a typo in the fingerprint, which closes nothing and must be visible.
 *
 * Telling them apart from here is guesswork, so the honest move is to skip and say
 * so rather than to fail the round or to close a finding on a coincidence.
 */
/** Where a justification lives when its own file cannot hold a comment (D-57). */
export const LEDGER = ".lore-ok.md";

async function collectJustifications(
  store: Store,
  reviewId: string,
  worktree: string,
  files: readonly string[],
  /** The caller's open findings — the same read `files` was derived from. */
  open: readonly RecordedFinding[],
): Promise<readonly { finding: RecordedFinding; reason: string; scope: ReturnType<typeof makeScope> | undefined }[]> {
  if (open.length === 0) return [];
  const byFingerprint = new Map(open.map((f) => [f.fingerprint, f]));

  const out: { finding: RecordedFinding; reason: string; scope: ReturnType<typeof makeScope> | undefined }[] = [];

  // The repo-level ledger, always read (D-57).
  //
  // A `lore-ok` is a comment, and some files have no comment syntax at all: JSON,
  // lockfiles, generated output, anything binary. A finding raised against one of
  // those had NOWHERE to put its reason, so it could only ever be fixed — and if it
  // should not be fixed, it was re-raised for ever with no way to answer. Hit on
  // `deploy/tiers.zai-openai.json` (c618aec7), where the tier schema is `.strict()`
  // so smuggling a key in is a parse error rather than a workaround.
  //
  // Markdown, so the existing `<!-- lore-ok[...] -->` form works and no new syntax
  // enters the vocabulary. One file, at the repo root, listed here rather than
  // discovered — a justification nothing reads is the failure this mechanism exists
  // to prevent, so where it may live is a closed set.
  // A Set because the ledger is itself a file, and a round that edits it would
  // otherwise scan it twice and propose every reason in it twice over.
  for (const file of new Set([...files, LEDGER])) {
    const source = await readFile(join(worktree, file), "utf8").catch(() => undefined);
    if (source === undefined) continue;

    for (const mark of parseLoreOk(source)) {
      const fp = store.resolveShort(reviewId, mark.short);
      if (fp === undefined) {
        // Named so a typo is findable. Silence here would mean an agent believes it
        // answered a finding it never touched.
        console.error(
          `[lore:log] lore-ok[${mark.short}] at ${file}:${mark.line} matches no finding in this review — ignored`,
        );
        continue;
      }
      const finding = byFingerprint.get(fp);
      if (finding === undefined) continue; // already settled in an earlier round

      // The scope is taken from the code the reason DEFENDS, never from wherever the
      // reason happens to be written (3f0e2139).
      //
      // `expireStaleVerdicts` looks the hunk up in the FINDING's file, so a scope
      // taken from the scanning file only worked while the two were the same file.
      // The ledger broke that silently and badly: a justification in `.lore-ok.md`
      // recorded a hunk of markdown, which can never appear in the JSON it defends,
      // so it expired the round after it was accepted — re-opening the finding and
      // restarting the ladder for ever, which is the exact loop D-57 exists to end.
      //
      // Taking it from the finding is also the more honest rule for the in-file case
      // it replaces: the reason should go stale when the CODE moves, not when someone
      // rewords the comment beside it.
      out.push({
        finding,
        reason: mark.reason,
        scope: await scopeOf(worktree, finding.file, finding.line),
      });
    }
  }
  return out;
}

function toReviewState(d: Decision): ReviewState {
  switch (d.kind) {
    case "findings":
      return "findings_ready";
    case "fastClean":
      return "fast_clean";
    case "passed":
      return "passed";
    case "passedPartial":
      return "passed_partial";
    case "needsHuman":
      return "needs_human";
    case "stopped":
      // A bound was hit. Not a pass — the code past that point was never reviewed.
      return "failed";
    default:
      return "running";
  }
}

/** Convenience for the CLI: a Finding is not yet a RecordedFinding. */
export function record(f: Finding, origin: string, round: number): RecordedFinding {
  return { ...f, fingerprint: fingerprint(f), origin, round, firstSeen: new Date().toISOString() };
}
