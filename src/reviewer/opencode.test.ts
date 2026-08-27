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
import { Exhausted, ProviderAuthFailed, ServiceUnreachable, TooLargeForTier } from "../core/errors.ts";
import { CLAIM_MAX } from "../core/finding.ts";
import type { Tier } from "../core/ladder.ts";
import { Reviewer, countStepParts, emissionOf, extractFindings, quotaRefusal, splitModel, toolsUsed, isTooLong, usageFromMessages } from "./opencode.ts";

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
  method?: string | undefined;
}

let server: Server;
let baseUrl: string;
let captured: Captured[];
/** Replies handed out in order, so a test can script a retry. */
let replies: unknown[];
let status = 200;
/** `POST /session`: an opencode that is up and refusing is not an absent one. */
let sessionStatus = 200;
let sessionBody: unknown = { id: "ses_test" };
/** `GET /session/:id/message`: the turn-by-turn record the step count is taken from. */
let messagesStatus = 200;
let messages: unknown = undefined;
/** `POST /session/:id/abort`: the call that is supposed to stop the spending. */
let abortStatus = 200;
/** `POST /session/:id/summarize`: compaction, which must never be able to end a review. */
let summarizeStatus = 200;
/** Destroy the prompt's socket mid-call — the shape of a container dying under a round. */
let destroyPrompt = false;
/** And whether `/config/providers` still answers — the probe that tells the two apart. */
let providersDown = false;
/** Accept the prompt and never answer it, so a cancel has something real to interrupt. */
let hangPrompt = false;
/** `DELETE /session/:id`: how long `release`'s cleanup call takes to answer. */
let deleteDelayMs = 0;
/** `POST /session`: how long session creation takes — so a test can land a cancel mid-create. */
let createSessionDelayMs = 0;
/** Events the fake opencode will publish on `/event`, in order. */
let pending: unknown[] = [];

/**
 * What `GET /session/:id/message` really answers, taken from a live opencode 1.18.9.
 *
 * One user message, then **one assistant message per agentic turn**, each carrying
 * exactly one `step-start`. That last detail is the whole reason the count is taken
 * from here: 82 `step-start` parts across 86 assistant messages in one real session,
 * and never two in the same message.
 */
function sessionMessages(turns: number): unknown[] {
  const out: unknown[] = [
    {
      info: { id: "msg_user", sessionID: "ses_test", role: "user", time: { created: 1 } },
      parts: [{ id: "prt_user", sessionID: "ses_test", messageID: "msg_user", type: "text", text: "review this" }],
    },
  ];
  for (let i = 0; i < turns; i++) {
    const id = `msg_a${i}`;
    out.push({
      info: { id, sessionID: "ses_test", role: "assistant", time: { created: 2 + i }, modelID: "z-ai/glm-5.2" },
      parts: [
        { id: `prt_${i}s`, sessionID: "ses_test", messageID: id, type: "step-start" },
        { id: `prt_${i}t`, sessionID: "ses_test", messageID: id, type: "tool", tool: "read" },
        { id: `prt_${i}f`, sessionID: "ses_test", messageID: id, type: "step-finish", reason: "tool-calls", cost: 0 },
      ],
    });
  }
  return out;
}

/**
 * One `step-start` — what a prompt reply really carries, however far the agent went.
 *
 * The reply is a single assistant message, so its own step count is 1 for a runaway
 * and 1 for a one-shot answer. Kept in every default reply here so no test can pass
 * by counting the wrong thing.
 */
const REPLY_STEP = { id: "prt_reply", sessionID: "ses_test", messageID: "msg_last", type: "step-start" };

function start(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        captured.push({ path: req.url ?? "", body: raw.length > 0 ? JSON.parse(raw) : undefined, method: req.method });

        // Route on the path alone. The prompt call carries `?directory=…`, so
        // matching against the raw url silently sends every prompt the
        // session-create reply — which is how this harness lied the first time.
        const path = (req.url ?? "").split("?")[0] ?? "";
        // …and on the METHOD as well, because opencode puts the prompt and the
        // message list on the same path and tells them apart by verb. Routing on the
        // path alone would feed the prompt reply to the step counter.
        if (path.endsWith("/message") && req.method === "GET") {
          res.writeHead(messagesStatus, { "content-type": "application/json" });
          res.end(JSON.stringify(messages ?? sessionMessages(3)));
          return;
        }
        if (path.endsWith("/message") && destroyPrompt) {
          req.socket.destroy();
          return;
        }
        if (path.endsWith("/message")) {
          // A PROMPT THAT NEVER COMES BACK — an exhausted Z.ai plan through opencode,
          // which accepts the session and answers nothing at all (D-84). Every other
          // fixture here answers instantly, so nothing could exercise a cancel against
          // a call that is genuinely still open, which is the only state a cancel is for.
          if (hangPrompt) return;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(replies.shift() ?? {}));
          return;
        }
        if (path === "/session") {
          // A refusing opencode answers with a status and no body at all — verified
          // against a password-protected server, which sends a bare 401 with
          // Content-Length: 0.
          setTimeout(() => {
            res.writeHead(sessionStatus, { "content-type": "application/json" });
            res.end(sessionStatus >= 400 ? "" : JSON.stringify(sessionBody));
          }, createSessionDelayMs);
          return;
        }
        // THE CHANNEL D-91 READS. A real opencode narrates every session here while the
        // prompt request is still open; the fixture holds the connection and writes
        // whatever a test pushes, so a quota refusal can arrive DURING a hanging call —
        // which is the only arrangement that proves anything about this feature.
        if (path === "/event") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          // A CURSOR PER CONNECTION, never a shift. A shared queue that consumes is a
          // fixture where one test's stream eats the next test's event — which is exactly
          // what happened, and it failed the feature rather than the harness. A real
          // event stream broadcasts; so does this.
          let sent = 0;
          const t = setInterval(() => {
            while (sent < pending.length) {
              res.write(`data: ${JSON.stringify(pending[sent])}\n\n`);
              sent++;
            }
          }, 10);
          res.on("close", () => {
            clearInterval(t);
          });
          return;
        }
        // THE ADVERTISED CONTEXT WINDOW, which the 2/3 compaction rule is a fraction OF
        // (D-80). Without a route here the catch-all answers `{id:"ses_test"}`, the window
        // reads as unknown, and `shouldCompact` correctly refuses — so a compaction test
        // would pass by never compacting.
        if (path === "/config/providers" && providersDown) {
          req.socket.destroy();
          return;
        }
        if (path === "/config/providers") {
          res.writeHead(200, { "content-type": "application/json" });
          // Two pool twins with DIFFERENT windows, so the budget test can prove the
          // prompt is fitted to the smaller one — an accidental max would pass a test
          // whose twins agree.
          res.end(JSON.stringify({ providers: [
            { id: "openrouter", models: { "z-ai/glm-5.2": { limit: { context: 1000 } } } },
            { id: "zp1", models: { "glm-5.2": { limit: { context: 2000 } } } },
            { id: "zp2", models: { "glm-5.2": { limit: { context: 500 } } } },
          ] }));
          return;
        }
        if (path.endsWith("/summarize")) {
          res.writeHead(summarizeStatus, { "content-type": "application/json" });
          res.end(summarizeStatus === 200 ? "true" : JSON.stringify({ error: "context overflow" }));
          return;
        }
        if (path.endsWith("/abort")) {
          res.writeHead(abortStatus, { "content-type": "application/json" });
          res.end(abortStatus >= 400 ? "" : "true");
          return;
        }
        // `release`'s own `DELETE /session/:id` — delayable, so a test can prove what
        // else happens WHILE it is still in flight rather than only after it settles.
        if (req.method === "DELETE") {
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("true");
          }, deleteDelayMs);
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

/**
 * A port nothing is listening on.
 *
 * Bound and released rather than picked, because a hard-coded port that something
 * else happens to be using would turn this test green for the wrong reason.
 */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

beforeEach(async () => {
  captured = [];
  replies = [];
  status = 200;
  sessionStatus = 200;
  sessionBody = { id: "ses_test" };
  messagesStatus = 200;
  messages = undefined;
  abortStatus = 200;
  summarizeStatus = 200;
  destroyPrompt = false;
  providersDown = false;
  hangPrompt = false;
  deleteDelayMs = 0;
  createSessionDelayMs = 0;
  pending = [];
  await start();
});

afterEach(() => {
  server.close();
});

const reviewer = () => new Reviewer({ baseUrl, agent: "readonly", timeoutMs: 10_000});

/**
 * Found BY PATH, never by position.
 *
 * These read `captured[0]` and `captured[1]` until D-91 added an event subscription that
 * opens before the session does — and three tests then failed for a reason having nothing
 * to do with what they assert. A positional index into "every request lore made" is a
 * dependency on the whole client's behaviour, declared nowhere.
 */
const asked = (match: string): Captured | undefined => captured.find((c) => c.path.includes(match));
const prompted = (): Captured | undefined => captured.find((c) => c.path.includes("/message") && c.method === "POST");

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
    expect(asked("/session")?.path).toContain("/session");
    expect(prompted()?.path).toContain("/session/ses_test/message");
  });

  // INV-8, made structural. `--agent` silently falls back to the write-capable
  // default when the agent is missing; an explicit per-request denial cannot.
  it("denies write tools in the request body, not only via the agent name", async () => {
    replies = [{ parts: [{ type: "text", text: FINDING_JSON }] }];
    await reviewer().review(TIER, "review this", "/tmp/wt");

    const body = prompted()?.body as { agent?: string; tools?: Record<string, boolean>; model?: unknown };
    expect(body.agent).toBe("readonly");
    expect(body.tools).toMatchObject({ write: false, edit: false, patch: false });
    expect(body.model).toStrictEqual({ providerID: "openrouter", modelID: "z-ai/glm-5.2" });
  });

  it("points the session at the worktree under review", async () => {
    replies = [{ parts: [{ type: "text", text: FINDING_JSON }] }];
    await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(prompted()?.path).toContain("directory=");
  });

  // The shape varies by opencode version, which is exactly why this is defensive.
  it("reads a reply nested under info.parts as well as a flat one", async () => {
    replies = [{ info: { parts: [{ text: FINDING_JSON }] } }];
    const result = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(result.findings).toHaveLength(1);
  });

  // The shape opencode really sends, observed live: `cache` is an OBJECT, and
  // `Number({read,write})` is NaN. NaN into a NOT NULL column killed the first
  // real review after the diff, T0 and the model call had all been paid for.
  it("reads the nested cache object rather than producing NaN", async () => {
    replies = [
      {
        parts: [{ type: "text", text: FINDING_JSON }],
        info: {
          tokens: { input: 4000, output: 200, reasoning: 50, cache: { read: 3000, write: 900 } },
          cost: 0.0123,
        },
      },
    ];
    const r = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(r.inputTokens).toBe(4000);
    // Only `read` is the saving. `write` is what populating the cache cost, and
    // counting it would overstate the discount D-29's cost model rests on.
    expect(r.cachedTokens).toBe(3000);
    // Reasoning is billed as output by every provider in the ladder.
    expect(r.outputTokens).toBe(250);
    expect(r.costUsd).toBeCloseTo(0.0123, 6);
  });

  it("still reads a flat cache count, for providers that send one", async () => {
    replies = [
      { parts: [{ type: "text", text: FINDING_JSON }], info: { tokens: { input: 10, cache: 5, output: 2 }, cost: 0.1 } },
    ];
    expect((await reviewer().review(TIER, "review this", "/tmp/wt")).cachedTokens).toBe(5);
  });

  it("never yields NaN when usage is missing or malformed", async () => {
    replies = [{ parts: [{ type: "text", text: FINDING_JSON }], info: { tokens: { input: "?" } } }];
    const r = await reviewer().review(TIER, "review this", "/tmp/wt");
    for (const v of [r.inputTokens, r.cachedTokens, r.outputTokens, r.costUsd]) {
      expect(Number.isFinite(v)).toBe(true);
    }
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

  /**
   * A BLOCK THAT WOULD NOT PARSE IS ASKED FOR AGAIN — and this is INV-1's worst case.
   *
   * A reply carrying two fenced blocks where one parses and one does not looks HEALTHY:
   * items came back, the round succeeds, and the findings in the bad block are gone. Loudly
   * gone — `checks_skipped` says "produced a finding this review does NOT contain" — but
   * gone. It happened four times in one day on lore's own review of D-121, which is the
   * rate that started this project.
   */
  it("re-asks for a fenced block that did not parse, and keeps what it recovers", async () => {
    const good = JSON.stringify({ findings: [JSON.parse(FINDING_JSON).findings[0]] });
    replies = [
      // One block parses; the second is truncated mid-object, as a dropped connection
      // leaves it.
      { parts: [{ type: "text", text: "```json\n" + good + "\n```\n```json\n{\"findings\": [{\"file\": \"src/a.ts\"\n```" }] },
      { parts: [{ type: "text", text: "```json\n" + good + "\n```" }] },
    ];

    const result = await reviewer().review(TIER, "review this", "/tmp/wt");

    expect(result.retried, "the second ask happened").toBe(true);
    // The recovered block's finding is merged in beside the one that already parsed.
    // Identical content collapses on fingerprint downstream, so a model that re-sends
    // what it already reported costs nothing.
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  // A SCHEMA REJECTION IS NOT RE-ASKED, and the difference is measured rather than
  // assumed: told the exact rule twice, glm-5.2 shortened an over-long claim by 44
  // characters and still landed 14 over the cap. Re-asking a refusal buys a second
  // refusal and a paid turn.
  it("does not re-ask when the block parsed and the schema refused an item", async () => {
    // lore-ok[79bf1e31]: was a SINGLE over-long claim (`'x'.repeat(4000)`) — refused by the
    // schema until D-116's `foldOverlongClaim` (core/finding.ts) started FOLDING an over-cap
    // claim instead of refusing it, so this fixture stopped producing a schema refusal at
    // all: the whole reply parsed and validated, the second scripted reply went unused, and
    // the one assertion left ("discarded is defined") is true of an empty array too — nothing
    // here could fail even if a re-ask silently happened.
    //
    // A single rejected item is not enough to replace it with, either: `extractList`'s
    // `out.length === 0 && rejected.length > 0` branch treats a candidate with NOTHING
    // usable as a whole-reply FAILURE ("a reply where nothing parsed is still a failed
    // reply"), which DOES retry — the one item sent alone would exercise that branch, not
    // the one this test names. The block has to parse AND yield something usable BESIDE
    // the refused item, so it lands in the merge that keeps the good one and reports the
    // bad one without asking again. The unknown key hits `.strict()` exactly as
    // `finding.test.ts`'s own "rejects unknown keys rather than dropping them" fixture does.
    const good = { ...JSON.parse(FINDING_JSON).findings[0], line: 99, claim: "a second, distinct claim" };
    const stillRefused = { ...JSON.parse(FINDING_JSON).findings[0], confidence: 0.8 };
    replies = [
      { parts: [{ type: "text", text: "```json\n" + JSON.stringify({ findings: [good, stillRefused] }) + "\n```" }] },
      { parts: [{ type: "text", text: "```json\n" + FINDING_JSON + "\n```" }] },
    ];

    const result = await reviewer().review(TIER, "review this", "/tmp/wt");

    expect(result.findings, "the good item is kept").toHaveLength(1);
    expect(result.findings[0]?.claim).toBe("a second, distinct claim");
    expect(result.discarded, "the refusal is reported").toHaveLength(1);
    expect(result.discarded.join(" ")).toMatch(/confidence/);
    expect(result.retried, "a schema refusal is not a parse failure — no re-ask").toBe(false);
    expect(
      captured.filter((c) => c.path.includes("/message") && c.method === "POST"),
      "exactly one prompt POST — the second scripted reply must go unused",
    ).toHaveLength(1);
  });

  /**
   * A FAILED RE-ASK MUST LOSE NOTHING. The re-ask can only add: if the model cannot
   * produce the missing block either, the client is told exactly what it was told before
   * this existed — that a finding was produced and this review does not contain it.
   */
  it("still reports the loss when the re-ask does not recover it", async () => {
    const good = JSON.stringify({ findings: [JSON.parse(FINDING_JSON).findings[0]] });
    replies = [
      { parts: [{ type: "text", text: "```json\n" + good + "\n```\n```json\n{\"findings\": [{\"file\"\n```" }] },
      { parts: [{ type: "text", text: "sorry, I cannot reconstruct it" }] },
    ];

    const result = await reviewer().review(TIER, "review this", "/tmp/wt");

    expect(result.discarded.join(" "), "the loss survives a failed recovery").toMatch(/did not parse/);
  });

  /**
   * THE EXACT REGRESSION (de36efae, found by lore's own review of D-123).
   *
   * The re-ask's own prompt tells the model "if that block held nothing you have not
   * already reported, reply with an empty array" — an ordinary, well-behaved reply the
   * prompt itself invites. The bug: the merge dropped the loss note whenever the re-ask
   * PARSED, not whenever it RECOVERED something, so this exact reply made the note vanish
   * with nothing recovered to justify it. Pre-D-123 the client at least saw the loss;
   * this reply made D-123 lose it more quietly than no feature at all.
   */
  it("keeps the loss note when the re-ask replies with an empty array", async () => {
    const good = JSON.stringify({ findings: [JSON.parse(FINDING_JSON).findings[0]] });
    replies = [
      { parts: [{ type: "text", text: "```json\n" + good + "\n```\n```json\n{\"findings\": [{\"file\"\n```" }] },
      // Exactly what the re-ask prompt asks for when the model believes there is nothing
      // new — a valid, well-formed, EMPTY reply.
      { parts: [{ type: "text", text: '```json\n{"findings": []}\n```' }] },
    ];

    const result = await reviewer().review(TIER, "review this", "/tmp/wt");

    expect(result.retried, "the re-ask still happened").toBe(true);
    expect(result.discarded.join(" "), "an empty reply does not clear an unverified loss").toMatch(/did not parse/);
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

  // The shape that actually occurs. opencode answers 200 and nests the PROVIDER's
  // failure in the body, so the transport status says nothing about whether the
  // model ran. Observed live against OpenRouter with an unfunded account.
  it("raises Exhausted when the provider refuses inside a 200 response", async () => {
    replies = [
      {
        info: {
          error: {
            name: "APIError",
            data: { message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits", statusCode: 402 },
          },
        },
      },
    ];
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(Exhausted);
  });

  // The shape that killed rev_gOhsCu's t3 on 2026-08-14: an OAuth-backed subscription
  // whose refresh token died answers through opencode as a 500 with the 401 INSIDE the
  // message — "UnknownError: Token refresh failed: 401" — matching neither the status
  // checks nor the old auth patterns. Unclassified, it was a plain failure: no page, no
  // route mark for the status line, and the same-model fallback never walked.
  it("classifies a failed token refresh as rejected credentials, not as a generic failure", async () => {
    status = 500;
    replies = [{ error: "UnknownError: Token refresh failed: 401" }];
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(ProviderAuthFailed);
  });

  it("does not retry a provider failure as though it were bad formatting", async () => {
    // Retrying an unpaid bill wastes a call and reports the wrong cause: someone
    // would go and debug the prompt.
    replies = [
      { info: { error: { name: "APIError", data: { message: "invalid api key", statusCode: 401 } } } },
      { parts: [{ type: "text", text: FINDING_JSON }] },
    ];
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(/invalid api key/);
  });
});

/**
 * ONE SESSION PER (REVIEW, TIER), INITIALISED ONCE (D-80).
 *
 * Vany: *"the main idea is to stop restarting it and continue the session in opencode, and
 * manage it so each model will be started and initialised only once per review."*
 *
 * Every round used to be a cold start — new session, whole prompt rebuilt, the model
 * re-orienting in a worktree it read minutes ago. Measured before it was built: 31.6 turns
 * a round, and 29% of all model rounds were a tier re-reading a review it already knew.
 */
describe("a tier that keeps its session", () => {
  const KEEPS = { ...TIER, conversation: true };
  const reply = () => ({ parts: [{ type: "text", text: FINDING_JSON }] });
  const creates = () => captured.filter((c) => (c.path.split("?")[0] ?? "") === "/session" && c.method === "POST");
  const prompts = () =>
    captured.filter((c) => (c.path.split("?")[0] ?? "").endsWith("/message") && c.method === "POST");

  it("creates the session once and continues it on the next round", async () => {
    replies = [reply(), reply()];
    const r = reviewer();
    const prompt = { initial: "FULL ORIENTATION", continued: "THE AUTHOR ANSWERED" };

    await r.review(KEEPS, prompt, "/tmp/wt", "rev1");
    await r.review(KEEPS, prompt, "/tmp/wt", "rev1");

    expect(creates(), "initialised once, not once per round").toHaveLength(1);
    // And the second round says only what changed — repeating the orientation would be
    // the cold start this replaces, wearing a different name.
    const sent = prompts().map((c) => JSON.stringify((c.body as { parts?: unknown[] }).parts ?? []));
    expect(sent[0]).toContain("FULL ORIENTATION");
    expect(sent[1]).toContain("THE AUTHOR ANSWERED");
    expect(sent[1], "the orientation is not repeated").not.toContain("FULL ORIENTATION");
  });

  /**
   * THE SAME SESSION ACROSS A RESTART — the half of D-80 that used to die with the process.
   *
   * Two Reviewer instances, one durable port: exactly what a deploy is. The map was the
   * only copy and was in memory, so a restart forgot every warm conversation while opencode
   * still held them all in a named volume — and every open review paid for a cold re-read
   * of its whole diff on its next round, which nothing reported.
   *
   * Vany: *"deployment must not kill the full ladder, may be one step."*
   *
   * TWO INSTANCES IS THE POINT, and it is why the port exists rather than a private field:
   * a single Reviewer cannot express the question at all, so no test of one could have
   * caught this.
   */
  it("continues a session the previous process opened", async () => {
    replies = [reply(), reply()];
    const rows = new Map<string, string>();
    const port = {
      get: (k: string) => rows.get(k),
      set: (k: string, v: string) => void rows.set(k, v),
      forget: (k: string) => void rows.delete(k),
      keys: () => [...rows.keys()],
    };
    const prompt = { initial: "FULL ORIENTATION", continued: "THE AUTHOR ANSWERED" };

    const before = new Reviewer({ baseUrl, agent: "readonly", timeoutMs: 10_000, keptSessions: port });
    await before.review(KEEPS, prompt, "/tmp/wt", "rev1");

    // The deploy. Nothing of `before` survives except what it wrote down.
    const after = new Reviewer({ baseUrl, agent: "readonly", timeoutMs: 10_000, keptSessions: port });
    await after.review(KEEPS, prompt, "/tmp/wt", "rev1");

    expect(creates(), "one session across the restart, not one per process").toHaveLength(1);
    const sent = prompts().map((c) => JSON.stringify((c.body as { parts?: unknown[] }).parts ?? []));
    expect(sent[1], "the second process says only what changed").toContain("THE AUTHOR ANSWERED");
    expect(sent[1], "and does NOT re-read the whole diff").not.toContain("FULL ORIENTATION");
  });

  /**
   * A DURABLE ID CAN OUTLIVE ITS SESSION, and that failure is new — a private Map could
   * not produce it. opencode's volume replaced, its data pruned, or this database restored
   * from a backup older than the session, and the row names something gone. Left alone it
   * would fail its tier on EVERY future round of the review: permanent, and strictly worse
   * than the cold start it was avoiding.
   */
  it("forgets a session opencode no longer has, and starts cold exactly once", async () => {
    replies = [reply(), reply()];
    const rows = new Map<string, string>([["rev1:t1:openrouter/z-ai/glm-5.2", "ses_vanished"]]);
    const port = {
      get: (k: string) => rows.get(k),
      set: (k: string, v: string) => void rows.set(k, v),
      forget: (k: string) => void rows.delete(k),
      keys: () => [...rows.keys()],
    };
    status = 404;

    const r = new Reviewer({ baseUrl, agent: "readonly", timeoutMs: 10_000, keptSessions: port });
    await expect(r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1")).rejects.toThrow();

    // THE DEAD ID IS GONE — not the row. The cold restart opens a fresh session and
    // records THAT, which is the whole point: the next round resumes normally. Asserting
    // the key was absent tested the intermediate state and would have failed the correct
    // implementation.
    expect(rows.get("rev1:t1:openrouter/z-ai/glm-5.2"), "never ses_vanished again").not.toBe("ses_vanished");
    // ONE create: the cold retry happened, and did not happen twice. Every prompt 404s in
    // this fixture, so a recovery without a bound would loop until something else stopped
    // it — asserting the count is what pins the bound rather than the intent.
    expect(creates(), "one cold restart, then it gives up honestly").toHaveLength(1);
  });

  /**
   * CONTINUITY IS WITHIN ONE TIER'S RUN, NEVER ACROSS TIERS. A tier that inherited the
   * previous model's conclusions would make three tiers into one opinion asked three
   * times, which is what D-1 and D-49 exist to prevent.
   */
  it("gives a different tier its own session, on the same review", async () => {
    replies = [reply(), reply()];
    const r = reviewer();
    const prompt = { initial: "FULL", continued: "NEXT" };

    await r.review(KEEPS, prompt, "/tmp/wt", "rev1");
    await r.review({ ...KEEPS, id: "t2" }, prompt, "/tmp/wt", "rev1");

    expect(creates(), "t2 starts empty of t1's reasoning").toHaveLength(2);
    expect(JSON.stringify((prompts()[1]?.body as { parts?: unknown[] }).parts ?? [])).toContain("FULL");
  });

  it("gives a different review its own session, on the same tier", async () => {
    replies = [reply(), reply()];
    const r = reviewer();
    await r.review(KEEPS, { initial: "A", continued: "n/a" }, "/tmp/wt", "rev1");
    await r.review(KEEPS, { initial: "B", continued: "n/a" }, "/tmp/wt", "rev2");
    expect(creates()).toHaveLength(2);
  });

  // The behaviour every other caller has, and the fallback when a lore restart has lost
  // the map: no reviewId, or the flag off, is a cold start exactly as before.
  it("starts cold when the tier has not opted in", async () => {
    replies = [reply(), reply()];
    const r = reviewer();
    await r.review(TIER, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    await r.review(TIER, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");

    expect(creates(), "no flag, no continuity").toHaveLength(2);
    const sent = prompts().map((c) => JSON.stringify((c.body as { parts?: unknown[] }).parts ?? []));
    expect(sent[1], "and a cold round is always told everything").toContain("A");
  });

  /**
   * WITHOUT THIS THEY ACCUMULATE. A kept session is deliberately never cleared per round,
   * so `release` is the only thing that ends one — and admission allows 128 open reviews,
   * which across three tiers is 384 sessions opencode would hold for finished work.
   */
  it("ends its sessions when the review does, and starts fresh after", async () => {
    replies = [reply(), reply()];
    const r = reviewer();
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");

    await r.release("rev1");
    expect(captured.some((c) => c.method === "DELETE"), "the session is deleted, not leaked").toBe(true);

    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    expect(creates(), "a released review starts over").toHaveLength(2);
  });

  /**
   * THE PATH THAT LEAKS IF NOBODY SAYS SO. `review_cancel` on a review sitting in
   * `findings_ready` runs with NO job in flight, so the worker's release never fires —
   * and `cancel` used to return early in exactly that case, which is the one that leaks.
   */
  it("ends its sessions on a cancel, even with nothing in flight", async () => {
    replies = [reply(), reply()];
    const r = reviewer();
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");

    // Nothing is running now — the round finished — so this is the leaking shape.
    expect(await r.cancel("rev1"), "nothing was in flight to abort").toBe(false);
    expect(captured.some((c) => c.method === "DELETE"), "and the session still went").toBe(true);

    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    expect(creates(), "a cancelled review starts over").toHaveLength(2);
  });

  it("reports which reviews still hold one, for the worker's reconcile", async () => {
    replies = [reply(), reply()];
    const r = reviewer();
    expect(r.keptReviews()).toStrictEqual([]);

    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    await r.review({ ...KEEPS, id: "t2" }, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    // Two sessions, ONE review: the reconcile asks about reviews, not sessions.
    expect(r.keptReviews()).toStrictEqual(["rev1"]);

    await r.release("rev1");
    expect(r.keptReviews()).toStrictEqual([]);
  });

  /**
   * A FALLBACK IS A DIFFERENT REVIEWER AND GETS ITS OWN SESSION.
   *
   * A tier running on its twin keeps its id and changes its model, so keying the kept
   * session on (review, tier) alone handed the primary's session to the fallback. Two
   * things went wrong at once, and both were observed live on rev_8ZM1XT7:
   *
   *  - the fallback model was sent the CONTINUED prompt on its first ever contact with
   *    the review — "the author has answered" to a reviewer that had never read the code;
   *  - opencode ties a session to the model that opened it, so a call lore addressed to
   *    `zai-coding-plan` came back carrying OpenRouter's `402 Insufficient credits`. The
   *    route lore then reported as tried was not the route that answered, which makes
   *    `unpayable` — every route refused — a claim about a call nobody made.
   */
  const TWIN = { ...KEEPS, model: "zai-coding-plan/glm-5.2" };

  it("does not hand a tier's session to the model standing in for it", async () => {
    replies = [reply(), reply()];
    const r = reviewer();
    const prompt = { initial: "FULL ORIENTATION", continued: "THE AUTHOR ANSWERED" };

    await r.review(KEEPS, prompt, "/tmp/wt", "rev1");
    await r.review(TWIN, prompt, "/tmp/wt", "rev1");

    expect(creates(), "the stand-in starts its own session").toHaveLength(2);
    const sent = prompts().map((c) => JSON.stringify((c.body as { parts?: unknown[] }).parts ?? []));
    expect(sent[1], "and is oriented, not continued").toContain("FULL ORIENTATION");
    expect(sent[1]).not.toContain("THE AUTHOR ANSWERED");
  });

  it("still keeps each of them across rounds, separately", async () => {
    replies = [reply(), reply(), reply(), reply()];
    const r = reviewer();
    const prompt = { initial: "FULL", continued: "NEXT" };

    await r.review(KEEPS, prompt, "/tmp/wt", "rev1");
    await r.review(TWIN, prompt, "/tmp/wt", "rev1");
    await r.review(KEEPS, prompt, "/tmp/wt", "rev1");
    await r.review(TWIN, prompt, "/tmp/wt", "rev1");

    expect(creates(), "two models, two sessions, and no more").toHaveLength(2);
  });

  it("releases every model a review ran on, under the one review id", async () => {
    replies = [reply(), reply()];
    const r = reviewer();
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    await r.review(TWIN, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    expect(r.keptReviews(), "one review, however many models it ran on").toStrictEqual(["rev1"]);

    await r.release("rev1");
    expect(captured.filter((c) => c.method === "DELETE"), "both sessions go").toHaveLength(2);
    expect(r.keptReviews()).toStrictEqual([]);
  });

  it("releases only the review it was asked about", async () => {
    replies = [reply(), reply(), reply()];
    const r = reviewer();
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev2");

    await r.release("rev1");
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev2");

    // rev2 was untouched, so its second round continues rather than creating a third.
    expect(creates()).toHaveLength(2);
  });
});

/**
 * COMPACT AT TWO THIRDS, never restart (D-80).
 *
 * Vany: *"let's compact if the session is 2/3 of context"*, and then, when I proposed
 * dropping the session and starting cold on the fixed tree instead: *"I said compact, who
 * said restart?"* The worktree remembers the CODE; it does not remember why the model
 * looked where it looked or what it ruled out.
 */
describe("compacting a kept session", () => {
  const KEEPS = { ...TIER, conversation: true };
  const reply = () => ({ parts: [{ type: "text", text: FINDING_JSON }] });
  const summarised = () => captured.filter((c) => c.path.split("?")[0]?.endsWith("/summarize"));

  /** A session whose last turn carried `used` tokens against the fixture's 1000 window. */
  const lastTurnAt = (used: number) => {
    messages = [
      { info: { id: "u", role: "user" }, parts: [] },
      { info: { id: "a", role: "assistant", tokens: { input: used, output: 10, cache: { read: 0, write: 0 } } }, parts: [] },
    ];
  };

  it("compacts before the next turn once the last one crossed 2/3", async () => {
    replies = [reply(), reply()];
    lastTurnAt(700);
    const r = reviewer();
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    expect(summarised(), "nothing to compact on the first round").toHaveLength(0);

    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    expect(summarised(), "the second round finds the session two thirds full").toHaveLength(1);
  });

  it("leaves a session alone below the threshold", async () => {
    replies = [reply(), reply()];
    lastTurnAt(400);
    const r = reviewer();
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    expect(summarised()).toHaveLength(0);
  });

  /**
   * A summarise that fails leaves the conversation as it was — longer than we would like
   * and still correct. Throwing would end a review over a housekeeping call.
   */
  it("carries on when the compaction itself fails", async () => {
    replies = [reply(), reply()];
    lastTurnAt(900);
    summarizeStatus = 500;
    const r = reviewer();
    await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    const out = await r.review(KEEPS, { initial: "A", continued: "B" }, "/tmp/wt", "rev1");
    expect(out.findings, "the round still produced its answer").toHaveLength(1);
  });
});

/**
 * A NICKNAME BUDGETS TO THE SMALLEST WINDOW IN ITS POOL.
 *
 * The prompt is built before the round rolls a route, so it must fit whichever twin the
 * roll lands on. Before this, `contextLimit` found no model called "GLM5.2" and returned
 * undefined — which reads as "no measurable window, send everything", silently disabling
 * the fit-check for exactly the tiers pools were built for.
 */
describe("the prompt budget of a pooled tier", () => {
  const POOLED = JSON.stringify({
    models: { "GLM5.2": ["zp1/glm-5.2", "zp2/glm-5.2"] },
    tiers: [{ id: "t0", kind: "deterministic", stage: "fast" }, { id: "t1", kind: "model", model: "GLM5.2", stage: "fast" }],
  });
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["LORE_TIERS"];
    process.env["LORE_TIERS"] = POOLED;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["LORE_TIERS"];
    else process.env["LORE_TIERS"] = saved;
  });

  it("fits the prompt to the smallest twin, not the largest", async () => {
    const r = reviewer();
    const single = await r.promptBudgetChars({ id: "t1", kind: "model", model: "zp2/glm-5.2", stage: "fast" });
    const pooled = await r.promptBudgetChars({ id: "t1", kind: "model", model: "GLM5.2", stage: "fast" });
    expect(single).toBeDefined();
    expect(pooled, "the 500-token twin bounds the pool, not the 2000-token one").toBe(single);
  });

  it("still answers undefined for a model nobody advertises", async () => {
    const r = reviewer();
    expect(await r.promptBudgetChars({ id: "t1", kind: "model", model: "nobody/knows", stage: "fast" })).toBeUndefined();
  });
});

/**
 * A FAILED LOOKUP MUST NOT BE CACHED FOREVER (found by lore's own review, fingerprint
 * 277d5b24). `contextLimit` used to cache whatever `/config/providers` produced,
 * success or not — so one dropped call, cold container or a request racing opencode's
 * own startup, permanently emptied the window map for the rest of the process. Both
 * `promptBudgetChars` and D-80's 2/3-window compaction read that as "unmeasurable",
 * which is the safe-but-silent direction: nothing said the lookup had failed at all.
 */
describe("a failed context-window lookup", () => {
  it("retries on the next call instead of caching the failure forever", async () => {
    providersDown = true;
    const r = reviewer();
    const first = await r.promptBudgetChars(TIER);
    expect(first, "an unmeasurable window is undefined, never a false zero").toBeUndefined();

    providersDown = false;
    const second = await r.promptBudgetChars(TIER);
    expect(second, "a later call must not inherit the earlier failure forever").toBeDefined();
  });
});

describe("opening a session", () => {
  // Two debugging sessions in one day went looking at connectivity while opencode
  // was up and answering, because a status it never checked came out as "is a server
  // running?". This SDK reports a refusal by RETURN VALUE: 500, no id, no throw.
  it("names the status opencode returned rather than blaming connectivity", async () => {
    sessionStatus = 500;
    const err = await reviewer()
      .review(TIER, "review this", "/tmp/wt")
      .then(() => undefined, (e: unknown) => e as Error);

    expect(err?.message).toMatch(/500/);
    expect(err?.message).not.toMatch(/is a server running/);
  });

  // Observed against a real password-protected opencode: a bare 401 with an EMPTY
  // body, so `error` is `{}` and the status is the only thing that names the fault.
  // A fake that answered with a helpful message here would be kinder than
  // production and would let a message that only prints the body pass.
  it("names a 401 as a refusal, with the credentials to check", async () => {
    sessionStatus = 401;
    const err = await reviewer()
      .review(TIER, "review this", "/tmp/wt")
      .then(() => undefined, (e: unknown) => e as Error);

    expect(err?.message).toMatch(/401/);
    expect(err?.message).toMatch(/OPENCODE_SERVER_USERNAME/);
  });

  // The other half of the same SDK asymmetry, and the one case where asking about
  // the server is right: an unreachable address REJECTS rather than returning, and
  // unwrapped it arrives as a bare `connect ECONNREFUSED` (or `fetch failed` without
  // `longFetch`) naming neither the tier nor the address it failed to reach.
  it("names the address it could not reach, instead of a bare fetch failure", async () => {
    const dead = await closedPort();
    const offline = new Reviewer({ baseUrl: `http://127.0.0.1:${dead}`, agent: "readonly", timeoutMs: 2_000});
    const err = await offline
      .review(TIER, "review this", "/tmp/wt")
      .then(() => undefined, (e: unknown) => e as Error);

    // `ServiceUnreachable` — a DidNotRun that also says WHO is at fault: lore's own
    // sidecar rather than the provider or the branch, so the worker requeues the round
    // instead of ending the review (D-104).
    expect(err?.name).toBe("ServiceUnreachable");
    expect(err?.message).toContain(`127.0.0.1:${dead}`);
    expect(err?.message).toContain("t1");
  });

  // The original message still belongs to the case it was written for, and only to
  // that case: a 200 that genuinely carries no id.
  it("still says so when a 200 carries no session id", async () => {
    sessionBody = {};
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(/no session id/);
  });
});

describe("counting how far the reviewer explored", () => {
  // One T2 call read ~1.5M cached tokens before it answered. An agentic reviewer
  // re-sends its accumulated context every turn, so the read count grows with the
  // SQUARE of the exploration — and against a subscription quota the count is what
  // runs out. There is no cap yet, deliberately (D-50): this is the measurement the
  // cap would have to be derived from.
  it("counts one step per agentic turn in the session", async () => {
    replies = [{ parts: [REPLY_STEP, { type: "text", text: FINDING_JSON }] }];
    messages = sessionMessages(9);

    const r = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(r.steps).toBe(9);
    expect(r.findings).toHaveLength(1);
  });

  // THE LESSON THAT KILLED THE PREVIOUS ATTEMPT AT THIS. A prompt reply is one
  // assistant message and an assistant message holds one `step-start`, so a count
  // taken from the reply reads 1 for a nine-turn exploration. The number has to come
  // from the session, and this test fails if it ever goes back to the reply.
  it("takes the count from the session, not from the one step in the reply", async () => {
    replies = [{ parts: [REPLY_STEP, { type: "text", text: FINDING_JSON }] }];
    messages = sessionMessages(9);

    const r = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(r.steps).not.toBe(1);
    const asked = captured.filter((c) => c.method === "GET" && c.path.includes("/session/ses_test/message"));
    expect(asked).toHaveLength(1);
  });

  // The retry is a second agentic run inside the same session, and it explores too.
  // Counting the session rather than a reply gets that for free.
  it("includes the turns the retry spent", async () => {
    replies = [
      { parts: [REPLY_STEP, { type: "text", text: "prose, not json" }] },
      { parts: [REPLY_STEP, { type: "text", text: FINDING_JSON }] },
    ];
    messages = sessionMessages(12);

    const r = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(r.retried).toBe(true);
    expect(r.steps).toBe(12);
  });

  // THE MEASUREMENT'S OWN FAILURE PATH. opencode answers `GET .../message` with a
  // 404 for a session it does not know (verified live), and this call happens after
  // the model has already been paid for. It must cost the review nothing — and it
  // must not invent a number.
  it("keeps the review when the count cannot be taken, and reports no number", async () => {
    replies = [{ parts: [REPLY_STEP, { type: "text", text: FINDING_JSON }] }];
    messagesStatus = 404;
    messages = { name: "NotFoundError", data: { message: "Session not found: ses_test" } };

    const r = await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(r.findings).toHaveLength(1);
    expect(r.steps).toBeUndefined();
  });

  // A reply shape we do not understand must read as "not measured", never as "this
  // review explored nothing" — a zero would be a plausible-looking data point, and
  // the distribution it poisons is the one a future cap gets set from.
  it("reports no number rather than zero when the shape is not the one we know", async () => {
    replies = [{ parts: [REPLY_STEP, { type: "text", text: FINDING_JSON }] }];
    messages = [{ info: { role: "assistant" }, parts: [{ type: "model-turn" }] }];

    expect((await reviewer().review(TIER, "review this", "/tmp/wt")).steps).toBeUndefined();
  });
});

// THE GATE QUEUE IS A WINDOW WITH NO SESSION IN IT. A call waiting for a provider slot
// has not created a session yet, so `cancel` finds nothing to abort and reports so
// truthfully — and then the slot frees and the queued call spends on a review somebody
// ended. The check belongs where the slot is won: after the wait, before anything exists.
describe("a call that is no longer wanted", () => {
  it("does not create a session or spend, and says nothing was spent", async () => {
    replies = [{ parts: [{ type: "text", text: '```json\n{"findings":[]}\n```' }] }];
    const before = captured.length;

    await expect(
      reviewer().review(TIER, "review this", "/tmp/wt", "rev1", () => false),
    ).rejects.toThrow(/ended while this call waited for a provider slot — nothing was spent/);

    expect(captured.slice(before)).toStrictEqual([]);
  });

  it("proceeds normally when it is still wanted", async () => {
    replies = [{ parts: [{ type: "text", text: '```json\n{"findings":[]}\n```' }] }];
    const r = await reviewer().review(TIER, "review this", "/tmp/wt", "rev1", () => true);
    expect(r.findings).toStrictEqual([]);
  });

  /**
   * THE ENTRY CHECK ABOVE ONLY COVERS THE MOMENT BEFORE `run` STARTS. Found by lore's
   * own review, fingerprint 40b5d6e5: once `Gate.run` stopped queuing behind D-101's
   * deleted worker pool, the real wait moved INSIDE `run` — `createSession` is a genuine
   * HTTP round trip, awaited before anything is registered in `sessions`/`kept` — and
   * nothing re-checked `stillWanted` once it returned. A cancel landing during that
   * specific await had no session yet for `cancel()` to find, so the freshly-opened
   * session went on to spend a full prompt nobody would ever read.
   */
  it("still spends nothing when the review ends WHILE the session is being created", async () => {
    replies = [{ parts: [{ type: "text", text: '```json\n{"findings":[]}\n```' }] }];
    // Long enough that the flip below lands WHILE `POST /session` is still in flight.
    createSessionDelayMs = 150;
    let wanted = true;
    setTimeout(() => {
      wanted = false;
    }, 30);

    await expect(
      reviewer().review(TIER, "review this", "/tmp/wt", "rev1", () => wanted),
    ).rejects.toThrow(/ended while tier t1 was opening a session — nothing was spent/);

    // THE SESSION OPENCODE ALREADY CREATED IS CLEANED UP, not leaked — it exists on
    // opencode's side by the time the cancel is noticed, even though lore never used it.
    expect(captured.some((c) => c.method === "DELETE"), "the orphaned session is deleted").toBe(true);
    // AND NO PROMPT WAS EVER SENT, which is the entire point of catching it here rather
    // than only reporting the loss after a full round's worth of quota was already spent.
    expect(
      captured.some((c) => c.path.includes("/message") && c.method === "POST"),
      "quota was never spent on a review that had already ended",
    ).toBe(false);
  });
});

// TOO LONG IS A TIER THAT CANNOT LOOK, NOT A REVIEW THAT FAILED (D-48).
//
// `compactToFit` refuses before spending when the prompt cannot fit the model's
// ADVERTISED window — and the advertised window is not always the limit that applies.
// Live on 2026-08-07: `zai-coding-plan/glm-5-turbo` publishes 200,000 tokens of context,
// so a 104 KB prompt was well inside the computed budget and sent unchanged, and the
// endpoint answered 400 "Prompt exceeds max length". Generic, that failed the whole
// review — six commits unreviewed, while t2 (1M) and t3 (500k) could each have held the
// diff comfortably. Classified, the ladder steps over t1 and finishes passed_partial.
describe("a prompt the provider refuses as too long", () => {
  it("is a tier that could not look, so the ladder can step over it", async () => {
    replies = [{ info: { error: { name: "APIError", data: { message: "Prompt exceeds max length", statusCode: 400 } } } }];
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(TooLargeForTier);
  });

  // It must NOT claim a limit it does not have. We checked the advertised window,
  // believed it would fit, and were refused — so the number we hold is not the number
  // that applies, and printing it would be inventing the explanation.
  it("says the provider refused it, rather than naming a window it fitted", async () => {
    replies = [{ info: { error: { name: "APIError", data: { message: "Prompt exceeds max length", statusCode: 400 } } } }];
    const err = await reviewer().review(TIER, "review this", "/tmp/wt").catch((e: unknown) => e);
    const msg = err instanceof Error ? err.message : "";
    expect(msg).toContain("REFUSED this review as too long");
    expect(msg).toContain("Prompt exceeds max length");
    expect(msg).toMatch(/smaller than the one it publishes/);
    expect((err as TooLargeForTier).contextLimit).toBeUndefined();
  });

  // Quota is checked first and stays first: a plan that is out of budget can answer
  // with wording that mentions limits, and stepping over a tier for the wrong reason
  // spends the ladder's escalation on a problem waiting is the fix for.
  it("still reads an exhausted plan as quota, not as size", async () => {
    replies = [{ info: { error: { name: "APIError", data: { message: "quota exceeded for this plan", statusCode: 429 } } } }];
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(Exhausted);
  });
});

/**
 * A DROPPED CONNECTION IS AMBIGUOUS, AND A PROBE SETTLES IT. "socket hang up" is both
 * how a provider reset presents THROUGH a healthy opencode and what a round sees when
 * the opencode container is recreated under it. On 2026-08-13 the second case skipped t1
 * as "could not answer" while both z.ai plans were fine — Vany read the record and
 * called it a lie. The classifier now asks the one question that tells them apart:
 * is opencode itself answering right now?
 */
describe("a connection that drops mid-call", () => {
  it("requeues when opencode itself has stopped answering", async () => {
    replies = [];
    destroyPrompt = true;
    providersDown = true;
    const err = await reviewer().review(TIER, "review this", "/tmp/wt").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceUnreachable);
    expect(String((err as Error).message)).toContain("opencode itself is not answering");
  });

  it("still blames the tier when opencode is healthy, because then the reset was the provider's", async () => {
    replies = [];
    destroyPrompt = true;
    const err = await reviewer().review(TIER, "review this", "/tmp/wt").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(ServiceUnreachable);
    expect(String((err as Error).message)).toMatch(/failed: .*(socket hang up|other side closed|fetch failed)/i);
  });
});

describe("abandoning a call", () => {
  // Measured live: three T2 calls that failed client-side went on to consume
  // ~3.7M cached-read tokens between them, because the agent kept exploring after
  // we had stopped listening. A timeout that only frees the caller is not a
  // budget — it just makes the spend invisible.
  it("aborts the session when the reply cannot be parsed", async () => {
    replies = [
      { parts: [{ type: "text", text: "prose" }] },
      { parts: [{ type: "text", text: "still prose" }] },
    ];
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow();
    expect(captured.some((c) => c.path.includes("/abort"))).toBe(true);
  });

  it("aborts the session when the provider refuses", async () => {
    replies = [
      { info: { error: { name: "APIError", data: { message: "Insufficient credits", statusCode: 402 } } } },
    ];
    await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(Exhausted);
    expect(captured.some((c) => c.path.includes("/abort"))).toBe(true);
  });

  it("does not abort a call that succeeded", async () => {
    replies = [{ parts: [{ type: "text", text: FINDING_JSON }] }];
    await reviewer().review(TIER, "review this", "/tmp/wt");
    expect(captured.some((c) => c.path.includes("/abort"))).toBe(false);
  });

  // The abort is best-effort by design — throwing here would replace the real error
  // with the cleanup's. Best-effort is not the same as unobserved, though: an abort
  // that failed means the model is still exploring and still spending, which is the
  // exact condition this call exists to end.
  it("says so when the abort itself fails, without replacing the original error", async () => {
    abortStatus = 500;
    replies = [{ info: { error: { name: "APIError", data: { message: "Insufficient credits", statusCode: 402 } } } }];
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(" "));

    try {
      await expect(reviewer().review(TIER, "review this", "/tmp/wt")).rejects.toThrow(/Insufficient credits/);
    } finally {
      console.error = realError;
    }
    expect(logged.join("\n")).toMatch(/could not abort session ses_test/);
  });
});

/**
 * A CANCEL HAS TO STOP BOTH ENDS.
 *
 * `abort` told opencode to stop the model and left our own request open, so a cancelled
 * review went on holding a provider slot until its 2700s deadline. Measured on the
 * deployment 2026-08-08: three sessions aborted with HTTP 200, and ninety seconds later
 * `/status` still read `inFlight: 2` with no active review at all.
 *
 * Both halves are pinned here, because either alone is a false claim of having stopped:
 * without the remote abort the model keeps exploring and keeps billing, and without the
 * local one lore keeps waiting for an answer that can never arrive.
 */
describe("cancelling a call that is still open", () => {
  it("frees the caller instead of waiting out the deadline", async () => {
    hangPrompt = true;
    const r = reviewer();
    const started = Date.now();
    // A ten-second `timeoutMs` is the fixture's deadline. If the cancel does not reach
    // this request it fails at ten seconds with "did not respond within" — which is what
    // the defect looked like, only forty-five minutes long.
    const inFlight = r.review(TIER, "review this", "/tmp/wt", "rev_hung");
    // Long enough for `createSession` to answer and the prompt to be sent; the session
    // is not registered until then, and a cancel arriving earlier would find nothing.
    await new Promise((res) => setTimeout(res, 200));

    await expect(r.cancel("rev_hung"), "it found the session to cancel").resolves.toBe(true);
    // NAMED AS OURS, not as the tier failing. `runRound` closes a tier run `failed` on
    // any throw and `tierFailureCount` counts it — one more count promotes that tier's
    // work to a dearer one. A cancel presenting as a tier failure would spend somebody
    // else's quota answering for a review a person deliberately ended.
    await expect(inFlight).rejects.toThrow(/stopped by lore/);
    expect(Date.now() - started, "the cancel ended it, not the 10s fixture deadline").toBeLessThan(5_000);
  });

  /**
   * THE FAST LOCAL ABORT MUST NOT WAIT BEHIND A SLOW NETWORK CALL (found by lore's own
   * review, fingerprint 4926151e). `cancel` used to await `release`'s `DELETE
   * /session/:id` calls before aborting the in-flight request — so on a conversation
   * tier (every tier in the deployed configuration) a slow or wedged opencode held a
   * cancelling client behind that DELETE while the in-flight model call's own socket,
   * and its spend, stayed open. The test above never exercised this: it uses a
   * non-conversation tier, so `release` finds nothing and the ordering is free.
   */
  it("aborts the in-flight session without waiting on a slow release", async () => {
    const KEPT: Tier = { ...TIER, conversation: true };
    hangPrompt = true;
    // Longer than the bound asserted below — if the abort waited behind this, the test
    // would fail on time, not on a thrown assertion about ordering. `cancel` itself still
    // fully awaits `release` (must not be skipped), so it is not the thing timed here.
    deleteDelayMs = 3_000;
    const r = reviewer();
    const inFlight = r.review(KEPT, { initial: "A", continued: "B" }, "/tmp/wt", "rev_hung");
    // Long enough for the session to be created and kept (D-80 registers it right after
    // creation, before the prompt is ever sent) and for the prompt to be in flight.
    await new Promise((res) => setTimeout(res, 200));

    const started = Date.now();
    const cancelling = r.cancel("rev_hung");
    await expect(inFlight, "the in-flight request dies without waiting on release").rejects.toThrow(/stopped by lore/);
    expect(Date.now() - started, "release's slow DELETE must not hold up the abort").toBeLessThan(deleteDelayMs);

    // release() is still awaited inside cancel — must not be SKIPPED, only reordered —
    // so let it finish and confirm it genuinely ran.
    await expect(cancelling, "cancel itself still resolves once release catches up").resolves.toBe(true);
    expect(captured.some((c) => c.method === "DELETE"), "release still ran, just not first").toBe(true);
  });

  it("still tells opencode to stop the model, which abandoning the socket does not", async () => {
    hangPrompt = true;
    const r = reviewer();
    const inFlight = r.review(TIER, "review this", "/tmp/wt", "rev_hung");
    await new Promise((res) => setTimeout(res, 200));
    await r.cancel("rev_hung");
    await expect(inFlight).rejects.toThrow();

    expect(captured.some((c) => c.path.includes("/abort")), "the model is still exploring until this lands").toBe(true);
  });

  // A review with nothing in flight must not report that it stopped something. The
  // handler renders this straight into "the model call in flight was aborted", and a
  // client repeats that to its user.
  it("reports false when that review has no session", async () => {
    await expect(reviewer().cancel("rev_never_started")).resolves.toBe(false);
  });
});

// The most frequent failure in this system was also the least diagnosable: a round
// died AFTER the model had been paid for, and nothing anywhere recorded what it
// actually said. Observed on a real review of this repo.
describe("an unparseable reply says what shape it was", () => {
  // AND SAYS ONLY THAT. "usually a provider failure inside a 200" was here, in a string
  // TOOL_DOCS.poll tells a client to repeat to its user verbatim — a guess presented as
  // an explanation. A client repeated it five times over two days about a branch whose
  // real fault was a diff 3.4x the largest that tier had ever finished, and ended by
  // telling a person lore's tier was broken. Where lore knows the cause it belongs in
  // failed_because; where it does not, silence beats a plausible story.
  it("names an empty reply as empty, and does not guess why", async () => {
    replies = [{ parts: [{ type: "text", text: "" }] }, { parts: [{ type: "text", text: "" }] }];
    const err = await reviewer()
      .review(TIER, "review this", "/tmp/wt")
      .then(() => undefined, (e: unknown) => e as Error);

    expect(err?.message).toMatch(/DID NOT RUN/);
    expect(err?.message).toMatch(/EMPTY/);
    expect(err?.message).not.toMatch(/usually|probably|provider failure inside/);
  });

  // Prose means the model answered and ignored the contract — a prompt problem, and
  // a different hour of debugging from an empty reply.
  it("names prose as prose, with its length", async () => {
    const prose = "I reviewed the code and it looks fine to me overall.";
    replies = [{ parts: [{ type: "text", text: prose }] }, { parts: [{ type: "text", text: prose }] }];
    const err = await reviewer()
      .review(TIER, "review this", "/tmp/wt")
      .then(() => undefined, (e: unknown) => e as Error);

    expect(err?.message).toMatch(/prose with no JSON block/);
    expect(err?.message).toContain(String(prose.length));
  });

  // The replies themselves go to the log, not into the message: the message travels
  // into a review's failure text and an operator alert, and a 40KB model reply in
  // either is its own problem.
  it("puts both replies on the log so the round is diagnosable at all", async () => {
    replies = [{ parts: [{ type: "text", text: "first attempt prose" }] }, { parts: [{ type: "text", text: "second attempt prose" }] }];
    const logged: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => logged.push(a.join(" "));
    try {
      await reviewer().review(TIER, "review this", "/tmp/wt").catch(() => undefined);
    } finally {
      console.error = real;
    }
    const all = logged.join("\n");
    expect(all).toContain("first attempt prose");
    expect(all).toContain("second attempt prose");
  });
});

describe("countStepParts", () => {
  const turn = (id: string) => ({
    info: { id, sessionID: "ses_test", role: "assistant" },
    parts: [
      { id: `${id}s`, messageID: id, type: "step-start" },
      { id: `${id}t`, messageID: id, type: "tool" },
    ],
  });

  it("counts the step of every turn, ignoring everything else in it", () => {
    expect(countStepParts([turn("a"), turn("b"), turn("c")])).toBe(3);
  });

  // Real sessions contain messages that hold nothing but `patch` parts — 4 of the 86
  // in the session this shape was copied from. They are bookkeeping, not turns.
  it("does not count a message that never went to the model", () => {
    expect(countStepParts([turn("a"), { info: { role: "assistant" }, parts: [{ type: "patch" }] }])).toBe(1);
  });

  // "I could not tell" and "it explored nothing" are different facts, and only one
  // of them belongs in a table that a threshold will later be computed from.
  it("says nothing rather than zero when there is nothing it recognises", () => {
    expect(countStepParts([])).toBeUndefined();
    expect(countStepParts(undefined)).toBeUndefined();
    expect(countStepParts({ messages: [turn("a")] })).toBeUndefined();
    expect(countStepParts([{ info: { role: "assistant" }, parts: "not an array" }])).toBeUndefined();
  });
});

describe("extractFindings", () => {
  const ok = (t: string) => {
    const r = extractFindings(t);
    if (!r.ok) throw new Error(`expected findings, got: ${r.why}`);
    return r.findings;
  };
  const why = (t: string) => {
    const r = extractFindings(t);
    if (r.ok) throw new Error("expected a failure, got findings");
    return r.why;
  };

  it("finds the block whether or not it is fenced", () => {
    expect(ok(`prose\n\`\`\`json\n${FINDING_JSON}\n\`\`\`\nmore prose`)).toHaveLength(1);
    expect(ok(FINDING_JSON)).toHaveLength(1);
  });

  it("distinguishes 'said clean' from 'could not be read'", () => {
    // [] means the model said clean. A failure means we could not tell. Conflating
    // them is precisely INV-1's failure.
    expect(ok('{"findings": []}')).toStrictEqual([]);
    expect(why("I could not complete this review.")).toMatch(/no JSON object/);
  });

  // D-66. This used to bin the whole reply, on the argument that keeping the good
  // findings would "silently drop a defect the model actually found". The premise was
  // the word SILENTLY: discarding everything drops that same defect AND every valid
  // finding beside it, which is strictly worse on the axis the rule defended.
  //
  // Measured before changing it: five paid replies binned this way, the worst a t2
  // round of forty minutes whose single finding — 14 characters over the cap — was
  // correct and load-bearing.
  it("keeps the valid findings when one sibling is malformed, and says what went", () => {
    const mixed = JSON.stringify({
      findings: [JSON.parse(FINDING_JSON).findings[0], { file: "x.ts", severity: "high" }],
    });
    const r = extractFindings(mixed);
    if (!r.ok) throw new Error(`expected the good finding to survive: ${r.why}`);

    expect(r.findings).toHaveLength(1);
    // The loss is carried, not swallowed — it becomes checks_skipped for the client.
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatch(/finding 2 of 2/);
  });

  it("still fails the reply when NOTHING in it is usable", () => {
    // Nothing survived, so there is no partial result to keep: this is a reply we
    // could not read, which is a failed round rather than a clean one.
    const allBad = JSON.stringify({ findings: [{ file: "x.ts" }, { file: "y.ts" }] });
    expect(why(allBad)).toMatch(/all 2 finding\(s\) were rejected/);
  });

  it("rejects a finding carrying keys we did not ask for", () => {
    const extra = JSON.stringify({
      findings: [{ ...JSON.parse(FINDING_JSON).findings[0], confidence: 0.9 }],
    });
    expect(why(extra)).toMatch(/all 1 finding\(s\) were rejected/);
  });

  // The reason this type exists, pinned to the reply that cost a review.
  //
  // glm-5.2 found a real high-severity bug and wrote a 325-character claim against
  // a 300-character cap. The reply was flawless JSON; only the cap rejected it. The
  // operator was told "malformed JSON" and the model was told nothing at all, so on
  // retry it guessed — trimming one claim to 298 and leaving another at 322.
  //
  // The cap moved 300 → 500 on 2026-08-05 after a fourth loss, so the limit is read
  // from the constant here. A literal would have gone on asserting the old number
  // while the message carried the new one — and this test exists precisely because
  // a model cannot comply with a limit it is told wrongly.
  //
  // REVERSED BY D-116, after a fifth loss the raise did not prevent. Length no longer
  // rejects anything: the claim is folded and the full text carried into `evidence`. The
  // message-quality rule this test defended still holds for the faults that DO reject —
  // `cwe` above is one — but survival is the stronger property, because an operator does
  // not need a well-worded error about a finding they did not lose.
  it("folds an over-long claim instead of rejecting the reply", () => {
    const long = JSON.parse(FINDING_JSON).findings[0];
    const claim = "x".repeat(CLAIM_MAX + 25);
    const r = extractFindings(JSON.stringify({ findings: [{ ...long, claim }] }));
    if (!r.ok) throw new Error(`expected the finding to survive its length: ${r.why}`);
    expect(r.findings[0]?.claim.length).toBeLessThanOrEqual(CLAIM_MAX);
    expect(r.findings[0]?.evidence).toContain(claim);
  });

  it("says which of the three faults it was", () => {
    expect(why("```json\n{not json at all}\n```")).toMatch(/JSON did not parse/);
    expect(why('{"results": []}')).toMatch(/no `findings` array/);
  });

  // t3 raised this against the comment above the loop, which claimed the reason
  // came from the candidate that got furthest while the code just overwrote it per
  // candidate. Here the fenced block parses and merely lacks `findings`; the bare
  // slice taken from the first "{" then fails to parse and used to mask it, so the
  // log blamed a stray brace in trailing prose for a reply whose real fault was a
  // missing key.
  it("reports the candidate that got furthest, not the last one tried", () => {
    expect(why('```json\n{"results": []}\n```\ntrailing {oops')).toMatch(/no `findings` array/);
  });
});

// Every question the reviewer answers with a tool call is one it could have been
// handed for free. We counted `step-start` and discarded the rest, so how a tier
// spent its turns was invisible — and that is exactly the measurement that says what
// to precompute next. The three facts added today (the branch's commits, whether it
// still merges, what the base did to the overlapping files) were found by reasoning
// about a wrong finding. Looking is cheaper than reasoning.
describe("what the reviewer reached for", () => {
  const msg = (...parts: unknown[]) => ({ parts });

  it("counts tool calls by name", () => {
    const data = [
      msg({ type: "step-start" }, { type: "tool", tool: "read" }, { type: "tool", tool: "bash" }),
      msg({ type: "tool", tool: "read" }, { type: "text", text: "thinking" }),
    ];
    expect(toolsUsed(data)).toStrictEqual({ read: 2, bash: 1 });
  });

  // A histogram that returns nothing is a lost measurement, never a failed review:
  // this reads someone else's reply format and must not throw on a shape change.
  it.each([[undefined], [null], [{}], ["nonsense"], [[{ parts: "not an array" }]]])(
    "returns an empty histogram for %s rather than throwing",
    (data) => {
      expect(() => toolsUsed(data)).not.toThrow();
      expect(toolsUsed(data)).toStrictEqual({});
    },
  );

  it("falls back through the shapes a tool part might use", () => {
    const data = [msg({ type: "tool", name: "grep" }, { type: "tool", state: { title: "webfetch" } }, { type: "tool" })];
    expect(toolsUsed(data)).toStrictEqual({ grep: 1, webfetch: 1, unknown: 1 });
  });
});

/**
 * "TOO LONG FOR THIS TIER" IS A DOWNGRADE, SO IT MUST NOT BE GUESSED.
 *
 * `TooLargeForTier` makes the ladder STEP OVER the tier and finish `passed_partial`
 * (D-48) — weaker evidence, honestly labelled. That is right when the tier's window
 * genuinely could not hold the diff, and wrong for everything else: a transient rate
 * limit classified this way silently downgrades a review's evidence instead of failing
 * it, and the attestation then claims a tier was honestly skipped when it was throttled.
 *
 * The first version matched the bare substring `exceed`, so every "rate limit exceeded"
 * and "quota exceeded" a provider has ever sent was read as a context overflow.
 */
describe("classifying a provider error as a window that was too small", () => {
  const tooLong = [
    "Prompt exceeds max length",
    "This model's maximum context length is 128000 tokens",
    "input is too long for the requested model",
    "context window exceeded for this request",
    "request body too large",
  ];
  const notTooLong = [
    "rate limit exceeded",
    "quota exceeded for this billing period",
    "daily spend limit exceeded",
    "concurrent request limit exceeded, retry later",
    "too many requests",
  ];

  it.each(tooLong)("reads %s as too long", (message) => {
    expect(isTooLong(message), message).toBe(true);
  });

  it.each(notTooLong)("does NOT read %s as too long", (message) => {
    expect(isTooLong(message), `${message} — this would silently downgrade the review`).toBe(false);
  });
});

/**
 * A CALL THAT FAILS STILL SPENT SOMETHING, and until 2026-08-09 we recorded none of it.
 *
 * `usage` rows are written only on success, so a failed call's tokens were invisible —
 * while the provider counted every one. Measured that day: two t1 attempts ran 45 minutes
 * each against an exhausted Z.ai plan, and the trailing-5h usage read ZERO. Any quota
 * accounting built on that under-counts exactly when the provider is at its limit, which
 * is the one moment it has to be right.
 *
 * The session survives the failure and its messages still carry per-message `tokens`, so
 * the spend is read back from there.
 */
describe("spend recovered from a call that failed", () => {
  const messages = (rows: unknown[]) => ({ data: rows });

  it("sums the assistant messages, including cache reads and writes", async () => {
    const sum = await usageFromMessages(
      messages([
        { info: { role: "user", tokens: { input: 999 } } },
        { info: { role: "assistant", tokens: { input: 10, output: 3, cache: { read: 100, write: 5 } } } },
        { info: { role: "assistant", tokens: { input: 20, output: 7, cache: { read: 200, write: 0 } } } },
      ]),
    );
    // The user turn is not the model's spend; cache read AND write both count.
    expect(sum).toStrictEqual({ input: 30, cached: 305, output: 10, cost: 0 });
  });

  // Nothing spent is `undefined`, never a row of zeroes: a zero row is
  // indistinguishable from a call that ran and used nothing, and this must not invent
  // spend it cannot see.
  it("reports nothing rather than zero when the session shows no tokens", async () => {
    expect(await usageFromMessages(messages([{ info: { role: "assistant", tokens: {} } }]))).toBeUndefined();
    expect(await usageFromMessages(messages([]))).toBeUndefined();
  });

  // Subscriptions report cost 0 on every message, so a dollar total is structurally
  // meaningless here — the units that mean anything are tokens and credits.
  it("does not pretend to a dollar cost", async () => {
    const sum = await usageFromMessages(messages([{ info: { role: "assistant", tokens: { input: 1, output: 1 } } }]));
    expect(sum?.cost).toBe(0);
  });
});

/**
 * WAITING IS THE BUG (D-91).
 *
 * `session.prompt` is one long HTTP request that says nothing until it returns, so an
 * exhausted plan cost the full 2700s deadline. Meanwhile opencode was narrating the same
 * call on `/event`: measured 2026-08-09, the provider's exact refusal — *with its reset
 * time* — arrived SEVEN SECONDS after the prompt, then four more times in ninety seconds.
 *
 *   {"type":"session.status","properties":{"sessionID":"ses_…","status":{
 *      "type":"retry","attempt":1,
 *      "message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-10 18:19:09"}}}
 *
 * D-84 said opencode swallows the limit and the reset time. It swallows them in the
 * message body, which is where lore was looking, and publishes them here.
 */
describe("reading what opencode says about a call in flight", () => {
  it("recognises a quota refusal and takes the reset time out of it", () => {
    const r = quotaRefusal({
      type: "retry",
      attempt: 1,
      message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-10 18:19:09",
    });
    expect(r?.message).toContain("Weekly/Monthly Limit Exhausted");
    expect(r?.resetAt, "the fact lore spent three days believing was unreachable").toBe("2026-08-10T18:19:09.000Z");
  });

  /**
   * OPENAI'S PHRASING, measured live 2026-08-13 after it cost three reviews and a whole
   * propose run 45 minutes each. The narration carried "The usage limit has been
   * reached" on every attempt — the watcher saw it and did not know the words, so
   * opencode retried for ever and the deadline was the only thing that ended the call.
   * No reset time: openai names none, and the event's `next` is the next RETRY attempt
   * seconds away — parsing it as a reset would park the tier for five seconds and call
   * that a cool-off.
   */
  it("recognises openai's usage-limit phrasing, with no reset time", () => {
    const r = quotaRefusal({ type: "retry", attempt: 2, message: "The usage limit has been reached" });
    expect(r?.message).toBe("The usage limit has been reached");
    expect(r?.resetAt).toBeUndefined();
  });

  // A retry is opencode saying it will ask again, which is CORRECT behaviour for a 500.
  // Failing the call on every retry would turn a recoverable blip into a dead tier, and
  // the ladder would step over a provider that was about to answer.
  it("leaves an ordinary retry alone", () => {
    expect(quotaRefusal({ type: "retry", attempt: 1, message: "connection reset by peer" })).toBeUndefined();
    expect(quotaRefusal({ type: "busy" })).toBeUndefined();
    expect(quotaRefusal({ type: "retry" }), "no message is nothing to classify").toBeUndefined();
  });

  // A refusal that names no time is still a refusal — it just leaves the caller to its
  // own backoff. Returning nothing here would make lore hang out the full deadline for
  // any provider that phrases its limit differently.
  it("classifies a refusal that names no reset time", () => {
    const r = quotaRefusal({ type: "retry", message: "rate limit exceeded, try later" });
    expect(r?.message).toContain("rate limit");
    expect(r?.resetAt).toBeUndefined();
  });
});

/**
 * The refactor's actual claim: a call dies when the answer arrives, not when a clock says so.
 *
 * With an exhausted plan the prompt request never returns, so before D-91 this cost the
 * full 2700s deadline — 45 minutes of holding a provider slot for a fact that had already
 * been published. The fixture reproduces exactly that: a prompt that never answers, and a
 * refusal on the event stream while it hangs.
 */
describe("a quota refusal on the event stream", () => {
  it("fails the call in flight instead of waiting out the deadline", async () => {
    hangPrompt = true;
    const r = reviewer();
    const started = Date.now();
    const inFlight = r.review(TIER, "review this", "/tmp/wt", "rev_quota");
    // Long enough for the session to exist and its watcher to be registered; a refusal
    // arriving before that has nowhere to go, which is the race the deadline still covers.
    await new Promise((res) => setTimeout(res, 250));
    pending.push({
      type: "session.status",
      properties: {
        sessionID: "ses_test",
        status: {
          type: "retry",
          attempt: 1,
          message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-10 18:19:09",
        },
      },
    });

    // EXHAUSTED, not DidNotRun. The distinction decides whether the ladder steps over the
    // tier and finishes (D-48) or fails the whole review — and "Weekly/Monthly Limit
    // Exhausted" matches none of the classifier's patterns, so it only arrives correctly
    // because the abort reason is already the right type.
    await expect(inFlight).rejects.toThrow(Exhausted);
    expect(Date.now() - started, "seconds, against a 10s fixture deadline and 2700s in production").toBeLessThan(5_000);
    r.close();
  });

  it("carries the reset time the provider named, so nobody has to guess", async () => {
    hangPrompt = true;
    const r = reviewer();
    const inFlight = r.review(TIER, "review this", "/tmp/wt", "rev_quota2");
    await new Promise((res) => setTimeout(res, 250));
    pending.push({
      type: "session.status",
      properties: {
        sessionID: "ses_test",
        status: { type: "retry", message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-10 18:19:09" },
      },
    });

    const err = await inFlight.then(() => undefined, (e: unknown) => e);
    expect((err as Exhausted).resetAt, "D-90 waits exactly this long instead of doubling a guess").toBe(
      "2026-08-10T18:19:09.000Z",
    );
    r.close();
  });

  // A retry is opencode saying it will try again, and for a 500 that is correct. Killing
  // the call on any retry would turn a recoverable blip into a stepped-over tier.
  it("lets an ordinary retry run on", async () => {
    hangPrompt = true;
    const r = reviewer();
    const inFlight = r.review(TIER, "review this", "/tmp/wt", "rev_blip");
    await new Promise((res) => setTimeout(res, 250));
    pending.push({
      type: "session.status",
      properties: { sessionID: "ses_test", status: { type: "retry", attempt: 1, message: "connection reset by peer" } },
    });
    await new Promise((res) => setTimeout(res, 400));

    // Still open: the fixture's own 10s deadline is what will end it, exactly as before.
    const settled = await Promise.race([inFlight.then(() => "settled", () => "settled"), new Promise((res) => setTimeout(() => res("open"), 300))]);
    expect(settled).toBe("open");
    // Ended deliberately rather than left to the fixture's deadline, so the suite does
    // not carry a ten-second wait per run.
    await r.cancel("rev_blip");
    await inFlight.catch(() => undefined);
    r.close();
  });
});

/**
 * A RETRY STORM IS A DOWN PROVIDER WEARING A RETRY LOOP (the 5-minute bound).
 *
 * Vany: *"if it starts retrying a lot, do not allow it to wait more than 5 minutes —
 * treat openai as down and go to the fallback."* The classifier kills refusals it
 * recognises in seconds; openai's phrasing was unknown for three days and cost every t3
 * round 45 minutes at the deadline. This bound is the backstop for the NEXT unknown
 * phrasing: retries still arriving past the limit end the call as Exhausted — the type
 * the fallback chain advances on.
 */
describe("a retry storm on the event stream", () => {
  const retryEvent = (msg: string) => ({
    type: "session.status",
    properties: { sessionID: "ses_test", status: { type: "retry", attempt: 1, message: msg } },
  });

  it("treats a storm older than the bound as a down route, and moves on", async () => {
    hangPrompt = true;
    const r = new Reviewer({ baseUrl, agent: "readonly", timeoutMs: 10_000, retryStormMs: 200 });
    const started = Date.now();
    const inFlight = r.review(TIER, "review this", "/tmp/wt", "rev_storm");
    await new Promise((res) => setTimeout(res, 250));
    // A message the classifier does NOT know — the whole point of the bound.
    pending.push(retryEvent("some entirely new provider unhappiness"));
    await new Promise((res) => setTimeout(res, 300));
    pending.push(retryEvent("some entirely new provider unhappiness"));

    const err = await inFlight.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Exhausted);
    expect(String((err as Error).message)).toMatch(/retried by opencode .* without recovering/);
    expect((err as Exhausted).resetAt, "no provider named a time, so none is invented").toBeUndefined();
    expect(Date.now() - started, "minutes in production, never the 2700s deadline").toBeLessThan(5_000);
    r.close();
  });

  it("clears the clock when the session recovers between retries", async () => {
    hangPrompt = true;
    const r = new Reviewer({ baseUrl, agent: "readonly", timeoutMs: 10_000, retryStormMs: 300 });
    const inFlight = r.review(TIER, "review this", "/tmp/wt", "rev_recover");
    await new Promise((res) => setTimeout(res, 250));
    pending.push(retryEvent("blip"));
    // WELL past the bound in TOTAL, well inside it per storm — the margins are wide on
    // both sides of the 300ms bound so this cannot pass or fail on delivery jitter.
    await new Promise((res) => setTimeout(res, 200));
    // Recovery: any non-retry status. The storm that follows starts a NEW clock.
    pending.push({ type: "session.status", properties: { sessionID: "ses_test", status: { type: "busy" } } });
    await new Promise((res) => setTimeout(res, 200));
    pending.push(retryEvent("blip again"));
    await new Promise((res) => setTimeout(res, 150));

    // Total retry-span exceeds the bound, but no single storm did — still open.
    const settled = await Promise.race([
      inFlight.then(() => "settled", () => "settled"),
      new Promise((res) => setTimeout(() => res("open"), 100)),
    ]);
    expect(settled, "two short storms are not one long one").toBe("open");
    await r.cancel("rev_recover");
    await inFlight.catch(() => undefined);
    r.close();
  });
});

/**
 * A DATE SHAPE IS NOT A DATE, and this one runs inside the event watcher.
 *
 * `\d{4}-\d{2}-\d{2}` matches `2026-13-45 99:99:99`, and `toISOString()` on an invalid
 * Date THROWS. That RangeError would be raised inside the watcher, from inside the stream
 * loop's deliberately silent catch — so the abort would never fire, the stream would
 * quietly reconnect, and the call would wait out the full 2700s. The exact hang D-91
 * removes, reintroduced through its own parser, and invisible while it happened.
 */
describe("a refusal whose reset time is malformed", () => {
  it("still classifies the refusal, and names no time", () => {
    const r = quotaRefusal({ type: "retry", message: "Limit Exhausted. Your limit will reset at 2026-13-45 99:99:99" });
    expect(r?.message, "the refusal is real whatever the date says").toContain("Limit Exhausted");
    expect(r?.resetAt, "an unparseable time is no time, never a thrown error").toBeUndefined();
  });

  it("does not throw for any date-shaped nonsense", () => {
    for (const t of ["0000-00-00 00:00:00", "9999-99-99 99:99:99", "2026-02-30 12:00:00"]) {
      expect(() => quotaRefusal({ type: "retry", message: `quota exceeded, resets at ${t}` })).not.toThrow();
    }
  });
});

/**
 * ONE STREAMED EMISSION (D-107): findings the model has in hand, or the done declaration
 * — and nothing in between. The empty list is refused ON PURPOSE: under emit-and-stop,
 * having nothing more to say IS the done declaration, and `[]` is a model that has
 * confused the two in exactly the way the retry should surface.
 */
describe("emissionOf", () => {
  it("parses a findings batch, not done", () => {
    const r = emissionOf('```json\n' + FINDING_JSON + '\n```');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(1);
      expect(r.done).toBe(false);
    }
  });

  it("parses the done declaration, with no findings", () => {
    const r = emissionOf('```json\n{"done": true, "examined": "all of src/core"}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.done).toBe(true);
      expect(r.items).toHaveLength(0);
    }
  });

  // INV-1's corner: an empty list must never read as "clean" mid-stream.
  it("refuses an empty findings list, naming the two real options", () => {
    const r = emissionOf('```json\n{"findings": []}\n```');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/report a finding, or declare/);
  });

  it("refuses prose, exactly as the batch contract does", () => {
    expect(emissionOf("looks fine to me").ok).toBe(false);
  });

  // done:false or done-shaped garbage is not a declaration.
  it("does not accept a done that is not literally true", () => {
    const r = emissionOf('```json\n{"done": "yes"}\n```');
    expect(r.ok).toBe(false);
  });

  /**
   * BOTH IN ONE BLOCK: the model's last emission may carry its final findings AND the
   * declaration. The first version returned on the done marker before reading the
   * findings — every one of them lost silently, and the run could end `passed` on code
   * the model had flagged. Raised by lore's own review of this change.
   */
  it("keeps the findings when they arrive in the same block as done", () => {
    const r = emissionOf(
      '```json\n' +
        JSON.stringify({ findings: JSON.parse(FINDING_JSON).findings, done: true, examined: "everything" }) +
        '\n```',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items, "the final findings survive the declaration").toHaveLength(1);
      expect(r.done).toBe(true);
    }
  });

  /**
   * TWO FINDINGS BLOCKS, ONE MESSAGE. "Report each finding the moment you are sure of
   * it; a small batch is acceptable" reads naturally as one fence per finding when
   * several are ready at once. The first version returned on the FIRST candidate that
   * parsed with any valid item, so the second block's findings were never even looked
   * at — not recorded, not in `discarded`, and the model, told "recorded and
   * delivered", believed both had been filed.
   */
  it("keeps findings from every fenced block, not only the first", () => {
    const second = {
      findings: [
        {
          file: "src/other.ts",
          line: 40,
          severity: "medium",
          claim: "a second defect entirely",
          evidence: "elsewhere in the same message",
          failureScenario: "a different input, a different wrong outcome",
        },
      ],
    };
    const r = emissionOf('```json\n' + FINDING_JSON + '\n```\n```json\n' + JSON.stringify(second) + '\n```');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items.map((f) => f.claim).sort()).toStrictEqual(
        ["decline path leaves the hold active", "a second defect entirely"].sort(),
      );
    }
  });

  /**
   * DONE MUST NOT LAUNDER THE LOSSES (raised by lore's own t2 against D-109). The
   * batch path retries a reply whose every finding the schema refused; done forecloses
   * the retry, so without carrying the rejections through, they vanished — no
   * discarded note, no checks_skipped line, and the run ended looking complete over
   * findings the model explicitly tried to report.
   */
  it("carries schema-rejected findings through a done declaration", () => {
    // The example has moved TWICE, which is the point: `severity: "catastrophic"` stopped
    // being a refusal (D-115), then `line: 0` stopped being one too (it is repaired into a
    // file-level finding). An absolute path is the stable one — it is a SAFETY refusal
    // rather than a strictness refusal, and repairing it would mean guessing at a path
    // outside the repo. If this example ever needs replacing again, that is a signal the
    // refusals have narrowed to their proper core, not that this test is fragile.
    const bad = { file: "/etc/passwd", severity: "high", claim: "c", evidence: "e", failureScenario: "f" };
    const r = emissionOf(
      '```json\n' + JSON.stringify({ findings: [bad] }) + '\n```\n```json\n{"done": true}\n```',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.done).toBe(true);
      expect(r.items).toHaveLength(0);
      expect(r.rejected.length, "the refused finding is a recorded loss, not a silence").toBeGreaterThan(0);
    }
  });

  it("says nothing about losses on a pure done declaration", () => {
    const r = emissionOf('```json\n{"done": true, "examined": "everything"}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rejected).toHaveLength(0);
  });

  // The refutation of the first fix, from lore's own t2: the loss was inferred from
  // `why`, and the ranking lawfully lets a healthy done block's "no findings array"
  // overwrite the mangled block's parse error — so a truncated findings fence beside a
  // valid done fence vanished without a note. The loss now rides the failure directly.
  it("carries a garbled findings block through a done declaration as a loss", () => {
    const r = emissionOf('```json\n{"findings": [{"file": "a.ts",\n```\n```json\n{"done": true}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.done).toBe(true);
      expect(r.rejected.length, "the mangled attempt is a recorded loss").toBeGreaterThan(0);
      expect(r.rejected[0]).toMatch(/did not parse/);
    }
  });

  /**
   * NEITHER LOSS EVICTS THE OTHER (found by lore's own review, fingerprint b2aef74f).
   * `allRejected ?? [fencedGarbled]` assumed the two loss kinds cannot coexist in one
   * message, but a truncated fence (JSON.parse fails) and a complete fence whose every
   * item the schema refuses are independent failures and can both be present — and the
   * `??` silently dropped the garbled one whenever a sibling landed in `allRejected`.
   */
  it("carries a garbled block AND an all-rejected block through a done declaration", () => {
    const bad = { file: "/etc/passwd", severity: "high", claim: "c", evidence: "e", failureScenario: "f" };
    const r = emissionOf(
      '```json\n{"findings": [{"file": "a.ts",\n```\n' +
        '```json\n' + JSON.stringify({ findings: [bad] }) + '\n```\n' +
        '```json\n{"done": true}\n```',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.done).toBe(true);
      expect(r.items).toHaveLength(0);
      expect(r.rejected.some((x) => /did not parse/.test(x)), "the garbled fence is not dropped").toBe(true);
      expect(r.rejected.some((x) => x.includes("/etc/passwd")), "the all-rejected fence survives too").toBe(true);
    }
  });

  /**
   * NOT JUST TWO KINDS — TWO OF THE SAME KIND (found by lore's own review, fingerprint
   * 9857f644, against the b2aef74f fix directly above). Uniting `allRejected` and
   * `fencedGarbled` still left each tracked as a single last-write-wins scalar, so two
   * candidates failing the SAME way — here, two complete fences whose every item the
   * schema refuses — still clobbered each other: only the second's reason survived.
   */
  it("carries losses from every all-rejected candidate, not just the last", () => {
    const first = { file: "/etc/passwd", severity: "high", claim: "first", evidence: "e", failureScenario: "f" };
    const second = { file: "/etc/shadow", severity: "high", claim: "second", evidence: "e", failureScenario: "f" };
    const r = emissionOf(
      '```json\n' + JSON.stringify({ findings: [first] }) + '\n```\n' +
        '```json\n' + JSON.stringify({ findings: [second] }) + '\n```',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect((r.rejected ?? []).some((x) => x.includes("/etc/passwd")), "the first candidate's loss is not evicted").toBe(true);
      expect((r.rejected ?? []).some((x) => x.includes("/etc/shadow")), "the second candidate's loss survives too").toBe(true);
    }
  });

  it("keeps the findings when done arrives as its own second block", () => {
    const r = emissionOf('```json\n' + FINDING_JSON + '\n```\n```json\n{"done": true}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(1);
      expect(r.done).toBe(true);
    }
  });
});
