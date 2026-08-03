/**
 * The opencode boundary: ask a model to review, get findings back.
 *
 * Two things this file exists to guarantee.
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
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import { DidNotRun, Exhausted } from "../core/errors.ts";
import { FindingSchema, type Finding } from "../core/finding.ts";
import type { Tier } from "../core/ladder.ts";
import { OUTPUT_CONTRACT } from "./prompts.ts";

export interface ReviewerConfig {
  readonly baseUrl: string;
  /** Read-only agent name. Belt; the explicit tool denial below is braces. */
  readonly agent: string;
  readonly timeoutMs: number;
}

export const DEFAULT_REVIEWER: ReviewerConfig = {
  baseUrl: process.env["OPENCODE_SERVER"] ?? "http://127.0.0.1:4096",
  agent: "readonly",
  timeoutMs: 20 * 60_000,
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
    this.client = createOpencodeClient({ baseUrl: cfg.baseUrl });
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
    const first = await this.ask(sessionId, tier, `${prompt}\n\n${OUTPUT_CONTRACT}`, worktree);

    let parsed = extractFindings(first.text);
    let retried = false;
    if (parsed === undefined) {
      // One retry, contract restated. Then it is a failure, not a clean result.
      retried = true;
      const second = await this.ask(
        sessionId,
        tier,
        `Your previous reply could not be parsed. Reply again with ONLY the json block.\n\n${OUTPUT_CONTRACT}`,
        worktree,
      );
      parsed = extractFindings(second.text);
      if (parsed === undefined) {
        throw new DidNotRun(
          `tier ${tier.id} (${tier.model}) did not return parseable findings after a retry — this review DID NOT RUN`,
        );
      }
      first.usage = second.usage;
    }

    return {
      findings: parsed,
      raw: first.text,
      inputTokens: first.usage.input,
      cachedTokens: first.usage.cached,
      outputTokens: first.usage.output,
      costUsd: first.usage.cost,
      latencyMs: Date.now() - started,
      retried,
    };
  }

  private async createSession(tier: Tier): Promise<string> {
    const res = await this.client.session.create({
      body: { title: `lore-${tier.id}-${Date.now()}` },
    });
    const id = (res.data as { id?: string } | undefined)?.id;
    if (id === undefined) {
      throw new DidNotRun(`opencode did not return a session id (is a server running at ${this.cfg.baseUrl}?)`);
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

function collectUsage(data: unknown): Usage {
  const t = (data as { info?: { tokens?: Record<string, number>; cost?: number } } | undefined)?.info;
  const tokens = t?.tokens ?? {};
  return {
    input: Number(tokens["input"] ?? 0),
    cached: Number(tokens["cache"] ?? tokens["cached"] ?? 0),
    output: Number(tokens["output"] ?? 0),
    cost: Number(t?.cost ?? 0),
  };
}

/**
 * Pull findings out of a reply.
 *
 * Returns `undefined` — meaning "could not parse", which triggers the retry — and
 * never an empty array on failure. An empty array means the model said clean, and
 * conflating "said clean" with "could not be read" is precisely INV-1's failure.
 */
export function extractFindings(text: string): readonly Finding[] | undefined {
  const block = /```(?:json)?\s*([\s\S]*?)```/g;
  const candidates: string[] = [];
  for (const m of text.matchAll(block)) candidates.push(m[1] ?? "");
  // A bare object, for models that ignore the fence.
  const brace = text.indexOf("{");
  if (brace >= 0) candidates.push(text.slice(brace));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    const list = (parsed as { findings?: unknown })?.findings;
    if (!Array.isArray(list)) continue;
    const out: Finding[] = [];
    for (const raw of list) {
      const res = FindingSchema.safeParse(raw);
      // One malformed finding invalidates the reply. Keeping the valid ones would
      // silently drop a defect the model actually found, and we would never know.
      if (!res.success) return undefined;
      out.push(res.data);
    }
    return out;
  }
  return undefined;
}
