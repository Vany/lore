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
import { type SpendConfig, spendByTier, startOfDayIso } from "../ops/spend.ts";
import { checkHealth, type HeartbeatConfig } from "../ops/heartbeat.ts";
import type { GateState } from "../reviewer/gate.ts";
import type { Store } from "../store/store.ts";

export interface HttpConfig {
  readonly port: number;
  readonly host: string;
  readonly heartbeat: HeartbeatConfig;
  /** So /status can report the ceiling — and whether it is capable of firing. */
  readonly spend: SpendConfig;
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

  const server = createServer((req, res) => {
    void handle(store, cfg, serveMcp, req, res).catch((e: unknown) => {
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
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

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
          // A ceiling that CANNOT fire must say so. Both providers are subscriptions,
          // so every usage row carries cost_usd = 0 and `spendToday: 0` against a $100
          // ceiling reads as headroom when it actually means "nothing here measures
          // spending". Opposite facts, identical in a dashboard.
          spend_ceiling: {
            usd: cfg.spend.dailyCeilingUsd,
            metered: store.hasMeteredUsage(),
            ...(store.hasMeteredUsage()
              ? {}
              : {
                  note:
                    "INERT: no model call has ever reported a cost, because these providers bill a flat " +
                    "subscription. This ceiling cannot fire. Read `spendToday: 0` as unmeasured, not as headroom.",
                }),
          },
          // Findings produced and never collected. 18 sat unread for hours, 14 of
          // them high — the review reached findings_ready and nothing ever polled it.
          // A finding nobody reads is a review that did not run, one step later.
          // Two bounds, two resources. `queueDepth` counts rounds waiting for a
          // worker (local, CPU-bound); this counts rounds holding a worker and
          // waiting for a model slot (remote). One knob used to govern both and was
          // therefore wrong for one of them — at 12 it killed four reviews in 2.5
          // minutes, and neither the host nor the container could show why.
          ...(cfg.modelGate === undefined ? {} : { model_calls: cfg.modelGate() }),
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
