/**
 * The opencode boundary: ask a model to review, get findings back.
 *
 * Three things this file exists to guarantee.
 *
 * **Reviewers cannot write.** The predecessor passed `--agent readonly` and learned
 * the hard way that opencode silently falls back to the *write-capable* default
 * when the named agent is missing (INV-8) — a missing file turned a read-only
 * reviewer into one that could edit the repo, with no error. Here the tools are
 * denied explicitly in the request body as well, and an explicit per-request denial
 * has nothing to fall back to.
 *
 * **An unparseable review is a failed review, not a clean one.** One retry with the
 * contract restated, then loud failure (INV-1).
 *
 * **Session setup and measurement name their own layer.** This SDK reports server
 * faults by RETURN VALUE and transport faults by throwing, so a fault nobody looks
 * for reads as whatever the next line happens to notice — twice that was "is a server
 * running?" for a server that was up and answering (D-50).
 *
 * NOT yet true of `ask`: its catch still attributes any transport fault — an opencode
 * restart mid-review, or the idle timeout — to the tier, as "tier <id> (<model>)
 * failed". Named here rather than claimed fixed, because the sentence above used to
 * say "every failure" and that was the same over-claim this file exists to punish.
 */

import type * as z from "zod";
import { ClientError, OpenCode, type OpenCodeClient } from "@opencode/client";
import { CancelledByLore, DidNotRun, Exhausted, ProbeInconclusive, ProviderAuthFailed, ServiceUnreachable, TierUnavailable, TooLargeForTier } from "../core/errors.ts";
import { FindingSchema, type Finding } from "../core/finding.ts";
import type { Tier } from "../core/ladder.ts";
import { loadPools, routesFor } from "../core/ladder.ts";
import { type KeptSessions, sessionKey, shouldCompact } from "./continuity.ts";
import { Gate, type GateState } from "./gate.ts";
import { DEFAULT_TIMEOUT_MS, longFetch } from "./long-fetch.ts";
import { OUTPUT_CONTRACT } from "./prompts.ts";

/**
 * What opencode publishes about a session while it is working (D-91), reduced to the one
 * distinction the watchers act on: a retry, or progress.
 *
 * v2 announces a retry as its own event, measured on 2.0.20 rather than read off the
 * schema — `data` carries the provider's failure STRUCTURED, which v1 never did:
 *
 *   {"type":"session.retry.scheduled","data":{"sessionID":"ses_…","attempt":2,
 *      "at":1791031632947,"error":{"type":"provider.rate-limit","message":"…","status":429}}}
 *
 * `at` is when the next ATTEMPT runs, never a quota reset — parsing it as one would park
 * the tier for seconds and call that a cool-off, the mistake v1's `next` invited too.
 * The provider's words still travel in `message`: Z.ai's "Weekly/Monthly Limit Exhausted.
 * Your limit will reset at …" arrives as a rate limit, and only the words carry the time.
 *
 * Only the fields lore reads are named. Everything else on that stream is somebody
 * else's business, and a wider type would invite depending on it.
 */
export interface OpencodeStatus {
  readonly type?: string;
  readonly attempt?: number;
  readonly message?: string;
  /** opencode's own classification of the failure (`provider.quota`, `provider.auth`, …). */
  readonly errorType?: string;
}

/**
 * One v2 event as a watcher sees it, or `undefined` when it says nothing a watcher acts on.
 *
 * PROGRESS IS WHAT ENDS A STORM, so it is reported as a non-retry status: a step that
 * ended WELL, or text the model is producing. Not `session.step.started` — after a retry
 * that is the retry itself, and counting it as recovery would reset the storm clock on
 * every attempt of a storm, which is the one thing that clock exists to outlast. And not a
 * step that ended with `finish: "error"` either, for the same reason from the other side:
 * that is how each FAILED attempt of a storm closes (step.started → error → step.ended
 * error → retry.scheduled), and reading it as recovery reset the clock on every attempt, so
 * the 5-minute bound could never fire on a real v2 storm.
 */
export function statusOf(type: string | undefined, data: Record<string, unknown>): OpencodeStatus | undefined {
  if (type === "session.retry.scheduled") {
    const error = (data["error"] ?? {}) as { type?: unknown; message?: unknown };
    return {
      type: "retry",
      ...(typeof data["attempt"] === "number" ? { attempt: data["attempt"] } : {}),
      ...(typeof error.message === "string" ? { message: error.message } : {}),
      ...(typeof error.type === "string" ? { errorType: error.type } : {}),
    };
  }
  if (type === "session.step.ended" && data["finish"] !== "error") return { type: "busy" };
  if (type === "session.text.delta") return { type: "busy" };
  return undefined;
}

/**
 * The provider's refusal, if this is one, with the reset time it named.
 *
 * Exported so it can be aimed at: it decides whether a review dies in seven seconds or
 * forty-five minutes, and the difference between a quota refusal and an ordinary retry is
 * a substring match nobody should have to find inside a stream handler.
 *
 * `retry` is opencode telling us it will ask again. That is fine and expected for a 500;
 * for an exhausted plan it is a promise to keep failing, once every few seconds, until
 * our deadline. The MESSAGE is what separates them, and it is the provider's own words.
 */
export function quotaRefusal(status: OpencodeStatus): { readonly message: string; readonly resetAt?: string } | undefined {
  const message = status.message ?? "";
  if (status.type !== "retry") return undefined;
  // opencode's OWN WORD FIRST, when it has one. v2 classifies before it retries, and a
  // quota it recognised is a quota whatever the provider's phrasing — the classifier below
  // only ever knew the phrasings that had already cost a review each.
  const known = status.errorType === "provider.quota";
  if (!known && message === "") return undefined;
  // "usage limit" is OpenAI's phrasing — "The usage limit has been reached" — measured
  // live 2026-08-13 after it cost three reviews and a whole propose run 45 minutes each:
  // opencode retries it forever (attempt 1, 2, 3… every few seconds), so the session
  // never finishes and the deadline is the only thing that ends it. The narration carried
  // the refusal the entire time; this line just did not know the words.
  // A PLAIN RATE LIMIT IS NOT IN THIS LIST, and in v1 it was. v1 retried for ever, so any
  // throttle meant waiting out the deadline and aborting at once was right; v2 retries a
  // rate limit itself — ten times, honouring a provider-named wait up to 15 minutes a gap —
  // which is exactly what heals a per-minute 429. Aborting on its first retry turned such
  // a throttle into a stepped-over tier and a thin-ladder pass. What stays are the words of
  // EXHAUSTION, which no retry heals; a throttle that never heals still ends, either in the
  // turn's own recorded failure (`ask` reads it as spent) or at the storm bound.
  if (!known && !/limit exhausted|quota|insufficient|out of credit|usage limit/i.test(message)) return undefined;
  if (message === "") return { message: "quota exceeded (opencode classified it; the provider gave no words)" };
  const at = /reset(?:s)?(?: at)?\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/i.exec(message);
  // TREATED AS UTC, and the provider does not say. Z.ai is a Beijing company and this may
  // well be UTC+8, in which case lore waits eight hours longer than it must — the safe
  // direction, and it self-corrects: the tier is retried after it, succeeds, and the mark
  // is cleared. Reading it the other way would mean one more 45-minute hang, which is the
  // cost this whole change exists to remove.
  // A DATE SHAPE IS NOT A DATE, and `toISOString()` on an invalid one THROWS.
  //
  // `\d{4}-\d{2}-\d{2}` matches `2026-13-45 99:99:99` perfectly well. That RangeError
  // would be thrown inside the watcher, from inside the event loop's deliberately silent
  // catch — so the abort would never fire, the stream would quietly reconnect, and the
  // call would wait out the full 2700s. The exact hang this function exists to remove,
  // reintroduced through its own parser, and invisible.
  //
  // `retryAt` in `core/cooloff.ts` already treats this input as untrusted and has a test
  // for an unparseable time. That care belonged here too — at the parse site that runs
  // first, where a throw has somewhere much worse to land.
  const parsed = at?.[1] === undefined ? Number.NaN : Date.parse(`${at[1].replace(" ", "T")}Z`);
  if (Number.isNaN(parsed)) return { message };
  return { message, resetAt: new Date(parsed).toISOString() };
}

export interface ReviewerConfig {
  readonly baseUrl: string;
  /** Read-only agent name. Belt; the explicit tool denial below is braces. */
  readonly agent: string;
  readonly timeoutMs: number;
  /** HTTP basic credentials, when the opencode server is password-protected. */
  readonly username?: string;
  readonly password?: string;
  /**
   * How long a session may sit in a RETRY STORM before the route is treated as down.
   *
   * Vany: *"monitor the logs of opencode — if it starts retrying a lot, do not allow it
   * to wait more than 5 minutes; treat openai as down and go to the fallback."*
   *
   * `quotaRefusal` kills a refusal it RECOGNISES in seconds; this is the backstop for
   * the phrasings it does not know yet — the openai wording cost three reviews and a
   * whole propose run 45 minutes each before the classifier learned it, and the next
   * provider will phrase it a third way. A storm that is still producing retries past
   * this bound aborts as `Exhausted`, which is what sends the round down the fallback
   * chain; a storm that STOPS is left alone, because recovery publishes a different
   * status and silence is what the deadline is for.
   */
  readonly retryStormMs?: number;
  /**
   * How long a PROBE (D-94) may wait before it counts as still unknown.
   *
   * A probe exists to re-test a route lore already believes is down, on the assumption
   * that asking costs about twelve seconds (D-91's own measured figure) — cheap insurance,
   * paid every `PROBE_INTERVAL_MS`. Kimi broke that assumption on 2026-08-31: a weekly
   * quota refusal took ~21.5 minutes to arrive, with no retry event on the stream for
   * `quotaRefusal` to catch early and no storm for `retryStormMs` to bound — a single
   * request, silent until it finally answered. Unbounded, that cost repeats every 15
   * minutes for as long as any review needs the tier, for the rest of the week the quota
   * does not reset.
   *
   * Short on purpose, and shorter than `retryStormMs`: a probe is strictly more
   * speculative than an active storm — we do not even know the route is trying — so it
   * must not itself become a source of long waits. A route that times out here is
   * reported as still unknown, not as freshly refused: `ProbeInconclusive` carries no
   * new information, so the existing backoff is left exactly as it was and the next
   * probe is simply due again in another `PROBE_INTERVAL_MS`.
   */
  readonly probeTimeoutMs?: number;
  /**
   * Where kept sessions survive a restart (D-80).
   *
   * Absent means the old behaviour exactly — sessions live and die with the process,
   * which is right for the CLI and for tests, and was wrong for the service: a deploy
   * threw away every warm conversation of every open review and nothing said so.
   */
  readonly keptSessions?: KeptSessions;
}

/**
 * The only user name opencode 2.x accepts — its server auth hard-codes it and ignores
 * OPENCODE_SERVER_USERNAME. The DEFAULT when none is configured: an empty name, which is
 * what an unset username used to send, is refused with a bare 401 even with the right
 * password, and the password is the only thing a v2 deployment configures.
 */
// lore-ok[0738503c]: the default every Basic-auth encoder here and in doctor.ts falls back to.
export const V2_USER = "opencode";

export const DEFAULT_REVIEWER: ReviewerConfig = {
  baseUrl: process.env["OPENCODE_SERVER"] ?? "http://127.0.0.1:4096",
  agent: "readonly",
  retryStormMs: 5 * 60_000,
  // MEASURED FROM ONE INCIDENT, NOT COMFORT — see the field's own doc comment. Kept as
  // an explicit default (mirroring `retryStormMs` above) rather than only the `?? 90_000`
  // fallback at the one call site, so a reader of this object sees every bound this
  // client enforces in one place.
  probeTimeoutMs: 90_000,
  // ONE timeout, not two. This was 20 minutes while `longFetch`'s own default was
  // 30, and the shorter silently won — an invisible default nobody chose, which is
  // the shape of nearly every bug this project has found in itself.
  //
  // It cost a real review: T1 on this repo went 521s, then 1006s as the code grew,
  // then past 1200s, and died as "opencode did not respond within 1200s" while a
  // comment three files away justified the 30-minute figure with headroom that did
  // not exist.
  timeoutMs: DEFAULT_TIMEOUT_MS,
  // FOUR, against a worker default of 2 and a deployment running 12.
  //
  // Sized from the failure rather than from a guess: 12 concurrent calls killed four
  // reviews in 2.5 minutes, and the deployment has been healthy at the 2 that
  // the old shared knob used to imply. Four left room above the known-good figure
  // while staying well under the known-bad one, and work above it queues rather than
  // failing, so being wrong low costs latency and being wrong high costs quota.
  //
  // Both knobs are gone (D-98, D-101); this is kept as the record of what was measured — the
  // number that matters is the provider's and we cannot see it.
  // opencode protects its server with basic auth when OPENCODE_SERVER_PASSWORD is
  // set, and returns a bare 401 with no hint when it is missing. Reading the same
  // variables opencode itself reads means a protected server works without any
  // extra configuration here.
  ...(process.env["OPENCODE_SERVER_USERNAME"] !== undefined
    ? { username: process.env["OPENCODE_SERVER_USERNAME"] }
    : {}),
  ...(process.env["OPENCODE_SERVER_PASSWORD"] !== undefined
    ? { password: process.env["OPENCODE_SERVER_PASSWORD"] }
    : {}),
};

/**
 * What the orchestrator needs from a reviewer.
 *
 * An interface rather than the class, so the review loop can be exercised end to
 * end without a model, a network or an API key. The loop is the part most likely to
 * be wrong and the part hardest to debug against a live model; separating them is
 * what makes it testable at all (PROG.md: pure core, effectful edges).
 */
export interface ReviewerLike {
  review(
    tier: Tier,
    /** One prompt, or the initial/continued pair a kept session needs (D-80). */
    prompt: Prompt,
    worktree: string,
    reviewId?: string,
    /** Asked once a provider slot is won: `false` means do not spend it. */
    stillWanted?: () => boolean,
    /**
     * This call exists only to re-test a route lore already believes is down (D-94).
     *
     * Bounds the call at `ReviewerConfig.probeTimeoutMs` instead of the ordinary
     * `timeoutMs` — a probe that goes quiet must not itself become a long wait, repeated
     * every `PROBE_INTERVAL_MS`. Optional so a fake reviewer need not model it; absent
     * means the ordinary bound applies, unchanged.
     */
    probing?: boolean,
  ): Promise<ReviewerResult>;
  /**
   * Stop this review's in-flight model call, and stop paying for it.
   *
   * Optional so a fake reviewer need not model it. Returns whether anything was
   * actually aborted — a cancel that reports success while the agent keeps exploring
   * is the failure this project refuses, and the caller says which happened.
   */
  cancel?(reviewId: string): Promise<boolean>;
  /**
   * End every session this review was holding, whatever its ending was (D-80).
   *
   * Optional so a fake reviewer need not model it. Not optional in production: a kept
   * session is deliberately never cleared per round, so this is the only thing that closes
   * one, and 128 admitted reviews across three tiers is 384 sessions if nothing does.
   */
  release?(reviewId: string): Promise<void>;
  /** Reviews still holding a kept session, so the worker can end the orphans (D-80). */
  keptReviews?(): readonly string[];
  /**
   * Ask a tier for something that is not findings — a knowledge screen, a proposal.
   *
   * Optional for the same reason `cancel` is: a fake reviewer in a round test has no
   * business modelling it, and a round whose reviewer cannot answer this simply ingests
   * without screening and stamps the rows so the next one retries. A knowledge base is
   * never emptied because a classifier was unavailable.
   */
  askFor?<T>(
    tier: Tier,
    /** One prompt, or the initial/continued pair a kept session picks from (D-80). */
    prompt: Prompt,
    worktree: string,
    extract: (text: string) => Listed<T>,
    contract: string,
    /** The review this belongs to, so a cancel can reach it. Absent outside a review. */
    reviewId?: string,
    /** Asked once a provider slot is won: `false` means do not spend it. */
    stillWanted?: () => boolean,
    /** Same meaning as `review()`'s own `probing` — see there. */
    probing?: boolean,
  ): Promise<SessionResult<T>>;
  /**
   * Characters of prompt this tier can hold, or `undefined` if unknown.
   *
   * The round compacts the diff to fit before spending anything. Optional so a fake
   * reviewer need not model a window; absent means "do not compact", which is the
   * safe direction — an unmeasurable tier must not be quietly given less to read.
   */
  promptBudgetChars?(tier: Tier): Promise<number | undefined>;
  /**
   * In-flight and waiting model calls, for the operator view.
   *
   * D-26 asks one question — *is parallelism actually running, or silently queueing?*
   * — and `/status` could only answer it for the local half, because until the gate
   * existed nothing queued on the remote half; it just failed. Optional, so a fake
   * reviewer in a test is not forced to model a bound it does not have.
   */
  gateState?(): GateState;
}

/**
 * What one paid session produced, whatever it was asked for.
 *
 * `ReviewerResult` is this with the items named `findings`, kept as its own type because
 * every caller of `review()` reads that name and a rename would touch the whole ladder
 * to say nothing new.
 */
export interface SessionResult<T> {
  readonly items: readonly T[];
  readonly raw: string;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly retried: boolean;
  readonly steps: number | undefined;
  readonly rejected: readonly string[];
}

export interface ReviewerResult {
  readonly findings: readonly Finding[];
  readonly raw: string;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** Set when the model's first answer had to be re-requested. */
  readonly retried: boolean;
  /**
   * Agentic turns this review took, or `undefined` when the count could not be taken
   * — either opencode could not be asked, or it answered and no step-start part was
   * found. Both mean "not measured"; neither means "explored nothing".
   *
   * Never `0` as a stand-in for "did not find out" (`countStepParts`): the whole
   * point of the number is to accumulate a distribution, and a failed measurement
   * that reads as *explored nothing* would drag that distribution toward zero
   * exactly when the measurement was broken (D-50).
   */
  readonly steps: number | undefined;
  /**
   * Findings this tier produced that the schema refused, one line each.
   *
   * Empty is the normal case. Non-empty means the tier looked at the code and said
   * something we could not accept — which is not the same as the tier finding
   * nothing, and must never be reported as though it were (INV-1, D-66).
   */
  readonly discarded: readonly string[];
}

/**
 * What a reviewer's session may never do, as opencode permission rules (see
 * `createSession` for why they live on the session rather than in the agent file).
 *
 * Read and search are left on deliberately: an agentic reviewer that can explore
 * the repo measured 70.5% higher comment acceptance than one handed a diff, and
 * exploring needs reading.
 *
 * Exported so a test can hold the list against the actions opencode checks — a rule
 * naming an action nothing asks for denies nothing, and reads as if it did.
 */
export const DENY_RULES: readonly { readonly action: string; readonly resource: string; readonly effect: "deny" }[] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
];

const READ_ONLY_SYSTEM = [
  "You review code. You never modify it.",
  "You may read, search and run read-only shell commands. You must never write, edit or patch a file, and never",
  "run a command that mutates the repository, the index, or anything outside a temp dir.",
  "`git add`, `git commit`, `git checkout`, `git reset` and `git stash` are all forbidden.",
].join("\n");

/**
 * Carries the HTTP status out of the SDK call, which reports failures by return
 * value rather than by throwing.
 */
class HttpStatus extends Error {
  readonly status: number;
  /** opencode's own classification (`provider.auth`, …) when the failure was a session record's. */
  readonly kind: string | undefined;

  constructor(status: number, detail: string, kind?: string) {
    super(`opencode returned ${status}: ${detail}`);
    this.name = "HttpStatus";
    this.status = status;
    this.kind = kind;
  }
}

/**
 * THE SESSION IS GONE FROM OPENCODE — its own type, not a status to sniff for.
 *
 * Only reachable since kept session ids became durable: a stored id can outlive the
 * session it names (opencode's volume replaced, its data pruned, this database restored
 * from a backup older than the session). It needs to survive `ask`'s classifier
 * untouched, and the first version did not — it was thrown as a plain `HttpStatus`, the
 * classifier turned every unrecognised status into `DidNotRun`, and the recovery below
 * could no longer tell a vanished session from a model that answered badly. Caught by the
 * test that asserts the cold restart happens exactly once.
 */
class SessionGone extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`opencode has no session ${sessionId}`);
    this.sessionId = sessionId;
  }
}

/**
 * A request the provider refused before generating anything — a 400 that no classifier in
 * `ask` recognised as quota, a credential, an oversized prompt or lore's own cancel.
 *
 * On a RESUMED session the only thing a cold request changes is the history, so
 * `conductSession` retries cold once to tell the two apart. Found live on 2026-09-24:
 * opencode restarted twice under a t2 round, and the kept Kimi session came back holding
 * the interrupted turn as an EMPTY assistant message — every later call on it answered
 * `400: the message at position 79 with role 'assistant' must not be empty` before
 * generating a token, and the review failed. Nothing ever forgot that session, so D-80's
 * continuity guaranteed the same refusal on every round that tier had left.
 *
 * A `DidNotRun` carrying the identical message, so every caller that does not know this
 * class treats it exactly as the plain failure it replaced; only `conductSession` looks
 * closer, and only at a session it resumed.
 */
class HistoryRejected extends DidNotRun {}

/** How soon a failed pending-permission list is asked again (see `sweepPermissions`). */
const PERMISSION_SWEEP_RETRY_MS = 3_000;

/** `openrouter/z-ai/glm-5.2` → provider `openrouter`, model `z-ai/glm-5.2`. */
export function splitModel(id: string): { providerID: string; modelID: string } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new DidNotRun(`model id '${id}' is not provider/model`);
  }
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

/**
 * ~4 characters per token. Rough, and only ever used with a wide margin — module-level
 * so `src/ladder-setup/`'s own fallback-caller sizing (a different rough estimate, same
 * factor) can share this one rather than keeping its own copy: found by lore's own
 * review, fingerprint 30e50116, before the second copy had drifted, but exactly the
 * shape ("one thing defined twice always disagrees eventually") this codebase keeps
 * being burned by once it does.
 */
export const CHARS_PER_TOKEN = 4;

export class Reviewer implements ReviewerLike {
  /** Every finite request, through `longFetch` — `session.wait` lasts as long as the model does. */
  private readonly client: OpenCodeClient;
  /**
   * The event stream only, through ordinary `fetch`.
   *
   * A SECOND CLIENT BECAUSE `longFetch` BUFFERS: it resolves a response at `end`, and the
   * stream never ends, so subscribing through it would wait for ever and deliver nothing —
   * every refusal D-91 exists to catch in seconds would again cost the full deadline. The
   * stream does not need the long timeout anyway: opencode sends keepalives, and `listen`
   * reconnects whatever ends it.
   */
  private readonly stream: OpenCodeClient;
  private readonly cfg: ReviewerConfig;
  private readonly gate: Gate;
  /** Lazily fetched, cached for the process: model id -> advertised context window. */
  private limits: Promise<Map<string, number>> | undefined = undefined;
  /**
   * review id -> every opencode session CURRENTLY reading for it, so `cancel` can stop
   * all of them.
   *
   * A SET, not a single id, since D-109: a rung runs several members concurrently on one
   * review id, and a plain `Map<string, string>` had the second member's `set` silently
   * overwrite the first's entry — so `cancel` aborted whichever session registered last
   * and the other kept exploring, unaborted, until its own deadline (the exact
   * ~3.7M-cached-token leak the comment below this map already measures, made the normal
   * shape of every mid-deep-phase cancel rather than a rare race).
   */
  private readonly sessions = new Map<string, Set<string>>();
  /**
   * Sessions KEPT ACROSS ROUNDS, one per (review, tier), for tiers with `conversation` on
   * (D-80). Separate from `sessions` above, which is the per-round handle a cancel uses
   * and is cleared every round by design.
   *
   * A PROCESS-LOCAL CACHE over `cfg.keptSessions`, which is where these actually live.
   *
   * This was the only copy, and in memory only — so a lore restart lost every warm
   * conversation and the next round of every open review started COLD, re-reading the
   * whole diff at full price. opencode had not lost anything: its sessions are in a named
   * volume that outlives the container. Only the ids were gone, and nothing reported it,
   * so a deploy quietly cost far more than the one interrupted round it was supposed to.
   *
   * Vany: *"deployment must not kill the full ladder, may be one step."*
   *
   * Still a Map because the lookup is on every turn and the port is a database; the port
   * is consulted only when this misses, which after a restart is once per tier.
   */
  private readonly kept = new Map<string, string>();
  /**
   * session id -> the controller for OUR request to it.
   *
   * Separate from `sessions` because they answer different questions and have different
   * lifetimes: `sessions` says which session belongs to a review, this says which socket
   * is still open. `propose` has no review id and so no entry in the first map, but its
   * request hangs exactly as a review's does.
   */
  private readonly aborters = new Map<string, AbortController>();
  /**
   * session id -> what to do when opencode says something about that session.
   *
   * The whole point of D-91. `session.prompt` is one long HTTP request that tells us
   * nothing until it returns, but opencode is *narrating the same call* on `/event` — and
   * during an exhausted-plan hang the narration is the only place the answer exists.
   */
  private readonly watchers = new Map<string, (status: OpencodeStatus) => void>();
  /**
   * session id -> "something happened for this session," for whoever only needs to know
   * a call is alive rather than what it said (D-138's probe bound).
   *
   * NOT folded into `watchers` above: that map is typed to `SessionStatus` — idle, busy,
   * retry — a STATE-TRANSITION channel, not a progress one. `message.part.updated`
   * streams a `delta` per token and carries no `SessionStatus` at all; forcing it through
   * `watchers`'s callback shape would mean inventing a fake status for it or widening what
   * every OTHER watcher has to handle. Found by lore's own review, fingerprint a2ea8a61:
   * the first version of the probe re-arm listened only to `session.status`, which is a
   * busy/idle/retry state machine that can sit on ONE state for the whole of a long turn
   * — so a healthy session generating for minutes past a turn's opening `busy` narrated
   * nothing the re-arm could see, and was killed exactly as the flat timer had been.
   */
  private readonly activity = new Map<string, () => void>();
  /** The subscription, started on first use and never restarted twice at once. */
  private listening?: Promise<void>;
  private closed = false;
  /**
   * Aborts the event subscription itself, because a flag cannot.
   *
   * `closed` is only observed when an event ARRIVES or the stream errors — and an idle
   * stream yields neither, so `for await` blocks for ever, the socket stays open, and the
   * process is held past its work. That is the exact thing `main.ts` says calling `close`
   * prevents, which it did not.
   */
  private listener?: AbortController;

  constructor(cfg: ReviewerConfig = DEFAULT_REVIEWER) {
    this.cfg = cfg;
    // No limit to pass any more: a round launches its session immediately and this only
    // counts what is out (D-98). The bound that remains is admission, at review_start.
    this.gate = new Gate();
    const basic =
      cfg.password === undefined
        ? undefined
        : `Basic ${Buffer.from(`${cfg.username ?? V2_USER}:${cfg.password}`).toString("base64")}`;
    const headers = basic === undefined ? undefined : { Authorization: basic };
    this.client = OpenCode.make({
      baseUrl: cfg.baseUrl,
      // Node's fetch gives up after 300s with a bare "fetch failed". A deep tier
      // routinely takes longer than that, and losing a review to an invisible
      // transport default is the worst kind of failure: it looks like the model.
      fetch: longFetch(cfg.timeoutMs) as typeof globalThis.fetch,
      ...(headers === undefined ? {} : { headers }),
    });
    this.stream = OpenCode.make({ baseUrl: cfg.baseUrl, ...(headers === undefined ? {} : { headers }) });
  }

  /**
   * Stop whatever this review has in flight, and stop paying for it.
   *
   * ABANDONING A CALL DOES NOT STOP THE MODEL. Measured on this deployment: three t2
   * calls that failed client-side went on to consume ~3.7M cached-read tokens between
   * them, because the agent kept exploring the repository after lore had stopped
   * listening. A cancel that only marks a row is worse than none — the operator sees a
   * stopped review and has no reason to suspect it is still running and still billing.
   *
   * Best-effort by construction: if no round is in flight there is nothing to abort,
   * and a failed abort must not fail the cancellation. It says so rather than
   * pretending, because "cancelled" that kept spending is exactly the confident false
   * statement this project exists to refuse.
   */
  /**
   * Listen to what opencode says about its own work, once, for the life of the process.
   *
   * THE CHANNEL WE WERE NOT READING (D-91). `session.prompt` is one long HTTP request
   * that tells us nothing until it returns; opencode narrates the same call on `/event`.
   * Measured 2026-08-09 against an exhausted Z.ai plan: the request hung for the full
   * 2700s deadline, while the stream carried the provider's exact refusal — *and its
   * reset time* — SEVEN SECONDS after the prompt was sent, then four more times inside
   * ninety seconds. Forty-five minutes of waiting for a fact that had already arrived.
   *
   * D-84 said opencode swallows the limit and the reset time. It swallows them in the
   * message body, which is where we were looking, and publishes them here.
   *
   * Lazily started, because a Reviewer that never calls a model should not hold a socket
   * open — the CLI builds one per invocation.
   */
  private listen(): void {
    if (this.listening !== undefined || this.closed) return;
    this.listening = (async () => {
      // Reconnects for as long as the process wants sessions watched. A stream that dies
      // is not a fault to report on its own: opencode restarts, and the deadline is still
      // there as the backstop for everything this loop is not awake for.
      while (!this.closed) {
        try {
          this.listener = new AbortController();
          for await (const ev of this.stream.event.subscribe({ signal: this.listener.signal })) {
            if (this.closed) break;
            const e = ev as { type?: string; data?: Record<string, unknown> };
            // EVERY (RE)CONNECT SWEEPS WHAT WAS MISSED. The stream has no replay, so a
            // `permission.asked` published while it was down — the two seconds between
            // reconnects, or an opencode restart — would never arrive, and that session
            // would sit parked until the 45-minute deadline. `server.connected` is the
            // first event of every connection, so asking then closes the gap.
            // lore-ok[8781d7cd]: the reconnect gap is closed here — see the sweep below.
            if (e.type === "server.connected") {
              void this.sweepPermissions();
              continue;
            }
            const id = typeof e.data?.["sessionID"] === "string" ? e.data["sessionID"] : undefined;
            if (id === undefined) continue;
            // ACTIVITY: every `session.*` event carries a flat `data.sessionID`, so one read
            // covers them all. v1 nested the id three different ways and a type list missed
            // one of them for weeks (`message.updated`); here the type is only a prefix, so
            // a narration type added upstream counts without anyone remembering to list it.
            // Same isolation as the watcher below: one session's callback must not be able
            // to blind the stream for every other session's events.
            if (e.type?.startsWith("session.") === true) {
              try {
                this.activity.get(id)?.();
              } catch (err) {
                console.error(`[lore:log] an activity callback threw: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            // A PERMISSION NOBODY WILL ANSWER. opencode asks when no rule decides, and on a
            // headless server the ask waits for ever: measured on 2.0.20, a reviewer reading
            // `/etc/hosts` parked its session on `permission.asked` and `session.wait` never
            // returned — a review dying at the 45-minute deadline over a question no person
            // could see. Refused at once instead, with the reason the model is told, so the
            // agent carries on without it; logged, because a refusal is a fact about what
            // the tier could not read.
            if (e.type === "permission.asked" && this.watchers.has(id)) {
              // A refusal that fails is retried through the sweep, which lists the session's
              // pending asks again — this one among them, since it is still pending.
              void this.refusePermission(id, e.data ?? {}).then((ok) => {
                if (!ok) this.retrySweep([id]);
              });
              continue;
            }
            const status = statusOf(e.type, e.data ?? {});
            if (status === undefined) continue;
            // GUARDED, because a watcher that throws lands in the silent catch below,
            // ends the `for await`, and reconnects — losing every other session's events
            // for two seconds and telling nobody. A watcher's job is to fail ONE call
            // fast; it must not be able to blind the stream for all of them.
            try {
              this.watchers.get(id)?.(status);
            } catch (err) {
              console.error(`[lore:log] a session watcher threw: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch {
          // lore-ok[8781d7cd]: what the reconnect gap missed is swept on the next
          // `server.connected` (above), and a failed sweep or refusal retries on its own timer.
          // Deliberately silent and deliberately not fatal. This is an optimisation: with
          // the stream up a dead provider costs seconds, and without it the 2700s deadline
          // does what it always did. Logging every reconnect would train a reader to skip
          // the log, and failing a review because a side-channel dropped would be worse
          // than the problem it solves.
        }
        if (this.closed) break;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    })();
  }

  /** Stop listening. Idempotent; the CLI and the tests both end without a service. */
  close(): void {
    this.closed = true;
    // The flag alone leaves an idle stream blocked in `for await` with its socket open.
    // Aborting is what actually ends it; the flag is what stops the loop reconnecting.
    this.listener?.abort(new Error("reviewer closed"));
  }

  /**
   * Refuse a permission opencode asked about, for a session lore is waiting on.
   *
   * REFUSED, never granted: a reviewer that wants something no rule allows wants something
   * a reviewer should not have, and `reject` hands the model the reason so it carries on
   * without it — measured on 2.0.20, it answered "I can't read that file" and finished.
   * A refusal that itself fails leaves the session parked until the deadline, so that is
   * logged loudly: the review will then fail as a hang, and this line says why.
   */
  /**
   * Refuse every permission already waiting on a session lore is waiting on — the asks the
   * stream could not deliver while it was down.
   *
   * A LIST OR A REFUSAL THAT FAILS IS ASKED AGAIN, on its own timer. "The next reconnect
   * asks again" was the first version's answer, and it is no answer: once the stream is
   * back it may stay up for the whole turn, so an ask behind one failed request — the list,
   * or the reply to an ask the list did find — sat parked until the 45-minute deadline.
   * Retried every few seconds while that session is still being waited on, and only for
   * the sessions that failed.
   */
  private async sweepPermissions(sessions: readonly string[] = [...this.watchers.keys()]): Promise<void> {
    const failed: string[] = [];
    for (const sessionId of sessions) {
      if (!this.watchers.has(sessionId)) continue;
      const pending = await this.client.permission.list({ sessionID: sessionId }).catch((e: unknown) => {
        console.error(`[lore:log] could not list pending permissions of session ${sessionId}: ${detail(e)} — asking again shortly`);
        failed.push(sessionId);
        return [];
      });
      for (const p of pending) {
        if (!(await this.refusePermission(sessionId, p as unknown as Record<string, unknown>)) && !failed.includes(sessionId)) {
          failed.push(sessionId);
        }
      }
    }
    this.retrySweep(failed);
  }

  /** Sweep these sessions again shortly, if any — see `sweepPermissions`. */
  private retrySweep(sessions: readonly string[]): void {
    if (sessions.length === 0 || this.closed) return;
    const t = setTimeout(() => void this.sweepPermissions(sessions), PERMISSION_SWEEP_RETRY_MS);
    // `unref`'d: a retry pending must not hold the process open past its work.
    t.unref?.();
  }

  /** Whether the refusal reached opencode — `false` sends the session back through the sweep. */
  private async refusePermission(sessionId: string, request: Record<string, unknown>): Promise<boolean> {
    const requestId = typeof request["id"] === "string" ? request["id"] : undefined;
    const what = `${String(request["action"] ?? "?")} on ${JSON.stringify(request["resources"] ?? []).slice(0, 200)}`;
    if (requestId === undefined) {
      console.error(`[lore:log] session ${sessionId} asked for a permission (${what}) with no request id — cannot refuse it; the session will wait until the deadline`);
      // Not retried: no id is a shape problem a second try cannot fix.
      return true;
    }
    const failure = await this.client.permission
      .reply({
        sessionID: sessionId,
        requestID: requestId,
        decision: "reject",
        message: "lore reviewers run unattended and read only the worktree under review — nobody can grant this. Carry on without it.",
      })
      .then(() => undefined)
      .catch((e: unknown) => detail(e));
    console.error(
      failure === undefined
        ? `[lore:log] refused a permission session ${sessionId} asked for: ${what}`
        : `[lore:log] could NOT refuse the permission session ${sessionId} asked for (${what}): ${failure} — asking again shortly`,
    );
    return failure === undefined;
  }

  async cancel(reviewId: string): Promise<boolean> {
    // lore-ok[4926151e]: THE IN-FLIGHT ABORT GOES FIRST, not `release`. It used to be the
    // other way round, on the reasoning that release must not be SKIPPED — true, but no
    // reason to make it go first too. `abort`'s own comment states the invariant this
    // violated: freeing our own socket is instant and must not wait behind a network call
    // that can hang, and `release` below is exactly such a call — one `DELETE /session` per
    // kept session, sequentially awaited. On a wedged opencode (the 2026-08-08 shape `abort`
    // was built for) the old order held a cancelling client behind that DELETE while the
    // in-flight model request's own socket — and its spend — stayed open toward the
    // 45-minute deadline. Reordering costs nothing: `live` is read from `this.sessions`,
    // untouched by `release` (which only ever touches `this.kept`), so which runs first
    // changes nothing about what either one finds.
    const live = this.sessions.get(reviewId);
    const hadLive = live !== undefined && live.size > 0;
    if (hadLive) {
      // EVERY LIVE SESSION, not the first or the last — a rung can hold several at once
      // (D-109), and each is a real model call spending real quota until it is told to
      // stop. `Promise.allSettled` so one session's abort failing (`abort` is already
      // best-effort and never throws, but nothing upstream should depend on that staying
      // true) cannot skip the rest.
      await Promise.allSettled([...live].map((id) => this.abort(id)));
      this.sessions.delete(reviewId);
    }

    // KEPT SESSIONS GO TOO, and this is the path that would otherwise leak them (D-80).
    //
    // `review_cancel` is terminal, but it does not come through the worker unless a round
    // happened to be in flight — a review sitting in `findings_ready` is cancelled with no
    // job running, so `releaseIfFinished` never fires and the sessions this review opened
    // would live in opencode until opencode itself restarted. UNCONDITIONAL, still: an
    // early return here would recreate the exact leak this comment is about, so it runs
    // whether or not anything was live to abort above.
    await this.release(reviewId);

    return hadLive;
  }

  /**
   * The last free moment before the shared gate counts this call — which, since D-101
   * deleted the worker pool `Gate.run` used to queue behind, is now a scheduling gap
   * rather than a real wait: nothing here holds a session, because the session does not
   * exist until `conductSession` runs, so a cancel landing in the moment between a
   * round dispatching several calls (a rung, D-109) and this one's own turn reaching the
   * gate is still worth catching before `run` spends anything.
   *
   * lore-ok[40b5d6e5]: this docblock used to describe a LONGER wait — "a call can wait
   * a long time at the provider gate, that is what the gate is for" — which was true
   * before D-101 and is not now (`gate.ts`: "everything admitted STARTS AT ONCE").
   * Found by lore's own review: the real remaining gap is not here at all, it is
   * `createSession`'s own await inside `conductSession` — a genuine network round trip,
   * checked nowhere between this entry check and the session's registration into
   * `sessions`/`kept`. That gap has its own check, at the one place it can act on a
   * fresh session it just opened; this one still guards the (now much narrower) window
   * it always could.
   *
   * lore-ok[b9319d46]: WE STOPPED THIS, same as `conductSession`'s own post-createSession
   * check a few lines below (b9319d46's own report was about that one, and this is its
   * identical twin, found reading the sibling it names). `CancelledByLore`, not a plain
   * `DidNotRun` — `runMember`'s catch (review.ts) rethrows `CancelledByLore` untouched and
   * would otherwise book this as the tier's own failure, and on a second strike step the
   * ladder and overwrite an already-`cancelled` review's state.
   */
  private guard<T>(reviewId: string | undefined, stillWanted: (() => boolean) | undefined, run: () => Promise<T>) {
    return this.gate.run(() => {
      if (stillWanted?.() === false) {
        throw new CancelledByLore(
          `review ${reviewId ?? "?"} was ended while this call waited for a provider slot — nothing was spent on it.`,
        );
      }
      return run();
    });
  }

  /**
   * Run one tier against one prompt.
   *
   * **One session per tier RUN, or per (review, tier) when the tier keeps it (D-80).**
   * It was a fresh session every round until 2026-08-12, and the sentence that used to
   * stand here — "a fresh session per tier run, not a pool" — was the load-bearing claim:
   * never a pool. That part is unchanged and is what matters. opencode sessions are
   * single-flight, and the predecessor's pool existed to work around a global lock that no
   * longer exists (INV-5, INV-6) — reviews are already parallel because each has its own
   * worktree, so SHARING a session between reviews would only reintroduce contention.
   *
   * What `conversation` adds is continuity along one review's own rounds, and those are
   * sequential by CONSTRUCTION rather than by convention: `claimJob` will not claim a job
   * whose review already has one running — `NOT EXISTS (… r.review_id = j.review_id AND
   * r.state = 'running')`, inside the claiming transaction. So a kept session is only ever
   * spoken to by one round at a time, which is the property opencode's single-flight
   * sessions need and the reason this is not a pool by another name.
   */
  async review(
    tier: Tier,
    prompt: Prompt,
    worktree: string,
    reviewId?: string,
    stillWanted?: () => boolean,
    probing?: boolean,
  ): Promise<ReviewerResult> {
    if (tier.model === undefined) throw new DidNotRun(`tier ${tier.id} has no model`);
    // The gate wraps the SESSION, not the request. What loads a provider is the
    // agentic exploration between them (`gate.ts`), so bounding individual HTTP calls
    // would bound nothing. Waiting here queues the round instead of failing it, which
    // is the same trade as backpressure: a review that dies on a 429 did not run.
    const r = await this.guard(reviewId, stillWanted, () =>
      this.conductSession<Finding>(
        tier, prompt, worktree, reviewId, findingsOf, OUTPUT_CONTRACT, false, stillWanted, probing,
      ),
    );
    return { ...r, findings: r.items, discarded: r.rejected };
  }

  /**
   * Ask a tier for something that is NOT findings — `propose`'s proposals today.
   *
   * Same gate, same retry, same abort-on-failure: a session that costs quota is a
   * session that costs quota, and `propose` running outside the gate is what would
   * burst past the provider ceiling that once killed four reviews in 2.5 minutes
   * (`spec/propose.md` §7).
   */
  async askFor<T>(
    tier: Tier,
    prompt: Prompt,
    worktree: string,
    extract: (text: string) => Listed<T>,
    contract: string,
    /**
     * The review this session belongs to, so `review_cancel` can abort it.
     *
     * Hard-coded `undefined` here until the knowledge screen became the first `askFor`
     * caller running INSIDE a review. That made the session uncancellable: a client
     * cancelling mid-screen was told nothing was in flight — truthfully, by the
     * bookkeeping — while the screen went on spending its quota. Optional because
     * `propose` genuinely has no review to belong to.
     */
    reviewId?: string,
    /** Asked once a gate slot is won: `false` means do not spend it. See `guard`. */
    stillWanted?: () => boolean,
    probing?: boolean,
  ): Promise<SessionResult<T>> {
    if (tier.model === undefined) throw new DidNotRun(`tier ${tier.id} has no model`);
    return this.guard(reviewId, stillWanted, () =>
      this.conductSession<T>(tier, prompt, worktree, reviewId, extract, contract, false, stillWanted, probing),
    );
  }

  gateState(): GateState {
    return this.gate.state();
  }

  /**
   * The share of a context window the OPENING prompt may occupy.
   *
   * Derived from our own completed runs, not chosen. A t1 review that finished sent a
   * 218 KB diff — roughly 54k tokens — and its session recorded 135k–155k tokens
   * against a 200k window by the time it answered. So agentic exploration multiplied
   * the opening prompt by about three (D-50: an agent re-sends its accumulated context
   * every turn). A prompt at a third of the window leaves room for that; a prompt at
   * 95% of it, which is what the 741 KB branch produced, cannot even begin.
   *
   * Deliberately generous rather than tight. Refusing a tier that would have coped is
   * the expensive mistake here — it costs an independent opinion — so this only fires
   * where there is no plausible way through.
   */
  private static readonly PROMPT_SHARE = 0.35;

  /**
   * How many characters of prompt this tier can be given.
   *
   * The round asks before it builds, and compacts the diff to fit (`review.ts`). The
   * limit comes from opencode's provider config rather than from a tiers file, for
   * D-74's reason: model facts come from the provider, never from memory or from a
   * name — `k3` carries 1M and `k3-256k` carries 262k, the suffix naming the smaller —
   * and a second copy in config is a copy that drifts.
   *
   * `undefined` when the model is unknown to us, and the caller must then compact
   * nothing: declining to review because a lookup failed would be a silent skip, which
   * is the failure this whole path exists to remove.
   */
  async promptBudgetChars(tier: Tier): Promise<number | undefined> {
    // A NICKNAME BUDGETS TO THE SMALLEST WINDOW IN ITS POOL. The prompt is built before
    // the round picks a route, so it must fit WHICHEVER route the roll lands on —
    // budgeting to the largest would overflow the smaller twin on a bad roll, and
    // budgeting to none (what a nickname resolved to before this: `contextLimit` found
    // no such model and returned undefined) silently disabled the fit-check for exactly
    // the tiers pools were built for.
    const model = tier.model ?? "";
    const routes = model.includes("/") ? [model] : routesFor(tier, loadPools());
    const limits = (await Promise.all(routes.map((r) => this.contextLimit(r)))).filter(
      (l): l is number => l !== undefined,
    );
    const limit = limits.length === 0 ? undefined : Math.min(...limits);
    return limit === undefined ? undefined : Math.floor(limit * Reviewer.PROMPT_SHARE * CHARS_PER_TOKEN);
  }

  /**
   * Advertised context window for a provider-qualified model id. A SUCCESSFUL read is
   * cached per process — the provider list does not change while lore runs — but a
   * FAILED one is not: see the retry-on-failure reasoning immediately below.
   *
   * lore-ok[277d5b24]: NOT CACHED ON FAILURE, not any more. `.catch(() => undefined)`
   * used to feed a fetch that failed straight into the same map a success builds, so
   * ONE dropped `/config/providers` call — a cold opencode container, a request racing
   * its own startup — cached an EMPTY map for the rest of the process, indistinguishable
   * from "no models configured": `promptBudgetChars` and D-80's 2/3-window compaction
   * (`compactIfFull`) both read an unmeasurable window as "skip", and nothing said why.
   * That is the exact failure this rewrite closes: `this.limits` is reset to `undefined`
   * inside the `.catch()` below, in the SAME microtask that resolves the failed fetch, so
   * the very next caller — same round, same process, no restart needed — sees
   * `this.limits === undefined` again and triggers a fresh `.providers()` call rather
   * than reading the empty map back. Proven directly: "retries on the next call instead
   * of caching the failure forever" (opencode.test.ts) fails on the pre-fix code and
   * passes here, toggling only the fixture's `providersDown` flag between two calls on
   * the SAME `Reviewer` instance — the exact shape of a container that drops one request
   * and answers the next.
   * Now a failure resets `this.limits` so the NEXT call retries instead of inheriting
   * a permanent false negative, and says so on `[lore:log]` — silent was the defect.
   */
  private async contextLimit(model: string): Promise<number | undefined> {
    if (this.limits === undefined) {
      this.limits = this.models()
        .then((models) => {
          // AN EMPTY CATALOGUE IS A FAILED READ, not a fact: opencode documents `/api/model`
          // as a snapshot that "may precede initial plugin settlement", and a lore that
          // cached that emptiness would treat every window as unmeasurable for the life of
          // the process — no fit-check, no compaction, and nothing saying why. Thrown, so
          // the catch below resets the cache and the next call asks again.
          if (models.length === 0) throw new Error("opencode listed no models (its catalogue may still be loading)");
          const out = new Map<string, number>();
          for (const m of models) {
            if (typeof m.context === "number" && m.context > 0) out.set(m.id, m.context);
          }
          return out;
        })
        .catch((e: unknown) => {
          this.limits = undefined;
          console.error(`[lore:log] could not read /api/model for context limits (${detail(e)}) — will retry next call`);
          return new Map<string, number>();
        });
    }
    return (await this.limits).get(model);
  }

  /**
   * Every model opencode can reach right now, as `provider/model` with its advertised window.
   *
   * `/api/model` lists only what a CONNECTED provider offers — measured on 2.0.20: 17 models
   * with one Z.ai key, 407 once OpenRouter was connected too — which is the question both
   * callers are actually asking. v1's `/config/providers` answered it the same way.
   */
  private async models(): Promise<readonly { readonly id: string; readonly context: number | undefined }[]> {
    const res = await this.client.model.list();
    // `enabled: false` is listed and cannot be called — counting it would report a fallback
    // ready that fails only when the subscription it backs has already run out.
    return res.data
      .filter((m) => m.enabled !== false)
      .map((m) => ({ id: `${m.providerID}/${m.id}`, context: m.limit?.context }));
  }

  /**
   * Which of these model ids opencode can actually reach, asked once at startup (D-93).
   *
   * A fallback is a promise about what happens when a subscription runs out, and the
   * moment it is configured an operator stops worrying about that case. A promise that
   * cannot be kept is worse than none: the failure arrives at the worst possible time,
   * looks like the provider being down, and the plan that was made around it was made for
   * nothing. So it is checked when someone is watching rather than when it is needed.
   *
   * Returns what is MISSING, not a boolean, because the caller has to name them — "a
   * fallback is unavailable" sends nobody anywhere.
   *
   * A provider list that cannot be fetched returns `[]` rather than "everything is
   * missing": opencode being unreachable at startup is its own condition with its own
   * message, and reporting it as a ladder misconfiguration would send an operator to edit
   * a tiers file that is perfectly correct.
   */
  async missingModels(ids: readonly string[]): Promise<readonly string[] | undefined> {
    const models = await this.models().catch(() => undefined);
    // `undefined` IS NOT AN EMPTY LIST. Returning `[]` here collapsed "opencode was
    // unreachable" and "the response was not the shape we expect" into the same value as
    // "every fallback is present" — and the caller then announced the fallback ready,
    // which is INV-1 in the one line an operator reads to believe it. A check that did
    // not run must never report as a check that found nothing.
    if (models === undefined || models.length === 0) return undefined;
    const known = new Set(models.map((m) => m.id));
    return ids.filter((id) => !known.has(id));
  }

  /** What `review` does once it holds a slot. */
  private async conductSession<T>(
    tier: Tier,
    prompt: Prompt,
    worktree: string,
    reviewId: string | undefined,
    extract: (text: string) => Listed<T>,
    contract: string,
    /**
     * Set on the ONE retry that follows a resumed session opencode no longer has.
     *
     * Persisting ids makes a failure reachable that a private Map could not produce: a
     * row pointing at a session that is gone — opencode's volume replaced, its data
     * pruned, a database restored from a backup older than the session. Left alone that
     * row would fail its tier on every future round of the review, permanently, which is
     * worse than the cold start it was avoiding. So: forget, start cold, once.
     */
    noResume = false,
    /** Re-checked once `createSession` returns — see the `40b5d6e5` comment below. */
    stillWanted?: () => boolean,
    /** Same meaning as `ReviewerLike.review`'s own `probing` — see there. */
    probing?: boolean,
  ): Promise<SessionResult<T>> {
    const started = Date.now();
    // SUBSCRIBED BEFORE THE SESSION EXISTS, not after. The stream takes a moment to
    // connect and there is no replay, so events published in that window are gone.
    // Opening it first buys the whole of `createSession` as head start and costs nothing:
    // the subscription is per-process and idempotent, so this is a no-op after the first.
    this.listen();
    // THE TIER IS INITIALISED ONCE PER REVIEW (D-80). A kept session is continued with the
    // round's message; anything else — no reviewId, the flag off, a lore restart that lost
    // the map — falls through to a cold start, which is the behaviour this replaced.
    const keptKey = reviewId !== undefined && tier.conversation === true
      ? sessionKey(reviewId, tier.id, tier.model ?? "")
      : undefined;
    // MEMORY, THEN THE PORT. After a restart the map is empty and the port still knows,
    // which is the whole point of this change; `noResume` is the recovery path below
    // refusing to resume an id opencode has since forgotten.
    const continuing = keptKey === undefined || noResume
      ? undefined
      : (this.kept.get(keptKey) ?? this.cfg.keptSessions?.get(keptKey));
    const resumedFromStore = continuing !== undefined && !this.kept.has(keptKey ?? "");
    const sessionId = continuing ?? (await this.createSession(tier, worktree));
    // lore-ok[40b5d6e5]: THE GAP `guard` NO LONGER COVERS. `createSession` is a real
    // HTTP round trip to opencode, awaited above — and until this line returns, nothing
    // is registered in `sessions`/`kept`, so a `cancel()` landing during that await finds
    // nothing to abort and truthfully reports so, while the freshly-opened session goes
    // on to spend a full prompt (up to the review's own deadline) that nobody will ever
    // read. Only for a FRESH session: `continuing !== undefined` spent no await getting
    // here, so `guard`'s own entry check is still current for it.
    //
    // lore-ok[b9319d46]: `CancelledByLore`, not a plain `DidNotRun`. WE stopped this — the
    // review's own `stillWanted` reads terminal — and `runMember`'s catch (review.ts) has
    // a rule for exactly that: rethrow `CancelledByLore` untouched, never book it as the
    // tier's own failure. A plain `DidNotRun` takes the ORDINARY path instead — closed
    // `failed`, counted by `tierFailureCount` — and on a second strike (a prior, unrelated
    // failure already on record) `alreadyFailed` returns `{kind:"skipped"}`, which steps
    // the ladder and overwrites the review's already-terminal `cancelled` state with
    // whatever `settleState` computes next: the exact resurrection review.ts's own
    // "A STOP LORE CAUSED IS NOT EVIDENCE ABOUT THE TIER" fix (D-109 era) exists to
    // prevent, reopened here by naming the wrong class.
    if (continuing === undefined && stillWanted?.() === false) {
      await this.client.session.remove({ sessionID: sessionId }).catch(() => undefined);
      throw new CancelledByLore(
        `review ${reviewId ?? "?"} was ended while tier ${tier.id} was opening a session — nothing was spent on it.`,
      );
    }
    if (keptKey !== undefined && continuing === undefined) {
      this.kept.set(keptKey, sessionId);
      // WRITTEN WHEN THE SESSION IS OPENED, not when the round ends. A round that dies
      // mid-call is exactly the case this exists for, and a record written at the end
      // would not exist for any of them.
      this.cfg.keptSessions?.set(keptKey, sessionId);
    } else if (keptKey !== undefined && resumedFromStore) {
      this.kept.set(keptKey, sessionId);
    }
    if (resumedFromStore) {
      console.error(`[lore:log] ${tier.id} resumed its kept session across a restart — no cold re-read (D-80).`);
    }
    // ADDED to the review's live set, never OVERWRITING it — a rung's members register
    // concurrently under the same reviewId (D-109), and a plain overwrite here is
    // exactly what let one member's registration erase another's. Cleared in `finally`
    // whatever happens — a stale entry would have a later cancel abort a session that
    // had already ended, or worse, one belonging to a different round of the same review.
    if (reviewId !== undefined) {
      const live = this.sessions.get(reviewId) ?? new Set<string>();
      live.add(sessionId);
      this.sessions.set(reviewId, live);
    }
    // AND OUR OWN END OF THE WIRE, because telling opencode to stop does not free us.
    //
    // Measured 2026-08-08: three sessions aborted through opencode's API all answered
    // 200, and ninety seconds later `/status` still read `inFlight: 2` with no active
    // review at all. `session.prompt` is one long HTTP request, and nothing about the
    // server abandoning the model closes it — so lore went on waiting for a reply that
    // could never come, holding a provider slot for a review that no longer existed,
    // until its own 2700s deadline expired.
    //
    // Two halves of one act, and `abort` now does both: opencode stops the model, this
    // stops us waiting for it.
    const aborter = new AbortController();
    this.aborters.set(sessionId, aborter);

    // AND WE LISTEN TO WHAT OPENCODE SAYS ABOUT IT (D-91).
    //
    // This is the difference between seven seconds and forty-five minutes. The prompt
    // request tells us nothing until it returns; the event stream carries the provider's
    // refusal — with the reset time — within seconds, and then repeats it every few
    // seconds while opencode retries something that cannot succeed.
    //
    // Aborting with an `Exhausted` as the REASON is what makes this arrive at the caller
    // correctly: `longFetch` destroys the socket with `signal.reason`, so the error the
    // round catches is this exact object, carrying the provider's words and its reset
    // time. Everything downstream — D-48's step-over, `skip_if_quota`, D-90's cool-off —
    // already knows what to do with an `Exhausted`; none of it had to change.
    // AND A CLOCK ON RETRIES THE CLASSIFIER DOES NOT RECOGNISE. A refusal it knows is
    // killed in seconds below; an unknown one is a storm — opencode retrying every few
    // seconds, no error ever surfacing, the deadline the only thing that would end it.
    // The clock starts at the first retry, is CLEARED by any non-retry status (recovery
    // publishes one), and kills only when a retry is still arriving past the bound — a
    // storm that merely stops is left to the deadline, which is the honest owner of
    // silence. Aborting as `Exhausted` with no reset time is deliberate twice: the chain
    // advances on exactly that type, and an unstated time becomes the doubling backoff
    // rather than a fact nobody stated.
    let stormStart: number | undefined;
    // A PROBE'S OWN, SHORTER DEADLINE (D-94/D-138) — see `ReviewerConfig.probeTimeoutMs`.
    //
    // BOUNDS SILENCE, NOT THE CALL. The first version killed the call outright at
    // `probeMs` regardless of what opencode was doing — found by lore's own review,
    // fingerprint 9835adfe: D-94's whole premise is "a live tier just works," and a
    // recovered route's real round routinely takes MINUTES (this file's own measured
    // t2 average is 766s), so a flat kill at 90s aborted every genuine recovery before it
    // could finish, and only a completed call ever clears a mark — the probe feature
    // could never again do the one thing it exists for, on any tier whose real work
    // outruns the bound, which is every deep tier, always.
    //
    // So the timer is RE-ARMED, not merely started, on `this.activity` (see its own doc
    // comment) — ANY narrated event for this session, not only `session.status`. A STATE
    // MACHINE (idle/busy/retry) is not a progress meter: found by lore's own review,
    // fingerprint a2ea8a61, against the first version of this re-arm, which listened to
    // `session.status` alone. That channel can sit on a single `busy` for the whole of a
    // long turn, so a healthy session generating for minutes past its opening `busy`
    // narrated nothing THAT channel could see, and was killed exactly as the original flat
    // timer had been — `message.part.updated`'s own streamed `delta` is what a call that is
    // truly producing nothing cannot fake. A session that keeps narrating, on any of the
    // types `activity` recognises, is exactly as alive as an ordinary call and is left to
    // run under the same deadline as one. What the bound still catches is Kimi's actual
    // shape: a request accepted and then silent — no narration of any kind — for `probeMs`
    // at a stretch.
    // lore-ok[8f9e95c6]: real, and left open rather than guessed shut.
    // lore-ok[afaad779]: same finding, restated — both name the same gap: the clock
    // starts before dispatch, so a healthy call whose
    // FIRST narration (not just its total round) takes longer than `probeMs` to arrive
    // would also die inconclusive, and I have no measured time-to-first-event for a
    // recovered deep tier to size the bound against — SPEC D-138 already says the 90s
    // figure is one incident's data, not a distribution. Left as a judgement rather than a
    // fabricated fix because two things bound the damage while it stands: D-94's own
    // `PROBE_INTERVAL_MS` re-tries every 15 minutes regardless, so a wrongly-killed probe
    // is a DELAYED recovery, not a lost one, matching this project's own tolerance for the
    // 81-minutes-late case D-94's history already accepts; and `session.status: busy` is a
    // state transition fired at dispatch, not content-dependent, so the common case is
    // almost certainly bounded well under 90s even without a measurement to cite. If a
    // real deployment shows probes dying inconclusive on a route that later turns out
    // healthy, that is the measurement this number has been waiting for.
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    const armProbeTimer = (): void => {
      if (probing !== true) return;
      const probeMs = this.cfg.probeTimeoutMs ?? 90_000;
      probeTimer = setTimeout(() => {
        aborter.abort(
          new ProbeInconclusive(
            `tier ${tier.id} (${tier.model ?? "?"}) probe was silent for ${String(Math.round(probeMs / 1000))}s — ` +
              "still treating it as unavailable, not as freshly refused.",
          ),
        );
      }, probeMs);
      // `unref`'d for the same reason `long-fetch.ts`'s own deadline is: a pending timer
      // must not hold the process open past its work.
      probeTimer.unref?.();
    };
    armProbeTimer();
    if (probing === true) {
      this.activity.set(sessionId, () => {
        if (probeTimer === undefined) return;
        clearTimeout(probeTimer);
        armProbeTimer();
      });
    }

    this.watchers.set(sessionId, (status) => {
      const refusal = quotaRefusal(status);
      if (refusal !== undefined) {
        aborter.abort(
          new Exhausted(
            `tier ${tier.id} (${tier.model ?? "?"}) refused on quota: ${refusal.message}` +
              (refusal.resetAt === undefined ? "" : ` (opencode reported this on attempt ${String(status.attempt ?? 1)})`),
            refusal.resetAt,
          ),
        );
        return;
      }
      if (status.type !== "retry") {
        stormStart = undefined;
        return;
      }
      stormStart ??= Date.now();
      const stormMs = this.cfg.retryStormMs ?? 5 * 60_000;
      if (Date.now() - stormStart >= stormMs) {
        aborter.abort(
          new Exhausted(
            `tier ${tier.id} (${tier.model ?? "?"}) was retried by opencode for over ${String(Math.round(stormMs / 60_000))} ` +
              `minute(s) without recovering — treating the route as down and moving on. ` +
              `The last retry said: ${status.message ?? "(no message)"}`,
          ),
        );
      }
    });

    try {
      // WHICH PROMPT: the full one for a session being initialised, the round's message
      // for one being continued. A caller that passes a bare string gets it either way,
      // which is every caller that is not the review loop.
      const asked = typeof prompt === "string"
        ? prompt
        : continuing === undefined
          ? prompt.initial
          : prompt.continued;
      // THE READ-ONLY CHARTER OPENS EVERY NEW SESSION. v1 sent it as a per-request
      // `system`; v2 has no such field — a prompt is text, and the session remembers it, so
      // saying it once at the start is saying it for every later turn. It is the belt: the
      // braces are the session's own `edit: deny` rule (`createSession`), which opencode
      // enforces whatever the model decides.
      const text = continuing === undefined ? `${READ_ONLY_SYSTEM}\n\n${asked}` : asked;
      // A KEPT SESSION FOLLOWS THE WORKTREE. v1 named the directory on every prompt; v2
      // fixes it when the session is created, so a review whose worktree moved (a
      // relocation, a restore into a different data dir) would have its later rounds read
      // the old path — or nothing. One GET per resumed round to rule that out.
      if (continuing !== undefined) await this.followWorktree(continuing, worktree);
      // COMPACT BEFORE SPENDING, at two thirds of the window (D-80). Measured on the LAST
      // turn's context rather than the session's cumulative reads: the two differ by a
      // factor of thirty on a long round, and the sum would compact almost at once and
      // then on every turn after.
      if (continuing !== undefined) await this.compactIfFull(continuing, tier);
      // lore-ok[d0eed5e8]: RE-CHECKED HERE, because `compactIfFull`'s own calls carry no
      // signal and cannot be interrupted — a cancel landing during it still reaches
      // `abort()`, which deletes `aborters`' entry for this session UNCONDITIONALLY
      // (`abort` above), whether or not anything was actually using it to abort. Without
      // this check, `conduct` below reaches `ask`'s "has no abort controller" guard with
      // the aborter genuinely gone — a state that guard's own comment calls a programming
      // error, but here is the ordinary result of a legitimate cancel — and throws a plain
      // `DidNotRun` that `runMember`'s catch (review.ts) cannot tell from a real failure:
      // booked `failed`, and on a second strike able to step the ladder and overwrite an
      // already-`cancelled` review's state.
      if (stillWanted?.() === false) {
        throw new CancelledByLore(
          `review ${reviewId ?? "?"} was ended while tier ${tier.id}'s session was being compacted — nothing new was spent on it.`,
        );
      }
      return await this.conduct(sessionId, tier, text, started, extract, contract);
    } catch (e) {
      // A SESSION OPENCODE NO LONGER HAS: forget it and start cold, exactly once.
      //
      // Only reachable now that ids are durable. The row can outlive the session it names
      // — opencode's volume replaced, its data pruned, this database restored from a
      // backup older than the session — and a 404 on `session.prompt` is how that shows.
      // Left in place the row would fail this tier on every future round of the review,
      // permanently, which is strictly worse than the cold start it was saving.
      //
      // AND A SESSION OPENCODE STILL HAS BUT THE PROVIDER WILL NO LONGER TAKE
      // (`HistoryRejected`) gets the same answer — see the class for the empty assistant
      // turn that made this necessary.
      //
      // NARROW ON PURPOSE: only when we RESUMED (`continuing`), only on one of those two,
      // and only once (`noResume`). Either one without a resume is a bug worth surfacing,
      // not a thing to paper over, and a second attempt would be a loop. The cold retry is
      // cheap for a refused history by construction: a refusal costs nothing when it
      // recurs, and one that does was the request's fault, and fails as it always did.
      if ((e instanceof SessionGone || e instanceof HistoryRejected) && continuing !== undefined && !noResume) {
        console.error(
          e instanceof SessionGone
            ? `[lore:log] ${tier.id}: opencode no longer has session ${continuing} — forgetting it and starting a ` +
                "fresh one. This round pays for a cold read; later rounds resume normally."
            : `[lore:log] ${tier.id}: the provider refused kept session ${continuing}'s own history (${e.message}) — ` +
                "forgetting it and starting a fresh one. This round pays for a cold read; later rounds resume normally.",
        );
        if (keptKey !== undefined) {
          this.kept.delete(keptKey);
          this.cfg.keptSessions?.forget(keptKey);
        }
        // A REFUSED history's session still exists in opencode, and forgetting the row was
        // the last thing that could find it: `release` enumerates sessions only through those
        // rows, so without this delete every recovery left one orphan for good — found by
        // lore's own review, fingerprint cbc1e5a6. Best-effort, exactly as `release` deletes:
        // failing to tidy up must not fail the round the cold retry is about to save. A
        // vanished session (`SessionGone`) has nothing left to delete.
        if (e instanceof HistoryRejected) {
          await this.client.session.remove({ sessionID: continuing }).catch(() => undefined);
        }
        this.aborters.delete(sessionId);
        this.watchers.delete(sessionId);
        return await this.conductSession(
          tier, prompt, worktree, reviewId, extract, contract, true, stillWanted, probing,
        );
      }
      // UNRECOVERABLE, so it leaves as something the ladder has a rule for. `SessionGone`
      // is ours and nothing above knows it; `DidNotRun` says exactly what happened and is
      // already handled everywhere. Reached when a FRESH session 404s, which is opencode
      // misbehaving rather than a stale row, and is worth saying plainly.
      if (e instanceof SessionGone) {
        throw new DidNotRun(`tier ${tier.id}: ${e.message} — the session vanished mid-round; nothing was learned.`);
      }
      // ABANDONING THE REQUEST DOES NOT STOP THE MODEL.
      //
      // Measured: three T2 calls that failed client-side went on to consume
      // ~3.7M cached-read tokens between them, because the agent kept exploring
      // the repository after we had stopped listening. A timeout that only frees
      // the caller is not a budget — it just makes the spend invisible.
      await this.abort(sessionId);
      // WHAT IT SPENT BEFORE IT DIED, recovered from the session it leaves behind.
      //
      // A call that fails writes no `usage` row, so the tokens it burned are invisible
      // to us — and the provider counted every one. Measured 2026-08-09: two t1 attempts
      // ran 45 minutes each against an exhausted Z.ai plan and our trailing-5h usage read
      // ZERO, which is the shape a quota calculation must never have. It under-counts
      // exactly when the provider is at its limit, which is the one moment it has to be
      // right.
      //
      // The session survives the failure and its messages still carry per-message
      // `tokens`, so this reads them back. Best-effort by construction: it must never
      // mask the error that caused it, and an unreadable session simply records nothing
      // — which is what happens today for every failure.
      // ATTACHED TO THE ERROR, not stored on `this`. An instance field would be shared
      // by every concurrent round — with four calls in flight one review's spend would
      // be recorded against another's, which is worse than not recording it.
      const spent = await this.usageOf(sessionId).catch(() => undefined);
      if (spent !== undefined && e instanceof Error) {
        (e as Error & { spent?: Usage }).spent = spent;
      }
      throw e;
    } finally {
      // The per-round handle always goes; the KEPT session does not — it is the whole
      // point, and `release` is what ends it when the review does. Only THIS session
      // leaves the set — a rung's sibling may still be live, and clearing the whole
      // entry here would let `cancel` believe nothing was left to abort (D-109).
      if (reviewId !== undefined) {
        const live = this.sessions.get(reviewId);
        if (live !== undefined) {
          live.delete(sessionId);
          if (live.size === 0) this.sessions.delete(reviewId);
        }
      }
      // Same reason the session entry goes: a controller left behind would let a later
      // cancel abort a request that has already finished, and would leak one entry per
      // session for the life of the process. The watcher is the same hazard with a
      // longer fuse — the stream outlives every call on it.
      this.aborters.delete(sessionId);
      this.watchers.delete(sessionId);
      this.activity.delete(sessionId);
      // ALWAYS, regardless of which branch above returned or threw — the one thing every
      // exit path shares. Left unset, a probe that succeeded (or failed for some other
      // reason) at, say, 4 seconds would still fire at `probeMs`, aborting a NEW call that
      // has since reused this same `sessionId` slot with an error about a request that
      // finished long ago.
      if (probeTimer !== undefined) clearTimeout(probeTimer);
    }
  }

  /**
   * Point a resumed session at the worktree this round reads, if it points elsewhere.
   *
   * A session opencode no longer has is left for `ask` to discover: its 404 is what drives
   * the cold-start recovery in `conductSession`, and handling it here would only move where
   * that is noticed.
   *
   * ANY OTHER FAILURE STOPS THE ROUND. The first version logged and carried on, on the
   * reasoning that a session that cannot be moved still reads the tree it was opened on —
   * true, and exactly the danger: a review restored under a new data directory would
   * prompt the session at the OLD checkout and could pass on code nobody had read. Whether
   * the session reads the right tree is not something to be best-effort about.
   */
  private async followWorktree(sessionId: string, worktree: string): Promise<void> {
    let at: string | undefined;
    try {
      at = (await this.client.session.get({ sessionID: sessionId })).location?.directory;
    } catch (e) {
      const w = this.wireError(e, sessionId);
      if (w instanceof SessionGone) return;
      throw transportFault(e)
        ? new ServiceUnreachable(
            `could not ask opencode at ${this.cfg.baseUrl} which worktree kept session ${sessionId} reads (${detail(e)}) — ` +
              "nothing was sent to it; the round is requeued.",
            e,
          )
        : new DidNotRun(`could not ask opencode which worktree kept session ${sessionId} reads: ${detail(e)} — nothing was sent to it.`);
    }
    if (at === worktree) return;
    // No location at all is a session whose tree cannot be confirmed — moved like any other,
    // rather than trusted.
    await this.client.session.move({ sessionID: sessionId, directory: worktree }).catch((e: unknown): never => {
      // Classified like the lookup above: a session that vanished between the two calls
      // is the cold-start recovery's, a dropped connection is a requeue — only a refusal
      // opencode actually answered is this tier's failure.
      const w = this.wireError(e, sessionId);
      // lore-ok[4047454f]: move failures keep the lookup's classes — gone, transport, refusal.
      if (w instanceof SessionGone) throw w;
      if (transportFault(e)) {
        throw new ServiceUnreachable(
          `lost opencode at ${this.cfg.baseUrl} while moving kept session ${sessionId} to ${worktree} (${detail(e)}) — ` +
            "nothing was sent to it; the round is requeued.",
          e,
        );
      }
      throw new DidNotRun(
        `kept session ${sessionId} reads ${at ?? "an unknown directory"} and could NOT be moved to ${worktree}: ${detail(e)} — ` +
          "nothing was sent to it, rather than reviewing the wrong tree.",
      );
    });
    console.error(`[lore:log] kept session ${sessionId} moved from ${at ?? "an unknown directory"} to ${worktree}`);
  }

  /**
   * Compact this session if its last turn carried two thirds of the window (D-80).
   *
   * Best-effort by construction. A summarise that fails leaves the conversation exactly as
   * it was — longer than we would like and still correct — where throwing would end a
   * review over a housekeeping call. What must NOT happen is silence: a session that keeps
   * failing to compact will eventually overflow, and the log line is the only warning.
   */
  private async compactIfFull(sessionId: string, tier: Tier): Promise<void> {
    const window = await this.contextLimit(tier.model ?? "").catch(() => undefined);
    const used = await this.lastTurnTokens(sessionId).catch(() => undefined);
    if (!shouldCompact(used, window)) return;

    // ADMITTED, THEN AWAITED. v2's compact only queues the work and returns; the summary
    // is written by the session's own loop, so the prompt that follows must wait for it or
    // it lands on the uncompacted history it was meant to spare.
    const failure = await this.client.session
      .compact({ sessionID: sessionId })
      .then(() => this.client.session.wait({ sessionID: sessionId }))
      .then(() => undefined)
      .catch((e: unknown) => detail(e));
    console.error(
      failure === undefined
        ? `[lore:log] compacted ${tier.id}'s session at ${String(used)} of ${String(window)} tokens`
        : `[lore:log] could NOT compact ${tier.id}'s session at ${String(used)} of ${String(window)} tokens: ${failure}`,
    );
  }

  /**
   * The context the last turn actually carried — input plus cache reads on the most
   * recent assistant message.
   *
   * NOT `usageOf`, which sums the whole session. That is the right number for spend and
   * the wrong one for "how full is the window": on a thirty-turn round the sum is thirty
   * times the context, so compacting against it would fire immediately and for ever.
   */
  private async lastTurnTokens(sessionId: string): Promise<number | undefined> {
    // The newest assistant message only — the server filters and orders, so this is one
    // short page however long the session has grown.
    const res = await this.client.message.list({ sessionID: sessionId, type: "assistant", order: "desc", limit: 1 });
    const t = (res.data[0] as { tokens?: Record<string, unknown> } | undefined)?.tokens;
    if (t === undefined) return undefined;
    const cache = (t["cache"] ?? {}) as Record<string, unknown>;
    const used = Number(t["input"] ?? 0) + Number(cache["read"] ?? 0) + Number(cache["write"] ?? 0);
    return used > 0 ? used : undefined;
  }

  /**
   * Which reviews still hold a kept session, for the reconcile that ends the orphans.
   *
   * The map is keyed `<reviewId>:<tierId>:<model>` and split on the FIRST colon,
   * matching what `release` prefixes on, so the two cannot disagree about where the
   * review id ends — see the inline comment below for why FIRST and not LAST.
   */
  keptReviews(): readonly string[] {
    // MEMORY *AND* THE DURABLE RECORD. The cache alone is empty after a restart — the one
    // event durable ids exist for — so the reconcile would sweep nothing exactly when
    // there is most to sweep, and the rows and their opencode sessions would outlive the
    // reviews that own them with nothing anywhere left to clear them.
    //
    // The FIRST colon, not the last: the key is `<reviewId>:<tierId>:<model>` and a model
    // id carries slashes rather than colons, so the review id is everything before the
    // first one. Splitting on the last returned `rev:t2` and released nothing.
    const keys = [...this.kept.keys(), ...(this.cfg.keptSessions?.keys() ?? [])];
    return [...new Set(keys.map((k) => k.slice(0, k.indexOf(":"))))];
  }

  /**
   * End every session this review was holding. Called when the review ends, whatever the
   * ending was.
   *
   * WITHOUT THIS THEY ACCUMULATE. A kept session is deliberately not cleared per round, so
   * nothing else would ever close it — and admission allows 128 open reviews, which across
   * three tiers is 384 sessions opencode would hold for reviews that finished hours ago.
   */
  async release(reviewId: string): Promise<void> {
    // THE DURABLE KEYS TOO, and for the same reason `keptReviews` reads them: after a
    // restart the cache holds nothing, so releasing from it alone would leave the sessions
    // of every pre-restart review open on opencode for ever.
    const held = new Map<string, string>(this.kept);
    for (const key of this.cfg.keptSessions?.keys() ?? []) {
      const id = this.cfg.keptSessions?.get(key);
      if (id !== undefined && !held.has(key)) held.set(key, id);
    }
    for (const [key, sessionId] of held) {
      if (!key.startsWith(`${reviewId}:`)) continue;
      this.kept.delete(key);
      // AND THE DURABLE COPY, or the next process resumes a session this line just
      // deleted — a 404 the recovery path would absorb, but only after paying for a
      // round trip to learn something we knew here.
      this.cfg.keptSessions?.forget(key);
      await this.client.session.remove({ sessionID: sessionId }).catch(() => undefined);
    }
  }

  /**
   * Tokens a session consumed, summed over its assistant messages.
   *
   * Read on BOTH paths: from the session opencode leaves behind after a failure, and from
   * the completed session, because `session.prompt` returns one assistant message and an
   * agentic run is many. `cost` is summed with the tokens — it was hard-zeroed while every
   * provider billed a flat subscription and reported nothing, which stopped being true
   * when D-93 put a metered provider on the fallback path and made this the number the
   * daily ceiling adds up.
   */
  private async usageOf(sessionId: string): Promise<Usage | undefined> {
    return usageFromMessages({ data: await this.messagesOf(sessionId) });
  }

  /**
   * A session's whole message list, oldest first, every page of it.
   *
   * PAGED in v2, and the default page is not the whole session: a reader that took the
   * first page would under-count spend and steps on exactly the long runs where they
   * matter. The cursor is followed until opencode stops offering one — and it keeps
   * offering one after the last message (measured on 2.0.20: one more, empty, page), so
   * an empty page ends it too. `order` goes on the first request only: opencode refuses a
   * cursor sent with it (400, "Do not combine with order").
   */
  private async messagesOf(sessionId: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let page = await this.client.message.list({ sessionID: sessionId, order: "asc" });
    for (let i = 0; i < 1_000; i++) {
      out.push(...page.data);
      const next = page.cursor?.next ?? undefined;
      if (page.data.length === 0 || next === undefined || next === null) return out;
      page = await this.client.message.list({ sessionID: sessionId, cursor: next });
    }
    throw new DidNotRun(`session ${sessionId} kept offering message pages past 1000 — refusing to read for ever`);
  }

  /**
   * Best-effort: a failed abort must not mask the error that caused it.
   *
   * Best-effort, though, is not the same as unobserved. This is called when a review
   * has already gone wrong, and the model keeps exploring until something tells it to
   * stop — so an abort that quietly returned 404 means the spend continues with
   * nobody watching, which is the failure the caller's own comment is about. It still
   * cannot throw here (that would replace the real error with the cleanup's), so it
   * says so instead, on the same channel as everything else that is true but not
   * fatal. Same reason the status is looked at at all: this SDK's failures are return
   * values.
   */
  private async abort(sessionId: string): Promise<void> {
    // OURS FIRST, and it is instant. Asking opencode is a network call that can itself
    // hang, and `cancel` awaits this — so a slow opencode would hold a client's cancel
    // open while we sat waiting for a reply we had already decided to discard. Freeing
    // our own socket cannot fail and cannot block, so it goes first.
    //
    // It does NOT stop the model. That is what the request below is for, and the order
    // between them matters only for how fast the caller is released.
    this.aborters.get(sessionId)?.abort(new Error(`session ${sessionId} was aborted by lore`));
    this.aborters.delete(sessionId);

    // `interrupted: false` is opencode saying the session was already idle — nothing was
    // running to stop, which is not a failure to stop it.
    const failure = await this.client.session
      .interrupt({ sessionID: sessionId })
      .then(() => undefined)
      .catch((e: unknown) => detail(e));
    if (failure !== undefined) {
      console.error(
        `[lore:log] could not abort session ${sessionId} (${failure}) —` +
          " the model may still be exploring, and its tokens are still being spent",
      );
    }
  }

  /**
   * One session, one answer, one retry — for whatever the caller asked for.
   *
   * `extract` and `contract` are parameters because findings are not the only list a
   * model is asked for: `propose` asks for proposals, with a different schema and the
   * same three ways to fail. Everything that made this loop worth keeping — the retry
   * carrying WHAT was wrong, both replies logged when it fails twice, the abort so a
   * failure stops the spend — is identical for both, and a second copy of it would
   * grow a second set of the bugs that were fixed here one at a time.
   */
  private async conduct<T>(
    sessionId: string,
    tier: Tier,
    prompt: string,
    started: number,
    extract: (text: string) => Listed<T>,
    contract: string,
  ): Promise<SessionResult<T>> {
    const first = await this.ask(sessionId, tier, `${prompt}\n\n${contract}`);

    let extracted = extract(first.text);
    let retried = false;
    // A BLOCK THAT WOULD NOT PARSE GETS ASKED FOR AGAIN — ONCE (INV-1).
    //
    // The retry below fires only when the WHOLE reply failed, so a reply carrying two
    // fenced blocks where one parsed and one did not looked healthy and was never
    // re-asked: the findings in the bad block were simply gone. Loudly gone — they reach
    // `checks_skipped` as "produced a finding this review does NOT contain" — but gone,
    // four times in one day on lore's own review of D-121.
    //
    // ONLY A PARSE FAILURE, never a schema rejection. That distinction is measured, not
    // guessed: told the exact rule twice, glm-5.2 shortened an over-long claim by 44
    // characters and still landed 14 over, so re-asking a refusal buys a second refusal
    // and a paid turn. A syntax error is usually truncation, which a re-send fixes.
    //
    // MERGED, NOT REPLACED, and the second ask is told to send only the missing block: the
    // items that already parsed are already ours, and a model re-listing them would double
    // them. Identical re-sends are harmless anyway — a finding's fingerprint is derived
    // from its content, so a duplicate collapses onto the original.
    // Captured before the reassignment below: `extracted` is a `let`, so the narrowing
    // does not survive into the closure that filters this same note out.
    const lostBlock = extracted.ok ? extracted.garbled : undefined;
    if (extracted.ok && lostBlock !== undefined) {
      retried = true;
      const again = await this.ask(
        sessionId,
        tier,
        `Part of your last reply was lost: ${extracted.garbled}.
` +
          "The blocks that DID parse are recorded — do not repeat them. Re-send ONLY the contents of the " +
          "block that failed, as one valid json block. If that block held nothing you have not already " +
          `reported, reply with an empty array.

${contract}`,
      );
      const recovered = extract(again.text);
      // ONLY WHEN SOMETHING WAS ACTUALLY RECOVERED — raised by lore's own t2 at high, and
      // the finding is exactly right.
      //
      // This dropped `lostBlock` from `rejected` whenever `recovered.ok`, and `recovered.ok`
      // is true for `{"findings": []}` as much as for a reply with real items: the prompt
      // ABOVE explicitly invites that reply — "if that block held nothing you have not
      // already reported, reply with an empty array" — so an ordinary, well-behaved
      // response made the loss note VANISH with nothing recovered to justify it. The one
      // finding this feature exists to stop losing could be lost by the feature itself,
      // more quietly than before it existed: pre-D-123 the client at least saw "produced a
      // finding this review does NOT contain".
      //
      // An empty-array reply does not resolve the uncertainty a truncated block leaves
      // behind — it is the model's OWN claim that there was nothing more, which is exactly
      // the self-report this project does not trust standing alone (the same INV-1 shape
      // as everywhere else: "I looked and found nothing" is not "I did not look", and here
      // it is not verifiable either way). So the note stays unless real items came back.
      if (recovered.ok && recovered.items.length > 0) {
        extracted = {
          ok: true,
          items: [...extracted.items, ...recovered.items],
          // BOTH SETS OF LOSSES, dropping the original only now that recovery is real.
          rejected: [...extracted.rejected.filter((r) => r !== lostBlock), ...recovered.rejected],
          ...(recovered.garbled === undefined ? {} : { garbled: recovered.garbled }),
        };
      }
      // AN EMPTY OR FAILED RE-ASK CHANGES NOTHING. `extracted` still carries the original
      // loss in `rejected`, so the client is told exactly what it was told before this
      // existed — the re-ask can only add, never subtract.
    }
    if (!extracted.ok) {
      // One retry, contract restated — and, since 2026-08-04, carrying WHAT was
      // wrong. A model told only "could not be parsed" is guessing: glm-5.2 trimmed
      // one over-long claim by nine characters and left another over the cap,
      // because nothing had told it a cap existed.
      retried = true;
      const second = await this.ask(
        sessionId,
        tier,
        `Your previous reply could not be used: ${extracted.why}.\n` +
          `Fix exactly that and reply again with ONLY the json block.\n\n${contract}`,
      );
      const retry = extract(second.text);
      if (!retry.ok) {
        // BOTH replies are in scope here and both used to be thrown away, which made
        // the most frequent failure in this system also the least diagnosable: a round
        // died after the model had already been paid for, and nothing anywhere said
        // what it actually said. Observed on a real review of this repo.
        //
        // Logged in full (bounded) rather than put in the message, because the message
        // travels into a review's failure text and an operator alert; a 40 KB model
        // reply in either is its own problem.
        // "nothing parseable" was itself untrue once the schema became a way to
        // fail: a 325-character claim is perfectly parseable JSON that we refuse.
        // The headline now carries both reasons, so the log agrees with the error
        // thrown three lines below it instead of contradicting it.
        console.error(
          `[lore:log] tier ${tier.id} (${tier.model}) returned nothing usable, twice ` +
            `(first: ${extracted.why}; retry: ${retry.why}). First reply:\n` +
            `${excerpt(first.text, 2_000)}\nAfter the contract was restated:\n${excerpt(second.text, 2_000)}`,
        );
        // Empty, unparseable and REJECTED are different faults and lead different
        // places: an empty reply is usually the provider failing inside an HTTP 200,
        // which is a bill or a quota; prose is the model ignoring the output
        // contract, which is a prompt; a schema rejection is a reply that was
        // perfectly good JSON saying something we would not accept, which is a cap
        // or a vocabulary. `why` is what separates the third from the second — it
        // said "malformed JSON" about valid JSON once, and sent the search an hour
        // in the wrong direction.
        throw new DidNotRun(
          `tier ${tier.id} (${tier.model}) did not return a usable reply after a retry — this DID NOT RUN. ` +
            `${describeReply("first", first.text)}: ${extracted.why}; ` +
            `${describeReply("retry", second.text)}: ${retry.why}. ` +
            "The full replies are on [lore:log].",
        );
      }
      // THE FIRST REPLY'S LOSSES SURVIVE THE RETRY THAT REPLACED IT.
      //
      // `extracted = retry` dropped them, and `extractList` attaches them to a FAILURE
      // for exactly this purpose — a garbled fence, or a block whose every item the
      // schema refused. It cost nothing while the retry was another findings batch,
      // because the model simply said it all again. Under D-107's streamed contract it
      // does not: a first emission whose findings fence the transport mangled, retried,
      // comes back as the model's `{"done": true}` — it had already said what it found —
      // and the run ends `ok` with empty items and empty `discarded`. The finding the
      // model explicitly tried to report then exists NOWHERE: no D-66 note, no
      // checks_skipped line, and a rung that may conclude clean over code it flagged.
      // This is `emissionOf`'s done-laundering fix again, across two messages instead of
      // one block.
      extracted = { ...retry, rejected: [...(extracted.rejected ?? []), ...retry.rejected] };
      first.usage = second.usage;
    }

    // Loud, always: a discarded item is something this tier said and we threw away.
    if (extracted.rejected.length > 0) {
      console.error(
        `[lore:log] tier ${tier.id} (${tier.model}) had ${extracted.rejected.length} item(s) rejected by the ` +
          `schema; the other ${extracted.items.length} were kept. ${extracted.rejected.join(" | ")}`,
      );
    }

    // Taken before the step count, because that costs an extra round trip to
    // opencode and latency is meant to describe the review, not the bookkeeping.
    const latencyMs = Date.now() - started;

    // THE WHOLE SESSION, not the last message of it.
    //
    // `session.prompt` returns ONE `AssistantMessage`, so reading its usage reported a
    // single turn of an agentic run that may have taken eighty. The failure path already
    // summed the session (`usageFromMessages`), which made success and failure count
    // different quantities — recorded as a known inconsistency while every provider was a
    // flat subscription and the numbers were decorative. D-93 made one path metered: a
    // COMPLETED review then reported a fraction of what it spent, and two spend gates
    // summed that fraction. Both gates are gone (D-121) and the reason to be accurate is
    // not — this is the number an operator reads to decide whether to keep paying, and an
    // under-count reads as a deployment that is cheaper than it is.
    //
    // Falls back to the single message when the session cannot be read, which is the
    // conservative direction available: an under-count is what we had, and inventing a
    // number would be worse.
    // ONE FETCH, TWO ANSWERS. The step count and the session's usage are both derived
    // from the same message list, and asking twice is a round trip nobody needs — the
    // first version did, which a test caught by counting the GETs.
    // v2 THROWS where v1 returned a status, so the three outcomes `stepsFrom` names are
    // rebuilt here: an answer (200), a refusal opencode declared or a status it did not
    // (the error's own status, else 500), and no answer at all (`undefined`).
    const messages = await this.messagesOf(sessionId)
      .then((data) => ({ status: 200 as number | undefined, data: data as unknown, error: undefined as unknown }))
      .catch((e: unknown) => ({ status: transportFault(e) ? undefined : httpStatusOf(e) ?? 500, data: undefined, error: e }));
    const whole = await usageFromMessages({ data: messages.data }).catch(() => undefined);
    const usage = whole ?? first.usage;
    return {
      items: extracted.items,
      raw: first.text,
      inputTokens: usage.input,
      cachedTokens: usage.cached,
      outputTokens: usage.output,
      costUsd: usage.cost,
      latencyMs,
      retried,
      rejected: extracted.rejected,
      steps: this.stepsFrom(sessionId, messages),
    };
  }

  /**
   * How far the agent explored, asked of the session rather than of the reply.
   *
   * A prompt reply carries ONE assistant message (`SessionPromptResponses` in the
   * pinned SDK: `{info: AssistantMessage, parts: Part[]}`), and an assistant message
   * carries at most one `step-start` — 1415 of them across 1455 recorded messages in
   * a real opencode store, never two in one message. So counting steps in the reply
   * yields 1 for a runaway and 1 for a one-shot answer, which is how a previous
   * attempt at this shipped a bound that could not fire. The turns live in the
   * SESSION: opencode appends one assistant message per turn, and lore gives every
   * tier run its own session.
   *
   * A LOWER BOUND, not a total. Turns the reviewer delegates with the `task` tool run
   * in CHILD sessions, and this list does not contain them. The read-only agent has
   * `task` available, so a reviewer that fans out is undercounted here. That is the
   * safe direction for a number whose purpose is to justify a future ceiling — it can
   * only argue for a ceiling being too low, never too high — but it is not the total
   * and must not be described as one.
   *
   * Never fatal. The model has already been paid for by the time this runs, and a
   * measurement that gates nothing must not be able to destroy the finished review
   * it is measuring. It fails to `undefined` — a missing number, never a zero.
   *
   * One round trip per completed review, and not a small one: the list carries every
   * part of every turn — 5.2 MB in 179 ms for the 86-turn session above, measured on
   * a laptop over loopback. The deployment is a CPU-bound arm64 SBC talking to a
   * sibling container, where this has NOT been measured; treat the figure as an order
   * of magnitude, not as a budget. `GET /session/:id` returns the same aggregates in
   * ~713 bytes and is the obvious replacement if this ever hurts.
   */
  /**
   * How far the agent explored, from a message list the caller already has.
   *
   * It used to fetch its own. The session's USAGE is derived from the same list (D-93
   * made a completed session's total matter), so asking twice was a round trip nobody
   * needed — caught by a test that counts the GETs rather than trusting the shape.
   */
  private stepsFrom(
    sessionId: string,
    seen: { status: number | undefined; data: unknown; error: unknown },
  ): number | undefined {
    // Three outcomes, three sentences, because the first draft of this reported an
    // unreachable server as "opencode answered 200" — caught by pointing it at a
    // dead port and reading what it actually printed. A diagnostic that invents a
    // status is the same defect as the one `createSession` above exists to fix.
    const steps = seen.status !== undefined && seen.status < 400 ? countStepParts(seen.data) : undefined;

    // What it reached for, and how often. Logged rather than stored: this is a
    // measurement to act on, not review state — every question answered by a tool
    // call is one that could have been precomputed and handed over instead.
    const tools = seen.status !== undefined && seen.status < 400 ? toolsUsed(seen.data) : {};
    const ranked = Object.entries(tools).sort((a, b) => b[1] - a[1]);
    if (ranked.length > 0) {
      console.error(
        `[lore:log] tools used in session ${sessionId}: ` +
          ranked.map(([name, n]) => `${name}×${n}`).join(", "),
      );
    }

    if (steps === undefined) {
      const because =
        seen.status === undefined
          ? `${this.cfg.baseUrl} could not be reached: ${detail(seen.error)}`
          : seen.status >= 400
            ? `opencode answered ${seen.status}: ${detail(seen.error ?? {})}`
            : "opencode answered 200 but no step-start part was found — an empty message list, a shape this does not recognise, or genuinely no turn recorded. This cannot tell which";
      // Logged rather than thrown, and logged rather than swallowed: the column will
      // say NULL, which reads as "not measured", but nothing else in the system
      // would ever say WHY. `[lore:log]` is the same channel an unmatched `lore-ok`
      // uses, for the same reason.
      console.error(
        `[lore:log] step count unavailable for session ${sessionId} (${because})` +
          " — the review stands, but this run contributes nothing to the exploration distribution (D-50)",
      );
    }
    return steps;
  }

  private async createSession(tier: Tier, worktree: string): Promise<string> {
    // EVERYTHING THAT SHAPES THE SESSION IS FIXED HERE, because v2 fixes it here. v1 sent
    // model, agent, tools and directory with every prompt; v2 takes them once, at creation,
    // and a prompt is only text. So a session opened with the wrong model or no deny rule
    // stays wrong for every turn — which is why the rules are not left to the agent file.
    //
    // THE DENY RULES ARE THE BRACES (INV-8). The predecessor learned that a missing agent
    // falls back to the write-capable default with no error; a session's own rules are
    // appended AFTER the agent's and the last match wins (opencode `Permission.evaluate`),
    // so these hold whatever agent opencode actually resolves. `edit` is the action every
    // write path checks — edit, write and patch all ask for it. `question` because nobody
    // is there to answer one: a question on a headless server waits for ever.
    //
    // NOT A SANDBOX. The shell stays allowed — reviewers read with it — and measured on
    // 2.0.20 a model told to fix a file did so through `python3 -c "open(...,'w')"` with
    // `edit` denied. v1 had the same hole; what contains it is that the worktree is lore's
    // own disposable copy, never the operator's checkout.
    const body = {
      title: `lore-${tier.id}-${Date.now()}`,
      agent: this.cfg.agent,
      model: (({ providerID, modelID }) => ({ providerID, id: modelID }))(splitModel(tier.model ?? "")),
      location: { directory: worktree },
      permissions: [...DENY_RULES],
    };
    const created = await this.client.session.create(body).catch((e: unknown): never => {
      // The ONE case where "is a server running?" is the right question: an unreachable
      // server makes this call reject before anything answers. Unwrapped, it reaches the
      // worker naming neither the tier nor the address it could not reach.
      if (transportFault(e)) {
        throw new ServiceUnreachable(
          `tier ${tier.id} could not reach opencode at ${this.cfg.baseUrl} (${detail(e)})` +
            " — is a server running there? Nothing about the code was learned; the round is requeued.",
          e,
        );
      }
      // And a server that is up and REFUSING, which is not the same thing and must not
      // read as it: blaming connectivity sent debugging the wrong way twice in one day
      // while opencode was up. The status names the fault, so it leads the message.
      //
      // DidNotRun rather than Exhausted even on a 429: creating a session touches no
      // provider, so a refusal here is opencode or something in front of it, and calling
      // it quota would step the tier over as unpayable (D-48) for a reason that has
      // nothing to do with money.
      const status = httpStatusOf(e);
      const hint = status === 401 || status === 403
        ? " — check OPENCODE_SERVER_PASSWORD; opencode v2 accepts only the user name `opencode`"
        : "";
      throw new DidNotRun(
        `tier ${tier.id} could not open a session: opencode at ${this.cfg.baseUrl} answered ` +
          `${status === undefined ? "with an error" : String(status)}: ${detail(e)}${hint}`,
      );
    });
    // A SESSION WITH NO ID cannot be prompted, cancelled or deleted — failing now names
    // the fault; failing on the first prompt would name a session id `undefined`.
    if (typeof created?.id !== "string" || created.id === "") {
      throw new DidNotRun(`opencode created a session but returned no id (${this.cfg.baseUrl})`);
    }
    return created.id;
  }

  private async ask(
    sessionId: string,
    tier: Tier,
    text: string,
  ): Promise<{ text: string; usage: Usage }> {
    // LOUD, not `?? null`. A missing controller means this request cannot be cancelled,
    // which is precisely the defect the controller was added to fix — and defaulting to
    // "no signal" would restore it silently for whatever new caller forgot to register
    // one. `conductSession` is the only way in and it always registers, so reaching this
    // is a programming error and should read as one.
    const signal = this.aborters.get(sessionId)?.signal;
    if (signal === undefined) {
      throw new DidNotRun(`session ${sessionId} has no abort controller — it would be impossible to cancel`);
    }
    try {
      // ADMITTED, NOT ANSWERED. v2's prompt queues the text and returns at once with the
      // user message it recorded; the agent loop runs afterwards. So this request is short
      // and the long one is `awaitTurn`'s `wait` — which is where the signal matters: it is
      // what makes a cancel reach a call that would otherwise hold its socket until the
      // 2700s deadline (`longFetch` destroys the socket when the signal fires).
      const admitted = await this.client.session
        .prompt({ sessionID: sessionId, text }, { signal })
        .catch((e: unknown): never => {
          throw this.wireError(e, sessionId);
        });
      const turn = await this.awaitTurn(sessionId, admitted.id, signal);
      // opencode records the PROVIDER's failure on the assistant message, classified —
      // the HTTP exchange with opencode succeeded either way, so without this an unpaid
      // bill arrives as an empty reply and is reported as "the model did not return
      // findings", sending someone to debug a prompt.
      if (turn.error !== undefined) {
        throw new HttpStatus(turn.error.status ?? 500, `${turn.error.type}: ${turn.error.message}`, turn.error.type);
      }
      if (turn.outcome === "interrupted") {
        throw new HttpStatus(499, `session ${sessionId} was interrupted before it finished`, "session.interrupted");
      }
      if (turn.outcome !== "succeeded") {
        throw new HttpStatus(500, `session ${sessionId} ended '${turn.outcome}' without recording why`, "unknown");
      }
      return { text: turn.text, usage: turn.usage };
    } catch (e) {
      // ALREADY CLASSIFIED, and re-deriving it would lose what it carries. When the event
      // stream fails a call (D-91), the abort reason IS an `Exhausted` holding the
      // provider's words and its reset time — and the classifier below would not even
      // recognise it: *"Weekly/Monthly Limit Exhausted"* matches none of
      // `rate.?limit|quota|insufficient`, so it would arrive as a plain `DidNotRun` and
      // the ladder would fail the review instead of stepping over the tier.
      //
      // AND IT ARRIVES WRAPPED. The v2 client turns every failed `fetch` into a
      // `ClientError("Transport")` carrying the original as `cause` — and an abort IS a
      // failed fetch, so the `Exhausted` a watcher aborted with, the `ProbeInconclusive` of
      // a silent probe and lore's own cancel all come back inside one. Unwrapped first, or
      // every one of them would fall through to the transport branch below and requeue a
      // round as "lost its connection".
      e = abortReason(e);
      if (e instanceof TierUnavailable) throw e;
      // Same reasoning, one line later: this one is answered by opening a new session,
      // which is a decision only `conductSession` can take.
      if (e instanceof SessionGone) throw e;
      const status = e instanceof HttpStatus ? e.status : undefined;
      // opencode's own classification, when the failure came from a session record. It is
      // asked FIRST below because it is the provider's answer as opencode understood it;
      // the patterns are the fallback for what arrives unclassified.
      const kind = e instanceof HttpStatus ? e.kind : undefined;
      const message = e instanceof Error ? e.message : String(e);
      // Quota is never a reason to fall through to another tier or provider: a
      // tier that did not run found nothing, which is not finding nothing.
      //
      // A RATE LIMIT THAT REACHES HERE IS SPENT, not transient: v2 already retried it ten
      // times (about 84s, longer when the provider names a wait) before failing the turn.
      if (
        kind === "provider.quota" || kind === "provider.rate-limit" ||
        status === 429 || status === 402 || /rate.?limit|quota|insufficient/i.test(message)
      ) {
        throw new Exhausted(`tier ${tier.id} (${tier.model}) refused on quota: ${message}`);
      }
      // A REJECTED CREDENTIAL IS NOT A DIFFICULT BRANCH. It stops every review at this
      // tier at once and only an operator can fix it, so it gets its own type and the
      // worker pages on it — a condition `spec/operations.md` §2.1 has listed under
      // "someone should look now" since it was written, with nothing ever sending it.
      //
      // Checked AFTER quota deliberately: 402 is a bill rather than a bad key, and
      // some providers answer 401 for an exhausted plan. Quota is the kinder reading
      // and the ladder can step over it (D-48); an auth failure cannot be stepped over,
      // so the narrower claim goes second and only catches what quota did not.
      //
      // Reached here through `providerError`, i.e. the status nested inside a 200 —
      // the transport's own 401 is opencode refusing us, which `createSession` names
      // separately and which points at OPENCODE_SERVER_PASSWORD, not at a provider.
      //
      // "TOKEN REFRESH FAILED" IS IN THE LIST BECAUSE IT ARRIVED WEARING A 500. An
      // OAuth-backed subscription (openai, 2026-08-14) died with `opencode returned
      // 500: UnknownError: Token refresh failed: 401` — the 401 is INSIDE the message,
      // the transport said 500, and none of the patterns here matched. The failure
      // then classified as a plain DidNotRun: no page, no route mark for the status
      // line, and the configured same-model fallback never walked, so a review that
      // had cleared t1 and t2 died 0.4 seconds into t3 with a healthy OpenRouter twin
      // sitting unasked in its config.
      if (
        kind === "provider.auth" ||
        status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authentication|token refresh failed/i.test(message)
      ) {
        throw new ProviderAuthFailed(tier.model ?? tier.id, `tier ${tier.id}: ${message}`);
      }
      // TOO LONG IS A TIER THAT CANNOT LOOK, NOT A REVIEW THAT FAILED (D-48).
      //
      // `compactToFit` already refuses before spending when the prompt cannot fit the
      // model's ADVERTISED window — and the advertised window is not always the limit
      // that applies. `zai-coding-plan/glm-5-turbo` advertises 200,000 tokens of
      // context, so a 104 KB prompt was nowhere near the computed budget and was sent
      // unchanged; the endpoint answered 400 "Prompt exceeds max length". A subscription
      // plan can cap a request well below the model's nominal context, and nothing
      // publishes that number.
      //
      // Classified rather than left generic, because the two answers are worlds apart.
      // Generic, this failed the WHOLE REVIEW: t1 died, the ladder stopped, and six
      // commits went unreviewed although t2 (1M context) and t3 (500k) could each have
      // held the diff comfortably. As `TooLargeForTier` the ladder steps over t1 and
      // finishes `passed_thin_ladder` — weaker evidence, honestly labelled, which is the
      // whole of D-48. The same lesson as the 741 KB branch that failed five times.
      // THE SUBJECT MUST BE THE PROMPT, not merely the word "exceed" somewhere.
      //
      // The bare substring set matched any provider error containing "exceeded" — a rate
      // limit, a quota, a spend cap, a token budget — and every one of those was then
      // classified as "this tier's window is too small". The consequence is the opposite
      // of the one it was built for: `TooLargeForTier` makes the ladder STEP OVER the
      // tier and finish `passed_thin_ladder`, so a transient rate limit would silently
      // downgrade a review's evidence instead of failing it, and the attestation would
      // claim a tier had been honestly skipped when it had merely been throttled.
      //
      // So the phrase has to be about length AND about the input. Anchored on the pairing
      // rather than on either word: "maximum context length" and "prompt is too long" both
      // match, "rate limit exceeded" and "quota exceeded" do not.
      if (isTooLong(message)) {
        throw TooLargeForTier.refusedAsTooLong(tier.id, tier.model ?? "", text.length, message);
      }
      // WE STOPPED THIS, and saying so is not decoration. Everything below this line in
      // the caller treats a throw as the tier misbehaving: `runRound` closes the tier
      // run `failed`, `tierFailureCount` counts it, and one more such count promotes the
      // tier's work to a dearer one. A cancel that presented as "tier t1 failed" would
      // spend somebody else's quota answering for a review a person deliberately ended,
      // and would leave a failure in the record naming the wrong culprit.
      if (this.aborters.get(sessionId)?.signal.aborted === true || /aborted by lore/.test(message)) {
        throw new CancelledByLore(`tier ${tier.id} (${tier.model}) was stopped by lore, not by the provider: ${message}`, e);
      }
      // A CONNECTION THAT DROPPED MID-CALL: WHERE IT DROPPED DECIDES, NOT WHEN WE ASK.
      //
      // This briefly classified `socket hang up` / `ECONNRESET` as `ServiceUnreachable` by
      // pattern alone; lore's own t2 refused it and was right — opencode relays provider
      // errors verbatim, so those strings are exactly how an upstream reset presents, and
      // requeuing them would spend subscription quota proving somebody else's outage while
      // blaming our own opencode in the audit trail.
      //
      // Then a PROBE settled it: is opencode answering right now? On 2026-08-13 an opencode
      // recreate had skipped t1 as "could not answer" while both z.ai plans were fine, and
      // Vany called that a lie. The probe fixed the slow case and left a race: opencode
      // restarts in seconds, so by the time the probe asks, the restarted process answers,
      // the drop reads as the provider's, and the tier is skipped. Measured 2026-09-15:
      // opencode restarted seven times in two hours with exit 0, and a review of lore's own
      // fix had t1 SKIPPED on a bare "socket hang up" in the middle of it.
      //
      // The two cases were always distinguishable by STRUCTURE, which does not race. Every
      // answer opencode gives — a non-2xx, or a provider's failure nested in a 200 — is
      // rethrown above as `HttpStatus`. So:
      //   * `HttpStatus` carrying the string: opencode ANSWERED and relayed a provider's
      //     reset. That is the tier failing, exactly t2's point, and it stays a DidNotRun.
      //   * anything else: lore's own socket to opencode broke before opencode answered.
      //     The provider was never reached through a live exchange, nothing about the code
      //     was learned, and it is a requeue whatever opencode looks like a second later.
      // The probe survives only to say WHICH of those two stories the operator is reading.
      if (
        !(e instanceof HttpStatus) &&
        (transportFault(e) || /socket hang up|ECONNRESET|ENOTFOUND|ECONNREFUSED|fetch failed|other side closed/i.test(message))
      ) {
        const alive = await this.client.server
          .info()
          .then(() => true)
          .catch(() => false);
        throw new ServiceUnreachable(
          alive
            ? `tier ${tier.id} lost its connection to opencode at ${this.cfg.baseUrl} mid-call (${message}), and ` +
                `opencode is already answering again — it restarted under the call rather than relaying a ` +
                `provider's error. Nothing about the code was learned; the round is requeued.`
            : `tier ${tier.id} could not reach opencode at ${this.cfg.baseUrl} — the connection dropped mid-call ` +
                `(${message}) and opencode itself is not answering. Nothing about the code was learned; the round ` +
                `is requeued.`,
          e,
        );
      }
      // A 400 NOTHING ABOVE CLAIMED: refused before a token was generated. Marked, not
      // rescued here — whether the history is to blame is `conductSession`'s question,
      // because only it knows whether this session was resumed.
      if (e instanceof HttpStatus && (e.status === 400 || e.kind === "provider.invalid-request")) {
        throw new HistoryRejected(`tier ${tier.id} (${tier.model}) failed: ${message}`, e);
      }
      throw new DidNotRun(`tier ${tier.id} (${tier.model}) failed: ${message}`, e);
    }
  }

  /**
   * Wait for the turn a prompt started, and read how it ended from the session's record.
   *
   * `wait` returns when the session is idle, which is NOT the same as "this turn ran": a
   * session that had not yet picked the prompt up is idle too. So the turn is found by the
   * user message `prompt` admitted, and it counts as finished only when an `idle` message
   * follows it — opencode writes one per execution, with its outcome (measured on 2.0.20:
   * `succeeded`, `failed` with the provider's error on the assistant message before it, or
   * `interrupted`). Anything else is waited on again, a bounded number of times, and then
   * refused: a turn whose end was never recorded is a turn nobody can claim ran.
   */
  private async awaitTurn(
    sessionId: string,
    userMessageId: string,
    signal: AbortSignal,
  ): Promise<{
    outcome: string;
    error: { type: string; message: string; status?: number } | undefined;
    text: string;
    usage: Usage;
  }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1_000));
      await this.client.session.wait({ sessionID: sessionId }, { signal }).catch((e: unknown): never => {
        throw this.wireError(e, sessionId);
      });
      const messages = (await this.messagesOf(sessionId)) as V2Message[];
      const at = messages.findIndex((m) => m.id === userMessageId);
      if (at < 0) continue;
      const after = messages.slice(at + 1);
      const end = after.findIndex((m) => m.type === "idle");
      if (end < 0) continue;
      const assistants = after.slice(0, end).filter((m) => m.type === "assistant");
      const last = assistants.at(-1);
      return {
        outcome: after[end]?.outcome ?? "unknown",
        error: last?.error,
        text: collectText(last),
        usage: collectUsage(last),
      };
    }
    throw new DidNotRun(
      `opencode reported session ${sessionId} idle five times without recording the end of the turn lore started ` +
        `(message ${userMessageId}) — the turn's outcome is unknown, so nothing it said can be used.`,
    );
  }

  /**
   * A failed request to opencode, as the error the classifier in `ask` reads.
   *
   * 404 IS ABOUT THE SESSION, not about the model or the plan: separated here so the
   * classifier cannot flatten it into `DidNotRun` — which it did once, silently disabling
   * the cold-start recovery in `conductSession`. A transport fault is passed through
   * untouched: whether it was our abort or a dropped socket is the classifier's question.
   */
  private wireError(e: unknown, sessionId: string): unknown {
    if (transportFault(e)) return e;
    const status = httpStatusOf(e);
    if (status === 404) return new SessionGone(sessionId);
    return new HttpStatus(status ?? 500, detail(e));
  }
}

/**
 * Is this provider error about the PROMPT being too big, rather than about anything else
 * a provider says "exceeded" about?
 *
 * Exported so it can be aimed at: it decides between failing a review and DOWNGRADING one
 * (`TooLargeForTier` makes the ladder step over the tier and finish `passed_thin_ladder`,
 * D-48), and a predicate that important should not live unreachable inside a catch block.
 *
 * Anchored on the PAIRING of a length phrase with an input subject rather than on either
 * alone. The first version matched the bare substring `exceed`, so "rate limit exceeded"
 * and "quota exceeded" were read as context overflows — silently trading a transient
 * failure for an attestation claiming a tier had been honestly skipped.
 */
export function isTooLong(message: string): boolean {
  const aboutLength = /too (?:long|large|many tokens)|maximum (?:context|prompt|input)|context (?:length|window)|max(?:imum)? length|length limit/i;
  const aboutInput = /prompt|context|input|message|token count|request body/i;
  return aboutLength.test(message) && aboutInput.test(message);
}

/**
 * Tokens a session consumed, summed over its assistant messages.
 *
 * Exported so it can be aimed at: it is the input to any quota accounting on BOTH the
 * success and failure paths — success reads it because `session.prompt` returns a single
 * assistant message and an agentic run is many — and getting it wrong under-counts
 * silently. `cost` is summed rather than zeroed: it was hard-zeroed while every provider
 * billed a flat subscription and reported nothing, and D-93 put a metered one on the
 * fallback path — where this is the number the daily ceiling adds up. A provider that
 * genuinely reports nothing still sums to zero, so the subscription case is unchanged.
 */
export async function usageFromMessages(res: unknown): Promise<Usage | undefined> {
  // v2 MESSAGES ARE FLAT — `{type: "assistant", tokens, cost}` — where v1 nested them
  // under `info` with a `role`. A reader left on the v1 shape finds no assistant at all
  // and returns `undefined`: spend silently unrecorded, which is exactly the under-count
  // this function exists to prevent.
  const rows = ((res as { data?: unknown[] } | undefined)?.data ?? []) as V2Message[];
  let input = 0;
  let cached = 0;
  let output = 0;
  // SUMMED, not hard-zeroed. This returned `cost: 0` on the reasoning that every provider
  // here bills a flat subscription and reports nothing — true until D-93 put a METERED
  // provider on the fallback path. A failed metered call recorded with a zero then made
  // the money it burned invisible, which is precisely the row it was added to expose: a
  // call that dies after eighty steps was paid for exactly like one that succeeded. No
  // guard reads this now (D-121) — a person does, and a person deciding whether to keep
  // paying for a route needs the failures counted. A provider that genuinely reports
  // nothing still sums to zero, so the subscription case is unchanged.
  let cost = 0;
  for (const r of rows) {
    if (r.type !== "assistant") continue;
    const t = r.tokens ?? {};
    const cache = (t["cache"] ?? {}) as Record<string, unknown>;
    input += Number(t["input"] ?? 0);
    // Reasoning is billed as output by every provider in the ladder — the single-message
    // reader (`collectUsage`) always counted it, and this sum did not, so a completed
    // review on a reasoning model under-reported exactly the tokens it spent most of.
    output += Number(t["output"] ?? 0) + Number(t["reasoning"] ?? 0);
    cached += Number(cache["read"] ?? 0) + Number(cache["write"] ?? 0);
    cost += Number(r.cost ?? 0);
  }
  if (input + cached + output === 0) return undefined;
  return { input, cached, output, cost: Number.isFinite(cost) ? cost : 0 };
}

interface Usage {
  input: number;
  cached: number;
  output: number;
  cost: number;
}

/**
 * One v2 session message, as far as lore reads it. Flat, and discriminated by `type`.
 *
 * Only the fields lore reads are named — the full union is opencode's (`SessionMessageInfo`)
 * and a wider type would invite depending on it. Read defensively for the same reason v1's
 * readers were: this is someone else's format, and a reader that throws on a shape it does
 * not know would destroy a finished review over bookkeeping.
 */
interface V2Message {
  readonly id?: string;
  readonly type?: string;
  /** `idle` messages only: how the execution ended. */
  readonly outcome?: string;
  readonly tokens?: Record<string, unknown>;
  readonly cost?: number;
  readonly error?: { readonly type: string; readonly message: string; readonly status?: number };
  readonly content?: readonly { readonly type?: string; readonly text?: string; readonly name?: string }[];
}

/**
 * The text of the assistant message that ended a turn.
 *
 * THE LAST MESSAGE ONLY, as v1 read it: the earlier assistant messages of an agentic turn
 * are the model narrating its exploration ("reading m.py…"), and the findings contract is
 * answered in the final one. Joining them all would hand the extractor prose it was never
 * meant to parse — and v1's `session.prompt` returned exactly this one message.
 */
function collectText(message: V2Message | undefined): string {
  return (message?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("\n");
}

/**
 * Coerce to a finite number, never NaN.
 *
 * `Number({read: 0, write: 0})` is NaN, and NaN reaching a NOT NULL integer column
 * fails the insert — which killed the first live review after the diff, T0 and the
 * model call had all been paid for. Usage accounting must never be the thing that
 * loses a completed review.
 */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read token usage from a reply.
 *
 * `tokens.cache` is an OBJECT — `{read, write}` — not a count. Only `read` is the
 * saving: those are tokens that were served from cache instead of being charged at
 * the full input rate. `write` is what it cost to populate the cache, and counting
 * it as cached would overstate the discount that D-29's whole cost model rests on.
 */
function collectUsage(message: V2Message | undefined): Usage {
  const tokens = message?.tokens ?? {};
  const cache = tokens["cache"];
  const cachedRead =
    typeof cache === "object" && cache !== null
      ? num((cache as Record<string, unknown>)["read"])
      : num(cache ?? tokens["cached"]);

  return {
    input: num(tokens["input"]),
    cached: cachedRead,
    // Reasoning tokens are billed as output by every provider in the ladder, so
    // omitting them would understate what a review actually cost.
    output: num(tokens["output"]) + num(tokens["reasoning"]),
    cost: num(message?.cost),
  };
}

/** Bounded, and it says when it cut — a silent truncation in a diagnostic is its own lie. */
function excerpt(text: string, max: number): string {
  const t = text ?? "";
  if (t.length === 0) return "  (empty)";
  return t.length <= max ? t : `${t.slice(0, max)}\n  … ${t.length - max} more characters not shown`;
}

/**
 * Name the SHAPE of a reply that could not be parsed.
 *
 * Empty and unparseable are different faults that lead to different places. An empty
 * reply is usually a provider failure nested inside an HTTP 200 — a bill, a quota, a
 * refusal — while prose means the model answered and ignored the output contract. The
 * first is an account problem and the second is a prompt problem, and an error that
 * does not distinguish them costs an hour of looking in the wrong one.
 */
function describeReply(which: string, text: string): string {
  const t = (text ?? "").trim();
  // "usually a provider failure inside a 200" USED TO BE HERE and is gone. It was a
  // guess presented as an explanation, in a string the client is told to repeat to its
  // user verbatim — and a client did exactly that, five times over two days, about a
  // branch whose real fault was a diff 3.4x the largest that tier had ever finished,
  // ending with a false report to a human that lore's tier was broken.
  //
  // What replaces it says only what is known — the reply was empty — and points at the
  // thing that DOES know. Where lore has the cause it belongs in `failed_because`, and
  // where it does not, silence beats a plausible story: a symptom invites a diagnosis,
  // and clients make one.
  if (t.length === 0) return `${which} reply was EMPTY — nothing to parse, and no reason given in the reply itself`;
  // Says only what it can SEE — a size and whether braces are present. It used to
  // call anything with braces "malformed JSON", which was a guess, and on 2026-08-04
  // it guessed wrong about a reply whose JSON was perfect and whose claim was 25
  // characters over a cap. The caller appends the extraction's `why`, which is the
  // part that actually knows; this half must not contradict it.
  const looksJson = t.includes("{") && t.includes("}");
  return `${which} reply was ${t.length} chars ${looksJson ? "containing a JSON object" : "of prose with no JSON block"}`;
}

/**
 * Count the agentic turns in a session's message list.
 *
 * ONE ASSISTANT MESSAGE IS ONE STEP in v2 — opencode opens a new one per model call
 * (`session.step.started` names it), which is the unit that re-sends the accumulated
 * context and therefore the unit that spends quota. v1 needed `step-start` parts to find
 * that unit, because an assistant message there could carry only a `patch`; measured on
 * 2.0.20, a four-call turn is four assistant messages, one per step event.
 *
 * `undefined`, never `0`, when the shape is not the one we know. A reply this cannot
 * read is a measurement that did not happen, and recording it as *zero exploration*
 * would bias the distribution downwards precisely when opencode's envelope has moved
 * under us — the failure mode that would make the eventual cap too tight to survive.
 * A finished review always took at least one turn, so zero is that same signal.
 */
export function countStepParts(data: unknown): number | undefined {
  if (!Array.isArray(data)) return undefined;
  const steps = (data as V2Message[]).filter((m) => m?.type === "assistant").length;
  return steps === 0 ? undefined : steps;
}

/**
 * Which tools the reviewer reached for, and how often.
 *
 * We counted `step-start` and discarded everything else, so how a tier spent its
 * turns was invisible — and that is the measurement that says what to precompute.
 * Every question the model answers with a tool call is one it could have been handed
 * for free: the branch's commits, whether it still merges, which files the base
 * touched. Those three were added by reasoning about a wrong finding rather than by
 * looking, and the looking is cheaper.
 *
 * Tolerant about shape on purpose. This reads someone else's reply format, and a
 * histogram that returns nothing is a lost measurement, never a failed review.
 */
export function toolsUsed(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(data)) return out;
  for (const message of data as V2Message[]) {
    if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "tool") continue;
      const key = typeof part.name === "string" && part.name.length > 0 ? part.name : "unknown";
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}

/** Whatever this thing is, the shortest true thing that can be said about it. */
function detail(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) return JSON.stringify(e).slice(0, 300);
  return String(e);
}

/**
 * Did this request fail before opencode answered it at all?
 *
 * The v2 client says so by type: `ClientError("Transport")` for a fetch that rejected —
 * a refused connection, a dropped socket, or our own abort. Everything opencode ANSWERED
 * arrives either as its declared error (`SessionNotFoundError`, …) or as
 * `ClientError("UnexpectedStatus")`.
 */
function transportFault(e: unknown): boolean {
  return e instanceof ClientError && e.reason === "Transport";
}

/**
 * What a request's failure was really about, when it was ours to abort.
 *
 * An abort reaches the caller as a transport fault whose `cause` is the signal's reason
 * — `longFetch` destroys the socket with it. That reason is the classified error a watcher
 * or a cancel chose (`Exhausted`, `ProbeInconclusive`, "aborted by lore"), and it is what
 * the classifier must see; the wrapper only says "the fetch failed", which is true of all
 * of them and decides none.
 */
function abortReason(e: unknown): unknown {
  return transportFault(e) && (e as Error).cause instanceof Error ? (e as Error).cause : e;
}

/**
 * The HTTP status opencode answered with, from either kind of failure the client throws.
 *
 * Declared errors carry their status only as a tag, so the tags opencode's API declares
 * are mapped back here (from `packages/protocol/openapi.json`, 2.0.22); an undeclared
 * status comes back on `ClientError.cause`. `undefined` means no status was answered.
 */
function httpStatusOf(e: unknown): number | undefined {
  if (e instanceof ClientError) {
    const status = (e.cause as { status?: unknown } | undefined)?.status;
    return typeof status === "number" ? status : undefined;
  }
  const tag = (e as { _tag?: unknown } | undefined)?._tag;
  const byTag: Record<string, number> = {
    InvalidRequestError: 400,
    InvalidCursorError: 400,
    UnauthorizedError: 401,
    SessionNotFoundError: 404,
    ConflictError: 409,
    UnknownError: 500,
    ServiceUnavailableError: 503,
  };
  return typeof tag === "string" ? byTag[tag] : undefined;
}

/**
 * Why a reply could not be read, in the words needed to fix it.
 *
 * Failure used to be a bare `undefined`, which cost a real review. glm-5.2 found a
 * genuine high-severity bug, wrote a 325-character `claim` against a 300-character
 * cap, and the whole reply was discarded; the operator was told "malformed JSON"
 * when the JSON was perfect, and the retry told the model only that its reply
 * "could not be parsed". It shortened one claim to 298 and left another at 322 —
 * complying blind with a rule nobody had named. The finding was lost, and the bug
 * it described was live in `main`.
 *
 * So the reason travels: into the retry, so the model can actually fix it, and into
 * the log, so the operator is not sent to the wrong fault.
 */
export type Extraction =
  | { readonly ok: true; readonly findings: readonly Finding[]; readonly rejected: readonly string[] }
  | { readonly ok: false; readonly why: string };

/**
 * The same shape for anything a session is asked to return in a list.
 *
 * Findings are not the only thing we ask a model for — `propose` asks for proposals,
 * with a different schema and the same three ways to fail (nothing parseable, parsed
 * but no list, parsed and every item refused). Generalised rather than copied, because
 * the candidate-ranking below is the subtle part: it already had a bug where a later,
 * worse candidate masked an earlier, better one, and a second hand-written copy would
 * have that bug again within a month.
 */
export type Listed<T> =
  | {
      readonly ok: true;
      readonly items: readonly T[];
      readonly rejected: readonly string[];
      /**
       * A fenced block that would not PARSE, while its siblings did.
       *
       * Carried apart from `rejected` — which it also appears in, so the loud reporting is
       * unchanged — because the two losses have opposite remedies and only a caller that
       * can tell them apart may act. A schema rejection is not worth re-asking: told the
       * exact rule twice, glm-5.2 shortened its claim by 44 characters and still landed 14
       * over the cap. A SYNTAX error usually means truncation, and asking again for that
       * one block is cheap on a warm session.
       *
       * A string in `rejected` would have to be sniffed for, which is the drift shape this
       * repository keeps paying for; a field cannot be mistaken for the other kind.
       */
      readonly garbled?: string;
    }
  // `rejected` on the FAILURE arm exists for exactly one consumer: a streamed done
  // declaration sharing its message with a findings block whose every item the schema
  // refused. The batch path retries such a reply; the done path cannot (done ends the
  // run), so without carrying the rejections through, they vanished — no discarded
  // note, no checks_skipped line, a D-66 loss inside a message that LOOKED complete.
  // Raised by lore's own t2 against the D-109 change.
  | { readonly ok: false; readonly why: string; readonly rejected?: readonly string[] };

/** One item, or why this one was refused while its siblings survive (D-66). */
export type ItemParser<T> = (raw: unknown, index: number, total: number) => T | { readonly rejected: string };

/** The first zod issue, as `path: message` — enough to act on, short enough to send. */
function firstIssue(error: z.ZodError): string {
  const i = error.issues[0];
  if (i === undefined) return "rejected by the finding schema";
  const path = i.path.join(".");
  return path === "" ? i.message : `${path}: ${i.message}`;
}

/**
 * Pull a named list out of a reply, however the model wrapped it.
 *
 * Fenced block, several fenced blocks, a bare object after prose — models do all of
 * these, and the reply is paid for either way. The ranking below is why this is one
 * function rather than one per caller: it already had a bug where a later, worse
 * candidate masked an earlier, better one, and a hand-written second copy would grow
 * that bug again.
 *
 * Never returns an empty list on failure. An empty list means the model said clean —
 * or had no proposals — and conflating that with "could not be read" is exactly INV-1's
 * failure.
 */
export function extractList<T>(text: string, key: string, parseOne: ItemParser<T>): Listed<T> {
  const block = /```(?:json)?\s*([\s\S]*?)```/g;
  // Fenced candidates are the model SPEAKING THE CONTRACT; the bare-brace candidate is
  // synthetic, for models that ignore the fence — and the difference decides what a
  // parse failure MEANS. A fenced block that does not parse is an attempt the
  // transport mangled and must be reportable as a loss; the synthetic tail of a
  // perfectly good fenced message fails to parse on every reply (it drags the
  // trailing fence along) and means nothing.
  const candidates: { readonly text: string; readonly fenced: boolean }[] = [];
  for (const m of text.matchAll(block)) candidates.push({ text: m[1] ?? "", fenced: true });
  const brace = text.indexOf("{");
  if (brace >= 0) candidates.push({ text: text.slice(brace), fenced: false });

  // The reason comes from the candidate that got FURTHEST, which needs a rank —
  // the comment claimed this before the code did it, and simply overwrote `why`
  // per candidate, so a later, worse candidate masked an earlier, better one. A
  // reply whose fenced block parsed but had no `findings`, followed by a stray
  // brace in trailing prose, reported the stray brace's syntax error and hid the
  // real fault, with that exact reply as the reproduction.
  const NO_JSON = 0;
  const UNPARSEABLE = 1;
  const NO_LIST = 2;
  let got = NO_JSON;
  let why = `no JSON object containing a \`${key}\` array`;
  /** The MOST RECENT fenced block that would not parse — see `garbledAll` for every one. */
  let fencedGarbled: string | undefined;
  // lore-ok[9857f644]: EVERY GARBLED CANDIDATE, not the last. `fencedGarbled` above is
  // last-write-wins and stays that way — it feeds the single-block re-ask prompt, which
  // can only usefully name one thing — but a reply with TWO truncated fences used to lose
  // the first one's loss note entirely: nothing pushed it anywhere before the second
  // overwrote the variable. Found by lore's own review of the b2aef74f fix, which united
  // the two loss KINDS without noticing multiple candidates of the SAME kind still
  // clobbered each other.
  const garbledAll: string[] = [];
  const note = (rank: number, reason: string) => {
    if (rank < got) return;
    got = rank;
    why = reason;
  };

  // EVERY CANDIDATE THAT PARSES AND YIELDS A LIST CONTRIBUTES — not only the first.
  //
  // This used to `return` inside the loop on the first candidate that produced any
  // valid item, so a message carrying TWO fenced findings blocks — a natural reading of
  // "report each finding the moment you are sure of it; a small batch is acceptable" —
  // silently lost every finding after the first: nothing recorded, nothing in
  // `discarded`, no retry, and the model — told "recorded and delivered" — believed
  // both had been filed.
  //
  // Merging is safe against the SYNTHETIC brace candidate double-counting a fenced one:
  // that candidate spans from the first `{` in the WHOLE text to its end, so for any
  // reply that has more than one JSON object in it — fenced or not — parsing it lands
  // on trailing content after the first balanced object and throws (the docstring above
  // already establishes this: "the synthetic tail of a perfectly good fenced message
  // fails to parse on every reply … and means nothing"). It only ever reaches a
  // successful merge when it is the SOLE candidate — a model that skipped the fence
  // entirely — where there is nothing for it to duplicate.
  const merged: T[] = [];
  const mergedRejected: string[] = [];
  let sawSuccess = false;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.text.trim());
    } catch (e) {
      note(UNPARSEABLE, `JSON did not parse: ${detail(e)}`);
      if (candidate.fenced) {
        const msg = `a fenced JSON block did not parse: ${detail(e)}`;
        fencedGarbled = msg;
        garbledAll.push(msg);
      }
      continue;
    }
    const list = (parsed as Record<string, unknown> | null)?.[key];
    if (!Array.isArray(list)) {
      note(NO_LIST, `parsed as JSON, but there was no \`${key}\` array`);
      continue;
    }
    // THE VALID FINDINGS SURVIVE ONE BAD SIBLING (D-66).
    //
    // This used to discard the whole reply. The argument was that keeping the good
    // ones would "silently drop a defect the model actually found" — and the premise
    // was the word SILENTLY, not the dropping. Discarding everything drops that same
    // defect AND every valid finding beside it, which is strictly worse on the axis
    // the rule was defending.
    //
    // The cost was measured. Five paid replies were binned this way; the worst was a
    // t2 round of FORTY MINUTES whose single finding — over the claim cap by 14
    // characters — was correct and load-bearing: `openFindings` had no latest-verdict
    // gate, so a justification accepted and later rejected counted as neither open nor
    // settled. It was fixed from the error message alone. The cap filtered a real
    // defect and charged forty minutes for it.
    //
    // And the retry does not rescue it: told the exact rule, glm-5.2 shortened its
    // claim by 44 characters and still landed 14 over. Twice.
    //
    // So: take what parsed, and make the loss LOUD — logged here, carried on the
    // result, and reported to the client so a clean round is never read as a complete
    // one. A reply where NOTHING parsed is still a failed reply.
    const out: T[] = [];
    const rejected: string[] = [];
    for (const [i, raw] of list.entries()) {
      const res = parseOne(raw, i, list.length);
      if (typeof res === "object" && res !== null && "rejected" in res) {
        rejected.push(res.rejected);
        continue;
      }
      out.push(res as T);
    }
    // lore-ok[ad5927ae]: upheld, and fixed at the success arm's return rather than here.
    // This branch is the ALL-REJECTED shape and already merges its losses; the one that
    // was missing is the UNPARSEABLE sibling, which never reaches this branch at all —
    // it fails at `JSON.parse` above and lands in `fencedGarbled`. So the fix belongs
    // where the success arm builds its result, and that is where it now is: `fencedGarbled`
    // rides out with `rejected` on `ok: true` too.
    if (out.length === 0 && rejected.length > 0) {
      note(NO_LIST, `all ${rejected.length} ${key.replace(/s$/, "")}(s) were rejected — ${rejected[0] ?? ""}`);
      // MERGED, and EVERY all-rejected candidate's — not just this one's, and not a
      // separate `allRejected` scalar that only the last such candidate would survive
      // into, fingerprint 9857f644. `mergedRejected` already accumulates across every
      // candidate that reaches here, which is also everything the failure arm below
      // needs: when `sawSuccess` never becomes true, nothing but this branch ever
      // pushed into it.
      mergedRejected.push(...rejected);
      continue;
    }
    sawSuccess = true;
    merged.push(...out);
    mergedRejected.push(...rejected);
  }
  if (sawSuccess) {
    // A GARBLED SIBLING IS A LOSS ON THE SUCCESS ARM TOO. The merge above carries
    // schema-REJECTED siblings, and stopped there — so a second fenced block the
    // transport truncated, sitting beside a valid first one, vanished with no
    // `discarded` note at all: the model tried to report something and nothing anywhere
    // says so. That is precisely the hole the done-laundering fix closed on the FAILURE
    // arm, reopened on the arm that looks healthy.
    return {
      ok: true,
      items: merged,
      rejected: [...mergedRejected, ...garbledAll],
      // AND SEPARATELY, so the caller can ask for it again. It stays in `rejected` above:
      // if the re-ask fails, the loss must still be reported exactly as it was before.
      ...(fencedGarbled === undefined ? {} : { garbled: fencedGarbled }),
    };
  }
  // The losses ride the failure DIRECTLY, never inferred from `why`: the rank above
  // exists to surface the best DIAGNOSIS, so a later candidate's wording lawfully
  // overwrites an earlier one's — a done block's "no findings array" outranking a
  // mangled block's parse error — and any consumer sniffing `why` for the loss reads
  // the survivor, not the casualty. Exactly that hole shipped once and lore's own t2
  // caught it: a truncated findings fence beside a valid done fence vanished without a
  // note, behind a comment claiming it could not.
  //
  // BOTH KINDS, AND EVERY CANDIDATE OF EACH — found by lore's own review across two
  // rounds. First, fingerprint b2aef74f: a truncated fence (JSON.parse fails) and a
  // complete fence whose every item the schema refuses are independent losses that can
  // both be present in one reply, and a bare `allRejected ?? [fencedGarbled]` let the
  // second evict the first. Then, fingerprint 9857f644: fixing that by uniting the two
  // KINDS still left each one tracked as a single last-write-wins scalar, so two
  // candidates failing the SAME way still clobbered each other. `mergedRejected` and
  // `garbledAll` accumulate across every candidate of their kind, so nothing here can
  // evict anything else.
  const lost = [...mergedRejected, ...garbledAll];
  return { ok: false, why, ...(lost.length === 0 ? {} : { rejected: lost }) };
}

/**
 * Pull findings out of a reply.
 *
 * Never returns an empty array on failure. An empty array means the model said clean,
 * and conflating "said clean" with "could not be read" is exactly INV-1's failure.
 */
const parseFindingItem: ItemParser<Finding> = (raw, i, n) => {
  const res = FindingSchema.safeParse(raw);
  return res.success
    ? res.data
    : { rejected: `finding ${i + 1} of ${n}: ${firstIssue(res.error)} — ${excerpt(JSON.stringify(raw), 300)}` };
};

/**
 * What a tier is asked, in the two shapes a continued session needs (D-80).
 *
 * A bare string is every caller that does not keep a session — the knowledge screen, the
 * proposer, and any tier with `conversation` off. The pair is the review loop: `initial`
 * orients a session being created, `continued` is the next message to one already holding
 * the repository.
 */
export type Prompt = string | { readonly initial: string; readonly continued: string };

/** Findings in the generic shape, for `review()`. */
export const findingsOf = (text: string): Listed<Finding> => extractList<Finding>(text, "findings", parseFindingItem);

/**
 * One STREAMED emission (D-107): findings the model has in hand, or the done declaration.
 *
 * `done` and `findings` are distinguishable ON PURPOSE: an empty findings list is a
 * contract failure here, never "clean" — under emit-and-stop, having nothing more to say
 * IS the done declaration, and a model that sends `[]` is confused in a way the retry
 * should surface. The done marker is INV-1's corner of the whole design: only the
 * declaration ends a run; silence and death never do.
 */
export interface Emission {
  readonly findings: readonly Finding[];
  readonly done: boolean;
}

export function emissionOf(text: string): Listed<Finding> & { readonly done?: boolean } {
  // FINDINGS FIRST, DONE SECOND, AND BOTH MAY BE IN ONE BLOCK. The first version
  // checked the done marker first and RETURNED on it — so a model wrapping up with
  // {"findings":[...],"done":true} lost every finding in that block, silently: no
  // error, no retry, no log, and a run that could reach `passed` on code the model
  // had explicitly flagged. Raised by lore's own review of this change. The two are
  // independent facts about one message and are read independently.
  let done = false;
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) {
    try {
      const parsed = JSON.parse((m[1] ?? "").trim()) as { done?: unknown };
      if (parsed !== null && typeof parsed === "object" && parsed.done === true) done = true;
    } catch {
      // Not JSON, or not the marker — the findings path below owns the error wording.
    }
  }
  const r = findingsOf(text);
  if (!r.ok) {
    if (!done) return r;
    // A pure done declaration has no findings list at all, and that is its ordinary
    // shape — not a contract failure. But what the model TRIED to report beside its
    // done marker must still reach D-66's channel: the batch path would have retried
    // this reply, and done forecloses the retry. The failure CARRIES its own losses
    // (`rejected` — schema-refused items, or a fenced block that would not parse);
    // they are read directly, never inferred from `why`, whose ranked wording a
    // healthy done block lawfully overwrites — the sniffing version of this line
    // shipped and lore's own t2 refuted it with exactly that shape.
    return { ok: true, items: [], rejected: r.rejected ?? [], done: true };
  }
  if (r.items.length === 0 && r.rejected.length === 0 && !done) {
    // See the docblock: [] is not clean here. Refused with the instruction the retry
    // needs, because the fix is to SAY done, not to send an emptier list.
    return { ok: false, why: 'an empty "findings" list is not a streamed emission — report a finding, or declare {"done": true}' };
  }
  return { ...r, done };
}

export function extractFindings(text: string): Extraction {
  const r = findingsOf(text);
  return r.ok ? { ok: true, findings: r.items, rejected: r.rejected } : r;
}
