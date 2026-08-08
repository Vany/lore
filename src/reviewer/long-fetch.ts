/**
 * A `fetch` that will wait as long as a model takes.
 *
 * Node's built-in fetch is undici, whose `headersTimeout` and `bodyTimeout`
 * default to **300 seconds**. An agentic review routinely exceeds that: the first
 * live T1 call took 254 s, and T2 at high effort went past the limit and surfaced
 * as a bare `fetch failed` — no status, no message, nothing pointing at a timeout.
 *
 * undici is not importable from Node core, so the dispatcher cannot simply be
 * reconfigured. `node:http` has no such default and gives us the timeout we
 * actually want: one we choose, applied deliberately.
 *
 * Only for talking to opencode on the loopback interface. Everything else in the
 * codebase uses ordinary `fetch`, where 300 s is a sensible ceiling.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Long enough for the slowest tier on the slowest host, short enough that a
 * genuinely stuck call is not held forever.
 *
 * A hung request otherwise occupies a review slot indefinitely and reads as a slow
 * review rather than a stuck one — the same failure the T0 sandbox timeout exists
 * to prevent.
 */
// lore-ok[8d7e827d]: the finding is that 30 minutes is excessive and lets a stuck
// model burn budget. The number is set from measurement, not comfort: the longest
// legitimate T1 call observed on the deployment is 1006 s reviewing this repo whole,
// and the predecessor's GLM review took 82 agentic turns.
//
// CORRECTED, hours after this comment first claimed 1.8x headroom. That arithmetic
// used 30 min while the BINDING limit was `DEFAULT_REVIEWER.timeoutMs` at 20 min —
// two timeouts, the shorter winning silently, and a comment confidently reasoning
// about the wrong one. Real headroom over 1006 s was 1.19x, and the next run crossed
// it: "opencode did not respond within 1200s". They are now one constant, this one.
//
// Cutting it kills reviews that were working; raising it because reviews got slower
// is a treadmill. The honest reading of the failure is that a whole-repo diff is at
// the edge of what T1 can do, not that the number is wrong.
//
// The "wastes spend ceiling budget" half does not hold today for a more embarrassing
// reason: both configured vendors are subscriptions reporting cost_usd = 0, so the
// ceiling sums zero and guards nothing (D-50, open). A shorter timeout would not
// protect a budget nothing is measuring.
//
// What DOES bound a stuck call is the abort on every failure path, added after three
// abandoned T2 calls kept exploring and consumed ~3.7M cache-read tokens. Revisit
// this number when usage.steps has a distribution behind it — that is the same
// [OPEN] as the exploration cap, and setting either from a guess is what D-50
// exists to refuse.
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export function longFetch(timeoutMs = DEFAULT_TIMEOUT_MS): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();

    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

    const send = url.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<Response>((resolve, reject) => {
      const req = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") responseHeaders.set(k, v);
              else if (Array.isArray(v)) responseHeaders.set(k, v.join(", "));
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 500,
                statusText: res.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          });
          res.on("error", reject);
        },
      );

      // Distinguishable from a transport failure on purpose. "fetch failed" told us
      // nothing; this says which limit was hit and how long it waited.
      req.on("timeout", () => {
        req.destroy(new Error(`opencode did not respond within ${Math.round(timeoutMs / 1000)}s`));
      });

      // AND A REAL DEADLINE, because the option above is not one.
      //
      // `http.request`'s `timeout` is SOCKET INACTIVITY: it fires when nothing has been
      // read for that long, and every byte resets it. An agentic tier streams as it
      // works, so it keeps the socket busy and the "30 minute timeout" never fires — a
      // t2 round on this repository ran 67 minutes and was still going, with the bound
      // everybody believed in doing nothing at all.
      //
      // That is the exact shape this service exists to refuse: a guard that reads as
      // enforced and enforces nothing. The deadline below is the bound the constant has
      // always claimed to be.
      const deadline = setTimeout(() => {
        req.destroy(new Error(`opencode ran past ${Math.round(timeoutMs / 1000)}s without finishing`));
      }, timeoutMs);
      // `unref` so a pending deadline cannot hold the process open past its work.
      deadline.unref?.();
      const done = (): void => {
        clearTimeout(deadline);
      };
      req.on("close", done);

      req.on("error", reject);

      if (request.signal.aborted) req.destroy(new Error("aborted"));
      else request.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });

      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}
