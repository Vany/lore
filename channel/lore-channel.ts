#!/usr/bin/env node
/**
 * A Claude Code CHANNEL that wakes a session when one of its reviews needs it.
 *
 * THE PROBLEM THIS EXISTS FOR, measured on the live store 2026-09-12. Of the findings a
 * client collected within an hour of them being raised, the median sat for 192 seconds
 * before anyone looked, 764 of them sat for more than 450, and the total dead time was
 * 339 hours. Clients bridge the gap with `sleep 450` — a constant that cannot be right,
 * because a round's wall-time runs from 20 seconds to 1400 across tiers.
 *
 * WHY NOT lore's OWN SUBSCRIPTION. lore implements `subscriptions/listen` and pushes
 * `notifications/resources/updated` (D-80), and for a Claude Code client that is unusable
 * twice over: Claude Code has no MCP resource-subscription support at all, and even where
 * a harness has one, an AGENT is handed tools rather than raw protocol methods, so it
 * cannot open a stream it is told about. lore was advertising that stream to this very
 * session all day and it was never once actionable.
 *
 * WHY A SEPARATE PROCESS. A channel is spawned by Claude Code as a stdio subprocess on the
 * user's machine; lore is a remote HTTP service in Docker. lore cannot BE a channel. So
 * the bridge is this: a local daemon that polls lore, and pushes into the session.
 *
 * AND POLLING HERE IS FREE, WHICH IS THE WHOLE POINT. The waste was never HTTP requests —
 * it was AGENT TURNS, each one an LLM call that usually learned nothing. Moving the same
 * polling into a process with no model attached costs nothing and removes all of them.
 *
 * NO DEPENDENCIES, AND THE PROTOCOL VERSION IS WHY. Claude Code refuses to register a
 * channel that negotiates MCP revision 2026-07-28, and it does so SILENTLY — the server
 * runs, notifications are written, and they are dropped with no error returned. The MCP
 * SDKs in this repo are v2 and know 2026-07-28, so handing negotiation to one of them
 * risks exactly that silent non-registration. Speaking the handshake directly is ~100
 * lines and makes the one value that decides whether this works at all impossible to get
 * wrong by accident.
 *
 * SPEC: D-148, `spec/mcp-api.md`
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Revisions this channel will settle on, newest first — and 2026-07-28 is deliberately
 * absent. See the docblock: offering it is how a channel silently fails to register.
 */
const SPEAKS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/**
 * Where lore is and how to prove you may ask it — and NO NEW CONFIGURATION FOR EITHER.
 *
 * Vany, of the setup: *"can we put it into config?"* It already is. A user running lore
 * has `.mcp.json` with the url and the bearer in it, because that is how Claude Code
 * reaches lore at all. Asking them to copy both into a second place would be one more
 * pair of values to drift, and the failure when they drift is this channel silently
 * watching the wrong deployment — or, worse, watching nothing while looking healthy.
 *
 * So: an explicit env var wins if set, and otherwise the answer is read out of the
 * `.mcp.json` Claude Code already spawned this process beside. No new secret anywhere,
 * and nothing to keep in step.
 *
 * `LORE_MCP_SERVER` names which entry to read, for a setup that calls it something else.
 * The reader is deliberately tolerant of a missing file and silent about it here: what to
 * SAY when nothing was found is decided once, at the bottom of this file, where it can be
 * said in the one place the user will actually read it.
 */
interface Wire {
  readonly url: string;
  readonly token: string | undefined;
  readonly from: string;
}

function fromMcpJson(): { url?: string; token?: string } {
  const name = process.env["LORE_MCP_SERVER"] ?? "lore";
  for (const file of [resolve(process.cwd(), ".mcp.json"), resolve(process.cwd(), ".claude", "mcp.json")]) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      const entry = (JSON.parse(raw) as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> })
        .mcpServers?.[name];
      if (entry === undefined) continue;
      const auth = entry.headers?.["Authorization"] ?? entry.headers?.["authorization"];
      return {
        ...(entry.url === undefined ? {} : { url: entry.url }),
        ...(auth === undefined ? {} : { token: auth.replace(/^Bearer\s+/i, "") }),
      };
    } catch {
      // A malformed .mcp.json is the user's to fix and Claude Code will have said so
      // already; guessing at half-parsed JSON would be worse than moving on.
      continue;
    }
  }
  return {};
}

/**
 * AN EMPTY ENV VAR IS UNSET, NOT A VALUE — for the url as well as the token.
 *
 * `LORE_URL=` in a wrapper script, or an `env` block with a blank placeholder, otherwise
 * beats the url discovered from `.mcp.json` and the channel fetches `""` for ever. It
 * fails in a way that reads as an outage rather than as a configuration mistake, which is
 * the worst of both. Found by a test that set it blank to isolate the discovery path.
 */
function set(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function wire(): Wire {
  const envUrl = set("LORE_URL");
  const envToken = set("LORE_TOKEN");
  if (envUrl !== undefined && envToken !== undefined) {
    return { url: envUrl, token: envToken, from: "LORE_URL and LORE_TOKEN" };
  }
  const found = fromMcpJson();
  return {
    url: envUrl ?? found.url ?? "http://127.0.0.1:7777/mcp",
    token: envToken ?? found.token,
    from: found.token === undefined ? "no source" : `.mcp.json (server "${process.env["LORE_MCP_SERVER"] ?? "lore"}")`,
  };
}

const WIRE = wire();
const LORE_URL = WIRE.url;
const LORE_TOKEN = WIRE.token;
/**
 * How often to ask lore, in milliseconds — and a refusal to guess when the answer is not a
 * number.
 *
 * `Number("15s")` is NaN and `Number("")` is 0, and `setTimeout` coerces both to about one
 * millisecond: a silent hot loop hammering `review_inbox` for the life of the session,
 * invisible because every tick SUCCEEDS and success resets the one thing that would have
 * complained. This channel exists to be quiet enough to leave on; a misconfiguration that
 * makes it the noisiest thing on the box has to be impossible rather than unlikely.
 *
 * The floor is a second for the same reason: any value under it is a mistake whatever the
 * operator meant, and a channel is a daemon with no model attached — it gains nothing from
 * asking faster than the service can answer.
 */
export function pollInterval(raw: string | undefined): { readonly ms: number } | { readonly bad: string } {
  if (raw === undefined || raw.trim() === "") return { ms: 15_000 };
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return { bad: `LORE_CHANNEL_INTERVAL_MS is "${raw}", which is not a number of milliseconds` };
  if (ms < 1_000) return { bad: `LORE_CHANNEL_INTERVAL_MS is "${raw}"; the floor is 1000ms, and anything under it is a hot loop` };
  return { ms };
}

const INTERVAL = pollInterval(process.env["LORE_CHANNEL_INTERVAL_MS"]);
const INTERVAL_MS = "ms" in INTERVAL ? INTERVAL.ms : 15_000;

/**
 * What Claude is told about these events when the channel connects.
 *
 * This is an MCP text and carries the same obligation as `TOOL_DOCS`: it is the only way
 * an agent learns what a `<channel source="lore">` event means, so it moves with the
 * behaviour in the same change (CLAUDE.md). It says what to DO, because an event that
 * reads as news rather than as a cue is an event that changes nothing.
 */
const INSTRUCTIONS = [
  "Events from lore arrive as <channel source=\"lore\"> with attributes review_id, state and",
  "severity. They mean one of your reviews needs you NOW — lore has stopped and will not",
  "move again until you act.",
  "",
  "WHILE YOU ARE SEEING EVENTS FROM ME, do not sleep or poll on a timer. That is what this",
  "replaces: you will be woken when there is something to do, so spend your turns on the work",
  "instead of on asking whether there is any.",
  "",
  "BUT YOU CANNOT SEE WHETHER I AM STILL ALIVE, so that instruction has a condition and here",
  "is how to check it. I send one line when I start, naming how many of your reviews are open.",
  "If you never saw it, I am not running and nothing will wake you — poll as you would have",
  "without me. If you saw it but nothing since, and a review of yours has been open for longer",
  "than a round usually takes, make ONE review_inbox call rather than waiting: a channel that",
  "dies mid-session is reported to nobody, by anyone, ever. One call costs a turn; believing a",
  "dead channel costs the review.",
  "",
  "On an event, call review_poll for that review_id to collect what is new, answer the",
  "findings, and review_submit. An event saying a review is no longer open means it reached",
  "a verdict: poll it once to learn which, and review_attest a pass.",
  "",
  "An event carrying backlog=\"true\" was ALREADY waiting when this channel started — it is",
  "what an earlier session walked away from, not something that just happened. Treat it as the",
  "most urgent kind: nothing else is going to finish it.",
  "",
  "This channel reports what it observes WHILE RUNNING. It starts when your session starts, so",
  "it cannot tell you about anything that ended before that. review_inbox at the start of a",
  "session is still the rule; this only means you need not keep asking afterwards.",
].join("\n");

function write(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

/** Push one event into the session. One-way: Claude Code never acknowledges these. */
function push(content: string, meta: Record<string, string>): void {
  write({ method: "notifications/claude/channel", params: { content, meta } });
}

// ---------------------------------------------------------------- the Claude Code side

/** The Claude Code half of the protocol: one JSON-RPC message per line on stdin. */
function serve(): void {
  createInterface({ input: process.stdin }).on("line", (line) => {
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      // A malformed line is the transport's problem, not ours, and there is no id to answer
      // against. Dropping it beats exiting: a channel that dies stops every future event,
      // and nothing would say why.
      return;
    }
    const { id, method } = msg;
    if (method === "initialize") {
      const asked = (msg.params?.["protocolVersion"] as string | undefined) ?? "";
      // Echo the client's revision when we speak it, otherwise name our newest. Never
      // 2026-07-28: `SPEAKS` cannot contain it, so this line cannot return it either.
      const version = (SPEAKS as readonly string[]).includes(asked) ? asked : SPEAKS[0];
      write({
        id,
        result: {
          protocolVersion: version,
          // The presence of `claude/channel` is the entire registration. Omit it and this
          // is an ordinary MCP server whose notifications go nowhere.
          capabilities: { experimental: { "claude/channel": {} } },
          serverInfo: { name: "lore", version: "0.1.0" },
          instructions: INSTRUCTIONS,
        },
      });
      return;
    }
    if (method === "ping") {
      write({ id, result: {} });
      return;
    }
    // Notifications carry no id and want no reply; anything else with an id gets a proper
    // refusal rather than silence, so a client waiting on it is not left hanging.
    if (id !== undefined) write({ id, error: { code: -32601, message: `no method ${String(method)}` } });
  });
}

// ------------------------------------------------------------------------ the lore side

/**
 * One `tools/call` against lore.
 *
 * lore's HTTP surface is stateless — no `initialize`, no session header — verified
 * against the running service. So this is one POST, and the reply is SSE-framed even for
 * a single result, which is why the body is scanned for `data:` lines rather than parsed
 * as JSON.
 */
async function callLore(name: string): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(LORE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${LORE_TOKEN ?? ""}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
  if (!res.ok) throw new Error(`lore answered ${String(res.status)}`);
  const body = await res.text();
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = JSON.parse(line.slice(5).trim()) as { result?: { content?: { text?: string }[] } };
    const text = payload.result?.content?.[0]?.text;
    if (typeof text === "string") return JSON.parse(text) as Record<string, unknown>;
  }
  return undefined;
}

export interface Row {
  readonly review_id: string;
  readonly branch?: string;
  readonly state: string;
  readonly waiting_on?: string;
  readonly new_findings?: number;
  readonly highest?: string | null;
  /**
   * Set by the inbox when the row belongs to this PRINCIPAL but not to this TOKEN — the
   * documented rotation overlap, where a new token is minted and pasted while a review
   * started on the old one is still open (D-78).
   *
   * It is the difference between "act on this" and "you cannot act on this from here", and
   * the row is otherwise byte-identical: same `waiting_on: "you"`, same state, same count.
   * Ignoring it produced the one instruction a reader must fail at — poll, submit and attest
   * all answer NOT FOUND — which is exactly the defect the channel was built to remove.
   */
  readonly not_yours_note?: string;
}

export interface Event {
  readonly content: string;
  readonly meta: Record<string, string>;
}

/**
 * What a row has to change for an event to be worth a turn.
 *
 * Every event costs the session a turn of attention, so the bar is a CHANGE, not a state:
 * re-announcing the same waiting review every 15 seconds would be the `sleep 450` problem
 * inverted and worse. `state`, the count of uncollected findings, and whose move it is are
 * the three facts a client acts on; anything else moving is lore's business.
 */
function signature(r: Row): string {
  return `${r.state}:${String(r.new_findings ?? 0)}:${r.waiting_on ?? "?"}`;
}

/**
 * The whole decision, as a pure function of the previous snapshot and the new one.
 *
 * Kept separate from the sending so it can be tested without a transport, a socket or a
 * clock — this is the part with the judgement in it, and the part whose failure modes are
 * "said nothing when it should have" and "said the same thing forty times".
 *
 * `first` is the channel's FIRST look, and it changes two answers. A review already
 * waiting then is backlog rather than news, and says so. A review missing then never
 * ended during this session at all — there is nothing to report and no one to report it
 * to — so disappearances are only announced afterwards.
 */
export function decide(
  prev: ReadonlyMap<string, string>,
  rows: readonly Row[],
  first: boolean,
): { readonly events: readonly Event[]; readonly next: Map<string, string> } {
  const events: Event[] = [];
  const next = new Map<string, string>();

  for (const r of rows) {
    const sig = signature(r);
    const had = prev.get(r.review_id);
    next.set(r.review_id, sig);
    if (had === sig) continue;
    // Only a row that needs the CLIENT is worth waking anyone for. A review lore is still
    // working on changes signature constantly and needs nothing from the session; that is
    // the distinction `waiting_on` exists to make, and honouring it here is what keeps
    // this channel quiet enough to be left on.
    if (r.waiting_on !== "you") continue;
    const backlog = first && had === undefined;
    const n = r.new_findings ?? 0;
    // NOT YOURS TO DRIVE, AND SAYING SO BEATS BOTH ALTERNATIVES. Silence would leave a
    // review of this person's rotting with nothing anywhere mentioning it; the ordinary
    // event would send them at three calls that all answer NOT FOUND. The row is otherwise
    // identical, so this note is the only thing that distinguishes them.
    if (r.not_yours_note !== undefined && r.not_yours_note !== "") {
      events.push({
        content:
          `Review ${r.review_id}${r.branch === undefined ? "" : ` (${r.branch})`} is waiting, and YOU CANNOT` +
          ` DRIVE IT FROM HERE — it was started on a different token of yours, so review_poll,` +
          ` review_submit and review_attest will all answer NOT FOUND. lore says: ${r.not_yours_note}` +
          ` Tell your user, and drive it from the session holding the token that started it.`,
        meta: {
          review_id: r.review_id,
          state: r.state,
          severity: r.highest ?? "none",
          not_yours: "true",
          ...(backlog ? { backlog: "true" } : {}),
        },
      });
      continue;
    }
    const what =
      r.state === "needs_human"
        ? "is parked on a QUESTION only a person can settle — take it to your user, then knowledge_resolve it"
        : n > 0
          ? `has ${String(n)} finding(s) waiting to be collected — review_poll it`
          : `is stopped in ${r.state} with everything already handed over — answer it with review_submit, or review_cancel if nobody will`;
    events.push({
      content:
        `Review ${r.review_id}${r.branch === undefined ? "" : ` (${r.branch})`} ${what}.` +
        (backlog
          ? " This was ALREADY waiting when this channel started, not a change just now — it is the" +
            " backlog an earlier session left behind, and nothing else is going to finish it."
          : ""),
      meta: {
        review_id: r.review_id,
        state: r.state,
        severity: r.highest ?? "none",
        ...(backlog ? { backlog: "true" } : {}),
      },
    });
  }

  // GONE FROM THE INBOX MEANS IT REACHED A VERDICT, and that is worth saying: the inbox
  // lists OPEN reviews, so a row that vanishes has ended — passed, failed, or swept — and
  // a client that was driving it would otherwise be left waiting for an event that can
  // never come.
  if (!first) {
    for (const id of prev.keys()) {
      if (next.has(id)) continue;
      events.push({
        content:
          `Review ${id} is no longer open — it reached a verdict while you were away. review_poll it once` +
          ` to learn which, and review_attest it if it is cleared.`,
        meta: { review_id: id, state: "closed", severity: "none" },
      });
    }
  }
  return { events, next };
}

let snapshot = new Map<string, string>();
let first = true;
/** Whether the last poll failed, so an outage is reported ONCE rather than every tick. */
let complaining = false;

async function tick(): Promise<void> {
  const inbox = await callLore("review_inbox");
  const rows = (inbox?.["reviews"] as Row[] | undefined) ?? [];
  // THE ONE LINE THE INSTRUCTIONS PROMISE, sent once, on the first successful look.
  //
  // An agent cannot observe whether this process is alive, and Claude Code reports nothing
  // when a channel dies — so "do not poll while the channel is running" was an instruction
  // whose condition the reader had no way to evaluate, and a channel that died after
  // startup left a session waiting for an event that could never come. This is the anchor:
  // if it never arrived, the channel is not running. Once per session, so it cannot become
  // the noise this design exists to avoid.
  if (first) {
    push(
      `lore-channel is watching your reviews, every ${String(Math.round(INTERVAL_MS / 1000))}s.` +
        ` ${rows.length === 0 ? "None are open right now" : `${String(rows.length)} open right now`}.` +
        ` If this is the last you hear from me and a review of yours is open, call review_inbox once —` +
        ` a channel that dies mid-session is reported to nobody.`,
      { review_id: "none", state: "channel_started", severity: "none" },
    );
  }
  const { events, next } = decide(snapshot, rows, first);
  for (const e of events) push(e.content, e.meta);
  snapshot = next;
  first = false;
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      await tick();
      complaining = false;
    } catch (e) {
      // SAY IT ONCE. A channel that cannot reach lore is a real fault the user must fix,
      // and a channel that says so every 15 seconds is one they will turn off — which
      // costs them every future event too.
      if (!complaining) {
        complaining = true;
        push(
          `lore-channel cannot reach lore at ${LORE_URL}: ${e instanceof Error ? e.message : String(e)}.` +
            ` You will get no review events until this is fixed, so fall back to calling review_inbox` +
            ` yourself and tell your user.`,
          { review_id: "none", state: "channel_error", severity: "high" },
        );
      }
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

/**
 * Run only when this file IS the program, so a test can import `decide` without opening
 * stdin or starting a poll loop against whatever `LORE_URL` happens to point at.
 *
 * Compared as resolved paths rather than by suffix: a suffix test passes for any file
 * whose name merely ends the same way, which is the kind of guard that works until the
 * day it silently does not.
 */
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  serve();
  // A MISSING TOKEN IS ANNOUNCED, NOT EXITED ON. Exiting would leave Claude Code with a
  // channel that registered and then died, which the docs say fails silently — the user
  // would see nothing and believe they were covered. Registering and immediately saying
  // what is wrong puts it in the one place they are certain to read.
  if (LORE_TOKEN === undefined || LORE_TOKEN === "") {
    push(
      "lore-channel found no lore token, so it can see nothing and will send no review events. It looked" +
        " for LORE_TOKEN in its environment and for an `mcpServers." + (process.env["LORE_MCP_SERVER"] ?? "lore") +
        "` entry with an Authorization header in .mcp.json under " + process.cwd() + ". Fix whichever is" +
        " wrong and restart the session. Until then this channel is doing nothing: call review_inbox" +
        " yourself and tell your user, because they cannot see this failing from the outside.",
      { review_id: "none", state: "channel_error", severity: "high" },
    );
  } else if ("bad" in INTERVAL) {
    // ANNOUNCED AND NOT STARTED, for the same reason a missing token is: exiting would
    // leave Claude Code holding a channel that registered and then vanished, which it
    // reports to nobody. Refusing to poll is the point — the alternative this replaces was
    // a ~1ms hot loop against review_inbox that looked perfectly healthy from here.
    push(
      `lore-channel will not start: ${INTERVAL.bad}. It is sending no review events. Fix the variable and` +
        ` restart the session; until then call review_inbox yourself and tell your user.`,
      { review_id: "none", state: "channel_error", severity: "high" },
    );
  } else {
    void loop();
  }
}
