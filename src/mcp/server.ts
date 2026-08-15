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
import { forClient } from "./plain.ts";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import { mayAdmit } from "../core/admission.ts";
import { absent } from "../core/optional.ts";
import { worstSeverity } from "../core/finding.ts";
import { initialState, ladderFingerprint, type LadderState } from "../core/ladder.ts";
import { isAttestable, isClean, isTerminal, needsClient, type ReviewState } from "../core/review-state.ts";
import { DEFAULT_TYPE, reviewType, reviewTypeIds } from "../core/review-type.ts";
import { STALE_GRACE_DAYS, STALE_HOURS } from "../ops/retention.ts";
import { applyPatch, restoreTree, treeHash } from "../git/repo.ts";
import { decide } from "../knowledge/decide.ts";
import { enrich, renderEnrichment } from "../knowledge/enrich.ts";
import { paceFor, paceNote } from "../ops/pace.ts";
import { alreadyAnswered, codeMoved, filesInDiff } from "../reviewer/review.ts";
import { buildVex, findingsNeedingTriage, renderVex } from "../security/vex.ts";
import { isSettled, type RecordedFinding, type Store } from "../store/store.ts";
import type { Principal } from "./auth.ts";
import { REVIEW_PROMPT_TEXT, RESOURCE_DOCS, TOOL_DOCS } from "./docs.ts";

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
  ) => Promise<{ worktree: string; treeHash: string; synced: boolean }>;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

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
function nextStep(state: ReviewState, freshFindings = 0): string {
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
      return "Still working — this is NOT a result. Read `check_back_note` THIS TIME (it shrinks as the round ages — never reuse the last one), leave, and make ONE call when it says. Do not merge, and do not report anything about the branch yet.";
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
      return "Every tier agrees. Call review_attest for the signed line, then merge.";
    case "passed_partial":
      return "Every tier that COULD run agrees — weaker evidence than `passed`, honestly labelled. Tell your user which tiers were skipped and why (the attestation names them) before deciding to merge.";
    case "failed":
      return "The review DID NOT RUN — this is not 'nothing found' and you must not merge. Read `failed_because` and repeat it to your user verbatim. Retry AT MOST ONCE; if it fails the same way, stop and report it rather than diagnosing lore yourself.";
    case "expired":
      return "Nobody answered this review in time, so it concluded NOTHING about the code — not that it was clean. Start a fresh review if this branch still matters.";
    case "cancelled":
      return "You stopped this review. The findings it had already produced are yours and are listed here; it concluded nothing beyond them, and the tiers that had not run never looked. Start a fresh review when you want the rest.";
  }
}

/**
 * NOTHING ABOUT SUBSCRIPTIONS TRAVELS TO A CLIENT — deliberately, and it is not gone.
 *
 * Vany: *"we are keeping our subscription mechanism, but it is not yet ready in the
 * client — the client can only poll. So we ask the client to poll, and keep the
 * subscribing model hidden."*
 *
 * The server still declares `resources: { subscribe: true }`, still honours
 * `subscriptions/listen`, and still wakes a subscriber on every state change (D-80). What
 * stopped is ADVERTISING it. Every reply used to carry a ready-made `subscribe` frame, a
 * `subscribe_filter`, and eight hundred words on why an SDK helper needs the second shape
 * — advice a client that cannot subscribe must read, fail at, and then work past to find
 * the interval it actually needed.
 *
 * That is worse than silence for a client that polls: the reply's most prominent
 * instruction is one it cannot follow, and the fallback reads as a consolation. So the
 * replies now say one thing — poll, at this interval — and the capability waits for a
 * client that can use it.
 *
 * Kept as a function returning nothing so the call sites stay honest: they say WHERE the
 * subscription hint used to go, and restoring it is one edit rather than an archaeology.
 */
export function subscribeTo(_reviewId: string): object {
  return {};
}

function newReviewId(): string {
  return `rev_${randomBytes(18).toString("base64url")}`;
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
    { capabilities: { resources: { subscribe: true } } },
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
    const bound = r.tokenHash;
    if (bound !== undefined && bound !== who.tokenHash && store.tokenLive(bound)) {
      throw new Error(`review ${reviewId} not found`);
    }
    return r;
  };

  // ------------------------------------------------------------ review.start

  server.registerTool(
    "review_start",
    {
      description: TOOL_DOCS.start,
      inputSchema: z.object({
        branch: z.string().min(1).describe("branch under review"),
        into: z
          .string()
          .min(1)
          .describe(
            "branch it will merge into — it must EXIST in this repository, and it is not " +
              "assumed to be `main`: a repository whose trunk is `master` needs `master` here. " +
              "A name lore cannot find fails the review naming the branches it can see.",
          ),
        ticket: z
          .string()
          .min(1)
          .describe("the task text, pasted verbatim — not summarised, not your own description"),
        type: absent(z.enum(reviewTypeIds() as [string, ...string[]])).describe(`default: ${DEFAULT_TYPE}`),
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
    async ({ branch, into, ticket, type, restart, pull_request, pull_fresh }) => {
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
      const open = store.openReviewFor(who.repoId, branch);
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
        const before = store.getReview(open.id, store.principalOf(open.id) ?? who.principal)?.originTreeHash;
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
        const pinned = await deps.repin(open.id, before);
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
        store.updateReview(open.id, { state: "queued", treeHash: pinned.treeHash, originTreeHash: pinned.treeHash });
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
            `last advanced ${age} ago). Continue it — poll it, then answer its findings with ` +
            `review_submit; or, if you pushed more commits, call review_start with pull_fresh: true, which ` +
            `re-pins the SAME review to origin's new tip with everything carried. Starting ` +
            `again would re-run the cheap tiers from round 1 and abandon every justification this review ` +
            `has already ratified, which is why the deep tiers are rarely reached. ` +
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
      // Checked before the row is written, so a refusal leaves nothing behind — unlike
      // the spend ceiling, which fires at enqueue and therefore has a review to mark
      // `failed`. Nothing here has been promised to anyone yet.
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
        intoRef: into,
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
          ...subscribeTo(id),
          // THE STRING A CLIENT IS GUARANTEED TO READ, and it pointed at a field that is
          // no longer here. D-103 stopped handing out the subscribe frame; this sentence
          // went on saying "SEND THE `subscribe` CALL BELOW" for exactly one deploy, which
          // is a reply telling a client to do something the same reply makes impossible.
          // Caught by reading the response to lore's own review_start.
          note:
            "Started. This does NOT mean it finished, and NOTHING can have happened yet. Poll it with " +
            "review_poll: ONE call when `check_back_after_ms` says, never a sleep loop. RE-READ that " +
            "number on every reply — it shrinks as the round ages, and reusing the first one doubles " +
            "your wait. It is never more than two minutes. Between calls, go and do something else.",
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
    async ({ review_id }) => {
      const review = mine(review_id);
      const fresh = store.undelivered(review_id);
      store.markDelivered(review_id, fresh.map((f) => f.fingerprint));

      return text(
        JSON.stringify({
          review_id,
          state: review.state,
          // Restated on every poll, because failure mode 1 and 7 are the two most
          // likely ways this loop ends with unreviewed code shipped.
          clean: isClean(review.state),
          // THE NEXT CALL, NAMED. This said only "NOT clean. Only `passed` means
          // clean." — true, and it left a client holding three findings with no
          // sentence telling it what to do with them. Every failure this surface has
          // had in production was a client doing something reasonable that nothing
          // told it not to: polling once and stopping, retrying a review that could
          // never succeed, walking away from `findings_ready` (the single largest
          // cause of abandoned reviews). A state name is not an instruction.
          note: nextStep(review.state, fresh.length),
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
                    justify_with: `// lore-ok[${short}]: <why this code is correct>`,
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
              history: renderEnrichment(enrich(store, who.repoId, f)),
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
          ...pacing(store, review),
          // Only while there is something to wait FOR. In `findings_ready` the next move
          // is the client's, and handing it a subscribe call there would read as
          // permission to sleep on findings that are already its problem — the
          // abandonment D-70 measured. Terminal states have nothing left to announce.
          ...(["queued", "running", "fast_clean"].includes(review.state) ? subscribeTo(review_id) : {}),
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
              : { failed_because: forClient(why) };
          })(),
          // A check that did not run is not a check that found nothing (INV-1). The
          // deterministic engines are the ones that go missing silently — no
          // `node_modules`, no test script, a disabled suite — and their absence
          // narrows what any later `passed` is evidence OF. The model tiers are told
          // in their prompt; the client has no other way to find out.
          ...(() => {
            const skipped = store.unavailableChecks(review_id).map(forClient);
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
            const open = store.openConflicts(review.repoId);
            const byId = new Map(store.knowledgeFor(review.repoId, undefined, 1000).map((k) => [k.id, k]));
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
            // claim that it is still stopped — and the way out is a submit, which is
            // the same way out as every other round.
            //
            // Written the wrong way round first, and caught while a real review was
            // sitting in exactly this position: with no open conflicts left, this
            // said the record was "gone" and told the client to report a defect in
            // lore. Resolution is the NORMAL exit from needs_human, not evidence of
            // data loss, and sending a client to raise a bug because a person did
            // what they were asked to do is its own small betrayal of INV-1.
            return {
              needs_human_because:
                "The question has been ANSWERED — no contradiction is open any more. Nothing is blocking this " +
                "review: call review_submit with your work (an empty diff is fine if there is nothing to change) " +
                "and the ladder continues from where it stopped.",
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
      inputSchema: z.object({
        review_id: z.string().min(1),
        diff: z.string().min(1).describe("unified diff of your fixes"),
        tree_hash: z
          .string()
          .min(1)
          .describe("git write-tree of your working tree after applying — verified after we apply"),
      }),
    },
    async ({ review_id, diff, tree_hash }) => {
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
      if (store.hasPendingRound(review_id)) {
        store.holdDiff(review_id, diff, tree_hash);
        if (store.hasPendingRound(review_id)) {
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
                }),
              },
            ],
          };
        }
        // The round ended in the race window: nothing will consume the hold, so take it
        // back and fall through to the synchronous path below.
        store.clearHeldDiff(review_id);
      }

      // Recorded BEFORE the patch, because the refusal below has to be able to undo it.
      const before = await treeHash(worktree);
      await applyPatch(worktree, diff);

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

      store.updateReview(review_id, { state: "queued", treeHash: applied });
      deps.enqueue(review_id, "fast");

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
        unmoved = (
          await Promise.all(
            store.openFindings(review_id).map(async (f) => {
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
                filesInDiff(diff),
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
                  `${String(unmoved.length)} open finding(s) name code that has NOT moved and carry no lore-ok, so ` +
                  "the next " +
                  "round CANNOT settle them however it goes: a tier that stops raising something it never saw " +
                  "move has changed its mind, not been satisfied. If you fixed the cause somewhere else — which " +
                  "is often the right place — say so AT THE NAMED LINE with a `lore-ok[<fingerprint>]: <why>` " +
                  "comment and submit again; the tier ratifies that by not raising it. Otherwise they will come " +
                  "back, and each round costs you the deep tier's full time.",
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
        throw new Error(
          `review ${review_id} is already '${review.state}' — there is nothing to cancel. Its findings are still ` +
            "available from review_poll and lore://review/" + review_id + ".",
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
      const reviews = store.listReviews(who.principal, who.repoId);
      const items = reviews.map((r) => {
        const fresh = store.undelivered(r.id);
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
      const byId = new Map(store.knowledgeFor(who.repoId, undefined, 1000).map((k) => [k.id, k]));
      const questions = needsHuman.length === 0
        ? []
        : store.openConflicts(who.repoId).map((c) => ({
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
          needs_human: needsHuman.length,
          ...(needsHuman.length > 0 ? { open_questions: questions } : {}),
          note:
            needsHuman.length === 0
              ? "Surface high-severity findings to your user rather than only logging them."
              : questions.length > 0
                ? "Some reviews need a PERSON. `open_questions` IS the question — two things this repository " +
                  "believes that cannot both be true. Take both statements to your user verbatim; do not answer " +
                  "them yourself. Then call knowledge_resolve with the id to keep, or knowledge_escalate."
                : "A review is parked at needs_human but no contradiction is open any more — the question has " +
                  "been answered. Call review_submit on it (an empty diff is fine) and the ladder continues.",
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
      let items = store.knowledgeFor(who.repoId, path);
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
        path: absent(z.string()).describe("scope it to a file or directory when it is not repo-wide"),
        kind: absent(z.enum(["rule", "fact", "mistake", "policy"])).describe(
          "policy = a development rule a review can be APPEALED to (D-83); default rule",
        ),
      }),
    },
    async ({ statement, why, path, kind }) => {
      const item = store.addKnowledge({
        repoId: who.repoId,
        kind: kind ?? "rule",
        source: "taught",
        statement,
        why,
        ...(path !== undefined ? { path } : { path: undefined }),
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
        rule: z.string().min(4).describe("short id of the development rule, as `cite_as` gave it"),
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
          summary: renderVex(doc),
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
        keep: z.string().min(1).describe("id of the rule that is correct"),
        retire: z.string().min(1).describe("id of the rule that is wrong"),
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
      store.escalateConflict(who.repoId, left, right, note);
      return text(
        JSON.stringify({
          escalated: true,
          note: "Recorded. This still blocks the review from passing — tell your user a person must decide it.",
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
    { title: "Full audit trail for one review", mimeType: "application/json" },
    async (uri: URL, vars: Record<string, string | string[]>) => {
      const id = String(Array.isArray(vars["review_id"]) ? vars["review_id"][0] : vars["review_id"]);
      const review = mine(id);
      // Verdicts and runs are a chronology, so they order by id; findings are a list
      // someone reads top-down, so they order worst first like everywhere else.
      const findings = store.findingRowsForReview(id);
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
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(store.knowledgeFor(who.repoId, path), null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------- prompt

  server.registerPrompt(
    "review",
    {
      title: "Review a branch before merging",
      description:
        "Drives the whole review loop. An agent handed only tools will improvise the multi-step, stateful part — this is what stops that.",
      argsSchema: z.object({
        branch: z.string().describe("branch under review"),
        into: z.string().describe("branch it will merge into"),
        ticket: z.string().describe("the task text, pasted verbatim"),
      }),
    },
    ({ branch, into, ticket }) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: REVIEW_PROMPT_TEXT(branch, into, ticket) },
        },
      ],
    }),
  );

  return server;
}
