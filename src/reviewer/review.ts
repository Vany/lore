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
import { DEFAULT_TIERS, settle, step, type Decision, type Tier } from "../core/ladder.ts";
import type { Finding } from "../core/finding.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { parseLoreOk } from "../core/lore-ok.ts";
import type { ReviewType } from "../core/review-type.ts";
import { hunkAround, hunkStillPresent, makeScope } from "../core/scope.ts";
import { blobSha, computeDiff, renderDiff } from "../git/diff.ts";
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
  const t0 = await runT0(worktree, {
    engines: type.t0,
    ...(input.runTests !== undefined ? { runTests: input.runTests } : {}),
  });

  // 3. Justifications proposed since last round.
  const pending = await collectJustifications(store, reviewId, worktree, diff.changedFiles);

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

  const result = await input.reviewer.review(tier, prompt, worktree);

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

  for (const { f, origin } of raised) {
    const fp = fingerprint(f);
    raisedFingerprints.add(fp);
    const rec: RecordedFinding = { ...f, fingerprint: fp, origin, round, firstSeen: new Date().toISOString() };
    if (store.recordFinding(reviewId, rec)) newFindings.push(rec);
  }

  // 6. Rule on the pending justifications. Silence is assent.
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const p of pending) {
    if (raisedFingerprints.has(p.finding.fingerprint)) {
      // The reviewer looked and raised it anyway: the reason does not hold. A
      // mistaken justification is worse than a bug, because it was trusted.
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

  // T0 and the model tier each ran; both belong in the audit trail, and the
  // attestation counts distinct tiers from it.
  store.recordTierRun(reviewId, "t0", round, t0.findings.length > 0 ? "findings" : "clean", startedAt);
  store.recordTierRun(reviewId, tier.id, round, stepped.decision.kind, startedAt);

  store.updateReview(reviewId, {
    ladder: stepped.state,
    state: toReviewState(stepped.decision),
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
 * A comment whose short id matches nothing, or matches two findings, is a hard
 * error rather than a shrug: resolving ambiguity by picking would close a defect
 * nobody examined.
 */
async function collectJustifications(
  store: Store,
  reviewId: string,
  worktree: string,
  files: readonly string[],
): Promise<readonly { finding: RecordedFinding; reason: string; scope: ReturnType<typeof makeScope> | undefined }[]> {
  const open = store.openFindings(reviewId);
  if (open.length === 0) return [];
  const byFingerprint = new Map(open.map((f) => [f.fingerprint, f]));

  const out: { finding: RecordedFinding; reason: string; scope: ReturnType<typeof makeScope> | undefined }[] = [];

  for (const file of files) {
    const source = await readFile(join(worktree, file), "utf8").catch(() => undefined);
    if (source === undefined) continue;

    for (const mark of parseLoreOk(source)) {
      const fp = store.resolveShort(reviewId, mark.short);
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

function toReviewState(d: Decision): "findings_ready" | "fast_clean" | "passed" | "needs_human" | "failed" | "running" {
  switch (d.kind) {
    case "findings":
      return "findings_ready";
    case "fastClean":
      return "fast_clean";
    case "passed":
      return "passed";
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
