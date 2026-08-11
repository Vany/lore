/**
 * Server-sent events for the operator board: one timer, many watchers.
 *
 * **Why a timer rather than the event bus.** `store.events` fires on review STATE changes
 * only, and deliberately so — its comment argues that a notification per non-event teaches
 * a client to ignore the stream. But this board's whole job is the things that happen
 * BETWEEN state changes: a tier opening, a tier closing, findings landing, a queue
 * draining. Wiring operator-grade events into every one of those write paths is a large
 * change with a silent failure mode — miss one and the board is quietly stale, which is
 * the exact class of bug this service exists to refuse. A poll cannot miss anything.
 *
 * It costs a handful of indexed queries every couple of seconds, and only while somebody
 * is watching: the timer starts with the first watcher and stops with the last, so an
 * unattended service does no work for a board nobody has open.
 *
 * **Nothing is sent unless something changed.** The payload is compared with the last one
 * as a string; equal means no write. So an idle board holds an open socket and transfers
 * nothing, and every arriving message means the picture genuinely moved. The elapsed
 * clocks animate in the browser from absolute timestamps — see `board-page.ts`.
 *
 * SPEC: spec/operations.md §2.4
 */

import type { ServerResponse } from "node:http";
import { board } from "../ops/board.ts";
import type { Store } from "../store/store.ts";

/** How often the snapshot is recomputed while at least one board is open. */
export const BOARD_POLL_MS = 2_000;

/**
 * How often to write a comment frame into an idle stream.
 *
 * Not for the browser — `EventSource` notices a closed socket by itself. It is for
 * anything between us and it that reaps quiet connections, and for the operator case this
 * is built around: a laptop that slept for an hour should find out its board is stale by
 * failing to receive, rather than by showing hour-old numbers with confidence.
 */
export const BOARD_HEARTBEAT_MS = 15_000;

export interface BoardStream {
  /** Attach a watcher. The response is left open until the client goes away. */
  add: (res: ServerResponse) => void;
  /** How many watchers are attached — for tests, and for `/status` if it ever asks. */
  watchers: () => number;
  close: () => void;
}

export function startBoardStream(
  store: Store,
  pollMs = BOARD_POLL_MS,
  heartbeatMs = BOARD_HEARTBEAT_MS,
): BoardStream {
  const watchers = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | undefined;
  let last = "";
  let sinceHeartbeat = 0;

  const write = (res: ServerResponse, frame: string): void => {
    // A watcher whose socket has gone is not an error worth propagating: the tick that
    // found it is serving every OTHER watcher, and throwing here would take them all down
    // because one laptop closed its lid.
    try {
      res.write(frame);
    } catch {
      drop(res);
    }
  };

  const drop = (res: ServerResponse): void => {
    watchers.delete(res);
    if (watchers.size === 0) stop();
  };

  const tick = (): void => {
    const payload = JSON.stringify(board(store));
    sinceHeartbeat += pollMs;
    if (payload === last) {
      if (sinceHeartbeat < heartbeatMs) return;
      sinceHeartbeat = 0;
      // A comment frame: legal SSE, ignored by the client, and enough to prove the socket
      // is still ours.
      for (const res of [...watchers]) write(res, ": still here\n\n");
      return;
    }
    last = payload;
    sinceHeartbeat = 0;
    const frame = `data: ${payload}\n\n`;
    for (const res of [...watchers]) write(res, frame);
  };

  const start = (): void => {
    if (timer !== undefined) return;
    // `unref` so an open board can never be the reason this process refuses to exit. A
    // test that forgot to close would hang for its full timeout and blame the wrong thing.
    timer = setInterval(tick, pollMs);
    timer.unref?.();
  };

  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    // Forgotten deliberately: the next watcher must be sent the current picture, and a
    // retained `last` would suppress that first frame whenever nothing had changed while
    // nobody was looking.
    last = "";
  };

  return {
    add: (res: ServerResponse) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Named for nginx, harmless elsewhere: proxy buffering turns a push stream into a
        // stream that arrives in one lump when it ends, which is indistinguishable from
        // the server never sending anything.
        "x-accel-buffering": "no",
      });
      watchers.add(res);
      res.on("close", () => drop(res));
      // IMMEDIATELY, because a stream carries no history. The same lesson as MCP
      // subscriptions: a watcher that attached one tick after something happened would
      // otherwise sit in front of a blank board until the next change, however long that
      // takes — and on a quiet service that is for ever.
      const payload = JSON.stringify(board(store));
      last = payload;
      sinceHeartbeat = 0;
      write(res, `data: ${payload}\n\n`);
      start();
    },
    watchers: () => watchers.size,
    close: () => {
      stop();
      for (const res of [...watchers]) {
        watchers.delete(res);
        try {
          res.end();
        } catch {
          // Already gone; there is nothing to close and nothing to report.
        }
      }
    },
  };
}
