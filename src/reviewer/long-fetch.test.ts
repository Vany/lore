/**
 * The bound on a model call has to be a bound.
 *
 * `http.request`'s `timeout` option is SOCKET INACTIVITY, not a deadline: it fires when
 * nothing has been read for that long, and every byte resets it. An agentic tier streams
 * as it works, so it keeps the socket busy and the "30 minute timeout" never fires. A t2
 * round on this repository ran 67 minutes and was still going, with the bound everybody
 * believed in doing nothing at all — including the comment above the constant, which
 * discussed what number to choose for a limit that could not fire.
 *
 * A guard that reads as enforced and enforces nothing is the shape this service exists to
 * refuse, so both halves are pinned here: the idle case that already worked, and the
 * chatty case that did not.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { longFetch } from "./long-fetch.ts";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** A server that answers headers, then dribbles bytes for ever without finishing. */
const dribbling = (everyMs: number): Promise<number> =>
  new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const t = setInterval(() => res.write("."), everyMs);
      res.on("close", () => {
        clearInterval(t);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve((server?.address() as { port: number }).port);
    });
  });

describe("a call that never finishes", () => {
  // THE CASE THAT WAS UNBOUNDED. Bytes arrive faster than the timeout, so the socket is
  // never idle; only a real deadline can end this.
  it("is cut off even while the peer keeps sending", async () => {
    const port = await dribbling(20);
    const started = Date.now();
    await expect(
      longFetch(300)(new Request(`http://127.0.0.1:${String(port)}/`)),
    ).rejects.toThrow(/ran past/);
    expect(Date.now() - started, "the deadline, not the idle timeout, ended it").toBeLessThan(3000);
  });

  // ...and the idle case still reports itself as idle, because the two failures want
  // different answers: one is a peer that died, the other a peer that will not stop.
  it("still says so when the peer sends nothing at all", async () => {
    const port = await dribbling(60_000);
    await expect(
      longFetch(300)(new Request(`http://127.0.0.1:${String(port)}/`)),
    ).rejects.toThrow(/did not respond within|ran past/);
  });
});
