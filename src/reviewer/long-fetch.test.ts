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

/**
 * A CANCEL HAS TO END THE WAIT, and until 2026-08-08 nothing here was ever asked to.
 *
 * Aborting the session through opencode's own API frees opencode and does nothing to
 * this request: measured on the deployment, three sessions aborted with HTTP 200 and
 * ninety seconds later `/status` still read `inFlight: 2` with no active review at all.
 * lore waited out its full 2700s deadline for replies that could never arrive, holding
 * provider slots for reviews that no longer existed.
 */
describe("a call somebody cancelled", () => {
  it("ends when its signal fires, not when its deadline does", async () => {
    const port = await dribbling(60_000);
    const ctl = new AbortController();
    const started = Date.now();
    // A deadline far beyond the test: if the signal is ignored, this hangs rather than
    // failing fast, which is exactly how the defect presented.
    const call = longFetch(120_000)(new Request(`http://127.0.0.1:${String(port)}/`, { signal: ctl.signal }));
    setTimeout(() => ctl.abort(new Error("session ses_x was aborted by lore")), 50);

    // THE REASON TRAVELS. "aborted" alone is indistinguishable from an idle socket and a
    // blown deadline, and the caller has to tell them apart: one is a person ending a
    // review, the others are a tier failing — and `runRound` promotes a tier's work to a
    // dearer one on the strength of that difference.
    await expect(call).rejects.toThrow(/aborted by lore/);
    expect(Date.now() - started, "the signal ended it, not the 120s deadline").toBeLessThan(3000);
  });
});
