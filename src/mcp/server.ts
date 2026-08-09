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
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import { absent } from "../core/optional.ts";
import { worstSeverity } from "../core/finding.ts";
import { initialState, ladderFingerprint, type LadderState } from "../core/ladder.ts";
import { isAttestable, isClean, isTerminal, type ReviewState } from "../core/review-state.ts";
import { DEFAULT_TYPE, reviewType, reviewTypeIds } from "../core/review-type.ts";
import { applyPatch, restoreTree, treeHash } from "../git/repo.ts";
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
function nextStep(state: ReviewState): string {
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
      return "ACT NOW: answer every finding below — fix it, or write the `justify_with` line at the site — then call review_submit with your diff and tree hash. THE REVIEW DIES IF YOU STOP HERE: it is abandoned after 48h and concludes nothing, and this branch stays unreviewed.";
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
 * The subscribe call, ready to send, with the id already in it.
 *
 * The docs described the shape with a `<review_id>` placeholder and left the client to
 * assemble it. That is a small tax charged at exactly the wrong moment — the reply that
 * says "go away and wait" is the one a client acts on immediately — and the observed
 * behaviour is that clients skip it and fall into a sleep-poll loop, which is the most
 * expensive thing they can do here. I did it myself, all evening, against this service.
 *
 * So the concrete call travels in the reply, beside the interval. A client that copies
 * one field gets it right; one that reads none of them still has `check_back_after_ms`.
 */
export function subscribeTo(reviewId: string): object {
  const filter = { resourceSubscriptions: [`lore://review/${reviewId}`] };
  return {
    // The wire-accurate JSON-RPC call, for a client sending raw frames.
    subscribe: { method: "subscriptions/listen", params: { notifications: filter } },
    // AND THE FILTER ON ITS OWN, because an SDK helper takes a `SubscriptionFilter` while
    // the frame above nests it under `notifications`. This is not a convenience: handing
    // out only the frame is what made every subscription against this service silent for
    // an evening.
    //
    // MEASURED, over the wire, after two wrong guesses about it:
    //
    //   * WRONG — `listen()` given the raw frame's params, `{ notifications: { ... } }`:
    //     the acknowledgement arrives with an EMPTY honoured filter and no event ever
    //     comes. The stream is open, healthy and useless.
    //   * RIGHT — `listen()` given `subscribe_filter`, `{ resourceSubscriptions: [...] }`:
    //     honoured filter echoes the review, and the wake arrives (377s later, on the
    //     round boundary).
    //
    // In-process, `subscribe.test.ts` honours BOTH, so the suite cannot tell them apart
    // and did not catch this. That is stated there rather than papered over: the test
    // asserts the two fields agree in SHAPE, which does discriminate, and calls `listen()`
    // for live confirmation, which does not.
    subscribe_filter: filter,
    subscribe_note:
      "Send this ONCE and stop polling on a timer: you are woken on every STATE change, which is the " +
      "only moment there is anything for you to do. Then call review_poll ONCE straight away — a " +
      "subscription carries no history, so anything that happened before your stream opened is waiting " +
      "and nothing will announce it. CHECK THE ACKNOWLEDGEMENT: if your subscription is not echoed in it, " +
      "you are not subscribed and nothing will ever arrive. An EMPTY honoured filter is never healthy: " +
      "the usual cause is giving an SDK's listen() the raw params instead of `subscribe_filter`, which " +
      "validates against an all-optional schema and matches nothing. Compare what came back with what you " +
      "sent. " +
      // The two walls I hit driving this service as a client, neither of which the old
      // text mentioned. Both produce an error that reads like a fault in lore.
      "TWO THINGS THAT LOOK LIKE LORE FAILING AND ARE NOT. (1) `subscriptions/listen` needs a 2026-07-28 " +
      "connection, and SDK clients default to the 2025 one — you usually have to opt in rather than being " +
      "unable to: on the TypeScript SDK that is `versionNegotiation: { mode: 'auto' }` in the client " +
      "options, and without it the method is refused as unsupported by the negotiated version. (2) Send it " +
      "with your SDK's SUBSCRIPTION call, not as an ordinary request: an ordinary request applies your " +
      "client's request timeout to the whole stream, so the subscription is acknowledged and then cancelled " +
      "by your own client a minute later, and raising the timeout only moves the moment. On the TypeScript " +
      "SDK that is `client.listen(...)`, and it takes `subscribe_filter` — `subscribe.params` nests the " +
      "same thing under `notifications` for a raw frame. The handle's `closed` promise says WHY a stream " +
      "ended. " +
      "If it still cannot be established, that is normal — fall back to `check_back_after_ms`.",
  };
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
        into: z.string().min(1).describe("branch it will merge into"),
        ticket: z
          .string()
          .min(1)
          .describe("the task text, pasted verbatim — not summarised, not your own description"),
        type: absent(z.enum(reviewTypeIds() as [string, ...string[]])).describe(`default: ${DEFAULT_TYPE}`),
        restart: absent(z.boolean()).describe(
          "abandon an open review of this branch and start over — only after a rebase or force-push",
        ),
      }),
    },
    async ({ branch, into, ticket, type, restart }) => {
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
            `review_submit, which applies your fixes to the SAME review and advances the ladder. Starting ` +
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
          // THE CALL ITSELF, not a description of it. See `subscribeTo`.
          ...subscribeTo(id),
          note:
            "Started. This does NOT mean it finished, and NOTHING can have happened yet. SEND THE " +
            "`subscribe` CALL BELOW, then poll ONCE, then leave — you will be woken. If your host cannot " +
            "subscribe, read `check_back_note` instead, re-read it on every reply because it shrinks as " +
            "the round ages, and make ONE call when it says. Either way, go and do something else: a " +
            "sleep-poll loop is the most expensive thing a client can do here.",
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
          note: nextStep(review.state),
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
              : { failed_because: why };
          })(),
          // A check that did not run is not a check that found nothing (INV-1). The
          // deterministic engines are the ones that go missing silently — no
          // `node_modules`, no test script, a disabled suite — and their absence
          // narrows what any later `passed` is evidence OF. The model tiers are told
          // in their prompt; the client has no other way to find out.
          ...(() => {
            const skipped = store.unavailableChecks(review_id);
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
            `be recreated — a new worktree would be cut from the mirror as it stands NOW, which is not the tree ` +
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
      if (store.hasPendingRound(review_id)) {
        throw new Error(
          `a review round is pending for ${review_id}; a reviewer is reading — or is about to read — the ` +
            `worktree this patch would rewrite. Call review_poll until the state is 'findings_ready' or ` +
            `'awaiting_diff' — those are the states that accept a diff — then submit the same diff again. ` +
            `Note that 'fast_clean' is NOT one of them: the deep tiers are still queued against this worktree. ` +
            `Nothing was applied.`,
        );
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
                will_not_settle: unmoved.map((f) => ({ file: f.file, line: f.line, claim: f.claim })),
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
      const reviews = store.listReviews(who.principal, who.repoId);
      const items = reviews.map((r) => {
        const fresh = store.undelivered(r.id);
        return {
          review_id: r.id,
          branch: r.branch,
          state: r.state,
          clean: isClean(r.state),
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
          reviews: items.filter((i) => i.new_findings > 0 || i.state === "needs_human"),
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
      const settled = store.resolveConflict(who.repoId, keep, retire, reason);
      if (!settled) {
        throw new Error(
          `no open conflict between ${keep} and ${retire} — check knowledge_query, or it may already be settled`,
        );
      }
      // RESUME THE REVIEWS THIS WAS BLOCKING. Without it the exit is not an exit.
      //
      // `spec/knowledge.md` §7.3 promises that a block has a way out and that the
      // ladder "recomputes needsHuman from currently-open conflicts on every round
      // rather than latching it forever". The recomputation is correct and was
      // unreachable: nothing enqueued a round after a conflict was settled, so a
      // client that did exactly what it was told — resolve, then wait for the ladder
      // to continue — waited for something that was never scheduled. `needs_human` is
      // not a terminal state, so `expireStale` then swept the review to `expired`
      // after 48 hours, and D-77 reads `expired` as "the ladder did not read the
      // code". A trap with an exit sign on it.
      //
      // BUT ONLY WHEN NOTHING ELSE IS STILL OPEN. `needsHuman` is recomputed from
      // `openConflicts(repoId)`, which is repo-wide: a parked review is blocked by
      // EVERY open conflict in the repository, not by one it could name. So resuming
      // while another conflict is unsettled buys each review one paid round and parks
      // it again at the end of it, while `resumed_reviews` reports progress that is
      // not happening. Raised on the commit that added the resume — the exit sign
      // fixed, and pointing at a second wall.
      const blocking = store.openConflicts(who.repoId).length;
      const resumed = blocking === 0 ? store.resumeNeedsHuman(who.repoId) : 0;
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
