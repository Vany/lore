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
import { authenticate } from "../mcp/auth.ts";
import { buildServer, type ServerDeps } from "../mcp/server.ts";
import { spendByTier, startOfDayIso } from "../ops/spend.ts";
import { checkHealth, type HeartbeatConfig } from "../ops/heartbeat.ts";
import type { Store } from "../store/store.ts";

export interface HttpConfig {
  readonly port: number;
  readonly host: string;
  readonly heartbeat: HeartbeatConfig;
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
          spend_today_by_tier: spendByTier(store, startOfDayIso()),
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

function activeReviews(store: Store): unknown {
  return store.db
    .prepare(
      `SELECT id, branch, state, type, updated_at FROM review
       WHERE state NOT IN ('passed', 'failed', 'expired')
       ORDER BY updated_at DESC LIMIT 50`,
    )
    .all();
}
