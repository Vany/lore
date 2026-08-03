/**
 * The opencode boundary, against a real HTTP server.
 *
 * This is the wiring I could least justify shipping unexercised: the response shape
 * varies between opencode versions, so `collectText` and `collectUsage` are written
 * defensively — and defensive code that has never been run is just a guess with
 * more lines.
 *
 * The server here is a stand-in for opencode, not for a model. It proves the
 * request we send is well-formed and the reply we get is understood.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Exhausted } from "../core/errors.ts";
import type { Tier } from "../core/ladder.ts";
import { Reviewer, extractFindings, splitModel } from "./opencode.ts";

const TIER: Tier = { id: "t1", kind: "model", model: "openrouter/z-ai/glm-5.2", stage: "fast" };

const FINDING_JSON = JSON.stringify({
  findings: [
    {
      file: "src/hold.ts",
      line: 12,
      symbol: "capture",
      severity: "high",
      claim: "decline path leaves the hold active",
      evidence: "released only on success",
      failureScenario: "funds stay held",
    },
  ],
});

interface Captured {
  path: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let captured: Captured[];
/** Replies handed out in order, so a test can script a retry. */
let replies: unknown[];
let status = 200;

function start(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        captured.push({ path: req.url ?? "", body: raw.length > 0 ? JSON.parse(raw) : undefined });

        // Route on the path alone. The prompt call carries `?directory=…`, so
        // matching against the raw url silently sends every prompt the
        // session-create reply — which is how this harness lied the first time.
        const path = (req.url ?? "").split("?")[0] ?? "";
        if (path.endsWith("/message")) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(replies.shift() ?? {}));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ses_test" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      baseUrl = typeof addr === "object" && addr !== null ? `http://127.0.0.1:${addr.port}` : "";
      resolve();
    });
  });
}

beforeEach(async () => {
  captured = [];
  replies = [];
  status = 200;
  await start();
});

afterEach(() => {
  server.close();
});

const reviewer = () => new Reviewer({ baseUrl, agent: "readonly", timeoutMs: 10_000 });

describe("splitModel", () => {
  it("splits provider from model, keeping slashes in the model id", () => {
    expect(splitModel("openrouter/z-ai/glm-5.2")).toStrictEqual({
      providerID: "openrouter",
      modelID: "z-ai/glm-5.2",
    });
  });

  it("refuses an id with no provider rather than guessing one", () => {
    expect(() => splitModel("glm-5.2")).toThrow();
  });
});

describe("Reviewer.review", () => {
  it("creates a session and sends the prompt to it", async () => {
    replies = [{ parts: [{ type: "text", text: FINDING_JSON }] }];
    const result = await reviewer().review(TIER, "review this", "/tmp/wt");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.claim).toBe("decline path leaves the hold active");
    expect(captured[0]?.path).toContain("/session");
    expect(captured[1]?.path).toContain("/session/ses_test/message");
  });

  // INV-8, made structural. `--agent` silently falls back to the write-capable
  // default when the agent is missing; an explicit per-request denial cannot.
  it("denies write tools in the request body, not only via the agent name", async () => {
    replies = [{ parts: [{ type: "text", text: FINDING_JSON }] }];
    await reviewer().review(TIER, "review this", "/tmp/wt");

    const body = captured[1]?.body as { agent?: string; tools?: Record<string, boolean>; model?: unknown };
    expect(body.agent).toBe("readonly");
    expect(body.tools).toMatchObject({ write: false, edit: false, patch: false });
    expect(body.model).toStrictEqual({ providerID: "openrouter", modelID: "z-ai/glm-5.2" });
  });

  it("points the session at the worktree under review", async () => {
    replies = [{ parts: [{ type: "text", text: FINDING_JSON }] }];
    await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(captured[1]?.path).toContain("directory=");
  });

  // The shape varies by opencode version, which is exactly why this is defensive.
  it("reads a reply nested under info.parts as well as a flat one", async () => {
    replies = [{ info: { parts: [{ text: FINDING_JSON }] } }];
    const result = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(result.findings).toHaveLength(1);
  });

  it("records what the call cost", async () => {
    replies = [
      {
        parts: [{ type: "text", text: FINDING_JSON }],
        info: { tokens: { input: 4000, cache: 3000, output: 200 }, cost: 0.0123 },
      },
    ];
    const result = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(result).toMatchObject({ inputTokens: 4000, cachedTokens: 3000, outputTokens: 200, costUsd: 0.0123 });
  });

  it("retries once when the reply cannot be parsed, and says it retried", async () => {
    replies = [
      { parts: [{ type: "text", text: "Sure! Here are my thoughts in prose." }] },
      { parts: [{ type: "text", text: `\`\`\`json\n${FINDING_JSON}\n\`\`\`` }] },
    ];
    const result = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(result.retried).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  // An unparseable review is a FAILED review, not a clean one. This is the single
  // most likely way a green run could silently mean nothing.
  it("fails loudly when the reply is still unparseable after the retry", async () => {
    replies = [
      { parts: [{ type: "text", text: "no json here" }] },
      { parts: [{ type: "text", text: "still no json" }] },
    ];
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(/DID NOT RUN/);
  });

  it("reports an empty findings array as clean rather than as a failure", async () => {
    replies = [{ parts: [{ type: "text", text: '```json\n{"findings": []}\n```' }] }];
    const result = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(result.findings).toStrictEqual([]);
    expect(result.retried).toBe(false);
  });

  // Quota is never a reason to fall through to another tier: a tier that did not
  // run found nothing, which is not the same as finding nothing.
  it("raises Exhausted on a rate limit rather than continuing", async () => {
    status = 429;
    replies = [{ error: "rate limit exceeded" }];
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(Exhausted);
  });
});

describe("extractFindings", () => {
  it("finds the block whether or not it is fenced", () => {
    expect(extractFindings(`prose\n\`\`\`json\n${FINDING_JSON}\n\`\`\`\nmore prose`)).toHaveLength(1);
    expect(extractFindings(FINDING_JSON)).toHaveLength(1);
  });

  it("distinguishes 'said clean' from 'could not be read'", () => {
    // [] means the model said clean. undefined means we could not tell. Conflating
    // them is precisely INV-1's failure.
    expect(extractFindings('{"findings": []}')).toStrictEqual([]);
    expect(extractFindings("I could not complete this review.")).toBeUndefined();
  });

  it("rejects the whole reply when one finding is malformed", () => {
    // Keeping the valid ones would silently drop a defect the model actually found,
    // and nobody would ever know it had been dropped.
    const mixed = JSON.stringify({
      findings: [JSON.parse(FINDING_JSON).findings[0], { file: "x.ts", severity: "high" }],
    });
    expect(extractFindings(mixed)).toBeUndefined();
  });

  it("rejects a finding carrying keys we did not ask for", () => {
    const extra = JSON.stringify({
      findings: [{ ...JSON.parse(FINDING_JSON).findings[0], confidence: 0.9 }],
    });
    expect(extractFindings(extra)).toBeUndefined();
  });
});
