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
import { CLAIM_MAX } from "../core/finding.ts";
import type { Tier } from "../core/ladder.ts";
import { Reviewer, countStepParts, extractFindings, splitModel, toolsUsed } from "./opencode.ts";

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
        if (path.endsWith("/message")) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(replies.shift() ?? {}));
          return;
        }
        if (path === "/session") {
          // A refusing opencode answers with a status and no body at all — verified
          // against a password-protected server, which sends a bare 401 with
          // Content-Length: 0.
          res.writeHead(sessionStatus, { "content-type": "application/json" });
          res.end(sessionStatus >= 400 ? "" : JSON.stringify(sessionBody));
          return;
        }
        if (path.endsWith("/abort")) {
          res.writeHead(abortStatus, { "content-type": "application/json" });
          res.end(abortStatus >= 400 ? "" : "true");
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
    const offline = new Reviewer({ baseUrl: `http://127.0.0.1:${dead}`, agent: "readonly", timeoutMs: 2_000 });
    const err = await offline
      .review(TIER, "review this", "/tmp/wt")
      .then(() => undefined, (e: unknown) => e as Error);

    expect(err?.name).toBe("DidNotRun");
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

// The most frequent failure in this system was also the least diagnosable: a round
// died AFTER the model had been paid for, and nothing anywhere recorded what it
// actually said. Observed on a real review of this repo.
describe("an unparseable reply says what shape it was", () => {
  it("names an empty reply as empty, because that is a provider fault not a prompt one", async () => {
    replies = [{ parts: [{ type: "text", text: "" }] }, { parts: [{ type: "text", text: "" }] }];
    const err = await reviewer()
      .review(TIER, "review this", "/tmp/wt")
      .then(() => undefined, (e: unknown) => e as Error);

    expect(err?.message).toMatch(/DID NOT RUN/);
    expect(err?.message).toMatch(/EMPTY/);
    expect(err?.message).toMatch(/provider failure inside a 200/);
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

  it("rejects the whole reply when one finding is malformed", () => {
    // Keeping the valid ones would silently drop a defect the model actually found,
    // and nobody would ever know it had been dropped.
    const mixed = JSON.stringify({
      findings: [JSON.parse(FINDING_JSON).findings[0], { file: "x.ts", severity: "high" }],
    });
    expect(why(mixed)).toMatch(/finding 2 of 2 was rejected/);
  });

  it("rejects a finding carrying keys we did not ask for", () => {
    const extra = JSON.stringify({
      findings: [{ ...JSON.parse(FINDING_JSON).findings[0], confidence: 0.9 }],
    });
    expect(why(extra)).toMatch(/finding 1 of 1 was rejected/);
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
  it("names the CAP, not the JSON, when a claim is too long", () => {
    const long = JSON.parse(FINDING_JSON).findings[0];
    const reason = why(JSON.stringify({ findings: [{ ...long, claim: "x".repeat(CLAIM_MAX + 25) }] }));
    expect(reason).toMatch(/^finding 1 of 1 was rejected — claim: /);
    // Actionable: it has to carry the limit, or a model cannot comply with it.
    expect(reason).toContain(String(CLAIM_MAX));
    expect(reason).not.toMatch(/JSON/);
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
