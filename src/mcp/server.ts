/**
 * The MCP surface.
 *
 * A server instance is built **per authenticated principal**, so the principal is
 * baked in rather than passed around and remembered. Possession of a `review_id`
 * is never authentication (D-23), and the cheapest way to guarantee that is to
 * make it impossible to ask for a review without saying who you are.
 *
 * SPEC: spec/mcp-api.md
 */

import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { forClient } from "./plain.ts";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import { mayAdmit, MAX_OPEN_REFACTOR_RUNS } from "../core/admission.ts";
import { elapsedWords } from "../core/elapsed.ts";
import { absent } from "../core/optional.ts";
import { worstSeverity } from "../core/finding.ts";
import { initialState, ladderFingerprint, loadTiers, type LadderState } from "../core/ladder.ts";
import { isAttestable, isClean, isTerminal, needsClient, type ReviewState } from "../core/review-state.ts";
import { SHORT_LENGTH } from "../core/fingerprint.ts";
import { AmbiguousFingerprint } from "../core/errors.ts";
import { isSuppressionNotice } from "../core/checks-skipped.ts";
import { DEFAULT_TYPE, reviewType, reviewTypeIds } from "../core/review-type.ts";
import { STALE_GRACE_DAYS, STALE_HOURS, quietSince } from "../ops/retention.ts";
import { applyPatch, resolveTree, restoreTree, revParse, treeDelta, treeHash } from "../git/repo.ts";
import { filesInDiff, filesTouchedByDiff } from "../git/diff.ts";
import { requestMirrorRefresh, type RefreshOutcome } from "../git/mirror-request.ts";
import { dataDir } from "../core/paths.ts";
import { decide } from "../knowledge/decide.ts";
import { enrich, renderEnrichment } from "../knowledge/enrich.ts";
import { paceFor, paceNote } from "../ops/pace.ts";
import { alreadyAnswered, codeMoved } from "../reviewer/review.ts";
import { buildVex, findingsNeedingTriage, renderVex, vexGap } from "../security/vex.ts";
import { NO_LIMIT, isSettled, type RecordedFinding, type Store } from "../store/store.ts";
import type { Principal } from "./auth.ts";
import { REVIEW_PROMPT_TEXT, RESOURCE_DOCS, SERVER_INSTRUCTIONS, TOOL_DOCS } from "./docs.ts";
import { reviewUri } from "./events.ts";

export interface ServerDeps {
  readonly store: Store;
  /** Worktree for a review, once one exists. */
  readonly worktreeFor: (reviewId: string) => Promise<string>;
  /** Queue the review for the background workers. */
  readonly enqueue: (reviewId: string, stage: "fast" | "deep") => void;
  readonly attest: (reviewId: string) => Promise<string>;
  /**
   * The reviewer, so `review_cancel` can stop a model call in flight.
   *
   * Optional: the CLI and the tests build a server without one, and a cancel that
   * cannot reach a session still marks the review and hands over its findings — it
   * just says plainly that nothing was aborted, rather than implying the spend
   * stopped.
   */
  readonly reviewer?: { cancel?(reviewId: string): Promise<boolean> };
  /**
   * Advance an open review's pin to the branch as origin now has it (D-108): sync,
   * remove the worktree, recut at the same review id. Optional because the CLI and the
   * tests build servers that cannot cut worktrees; `pull_fresh` says so plainly then.
   */
  readonly repin?: (
    reviewId: string,
    /** Origin's tree as this review last pinned it — repin leaves the worktree alone if origin still points there. */
    expectTree?: string,
    /** The review's `into`, so the base the change-set is measured from is re-resolved at this pin (D-113). */
    intoRef?: string,
  ) => Promise<{ worktree: string; treeHash: string; synced: boolean; baseCommit?: string | undefined }>;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/**
 * ONE `review_submit` AT A TIME, PER REVIEW (found by lore's own review, fingerprint
 * 015cd8d0). Deciding a commit-form submit's base (`store.heldDiffs`) and recording its
 * own hold (`store.holdDiff`) are separated by real async work — `revParse`, sometimes a
 * mirror refresh, `treeDelta` — so two OVERLAPPING submits for the SAME review could both
 * read an empty held chain and both build from the same stale `review.treeHash`: the
 * exact silently-dropped-chain shape this file's `at` fix exists to prevent, reopened
 * through a wider window than the sequential-submit one it closed. Same promise-chained
 * mutex shape `withHoldLock` (reviewer/review.ts) already uses for the identical class of
 * problem — a `Map` here rather than a per-call local, because this lock has to outlive
 * one `review_submit` call and be found again by the next one for the same review.
 */
const submitLocks = new Map<string, Promise<unknown>>();
function withSubmitLock<T>(reviewId: string, fn: () => Promise<T>): Promise<T> {
  const prior = submitLocks.get(reviewId) ?? Promise.resolve();
  const next = prior.then(fn);
  // ALWAYS RESOLVED, whatever `fn` did — the NEXT caller's own `prior.then(fn)` needs a
  // settled promise to chain onto; storing a rejected one here would skip every later
  // submit's `fn` entirely (`.then(onFulfilled)` with no rejection handler propagates a
  // rejection through untouched), wedging this review's submits on the first failure.
  // `next` itself is returned unwrapped below, so THIS call's own caller still sees
  // whatever `fn` actually did.
  submitLocks.set(reviewId, next.catch(() => undefined));
  return next;
}

/**
 * What to tell a client that has nothing to do but wait, or `{}` when it does.
 *
 * Only the waiting states get a number. In `findings_ready` the next move belongs to
 * the client, and handing it an interval there would read as permission to sleep on
 * findings that are already its problem — the abandonment D-70 measured.
 *
 * The tier is the one the ladder's cursor points at, which is the one now running or
 * about to. It changes as the ladder climbs, and the note says so: a client that
 * cached the first number would be using t1's median to wait for t2.
 */
function pacing(
  store: Store,
  review: { id: string; repoId: string; state: ReviewState; type: string; ladder: LadderState },
): object {
  if (!["queued", "running", "fast_clean"].includes(review.state)) return {};
  const tier = reviewType(review.type).tiers[review.ladder.cursor];
  if (tier === undefined) return {};
  // HOW LONG THIS ROUND HAS ALREADY RUN. Without it every poll gets the same number,
  // so a client that comes back at the median and finds the round still going is sent
  // away for another full median — twelve minutes, on t2, with the answer already
  // written. Absent when no round is in flight (`queued`), which is elapsed zero.
  // Asked about THE TIER BEING PACED, not about whatever row happens to be open. During
  // T0 the only open run is T0's, and the cursor already points at the model tier — so
  // this used to condition a T0-window elapsed on the model tier's distribution.
  const startedAt = store.roundStartedAt(review.id, tier.id);
  const elapsed = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
  const pace = paceFor(store, tier.id, review.repoId, elapsed);
  return {
    ...(pace === undefined ? {} : { check_back_after_ms: pace.ms }),
    check_back_note: paceNote(pace),
  };
}

/**
 * CSPRNG, never sequential.
 *
 * The moment ids are guessable, every log line containing one becomes a credential
 * (D-23).
 */
/**
 * What to do next, per state — the most-read string this service produces.
 *
 * It used to be binary: "Every tier agrees" or "NOT clean. Only `passed` means
 * clean." Both true, neither an instruction, and every production failure of this
 * surface was a client doing something reasonable that nothing told it not to:
 *
 *   * polled once, saw `running`, concluded the branch was clean;
 *   * got `failed`, retried five times because the docs said retries often succeed,
 *     then told its user lore was broken;
 *   * reached `findings_ready` and stopped — the single largest cause of abandoned
 *     reviews, and not a fault in any client: nothing in the reply said the review
 *     dies if you walk away.
 *
 * So each state names the next call. A client that reads only this field should still
 * do the right thing, because that is the client we actually have.
 */
function nextStep(state: ReviewState, freshFindings: number, reviewId: string): string {
  // STREAMED FINDINGS ARRIVE WHILE THE TIER IS STILL READING (D-107), so "running" with
  // findings in hand is not "nothing yet" — it is "start fixing now". A submit made now
  // is HELD and delivered at the reviewer's next emission; nothing needs resubmitting.
  if ((state === "running" || state === "queued") && freshFindings > 0) {
    return (
      "The reviewer is STILL READING and has already raised the findings below — start fixing now. " +
      "Submit whenever ready: your diff is held and handed to the same reviewer at its next emission, " +
      "and its ruling arrives as ordinary findings. It may still report things your fix already answers; " +
      "that is expected — do not double-fix, the next emission settles them."
    );
  }
  switch (state) {
    case "queued":
    case "running":
      // NOT "poll again in 10s". That instruction, against a measured t1 median of
      // 323s and t2 of 820s, buys seven to fifteen calls that cannot return anything
      // — and for an agent client each is a turn. `check_back_after_ms` in the same
      // response is the measured answer; this string points at it rather than
      // repeating a number that would then have two sources.
      return "Still working — this is NOT a result. Read `check_back_note` THIS TIME and never reuse the last number: below the two-minute cap the interval shrinks as the round ages, and AT the cap it stays put for several calls — the note says which you have been handed. Then leave, and make ONE call when it says. Do not merge, and do not report anything about the branch yet.";
    case "findings_ready":
    case "awaiting_diff":
      return "ACT NOW: answer every finding below — fix it, or write the `justify_with` line at the site — then call review_submit with your diff and tree hash. THE REVIEW DIMS IF YOU STOP HERE: after 48h quiet it turns findings_stale — still answerable, for one more week — and then it is abandoned, concluding nothing, and this branch stays unreviewed.";
    case "findings_stale":
      // The same instruction as findings_ready ON PURPOSE (D-106): nothing about the
      // review has changed but its clock. A different instruction would teach a client
      // that gray means "different protocol", when it means "same protocol, less time".
      return "STILL ANSWERABLE, BUT DIMMED: this review sat unanswered for 48h and has at most a week left. Everything works as in findings_ready — answer the findings and call review_submit with your diff and tree hash — or call review_cancel if somebody decided not to. Doing nothing abandons it, and an abandoned review concludes NOTHING about this branch.";
    case "fast_clean":
      return "The CHEAP tiers found nothing; the deep tiers are still running. This is NOT a pass and you must not merge on it. Keep polling.";
    case "needs_human":
      return "STOP and ask a person. `open_questions` is the question — take both statements to your user verbatim. Do not answer it yourself and do not close it with lore-ok. When they decide, call knowledge_resolve; that resumes this review.";
    case "passed":
      return "Every tier agrees. Call review_attest for the signed line, then merge — and carry on. This closes the review, not your task.";
    case "passed_partial":
      return "Every tier that COULD run agrees — weaker evidence than `passed`, honestly labelled. Tell your user which tiers were skipped and why (the attestation names them) before deciding to merge. Same after that: this closes the review, not your task.";
    case "failed":
      return "The review DID NOT RUN — this is not 'nothing found' and you must not merge. Read `failed_because` and repeat it to your user verbatim. Retry AT MOST ONCE; if it fails the same way, stop and report it rather than diagnosing lore yourself.";
    case "expired":
      return "Nobody answered this review in time, so it concluded NOTHING about the code — not that it was clean. Start a fresh review if this branch still matters.";
    case "cancelled":
      // lore-ok[5e6c18de]: was "...are yours and are LISTED HERE" — found by lore's
      // own review. `nextStep` is called only from `review_poll` (never from
      // `review_cancel`'s own reply, which genuinely does list them), and a
      // cancelled review's findings were already marked delivered at the cancel
      // that produced them — so a POLL reaching this exact sentence has
      // `new_findings: []` beside it, every time, contradicting "here" in the same
      // response.
      //
      // 1ee794a4/e54c900e: THAT fix wrote a literal, never-substituted
      // "{review_id}" placeholder in its place — real braces in the string, not a
      // template interpolation — because `nextStep` had no review id to put there.
      // A client reading this instruction and building the URI verbatim would
      // issue `resources/read` on a template match for the LITERAL string
      // "{review_id}", which `mine()` refuses as not found, at the exact moment
      // the client is told its findings are one substitution away. Fixed the way
      // `review_cancel`'s own messages already do it (`"lore://review/" +
      // review_id`, a few hundred lines down): `nextStep` now takes the real id.
      return "You stopped this review. The findings it had already produced are yours, at lore://review/" +
        reviewId + " (a poll here returns nothing new — they were handed to you when you cancelled). It " +
        "concluded nothing beyond them, and the tiers that had not run never looked. Start a fresh review " +
        "when you want the rest.";
  }
}

/**
 * The wire revision this request was sent for, or `undefined` on a 2025-era connection.
 *
 * `ctx.mcpReq.envelope` is the per-request `_meta` envelope (2026-07-28), keyed by the
 * reserved names verbatim. The SDK types it as `Partial<{}>` — an empty type, so there is
 * nothing to index — hence the one cast, which is confined to this function rather than
 * spread across the call sites that want the answer.
 */
function wireRevision(ctx: unknown): string | undefined {
  const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq?.envelope;
  const version = envelope?.["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" ? version : undefined;
}

/**
 * Tell a client about the stream ONLY IF ITS CONNECTION CAN HOLD ONE (D-103, revised).
 *
 * D-103 removed the subscribe frame from every reply because no client could act on it:
 * the most prominent instruction in the response was one that would fail, and the polling
 * interval it actually needed read as a consolation prize. That was right, and it threw
 * away Vany's rule with it — *"the model chooses what its harness supports"* — by deciding
 * for every client at once that the answer was no.
 *
 * The connection already answers the question. `subscriptions/listen` exists only in the
 * 2026-07-28 method registry, so a client that negotiated an earlier era CANNOT call it —
 * not "probably will not", cannot: the method is not in its era. A client that negotiated
 * 2026-07-28 can, and lore serves it (D-80, proven end to end in `subscribe.test.ts`).
 *
 * So the hint is emitted on exactly the connections where it is followable, and on every
 * other one the reply says what it has said since D-103: poll, at this interval. Nobody
 * is handed an instruction they cannot carry out, and nobody who could stream is kept in
 * the dark because somebody else could not.
 */
export function subscribeTo(reviewId: string, ctx?: unknown): object {
  if (wireRevision(ctx) !== "2026-07-28") return {};
  return {
    subscribe: {
      method: "subscriptions/listen",
      params: { resourceSubscriptions: [reviewUri(reviewId)] },
      note:
        "Your connection can hold a notification stream, so you do not have to poll on a timer: open " +
        "subscriptions/listen with the filter above and lore wakes you on every state change of this " +
        "review. Poll once when woken to collect what is new — the stream says THAT something happened, " +
        "review_poll says what. Polling on the interval still works and is never wrong; this only saves " +
        "the calls that would have found nothing.",
    },
  };
}

function newReviewId(): string {
  return `rev_${randomBytes(18).toString("base64url")}`;
}

function newRefactorRunId(): string {
  return `refactor_${randomBytes(18).toString("base64url")}`;
}

// lore-ok[b53881c1]: same finding as e393b46f below (an absolute root path — "/"
// and its variants — normalizing to "." here before the escape check could see it
// was absolute), raised twice with different wording. See that comment for the fix
// and how it was verified; not repeated here to avoid two accounts drifting apart.

/**
 * A folder review's `path`, in one canonical spelling (D-130, found by lore's own
 * review: `"src"`, `"src/"` and `"./src"` name the same scope to git, but the dedup
 * key and `pull_fresh` lookup below compare it byte-exact). Without this, two
 * spellings of one path pass the one-review-per-(branch, path) check as though they
 * were different work — a second open review of the same directory, burning a
 * second ladder's quota, exactly the duplication that check exists to prevent.
 */
function normalizeReviewPath(path: string): string {
  const n = posix.normalize(path).replace(/\/+$/, "");
  return n === "" ? "." : n;
}

// lore-ok[e393b46f]: real for one round — `"/"` (and `"//"`, `"/."`) normalizes to
// `"."` here, exactly as described — but fixed already, one function down:
// `pathEscapesWorktree` checks `posix.isAbsolute` on the RAW input this function
// receives, not the normalized output it returns, specifically because this
// function can erase the leading `/` the check needs. Verified directly: node
// -e confirms `pathEscapesWorktree("/", normalizeReviewPath("/"))` is `true`, and
// http.test.ts's escape suite includes `"/"` itself.

/**
 * `path` names somewhere outside the worktree — `"../shared"`, or an absolute one
 * like `"/home/agent/repo/src"` (natural for an agent that thinks in absolute
 * paths, which the review loop itself trains it to).
 *
 * Found by lore's own review of D-130, matching the precedent `into` already set
 * (`computeDiff`'s own comments: an unresolvable name reaching git "reached a client
 * as a failed review with no reason at all... raw git vocabulary about a directory
 * nobody can see"). Unrefused, this same failure was one call away: `wholeTreeDiff`
 * passes `path` straight into `git diff ... -- <path>`, which exits non-zero for a
 * pathspec outside the repository — a `failed` review naming a directory on the
 * client's machine and a lore-internal worktree path, instead of a door refusal.
 *
 * TAKES BOTH THE RAW INPUT AND ITS NORMALIZED FORM — found by lore's own review,
 * a second time: `"/"` normalizes (via `normalizeReviewPath`) to `"."`, since
 * `posix.normalize("/")` is `"/"` and the trailing-slash strip then empties it,
 * which this function's first version read from the ALREADY-NORMALIZED value and so
 * saw a harmless relative `"."` — silently reviewing the whole repository instead of
 * refusing the absolute path that was actually sent. Absoluteness is a property of
 * what the client wrote, and normalizing away the leading `/` before asking must not
 * also normalize away the refusal. `..`-escaping still needs the normalized form —
 * `"foo/../.."` is not obviously escaping without it — so each check reads the input
 * built to answer it, not whichever was more convenient.
 */
function pathEscapesWorktree(raw: string, normalized: string): boolean {
  return posix.isAbsolute(raw) || normalized === ".." || normalized.startsWith("../");
}

export function buildServer(who: Principal, deps: ServerDeps): McpServer {
  // `resources.subscribe` is DECLARED, not implied. `registerResource` advertises
  // `resources.listChanged` on its own and stops there, and the listen router honours
  // a client's `resourceSubscriptions` filter only against a declared `subscribe` bit
  // — so without this line the server would accept `subscriptions/listen`, acknowledge
  // it with an empty filter, and then never deliver a single event. A client that
  // waited on that stream would wait forever while being told everything was fine,
  // which is this project's defining failure with a new coat of paint (D-80).
  const server = new McpServer(
    { name: "lore", version: "0.1.0" },
    {
      capabilities: { resources: { subscribe: true } },
      // THE ONLY TEXT ADDRESSED TO THE SESSION RATHER THAN TO A CALL.
      //
      // Tool descriptions are in context from the start — that is not the gap. What
      // they are not is a STANDING instruction: each is consulted while choosing a tool,
      // so a rule inside one arrives as a reason to call that tool, not as something to
      // check before deciding what to do at all. Measured 2026-09-02: the sessions that
      // abandoned reviews had `inbox`'s "THE FIRST CALL OF EVERY SESSION" and `start`'s
      // "FINISH WHAT YOU START" in context throughout, and stopped mid-loop anyway —
      // most after three to six answered rounds, three of them inside three minutes of
      // one another. This string is short, first, and addressed to the session rather
      // than to a call, which is the whole difference it is betting on.
      instructions: SERVER_INSTRUCTIONS,
      // ONE MINUTE ON THE TOOL LIST, AND NOTHING ELSE CACHED AT ALL.
      //
      // 2026-07-28 added `CacheableResult` (`ttlMs`, `cacheScope`) to the list and read
      // methods. The SDK's own defaults are already the safe ones — `ttlMs: 0`,
      // `cacheScope: 'private'` — so nothing here is about correctness or disclosure;
      // it is about a client re-listing a static tool set on every session.
      //
      // WHY THE NUMBER IS SMALL, and why it is the only one set. In this service the tool
      // descriptions ARE the interface: an agent has no README and no support channel, so
      // `TOOL_DOCS` is the entire contract, and it changes in the same deploy as the
      // behaviour it describes (CLAUDE.md). A long TTL therefore buys round-trips at the
      // price of clients acting confidently on a contract that has been replaced — this
      // project's defining failure, bought back with a config value. Sixty seconds saves
      // the repeat listing within one session and cannot outlive a deploy by long.
      //
      // `resources/read` is deliberately left at 0: `lore://review/{id}` moves on every
      // state change and every finding, and it is the one surface a client polls to learn
      // that something happened. Caching it would be caching the answer to "has anything
      // changed", which is the question.
      cacheHints: { "tools/list": { ttlMs: 60_000, cacheScope: "private" } },
    },
  );
  const { store } = deps;

  /**
   * Fetch a review or refuse. A valid id from another principal — OR ANOTHER
   * REPOSITORY — fails exactly like a forged one.
   *
   * The repo check is the half that was missing. Tokens are minted per repository
   * (D-23), and this asked only whether the principal matched — so one person holding
   * tokens for two repos could read either through either, and the same person is the
   * normal case: a workgroup provisions each repo to the same human. A client
   * reported seeing lore's own branches through a rigid-monorepo token.
   *
   * Failing as NOT FOUND rather than as forbidden, deliberately: "this exists but is
   * not yours" tells an unauthorized caller that the id is real, and ids are the one
   * thing a caller might guess.
   */
  const mine = (reviewId: string) => {
    const r = store.getReview(reviewId, who.principal);
    if (r === undefined || r.repoId !== who.repoId) throw new Error(`review ${reviewId} not found`);
    // AND THE TOKEN THAT STARTED IT (D-78). `review_poll` returns deltas and MARKS THEM
    // DELIVERED, so a colleague polling a review they did not start silently takes its
    // findings and the owner is shown nothing at all. Repository scope was right while a
    // repository meant one holder; `rigid-monorepo` has three.
    //
    // Not a threat model — these are colleagues, and `principal` already says who a
    // review belongs to. It is an ACCIDENT model: the obvious way to answer "how is that
    // review doing" is to poll it, and doing so costs somebody else their findings with
    // nothing anywhere to say so. I nearly did it myself the day this was written.
    //
    // A REVOKED BINDING FALLS BACK TO REPOSITORY SCOPE, which is the rotation question
    // this carried. Revoking a token would otherwise strand every review it started —
    // right for a compromised credential and wrong for the routine replacement that is
    // the common case, and stranding a colleague's in-flight work is a worse failure
    // than the accident this prevents, against people who are already trusted with the
    // repository. Reversible if the threat model ever changes; say so if it should.
    if (boundElsewhere(r)) throw new Error(`review ${reviewId} not found`);
    return r;
  };

  /**
   * Started by a DIFFERENT live token of this same principal (D-78).
   *
   * Extracted because `review_inbox` needs the same answer for a different purpose and
   * two copies of this condition would disagree eventually — this repository's most
   * repeated defect. `mine` refuses such a review; the inbox LISTS it, because the inbox
   * is principal-scoped by design, and then has to say that none of the exits it would
   * normally prescribe will work. A note telling a caller to review_submit something that
   * answers NOT FOUND is worse than no note: it reads as lore pointing at a review that
   * does not exist.
   */
  function boundElsewhere(r: { readonly tokenHash?: string | undefined }): boolean {
    const bound = r.tokenHash;
    return bound !== undefined && bound !== who.tokenHash && store.tokenLive(bound);
  }

  /**
   * Fetch a refactor run or refuse, same reasoning as `mine` — repository scope, and
   * "not found" rather than "forbidden" so a guessed id learns nothing.
   *
   * No token-binding half: unlike `review_poll`, `refactor_poll` marks nothing
   * delivered and consumes nothing — it is safe for anybody holding this repo's token
   * to read the same run twice, so there is no colleague-loses-their-findings accident
   * to guard against here (D-136).
   */
  const myRefactorRun = (runId: string) => {
    const r = store.refactorRun(runId);
    if (r === undefined || r.repoId !== who.repoId) throw new Error(`refactor run ${runId} not found`);
    return r;
  };

  // ------------------------------------------------------------ review.start

  server.registerTool(
    "review_start",
    {
      description: TOOL_DOCS.start,
      inputSchema: z.object({
        branch: z.string().min(1).describe("branch under review"),
        // REQUIRED FOR mode: "diff" (the default), REFUSED for mode: "folder" — see
        // that param. `absent()` rather than a plain optional so the two can be
        // told apart from "forgot it" (schema now accepts the omission; the handler
        // still refuses a diff-mode review with no `into`, same message as today).
        into: absent(z.string().min(1)).describe(
          "branch it will merge into — it must EXIST in this repository, and it is not " +
            "assumed to be `main`: a repository whose trunk is `master` needs `master` here. " +
            "A name lore cannot find fails the review naming the branches it can see. " +
            "REQUIRED for mode: \"diff\" (the default); do not pass it for mode: \"folder\", " +
            "which has no base to diff against.",
        ),
        ticket: z
          .string()
          .min(1)
          .describe("the task text, pasted verbatim — not summarised, not your own description"),
        type: absent(z.enum(reviewTypeIds() as [string, ...string[]])).describe(`default: ${DEFAULT_TYPE}`),
        // D-130. Default "diff" is today's exact behaviour: `branch` diffed against
        // `into`, unchanged. "folder" reviews `path` as it stands — no base, no diff,
        // every file read as it exists — and needs `path` instead of `into`.
        //
        // A THIRD ENUM VALUE, not an inferred mode from an omitted `into`: a client
        // that simply forgets `into` today gets a clear schema error. If omitting it
        // silently meant folder mode instead, that same mistake would silently review
        // the wrong thing at the wrong scope rather than fail loudly — a new footgun
        // this project's whole ethos (INV-1, D-40) argues against for the sake of one
        // shorter parameter.
        mode: absent(z.enum(["diff", "folder"])).describe(
          'default "diff": review `branch` against `into`, exactly as always. Pass "folder" to ' +
            "review `path` as a full read instead — no base, every file in it read as it stands, " +
            "not as a change. Use this for a rewrite with no clean incremental diff, or a module " +
            "you want a fresh independent look at regardless of its git history.",
        ),
        // REQUIRED for mode: "folder", REFUSED otherwise. No default to the repo root:
        // a whole real repository's diff-against-nothing usually blows past the diff
        // size ceiling and every tier that reads it spends real quota on a mostly-cut
        // prompt, so an unscoped "review the folder" risks burning a full ladder's
        // quota by accident. Pass "." explicitly if you really do mean the whole tree.
        path: absent(z.string().min(1)).describe(
          'the path mode: "folder" reviews, relative to the repository root — "." for the whole ' +
            'tree, or a subdirectory ("src/payments") to scope it. Required when mode is "folder", ' +
            "refused otherwise.",
        ),
        // OPTIONAL, AND IT HAD TO BE. Required would have failed every `review_start`
        // from every client already working — three people on one repository — the
        // moment this deployed, and lore's own reviews are cut from scratch
        // `review/<sha>` refs that have no pull request in the first place. The docs
        // ask for it in the strongest terms available to a document; the schema does
        // not turn "you forgot a link" into "your review did not run" (INV-1).
        //
        // `http(s)` ONLY, checked here rather than trusted. This string is rendered as
        // a link on a page that needs no credential, so `javascript:` in it would be a
        // script somebody else chose, running in the operator's browser, on the one
        // page they open when something is wrong.
        pull_request: absent(
          z
            .string()
            .min(1)
            .max(2048)
            .refine((u) => /^https?:\/\//i.test(u), "pull_request must be an http(s) URL"),
        ).describe("link to the pull request this branch is proposed in"),
        // The describes below are CLIENT-FACING: they are the whole contract of the flags.
        restart: absent(z.boolean()).describe(
          "ALMOST NEVER WHAT YOU WANT. Cancels the open review and abandons everything it " +
            "learned — every finding, every justification already ratified — then starts from " +
            "round 1. If you pushed more commits, use pull_fresh instead: same review, new tree. " +
            "If you have fixes, review_submit them. restart is for a deliberate human decision " +
            "to discard the review's history, and for nothing else.",
        ),
        pull_fresh: absent(z.boolean()).describe(
          "CONTINUE the open review of this branch on the branch as origin now has it: lore " +
            "syncs, re-pins the same review to the new tip, and the tier that raised the open " +
            "findings judges the new tree. Findings, justifications and the ladder all carry. " +
            "This is the ordinary way to hand over new commits without composing a diff — push, " +
            "then call review_start with pull_fresh: true. Returns the SAME review_id.",
        ),
      }),
    },
    async ({ branch, into, ticket, type, restart, pull_request, pull_fresh, mode, path }, ctx) => {
      // D-130: THE TWO NEW PARAMS MUST NOT CONTRADICT EACH OTHER OR `into`, checked
      // before anything is looked up or spent — the same "refuse at the door" shape
      // `pull_fresh` + `restart` already gets below. Skipped by nothing: even a
      // pull_fresh call is worth checking, since `path` has to match what an open
      // folder review was actually started with to be found at all (see `open`,
      // next), and a silently-ignored contradiction there would be confusing in a
      // different way.
      const folderMode = mode === "folder";
      if (folderMode && path === undefined) {
        throw new Error(
          'mode: "folder" needs `path` — the path to review, relative to the repository root. Pass "." ' +
            "for the whole tree, or a subdirectory to scope it. There is no default: an unscoped folder " +
            "review usually exceeds the diff size ceiling and spends real quota reading a mostly-cut prompt.",
        );
      }
      // A NUL BYTE REACHING `execFile` THROWS FROM NODE ITSELF, not from git — and by
      // then the row already exists and a slot is already spent. Found by lore's own
      // review of D-130: `wholeTreeDiff` passes `path` straight into an `execFile`
      // argument (`git/exec.ts`), which Node refuses outright for any argument
      // containing "\0" — a queued-then-failed review instead of a door refusal,
      // exactly the class INV-1 exists to keep from happening quietly.
      if (path !== undefined && path.includes("\0")) {
        throw new Error("path must not contain a NUL byte.");
      }
      // lore-ok[4a56e160]: fixed immediately above, same round it was raised — the
      // NUL-byte check now runs before this line (and before `open` is looked up,
      // same as every other `path` validation here), refusing at the door instead
      // of reaching `execFile` after a review row already exists.
      if (folderMode && into !== undefined) {
        throw new Error(
          'mode: "folder" and `into` contradict each other: folder mode has no base to diff against, so ' +
            "there is nothing for `into` to name. Omit `into`, or drop mode: \"folder\" and use the default " +
            "diff review instead.",
        );
      }
      if (!folderMode && path !== undefined) {
        throw new Error(
          '`path` only applies to mode: "folder" — omit it for an ordinary diff review, or pass ' +
            'mode: "folder" to scope this review to it.',
        );
      }
      // `into` IS REQUIRED HERE TOO, checked at the same "nothing spent yet" point as
      // the three above it — found by lore's own review of D-130, HIGH severity: this
      // check used to sit right before `createReview`, AFTER the restart-cancel block
      // below. Before D-130 that was safe, because schema-level `into: z.string().min(1)`
      // made a request missing it unreachable at all — Zod rejected it before the
      // handler ran. Making `into` optional (so folder mode could omit it) made this
      // path live, and a late check reintroduces the exact incident this file's own
      // restart-cancel comment (below) documents fixing: a client that restarts and
      // forgets `into` would have its predecessor CANCELLED — every ratified
      // justification gone — and then be refused for the missing field, worse off than
      // before it asked. Checked here, before `open` is even looked up, nothing is
      // ever destroyed on the way to this refusal.
      if (!folderMode && into === undefined) {
        throw new Error(
          '`into` is required unless mode: "folder" is set — the branch this one will merge into. ' +
            "It must EXIST in this repository, and it is not assumed to be `main`.",
        );
      }
      // CANONICAL FROM HERE ON — see normalizeReviewPath. Every read of `path` below
      // this line uses `scopedPath` instead, so the dedup key and the stored row agree
      // with each other regardless of which spelling the client sent.
      const scopedPath = path === undefined ? undefined : normalizeReviewPath(path);
      if (path !== undefined && scopedPath !== undefined && pathEscapesWorktree(path, scopedPath)) {
        throw new Error(
          `path must stay inside the repository, relative to its root — "${path}" does not. Pass a path like ` +
            '"src" or "src/payments", not an absolute one or one starting with "..".',
        );
      }

      // AN OPEN REVIEW OF THIS BRANCH IS THE ONE TO CONTINUE, NOT TO DUPLICATE.
      //
      // Measured 2026-08-05, the first day a real client drove this: six reviews of
      // one branch in two hours, four of another, and 13 of 30 reviews stopping at
      // round 1. The ladder needs round 2 to settle anything — carry findings
      // forward, escalate, ratify a justification — so a repository being reviewed
      // all day produced ZERO verdicts and learned nothing. Every restart also
      // re-pays t0 and t1 from scratch.
      //
      // Nothing told the client that `review_submit` continues the same review, and
      // nothing noticed it was starting a fifth one. The docs say it now, and this
      // is the mechanical half: refused, with the id to continue instead. A refusal
      // rather than silently returning the existing review, because "here is a
      // review_id" that is not the one just asked for is exactly the kind of quiet
      // substitution this project refuses.
      //
      // `path` IS PART OF THE DEDUP KEY (D-130): a folder review of `src/payments` and
      // a diff review of the same branch are different work, and so are folder
      // reviews of two different paths on the same branch. A pull_fresh meant to
      // continue one of several open folder reviews on this branch has to name the
      // same path again, exactly as it already has to name the same branch again.
      const open = store.openReviewFor(who.repoId, branch, scopedPath);
      // CONTINUE, RE-PINNED (D-108). The middle path between "answer with a diff" and
      // "abandon everything": the client pushed more commits, so the SAME review moves
      // its pin to origin's new tip. Nothing resets — the tier that raised the open
      // findings judges the new tree, exactly as it judges a submitted diff.
      if (pull_fresh === true) {
        if (restart === true) {
          throw new Error(
            "pull_fresh and restart contradict each other: pull_fresh continues the review, restart abandons " +
              "it. Pick the one you mean — pull_fresh if you pushed more commits, restart only if a person " +
              "decided to discard the review's history.",
          );
        }
        if (open === undefined) {
          throw new Error(
            `pull_fresh continues an open review, and ${branch} has none — call review_start without it to ` +
              `begin one.`,
          );
        }
        // aa8cc149: THE SAME GAP restart HAD, one branch over. `open` is
        // repo-scoped so a colleague can see it — that is deliberate — but pull_fresh
        // then acted on it with no ownership check at all, and `deps.repin` a few
        // lines down RECUTS THE WORKTREE: a submit applied and never committed
        // (D-40) exists nowhere else, so a colleague's pull_fresh on your branch
        // could silently discard fixes you had already submitted, reset your round
        // bounds, and re-queue your review — all under their action, no warning to
        // either side. Worse than restart in one way: pull_fresh is documented as
        // the SAFE continuation, so a caller reaching for it has no reason to expect
        // it destroys anything. Principal, not `mine`'s full token binding, for the
        // same reason as restart: this hands over no data, and the caller's OWN
        // review must stay reachable from a rotated token — the token-rotation case
        // the refusal below this whole branch already documents a path through.
        if (open.principal !== who.principal) {
          throw new Error(
            `${branch} already has an open review (${open.id}, round ${open.round}) started by ` +
              `${open.principal}, not you. pull_fresh: true would re-pin and re-queue it — and if it holds ` +
              `fixes ${open.principal} submitted but never committed, discard them, since re-pinning recuts ` +
              `the worktree from origin. Nothing has been touched. Ask ${open.principal} to continue it ` +
              "themselves; only the principal who started a review can pull_fresh it over this surface.",
          );
        }
        if (store.hasPendingRound(open.id)) {
          throw new Error(
            `a round is running for ${open.id} right now — poll it, and call pull_fresh again when it parks. ` +
              `(A diff submitted mid-round is held for the reviewer; a whole-tree re-pin is not, because ` +
              `replacing the tree under a reading tier is exactly what the hold exists to prevent.)`,
          );
        }
        if (deps.repin === undefined) {
          throw new Error("this build cannot re-pin a review; start over or submit a diff.");
        }
        // lore-ok[49451a88]: right, and fixed one layer in rather than here. The column
        // really was NULL for the reviews this guard protects — `review_start` writes the
        // row before any worktree exists, so `createReview` had no tree to record — which
        // made `before !== undefined` dead. It is now written where the tree first EXISTS:
        // `runRound` stamps `origin_tree_hash` from the round-0 tree. This line is correct
        // as it stands and is the reader of that value, not its writer.
        // lore-ok[d9ec8874]: the same finding, reported twice. Same answer.
        // THE LAST ORIGIN PIN, never the fixes-applied tree. `treeHash` is advanced by
        // review_submit, a held diff landing, and every round's own end — so comparing
        // against it meant this check could only ever fire on a review that had NEVER
        // been fixed, and a no-op pull_fresh after any submit silently rewound the review
        // to the pre-fix tip. `originTreeHash` is the one field ordinary fixes never move.
        const openRow = store.getReview(open.id, store.principalOf(open.id) ?? who.principal);
        const before = openRow?.originTreeHash;
        // lore-ok[a204d46d]: both halves upheld, and both fixed in `repinReview` rather
        // than here. The destroy-then-compare ORDER is gone — `expectTree` goes in, and
        // the recut happens only once origin is known to have moved — and the ref
        // NAMESPACE is fixed with it: `originTree` now resolves `origin/<branch>` first
        // and falls back to `refs/heads/<branch>`, which is `addWorktree`'s own order and
        // the only one that survives a mirror fetching `+refs/heads/*:refs/remotes/origin/*`
        // with its local heads frozen at clone time. The fixture that could not see this
        // was fetching into `refs/heads/*`; it now uses the production refspec.
        // `before` goes IN, so the decision is made before anything is destroyed rather
        // than compared after — see `repinReview`. Passing it is what makes the
        // "unchanged" reply below safe to give.
        const pinned = await deps.repin(open.id, before, openRow?.intoRef);
        if (before !== undefined && pinned.treeHash === before) {
          return text(
            JSON.stringify({
              review_id: open.id,
              status: "unchanged",
              note:
                "origin has nothing newer than this review already reviewed" +
                (pinned.synced ? "" : " (and lore could not confirm a fresh sync first)") +
                " — push your commits, then call again.",
            }),
          );
        }
        // NEW COMMITS FROM THE CLIENT, so the round bounds restart (D-114) — a
        // `pull_fresh` that got this far is one where origin genuinely moved.
        store.noteClientWork(open.id);
        // THE BASE MOVES ONLY AT A PIN (D-113), and this is one. Omitted rather than
        // written as undefined when the ref would not resolve: `updateReview` treats
        // undefined as "leave it", and the stored base is the last one that was true.
        store.updateReview(open.id, {
          state: "queued",
          treeHash: pinned.treeHash,
          originTreeHash: pinned.treeHash,
          ...(pinned.baseCommit === undefined ? {} : { baseCommit: pinned.baseCommit }),
        });
        deps.enqueue(open.id, "fast");
        return text(
          JSON.stringify({
            review_id: open.id,
            status: "continued",
            note:
              "Same review, new tree: the branch as origin now has it. Findings, ratified justifications and " +
              "the ladder all carried; the tier that raised the open findings will judge the new tree. Poll as " +
              "usual.",
          }),
        );
      }

      if (open !== undefined && restart !== true) {
        // THE AGE IS PART OF THE ADVICE, not decoration.
        //
        // This fired on a review from twenty hours and twenty-five commits earlier,
        // whose pinned snapshot was long meaningless — and offered `restart: true`
        // only "if the branch was rebased or force-pushed", which it had not been. So
        // the message named an id worth continuing, gave a condition that did not
        // apply, and left the one correct action looking unavailable.
        //
        // A review is pinned to the tree it began with (D-40), so what decides between
        // continuing and restarting is how far the branch has moved since — and age is
        // the only proxy for that available here. Twelve hours is a working day's
        // worth of drift, not a threshold with evidence behind it; it is a hint to a
        // reader who has the branch in front of them and can tell.
        const stale = open.ageHours >= 12;
        const age =
          open.ageHours < 1
            ? `${Math.round(open.ageHours * 60)} minutes`
            : `${Math.round(open.ageHours)} hours`;
        throw new Error(
          `${branch} already has an open review: ${open.id} (state ${open.state}, round ${open.round}, ` +
            `last advanced ${age} ago). Continue it — poll it, then answer its findings with review_submit. ` +
            // lore-ok[5e53c948]: real for its own case, and superseded by 393cf295
            // just below rather than rewritten in place — this is the reasoning that
            // established pull_fresh as A way out; 393cf295 is what found it is not
            // the ONLY one and corrected the overclaim. Kept so the two read as one
            // history rather than a silent replacement.
            //
            // lore-ok[393cf295]: found real by lore's own review, against the fix
            // just above — "works regardless of whether you pushed anything" is
            // false in exactly the case this sentence exists for: rotation overlap
            // with nothing new pushed. Origin has not moved, so pull_fresh takes the
            // status: "unchanged" branch a few lines up — no re-pin, no requeue,
            // nothing carried forward — and hands back "push your commits, then call
            // again" to a caller with no commits to push.
            //
            // The mechanism that actually works regardless was already sitting in
            // `mine`'s own comment: a REVOKED binding falls back to repository scope
            // (D-78), so revoking the stale token unblocks poll/submit on the new one
            // immediately, independent of whether origin has moved. Revoking is
            // CLI-only (`make revoke`, deploy/Makefile) — a human's move, not this
            // client's — so it is named as the ask rather than attempted here.
            `IF EITHER SAYS "not found", a different, still-valid token of yours started this review — normal ` +
            `during a token rotation's overlap window. (It could instead be a colleague's review of the same ` +
            `branch: both pull_fresh and restart below refuse cleanly and name them if so, so trying is safe ` +
            `either way.) If anyone has pushed to ${branch} since, review_start ` +
            `again with pull_fresh: true re-pins the SAME review to origin's current tip and carries everything ` +
            `forward — try that first. If nobody has, pull_fresh will answer "unchanged" and change nothing: ` +
            `ask a person to revoke your OLD token instead (make revoke on the lore host; make tokens lists ` +
            `which one). A revoked binding falls back to repository scope, so poll and submit on your CURRENT ` +
            `token work immediately, no re-pin needed. ` +
            `Starting again (restart: true) would re-run the cheap tiers from round 1 and abandon every ` +
            `justification this review has already ratified, which is why the deep tiers are rarely reached. ` +
            (stale
              ? `BUT THAT REVIEW IS ${age.toUpperCase()} OLD. It is pinned to the tree it started with, so ` +
                `if the branch has moved since — commits, a rebase, a force-push — it is reviewing code ` +
                `nobody is merging, and there is nothing worth carrying forward. Pass restart: true.`
              : `If the branch was rebased or force-pushed the old snapshot is genuinely meaningless — ` +
                `pass restart: true, deliberately.`),
        );
      }

      // RESTART CANCELS ITS PREDECESSOR, in the same breath (D-107 shape, found live).
      //
      // `restart: true` used to fall straight through to createReview and touch nothing —
      // so the old review stayed OPEN: two live reviews of one branch, racing rounds
      // against two pinned trees, burning two reviews' quota and raising two sets of
      // findings for one PR. Measured before fixing: feat/RIGID-129 accumulated SEVEN
      // overlapping generations this way, each restart stacking a new live review on the
      // last, until the operator mass-cancelled them from the board. The directories
      // never clashed — the reviews did.
      //
      // The same order the cancel tool uses, for the same reason: state first, so a round
      // claimed in this instant finds a terminal review and stops before spending; the
      // in-flight model call aborted after, best-effort exactly as there.
      // THE SERVICE IS FULL — refused at the door, never queued in the middle (D-98).
      //
      // The alternative was a semaphore that made a round wait for a model slot, and
      // what that produced was a review sitting in `queued` with a clock running and
      // nothing on any surface able to say whether it was waiting or wedged. A client
      // that is REFUSED knows: it can come back, tell its user, or cancel something.
      //
      // Checked before the row is written, so a refusal leaves nothing behind, and it is
      // now the ONLY thing that refuses a review at all: the spend ceiling that also did
      // fired at enqueue, after the row existed, and therefore had a review to mark
      // `failed` — which is how eight of other people's reviews came to carry lore's
      // ledger in their failure on 2026-08-16. It is gone (D-121). Nothing here has been
      // promised to anyone yet, which is why this refusal costs a client nothing.
      //
      // AND BEFORE THE RESTART CANCEL BELOW, which is what makes that promise true. The
      // cancel ran first, so at the limit a restart DESTROYED the client's predecessor —
      // every justification it had ratified with it — and was then refused by this
      // check, whose own message says "NOTHING WAS STARTED". The client ended the call
      // with no review at all, worse off than before it asked, told nothing had happened.
      //
      // A RESTART DOES NOT NEED A FREE SLOT: it cancels one review and starts one, so it
      // is slot-neutral, and counting its own predecessor against it would refuse the one
      // operation that cannot make the service any fuller.
      const restarting = open !== undefined && restart === true;

      // 8d847ca4: RESTART IS DESTRUCTIVE, AND `open` IS REPO-SCOPED, NOT PRINCIPAL-
      // SCOPED (`store.openReviewFor`'s own comment: colleagues are told about each
      // other's open reviews on purpose, to avoid duplicating work). That is right
      // for the READ the refusal above gives every caller — it is not a licence to
      // CANCEL a colleague's review. `review_cancel` refuses that via `mine()`; this
      // path fell straight through to `setFailureReason`/`updateReview` with no
      // check at all, so a repo-mate's `restart: true` on a stale-looking review
      // could destroy someone else's in-flight work — every ratified justification,
      // an in-flight model call — on a branch they never named as theirs.
      //
      // Principal, not `mine()`'s full token binding: restart does not hand over
      // any data (nothing D-78 exists to guard here), it only destroys-and-replaces,
      // and the caller's OWN review on a rotated token must still be restartable —
      // the exact case 393cf295/5e53c948 already document a path through. Blocking
      // that too would be a second dead end for the same rotation window.
      if (restarting && open !== undefined && open.principal !== who.principal) {
        throw new Error(
          `${branch} already has an open review (${open.id}, round ${open.round}) started by ` +
            `${open.principal}, not you. restart: true would cancel it — every justification it has ` +
            `ratified, any model call in flight — and it is not yours to cancel. NOTHING WAS STARTED. Ask ` +
            `${open.principal} to continue it (poll, then review_submit) or cancel it themselves; only the ` +
            "principal who started a review can end it over this surface. An abandoned review is swept " +
            "automatically after 48h of quiet and a further week, if waiting is an option.",
        );
      }

      const admission = mayAdmit(store.openReviewCount() - (restarting ? 1 : 0));
      if (!admission.allowed) {
        throw new Error(
          `lore is full: ${admission.open} reviews are already open, and the limit is ${admission.limit}. ` +
            "NOTHING WAS STARTED — this branch is unreviewed and no review id exists for it. Try again once " +
            "something finishes. If reviews of yours are sitting in findings_ready with nobody answering " +
            "them, review_inbox lists them and review_cancel on one frees a slot immediately: an abandoned " +
            "review holds its place here until the sweep takes it, which is 48h of grace and then a further " +
            "week — so cancelling what you are not going to answer is far faster than waiting it out.",
        );
      }

      if (restarting && open !== undefined) {
        store.setFailureReason(open.id, `cancelled by ${who.principal}: superseded by a restart of ${branch}`);
        store.updateReview(open.id, { state: "cancelled" });
        await deps.reviewer?.cancel?.(open.id).catch(() => false);
        store.clearSessionTrees(open.id);
      }

      const rt = reviewType(type ?? DEFAULT_TYPE);
      const id = newReviewId();
      store.createReview({
        id,
        repoId: who.repoId,
        principal: who.principal,
        // The token this review answers to (D-78) — see `mine`.
        tokenHash: who.tokenHash,
        // And the ladder it starts on, so swapping `LORE_TIERS` cannot silently rebind
        // its cursor to a different model half way through.
        tiers: ladderFingerprint(rt.tiers),
        branch,
        ...(pull_request === undefined ? {} : { pullRequest: pull_request }),
        ...(folderMode ? {} : { intoRef: into }),
        ...(folderMode ? { reviewPath: scopedPath } : {}),
        ticket,
        type: rt.id,
        state: "queued",
        ladder: initialState(rt.tiers),
      });
      // Fast stage first: at 30 PRs a day nobody waits for a full ladder (D-34).
      deps.enqueue(id, "fast");
      return text(
        JSON.stringify({
          review_id: id,
          state: "queued",
          // THE STRING A CLIENT IS GUARANTEED TO READ, and it is not in `docs.ts`, which
          // is how it survived the rewrite that moved every text in that file to
          // subscribe-first. A tool description may or may not be in the model's
          // context by the time this returns; the response note always is.
          ...pacing(store, { id, repoId: who.repoId, state: "queued", type: rt.id, ladder: initialState(rt.tiers) }),
          // Where the subscription hint used to go. See `subscribeTo` (D-103).
          ...subscribeTo(id, ctx),
          // THE STRING A CLIENT IS GUARANTEED TO READ, and it pointed at a field that is
          // no longer here. D-103 stopped handing out the subscribe frame; this sentence
          // went on saying "SEND THE `subscribe` CALL BELOW" for exactly one deploy, which
          // is a reply telling a client to do something the same reply makes impossible.
          // Caught by reading the response to lore's own review_start.
          //
          // 76470c5e/004465f7: found real by lore's own review, the same defect class
          // as the one just above — a reply telling a client to do something the same
          // reply can make impossible. `check_back_after_ms` is OMITTED below MIN_RUNS
          // (`pacing`, a few lines up), which is every tier's first 20 rounds — the
          // state a freshly provisioned repository's FIRST EVER review_start is
          // guaranteed to be in. The round-4 fix touched TOOL_DOCS.start, a tool
          // DESCRIPTION that may not even be in context by the time this returns; this
          // reply note is the one string this project's own comment, right above,
          // already says is guaranteed read — and it was the one left unfixed.
          note:
            "Started. This does NOT mean it finished, and NOTHING can have happened yet. Poll it with " +
            "review_poll: ONE call when `check_back_note` says. `check_back_after_ms` gives the same " +
            "answer as a number WHEN IT IS PRESENT — RE-READ it on every reply rather than reusing the " +
            "first one, since below the two-minute cap it shrinks as the round ages, and AT the cap it " +
            "stays put for several calls. It is OMITTED on a tier's first 20 rounds (no honest median " +
            "yet, common on a freshly provisioned repository) — `check_back_note` always has a full " +
            "instruction regardless. Between calls, go and do something else.",
        }),
      );
    },
  );

  // ------------------------------------------------------------- review.poll

  server.registerTool(
    "review_poll",
    {
      description: TOOL_DOCS.poll,
      inputSchema: z.object({ review_id: z.string().min(1) }),
    },
    async ({ review_id }, ctx) => {
      const review = mine(review_id);
      const fresh = store.undelivered(review_id);
      store.markDelivered(review_id, fresh.map((f) => f.fingerprint));

      // lore-ok[de741489]: found real by lore's own review — a needs_human review
      // whose blocking conflict closed WITHOUT going through knowledge_resolve (an
      // ordinary document edit retiring one side, D-20 — nothing else ever called
      // `resumeNeedsHuman`) had no legal way forward: the text below used to say
      // "call review_submit with an empty diff", which the tool's own schema
      // refuses (`diff`/`commit` are each `.min(1)`, exactly one required, and an
      // empty diff normalises to absent). Stuck until the 48h sweep expired it,
      // concluding nothing, while every text said nothing was blocking it. Resumed
      // HERE now — computed BEFORE the response is built, so `state`/`clean`/`note`
      // below describe what is actually true after it, not the stale row `mine`
      // read a moment ago.
      const openConflicts = review.state === "needs_human" ? store.openConflicts(review.repoId) : [];
      const justResumed = review.state === "needs_human" && openConflicts.length === 0;
      if (justResumed) {
        store.resumeNeedsHuman(
          review.repoId,
          "No contradiction is open any more. The document that supplied one side of it changed (or a " +
            "person resolved it directly) and nothing else in this repository is blocking. Resumed " +
            "automatically — carry on from where the review stopped, no submit needed.",
        );
      }
      const state = justResumed ? "queued" : review.state;

      return text(
        JSON.stringify({
          review_id,
          state,
          // Restated on every poll, because failure mode 1 and 7 are the two most
          // likely ways this loop ends with unreviewed code shipped.
          clean: isClean(state),
          // THE NEXT CALL, NAMED. This said only "NOT clean. Only `passed` means
          // clean." — true, and it left a client holding three findings with no
          // sentence telling it what to do with them. Every failure this surface has
          // had in production was a client doing something reasonable that nothing
          // told it not to: polling once and stopping, retrying a review that could
          // never succeed, walking away from `findings_ready` (the single largest
          // cause of abandoned reviews). A state name is not an instruction.
          note: nextStep(state, fresh.length, review_id),
          // The branch's own defects FIRST, inherited ones after.
          //
          // Ordering is what a reader actually acts on, and severity alone put two
          // pattern matches in test fixtures the branch never opened above three spec
          // contradictions in files it wrote. Both are true; only one is this merge's
          // to answer, and triage should not have to work that out.
          new_findings: [...fresh]
            .sort((a, b) => Number(a.preexisting ?? false) - Number(b.preexisting ?? false))
            .map((f) => {
            const short = f.fingerprint.slice(0, 8);
            // A finding can be raised and settled inside one round: D-51 carries a
            // justification this repo already ratified into a later review and
            // accepts it without anyone answering. It is still NEW to this caller,
            // so it is still delivered — but telling them to justify it would be a
            // confident instruction to do work that is already done, and the lore-ok
            // they wrote in response would be fresh surface for the next tier to
            // review. Observed here: a semgrep CWE-319 on a loopback test server,
            // auto-settled by carry-forward, handed back with `justify_with` set.
            // The question is whether the finding is CLOSED, not whether a verdict
            // row exists. `justified-rejected` is a verdict and leaves the finding
            // open — the reviewer read the reason and refused it — so asking the
            // wrong one labelled the most serious case "nothing to do" while
            // `open_count` still counted it (t2, medium).
            const verdict = store.latestVerdict(review_id, f.fingerprint);
            const closed = verdict !== undefined && isSettled(verdict.verdict);
            const rejected = verdict?.verdict === "justified-rejected";
            return {
              fingerprint: short,
              file: f.file,
              line: f.line,
              symbol: f.symbol,
              severity: f.severity,
              cwe: f.cwe,
              claim: f.claim,
              evidence: f.evidence,
              failure_scenario: f.failureScenario,
              ...(closed
                ? {
                    settled: verdict.verdict,
                    settled_because: verdict.rationale ?? "no reason recorded",
                    note: "Already settled — nothing to do. Shown because it is new to you.",
                  }
                : {
                    // THE FINDING IS A QUESTION, AND THIS IS IT (D-79). A record
                    // invites compliance; an ask invites judgement, and judgement is
                    // what a justification is for. The mechanism was always this —
                    // the reviewer rules on your reason (D-10) — and the shape hid it,
                    // so clients treated findings as verdicts and argued badly or not
                    // at all.
                    asks: "Fix this, or tell me why it is not a problem. Both are real answers, and I may be wrong.",
                    // AND THE THIRD ANSWER, said HERE rather than after a wasted submit.
                    //
                    // Fixing the CAUSE somewhere else is often the right repair, and it
                    // leaves this line untouched — which the next round reads as a finding
                    // nobody answered, so it cannot settle however it goes. `review_submit`
                    // already says this in `will_not_settle`, but only once the submit has
                    // been spent: measured on lore's own review of D-121, where the fix
                    // landed sixty lines above the named line and the round trip bought
                    // nothing. A client can only act on it if it is told while it is still
                    // deciding where to put the fix.
                    fixed_elsewhere:
                      "If you repair this by changing OTHER code, the tier will not see this line move and " +
                      "cannot settle it. Leave the `justify_with` comment here saying where the fix went, and " +
                      "submit both together.",
                    justify_with: `// lore-ok[${short}]: <why this code is correct, or where it was fixed>`,
                    // Still open, and worse than open: a justification was offered
                    // and refused. Saying so is the difference between "answer this"
                    // and "your answer was wrong".
                    ...(rejected
                      ? {
                          justification_rejected: verdict.rationale ?? "no reason recorded",
                          note: "Your justification was REJECTED. Fix the code, or give a reason that holds.",
                        }
                      : {}),
                  }),
              // A finding with history is far more actionable than the same finding
              // raised cold: it says whether to fix the line or fix the habit.
              history: renderEnrichment(enrich(store, who.repoId, review_id, f)),
              // Not this branch's doing, and every other branch inherits it too.
              ...(f.preexisting === true
                ? {
                    preexisting: true,
                    preexisting_note:
                      "This file is NOT touched by your branch, and the pattern that matched was already " +
                      "there — every other branch gets this finding too. It is real and worth a ticket; it " +
                      "is not yours to answer here. Fixing it widens this merge; a lore-ok settles it.",
                  }
                : {}),
            };
          }),
          open_count: store.openFindings(review_id).length,
          // lore-ok[9e18a0b1]: found real by lore's own review, same finding as
          // afc10ea2 below — the de741489 resume above corrects the top-level
          // `state`/`clean`/`note` but this read `review.state`, the STALE
          // pre-resume value, straight from `mine`'s result. A just-resumed poll
          // said `state: "queued"` with `nextStep("queued")` instructing "read
          // `check_back_note` THIS TIME" while `pacing` gated on the stale
          // `needs_human` and returned `{}` — a reply telling a client to do
          // something the same reply makes impossible, the exact shape `de741489`'s
          // own comment two screens up exists to prevent. `{ ...review, state }`
          // carries the corrected value in without changing `pacing`'s signature.
          ...pacing(store, { ...review, state }),
          // Only while there is something to wait FOR. In `findings_ready` the next move
          // is the client's, and handing it a subscribe call there would read as
          // permission to sleep on findings that are already its problem — the
          // abandonment D-70 measured. Terminal states have nothing left to announce.
          // lore-ok[afc10ea2]: same finding as 9e18a0b1 above, raised twice with
          // different wording — `state` (the corrected local) reused here rather
          // than `review.state`, for the identical reason.
          ...(["queued", "running", "fast_clean"].includes(state) ? subscribeTo(review_id, ctx) : {}),
          // Deterministic, known in milliseconds, and the fact a landing decision
          // actually turns on. It was reaching the reviewer's prompt and stopping
          // there, so a client triaging eight open pull requests would have needed
          // eight model-tier reviews to learn which ones were stale.
          ...(() => {
            const n = store.behindBy(review_id);
            return n === undefined || n === 0
              ? {}
              : {
                  behind_by: n,
                  behind_by_note:
                    `The base has ${n} commit(s) this branch does not. The findings above are correct for the ` +
                    "fork point, but nothing here was checked against the base as it now stands — so a `passed` " +
                    "does not mean this merges cleanly or still works. Rebase and review again before landing.",
                };
          })(),
          // A PERSON ANSWERED THE QUESTION WHILE YOU WERE AWAY (D-99).
          //
          // A contradiction can now be settled with a button on the operator board, which
          // resumes every review parked on it. From here that is indistinguishable from an
          // ordinary requeue — and the client's standing instruction for `needs_human` is
          // to take the question to its user, so without this it would go and ask somebody
          // who has already answered, and quite possibly get a second, different answer.
          //
          // Carried on every poll from then on rather than once: a review is polled by
          // whichever session happens to be alive, and a fact delivered exactly once is a
          // fact the next session does not have (the same reasoning as `review_inbox`).
          //
          // lore-ok[1b172d0a]: the finding is real and is fixed at the other end. Read
          // unconditionally here, and CLEARED when a round parks the review on a person
          // again (`settleState` in reviewer/review.ts, `clearHumanDecision` in the store),
          // so what survives to be read can only be the answer to the question that is
          // actually blocking this review. Fixed there rather than here because the
          // condition is "the review parked again", which this call cannot observe — it
          // sees a state, not a transition — and a reader that tried to infer it would be
          // guessing at exactly the moment the client is told not to ask its user.
          ...(() => {
            const decision = store.humanDecision(review_id);
            return decision === undefined ? {} : { human_decision: decision };
          })(),
          // WHY it did not run, not merely that it did not. A bare `failed` is the
          // shape INV-1 refuses: indistinguishable from "found nothing" to anyone
          // who has to act on it, and an invitation to guess. A client given only
          // the word published a diagnosis that was the opposite of the truth.
          ...(() => {
            // `cancelled` belongs here too. Somebody stopped this review and said why,
            // and the next session to look at it — or the same one after a restart —
            // has no other way to learn that. Without it a cancel reads exactly like an
            // abandonment, which is the distinction the state exists to draw.
            if (!["failed", "expired", "cancelled"].includes(review.state)) return {};
            // A CANCEL MAY NOT BORROW A ROUND'S ERROR. `failureReason` falls back to the
            // last `job.last_error` because for a `failed` review that is usually the
            // truest account there is — but a cancelled one was stopped by a person, and
            // handing back a transport error from an unrelated earlier round would
            // manufacture their reason. The state whose whole purpose is to say somebody
            // decided this must not answer with something that merely happened.
            const why = store.failureReason(review_id, review.state !== "cancelled");
            return why === undefined
              ? {
                  failed_because:
                    review.state === "cancelled"
                      ? "cancelled with no reason recorded — say that, and do not infer why"
                      : "no reason was recorded, which is itself a defect — report it rather than inferring a cause",
                }
              : // 0796e115: de431bb7's fix (below) skipped forClient whenever the review's
                // CURRENT state is `cancelled`, on the premise that a cancelled review's
                // reason is always human-authored — wrong, found by lore's own review
                // against its own prior fix. A held diff that fails to apply writes RAW
                // kitchen text — an absolute worktree path, raw git plumbing
                // (consumeHeldDiffs, reviewer/review.ts; worker.ts's late-hold sweep) —
                // while the review is `awaiting_diff`, non-terminal. If that review is
                // THEN cancelled with NO reason given, review_cancel never overwrites the
                // column (it only writes when `reason` is non-empty), so the stale
                // system-authored text survives unchanged into `cancelled` and this
                // ternary, keyed on state, let it straight through untranslated. The
                // state is not a reliable proxy for who wrote the text that happens to be
                // sitting in the column; the text's own shape is. Both human-authored
                // write sites — review_cancel's `reason` param and the restart-supersede
                // sentence — use exactly one prefix, unconditionally: `cancelled by
                // ${principal}: `. Checking for it is checking provenance directly,
                // correct regardless of which state transitions happened first.
                { failed_because: why.startsWith("cancelled by ") ? why : forClient(why) };
          })(),
          // A check that did not run is not a check that found nothing (INV-1). The
          // deterministic engines are the ones that go missing silently — no
          // `node_modules`, no test script, a disabled suite — and their absence
          // narrows what any later `passed` is evidence OF. The model tiers are told
          // in their prompt; the client has no other way to find out.
          ...(() => {
            // c1a9d4b6/fcf8e8cd: the third door of the class de431bb7/0796e115 fixed
            // for `failed_because` above — one entry kind here embeds a TEAM-authored
            // development rule's full statement verbatim, in quotes (D-83's design,
            // reviewer/review.ts: "the client's channel is the audit trail and wants
            // the whole reason"). A rule whose statement happens to contain a URL, the
            // word "opencode", or an absolute path is not kitchen text — it is a quote
            // from a person, and running it through forClient anyway attributes words
            // to the team that the team never wrote. Every other entry here is
            // genuinely system-authored (an engine that could not run, a tier that
            // failed over) and still needs translating.
            //
            // 9e8af4bb: the first version of this check was `line.includes(" was NOT
            // reported at ")` — unanchored. Two OTHER writers of this same list embed
            // UNTRUSTED text verbatim (a rejected finding's up-to-300-char raw model
            // JSON excerpt; a tier-unavailable note's caught error message), and either
            // can legitimately CONTAIN that exact phrase — this repository reviews
            // itself, and the phrase is the ladder's own vocabulary, so a model quoting
            // this file's own source would do it. An unanchored match would then exempt
            // untrusted text from translation on nothing more than a coincidental
            // substring — the leak direction, unlike `isSuppressionNotice`'s OTHER use
            // in reviewer/review.ts, where the same unanchored shape only ever dropped a
            // line from a prompt. `isSuppressionNotice` (core/checks-skipped.ts) is
            // anchored at the start against the one shape this list's real producer
            // writes, exactly as `isCoverageLoss` already had to be for the same reason.
            const skipped = store.unavailableChecks(review_id).map((line) =>
              isSuppressionNotice(line) ? line : forClient(line),
            );
            return skipped.length === 0
              ? {}
              : {
                  checks_skipped: skipped,
                  // NOT EVERY ENTRY IS A CHECK THAT DID NOT RUN. D-93 puts one here that
                  // says the opposite — the tier RAN through a metered provider because
                  // its subscription was out — and `TOOL_DOCS.poll` was rewritten to tell
                  // the client exactly that. This note was not, so the two texts on one
                  // payload contradicted each other, on the branch's headline path.
                  checks_skipped_note:
                    "Most of these are checks that did NOT run: anything they would have caught is unexamined, " +
                    "so say so to your user and weigh a later `passed` accordingly. A line saying a tier " +
                    "`was answered by` another provider is the exception — that tier ran and its opinion counts " +
                    "in full; it is listed because it cost money, not because anything is missing. Read each line.",
                };
          })(),
          // THE QUESTION ITSELF, not just the fact that there is one.
          //
          // `needs_human` is the single state whose entire purpose is "a person must
          // decide this" — and it shipped saying only that. A client hit it on a real
          // review and reported, correctly, that lore "does not say which question".
          // Telling an agent to stop and ask a human, without telling it what to ask,
          // is the same defect as a review that did not run reporting nothing found:
          // the machine knows something the caller needs and does not say it.
          //
          // Rendered rather than raw ids: the two statements ARE the question, and an
          // id pair sends the reader on a second lookup for the only thing that
          // matters.
          ...(() => {
            if (review.state !== "needs_human") return {};
            // Reuses `openConflicts`, computed once above (before the response was
            // built) so it and the resume side-effect it triggers stay in sync with
            // `state`/`clean`/`note` — see the `lore-ok[de741489]` comment there.
            const open = openConflicts;
            // lore-ok[aa57c0f2]: was capped at 1000 with no ordering — found by
            // lore's own review. A conflict naming an id past that window rendered
            // "(retired)" for a rule that was very much live, the 592cd49f bug's
            // other door; resolving every open conflict's id needs every live row.
            const byId = new Map(store.knowledgeFor(review.repoId, undefined, NO_LIMIT).map((k) => [k.id, k]));
            const questions = open.map((c) => ({
              left: { id: c.left, statement: byId.get(c.left)?.statement ?? "(retired)", source: byId.get(c.left)?.provenance },
              right: { id: c.right, statement: byId.get(c.right)?.statement ?? "(retired)", source: byId.get(c.right)?.provenance },
            }));
            if (questions.length > 0) {
              return {
                needs_human_because:
                  "This repository's memory contains statements that cannot both be true. A REVIEW CANNOT SETTLE THIS — " +
                  "the answer decides what every future session is told about this codebase, so a person must choose. " +
                  "Take it to them, then call knowledge_resolve with the id to keep, or knowledge_escalate if they cannot decide either.",
                open_questions: questions,
              };
            }
            // ANSWERED. The state is a record of where the review stopped, not a
            // claim that it is still stopped.
            //
            // Written the wrong way round first, and caught while a real review was
            // sitting in exactly this position: with no open conflicts left, this
            // said the record was "gone" and told the client to report a defect in
            // lore. Resolution is the NORMAL exit from needs_human, not evidence of
            // data loss, and sending a client to raise a bug because a person did
            // what they were asked to do is its own small betrayal of INV-1.
            //
            // lore-ok[de741489]: `resumeNeedsHuman` already ran, above, before this
            // response was built — see that comment for why "call review_submit
            // with an empty diff" (what this used to say) does not work and never
            // resumes a review closed by anything other than knowledge_resolve.
            return {
              needs_human_because:
                "The question has been ANSWERED — no contradiction is open any more. This review has just " +
                "been resumed automatically; poll again shortly rather than calling review_submit.",
              open_questions: [],
            };
          })(),
        }),
      );
    },
  );

  // ----------------------------------------------------------- review.submit

  server.registerTool(
    "review_submit",
    {
      description: TOOL_DOCS.submit,
      inputSchema: z
        .object({
          review_id: z.string().min(1),
          // `absent`, not `.optional()`: the caller is a language model and writes `null`
          // for absent as readily as it omits the key, which plain `.optional()` rejects
          // as a hard validation error against an agent that did nothing wrong. Blank is
          // forgiven, wrong is still refused.
          diff: absent(z.string().min(1)).describe("unified diff of your fixes"),
          commit: absent(z.string().min(1)).describe(
            "a commit you have PUSHED, as an alternative to `diff` — use this when you did not compose the " +
              "earlier submissions and so cannot diff against the review's tree",
          ),
          tree_hash: z
            .string()
            .min(1)
            .describe(
              "git write-tree of the tree you mean — for `diff`, verified after we apply it; for `commit`, " +
                "checked synchronously against the commit's own tree before anything is applied or held",
            ),
          // D-133: the same thing a `// lore-ok[fp]: fixed elsewhere, see X` comment at
          // the ORIGINAL line already says — offered as a field because writing that
          // comment costs nothing extra when you already know where the fix went, and
          // ruled on exactly the same way (this is not a shortcut around review, only
          // around re-explaining it in a second place).
          fixed_elsewhere: absent(
            z.array(
              z.object({
                fingerprint: z.string().min(1).describe("the finding's fingerprint, from review_poll"),
                file: z.string().min(1).describe("where the fix actually landed — must be part of THIS submission"),
                line: absent(z.number().int().positive()),
                reason: z.string().min(1).describe("what you changed there, and why it answers the finding"),
              }),
            ),
          ).describe(
            "findings you are answering by pointing at a fix elsewhere in this same diff/commit, instead of " +
              "a lore-ok comment at the original line",
          ),
        })
        // EXACTLY ONE, and it is refused here rather than downstream. Both would be two
        // descriptions of a tree that can disagree, and lore would have to pick; neither
        // leaves nothing to apply, and the tree-hash check would then pass trivially
        // against the tree already in the worktree — a submit that reviewed nothing while
        // looking like it worked.
        .refine((v) => (v.diff === undefined) !== (v.commit === undefined), {
          message: "send exactly one of `diff` or `commit` — not both, and not neither",
        }),
    },
    async ({ review_id, diff, commit, tree_hash, fixed_elsewhere }) => {
      const review = mine(review_id);

      // A FINISHED REVIEW TAKES NO MORE WORK.
      //
      // There was no guard here, and it was harmless only by accident: the worktree
      // of a terminal review happened to still exist, so a patch landed in a
      // directory nobody would read again. Dropping those worktrees on completion
      // (D-70) turns that into a real fault — `worktreeFor` would cut a FRESH base
      // from the mirror as it stands now, apply the patch to it, and record a tree
      // hash against a review that passed on an entirely different tree. D-40 says a
      // review is pinned to the snapshot it began with; this is that guarantee being
      // quietly voided by a call nobody thought to refuse.
      if (isTerminal(review.state)) {
        throw new Error(
          `review ${review_id} is '${review.state}' and takes no more submissions. Its base is gone and cannot ` +
            `be recreated — a new worktree would be cut from origin as lore now sees it, which is not the tree ` +
            `this review looked at. Start a fresh review for further work on this branch.`,
        );
      }

      // The worktree is resolved FIRST so the only `await` before the check is
      // behind us; the check and the write then sit together with nothing to yield
      // between them.
      const worktree = await deps.worktreeFor(review_id);

      // A PUSHED COMMIT IS NORMALISED TO A DIFF, ONCE, HERE (D-124).
      //
      // Every path below — the mid-round hold, the tree-hash check, `filesInDiff` for the
      // fix-elsewhere notice — already works on a diff, so a second shape threaded through
      // three call sites would be three chances for the two to diverge. `treeDelta` from
      // the worktree's current tree to the commit's is exactly the patch that turns one
      // into the other, deletions included, so the rest of this handler cannot tell the
      // difference and does not need to.
      //
      // WHY IT EXISTS: a review's tree is the pinned base plus every patch already
      // applied, and that tree lives only inside lore. A session that did not make the
      // earlier submissions cannot check it out, cannot diff against it, and cannot
      // compute a matching hash — so a review that has taken ONE submit was unanswerable
      // by every later session, and the only exit was `restart`, which re-pays the cheap
      // tiers and discards every ratified justification. Measured on this deployment: 16
      // reviews passed out of 128, against 58 failed, 28 cancelled and 18 expired, with
      // one branch reviewed thirteen times.
      //
      // A COMMIT LORE CANNOT SEE IS REFUSED ONLY AFTER A REAL REFRESH FAILS TO FIND IT
      // (D-100's pattern, applied here — found by lore's own t1, 2026-08-20).
      //
      // This used to refresh AFTER the check, which reads as refresh-then-check but ran
      // check-then-refresh: a commit pushed moments before this call was refused, told to
      // "push and call again", and every immediate retry hit the same stale mirror — for
      // as long as the host's fetch timer takes — since nothing between the refusal and
      // the retry ever refreshed anything. The doc text this shipped with said "lore syncs
      // with origin and works out the delta itself", which was true of the diff computed
      // AFTER resolution and false of the resolution itself.
      // ONE SUBMIT AT A TIME FOR THIS REVIEW, from here through the hold decision —
      // see `withSubmitLock`'s own docblock, fingerprint 015cd8d0. `patch` is decided
      // inside the lock and returned out through the discriminated result below rather
      // than left as an outer `let` a nested callback mutates by closure: TypeScript
      // does not narrow a `let` across an `await` boundary reliably, and the
      // "unreachable" check a few lines down needs `patch` provably defined on the way
      // out — a discriminated union gives it that for free.
      const submitted = await withSubmitLock(
        review_id,
        async (): Promise<
          // `patch` on BOTH variants (D-133): it is fully resolved — commit normalized
          // to a diff — before the held/applied fork below, so `fixed_elsewhere`'s own
          // filesInDiff check runs INSIDE this callback, once, regardless of which
          // branch is taken, instead of duplicating commit-resolution to get it.
          //
          // `fixedElsewhereSkipped` travels out through this return rather than an
          // outer `let` a nested callback mutates by closure — this file's own
          // established reason (see `patch` above): TypeScript does not narrow a
          // `let` mutated inside an `await` boundary reliably.
          | { readonly kind: "held"; readonly patch: string; readonly fixedElsewhereSkipped: readonly string[] }
          | {
              readonly kind: "applied";
              readonly patch: string;
              readonly appliedTreeHash: string;
              readonly fixedElsewhereSkipped: readonly string[];
            }
        > => {
          let patch = diff;
          if (commit !== undefined) {
            // RESOLVED TO A SHA BEFORE IT REACHES GIT'S ARGV, and this is not tidiness.
            //
            // A client-supplied string went verbatim into `git diff <tree> <commit>`, and git
            // parses an argument beginning with `-` as an OPTION rather than a ref. So
            // a `--output=` pointed at the service's own database file made git write the diff
            // straight over it — an arbitrary-file-write primitive handed to every token holder,
            // from a review tool call, against the knowledge base that IS the product. (The
            // path is not spelled here: `one-definition.test.ts` refuses a hand-built database
            // path anywhere in the source, and it is right to refuse one in prose too.) It also breaks
            // D-61 outright: git must never be aimed outside the directory it was given.
            //
            // `rev-parse --verify --quiet <ref>^{commit}` is the pattern `addWorktree` already
            // uses for a client-supplied branch, and it answers both questions at once: an
            // option is not a commit-ish, so it resolves to nothing and is refused by name;
            // anything that does resolve comes back as a 40-character sha, which cannot be an
            // option whatever the caller wrote. Everything downstream sees only that sha.
            let resolved = await revParse(worktree, commit);
            // MISSING → REFRESH → RE-RESOLVE, never the other order. Gated on `fetched` so a
            // refresh that did not actually run (host busy, no daemon) does not spend a second
            // git call re-asking a question that cannot have a new answer.
            let refreshed: RefreshOutcome | undefined;
            if (resolved === undefined) {
              refreshed = await requestMirrorRefresh(dataDir()).catch(() => undefined);
              if (refreshed?.fetched === true) resolved = await revParse(worktree, commit);
            }
            if (resolved === undefined) {
              // NOT FETCHED IS NOT THE SAME CLAIM AS FETCHED-AND-STILL-ABSENT (D-100's
              // pattern, `addWorktree`). Collapsing them into one sentence told a caller
              // whose refresh never ran — daemon down, host busy — the same "it is
              // genuinely not there" story as a caller whose refresh ran clean and found
              // nothing; the first case means lore's view of origin may simply be stale,
              // which `refreshed.why` says and this message used to discard.
              //
              // AND `fetched: true` IS ITSELF NOT "SUCCEEDED" — found by lore's own t2 against
              // this exact fix. `mirror-refresh.sh`'s `serve_requests` deletes the request (the
              // only signal `fetched` reads) once `one_pass` RETURNS, whatever it returned: a
              // per-repo fetch failure inside that pass — network down, an expired credential —
              // is logged to `mirror.log` and nowhere else, discarded rather than threaded back
              // through the file-based protocol. `RefreshOutcome` has no third state to carry
              // it (TODO.md: needs the daemon to report per-repo, not per-pass). So `fetched:
              // true` here means "a pass completed", not "this repository's fetch succeeded" —
              // shared with `addWorktree`'s identical claim, softened there too, same commit.
              throw new Error(
                `lore cannot see commit ${commit} for ${review_id}. ` +
                  (refreshed?.fetched === true
                    ? "lore's mirror daemon completed a sync pass since asking. Most likely the string is not a real " +
                      "commit-ish, or was not pushed to this repository — but a single repository's fetch CAN fail " +
                      "inside a completed pass without lore seeing it (the daemon does not yet report per-repo results), " +
                      "so if you are confident this was pushed here, check `mirror.log` on the lore host before assuming " +
                      "the commit is wrong."
                    : `lore could not confirm a fresh sync first (${refreshed?.why ?? "no sync was attempted"}), so its ` +
                      "view of origin may be behind — report that rather than assuming the commit is wrong.") +
                  " (If that string was not meant as a commit, it is refused for that reason too: only a commit-ish is " +
                  "accepted here.)",
              );
            }
            // THE CLIENT'S OWN CLAIM, CHECKED AGAINST WHAT LORE CAN COMPUTE DIRECTLY —
            // found by lore's own review, fingerprint 109d9211. Unlike the raw-diff form,
            // the commit form does not actually NEED `tree_hash` to know what applying it
            // produces — `resolved`'s own tree already says so — so there is no reason to
            // accept an unverified claim the way the raw-diff form has to. A wrong
            // `tree_hash` (a typo, still the right hex length) used to be accepted as a
            // HELD row regardless, inevitably fail its verification at consume time —
            // minutes or hours later — and drop the WHOLE tail of the chain with it
            // (`consumeHeldDiffs`, review.ts, `clearHeldDiff` with no id there, BY DESIGN:
            // a mid-chain failure genuinely cannot trust anything queued after it). Refused
            // HERE instead, synchronously, naming the real reason, before a single row is
            // ever held.
            //
            // lore-ok[9d613649]: this check's timing contradicted every text that
            // described when tree_hash is checked — fixed now, not here: the schema's own
            // `.describe()` above splits `diff` (verified after applying) from `commit`
            // (this check, synchronous), and TOOL_DOCS.submit and spec/mcp-api.md SS4.1
            // both say the same split in prose.
            const claimedTree = await resolveTree(worktree, resolved);
            if (claimedTree !== tree_hash) {
              throw new Error(
                `tree_hash mismatch: you sent ${tree_hash}, but commit ${commit}'s own tree is ` +
                  `${claimedTree ?? "unresolvable, which should not be reachable here"}. The commit form verifies ` +
                  "against the commit's own tree rather than trusting the one you send — send that, or check " +
                  "what you meant to submit.",
              );
            }
            // THE STORED TREE, NOT A FRESH SNAPSHOT — raised by lore's own t2 at high, and the
            // fix is not a lock, it is not needing one.
            //
            // `treeHash(worktree)` is `git add -A` followed by `write-tree`: it MUTATES the
            // index, taking the same lock a round's own periodic re-hashing takes on this
            // shared worktree (`withHoldLock` in `runRound`, D-107, D-109). Calling it HERE,
            // before the pending-round check below has run, raced that lock — and when the
            // round's own hash lost, it threw something that was not a route fault, so the
            // tier's catch rethrew it and the WHOLE REVIEW failed. A submit that merely asked
            // "what changed" was able to kill a round it never touched.
            //
            // `review.treeHash` is the review's OWN record of what its worktree currently
            // represents, written back on every prior submit and round boundary — the same
            // value D-40's pin discipline already treats as authoritative. Reading it is a
            // SQLite query, not a filesystem write, so it cannot collide with anything the
            // round is doing. `treeDelta` itself was never the hazard: `git diff <tree>
            // <tree>` reads two committed objects and touches no index at all.
            //
            // Falls back to a live snapshot only when no tree has been recorded yet, which a
            // review reaching `review_submit` should not be able to reach — `findings exist`
            // is the tool's own precondition, and findings imply a completed round, which
            // always writes this field. Guarded by the pending-round check that already exists
            // below, so the rare fallback carries no less safety than the normal diff path did.
            //
            // THE HELD CHAIN'S OWN HEAD, FIRST — found live, not by a tier, when a second
            // commit-form submit silently never landed. `heldDiffs`' own docblock states the
            // assumption this violated: "each was built by the client on top of the one
            // before" — true for the `diff` form, where the CLIENT computes each successive
            // patch against their own prior one. False for this, the `commit` form (D-124):
            // LORE computes the patch, from `review.treeHash` alone, which `holdDiff`
            // deliberately does NOT advance ("NO BOUNDS RESET HERE" — a round applies it once,
            // at its own boundary). A second commit-form submit arriving while the first is
            // still held was therefore built from the SAME base as the first, not from what
            // the first's own hold claims it will produce — so applying both in sequence
            // (`consumeHeldDiffs`) landed the second on a tree it never diffed against, failed
            // its hash check, and the whole held chain was dropped: `awaiting_diff`, with the
            // review parked at whichever commit-form submit landed FIRST, silently discarding
            // every one after it. Observed directly: a round-9 fix held, a round-10 fix
            // submitted minutes later while it was still held, and round 10 never landed —
            // `awaiting_diff` an hour later with no diagnosis anywhere in the response.
            const heldChain = store.heldDiffs(review_id);
            const heldHead = heldChain[heldChain.length - 1];
            // A RAW-DIFF HOLD'S TREE IS A CLIENT CLAIM, NOT YET AN OBJECT — found by
            // lore's own review, fingerprint 2889d85b, reading the fix above. The raw
            // `diff` form's `tree_hash` is the CALLER's own local `git write-tree`, never
            // pushed anywhere lore can see (the schema says so: for `diff`, it is
            // verified only after applying) — so using it as `at` here would send
            // `treeDelta` an object that does not exist in this repository, and `git
            // diff` dies "fatal: bad object" rather than the ordinary "commit not found"
            // the ERROR MESSAGE below is written for. Refused by name instead: a
            // commit-form submit genuinely cannot compute a safe delta until the round
            // ahead of it actually applies that raw diff and `review.treeHash` catches up
            // to reflect it for real.
            //
            // lore-ok[8f68d435]: this refusal existed before this round and had no
            // matching client text — fixed now, not here: TOOL_DOCS.submit's "ONE
            // EXCEPTION" paragraph, both workflow-loop copies' step 4, spec/mcp-api.md
            // SS4.1's "cannot chain onto an outstanding diff hold" paragraph, and
            // SPEC.md's new bullet beside "Held diffs chain deterministically" all state
            // it now.
            if (heldHead !== undefined && (await resolveTree(worktree, heldHead.treeHash)) === undefined) {
              throw new Error(
                `${review_id} has a HELD raw diff whose claimed tree lore has never fetched — that tree only ` +
                  "becomes a real object once the round ahead of this submit actually applies it, which has not " +
                  "happened yet. A commit-form submit cannot safely compute a delta against an unverified claim. " +
                  "Poll until that hold is consumed (the review leaves 'held' — findings or a state change " +
                  "arrives), then send this commit again; review.treeHash will then reflect the applied result " +
                  "and the delta will resolve correctly. If you are the same session that submitted the raw diff " +
                  "and already know the tree it targets, you can also send this fix as a raw `diff` built on that.",
              );
            }
            // `mine(review_id)` AGAIN, not the outer `review` this handler captured before
            // ever reaching the lock. Caught by this fix's own concurrent-submit test: two
            // overlapping commit-form submits with nothing held both call `mine` at the
            // very top of the handler, before either has its own lock turn — so the OUTER
            // `review.treeHash` is a snapshot from BEFORE either submit applied anything,
            // and the second one through the lock would still compute its delta from that
            // stale value even though the first one's own apply, moments earlier in the
            // SAME lock, already moved the real tree forward. `heldHead` above has no such
            // problem — `store.heldDiffs` is read fresh, right here — this fallback needed
            // the identical freshness for the case nothing is held at all.
            const at =
              heldHead?.treeHash ??
              mine(review_id).treeHash ??
              (store.hasPendingRound(review_id)
                ? undefined
                : await treeHash(worktree));
            if (at === undefined) {
              throw new Error(
                `${review_id} has no recorded tree yet and a round is currently reading its worktree, so the ` +
                  "commit form cannot compute a delta safely right now. Poll and try again once the round parks, " +
                  "or send `diff` instead.",
              );
            }
            patch = await treeDelta(worktree, at, resolved).catch((e: unknown) => {
              throw new Error(
                `lore cannot see commit ${commit} for ${review_id}: ${e instanceof Error ? e.message : String(e)}. ` +
                  "Push it to origin and call again — lore reviews what origin has, never a working copy.",
              );
            });
            // AN EMPTY DELTA IS NOT A SUBMIT. The worktree already IS that tree, so there is
            // nothing to review and the hash check below would pass trivially — a call that
            // looked like work and did none, which is the shape D-114's bounds reset was
            // abused by. Said plainly instead.
            if (patch.trim() === "") {
              throw new Error(
                `commit ${commit} is the tree this review already has, so there is nothing to submit. If you meant ` +
                  "to hand over new work, push it first; if you meant that you have no more to give, poll instead.",
              );
            }
          }

          // UNREACHABLE, and it says so rather than being typed away. The schema refuses a
          // call carrying neither, so arriving here is a programming error — and this project
          // does not let a scaffolded path continue quietly.
          if (patch === undefined) {
            throw new Error(
              `internal: review_submit for ${review_id} reached the apply path with neither a diff nor a commit; ` +
                "the input schema should have refused this call.",
            );
          }

          // D-133: validated here, where `patch` is finally known regardless of
          // diff/commit form, and BEFORE the held/applied fork — file-in-diff is a
          // fact about the SUBMISSION, unaffected by whether it applies now or later.
          //
          // PERSISTENCE ITSELF IS NOT DECIDED HERE — found by lore's own review,
          // fingerprint d2c5ca38: a claim recorded immediately and unconditionally
          // survives a HELD diff that later fails to verify (`consumeHeldDiffs` drops
          // a fuzzy/partial apply or a tree-hash mismatch, and everything queued
          // after it, without knowing anything about `fixed_elsewhere_claim`),
          // leaving a claim with nothing behind it — exactly what the file-in-diff
          // check below exists to refuse. So the validated claims travel WITH the
          // held diff (`holdDiff`'s own new parameter) and are written to
          // `fixed_elsewhere_claim` only once `consumeHeldDiffs` confirms that
          // SPECIFIC diff actually landed; on the applied path the diff is already
          // verified by the time this callback returns, so recording immediately,
          // right before that return, is safe.
          //
          // "Already settled" is checked here too, best-effort — it is NOT
          // authoritative for a diff that ends up held, since the in-flight round
          // that made this one wait can itself settle findings before the hold is
          // ever consumed. That is fine: `collectFixedElsewhere` re-filters against
          // `store.openFindings` at the point it actually rules, regardless of what
          // was true here, so this check exists only to give the client an early,
          // honest-effort signal, not to gate correctness.
          const fixedElsewhereSkipped: string[] = [];
          const validatedFixedElsewhere: { fingerprint: string; file: string; line: number | undefined; reason: string }[] =
            [];
          if (fixed_elsewhere !== undefined && fixed_elsewhere.length > 0) {
            // `filesTouchedByDiff`, NOT `filesInDiff` — found by lore's own review,
            // fingerprint 23c8b393: `filesInDiff` deliberately excludes a deletion
            // (no marker left to scan in a file that no longer exists), but a
            // `fixed_elsewhere` claim naming a file the fix DELETED is often the
            // strongest evidence there is ("I removed the whole buggy module"), and
            // was refused here as "not part of this submission" — wrong, and the
            // refusal's own suggested fallback (a lore-ok at the original line) can
            // be equally impossible when that line is what got deleted.
            const filesTouched = new Set(filesTouchedByDiff(patch));
            const stillOpen = new Set(store.openFindings(review_id).map((f) => f.fingerprint));
            for (const entry of fixed_elsewhere) {
              let fp: string | undefined;
              try {
                fp = store.resolveShort(review_id, entry.fingerprint);
              } catch (e) {
                // A SHORT PREFIX SHARED BY TWO FINDINGS is a real, if rare, third
                // outcome `resolveShort` has always had (spec/review-ladder.md
                // §3.1.2) — found by lore's own review, fingerprint cf48ccb1: this
                // loop checked only `fp === undefined` and left the throw to escape
                // uncaught, an unenumerated case none of the surrounding text (this
                // schema's own `.describe()`, TOOL_DOCS.submit, spec/mcp-api.md
                // §4.2) says anything about, for a client that used exactly the id
                // review_poll gave it.
                if (e instanceof AmbiguousFingerprint) {
                  throw new Error(
                    `fixed_elsewhere's fingerprint ${entry.fingerprint} is ambiguous: ${String(e.matches.length)} ` +
                      `findings share this prefix (${e.matches.join(", ")}). Use more of the fingerprint from ` +
                      "review_poll to name exactly one.",
                  );
                }
                throw e;
              }
              if (fp === undefined) {
                throw new Error(
                  `fixed_elsewhere names fingerprint ${entry.fingerprint}, which this review has never raised. ` +
                    "Use the fingerprint review_poll gave you, not one remembered or guessed.",
                );
              }
              if (!filesTouched.has(entry.file)) {
                throw new Error(
                  `fixed_elsewhere for ${entry.fingerprint} names ${entry.file}, which is not part of this ` +
                    "submission. A tier's silence over a file it was never shown is not evidence of anything -- " +
                    "include the fix in this same diff/commit, or leave a lore-ok at the finding's own line instead.",
                );
              }
              if (!stillOpen.has(fp)) {
                fixedElsewhereSkipped.push(entry.fingerprint);
                continue;
              }
              validatedFixedElsewhere.push({ fingerprint: fp, file: entry.file, line: entry.line, reason: entry.reason });
            }
          }

          // REFUSED while a round is pending, because the next line writes into the
          // directory that round reads (D-55).
          //
          // D-53 stopped two rounds running at once. It did not stop a writer from
          // OUTSIDE the queue, and this is one: a tier computes its diff, starts
          // exploring, and a submit rewrites the files under it. Its prompt and its
          // tier_run row describe the old tree while its tools read a new or
          // half-patched one, and a `clean` from that describes a tree that has never
          // existed anywhere — which is the failure the tree-hash check below exists to
          // prevent, arriving from the other side (D-40).
          //
          // Refusing rather than queueing the patch: the client already polls (D-34),
          // the fix genuinely cannot be reviewed until the current round is done, and
          // storing pending patches would add a second place where a review's tree
          // lives. The error says what to wait for.
          // The wait condition is stated POSITIVELY, as the states that accept a diff.
          //
          // Naming the states to wait past instead — "until it is not running or queued"
          // — described the JOB while the client can only see the REVIEW, and the two
          // disagree exactly where it matters: during `fast_clean` the deep round is
          // already queued, so the submit is refused while the client's exit condition
          // reads as met. It would poll, see `fast_clean`, submit, and be refused again,
          // for ever, with no state named that it could actually wait for.
          //
          // lore-ok[d3021c5e]: correct, and deliberately not closed by this commit. The
          // ticket asked for a submit at any time, fully async; this refusal is D-55 and it
          // is half the ask. What it needs is D-80's conversation half — the diff applied
          // at once and handed to the live session as its next message — which SPEC D-80 §6
          // marks `[OPEN]` on two questions that must be answered first: whether a long
          // conversation beats repeated cold rounds on COST, measured rather than argued
          // (a session re-sends its accumulated context every turn, D-50, against a 97-99%
          // cache hit on cold rounds), and how the deep tiers enter a conversation the
          // cheap tier has been having. Both change which models are called and how much
          // quota burns, which is the operator's decision, not a reviewer's or mine.
          // The prerequisite landed today — D-6 revised, so a submit no longer resets the
          // ladder, which is what made an interactive submit incoherent. This is the next
          // commit, not a patch to one already ten rounds deep.
          // HELD, NOT REFUSED (D-107). A reviewer is reading — or about to read — the tree
          // this patch would rewrite, so the diff cannot land NOW; but making the client
          // wait, poll and resubmit was the part IT paid for. The diff waits in the store
          // and lands at the reviewer's next emission boundary, hash-verified there; a
          // mismatch at that point surfaces on poll as awaiting_diff, never as a silently
          // dropped diff. The double-check below closes the race where the round finished
          // between the check and the hold — then nothing would ever consume it.
          // lore-ok[109d9211]: fixed upstream for the COMMIT form only, not here and
          // not for `diff`. When `commit !== undefined`, the synchronous check right
          // after `resolved` is confirmed (search this file for "tree_hash mismatch")
          // already refused a wrong claim before a round could even be pending, so a
          // commit-form `tree_hash` reaching this call has been checked against
          // `resolved`'s own tree. A raw `diff` submit reaches this SAME call with no
          // such check — its `tree_hash` is the caller's own local `git write-tree`,
          // unverifiable without applying it, and D-107 accepts that claim on trust by
          // design. Found by lore's own review, fingerprint b39f4f4a: the comment this
          // replaced said "whatever holdDiff stores here", which read as both forms
          // pre-verified.
          if (store.hasPendingRound(review_id)) {
            const heldId = store.holdDiff(review_id, patch, tree_hash, validatedFixedElsewhere);
            if (store.hasPendingRound(review_id)) {
              return { kind: "held", patch, fixedElsewhereSkipped };
            }
            // The round ended in the race window: nothing will consume the hold, so take it
            // back and fall through to the synchronous path below.
            //
            // BY ID, not the bare form that clears every row this review has. A concurrent
            // submit can land its OWN hold in this exact window — the check above only says
            // whether a round is pending, not whether another caller is here too — and the
            // bare form would discard that hold as well, silently, the same loss this whole
            // file exists to refuse.
            store.clearHeldDiff(review_id, heldId);
          }

          // ONE MUTATION AT A TIME TOO, not only the hold decision — found by lore's own
          // review, fingerprint 13339892. The lock used to end at the hold decision above,
          // and everything from here on ran UNLOCKED: two overlapping submits that both
          // found no round pending (the ORDINARY `findings_ready` window, not the rarer
          // held one) could both apply and verify against the SAME shared worktree
          // concurrently — a losing submit's own `restoreTree` could rewind the worktree
          // PAST a winning submit's already-applied and already-RECORDED result, leaving
          // `review.treeHash` naming a tree the worktree no longer holds, silently. Moved
          // inside the same lock: whichever submit actually reaches this second, its own
          // `before` (read fresh, right here, never carried from before the lock) already
          // reflects the first one's write, so the existing hash-mismatch-and-restore
          // logic below — unchanged — does its job honestly instead of being raced.

          // Recorded BEFORE the patch, because the refusal below has to be able to undo it.
          const before = await treeHash(worktree);
          // lore-ok[8c09e43a]: found by lore's own review, the direct consequence of giving
          // applyPatch a timeout (`lore-ok[40f980fe]`) — a killed mid-write used to be
          // unreachable (a hang, not a throw), so a bare `await` here never needed to restore
          // anything on failure: every OTHER applyPatch throw genuinely leaves the worktree
          // untouched. A timeout kill does not — its own message says so explicitly — so this
          // path now needs the identical restore-on-catch consumeHeldDiffs already has
          // (review.ts:236-249) rather than leaving a partial apply sitting in the worktree
          // for the next round's computeDiff (INV-3) to read as ratified work.
          try {
            await applyPatch(worktree, patch);
          } catch (e) {
            await restoreTree(worktree, before).catch((e2: unknown) => {
              console.error(
                `[lore:log] could not restore ${review_id}'s worktree after a failed apply — ` +
                  `it is left at a tree nobody has seen: ${e2 instanceof Error ? e2.message : String(e2)}`,
              );
            });
            throw e;
          }

          const applied = await treeHash(worktree);
          if (applied !== tree_hash) {
            // Without this check a fuzzy or partial apply leaves us reviewing a tree
            // that exists nowhere — not in git, not on the client's disk — and
            // reporting on it with full confidence (D-40).
            //
            // AND THE WORKTREE IS PUT BACK. It used to be left with the patch applied while
            // the client was told "Nothing was reviewed" — true of the review and false of
            // the worktree — so the re-send it was asked for landed on top of the partial
            // apply, against a base that had silently moved. "Nothing was applied" is now a
            // statement about the tree rather than a hope.
            await restoreTree(worktree, before).catch((e: unknown) => {
              // Loud, and the error says so: a worktree we could not restore is a base
              // nobody can reason about, and the next submit would be reviewed against it.
              console.error(
                `[lore:log] could not restore ${review_id}'s worktree after a rejected patch — ` +
                  `it is left at a tree nobody has seen: ${e instanceof Error ? e.message : String(e)}`,
              );
            });
            throw new Error(
              `tree hash mismatch after applying: you sent ${tree_hash}, the patch produced ${applied}. ` +
                `Nothing was applied — the worktree is back at the tree it started this call with — and nothing ` +
                `was reviewed. Re-send the full diff for the tree you actually have.`,
            );
          }

          // NEW WORK, so the round bounds start counting again (D-114) — BUT ONLY IF THE TREE
          // ACTUALLY MOVED.
          //
          // Resetting on any verified submit is an unbounded loop, and a loop a compliant
          // client walks into: `applyPatch` no-ops on an empty diff, the tree hash still
          // verifies, and lore's own texts tell a client with nothing to change to submit an
          // empty diff. Each such nudge used to wipe the counters, advance the floor, move
          // `updated_at` past the stale sweep's reach, and enqueue a full round — t0 plus a
          // model tier, on the shared subscriptions, for ever. Before D-114 the global bound
          // stopped that at twelve; D-114 removed the backstop without replacing it.
          //
          // `applied !== before` is the same test `pull_fresh` already makes before it counts
          // origin as having moved. A submit that changes nothing is a client saying "I have
          // no more to give", which is exactly when the bounds should keep counting.
          // lore-ok[8bcf23f5]: the correction is right and the gate stays. The empty-diff
          // path really is unreachable — the schema is `diff.min(1)` and `git apply` exits
          // non-zero with no valid patches — and the residual it names, `holdDiff` resetting
          // the bounds before verification, is gone because `holdDiff` no longer writes the
          // ladder at all. The tree-moved test is kept regardless: it is the correct rule for
          // "did the client give me new material", and keeping it does not depend on which
          // of the two routes to a no-op submit happens to be open today.
          if (applied !== before) store.noteClientWork(review_id);
          store.updateReview(review_id, { state: "queued", treeHash: applied });
          deps.enqueue(review_id, "fast");

          // Safe to record NOW, unconditionally: this path is reached only once the
          // apply above is already verified against `tree_hash` — there is no later
          // failure that could still discard the diff these claims are evidence for.
          for (const c of validatedFixedElsewhere) store.recordFixedElsewhere(review_id, c.fingerprint, c.file, c.line, c.reason);

          return {
            kind: "applied",
            patch,
            appliedTreeHash: applied,
            fixedElsewhereSkipped,
          };
        },
      );

      if (submitted.kind === "held") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                review_id,
                status: "held",
                note:
                  "A reviewer is mid-read, so your diff is HELD and will be applied and put to it at its " +
                  "next emission — you do not need to resubmit. Keep polling: the reviewer's ruling on this " +
                  "fix arrives as ordinary findings (fixed things are not re-raised; still-broken things " +
                  "return at higher severity). Findings it reports before seeing your fix may already be " +
                  "fixed by it — expected, do not double-fix. If the tree hash cannot be verified when it " +
                  "is applied, the review lands in awaiting_diff with the reason.",
                ...(submitted.fixedElsewhereSkipped.length === 0
                  ? {}
                  : { fixed_elsewhere_skipped: submitted.fixedElsewhereSkipped }),
              }),
            },
          ],
        };
      }
      const { patch, appliedTreeHash: applied, fixedElsewhereSkipped } = submitted;

      // WHAT THIS DIFF CANNOT SETTLE, said now rather than in twenty minutes.
      //
      // D-56 settles a finding only when the tier stops raising it AND the code it named
      // has moved, because silence over untouched code is a tier changing its mind, not a
      // fix. That is deterministic and costs a file read — and it was being answered a
      // ROUND later, so a client learned which of its answers had not landed after ten
      // to twenty-five minutes of deep-tier time. Measured on this repository: three
      // fixes submitted, two of them made in a COLLABORATOR rather than at the named
      // line, both sat open for a further round, which is one t2 round bought to learn
      // something knowable the instant the patch applied.
      //
      // "Fix it where the cause is" is an ordinary and often correct shape, so every
      // client meets this repeatedly. The answer is not to weaken D-56 — it is right —
      // but to say at the moment it is actionable that a justification at the site is
      // what settles a fix made elsewhere.
      //
      // It shares `codeMoved` with the settle path rather than restating the rule: a
      // preview that drifts from what it previews is worse than no preview.
      //
      // AND NOT THE ONES ALREADY ANSWERED. The advice this note gives is "say so at the
      // named line with a lore-ok and submit again" — and it was given to findings whose
      // named line carried one, sent in that very diff. A warning that fires on the
      // correct answer is a warning clients learn to skip, and this is the only one that
      // saves them a deep-tier round.
      // ADVISORY MEANS IT CAN NEVER BREAK THE REPLY. `resolveShort` throws on an
      // ambiguous 8-hex prefix, and this runs AFTER the patch is applied, the review is
      // queued and the job is enqueued — so a throw here reported a failed submit for a
      // mutation that had already committed, and a client doing the obvious thing would
      // resend it. A preview whose failure looks like the operation's failure is worse
      // than no preview.
      //
      // Not swallowed either: an omitted `will_not_settle` reads as "nothing will fail to
      // settle", which is the opposite of "I could not tell".
      let unmoved: RecordedFinding[] | undefined;
      try {
        // ANY CLAIM ON RECORD, not only this call's own — found by lore's own review,
        // fingerprint a5bc9f62. A HELD submission's fixed_elsewhere claims are not
        // promoted into this table until `consumeHeldDiffs` confirms that diff landed
        // (D-133, above), which happens MID-ROUND, after that round's own `pending`
        // was already collected (`review.ts`: pending is built near the top of
        // `runRound`, `consumeHeldDiffs` runs much later, at an emission boundary) —
        // so a claim promoted that way sits unruled until the NEXT round. If this
        // preview only excluded fingerprints THIS call just claimed, that finding
        // still showed up here as "cannot settle however it goes", even though the
        // round this very submit enqueues will collect the stored claim and rule on
        // it. `fixedElsewhereFor` has no settled/unsettled distinction of its own
        // (its own doc comment says so), which is exactly right here too: an OPEN
        // finding (the only kind this loop sees) with any claim on file has one
        // still waiting to be ruled on, whichever round recorded it.
        const claimed = new Set(store.fixedElsewhereFor(review_id).map((c) => c.fingerprint));
        unmoved = (
          await Promise.all(
            store.openFindings(review_id).map(async (f) => {
              if (claimed.has(f.fingerprint)) return undefined;
              if (await codeMoved(worktree, f)) return undefined;
              // EVERY FILE THE DIFF TOUCHED, not just the finding's own. The round reads
              // markers from every changed file, so a `lore-ok` written where the fix
              // was made — which the note itself calls "often the right place" — settles
              // in the round and was invisible here, leaving the preview nagging about a
              // finding that was already answered.
              const answered = await alreadyAnswered(
                worktree,
                review_id,
                (r, sh) => store.resolveShort(r, sh),
                f,
                filesInDiff(patch),
              );
              return answered ? undefined : f;
            }),
          )
        ).filter((f) => f !== undefined);
      } catch (e) {
        console.error(`[lore:log] will_not_settle preview could not run: ${e instanceof Error ? e.message : ""}`);
      }

      return text(
        JSON.stringify({
          review_id,
          state: "queued",
          tree_hash: applied,
          ...(fixedElsewhereSkipped.length === 0 ? {} : { fixed_elsewhere_skipped: fixedElsewhereSkipped }),
          ...(unmoved === undefined
            ? {
                will_not_settle_note:
                  "The submit SUCCEEDED. The preview of what the next round cannot settle could not be " +
                  "computed — usually an ambiguous `lore-ok[...]` prefix matching two findings — so this " +
                  "reply says nothing either way about them. Do not read its absence as 'everything will " +
                  "settle'.",
              }
            : unmoved.length === 0
            ? {}
            : {
                // THE FINGERPRINT, because the note below tells the client to write
                // `lore-ok[<fingerprint>]` and this list was the only place it could have
                // come from. Without it the instruction is unfollowable: a poll returns
                // only NEW findings, so the ids named here are precisely the ones the
                // client will never be shown again. Driving this loop by hand, the only
                // way to recover them was a SQL query inside the container — which no
                // client can do, on a machine it is not on. `justify_with` carries the
                // whole line ready to paste, for the same reason `review_poll` does.
                will_not_settle: unmoved.map((f) => ({
                  // THE SHORT FORM, because that is what `lore-ok[...]` accepts — the
                  // parser requires exactly 8 hex before `]`, and `review_poll`'s field
                  // of the same name is already the short one. Handing back the full
                  // 64-char hash beside an instruction to paste it produced a marker
                  // that is silently never read: the exact unfollowable instruction
                  // D-111 fixed, re-created by the field added to fix it.
                  fingerprint: f.fingerprint.slice(0, 8),
                  file: f.file,
                  line: f.line,
                  claim: f.claim,
                  justify_with: `// lore-ok[${f.fingerprint.slice(0, 8)}]: <why this code is correct, or where it was fixed>`,
                })),
                will_not_settle_note:
                  `${String(unmoved.length)} open finding(s) name code that has NOT moved and carry no lore-ok or ` +
                  "fixed_elsewhere claim, so the next round CANNOT settle them however it goes: a tier that stops " +
                  "raising something it never saw move has changed its mind, not been satisfied. If you fixed the " +
                  "cause somewhere else — which is often the right place — say so: pass `fixed_elsewhere` " +
                  "(fingerprint, file, reason) on your next submit, or leave a `lore-ok[<fingerprint>]: <why>` " +
                  "comment AT THE NAMED LINE instead. Either settles it by silence. Otherwise they will come back, " +
                  "and each round costs you the deep tier's full time.",
              }),
        }),
      );
    },
  );

  // ----------------------------------------------------------- review.attest

  // ----------------------------------------------------------- review.cancel

  server.registerTool(
    "review_cancel",
    {
      description: TOOL_DOCS.cancel,
      inputSchema: z.object({
        review_id: z.string().min(1),
        reason: absent(z.string()).describe("why you are stopping — recorded, and the only account anyone gets"),
      }),
    },
    async ({ review_id, reason }) => {
      const review = mine(review_id);
      if (isTerminal(review.state)) {
        // lore-ok[5e6c18de]: was "available from review_poll AND lore://review/..." —
        // found by lore's own review. Any findings a terminal review had were already
        // marked delivered at the handover that made it terminal (cancel's own reply,
        // or the round that produced a verdict), so `review_poll` — which returns
        // only what it has not already handed the caller — legitimately answers
        // `new_findings: []` here, every time. Only the resource still has them.
        throw new Error(
          `review ${review_id} is already '${review.state}' — there is nothing to cancel. Its findings are still ` +
            "available from lore://review/" + review_id + " (not review_poll — that returns only what it has not" +
            " already handed you, and you already have all of it).",
        );
      }

      // STATE FIRST, then abort — and marking it terminal is what stops the LADDER
      // only because two other places were taught to ask.
      //
      // Neither did. `claimJob` checked that no OTHER job for the review was running
      // and never what state the review was in, so a cancelled review's queued jobs
      // were still claimed and paid for; and `runRound` read the review and proceeded
      // regardless. A first version of this comment claimed the worker already
      // checked, which was the false-statement-about-behaviour this repository is
      // worst at, written into the fix for it. Both now refuse a terminal review.
      //
      // WRITTEN DOWN, because the tool description promises exactly that — "recorded,
      // and the only account anyone gets" — and it was not. The reason went into the
      // reply and nowhere else, so two reviews cancelled by a real client on
      // 2026-08-07 read as `cancelled` with no account at all, and whatever it said
      // about why is gone. A false statement in an interface text, in the field whose
      // entire purpose is to survive.
      //
      // Before the state, so a subscriber woken by the change can already read it.

      if (reason !== undefined && reason.trim() !== "") {
        store.setFailureReason(review_id, `cancelled by ${who.principal}: ${reason.trim()}`);
      }

      // Order matters for the remaining window: state first means a round claimed in
      // the same instant finds a terminal review and stops before spending. Aborting
      // first would leave the session dead and the round still free to advance the
      // ladder on an empty answer.
      store.updateReview(review_id, { state: "cancelled" });

      // Abandoning a call does not stop the model: three t2 calls that failed
      // client-side once went on to consume ~3.7M cached-read tokens between them
      // because the agent kept exploring after lore stopped listening. So a cancel
      // that only marks a row would be worse than none — the operator would see a
      // stopped review and have no reason to suspect it was still billing.
      // THREE OUTCOMES, NOT TWO. `aborted` false used to mean "nothing was in flight",
      // and it also meant "I was never given a reviewer, so I could not look" — which is
      // what the deployed service actually did. `startHttp` was built with `store`,
      // `worktreeFor`, `enqueue` and `attest` and no `reviewer`, so this expression was
      // `undefined ?? false` on every cancel there has ever been, and the reply said
      // "No model call was in flight" while a screen session created 45 seconds earlier
      // went on running. Measured 2026-08-08 on rev_NYiv0xfO: `stopped_in_flight: false`,
      // opencode still holding the session, lore's gate still holding the slot.
      //
      // The wiring is fixed in `service/main.ts`. This stays because the CLI and the
      // tests legitimately build a server without one, and INV-1 applies to a cancel
      // exactly as it applies to a review: not knowing whether the spend stopped is a
      // thing to SAY, not a thing to round down to "no".
      const canAbort = deps.reviewer?.cancel !== undefined;
      const aborted = canAbort && ((await deps.reviewer?.cancel?.(review_id).catch(() => false)) ?? false);

      // AND THE SESSION-TREE RECORDS THOSE SESSIONS LEFT BEHIND (D-108). `cancel` above
      // empties the kept-session map, so the worker's reconcile — which sweeps these by
      // iterating exactly that map — can never see this review again. Cleared here, on
      // the ending that owns it, rather than left to a backstop that has already been
      // made blind to it.
      store.clearSessionTrees(review_id);

      // EVERYTHING RAISED SO FAR, delivered or not. A cancelled review still found
      // what it found, and those findings are the only thing of value it produced;
      // dropping them because the loop stopped early would throw away the work that
      // was actually paid for. Marked delivered, because this is the handover.
      const all = store.allFindings(review_id);
      store.markDelivered(review_id, all.map((f) => f.fingerprint));

      return text(
        JSON.stringify({
          review_id,
          state: "cancelled",
          stopped_in_flight: canAbort ? aborted : null,
          findings: all.map((f) => ({
            fingerprint: f.fingerprint.slice(0, 8),
            file: f.file,
            line: f.line,
            severity: f.severity,
            claim: f.claim,
            evidence: f.evidence,
            failure_scenario: f.failureScenario,
          })),
          ...(reason === undefined ? {} : { reason }),
          note:
            `Stopped. ${all.length} finding(s) it had already produced are above and are yours to act on — ` +
            "they are real. What the remaining tiers would have found is UNKNOWN, so this is not a pass and " +
            "not evidence the branch is clean. Everything it learned about this repository is kept. " +
            (!canAbort
              ? "WHETHER A MODEL CALL IS STILL RUNNING IS UNKNOWN — this server was built without a reviewer, " +
                "so nothing here could reach a session to abort it. If one was in flight it is still exploring " +
                "and still spending. Tell an operator."
              : aborted
                ? "The model call in flight was aborted, so it has stopped spending."
                : "No model call was in flight."),
        }),
      );
    },
  );

  server.registerTool(
    "review_attest",
    { description: TOOL_DOCS.attest, inputSchema: z.object({ review_id: z.string().min(1) }) },
    async ({ review_id }) => {
      const review = mine(review_id);
      if (!isAttestable(review.state)) {
        throw new Error(
          `review is '${review.state}' — there is nothing to attest. ` +
          `Only 'passed' and 'passed_partial' can be attested, and only 'passed' is clean. ` +
            `An attestation for an incomplete review would be a false claim.`,
        );
      }
      return text(await deps.attest(review_id));
    },
  );

  // ------------------------------------------------------------ review.inbox

  server.registerTool(
    "review_inbox",
    { description: TOOL_DOCS.inbox, inputSchema: z.object({}) },
    async () => {
      // IT DOES NOT CONSUME, and it used to.
      //
      // `undelivered` + `markDelivered` is `review_poll`'s contract: it returns deltas
      // and takes them off the queue, which is why polling somebody else's review is
      // refused (D-78). The inbox did exactly the same thing while its own documentation
      // and `smoke.mjs` both said it consumed nothing — so a read-only health check
      // silently emptied the delta queue of every review it listed, and the owner was
      // shown nothing next time it polled.
      //
      // The inbox answers "what is waiting for me", which is a question about state, not
      // a handover. `store.undelivered` READS; only `markDelivered` hands over, and it is
      // simply not called here — so the numbers are unchanged and the client still calls
      // `review_poll` to collect, which is what every doc already tells it to do.
      // lore-ok[7b430181]: the finding is real and is fixed in `listReviews`, not here.
      // Its 50-row cap ordered by recency alone could bury a parked review behind fifty
      // freshly-finished ones, so the filter below never saw the review it exists to
      // surface — D-95's own failure, reintroduced by a LIMIT. The query orders unfinished
      // first now, so the rows the cap drops are terminal ones, which this filter would
      // have dropped anyway. Fixed there rather than here because the ordering is what
      // makes the cap safe, and a caller compensating for its query's ordering is a
      // second place to get it wrong.
      // lore-ok[c8d63c13]: found real by lore's own review — de741489 taught
      // `review_poll` to auto-resume a `needs_human` review once its blocking
      // conflict closes, but the inbox is where a client looks FIRST (see the
      // comment on `questions` below) and it kept its own copy of the old,
      // now-impossible instruction: "call review_submit on it (an empty diff is
      // fine)" — refused by review_submit's own schema (absent() maps "" to
      // undefined, and its exactly-one-of refine rejects both undefined). A client
      // that only ever calls the inbox, never polling the parked review directly,
      // had no route to the earlier fix at all.
      //
      // Resumed HERE too, before `items` is built — same reason review_poll resumes
      // before computing its response: everything below must describe the list
      // AFTER the resume, not the rows `listReviews` read a moment ago. Re-fetching
      // rather than patching `state` in place on each row also keeps `expires_at`
      // honest — `updateReview` bumps `updated_at` on every row `resumeNeedsHuman`
      // touches, and a locally-patched `state` next to a stale `updatedAt` would
      // print a deadline computed from a timestamp resuming had already moved past.
      const reviews0 = store.listReviews(who.principal, who.repoId);
      const anyNeedsHuman = reviews0.some((r) => r.state === "needs_human");
      const openConflictsNow = anyNeedsHuman ? store.openConflicts(who.repoId) : [];
      const justResumed = anyNeedsHuman && openConflictsNow.length === 0;
      if (justResumed) {
        store.resumeNeedsHuman(
          who.repoId,
          "No contradiction is open any more. The document that supplied one side of it changed (or a " +
            "person resolved it directly) and nothing else in this repository is blocking. Resumed " +
            "automatically — carry on from where the review stopped, no submit needed.",
        );
      }
      const reviews = justResumed ? store.listReviews(who.principal, who.repoId) : reviews0;
      const items = reviews.map((r) => {
        const fresh = store.undelivered(r.id);
        // Listed but not answerable by THIS token — see `boundElsewhere`.
        const elsewhere = boundElsewhere(r);
        // WHOSE MOVE IT IS, which is the question this call is for and the one it could
        // not answer. A review in `running` needs nothing from anyone; a review in
        // `findings_ready` is stopped dead and dies in 48 hours.
        const yours = fresh.length > 0 || needsClient(r.state);
        return {
          review_id: r.id,
          branch: r.branch,
          state: r.state,
          clean: isClean(r.state),
          waiting_on: yours ? "you" : "lore",
          // WHEN IT WILL BE TAKEN AWAY. "Waiting on you" is true of a review with three
          // hours left and of one with two days, and a client that cannot tell them
          // apart cannot triage. Only for reviews the sweep can still reach: a terminal
          // review is never expired, so a deadline on one would be fiction.
          // A `findings_ready` review is not TAKEN at 48h any more — it dims to
          // `findings_stale` and lives a further week (D-106); the stale clock counts
          // from the dimming. The deadline shown is the one a client can plan around:
          // the moment the review actually stops accepting an answer.
          ...(isTerminal(r.state)
            ? {}
            : {
                expires_at: new Date(
                  Date.parse(r.updatedAt) +
                    (r.state === "findings_stale"
                      ? STALE_GRACE_DAYS * 86_400_000
                      : r.state === "findings_ready"
                        ? STALE_HOURS * 3_600_000 + STALE_GRACE_DAYS * 86_400_000
                        : STALE_HOURS * 3_600_000),
                ).toISOString(),
              }),
          new_findings: fresh.length,
          // WHAT `new_findings: 0` MEANS, said here rather than left to be inferred.
          //
          // 2026-09-03: a client asked whether everything was ready, read three reviews
          // in `findings_ready` carrying `new_findings: 0`, and told its user "the
          // agents already collected them and are working the fixes — not the rot
          // state". Nothing in this reply said that or could have. It is the rot state:
          // everything was handed over and nobody came back. The client had a number
          // and no meaning, so it supplied the more comfortable of the two readings and
          // a person was told the work was in hand.
          //
          // lore cannot see sessions. A caller mid-fix and one that ended days ago
          // produce identical rows, and the ONLY fact here that separates them is how
          // long nothing has moved — so that is what is handed over, in words, at the
          // field that was misread. `TOOL_DOCS.inbox` has said "THIS IS THE STATE THAT
          // ROTS" for weeks; saying it only there is what failed.
          // NOT `needs_human`, though it is equally stopped and equally the caller's
          // move. Its move is to get a PERSON, and this note's two exits — review_submit
          // and review_cancel — are both wrong there: the inbox already answers it
          // louder, with `open_questions` carrying the question itself and a top-level
          // note saying not to answer it yourself. Two instructions competing over one
          // review is how a client picks the cheaper one.
          ...(yours && fresh.length === 0 && r.state !== "needs_human"
            ? {
                waiting_note:
                  "Everything this review found has ALREADY been handed over. `new_findings: 0` means nothing " +
                  "NEW has arrived since — it does NOT mean anybody is working on it, and lore has no way to " +
                  "know whether anyone is: it cannot see sessions. Nobody has touched this review for at " +
                  "least " + elapsedWords(quietSince(r.state, r.updatedAt)) +
                  (elsewhere
                    ? ". THIS ONE IS NOT YOURS TO ANSWER: it was started by another token of yours that is " +
                      "still live, so review_poll, review_submit, review_cancel and lore://review/" + r.id +
                      " all answer NOT FOUND for you (D-78). The session holding that token has to finish it " +
                      "— or a person revokes that token, after which it falls back to repository scope and " +
                      "you can."
                    : ". If you hold these findings, answer them with review_submit. If you do not — a " +
                      "session that collected them ended — read lore://review/" + r.id +
                      ", which returns all of them and consumes nothing; polling cannot replay them. If " +
                      "nobody is going to answer, review_cancel is the honest ending."),
              }
            : {}),
          // THE RAW FACT BEHIND THE SENTENCE ABOVE, and it is deliberately NOT
          // `updated_at`. That column is "when the row last changed", and the sweep's own
          // graying write is one of those changes — so on a `findings_stale` row it says
          // the review moved moments ago when nobody has touched it for two days.
          // `quietSince` reconstructs the client's last touch through the dim; the note
          // and this field therefore measure the same thing, which is the whole point of
          // shipping both.
          ...(isTerminal(r.state) ? {} : { quiet_since: quietSince(r.state, r.updatedAt) }),
          // This is the field a client triages on, so it is computed, not read off
          // the front of the list. It used to be `fresh[0].severity` with "high"
          // special-cased — and since the query sorted severity as text, a review
          // whose worst finding was medium reported `highest: "low"` (D-50).
          highest: worstSeverity(fresh.map((f) => f.severity)) ?? null,
          findings: fresh.map((f) => ({
            fingerprint: f.fingerprint.slice(0, 8),
            file: f.file,
            severity: f.severity,
            claim: f.claim,
          })),
        };
      });
      const needsHuman = items.filter((i) => i.state === "needs_human");
      // THE QUESTION, not the fact that there is one.
      //
      // `review_poll` was fixed to carry this and the inbox was not — and the inbox is
      // where a client looks FIRST, so "surface these to your user" arrived with
      // nothing to surface. A client said so plainly: *I can't surface a question I
      // was never given, and guessing is exactly what lore's own doctrine forbids.*
      // Being told to escalate something unnamed is worse than not being told, because
      // the only ways forward are to invent the question or to drop it.
      // lore-ok[aa57c0f2]: was capped at 1000 with no ordering — found by lore's own
      // review, same fix as the identical byId map above: resolving every open
      // conflict's id needs every live row, not a sampled window.
      const byId = new Map(store.knowledgeFor(who.repoId, undefined, NO_LIMIT).map((k) => [k.id, k]));
      // Reuses `openConflictsNow` rather than querying again: any `needsHuman` review
      // left in `items` survived the resume above, which only happens when at least
      // one conflict was genuinely still open — the same list this maps over.
      const questions = needsHuman.length === 0
        ? []
        : openConflictsNow.map((c) => ({
            left: { id: c.left, statement: byId.get(c.left)?.statement ?? "(retired)", source: byId.get(c.left)?.provenance },
            right: { id: c.right, statement: byId.get(c.right)?.statement ?? "(retired)", source: byId.get(c.right)?.provenance },
          }));

      return text(
        JSON.stringify({
          // EVERY OPEN REVIEW, not only the ones with something fresh to collect.
          //
          // The filter used to be `new_findings > 0 || needs_human`, which hid the exact
          // review this call's own documentation is about: one in `findings_ready` whose
          // findings were collected by a session that then ended mid-fix. Measured on
          // lore's own repository — rev_uFMG9 sat there for two days, invisible to the
          // inbox, holding a pinned worktree, and would have been swept as `expired`
          // having concluded nothing. `review_poll` had consumed the deltas, so the one
          // call whose stated job is "what is waiting for me" answered with nothing.
          //
          // Terminal reviews still appear WHILE they hold undelivered findings, because
          // a cancelled review hands its findings over and they are real; they drop out
          // once collected, which is correct — there is nothing left to come back to.
          reviews: items.filter((i) => i.new_findings > 0 || !isTerminal(i.state)),
          // THE HEADLINE COUNT, because a client asked "is everything ready" and answered
          // it from three rows it had misread one at a time. A number it cannot get wrong
          // sits above the rows: how many reviews are stopped, waiting on this caller,
          // with nothing left to collect. That is the count of things that will rot.
          stalled: items.filter((i) => i.waiting_note !== undefined).length,
          needs_human: needsHuman.length,
          ...(needsHuman.length > 0 ? { open_questions: questions } : {}),
          note: [
            needsHuman.length === 0
              ? "Surface high-severity findings to your user rather than only logging them."
              : "Some reviews need a PERSON. `open_questions` IS the question — two things this repository " +
                "believes that cannot both be true. Take both statements to your user verbatim; do not answer " +
                "them yourself. Then call knowledge_resolve with the id to keep, or knowledge_escalate.",
            // Said whenever there is one, and never implied by silence. NOTHING IS READY
            // while this is above zero, and that is the sentence a client relays to the
            // person who asked.
            ...(items.some((i) => i.waiting_note !== undefined)
              ? [
                  "`stalled` counts reviews STOPPED with nothing left to collect — read each one's " +
                    "`waiting_note`, which says whether you can answer it here. They are not in progress: " +
                    "lore cannot see whether anyone is working, so `new_findings: 0` says only that nothing " +
                    "new arrived. While `stalled` is above zero, the honest answer to \"is everything done\" " +
                    "is NO.",
                ]
              : []),
          ].join(" "),
        }),
      );
    },
  );

  // --------------------------------------------------------- knowledge.query

  server.registerTool(
    "knowledge_query",
    {
      description: TOOL_DOCS.query,
      inputSchema: z.object({
        path: absent(z.string()).describe("narrow to a file or directory prefix"),
        contains: absent(z.string()).describe("case-insensitive substring filter"),
      }),
    },
    async ({ path, contains }) => {
      // lore-ok[562d4c2e]: found real by lore's own review, same class this file
      // already fixed twice over for the conflict-id `byId` maps (lore-ok[aa57c0f2]
      // above) — the default LIMIT 200 (`verified_at DESC`) meant `count` froze once
      // a repo's live rules passed 200, and past that point the zero-match note
      // AFFIRMATIVELY told a caller "nothing matched this filter, widen it" for a
      // `contains` match that existed beyond the window and no widening could reach.
      // `knowledge_resolve`'s own refusal (below) tells a caller to "check
      // knowledge_query" for exactly this reason, so a capped answer here could send
      // a real conflict back as unresolvable. NO_LIMIT for the same reason
      // aa57c0f2 gave: resolving a question about this repo's whole knowledge needs
      // every live row, not a sampled window.
      //
      // c5e38bc8/2a540515: found real by lore's own review — the WRITE side
      // (knowledge_teach, the fix a few hundred lines down for 28941e15/7e754395)
      // normalizes and refuses an escaping `path`; this READ side passed it straight
      // to `knowledgeFor` unnormalized. `knowledgeFor`'s SQL (store.ts, `? = path OR
      // ? LIKE path || '/%'`) matches only an exact segment boundary, so a query
      // spelled "src/" (trailing slash), "./src" or an absolute "/src" — every one a
      // client composes naturally — silently missed every rule scoped to "src": not
      // an error, just a lower `count` and an empty-looking answer that reads as "no
      // knowledge here" rather than "your spelling could never match". Same fix,
      // same reason: normalize before querying, and refuse rather than silently
      // returning zero for a path that can never match anything.
      const scopedPath = path === undefined ? undefined : normalizeReviewPath(path);
      if (path !== undefined && scopedPath !== undefined && pathEscapesWorktree(path, scopedPath)) {
        throw new Error(
          `path must stay inside the repository, relative to its root — "${path}" does not. Pass a path like ` +
            '"src" or "src/payments", not an absolute one or one starting with "..".',
        );
      }
      let items = store.knowledgeFor(who.repoId, scopedPath, NO_LIMIT);
      if (contains !== undefined) {
        const needle = contains.toLowerCase();
        items = items.filter(
          (k) => k.statement.toLowerCase().includes(needle) || (k.why ?? "").toLowerCase().includes(needle),
        );
      }
      // An empty answer has to explain itself.
      //
      // A client queried this before its repository's first review completed, got
      // `count: 0`, and wrote "the knowledge store is empty" into two manuals. That
      // is the honest reading of a bare zero — and it is wrong in a way that matters,
      // because the memory is the product and "empty" reads as "this does nothing".
      //
      // The cause is D-35: bootstrapping needs a mirror to read, so it runs on the
      // first review rather than at provisioning. Nothing said so, and the very first
      // question a new workgroup asks is this one.
      const empty =
        store.knowledgeFor(who.repoId, undefined, 1).length === 0
          ? "Nothing has been learned about this repository YET — not 'this repo has no conventions'. " +
            "The knowledge base is built from the repo's own docs on the FIRST REVIEW (there has not been one, " +
            "or it did not finish). Start a review, or teach a rule directly with knowledge_teach."
          : undefined;

      return text(
        JSON.stringify({
          // lore-ok[0e9ae660]: same finding as 562d4c2e above, raised twice with
          // different wording — `items` is fixed there (NO_LIMIT), so `count` and
          // the zero-match note below are both accurate as they stand now.
          count: items.length,
          items: items.map((k) => ({
            id: k.id,
            kind: k.kind,
            source: k.source,
            statement: k.statement,
            why: k.why,
            path: k.path,
            cwe: k.cwe,
            verified_at: k.verifiedAt,
          })),
          note:
            empty ??
            (items.length === 0
              ? "This repository HAS knowledge; nothing matched this filter. Widen it before concluding anything."
              : // lore-ok[b9033841]: found real by lore's own review — a third door for the
                // same laundering 70b88761/652bb58d closed elsewhere. This note used to
                // blanket-frame every returned row as "this team's decisions", including
                // `kind: "fact"` rows (bootstrap's own, unconfirmed reading of one
                // branch's code) — and TOOL_DOCS.query tells a client the note is "the
                // only thing that can tell you" which case it is in, so a client would
                // have written code trusting a planted claim as settled team policy.
                items.some((k) => k.kind === "fact")
                ? "Taught rules outrank inferred ones. These are this team's decisions, not suggestions — EXCEPT " +
                  'any `kind: "fact"` row: a model\'s own unconfirmed reading of one branch\'s code at bootstrap, ' +
                  "never a decision. Weigh those, do not treat them as settled."
                : "Taught rules outrank inferred ones. These are this team's decisions, not suggestions."),
        }),
      );
    },
  );

  // --------------------------------------------------------- knowledge.teach

  server.registerTool(
    "knowledge_teach",
    {
      description: TOOL_DOCS.teach,
      inputSchema: z.object({
        statement: z.string().min(1).describe("the rule or fact, stated plainly"),
        why: z.string().min(1).describe("the reason — a rule without one gets deleted by the next reader"),
        // lore-ok[88958ae6]: same finding as 28941e15 below, raised twice with
        // different wording — normalized where the value is stored, a few lines
        // down. See that comment for the fix and how it was verified.
        path: absent(z.string()).describe(
          "scope it to a file or directory when it is not repo-wide, relative to the repository root " +
            '(e.g. "src/payments") — not absolute and not starting with ".."',
        ),
        kind: absent(z.enum(["rule", "fact", "mistake", "policy"])).describe(
          "policy = a development rule a review can be APPEALED to (D-83); default rule",
        ),
      }),
    },
    async ({ statement, why, path, kind }) => {
      // lore-ok[28941e15]: found real by lore's own review, same finding as 88958ae6
      // below — every consumer of a knowledge row's `path` compares it at an EXACT
      // segment boundary (`scopesOverlap` in conflict.ts requires `startsWith(b +
      // "/")`; `knowledgeFor`'s SQL requires `LIKE path || '/%'`), so a rule taught
      // with the natural spellings "src/" or "./src" stored verbatim recorded: true,
      // confidence 1, and then matched no file, ever — attached to no review prompt,
      // no finding history, no path-scoped knowledge_query. `normalizeReviewPath`
      // already exists in this file for exactly this canonicalization; it was applied
      // only to `review_start`'s folder path, ten handlers up, not to this one.
      //
      // lore-ok[7e754395]: found real by lore's own review, against the fix just
      // above — normalizing alone does not carry the refusal `review_start` pairs it
      // with (`pathEscapesWorktree`, `lore-ok[e393b46f]` at that function's own
      // definition: "normalization alone cannot carry the refusal"). An absolute
      // path or one starting with ".." survives `normalizeReviewPath` unchanged,
      // still stores recorded: true, and still scopes nothing — every consumer
      // compares against an always-relative file path from a diff, which an
      // absolute or escaping string can never equal or prefix. An agent trained by
      // review_start's own folder-path convention to think in absolute paths is the
      // realistic source; refused here the same way review_start refuses it at its
      // own door, rather than silently recording a rule that can never fire.
      const scopedPath = path === undefined ? undefined : normalizeReviewPath(path);
      if (path !== undefined && scopedPath !== undefined && pathEscapesWorktree(path, scopedPath)) {
        throw new Error(
          `path must stay inside the repository, relative to its root — "${path}" does not. Pass a path like ` +
            '"src" or "src/payments", not an absolute one or one starting with "..".',
        );
      }
      const item = store.addKnowledge({
        repoId: who.repoId,
        kind: kind ?? "rule",
        source: "taught",
        statement,
        why,
        ...(scopedPath !== undefined ? { path: scopedPath } : { path: undefined }),
        cwe: undefined,
        provenance: `taught by ${who.principal}`,
        sourceBlob: undefined,
        confidence: 1,
      });
      // THE SHORT ID IS THE HANDLE AN APPEAL USES, so it is returned where it is
      // created. A policy nobody can cite is a policy nobody can appeal to, and the
      // client has no other way to learn the id it needs.
      return text(
        JSON.stringify({
          id: item.id,
          recorded: true,
          ...(item.kind === "policy"
            ? {
                cite_as: item.id.slice(0, 8),
                note:
                  "A development rule. It is NOT added to reviewer prompts — reviewers are told this " +
                  "project has policies, not what they say. To appeal a finding to it, answer that finding " +
                  `with: lore-ok[<fingerprint>]: rule ${item.id.slice(0, 8)} — <why it applies here>. ` +
                  "The reviewing tier rules on the appeal; lore never closes a finding because a rule was " +
                  "cited at it.",
              }
            : {}),
        }),
      );
    },
  );

  // ------------------------------------------------------- knowledge.retire

  // A RULE THAT CANNOT BE REVOKED IS A CHECK THAT CANNOT BE SWITCHED BACK ON.
  //
  // An accepted appeal suppresses an engine rule for a path for as long as the
  // development rule that authorised it is live (D-83), and `checks_skipped` tells the
  // reader exactly that — "retire the rule to switch it back on". Without this tool that
  // sentence named an action nothing could perform, which is the same defect as a review
  // that reports a state the client cannot act on.
  server.registerTool(
    "knowledge_retire",
    {
      description: TOOL_DOCS.retire,
      inputSchema: z.object({
        rule: z.string().min(4).describe("id of the development rule — `cite_as`, or the full id, either resolves it"),
        why: z.string().min(1).describe("why it no longer holds — this is kept, and is what a later reader gets"),
      }),
    },
    async ({ rule, why }) => {
      const outcome = store.retirePolicy(who.repoId, rule, `retired by ${who.principal}: ${why}`);
      // Ambiguity is refused rather than resolved, exactly as `policyByShort` refuses it:
      // retiring the wrong rule silently re-enables checks somewhere nobody is looking.
      return text(
        JSON.stringify(
          outcome === "retired"
            ? {
                retired: true,
                note:
                  "Every suppression this rule authorised stops applying from the next review. The " +
                  "suppression rows are kept on purpose — they are the record of what earlier reviews " +
                  "did not cover.",
              }
            : {
                retired: false,
                because:
                  outcome === "ambiguous"
                    ? `more than one development rule starts with '${rule}' — give more characters`
                    : `no live development rule of this repository starts with '${rule}'`,
              },
        ),
      );
    },
  );

  // -------------------------------------------------------------- review.vex

  server.registerTool(
    "review_vex",
    {
      description: TOOL_DOCS.vex,
      inputSchema: z.object({ review_id: z.string().min(1) }),
    },
    async ({ review_id }) => {
      const review = mine(review_id);
      const doc = buildVex(
        store,
        review_id,
        { name: review.branch, version: review.treeHash ?? "unknown" },
        new Date().toISOString(),
      );
      return text(
        JSON.stringify({
          // lore-ok[9b09e7c5,a9c12b7e,118b5ec1]: `vexGap` PASSED THROUGH,
          // `review.treeHash` ALONGSIDE reviewType now too — see vexGap's own
          // doc comment (vex.ts) for what each answers.
          summary: renderVex(doc, vexGap(store, review_id, review.type, review.treeHash)),
          untriaged: findingsNeedingTriage(store, review_id).length,
          document: doc,
        }),
      );
    },
  );

  // ------------------------------------------------------- knowledge.resolve

  server.registerTool(
    "knowledge_resolve",
    {
      description: TOOL_DOCS.resolve,
      inputSchema: z.object({
        keep: z.string().min(1).describe("id of the rule that is correct — full or short, either resolves it"),
        retire: z.string().min(1).describe("id of the rule that is wrong — full or short, either resolves it"),
        reason: z.string().min(1).describe("why — this is recorded and outlives both of you"),
      }),
    },
    async ({ keep, retire, reason }) => {
      // THROUGH THE SAME FUNCTION THE BOARD'S BUTTON USES (D-99), so a review resumed by
      // an agent relaying its user's decision and one resumed by a person clicking are
      // not distinguishable afterwards — same retirement, same resume rule, same record
      // that a HUMAN decided. Two implementations of one decision is how they come to
      // disagree, and this one ends with a statement retired from the shared memory.
      const outcome = decide(store, { repoId: who.repoId, keep, retire, reason, by: who.principal });
      if (!outcome.resolved) {
        throw new Error(
          `no open conflict between ${keep} and ${retire} — check knowledge_query, or it may already be settled`,
        );
      }
      // THE RESUME AND ITS ONE CONDITION NOW LIVE IN `decide` — see there. Both were
      // written here first: that a settled conflict must ENQUEUE a round, because
      // `spec/knowledge.md` §7.3 promised an exit that nothing scheduled and reviews were
      // swept to `expired` waiting for it; and that it must resume only when NOTHING else
      // in the repository is open, because a parked review is blocked by every conflict
      // rather than one it could name, so resuming early buys a paid round and parks
      // again while reporting progress that is not happening.
      const blocking = outcome.stillBlocking;
      const resumed = outcome.resumed;
      const kept = "The losing rule is retired, not deleted: the decision stays reconstructable.";
      return text(
        JSON.stringify({
          resolved: true,
          retired: retire,
          resumed_reviews: resumed,
          conflicts_still_open: blocking,
          note:
            blocking > 0
              ? `${kept} ${blocking} other conflict(s) in this repository are still open, and a parked review is ` +
                "blocked by all of them — so NOTHING was resumed. Settle them too; the reviews resume when the " +
                "last one is gone."
              : resumed > 0
                ? `${kept} ${resumed} review(s) that were waiting have been resumed — poll them.`
                : kept,
        }),
      );
    },
  );

  server.registerTool(
    "knowledge_escalate",
    {
      description: TOOL_DOCS.escalate,
      inputSchema: z.object({
        left: z.string().min(1),
        right: z.string().min(1),
        note: z.string().min(1).describe("what you tried, and what a person needs to decide"),
      }),
    },
    async ({ left, right, note }) => {
      // lore-ok[55452eb0]: found by lore's own review — this used to discard
      // `escalateConflict`'s result and report "Recorded" unconditionally, so a
      // wrong or already-settled id pair wrote nothing while the reply told the
      // client a person would be notified. Mirrors `knowledge_resolve` a few
      // handlers up, which already throws rather than claim a no-op succeeded.
      const escalated = store.escalateConflict(who.repoId, left, right, note);
      if (!escalated) {
        throw new Error(
          `no OPEN conflict between ${left} and ${right} in this repo — check knowledge_query, or it may` +
            " already be needs-human",
        );
      }
      return text(
        JSON.stringify({
          escalated: true,
          note: "Recorded. This still blocks the review from passing — tell your user a person must decide it.",
        }),
      );
    },
  );

  // ----------------------------------------------------------- refactor.start (D-136)
  //
  // SEPARATE FROM REVIEW THROUGHOUT: no review row, no ladder, no finding, no
  // attestation. `commit`+`folder` are read exactly as `review_start`'s folder mode
  // reads `path` — a githash is not new plumbing here, `worktreeFor` (git/repo.ts)
  // already resolves any committish, branch tip or raw SHA alike.

  server.registerTool(
    "refactor_start",
    {
      description: TOOL_DOCS.refactorStart,
      inputSchema: z.object({
        commit: z.string().min(1).describe("the commit to read — a branch tip or a raw SHA, cut from lore's mirror exactly as a review is"),
        folder: z.string().min(1).describe('the folder the suggestions must be ABOUT, relative to the repository root — "." for the whole tree'),
      }),
    },
    async ({ commit, folder }) => {
      // Same fault as review_start's own path guard: a NUL byte reaches `execFile` and
      // throws from Node itself, after a row already exists and a claim is already
      // possible — refused here instead, before anything is created.
      if (commit.includes("\0") || folder.includes("\0")) {
        throw new Error("commit and folder must not contain a NUL byte.");
      }
      // lore-ok[6253e066]: found by lore's own review, HIGH — `folder` reached the
      // fan-out prompt with no escape check at all, unlike both siblings this file
      // already protects the same way: `review_start`'s own `path` (normalizeReviewPath
      // + pathEscapesWorktree, this file) and `propose`'s `--folder` (`propose/run.ts`).
      // `"../.."` from a worktree lands on the shared `reposRoot` — every repo this
      // deployment mirrors, for a token scoped to exactly one (D-23). Same functions,
      // same normalization `review_start` already applies, so the STORED folder is
      // canonical the same way the stored `path` is.
      const scopedFolder = normalizeReviewPath(folder);
      if (pathEscapesWorktree(folder, scopedFolder)) {
        throw new Error(
          `folder must stay inside the repository, relative to its root — "${folder}" does not. Pass a path ` +
            'like "src" or "src/payments", not an absolute one or one starting with "..".',
        );
      }
      // REFUSED AT THE DOOR. A config with no tier marked refactor: true cannot answer
      // this, ever — finding that out only after a run is queued and claimed would
      // waste a claim (and the worktree it cuts) on a request doomed from the start.
      if (!loadTiers().some((t) => t.kind === "model" && t.refactor === true)) {
        throw new Error(
          'no tier is configured for refactor suggestions — LORE_TIERS needs "refactor": true on at least one model tier',
        );
      }
      // lore-ok[43ba939c]: found by lore's own review, MEDIUM — no admission bound at
      // all. `review_start` refuses past `MAX_OPEN_REVIEWS` (D-98) for exactly this
      // reason: `RefactorWorker.dispatch` claims and fires every run WITHOUT awaiting,
      // same as `Worker`'s own dispatcher, straight through the one shared model-call
      // gate every in-flight review also depends on. Same `mayAdmit`, a smaller limit
      // (`core/admission.ts`).
      const refactorAdmission = mayAdmit(store.openRefactorRunCount(), MAX_OPEN_REFACTOR_RUNS);
      if (!refactorAdmission.allowed) {
        throw new Error(
          `lore is full: ${refactorAdmission.open} refactor runs are already open, and the limit is ` +
            `${refactorAdmission.limit}. NOTHING WAS STARTED. Try again once one finishes.`,
        );
      }
      const id = newRefactorRunId();
      store.createRefactorRun({ id, repoId: who.repoId, principal: who.principal, commitSha: commit, folder: scopedFolder });
      return text(JSON.stringify({ run_id: id, state: "queued" }));
    },
  );

  // ------------------------------------------------------------ refactor.poll (D-136)

  server.registerTool(
    "refactor_poll",
    {
      description: TOOL_DOCS.refactorPoll,
      inputSchema: z.object({ run_id: z.string().min(1) }),
    },
    async ({ run_id }) => {
      const run = myRefactorRun(run_id);
      const body: Record<string, unknown> = { run_id, state: run.state };
      if (run.state === "done") {
        body["suggestions"] = run.suggestions;
        body["combined"] = run.combined ?? false;
        if (run.combinerNote !== undefined) body["combiner_note"] = run.combinerNote;
        body["sources"] = run.sources ?? [];
      }
      if (run.state === "failed" && run.lastError !== undefined) {
        body["error"] = run.lastError;
      }
      return text(JSON.stringify(body));
    },
  );

  // ------------------------------------------------------------ refactor.list (D-136)
  //
  // lore-ok[cc9d46fd]: found by lore's own review, MEDIUM — "stored and queryable" had
  // no way to actually list what was stored: a run_id lost from a client's context made
  // its suggestions unreachable, exactly the "looks used, is not" shape this project's
  // own rules warn about (`store.recentRefactorRuns`'s own doc names the index this
  // query actually needed). Mirrors `review_inbox`'s own no-args, repo-scoped shape.

  server.registerTool(
    "refactor_list",
    { description: TOOL_DOCS.refactorList, inputSchema: z.object({}) },
    // lore-ok[f60ebe42,c892422d]: found by lore's own review, twice — the cap on
    // this list was silent while every doc describing it said "every run". `notShown`
    // is the honest remainder, the same "counted and stated" shape `findingsNotShown`
    // (board.ts) already uses for the same reason.
    //
    // lore-ok[e6387cc0]: found by lore's own review — this used to pass the store's
    // raw camelCase rows straight through, so the wire spoke `id`/`commitSha`/
    // `combinerNote`/`lastError` while both this tool's own docs and `refactor_poll`'s
    // real response speak `run_id`/`commit`/`combiner_note`/`error`. Mapped now the
    // same way every sibling tool maps a store row at this boundary
    // (`knowledge_query`'s `verified_at`, `review_inbox`'s `review_id`) — this file had
    // exactly one exception to that rule, and it was this one.
    () => {
      const { runs, notShown } = store.recentRefactorRuns(who.repoId);
      return text(
        JSON.stringify({
          runs: runs.map((r) => ({
            run_id: r.id,
            commit: r.commitSha,
            folder: r.folder,
            state: r.state,
            principal: r.principal,
            ...(r.combined === undefined ? {} : { combined: r.combined }),
            ...(r.combinerNote === undefined ? {} : { combiner_note: r.combinerNote }),
            ...(r.lastError === undefined ? {} : { error: r.lastError }),
            created_at: r.createdAt,
            updated_at: r.updatedAt,
          })),
          notShown,
        }),
      );
    },
  );

  // ------------------------------------------------------------- resources

  for (const [uri, doc] of Object.entries(RESOURCE_DOCS)) {
    server.registerResource(
      uri,
      uri,
      {
        title: doc.title,
        mimeType: "text/markdown",
        // Assistant-facing, with a priority so a host doing automatic context
        // inclusion picks the workflow doc before the ladder rationale.
        annotations: { audience: ["assistant"], priority: doc.priority },
      },
      async () => ({ contents: [{ uri, mimeType: "text/markdown", text: doc.text }] }),
    );
  }

  // Live data, not documentation.
  //
  // `lore://review/{id}` is deliberately richer than `review_poll`: poll returns
  // deltas so the loop stays cheap, while this returns the whole history for when
  // an agent — or a person — needs to understand how a review reached its verdict.
  server.registerResource(
    "review-trail",
    new ResourceTemplate("lore://review/{review_id}", { list: undefined }),
    {
      title: "Every finding on one review, in full — reading it consumes nothing",
      mimeType: "application/json",
    },
    async (uri: URL, vars: Record<string, string | string[]>) => {
      const id = String(Array.isArray(vars["review_id"]) ? vars["review_id"][0] : vars["review_id"]);
      const review = mine(id);
      // Verdicts and runs are a chronology, so they order by id; findings are a list
      // someone reads top-down, so they order worst first like everywhere else.
      //
      // lore-ok[d6294062]: `fingerprint` here is the store's full 64-hex column,
      // preserved as-is because `buildVex` (src/security/vex.ts) keys `latestVerdict`
      // lookups off this exact value — truncating it here would break VEX. But
      // `review_poll` hands every client an 8-hex `fingerprint` (server.ts, `.slice(0,
      // SHORT_LENGTH)`), and TOOL_DOCS pointed a client who lost that value at THIS
      // resource for "the fingerprint lore-ok needs" — which the 64-hex form is not:
      // SLASH_START (core/lore-ok.ts) accepts exactly 8 hex before `]`. `short` is the
      // field docs.ts now names for that recovery.
      const findings = store.findingRowsForReview(id).map((f) => ({
        ...f,
        short: String(f["fingerprint"] ?? "").slice(0, SHORT_LENGTH),
      }));
      const verdicts = store.verdictsFor(id);
      const runs = store.tierRunsFor(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ review, tierRuns: runs, findings, verdicts }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "knowledge-at-path",
    new ResourceTemplate("lore://knowledge/{+path}", { list: undefined }),
    { title: "What is known about a path", mimeType: "application/json" },
    async (uri: URL, vars: Record<string, string | string[]>) => {
      const path = String(Array.isArray(vars["path"]) ? vars["path"][0] : vars["path"] ?? "");
      // c5e38bc8/2a540515: the same unnormalized-read gap as knowledge_query, fixed
      // the same way — see that handler's comment. Refusing here too, not only
      // there: leaving the resource lenient while the tool refuses would just be a
      // second, subtler flavour of the same inconsistency this file keeps producing
      // between near-identical read paths — mine() throwing "not found" from a
      // resource handler a few dozen lines up is the existing precedent that a
      // resource read already has a working error channel.
      const scopedPath = normalizeReviewPath(path);
      if (pathEscapesWorktree(path, scopedPath)) {
        throw new Error(
          `path must stay inside the repository, relative to its root — "${path}" does not. Pass a path like ` +
            '"src" or "src/payments", not an absolute one or one starting with "..".',
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(store.knowledgeFor(who.repoId, scopedPath), null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------- prompt

  server.registerPrompt(
    "review",
    {
      title: "Review a branch, or a folder within it",
      description:
        "Drives the whole review loop. An agent handed only tools will improvise the multi-step, stateful part — this is what stops that.",
      argsSchema: z.object({
        branch: z.string().describe("branch under review"),
        // D-130. into required for the default diff review; omit both it and mode
        // for that case. mode: "folder" needs path instead, not into.
        into: absent(z.string()).describe('branch it will merge into — omit for mode: "folder"'),
        mode: absent(z.enum(["diff", "folder"])).describe('default "diff"; "folder" reviews `path` instead of `into`'),
        path: absent(z.string()).describe('path to review, when mode is "folder"'),
        ticket: z.string().describe("the task text, pasted verbatim"),
      }),
    },
    ({ branch, into, mode, path, ticket }) => {
      const folderMode = mode === "folder";
      if (folderMode && path === undefined) {
        throw new Error('mode: "folder" needs `path` — the path to review, relative to the repository root.');
      }
      if (folderMode && into !== undefined) {
        throw new Error('mode: "folder" and `into` contradict each other — folder mode has no base to diff against.');
      }
      if (!folderMode && path !== undefined) {
        throw new Error('`path` only applies to mode: "folder" — omit it, or pass mode: "folder" to use it.');
      }
      if (!folderMode && into === undefined) {
        throw new Error('`into` is required unless mode: "folder" is set — the branch this one will merge into.');
      }
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: REVIEW_PROMPT_TEXT({ branch, into, mode, path }, ticket),
            },
          },
        ],
      };
    },
  );

  return server;
}
