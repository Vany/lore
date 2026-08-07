/**
 * What lore serves when its database is unreadable.
 *
 * **A service that cannot do its job must SAY so, and it can only say anything if it
 * is still there.** On 2026-08-08 the database became malformed while a review was
 * running; `reclaimOrphanedJobs` threw at startup, `main()` exited 70, Docker restarted
 * it, and that loop would have run for ever. Every second of it, `/status` — the one
 * endpoint whose entire purpose is answering *am I healthy* — was a refused connection,
 * which is indistinguishable from the machine being off, the port having moved, or
 * Docker being broken.
 *
 * The heartbeat DOES check integrity on every beat, added the day before after the same
 * fault went unnoticed for twenty minutes. It was no use here, and the reason is exact:
 * it only runs while the service is healthy enough to run it. A database bad enough to
 * kill startup kills the check that would have reported it — INV-1 one layer up, where
 * the thing that did not run is the thing that says whether things ran.
 *
 * So: no worker, no heartbeat, no sweep — nothing that could write another byte into a
 * damaged file — and an HTTP server that answers every request with the fault and the
 * remedy. `ok: false` with a cause an operator can act on in five seconds, instead of a
 * twenty-minute diagnosis that starts with "is it even running".
 *
 * It does NOT exit and it does NOT retry. A malformed database is not transient; the
 * next open finds the same thing, and a crash-loop's only effect is to destroy the
 * evidence in the logs. Somebody has to restore it, and this text tells them how.
 *
 * SPEC: spec/operations.md §2.4, INV-1
 */

import { createServer, type Server } from "node:http";

export interface RefusingConfig {
  readonly port: number;
  readonly bind: string;
  readonly dbPath: string;
  /** What SQLite actually said. Quoted verbatim: a paraphrase is a second diagnosis. */
  readonly fault: string;
}

/**
 * The whole message, in one place, because it is served from three routes and read by
 * two audiences — a person running `curl`, and an agent that will repeat it to its user.
 */
export function refusalText(cfg: RefusingConfig): string {
  return [
    `lore is NOT serving: its database at ${cfg.dbPath} cannot be read — ${cfg.fault}.`,
    "",
    "NOTHING was reviewed and nothing is queued. Every review handle is unreachable; none of them",
    "passed, and none of them found nothing.",
    "",
    "This is not transient and lore will not retry: a malformed database is malformed on the next",
    "open too, and restarting only overwrites the evidence. A person must restore it:",
    "",
    "    make backup-check      # is the replica itself sound, or a faithful copy of the damage",
    "    make restore           # overwrite the database from the newest sound replica",
    "",
    "The worker, the heartbeat and the retention sweep are all stopped, deliberately — writing",
    "into a damaged file is how a recoverable fault becomes an unrecoverable one.",
  ].join("\n");
}

/**
 * Serve the refusal until somebody fixes it.
 *
 * 503 on every route, including `/mcp`: a client that gets a 200 with an error body will
 * often carry on. `/status` is JSON because that is its contract and a monitor parses it;
 * everything else is the plain text above.
 */
export function serveRefusing(cfg: RefusingConfig): { readonly server: Server; readonly stop: () => void } {
  const text = refusalText(cfg);

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/status") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          // The SAME key the healthy path uses, so a monitor watching `problems` sees
          // this without being taught a second shape.
          problems: [`DATABASE UNREADABLE: ${cfg.fault}`],
          serving: false,
          remedy: "make backup-check, then make restore",
          detail: text,
          build: {
            commit: process.env["LORE_COMMIT"] ?? "unknown",
            built_at: process.env["LORE_BUILT_AT"] ?? "unknown",
          },
          at: new Date().toISOString(),
        }),
      );
      return;
    }
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  });

  server.listen(cfg.port, cfg.bind);
  // Loud on the way up, once. The operator's first move after a restart is the logs.
  console.error(`lore: REFUSING TO SERVE — ${cfg.fault}\n${text}`);

  return {
    server,
    stop: () => {
      server.close();
    },
  };
}
