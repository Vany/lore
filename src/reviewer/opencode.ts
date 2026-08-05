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
import { DidNotRun, Exhausted } from "../core/errors.ts";
import { FindingSchema, type Finding } from "../core/finding.ts";
import type { Tier } from "../core/ladder.ts";
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
  review(tier: Tier, prompt: string, worktree: string): Promise<ReviewerResult>;
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

  constructor(cfg: ReviewerConfig = DEFAULT_REVIEWER) {
    this.cfg = cfg;
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
  async review(tier: Tier, prompt: string, worktree: string): Promise<ReviewerResult> {
    if (tier.model === undefined) throw new DidNotRun(`tier ${tier.id} has no model`);
    const started = Date.now();
    const sessionId = await this.createSession(tier);

    try {
      return await this.conduct(sessionId, tier, prompt, worktree, started);
    } catch (e) {
      // ABANDONING THE REQUEST DOES NOT STOP THE MODEL.
      //
      // Measured: three T2 calls that failed client-side went on to consume
      // ~3.7M cached-read tokens between them, because the agent kept exploring
      // the repository after we had stopped listening. A timeout that only frees
      // the caller is not a budget — it just makes the spend invisible.
      await this.abort(sessionId);
      throw e;
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

  private async conduct(
    sessionId: string,
    tier: Tier,
    prompt: string,
    worktree: string,
    started: number,
  ): Promise<ReviewerResult> {
    const first = await this.ask(sessionId, tier, `${prompt}\n\n${OUTPUT_CONTRACT}`, worktree);

    let extracted = extractFindings(first.text);
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
          `Fix exactly that and reply again with ONLY the json block.\n\n${OUTPUT_CONTRACT}`,
        worktree,
      );
      const retry = extractFindings(second.text);
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
        // thrown three lines below it instead of contradicting it (f7c4a9b8).
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
          `tier ${tier.id} (${tier.model}) did not return usable findings after a retry — this review DID NOT RUN. ` +
            `${describeReply("first", first.text)}: ${extracted.why}; ` +
            `${describeReply("retry", second.text)}: ${retry.why}. ` +
            "The full replies are on [lore:log].",
        );
      }
      extracted = retry;
      first.usage = second.usage;
    }

    // Loud, always: a discarded finding is a defect this tier saw and we threw away.
    if (extracted.rejected.length > 0) {
      console.error(
        `[lore:log] tier ${tier.id} (${tier.model}) had ${extracted.rejected.length} finding(s) rejected by the ` +
          `schema; the other ${extracted.findings.length} were kept. ${extracted.rejected.join(" | ")}`,
      );
    }

    // Taken before the step count, because that costs an extra round trip to
    // opencode and latency is meant to describe the review, not the bookkeeping.
    const latencyMs = Date.now() - started;

    return {
      findings: extracted.findings,
      raw: first.text,
      inputTokens: first.usage.input,
      cachedTokens: first.usage.cached,
      outputTokens: first.usage.output,
      costUsd: first.usage.cost,
      latencyMs,
      retried,
      discarded: extracted.rejected,
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

/** The first zod issue, as `path: message` — enough to act on, short enough to send. */
function firstIssue(error: z.ZodError): string {
  const i = error.issues[0];
  if (i === undefined) return "rejected by the finding schema";
  const path = i.path.join(".");
  return path === "" ? i.message : `${path}: ${i.message}`;
}

/**
 * Pull findings out of a reply.
 *
 * Never returns an empty array on failure. An empty array means the model said
 * clean, and conflating "said clean" with "could not be read" is exactly INV-1's
 * failure.
 */
export function extractFindings(text: string): Extraction {
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
  // real fault. Raised against this function by t3 (b8554687), with that exact
  // reply as the reproduction.
  const NO_JSON = 0;
  const UNPARSEABLE = 1;
  const NO_LIST = 2;
  let got = NO_JSON;
  let why = "no JSON object containing a `findings` array";
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
    const list = (parsed as { findings?: unknown })?.findings;
    if (!Array.isArray(list)) {
      note(NO_LIST, "parsed as JSON, but there was no `findings` array");
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
    const out: Finding[] = [];
    const rejected: string[] = [];
    for (const [i, raw] of list.entries()) {
      const res = FindingSchema.safeParse(raw);
      if (!res.success) {
        rejected.push(`finding ${i + 1} of ${list.length}: ${firstIssue(res.error)} — ${excerpt(JSON.stringify(raw), 300)}`);
        continue;
      }
      out.push(res.data);
    }
    if (out.length === 0 && rejected.length > 0) {
      note(NO_LIST, `all ${rejected.length} finding(s) were rejected — ${rejected[0] ?? ""}`);
      continue;
    }
    return { ok: true, findings: out, rejected };
  }
  return { ok: false, why };
}
