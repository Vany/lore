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
import { createOpencodeClient } from "@opencode-ai/sdk";
import { DidNotRun, Exhausted, ProviderAuthFailed, TooLargeForTier } from "../core/errors.ts";
import { FindingSchema, type Finding } from "../core/finding.ts";
import type { Tier } from "../core/ladder.ts";
import { Gate, type GateState } from "./gate.ts";
import { DEFAULT_TIMEOUT_MS, longFetch } from "./long-fetch.ts";
import { OUTPUT_CONTRACT } from "./prompts.ts";

export interface ReviewerConfig {
  readonly baseUrl: string;
  /** Read-only agent name. Belt; the explicit tool denial below is braces. */
  readonly agent: string;
  readonly timeoutMs: number;
  /** HTTP basic credentials, when the opencode server is password-protected. */
  readonly username?: string;
  readonly password?: string;
  /**
   * How many model calls may be in flight at once, across every review.
   *
   * Deliberately NOT `LORE_CONCURRENCY`, which sizes the local sandbox by cores. See
   * `gate.ts`: the two resources have opposite constraints, and the provider was what
   * broke first — four reviews dead in 2.5 minutes when the local knob went to 12.
   */
  readonly modelConcurrency: number;
}

export const DEFAULT_REVIEWER: ReviewerConfig = {
  baseUrl: process.env["OPENCODE_SERVER"] ?? "http://127.0.0.1:4096",
  agent: "readonly",
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
  // `LORE_CONCURRENCY` used to imply. Four leaves room above the known-good figure
  // while staying well under the known-bad one, and work above it queues rather than
  // failing, so being wrong low costs latency and being wrong high costs quota.
  //
  // Raise it with `LORE_MODEL_CONCURRENCY` once there is evidence, not before — the
  // number that matters is the provider's and we cannot see it.
  modelConcurrency: 4,
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
    prompt: string,
    worktree: string,
    reviewId?: string,
    /** Asked once a provider slot is won: `false` means do not spend it. */
    stillWanted?: () => boolean,
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
   * Ask a tier for something that is not findings — a knowledge screen, a proposal.
   *
   * Optional for the same reason `cancel` is: a fake reviewer in a round test has no
   * business modelling it, and a round whose reviewer cannot answer this simply ingests
   * without screening and stamps the rows so the next one retries. A knowledge base is
   * never emptied because a classifier was unavailable.
   */
  askFor?<T>(
    tier: Tier,
    prompt: string,
    worktree: string,
    extract: (text: string) => Listed<T>,
    contract: string,
    /** The review this belongs to, so a cancel can reach it. Absent outside a review. */
    reviewId?: string,
    /** Asked once a provider slot is won: `false` means do not spend it. */
    stillWanted?: () => boolean,
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
 * Tools a reviewer must never have.
 *
 * Read and search are left on deliberately: an agentic reviewer that can explore
 * the repo measured 70.5% higher comment acceptance than one handed a diff, and
 * exploring needs reading.
 */
const DENIED_TOOLS: Readonly<Record<string, boolean>> = {
  write: false,
  edit: false,
  patch: false,
  todowrite: false,
};

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

  constructor(status: number, detail: string) {
    super(`opencode returned ${status}: ${detail}`);
    this.name = "HttpStatus";
    this.status = status;
  }
}

/** `openrouter/z-ai/glm-5.2` → provider `openrouter`, model `z-ai/glm-5.2`. */
export function splitModel(id: string): { providerID: string; modelID: string } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new DidNotRun(`model id '${id}' is not provider/model`);
  }
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

export class Reviewer implements ReviewerLike {
  private readonly client: ReturnType<typeof createOpencodeClient>;
  private readonly cfg: ReviewerConfig;
  private readonly gate: Gate;
  /** Lazily fetched, cached for the process: model id -> advertised context window. */
  private limits?: Promise<Map<string, number>>;
  /** review id -> the opencode session currently reading for it, so `cancel` can stop it. */
  private readonly sessions = new Map<string, string>();

  constructor(cfg: ReviewerConfig = DEFAULT_REVIEWER) {
    this.cfg = cfg;
    this.gate = new Gate(cfg.modelConcurrency);
    const basic =
      cfg.password === undefined
        ? undefined
        : `Basic ${Buffer.from(`${cfg.username ?? ""}:${cfg.password}`).toString("base64")}`;
    this.client = createOpencodeClient({
      baseUrl: cfg.baseUrl,
      // Node's fetch gives up after 300s with a bare "fetch failed". A deep tier
      // routinely takes longer than that, and losing a review to an invisible
      // transport default is the worst kind of failure: it looks like the model.
      fetch: longFetch(cfg.timeoutMs),
      ...(basic === undefined ? {} : { headers: { Authorization: basic } }),
    });
  }

  /**
   * Run one tier against one prompt.
   *
   * A fresh session per tier run, not a pool. opencode sessions are single-flight,
   * and the predecessor's pool existed to work around a global lock that no longer
   * exists (INV-5, INV-6) — reviews are already parallel because each has its own
   * worktree, so sharing sessions would only reintroduce contention.
   */
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
  async cancel(reviewId: string): Promise<boolean> {
    const sessionId = this.sessions.get(reviewId);
    if (sessionId === undefined) return false;
    await this.abort(sessionId);
    this.sessions.delete(reviewId);
    return true;
  }

  /**
   * The last free moment: a slot has been won, nothing has been created or sent yet.
   *
   * A call can wait a long time at the provider gate — that is what the gate is for —
   * and it holds no session while it waits, because the session does not exist until
   * `conductSession` runs. So `cancel` finds nothing to abort and truthfully reports
   * nothing in flight, and then the slot frees and the queued call spends anyway on a
   * review somebody ended. Asking here closes that window for BOTH callers, which is why
   * it lives at the one point they share rather than in each of them.
   */
  private guard<T>(reviewId: string | undefined, stillWanted: (() => boolean) | undefined, run: () => Promise<T>) {
    return this.gate.run(() => {
      if (stillWanted?.() === false) {
        throw new DidNotRun(
          `review ${reviewId ?? "?"} was ended while this call waited for a provider slot — nothing was spent on it.`,
        );
      }
      return run();
    });
  }

  async review(
    tier: Tier,
    prompt: string,
    worktree: string,
    reviewId?: string,
    stillWanted?: () => boolean,
  ): Promise<ReviewerResult> {
    if (tier.model === undefined) throw new DidNotRun(`tier ${tier.id} has no model`);
    // The gate wraps the SESSION, not the request. What loads a provider is the
    // agentic exploration between them (`gate.ts`), so bounding individual HTTP calls
    // would bound nothing. Waiting here queues the round instead of failing it, which
    // is the same trade as backpressure: a review that dies on a 429 did not run.
    const r = await this.guard(reviewId, stillWanted, () =>
      this.conductSession<Finding>(tier, prompt, worktree, reviewId, findingsOf, OUTPUT_CONTRACT),
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
    prompt: string,
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
  ): Promise<SessionResult<T>> {
    if (tier.model === undefined) throw new DidNotRun(`tier ${tier.id} has no model`);
    return this.guard(reviewId, stillWanted, () =>
      this.conductSession<T>(tier, prompt, worktree, reviewId, extract, contract),
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

  /** ~4 characters per token. Rough, and only ever used with a wide margin. */
  private static readonly CHARS_PER_TOKEN = 4;

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
    const limit = await this.contextLimit(tier.model ?? "");
    return limit === undefined ? undefined : Math.floor(limit * Reviewer.PROMPT_SHARE * Reviewer.CHARS_PER_TOKEN);
  }

  /** Advertised context window for a provider-qualified model id, cached per process. */
  private async contextLimit(model: string): Promise<number | undefined> {
    if (this.limits === undefined) {
      this.limits = (async (): Promise<Map<string, number>> => {
        const out = new Map<string, number>();
        const res = await this.client.config.providers().catch(() => undefined);
        for (const p of res?.data?.providers ?? []) {
          for (const [id, m] of Object.entries(p.models ?? {})) {
            const ctx = (m as { limit?: { context?: number } }).limit?.context;
            if (typeof ctx === "number" && ctx > 0) out.set(`${p.id}/${id}`, ctx);
          }
        }
        return out;
      })();
    }
    return (await this.limits).get(model);
  }

  /** What `review` does once it holds a slot. */
  private async conductSession<T>(
    tier: Tier,
    prompt: string,
    worktree: string,
    reviewId: string | undefined,
    extract: (text: string) => Listed<T>,
    contract: string,
  ): Promise<SessionResult<T>> {
    const started = Date.now();
    const sessionId = await this.createSession(tier);
    // Registered so `cancel` can reach it. Cleared in `finally` whatever happens —
    // a stale entry would have a later cancel abort a session that had already ended,
    // or worse, one belonging to a different round of the same review.
    if (reviewId !== undefined) this.sessions.set(reviewId, sessionId);

    try {
      return await this.conduct(sessionId, tier, prompt, worktree, started, extract, contract);
    } catch (e) {
      // ABANDONING THE REQUEST DOES NOT STOP THE MODEL.
      //
      // Measured: three T2 calls that failed client-side went on to consume
      // ~3.7M cached-read tokens between them, because the agent kept exploring
      // the repository after we had stopped listening. A timeout that only frees
      // the caller is not a budget — it just makes the spend invisible.
      await this.abort(sessionId);
      throw e;
    } finally {
      if (reviewId !== undefined && this.sessions.get(reviewId) === sessionId) {
        this.sessions.delete(reviewId);
      }
    }
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
    const failure = await this.client.session
      .abort({ path: { id: sessionId } })
      .then((r) => ((r.response?.status ?? 200) >= 400 ? `opencode answered ${r.response?.status}` : undefined))
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
    worktree: string,
    started: number,
    extract: (text: string) => Listed<T>,
    contract: string,
  ): Promise<SessionResult<T>> {
    const first = await this.ask(sessionId, tier, `${prompt}\n\n${contract}`, worktree);

    let extracted = extract(first.text);
    let retried = false;
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
        worktree,
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
      extracted = retry;
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

    return {
      items: extracted.items,
      raw: first.text,
      inputTokens: first.usage.input,
      cachedTokens: first.usage.cached,
      outputTokens: first.usage.output,
      costUsd: first.usage.cost,
      latencyMs,
      retried,
      rejected: extracted.rejected,
      steps: await this.countSteps(sessionId),
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
  private async countSteps(sessionId: string): Promise<number | undefined> {
    // Three outcomes, three sentences, because the first draft of this reported an
    // unreachable server as "opencode answered 200" — caught by pointing it at a
    // dead port and reading what it actually printed. A diagnostic that invents a
    // status is the same defect as the one `createSession` above exists to fix.
    const seen = await this.client.session
      .messages({ path: { id: sessionId } })
      .then((r) => ({ status: r.response?.status ?? 200, data: r.data, error: r.error }))
      .catch((e: unknown) => ({ status: undefined, data: undefined, error: e }));

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

  private async createSession(tier: Tier): Promise<string> {
    // The ONE case where "is a server running?" is the right question, and until now
    // the one case that never asked it: an unreachable server makes this call REJECT
    // while every answered request comes back as a return value. Verified against a
    // dead port — `connect ECONNREFUSED` through `longFetch`, `TypeError: fetch
    // failed` through plain fetch. Unwrapped, either one reaches the worker naming
    // neither the tier nor the address it could not reach.
    const res = await this.client.session
      .create({ body: { title: `lore-${tier.id}-${Date.now()}` } })
      .catch((e: unknown): never => {
        throw new DidNotRun(
          `tier ${tier.id} could not reach opencode at ${this.cfg.baseUrl} (${detail(e)})` +
            " — is a server running there?",
          e,
        );
      });

    // And the case that made this necessary. A server that is up and refusing
    // answers with a status and no session id, so blaming the missing id sent
    // debugging at connectivity twice in one day while opencode was up. Verified
    // against a password-protected opencode: a bare 401, `data` undefined and
    // `error` an EMPTY OBJECT — the status is the only thing that names the fault,
    // which is why it is in the message before the body is.
    //
    // DidNotRun rather than Exhausted even on a 429: creating a session touches no
    // provider, so a refusal here is opencode or something in front of it, and
    // calling it quota would step the tier over as unpayable (D-48) for a reason
    // that has nothing to do with money.
    const status = res.response?.status ?? 200;
    if (status >= 400) {
      const hint = status === 401 || status === 403 ? " — check OPENCODE_SERVER_USERNAME/PASSWORD" : "";
      throw new DidNotRun(
        `tier ${tier.id} could not open a session: opencode at ${this.cfg.baseUrl} returned ${status}` +
          ` ${JSON.stringify(res.error ?? {}).slice(0, 300)}${hint}`,
      );
    }

    const id = (res.data as { id?: string } | undefined)?.id;
    if (id === undefined) {
      throw new DidNotRun(`opencode answered ${status} with no session id (${this.cfg.baseUrl})`);
    }
    return id;
  }

  private async ask(
    sessionId: string,
    tier: Tier,
    text: string,
    worktree: string,
  ): Promise<{ text: string; usage: Usage }> {
    try {
      const res = await this.client.session.prompt({
        path: { id: sessionId },
        query: { directory: worktree },
        body: {
          model: splitModel(tier.model ?? ""),
          agent: this.cfg.agent,
          system: READ_ONLY_SYSTEM,
          tools: { ...DENIED_TOOLS },
          parts: [{ type: "text", text }],
        },
      });

      // The SDK does NOT throw on a non-2xx — it returns the status and an error
      // body. Without this check a 429 fell through to the parser, came back
      // unparseable, and was reported as "did not return findings" (exit 70)
      // instead of "out of quota" (exit 75) — losing the quota alert and the
      // spend-ceiling behaviour with it.
      const status = res.response?.status ?? 200;
      if (status >= 400) {
        throw new HttpStatus(status, JSON.stringify(res.error ?? {}).slice(0, 300));
      }

      // opencode answers 200 and nests the PROVIDER's failure in the message body,
      // so the transport status says nothing about whether the model ran. Without
      // this, "insufficient credits" (402) arrives as an empty assistant message,
      // fails to parse, and is reported as "the model did not return findings" —
      // sending someone to debug a prompt when the real answer is an unpaid bill.
      const embedded = providerError(res.data);
      if (embedded !== undefined) {
        throw new HttpStatus(embedded.statusCode, embedded.message);
      }

      return { text: collectText(res.data), usage: collectUsage(res.data) };
    } catch (e) {
      const status = e instanceof HttpStatus ? e.status : undefined;
      const message = e instanceof Error ? e.message : String(e);
      // Quota is never a reason to fall through to another tier or provider: a
      // tier that did not run found nothing, which is not finding nothing.
      if (status === 429 || status === 402 || /rate.?limit|quota|insufficient/i.test(message)) {
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
      if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authentication/i.test(message)) {
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
      // finishes `passed_partial` — weaker evidence, honestly labelled, which is the
      // whole of D-48. The same lesson as the 741 KB branch that failed five times.
      if (/exceed|too long|too large|maximum context|context length|max length/i.test(message)) {
        throw TooLargeForTier.refusedAsTooLong(tier.id, tier.model ?? "", text.length, message);
      }
      throw new DidNotRun(`tier ${tier.id} (${tier.model}) failed: ${message}`, e);
    }
  }
}

interface Usage {
  input: number;
  cached: number;
  output: number;
  cost: number;
}

/**
 * Pull a provider failure out of an otherwise-successful reply.
 *
 * `data.info.error` is where opencode records that the model call itself failed —
 * bad key, no credits, rate limit — while the HTTP exchange with opencode
 * succeeded. Two different layers, two different verdicts, and only one of them is
 * visible in the status code.
 */
function providerError(data: unknown): { statusCode: number; message: string } | undefined {
  const err = (data as { info?: { error?: { name?: string; data?: { message?: string; statusCode?: number } } } })
    ?.info?.error;
  if (err === undefined) return undefined;
  return {
    statusCode: err.data?.statusCode ?? 500,
    message: `${err.name ?? "provider error"}: ${err.data?.message ?? "no detail"}`,
  };
}

/** Defensive: the response shape varies across opencode versions. */
function collectText(data: unknown): string {
  if (typeof data === "string") return data;
  const parts = (data as { parts?: { type?: string; text?: string }[] } | undefined)?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  const info = (data as { info?: { parts?: { text?: string }[] } } | undefined)?.info?.parts;
  if (Array.isArray(info)) return info.map((p) => p.text ?? "").join("\n");
  return typeof data === "object" && data !== null ? JSON.stringify(data) : String(data ?? "");
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
function collectUsage(data: unknown): Usage {
  const info = (data as { info?: { tokens?: Record<string, unknown>; cost?: number } } | undefined)?.info;
  const tokens = info?.tokens ?? {};
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
    cost: num(info?.cost),
  };
}

/**
 * Count the agentic turns in a session's message list.
 *
 * `step-start` rather than assistant messages: a step is one model turn, which is
 * the unit that re-sends the accumulated context and therefore the unit that spends
 * quota. Counted against a real GLM review session (`review_glm_r181`, the
 * predecessor's, same read-only agent) — 82 `step-start` parts across 86 assistant
 * messages, the other four carrying only `patch` parts, so the two counts are close
 * but not the same and only one of them means "the model was asked again".
 *
 * `undefined`, never `0`, when the shape is not the one we know. A reply this cannot
 * read is a measurement that did not happen, and recording it as *zero exploration*
 * would bias the distribution downwards precisely when opencode's envelope has moved
 * under us — the failure mode that would make the eventual cap too tight to survive.
 * A finished review always took at least one turn, so zero is that same signal.
 */
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
  if (t.length === 0) return `${which} reply was EMPTY (usually a provider failure inside a 200)`;
  // Says only what it can SEE — a size and whether braces are present. It used to
  // call anything with braces "malformed JSON", which was a guess, and on 2026-08-04
  // it guessed wrong about a reply whose JSON was perfect and whose claim was 25
  // characters over a cap. The caller appends the extraction's `why`, which is the
  // part that actually knows; this half must not contradict it.
  const looksJson = t.includes("{") && t.includes("}");
  return `${which} reply was ${t.length} chars ${looksJson ? "containing a JSON object" : "of prose with no JSON block"}`;
}

export function countStepParts(data: unknown): number | undefined {
  if (!Array.isArray(data)) return undefined;
  let steps = 0;
  for (const message of data as { parts?: unknown }[]) {
    const parts = message?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts as { type?: unknown }[]) {
      if (part?.type === "step-start") steps++;
    }
  }
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
  for (const message of data as { parts?: unknown }[]) {
    const parts = message?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts as Record<string, unknown>[]) {
      if (part?.["type"] !== "tool") continue;
      const name = part["tool"] ?? part["name"] ?? (part["state"] as Record<string, unknown> | undefined)?.["title"];
      const key = typeof name === "string" && name.length > 0 ? name : "unknown";
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
  | { readonly ok: true; readonly items: readonly T[]; readonly rejected: readonly string[] }
  | { readonly ok: false; readonly why: string };

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
  const candidates: string[] = [];
  for (const m of text.matchAll(block)) candidates.push(m[1] ?? "");
  // A bare object, for models that ignore the fence.
  const brace = text.indexOf("{");
  if (brace >= 0) candidates.push(text.slice(brace));

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
  const note = (rank: number, reason: string) => {
    if (rank < got) return;
    got = rank;
    why = reason;
  };

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch (e) {
      note(UNPARSEABLE, `JSON did not parse: ${detail(e)}`);
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
    if (out.length === 0 && rejected.length > 0) {
      note(NO_LIST, `all ${rejected.length} ${key.replace(/s$/, "")}(s) were rejected — ${rejected[0] ?? ""}`);
      continue;
    }
    return { ok: true, items: out, rejected };
  }
  return { ok: false, why };
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

/** Findings in the generic shape, for `review()`. */
export const findingsOf = (text: string): Listed<Finding> => extractList<Finding>(text, "findings", parseFindingItem);

export function extractFindings(text: string): Extraction {
  const r = findingsOf(text);
  return r.ok ? { ok: true, findings: r.items, rejected: r.rejected } : r;
}
