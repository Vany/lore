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
import {
  DEFAULT_TIERS,
  anyTierRan,
  markUnavailable,
  ladderChanged,
  ladderFingerprint,
  settle,
  step,
  type Decision,
  type LadderState,
  type Tier,
} from "../core/ladder.ts";
import type { Finding } from "../core/finding.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { parseLoreOk } from "../core/lore-ok.ts";
import { isTerminal, type ReviewState } from "../core/review-state.ts";
import type { ReviewType } from "../core/review-type.ts";
import { DidNotRun, TierUnavailable, TooLargeForTier } from "../core/errors.ts";
import { hunkAround, hunkStillPresent, makeScope, type Scope } from "../core/scope.ts";
import { blobSha, computeDiff, renderDiff } from "../git/diff.ts";
import { treeHash } from "../git/repo.ts";
import { detectAndRecord, renderConflicts } from "../knowledge/conflict.ts";
import { promoteRecurring } from "../knowledge/derive.ts";
import { relevantTo } from "../knowledge/enrich.ts";
import { ingestDocs } from "../knowledge/ingest.ts";
import { screenFor, screenUsage, type ScreenUsage } from "../knowledge/screen.ts";
import { runT0, renderT0 } from "../t0/runner.ts";
import { engineRuleClass } from "../t0/engines.ts";
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

/**
 * Fit the prompt to this tier's context window by shrinking the DIFF, and error only
 * when even a compacted prompt cannot fit.
 *
 * The diff is the only part that is both large and safely reducible. Everything else
 * — the ticket, the knowledge, the settled ledger, the output contract — is either
 * small or load-bearing, and cutting those would change what the reviewer is asked
 * rather than how much of the code it sees.
 *
 * **Announced, always.** A shortened diff means the reviewer did not see the whole
 * change, and a reviewer that does not know that will report clean about code it never
 * read — INV-7, and the reason truncation has always carried a notice.
 *
 * **Compaction failing is an error, not a skip.** If the fixed parts alone overflow
 * the window there is nothing to cut that would not change the question, and a review
 * that cannot ask the question did not run.
 */
export async function compactToFit(
  reviewer: ReviewerLike,
  tier: Tier,
  diffText: string,
  build: (diffText: string) => string,
): Promise<string> {
  const budget = await reviewer.promptBudgetChars?.(tier);
  const full = build(diffText);
  // No measurable window is NOT a licence to send less. An unmeasurable tier gets the
  // whole thing, exactly as before this existed.
  if (budget === undefined || full.length <= budget) return full;

  // What the prompt costs with no diff at all — the floor we cannot compact below.
  const floor = build("").length;
  const NOTICE_ROOM = 500;
  const room = budget - floor - NOTICE_ROOM;

  // Below this a "diff" is not a diff, it is a fragment — and a tier given a fragment
  // produces confident findings about code it mostly did not see. Better to say so.
  const MIN_USEFUL_DIFF = 4_000;
  if (room < MIN_USEFUL_DIFF) {
    throw new TooLargeForTier(tier.id, tier.model ?? "", Math.round(floor / 4), budget);
  }

  const kept = diffText.slice(0, room);
  return build(
    `${kept}\n\n[COMPACTED FOR THIS TIER: ${kept.length} of ${diffText.length} characters shown. ` +
      `${tier.id} (${tier.model ?? "?"}) cannot hold the whole diff, so the rest was cut to fit its context ` +
      `window. YOU HAVE NOT SEEN THE WHOLE CHANGE — read the remainder from the worktree before concluding ` +
      `anything is absent, and say so if you could not. A smaller review scope is the real fix.]`,
  );
}

export async function runRound(input: RoundInput): Promise<RoundResult> {
  const { store, reviewId, principal, worktree, type } = input;
  const startedAt = new Date().toISOString();

  const review = store.getReview(reviewId, principal);
  if (review === undefined) throw new Error(`review ${reviewId} not found for this principal`);

  // TOCTOU with cancellation, closed at the last moment before anything is spent.
  //
  // `claimJob` refuses a terminal review's jobs now, but a job claimed microseconds
  // before `review_cancel` lands is already past that gate — and the next thing this
  // function does is run T0 and then pay a model tier. Checking here means the worst
  // case is a round that starts and stops, rather than one that spends and then
  // writes a ladder step onto a review somebody deliberately ended.
  if (isTerminal(review.state)) {
    throw new DidNotRun(
      `review ${reviewId} is '${review.state}' — no further rounds. Nothing was spent on this one.`,
    );
  }

  const tiers = type.tiers.length > 0 ? type.tiers : DEFAULT_TIERS;

  // THE LADDER THIS REVIEW STARTED ON, OR NONE AT ALL.
  //
  // `ladder.cursor` is an index resolved against whatever config is loaded now. Switch
  // `LORE_TIERS` with a review open — done deliberately on 2026-08-06, to prove the Kimi
  // tier and then switch back — and cursor 1 stops meaning the tier it meant. The review
  // resumes on a different model, and `tier_run` ends up with two rows both called `t1`
  // naming different vendors, in the one table that exists to say whether a review
  // really ran. Not a crash: a corrupted audit trail, which is worse, and an attestation
  // over the top of it.
  //
  // REFUSED rather than remapped. Remapping would need a rule for a tier that no longer
  // exists and another for one that appeared, and every such rule is a guess about what
  // the operator meant. Refusing costs a restarted review and says exactly why; the
  // client can start a fresh one against the ladder that is actually configured.
  // Reviews started before the column exists carry nothing and are not checked — they
  // were never pinned to anything, and inventing a ladder for them would strand work
  // over a comparison nobody made.
  // Compared field by field rather than as strings — see `ladderChanged`. A pin that
  // merely grew a field is not a ladder that moved, and refusing on that costs exactly
  // the work this check exists to protect.
  const started = review.tiers;
  const nowRunning = ladderFingerprint(tiers);
  if (started !== undefined && ladderChanged(started, nowRunning)) {
    throw new DidNotRun(
      `review ${reviewId} began on a different ladder and cannot be resumed on this one — it started with ` +
        `[${started}] and the service is now configured with [${nowRunning}]. Its cursor is an index into the ` +
        `first list, so continuing would run a different model under the same tier name and record it as though ` +
        `nothing had changed. Start a fresh review of this branch against the current ladder.`,
    );
  }

  const tier = tiers[review.ladder.cursor];
  if (tier === undefined) throw new Error(`ladder cursor ${review.ladder.cursor} out of range`);

  // 1. What changed.
  const diff = await computeDiff(worktree, review.intoRef);
  store.setBehindBy(reviewId, diff.behindBy);

  // 2. Deterministic first. An LLM is never paid for what tsc decides for free.
  //
  // Opened before it runs, closed with what happened, for the same reason the model
  // tier is: T0 shells out to tsc, semgrep and a sandboxed test suite, any of which
  // can die, and a crash used to leave no row at all. A reviewer reading this code
  // raised exactly that — "T0 crashes mid-execution, no tier_run row exists, and a
  // reader cannot distinguish 'never ran' from 'ran and died'" — after the model
  // tier's half had been fixed and this half had not.
  // The tree every tier in THIS round reads, recorded on each run. Since a closed tier
  // is not re-run after a fix (D-6, revised), "tiers that ran" and "tiers that read the
  // signed tree" are different sets, and only the second is what an attestation may
  // claim (`spec/review-ladder.md` §5).
  const roundTree = await treeHash(worktree);
  // lore-ok[bb2c32f5]: the reasoning is right and the fix belongs one layer down, so
  // this line is deliberately unchanged. T0's row IS stamped at entry, and that is
  // correct — T0's work does start here. What was wrong is that `roundStartedAt`
  // answered with ANY open run, so during T0 the model tier's pacing read T0's clock.
  // It takes the tier now (`store.ts`), which makes the answer right for every tier at
  // once rather than relying on each one stamping itself defensively — and it returns
  // `undefined` before a tier begins, which is the honest elapsed-zero the caller wants.
  const t0RunId = store.openTierRun(reviewId, "t0", review.ladder.round + 1, startedAt);
  let t0;
  try {
    t0 = await (input.t0 ?? runT0)(worktree, {
      engines: type.t0,
    });
  } catch (e) {
    store.closeTierRun(t0RunId, "failed", [], roundTree);
    throw e;
  }

  // APPEALS ALREADY ACCEPTED, APPLIED BEFORE T0 REPORTS (D-83).
  //
  // Here rather than inside `runT0`: the engines are a pure function of the worktree
  // and have no store, and — more to the point — running them is not what an appeal
  // saves. What it saves is the ladder churn. A suppressed finding is never recorded,
  // so it never resets settling, never costs a round, and is never re-argued. Filtering
  // after the engines have spoken and before anything is written is exactly that.
  //
  // AND IT IS SAID OUT LOUD. A check switched off silently is the shape this whole
  // service exists to refuse, so each one lands in `checks_skipped` — the channel a
  // client already repeats to its user — naming the rule, the path, and the development
  // rule that bought it. Someone reading a later `passed` can see what it does not cover
  // and can go and argue with the rule instead of with the review.
  //
  // The model tier reads the same list (`renderT0`), which is the escape hatch and not
  // an accident: a tier is NOT bound by a suppression an engine's rule bought. If it
  // looks at that code and thinks it is genuinely wrong it raises the finding itself —
  // and a model finding has no engine rule class, so no appeal can silence it by class.
  // A team can decide a pattern-matcher is wrong for a place; it cannot decide a reader
  // may not look.
  const suppressed = store.liveSuppressions(review.repoId);
  //
  // TWO AUDIENCES, TWO TEXTS. The client's version quotes the rule; the reviewer's does
  // not, and that is D-83's design rather than an omission — `knowledge_teach` promises
  // that reviewers are told a project HAS development rules and never what they say, and
  // that a rule's text arrives only with the appeal that cites it. Writing the statement
  // into `t0.unavailable` put it into `renderT0`, and `renderT0` is in every model prompt
  // for every later round: one accepted appeal would have injected its rule into every
  // review of that repository for ever, which is exactly the standing injection the
  // design refuses. The client's channel is the audit trail and wants the whole reason.
  const silenced: string[] = [];
  const silencedForTier: string[] = [];
  const t0Findings = t0.findings.filter((f) => {
    const cls = engineRuleClass(f.claim);
    const s = cls === undefined ? undefined : suppressed.find((x) => x.ruleClass === cls && x.path === f.file);
    if (s === undefined) return true;
    silenced.push(
      `${cls ?? ""} was NOT reported at ${f.file} — ${s.tier} accepted an appeal to this project's ` +
        `development rule ${s.policyShort} ("${s.statement}") on ${s.acceptedAt.slice(0, 10)}. Anything that ` +
        "rule would have caught here is unexamined; retire the rule to switch it back on.",
    );
    silencedForTier.push(
      `${cls ?? ""} was NOT reported at ${f.file} — a tier accepted an appeal to one of this project's ` +
        "development rules. Nothing checked that rule's subject here; you are free to raise the underlying " +
        "problem yourself if you see it, and a finding you raise cannot be silenced this way.",
    );
    return false;
  });
  // `unavailable` reaches the CLIENT, through `unavailableChecks`; `t0ForTier` is what
  // `renderT0` turns into prompt text a few lines below.
  const t0ForTier = { ...t0, findings: t0Findings, unavailable: [...t0.unavailable, ...new Set(silencedForTier)] };
  t0 = { ...t0, findings: t0Findings, unavailable: [...t0.unavailable, ...new Set(silenced)] };

  store.closeTierRun(t0RunId, t0.findings.length > 0 ? "findings" : "clean", t0.unavailable, roundTree);

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
  // Observed on this repo: one semgrep false positive survived every review of a whole
  // justification written for it was never once collected.
  //
  // A finding names its own file, which is the honest set to look in — where the
  // finding is, not where the diff is.
  //
  // lore-ok[34a89032]: correct — this was NOT in the ticket, which asked for four
  // other fixes. It stands anyway, and the reason is specific rather than general:
  // it is the fix for the defect that this very review was stuck on. That finding
  // could not be settled by any means while the collector read only changed files,
  // so the ladder could not advance past t1 and no later tier could ever be reached.
  // Reverting it would re-block the review that found it.
  //
  // The process complaint is upheld, not waved away: the ticket should have been
  // amended when the scope grew, and was not. What is being justified here is the
  // code, not the omission — a reviewer noticing an unrequested change against a
  // stated intent is the check working, and it should stay noisy about this.
  // Read ONCE and passed down. `collectJustifications` used to re-run the identical
  // query, which is not just a wasted round trip: two reads of the same
  // rows in one round can disagree, and the file list would then describe a set of
  // findings the collector never saw.
  const open = store.openFindings(reviewId);
  const justifiableFiles = [...new Set([...diff.changedFiles, ...open.map((f) => f.file)])];
  const pending = await collectJustifications(store, reviewId, review.repoId, worktree, justifiableFiles, open);

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

  // Re-ingest the repo's own documents. It is what makes a rule die when the paragraph
  // that justified it is deleted (D-20).
  //
  // SCREENED BY THE CHEAPEST MODEL TIER, and that is the one place a model is paid for
  // what a rule could not decide. Extraction is still deterministic and free; the screen
  // only ever refuses, and only where three successive regex narrowings all plateaued at
  // about a fifth of survivors not being rules. It costs nothing on a review where no
  // document changed — `ingestDocs` asks that before it asks the model — and where the
  // tier cannot be reached, every candidate is kept and stamped so the next ingest
  // retries. The knowledge base is the product; it is never emptied to protect a filter.
  const screenTier = tiers.find((t) => t.kind === "model" && t.model !== undefined);
  const ask = input.reviewer.askFor?.bind(input.reviewer);
  // A tier is billed the same whoever asked it, so a screen session lands in `usage`
  // exactly as a round does.
  const recordScreen = (u: ScreenUsage) => store.recordUsage(screenUsage(u, review.repoId, reviewId));
  // IS THIS STILL WANTED. Asked at the one moment a queued call has a provider slot and
  // has not yet spent it — a call can wait a long time at the gate holding no session,
  // so `review_cancel` finds nothing to abort and says so truthfully, and then the slot
  // frees and the queued call spends on a review somebody ended. One predicate, given to
  // both the screen and the tier, because the window is the gate and both queue at it.
  const stillWanted = () => !isTerminal(store.getReview(reviewId, principal)?.state ?? review.state);
  const ingested = await ingestDocs(store, review.repoId, worktree, {
    ...(screenTier === undefined || ask === undefined
      ? {}
      : { screen: screenFor(ask, screenTier, worktree, { reviewId, spent: recordScreen, stillWanted }) }),
  });
  // ASKED AGAIN, because the ingest above can now take minutes and spend money.
  //
  // The check at the top of this function was the only one, and it was written when
  // everything between it and the tier call was free. The screen made that false: a
  // client can cancel while a screen session is in flight, and this would then open the
  // model tier, spend it too, and write a ladder result over a review somebody
  // deliberately ended. The tier call is the expensive one, so this is the last moment
  // the check is worth anything.
  if (isTerminal(store.getReview(reviewId, principal)?.state ?? review.state)) {
    throw new DidNotRun(
      `review ${reviewId} was ended while its documents were being read — no tier was asked, and nothing was spent on one.`,
    );
  }
  // SAID OUT LOUD, because a degraded memory is invisible from the outside: the review
  // runs, the prompt is full of rules, and a fifth of them being fragments looks exactly
  // like a fifth of them being rules. The rows carry the stamp that heals it, so this is
  // a notice rather than an alarm — but a count nobody prints is a count nobody has.
  if (ingested.unscreened > 0 || ingested.screenedOut > 0) {
    console.error(
      `[lore:log] ${reviewId}: knowledge ${String(ingested.added)} kept, ${String(ingested.screenedOut)} screened out` +
        (ingested.unscreened > 0
          ? `, ${String(ingested.unscreened)} document(s) UNSCREENED and stamped for the next ingest to retry`
          : ""),
    );
  }
  detectAndRecord(store, review.repoId);

  const build = (diffText: string): string =>
    reviewPrompt({
      tier,
      tierIndex: tiers.filter((t) => t.kind === "model").findIndex((t) => t.id === tier.id),
      modelTierCount: tiers.filter((t) => t.kind === "model").length,
      type,
      worktree,
      branch: review.branch,
      ticket: review.ticket,
      diff: diffText,
      t0: renderT0(t0ForTier),
      // Selected against the changed files, not dumped wholesale: everything a repo
      // knows would crowd the diff out of the context window.
      knowledge: relevantTo(store, review.repoId, diff.changedFiles),
      // INDICATED, not listed (D-83). A policy decides nothing until it is cited, and
      // sixty rules already occupy the space the diff wants.
      policyCount: store.policyCount(review.repoId),
      conflicts: renderConflicts(store, review.repoId),
      settled: [...settledForPrompt, ...pending.map((p) => ({ finding: p.finding, rationale: p.reason }))],
      // WHERE THIS TIER ACTUALLY STANDS. Without it `position()` told every round it was
      // a first look, so a tier on its fifth pass re-audited a tree it had cleared four
      // times — and found the only thing such a tree offers, which is comments.
      round: review.ladder.round + 1,
      tierRounds: review.ladder.tierRounds,
    });

  // COMPACT TO THE READER, rather than to a constant.
  //
  // `computeDiff` already truncates at a fixed 600,000 characters (INV-7) and
  // announces it — but that number has no relationship to whoever is about to read
  // it. A 763 KB branch was cut to 600 KB, which is still ~150k tokens against
  // glm-5-turbo's 200,000-token window, before the system prompt, the knowledge
  // block, the ledger or a single tool call. The provider answered HTTP 200 with an
  // empty body, which `describeReply` reported as "usually a provider failure inside
  // a 200", and the client — told by TOOL_DOCS that `failed` is often transient —
  // retried. Five times over two days, ~21 minutes of T0 and ten empty calls, ending
  // with it telling its operator that lore's tier was broken. It was not.
  //
  // Skipping the tier was the first fix and it was worse: on any large branch it
  // would drop an independent opinion permanently and make `passed` unreachable,
  // trading away the premise of the whole design (D-1) to avoid an error.
  const prompt = await compactToFit(input.reviewer, tier, renderDiff(diff), build);

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
  const oversize =
    ceiling !== undefined && diff.totalChars > ceiling
      ? `${tier.id} was given ${String(Math.round(diff.totalChars / 1024))} KB, larger than anything it has ever ` +
        `finished (${String(Math.round(ceiling / 1024))} KB) — a smaller review scope is the fix, not a longer timeout`
      : undefined;
  // WRITTEN TO A LOG THE CLIENT CANNOT READ, and that was the whole defect. lore
  // computed this ratio correctly on five attempts across two days and sent it here,
  // while the client got "first reply was EMPTY (usually a provider failure)" and a doc
  // telling it `failed` is often transient. It retried, then told its operator lore's
  // tier was broken — a false diagnosis lore manufactured, escalated to a person.
  //
  // The log line stays for the operator. What is new is that when the round then FAILS,
  // this travels with the failure (below), because a symptom invites a diagnosis and a
  // client given only a symptom will make one.
  if (oversize !== undefined) console.error(`[lore:log] ${reviewId}: ${oversize}`);

  // STAMPED WHEN THE TIER'S OWN WORK BEGINS, not when `runRound` was entered.
  //
  // `roundStartedAt` reads this column to condition `check_back_after_ms` on how long the
  // round has already run — against a distribution taken from `usage.latency_ms`, which
  // measures the MODEL SESSION alone. Stamping it at entry made the two quantities
  // different things: everything before this line (T0's engines, the doc ingest, and now
  // the screen's own model call) counted as elapsed against a distribution that never
  // included any of it. The wait shrank too fast, and on a slow T0 the overdue branch
  // could tell a client the round had outrun every recorded run before the tier had been
  // asked anything — a false statement in the field a waiting client acts on.
  //
  // Still not exact: the provider gate can queue this session behind another review's,
  // and that wait is inside `reviewer.review` where nothing here can see it. Narrower
  // than it was, and `paceNote` no longer claims more than it can support.
  const tierRunId = store.openTierRun(reviewId, tier.id, review.ladder.round + 1, new Date().toISOString());

  let result;
  try {
    result = await input.reviewer.review(tier, prompt, worktree, reviewId, stillWanted);
    // Closed with what this tier FOUND, in the same words T0 uses (line 99). The
    // column answers one question — what did this tier do — and `answered` did not
    // answer it: a tier that replied with nothing and one that replied with six
    // problems both read the same.
    // Findings the schema refused go in the SAME channel as an engine that could not
    // run, and for the same reason: this tier looked at the code and said something
    // the review does not contain. `checks_skipped` is what the client repeats to its
    // user so a later `passed` is not over-read, and this belongs in exactly that
    // sentence (D-66). Silence here would be the tier's own findings quietly
    // disappearing, which is INV-1 with the loss one layer further in.
    store.closeTierRun(
      tierRunId,
      result.findings.length > 0 ? "findings" : "clean",
      result.discarded.map((d) => `${tier.id} produced a finding this review does NOT contain — ${d}`),
      roundTree,
    );
  } catch (e) {
    // The row is already open, so whatever happens next this tier leaves evidence.
    // Before this existed, a `glm-5.2` call that ran 30 minutes and timed out wrote
    // NOTHING, and the operator view could not tell it from a tier that never
    // started — INV-1 inside the bookkeeping.
    // A tier that COULD NOT LOOK is closed as `unpayable`, whether the reason was
    // money or size. The column answers "what did this tier do", and both answers are
    // "nothing, and not because the code was clean".
    store.closeTierRun(
      tierRunId,
      e instanceof TierUnavailable ? "unpayable" : "failed",
      // THE CLIENT IS TOLD, and this is the whole point of the change.
      //
      // lore already knew this diff was 3.4× the largest t1 had ever finished — it
      // computed the ratio and wrote it to `[lore:log]`, which no client can read.
      // What the client got was "first reply was EMPTY (usually a provider failure
      // inside a 200)", and `TOOL_DOCS.poll` tells it `failed` is often transient and
      // to retry. It retried five times over two days, then reported to its operator
      // that lore's tier was broken. It was not; the tier's window was too small.
      //
      // `checks_skipped` is the channel that already exists for "this review does not
      // cover what you might assume", and it is what the client repeats to its user.
      // The oversize notice reaches the CLIENT here, not only the log. `checks_skipped`
      // is what a client repeats to its user, and "this tier was given more than it has
      // ever finished" is the difference between a diagnosable failure and a guess.
      [
        ...(e instanceof TierUnavailable ? [`${tier.id} did not look at this code — ${e.message}`] : []),
        ...(oversize === undefined ? [] : [oversize]),
      ],
    );
    // A tier nobody can pay for, or whose window cannot hold the diff, is a limitation
    // rather than a failure (D-48). Record it, step over it, and let the ladder finish
    // with what remains — but only if something else can still look. If nothing can,
    // there is no review.
    if (!(e instanceof TierUnavailable)) throw e;

    const withoutTier = markUnavailable(review.ladder, tier.id);
    if (!anyTierRan(tiers, withoutTier.unavailable)) throw e;

    const skipped = step({ state: withoutTier, raised: [], tiers, needsHuman: false });
    // The tree is recorded on THIS path too. It reaches `passed_partial`,
    // which is attestable — so without it the review would pass and then be refused
    // an attestation for having no tree, which is a regression the guard introduced
    // rather than a fault it caught. T0 and the tiers that could be paid for did read
    // this tree; that is exactly what a partial attestation claims.
    const skippedWhy = stoppedBecause(skipped.decision, skipped.state);
    if (skippedWhy !== undefined) store.setFailureReason(reviewId, skippedWhy);
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
  // WHOSE DEFECT IS THIS? (D-68)
  //
  // T0 scans the whole worktree, so a pattern engine reports every match in the
  // repository — and those same matches then appear on EVERY unrelated branch,
  // forever, ahead of what the branch actually did. A client triaging by severity
  // did two `high` CWE-319 hits in test fixtures it had never touched before three
  // real `medium` spec contradictions in files it had written.
  //
  // Only pattern engines, deliberately. semgrep and ast-grep match text that was
  // already there, so "outside the diff" really does mean "not this branch". `tsc`,
  // `eslint` and the test suite are project-wide: a change here genuinely can break
  // an untouched file, and calling that pre-existing would be the more dangerous
  // mistake of the two.
  //
  // Reported, never dropped. The finding is true and someone should fix it; what was
  // wrong was attributing it to this merge.
  const PATTERN_ENGINES = new Set(["semgrep", "ast-grep"]);
  const changed = new Set(diff.changedFiles);
  const fromPatterns = new Set(
    t0.outcomes.filter((o) => PATTERN_ENGINES.has(o.engine)).flatMap((o) => o.findings.map((f) => `${f.file}:${f.claim}`)),
  );
  const inherited = (f: { file: string; claim: string }): boolean =>
    fromPatterns.has(`${f.file}:${f.claim}`) && !changed.has(f.file);

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
      // Only T0's pattern engines can be inherited; a model tier reads the diff and
      // raises what it means to raise.
      preexisting: origin === "t0" && inherited(f),
      ...(scope === undefined ? {} : { scope }),
    };
    if (store.recordFinding(reviewId, rec)) {
      newFindings.push(rec);
    } else {
      // Already on file, so the insert did nothing — but a RE-RAISE changes two
      // things the settling rule depends on, and both describe the last raise rather
      // than the first (D-56). The scope moves with the code; the origin rises to the
      // strongest tier that has confirmed the defect, and never falls.
      const prev = store.originOfFinding(reviewId, fp);
      const stronger = tierRank(tiers, origin) > tierRank(tiers, prev ?? origin) ? origin : undefined;
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
      ?? store.fileOfFinding(reviewId, fp);
    if (file === undefined) continue;

    // NOT IF THE RULE THAT BOUGHT IT HAS BEEN WITHDRAWN (D-83).
    //
    // `liveSuppressions` already closes the forward-looking hole — a retired rule stops
    // silencing the class at the next review, by a JOIN rather than a sweep. This closes
    // the backward-looking one. Without it the exact finding the appeal was made about
    // keeps being carried in as settled, for ever, because a verdict outlives its review
    // (D-51) — so `lore rule --retire` would report "every check it silenced reports
    // again" while the one place it was actually argued stayed silent.
    //
    // ASKED OF THE VERDICT, which is the only thing that knows. This first matched the
    // finding's engine rule class and path against revoked suppressions, and that is
    // broader than it sounds: an ORDINARY justification of a finding that merely shared
    // a class and a file with somebody else's appeal was blocked from carrying forward
    // too, and re-argued from scratch for a rule it never invoked. `via_rule` is NULL on
    // every ordinary justification, so those carry exactly as they always have.
    if (prior.viaRule !== undefined && !store.isLivePolicy(review.repoId, prior.viaRule)) continue;

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
      // The provenance travels with the carry, or the chain breaks at the first hop: a
      // carried row with no `via_rule` looks like an ordinary justification to the NEXT
      // review, and retiring the rule would stop reaching it.
      ...(prior.viaRule === undefined ? {} : { viaRule: prior.viaRule }),
    });
    carried.push(fp);
  }

  // 6. Rule on the pending justifications. Silence is assent.
  const accepted: string[] = [...carried];
  /** Appeals accepted that bought no class suppression — the client is told (D-83). */
  const appealBoughtNothing: string[] = [];
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
        // WHAT THIS ACCEPTANCE RESTS ON. NULL for an ordinary justification, which is
        // the load-bearing distinction: an ordinary reason was argued on its own words
        // and carries forward for ever (D-51), while an appeal borrowed a rule's
        // authority and must lose it when the rule is withdrawn. Written only when the
        // citation RESOLVED — an appeal to a rule that does not exist is judged on its
        // words like any other reason.
        ...(p.citedRule === undefined ? {} : { viaRule: p.citedRule }),
      });

      // AN ACCEPTED APPEAL SETTLES THE CLASS FOR THAT PATH, not just this fingerprint
      // (D-83). The verdict above is keyed by fingerprint — the exact claim about the
      // exact code — and for an appeal that is the wrong unit: the author's claim is
      // "this project decided not to enforce this rule here", so the next edit to the
      // file produces a fresh fingerprint and re-raises the identical argument. Answering
      // it forever is the loop D-57 exists to end.
      //
      // Three conditions, and none is incidental:
      //
      //   * a rule was CITED and resolved — otherwise this is an ordinary reason, and
      //     ordinary reasons do not switch checks off;
      //   * the finding came from T0 — a model tier's finding has no rule class, and
      //     re-raising it is judgement rather than a pattern re-firing. Suppressing a
      //     class of thought is not a thing this should be able to do;
      //   * the claim yields a class. A script failure ("`npm test` fails on this
      //     branch") has none, so nothing appeals its way past a red suite.
      //
      // The tier that accepted it is a model tier by construction: this loop runs in a
      // model round, and `modelRaised` is what rejects. A deterministic engine can
      // neither read the appeal nor rule on it.
      const cls = p.citedRule === undefined || p.finding.origin !== "t0"
        ? undefined
        : engineRuleClass(p.finding.claim);
      // AN APPEAL THAT BUYS NOTHING SAYS SO, TO THE AUTHOR. Accepted, the fingerprint
      // settles either way — but without a class there is no suppression, so nothing was
      // decided beyond this one finding and the author is left believing otherwise.
      //
      // `checks_skipped`, not the log. The first version wrote it to stderr, which is the
      // channel defect this same branch fixed for the oversize notice — "written to a log
      // no client can read" was the whole of that bug, reintroduced two files away. This
      // is precisely a "the review does not cover what you would assume" fact, which is
      // what that channel is for.
      if (p.citedRule !== undefined && cls === undefined) {
        appealBoughtNothing.push(
          p.finding.origin === "t0"
            ? `the appeal to rule ${p.citedRule} at ${p.finding.file} settled THIS finding only — its claim ` +
              "names no engine rule, so no class was suppressed and the same check will raise it again."
            : `the appeal to rule ${p.citedRule} at ${p.finding.file} settled THIS finding only — a model ` +
              "raised it, and a model's judgement is never suppressed by class. It may or may not be raised " +
              "again; nothing was decided beyond this one finding.",
        );
      }
      if (cls !== undefined && p.citedRule !== undefined) {
        store.recordSuppression({
          repoId: review.repoId,
          ruleClass: cls,
          path: p.finding.file,
          policyShort: p.citedRule,
          reviewId,
          tier: tier.id,
        });
      }
      // AN ACCEPTED JUSTIFICATION IS A VERDICT, NOT A RULE, and it used to be written
      // here as both.
      //
      // A `lore-ok` reason is addressed to one reviewer about one finding — "correct,
      // this was NOT in the ticket, which asked for four other fixes". Stored as a
      // knowledge row it loses the finding, and what remains is shown to the next model
      // under *"WHAT THIS CODEBASE ALREADY KNOWS ABOUT ITSELF — treat these as this
      // team's decisions"*: a sentence with no subject, presented as binding.
      //
      // Nothing is lost by not writing it, which is the part worth checking rather than
      // assuming. The reason is already in every prompt, WITH its finding, through
      // `settledBlock` — `file:line — claim → justified: reason`. And it already
      // outlives its review (D-51): carrying is done from the VERDICT table, joined
      // across the repo's reviews by fingerprint, never from knowledge.
      //
      // What the loop genuinely learns is the PATTERN, and `promoteRecurring` writes
      // that as an authored rule once a claim has recurred three times — "this codebase
      // repeatedly produces CWE-459 findings (7 so far), check for it explicitly" —
      // which is a statement about the codebase rather than a quotation from an
      // argument about one line.
    }
  }

  // Said to the CLIENT, once the loop knows. See `appealBoughtNothing`.
  store.noteChecksSkipped(tierRunId, appealBoughtNothing);

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
  // `fixed` belongs here as much as `accepted` does. The store has always
  // counted both as settled — `settledFingerprints` and `openFindings` agree — and the
  // ladder was the only view that did not. That disagreement livelocks: a re-raised
  // fixed fingerprint looks fresh to `step`, which re-runs the tier, while
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
  // A real review showed `t1·r4 ✘ stopped 485s` for a
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
  // which carries both the line and its test. The test is the answer to the finding,
  // raised against that very commit — a fix, a finding, then the test, which is the
  // loop working rather than a gap in it.
  // Written BEFORE the state, so a client woken by the state change can already read
  // the reason. The wake fires on the `updateReview` below.
  // Written BEFORE the state, so a client woken by the state change can already read
  // the reason. The wake fires on the `updateReview` below.
  const why = stoppedBecause(stepped.decision, stepped.state);
  if (why !== undefined) store.setFailureReason(reviewId, why);
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
/**
 * Has the code this finding NAMED actually changed?
 *
 * D-56's half of settling: silence from a tier is only evidence of a fix if the thing
 * it stopped mentioning has moved, because a tier that simply stops mentioning untouched
 * code has changed its mind rather than been satisfied.
 *
 * Exported because `review_submit` answers the same question the instant a patch lands,
 * and a client that learns a round later has waited ten to twenty-five minutes to be
 * told something that was knowable immediately. ONE definition, not two: this is exactly
 * the shape where a preview and the rule it previews drift apart and the preview starts
 * lying, which is worse than not having one.
 *
 * ABSENT SCOPE AND AN UNREADABLE FILE BOTH MEAN "CANNOT TELL", and cannot tell never
 * settles. The condition here used to fall through to `fixed` when the read failed, so a
 * permissions error or a transient I/O fault read as evidence the code had moved — the
 * exact opposite of what it means.
 */
/**
 * Is this finding already answered, in the tree, by a `lore-ok` naming it?
 *
 * The same question `collectJustifications` asks, asked cheaply and without a store
 * write, so `review_submit` can preview what the next round will do.
 *
 * It exists because the preview nagged a client that had done exactly what the preview
 * told it to. `will_not_settle` listed everything whose code had not moved and advised
 * *"say so AT THE NAMED LINE with a lore-ok and submit again"* — including findings whose
 * named line already carried one, submitted in that very diff. A field that fires on the
 * correct answer is a field clients learn to skip, and this one is the only warning that
 * saves them a deep-tier round.
 *
 * The LEDGER is read too (D-57): a finding in a file with no comment syntax has nowhere
 * else to put its reason, and missing that would reintroduce the nag for exactly the
 * files that cannot avoid it.
 */
export async function alreadyAnswered(
  worktree: string,
  reviewId: string,
  resolve: (reviewId: string, short: string) => string | undefined,
  f: RecordedFinding,
): Promise<boolean> {
  for (const file of new Set([f.file, LEDGER])) {
    const source = await readFile(join(worktree, file), "utf8").catch(() => undefined);
    if (source === undefined) continue;
    for (const mark of parseLoreOk(source)) {
      if (resolve(reviewId, mark.short) === f.fingerprint) return true;
    }
  }
  return false;
}

export async function codeMoved(worktree: string, f: RecordedFinding): Promise<boolean> {
  if (f.scope === undefined) return false;
  const source = await readFile(join(worktree, f.file), "utf8").catch(() => undefined);
  if (source === undefined) return false;
  return !hunkStillPresent(source, f.scope.hunk);
}

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
    // T0 re-scans the whole worktree every round, so its silence is authoritative
    // for its own findings and means nothing for anyone else's.
    const qualified = f.origin === "t0" ? tier.id === "t0" || here >= 0 : here >= 0 && here >= rank(f.origin);
    if (!qualified) continue;

    if (!(await codeMoved(worktree, f))) continue;

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

    const file = store.fileOfFinding(reviewId, fingerprint);
    if (file === undefined) continue;

    const source = await readFile(join(worktree, file), "utf8").catch(() => undefined);
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

/**
 * A justification waiting to be ruled on this round.
 *
 * `citedRule` is what makes it an APPEAL rather than an argument (D-83): the author is
 * not saying the finding is wrong, but that this project decided not to enforce it —
 * and if a tier agrees, that decision outlives this one fingerprint.
 */
interface Pending {
  readonly finding: RecordedFinding;
  readonly reason: string;
  readonly scope: ReturnType<typeof makeScope> | undefined;
  readonly citedRule?: string;
}

async function collectJustifications(
  store: Store,
  reviewId: string,
  repoId: string,
  worktree: string,
  files: readonly string[],
  /** The caller's open findings — the same read `files` was derived from. */
  open: readonly RecordedFinding[],
): Promise<readonly Pending[]> {
  if (open.length === 0) return [];
  const byFingerprint = new Map(open.map((f) => [f.fingerprint, f]));

  const out: Pending[] = [];
  // lore-ok[5dee6c43]: upheld, and written at the end of this function rather than here,
  // which is where the count is complete. The claim was exactly right — this was
  // incremented per marker and read by nothing, so the noise it replaced became total
  // silence, and a comment promised a summary that did not exist.
  // Counted, not printed one by one. See `shortKnownToRepo`.
  let carriedOver = 0;

  // The repo-level ledger, always read (D-57).
  //
  // A `lore-ok` is a comment, and some files have no comment syntax at all: JSON,
  // lockfiles, generated output, anything binary. A finding raised against one of
  // those had NOWHERE to put its reason, so it could only ever be fixed — and if it
  // should not be fixed, it was re-raised for ever with no way to answer. Hit on
  // `deploy/tiers.zai-openai.json`, where the tier schema is `.strict()`
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
        // A MARKER FROM AN EARLIER REVIEW IS NORMAL, AND WAS SHOUTING. A `lore-ok` is
        // permanent in the source: the review that earned it ends, the marker stays,
        // and every later round found it matching nothing in ITS review and said so —
        // 18 of 29 log lines in three hours, in the log the oversize warning shares.
        // Counted here and summarised once below.
        //
        // A marker matching nothing ANYWHERE still gets its own line. That is the case
        // the warning was written for: a typo, or an agent believing it answered a
        // finding it never touched, and silence there would hide it.
        if (store.shortKnownToRepo(repoId, mark.short)) {
          carriedOver++;
        } else {
          console.error(
            `[lore:log] lore-ok[${mark.short}] at ${file}:${mark.line} matches NO finding this repository has ` +
              `ever raised — a typo, or an answer to something that was never asked. Ignored.`,
          );
        }
        continue;
      }
      const finding = byFingerprint.get(fp);
      if (finding === undefined) continue; // already settled in an earlier round

      // The scope is taken from the code the reason DEFENDS, never from wherever the
      // reason happens to be written.
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
      // AN APPEAL CARRIES THE RULE'S TEXT, because the tier must rule on what was
      // actually written rather than on an id it cannot look up — reviewers have no
      // lore MCP and no way to fetch anything (D-83). A cited rule that does not
      // resolve is NOT silently dropped: the reason says so, so the tier judges a
      // justification whose central claim it can see is unsupported, rather than one
      // that merely reads oddly.
      const cited = mark.rule === undefined ? undefined : store.policyByShort(repoId, mark.rule);
      const reason =
        mark.rule === undefined
          ? mark.reason
          : cited === undefined
            ? `[APPEALS TO RULE ${mark.rule}, WHICH DOES NOT RESOLVE — no such development rule for this ` +
              `repository, or the id is ambiguous. Judge this as an unsupported claim.] ${mark.reason}`
            : `[APPEAL TO THIS PROJECT'S DEVELOPMENT RULE ${mark.rule}: "${cited.statement}"` +
              `${cited.why === undefined ? "" : ` — ${cited.why}`}. The author says this finding enforces ` +
              `something the project decided not to enforce. Rule on THAT: does the rule cover this code? ` +
              `Accept by not raising it again; reject by raising it, and say why the rule does not apply.] ` +
              `${mark.reason}`;

      out.push({
        finding,
        reason,
        scope: await scopeOf(worktree, finding.file, finding.line),
        // Carried only when the citation RESOLVED. An appeal to a rule that does not
        // exist is judged on its words like any other reason; it must not be able to
        // buy a suppression, or an unresolvable id would switch a check off.
        ...(cited === undefined || mark.rule === undefined ? {} : { citedRule: mark.rule }),
      });
    }
  }

  // THE SUMMARY THE COUNTER WAS FOR, and it was never written.
  //
  // `carriedOver` was incremented per marker and read by nothing, so the noise this
  // replaced — 18 of 29 log lines in three hours — became total silence instead of one
  // line. Both are wrong in the same direction: a marker from an earlier review is
  // NORMAL, and an operator reading the log should be able to tell "37 old markers, as
  // expected" from "no markers at all", which is what a typo in the ledger looks like.
  //
  // One line, at the end, naming the count. A marker matching nothing ANYWHERE still gets
  // its own line above — that is the case worth shouting about.
  if (carriedOver > 0) {
    console.error(
      `[lore:log] ${String(carriedOver)} lore-ok marker(s) in this tree belong to earlier reviews of this ` +
        "repository and matched nothing open here. That is normal — a marker is permanent in the source — " +
        "and they were ignored.",
    );
  }
  return out;
}

/**
 * What to tell the client when the LADDER stopped, rather than a round throwing.
 *
 * A bound was reached, and `state: failed` alone is indistinguishable from a crash —
 * the shape INV-1 refuses. The cause is known exactly at this point and used to be
 * discarded here, so `review_poll` answered "no reason was recorded, which is itself
 * a defect" and it was right. Raised against a review of this repository that had
 * just hit the per-tier bound after nine rounds.
 *
 * The advice matters as much as the cause: hitting the per-tier bound almost always
 * means each fix produced fresh findings ABOUT THE FIX, which for prose is nearly
 * unbounded — measured twice on this repository. Answering shorter is what ends it.
 */
function stoppedBecause(d: Decision, state: LadderState): string | undefined {
  if (d.kind !== "stopped") return undefined;
  const rounds = Object.entries(state.tierRounds)
    .map(([tier, n]) => `${tier}×${String(n)}`)
    .join(", ");
  return d.bound === "global"
    ? `The ladder ran its whole budget (${String(state.round)} rounds: ${rounds}) without settling every ` +
        "finding, so it stopped. This is NOT a pass and NOT 'nothing found' — the code past that point was " +
        "never reviewed. Answer the remaining findings and start a fresh review of the final tree."
    : `One tier reached its per-review round bound (${rounds} across ${String(state.round)} rounds), so the ` +
        "ladder stopped. This is NOT a pass and NOT 'nothing found' — the code past that point was never " +
        "reviewed. It means each answer produced fresh findings about the answer, which is nearly unbounded " +
        "for documentation and wording: answer MINIMALLY — change the code, or one short lore-ok line — and " +
        "start a fresh review of the final tree.";
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
