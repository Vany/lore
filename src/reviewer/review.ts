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
import { hunkAround, hunkStillPresent, makeScope } from "../core/scope.ts";
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
  store.closeTierRun(t0RunId, t0.findings.length > 0 ? "findings" : "clean");

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
    const rec: RecordedFinding = { ...f, fingerprint: fp, origin, round, firstSeen: new Date().toISOString() };
    if (store.recordFinding(reviewId, rec)) newFindings.push(rec);
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

    store.recordVerdict(reviewId, {
      fingerprint: fp,
      verdict: "justified-accepted",
      // The provenance travels with it. A reader six months from now needs to know
      // this was decided elsewhere and inherited, not ruled on by the tier named here.
      rationale: `carried forward from an earlier review of this repo (${prior.createdAt}): ${prior.rationale ?? "(no reason recorded)"}`,
      scope: prior.scope,
      tier: "carried",
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

  // 7. A defect that keeps recurring is a missing rule, not N unrelated bugs.
  promoteRecurring(store, review.repoId);

  // 8. Move the ladder.
  const withSettled = settle(review.ladder, accepted);
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
    t0Unavailable: t0.unavailable,
  };
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

  for (const file of files) {
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

      const blob = await blobSha(worktree, file);
      const hunk = hunkAround(source, mark.line);
      out.push({
        finding,
        reason: mark.reason,
        scope: blob === undefined ? undefined : makeScope(blob, hunk),
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
