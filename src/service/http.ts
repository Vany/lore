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
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { TERMINAL_SQL } from "../core/review-state.ts";
import { authenticate } from "../mcp/auth.ts";
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

export function startHttp(store: Store, deps: ServerDeps, cfg: HttpConfig): { close: () => void } {
  const server = createServer((req, res) => {
    void handle(store, deps, cfg, req, res).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    });
  });
  server.listen(cfg.port, cfg.host);
  return { close: () => server.close() };
}

async function handle(
  store: Store,
  deps: ServerDeps,
  cfg: HttpConfig,
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

  const mcp = buildServer(who, deps);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}

/**
 * Reviews holding findings nobody has fetched, oldest first.
 *
 * `delivered_at` already recorded this per finding; nothing ever asked. The age is
 * what makes it actionable — a finding undelivered for a minute is a poll in flight,
 * one undelivered for six hours is a client that walked away.
 */
function uncollectedFindings(store: Store): unknown {
  return store.db
    .prepare(
      `SELECT r.id, r.branch,
              COUNT(*) AS undelivered,
              SUM(CASE WHEN f.severity = 'high' THEN 1 ELSE 0 END) AS high,
              MIN(f.first_seen) AS waiting_since
       FROM finding f JOIN review r ON r.id = f.review_id
       WHERE f.delivered_at IS NULL
       GROUP BY r.id, r.branch
       ORDER BY waiting_since`,
    )
    .all();
}

function activeReviews(store: Store): unknown {
  return store.db
    .prepare(
      `SELECT id, branch, state, type, updated_at FROM review
       WHERE state NOT IN (${TERMINAL_SQL})
       ORDER BY updated_at DESC LIMIT 50`,
    )
    .all();
}
