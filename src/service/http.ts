/**
 * The HTTP host: MCP over Streamable HTTP, plus the operator view.
 *
 * Behind Tailscale, so no public TLS, no domain and no abuse surface — WireGuard
 * is the transport security (D-33). Bearer tokens remain, for **scoping** rather
 * than perimeter: two teammates on one tailnet still must not read each other's
 * repos.
 *
 * A fresh MCP server is built per request, bound to the authenticated principal.
 * That is slightly wasteful and entirely worth it: there is then no code path in
 * which a handler could serve a review belonging to someone else.
 *
 * The *handler* around those servers is built once, because it owns the subscription
 * bus (D-80). See `startHttp`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type NodeIncomingMessageLike,
  type NodeMcpRequestHandler,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { type AuthInfo, createMcpHandler, type McpRequestContext } from "@modelcontextprotocol/server";
import { authenticate, type Principal } from "../mcp/auth.ts";
import { asSubscriber, eventsFor, NO_EVENTS, ScopedEventBus } from "../mcp/events.ts";
import { buildServer, type ServerDeps } from "../mcp/server.ts";
import { decide } from "../knowledge/decide.ts";
import { board } from "../ops/board.ts";
import { configView } from "../ops/config-view.ts";
import { spendByTier, startOfDayIso } from "../ops/spend.ts";
import { checkHealth, type HeartbeatConfig } from "../ops/heartbeat.ts";
import type { GateState } from "../reviewer/gate.ts";
import type { Store } from "../store/store.ts";
import { BOARD_PAGE } from "./board-page.ts";
import { type BoardStream, startBoardStream } from "./board-stream.ts";

export interface HttpConfig {
  readonly port: number;
  readonly host: string;
  readonly heartbeat: HeartbeatConfig;
  /** Whether metered fallback routes may be used (D-117) — reported by `/status`. */
  readonly allowMetered: boolean;
  /**
   * The model-call gate, so `/status` can answer D-26 for the REMOTE half too.
   *
   * "Is parallelism actually running, or silently queueing?" was answerable only for
   * the local half, because nothing queued on the remote one — over the limit, calls
   * did not wait, they died. Now they wait, and waiting is invisible from outside
   * unless it is reported.
   */
  readonly modelGate?: () => GateState;
}

/**
 * Bind, and wire the subscription bus to the store.
 *
 * The MCP handler is built ONCE for the process, unlike the servers inside it. It
 * owns the `subscriptions/listen` router — the thing holding a client's notification
 * stream open — and a handler per request could not: the stream would die with the
 * exchange that opened it, which is the whole feature (D-80).
 *
 * `store.events` is set here rather than by the caller, on purpose. A review changes
 * in a background worker and the client that must hear about it is parked on an HTTP
 * stream; the bus is the only thing joining them, and if this wiring is a step someone
 * can forget, the failure is silent — reviews complete, subscribers wait forever, and
 * nothing anywhere reports a fault. So the step is not separable from starting the
 * server that serves the streams.
 */
export function startHttp(store: Store, deps: ServerDeps, cfg: HttpConfig): { close: () => void } {
  const mcp = createMcpHandler((ctx) => buildServer(principalOf(ctx), deps), {
    // OUR bus, not the SDK's default one. The listen router authorizes nothing — it
    // matches URIs against what the client asked for — so the ownership check has to
    // live on the delivery side or not at all. `ScopedEventBus` carries the argument.
    bus: new ScopedEventBus({
      ownerOf: (reviewId) => store.ownerOf(reviewId),
      tokenLive: (hash) => store.tokenLive(hash),
    }),
    // Report-only, per the SDK: this never changes a response. It exists so that a
    // rejected or malformed exchange leaves a trace — the alternative is a client
    // seeing a bare error and this side having nothing at all to correlate it with.
    onerror: (e) => console.error(`[mcp] ${e.message}`),
  });
  const serveMcp = toNodeHandler(mcp, {
    onerror: (e) => console.error(`[mcp:node] ${e.message}`),
  });

  store.events = eventsFor(mcp.notify);

  // Built once and owned here, for the same reason the MCP handler is: it holds open
  // response streams, so it cannot be per-request, and its timer must die with the server.
  const boardStream = startBoardStream(store, undefined, undefined, cfg.modelGate);

  const server = createServer((req, res) => {
    void handle(store, cfg, serveMcp, boardStream, req, res).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    });
  });
  server.listen(cfg.port, cfg.host);
  return {
    close: () => {
      server.close();
      // Aborts in-flight exchanges, including every open subscription stream. A
      // client blocked on one learns the service went away instead of hanging.
      void mcp.close();
      // Same argument, for the other kind of held-open stream: a board watcher is told
      // the service went away rather than left holding a socket that will never speak.
      boardStream.close();
      // Nothing is listening once the handler is shut; publishing into a closed
      // handler is a no-op either way, but a store that outlives its server should
      // not keep a reference to it.
      store.events = NO_EVENTS;
    },
  };
}

/**
 * The principal an instance is built for, recovered from the pass-through `authInfo`.
 *
 * The handler performs no authentication of its own — `handle` does it, and hands the
 * result down through `req.auth`. This function is the far end of that hand-off, and
 * it throws rather than defaulting: an instance built for nobody would answer
 * `store.getReview(id, "")` for every caller, which is the one thing D-23 exists to
 * make impossible.
 */
function principalOf(ctx: McpRequestContext): Principal {
  const repoId = ctx.authInfo?.extra?.["repoId"];
  const tokenHash = ctx.authInfo?.extra?.["tokenHash"];
  if (ctx.authInfo === undefined || typeof repoId !== "string" || typeof tokenHash !== "string") {
    throw new Error("internal: MCP instance requested without an authenticated principal");
  }
  return { principal: ctx.authInfo.clientId, repoId, tokenHash };
}

/**
 * The authenticated principal, in the shape the SDK passes through.
 *
 * `token` is deliberately empty. The field is required by `AuthInfo`, and nothing
 * downstream needs the secret — while a credential copied into a struct that travels
 * through the transport is a credential in every stack trace and error report that
 * struct ever appears in. The principal's NAME is the identity here; the token is only
 * ever the thing that proved it, once, in `handle`.
 */
function authInfoFor(who: Principal): AuthInfo {
  return {
    token: "",
    clientId: who.principal,
    scopes: [],
    extra: { repoId: who.repoId, tokenHash: who.tokenHash },
  };
}

async function handle(
  store: Store,
  cfg: HttpConfig,
  serveMcp: NodeMcpRequestHandler,
  boardStream: BoardStream,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // THE OPERATOR BOARD (D-96): the same question `/status` answers, for a person rather
  // than a monitor — what is running, how long it has been running, and how long since it
  // last moved.
  //
  // UNAUTHENTICATED, ON THE SAME INTERFACE AS MCP, ON PURPOSE — Vany's call, made knowing
  // that `LORE_BIND` is `0.0.0.0` and this therefore answers to everyone on the tailnet.
  // `/status` has always exposed the same branch names and counts to the same audience, so
  // this widens who can see it comfortably rather than who can see it at all. What it
  // deliberately does NOT carry is finding TEXT: a claim names a defect in somebody's
  // unmerged branch, and that is theirs to hand out, not ours to publish.
  if (url.pathname === "/" || url.pathname === "/board") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(BOARD_PAGE);
    return;
  }

  if (url.pathname === "/board/events") {
    boardStream.add(res);
    return;
  }

  // THE ONE THING THE BOARD CAN CHANGE (D-99): a person settling the contradiction that
  // has a review parked on `needs_human`.
  //
  // REACHABLE WHEREVER THE PAGE IS, which is the tailnet, and that is a deliberate choice
  // rather than an oversight. D-33 makes WireGuard the perimeter and bearer tokens the
  // SCOPING mechanism; `/status` has always answered to the same audience. The obvious
  // tightening — loopback only — was written first and then removed, because inside a
  // container a browser's request arrives from the docker gateway rather than `127.0.0.1`:
  // it would have refused every real use of the button while looking like security.
  //
  // WHAT IT COSTS IS THE NAME. This endpoint carries no credential, so the decision is
  // recorded as taken on the board by somebody unnamed. `knowledge_resolve` over MCP
  // records WHO, and a teammate who wants their decision attributed should use it. The
  // reason string says which of the two happened, because the knowledge base outlives
  // everyone who edits it and "resolved" with no author is a fact nobody can weigh later.
  if (url.pathname === "/board/decide") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ error: "use POST" }));
      return;
    }
    const body = JSON.parse(await readBody(req)) as {
      repo_id?: string;
      keep?: string;
      retire?: string;
      reason?: string;
    };
    if (!body.repo_id || !body.keep || !body.retire) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "repo_id, keep and retire are all required" }));
      return;
    }
    const outcome = decide(store, {
      repoId: body.repo_id,
      keep: body.keep,
      retire: body.retire,
      // The button's own words when the operator adds nothing. Recorded verbatim and
      // outlives both of us, so it says what happened rather than "resolved".
      reason: body.reason?.trim() || "chosen on the operator board",
      // HONEST ABOUT WHAT IS AND IS NOT KNOWN. A person pressed it; the page holds no
      // credential, so which person is not recoverable. Saying "a person" and naming the
      // route lets a later reader weigh the decision — and tells them where to look for
      // an attributed one.
      by: "a person on the operator board (no credential, so no name recorded)",
    });
    res.writeHead(outcome.resolved ? 200 : 409, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        outcome.resolved
          ? outcome
          : { ...outcome, error: "no open conflict between those two statements — it may already be settled" },
      ),
    );
    return;
  }

  // THE SHAPE OF THIS DEPLOYMENT (D-118), for a person and for a script.
  //
  // The knobs that decide what runs and what it costs live in a `.env` nobody reads, a
  // JSON file on the host, and `make` targets one person runs — so the answer to "why did
  // this cost $101.36" was one variable that nothing anywhere displayed. Read-only, and
  // each row says how to change it; see `ops/config-view.ts` for why writing is not here.
  if (url.pathname === "/config.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(configView(), null, 2));
    return;
  }

  // The same snapshot the page renders, for anything that would rather read JSON once
  // than hold a stream open — `curl`, a script, or me at a prompt.
  if (url.pathname === "/board.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(board(store, Date.now(), cfg.modelGate), null, 2));
    return;
  }

  // The operator view (D-26). Answers one question: is parallelism actually
  // running, or silently queueing? Those look identical from outside, and only one
  // of them is fine.
  if (url.pathname === "/status") {
    const health = await checkHealth(store, cfg.heartbeat);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        {
          ...health,
          // WHICH CODE IS RUNNING. The deployment ran 21 commits behind for three
          // hours while this endpoint said ok: true, and nothing here distinguished
          // that from being current. "unknown" is what an unstamped build says,
          // rather than something plausible.
          build: {
            commit: process.env["LORE_COMMIT"] ?? "unknown",
            built_at: process.env["LORE_BUILT_AT"] ?? "unknown",
          },
          // Visible without a terminal: a drained service looks idle from outside,
          // and "nothing to do" and "refusing to take work" are opposite facts.
          draining: store.isDraining(),
          spend_today_by_tier: spendByTier(store, startOfDayIso()),
          // WHAT THE MONEY CAN DO, WHICH IS THE ONLY REMAINING MONEY DECISION (D-117).
          //
          // This used to be `spend_ceiling`, and reporting it taught an operator that a
          // dollar figure bounded the day. None does (D-121): `spendToday` above is a
          // reading, and nothing branches on it. What CAN be refused is a route that bills
          // per call, and that is a yes/no a person set — so it is the yes/no reported.
          //
          // Stays in the payload when false, because a key that disappears in the safe
          // case teaches a monitor to ignore its absence, and this is the field that says
          // whether an outage will cost money or coverage.
          allow_metered: cfg.allowMetered,
          // Findings produced and never collected. 18 sat unread for hours, 14 of
          // them high — the review reached findings_ready and nothing ever polled it.
          // A finding nobody reads is a review that did not run, one step later.
          // Two bounds, two resources. `queueDepth` counts rounds waiting for a
          // worker (local, CPU-bound); this counts rounds holding a worker and
          // waiting for a model slot (remote). One knob used to govern both and was
          // therefore wrong for one of them — at 12 it killed four reviews in 2.5
          // minutes, and neither the host nor the container could show why.
          ...(cfg.modelGate === undefined ? {} : { model_calls: cfg.modelGate() }),
          // A PROVIDER LORE HAS STOPPED CALLING (D-90). The one condition that makes
          // every review below slower and that nothing here could report: a tier stops
          // answering, lore backs off, and from outside the service just looks sluggish.
          // Empty is the healthy case and stays in the payload, because a key that
          // disappears when things are fine teaches a monitor to ignore its absence.
          // `stated` on each entry, because the two marks are not the same claim. A time
          // the PROVIDER named stops reviews calling that tier; a backoff lore guessed
          // bounds only the background screen, and reviews go on asking normally. A
          // monitor reading the name alone would report degraded coverage that is not
          // happening — which is why the flag travels rather than the reader inferring.
          tiers_not_being_asked: store.unavailableTiers(new Date().toISOString()),
          uncollected: uncollectedFindings(store),
          active: activeReviews(store),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const who = authenticate(store, req.headers.authorization);
  if (who === undefined) {
    // Per RFC 6750 / the MCP authorization spec: say what is required, in a header,
    // and never accept a credential from the query string.
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="lore"',
    });
    res.end(JSON.stringify({ error: "missing or invalid bearer token" }));
    return;
  }

  // The per-principal server is still per request: the adapter forwards `req.auth`
  // into the factory, which builds an instance for exactly this principal. The
  // guarantee that no instance can reach someone else's review is unchanged — only
  // the object that routes to it is now shared.
  //
  // The cast is structural, not a lie: the adapter takes a duck-typed request so it
  // can stay free of `node:` imports, and under `exactOptionalPropertyTypes` its
  // `method?: string` and Node's `method: string | undefined` are different types
  // for the same runtime value.
  const carrier = req as unknown as NodeIncomingMessageLike;
  carrier.auth = authInfoFor(who);
  // `asSubscriber` is the OTHER half of the identity hand-off, and it exists because
  // the SDK's listen router hands the bus a bare callback: a `subscriptions/listen`
  // stream registers itself from inside this call, and this is the only moment where
  // the stream and the principal that opened it are in the same async context.
  await asSubscriber(who, () => serveMcp(carrier, res));
}

/** The whole request body, bounded — a decision is three short ids. */
async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A body that keeps coming is not a decision; refusing beats buffering it.
    if (size > limit) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reviews holding findings nobody has fetched, oldest first.
 *
 * `delivered_at` already recorded this per finding; nothing ever asked. The age is
 * what makes it actionable — a finding undelivered for a minute is a poll in flight,
 * one undelivered for six hours is a client that walked away.
 */
function uncollectedFindings(store: Store): unknown {
  return store.uncollectedByReview();
}

function activeReviews(store: Store): unknown {
  return store.reviewsUnfinished();
}
