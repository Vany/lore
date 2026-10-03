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
// ceiling sums zero and guards nothing (D-50, open). This is not that ceiling: it is a
// hang detector, and the abort on every failure path is what frees the session once it
// fires.
// 45 MINUTES, AND THE NUMBER IS MEASURED RATHER THAN CHOSEN.
//
// This bounds a HANG. It is not a budget, and if it sits below a legitimate call it stops
// being a hang detector and becomes truncation — which is what 30 minutes was: the
// recorded maximum across every tier is 1851s (a t2 round on this repository), so 1800s
// was already below an observed good call and would have killed it.
//
// The distribution behind this, from `usage.latency_ms` on 2026-08-08:
//
//   | tier | n   | p50  | p90   | max   |
//   |------|-----|------|-------|-------|
//   | t1   | 129 | 322s | 590s  | 1250s |
//   | t2   | 68  | 762s | 1275s | 1851s |
//   | t3   | 22  | 147s | 1633s | 1766s |
//
// 2700s clears the observed maximum by 46%. A hang therefore costs at most 45 minutes
// where it previously cost hours — a t2 ran 2h46m before the provider refused it — and no
// call anybody has ever recorded is cut short.
//
// PER-TIER WOULD BE BETTER and is deliberately not done here: the opencode client is
// built once and shared, so it would mean a client per tier, and the numbers above are
// not yet a distribution worth splitting on for t3 (n=22). That is the same [OPEN] as the
// exploration cap — D-50 refuses a threshold set from a guess, and this one is set from
// the only thing that is not one.
export const DEFAULT_TIMEOUT_MS = 45 * 60_000;

/**
 * BOTH CALL SHAPES, because the two opencode clients disagree. The v1 SDK called
 * `fetch(request)`; the v2 client (`@opencode/client`) calls `fetch(url, init)`, and a
 * function that read only the first argument would send every v2 request as a bodiless
 * GET with no signal — a cancel that reaches nothing, the exact defect `abort` exists for.
 *
 * BUFFERED, so never hand it a stream: the response resolves only at `end`. The event
 * stream therefore goes through ordinary `fetch` (`Reviewer.events`), and this is for the
 * requests that are long but finite — `session.wait` above all.
 */
export function longFetch(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): (input: Request | string | URL, init?: RequestInit) => Promise<Response> {
  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
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
            // INSIDE A TRY, because this runs in an event handler, not in the promise: a
            // throw here is an uncaught exception that ends the whole process. It did —
            // the first v2 `session.wait` answered 204 and took lore down with it.
            try {
              const responseHeaders = new Headers();
              for (const [k, v] of Object.entries(res.headers)) {
                if (typeof v === "string") responseHeaders.set(k, v);
                else if (Array.isArray(v)) responseHeaders.set(k, v.join(", "));
              }
              const status = res.statusCode ?? 500;
              // A NULL-BODY STATUS MUST HAVE A NULL BODY: `new Response` refuses an empty
              // Buffer for 204, 205 and 304. v1 never answered with one; v2 answers 204 for
              // every empty success — wait, remove, permission reply.
              const nullBody = status === 204 || status === 205 || status === 304;
              resolve(
                new Response(nullBody ? null : Buffer.concat(chunks), {
                  status,
                  statusText: res.statusMessage ?? "",
                  headers: responseHeaders,
                }),
              );
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
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

      // CARRYING THE REASON, because "aborted" alone is indistinguishable from the two
      // other ways this request dies. A cancel, an idle socket and a blown deadline all
      // arrived at the caller as the same five characters, and the caller has to tell
      // them apart: one is a person ending a review, the others are a tier failing.
      // `AbortSignal.reason` is what the aborter passed, so it says which.
      const why = (): Error => {
        const r: unknown = request.signal.reason;
        return r instanceof Error ? r : new Error(typeof r === "string" && r !== "" ? r : "aborted");
      };
      if (request.signal.aborted) req.destroy(why());
      else request.signal.addEventListener("abort", () => req.destroy(why()), { once: true });

      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}
