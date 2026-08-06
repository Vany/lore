/**
 * Waking a client, instead of making it ask — and only the client whose review it is.
 *
 * A review outlives an MCP request, and for the whole of this service's life the
 * answer was "the client polls" — justified by *"MCP servers cannot initiate
 * requests"* (SPEC §2). That is true about **requests** and was carrying an argument
 * it cannot support: since revision `2026-07-28` a client opens a long-lived
 * `subscriptions/listen` stream and the server pushes `notifications/resources/updated`
 * on it (`research/mcp-subscriptions.md`).
 *
 * The SDK owns the wire: acknowledgement first, per-stream filtering by URI,
 * subscription-id stamping, teardown. **It does not own authorization**, and that gap
 * is what most of this file is about — see `ScopedEventBus`.
 *
 * **One publisher, many streams.** The thing that changes a review is a background
 * worker; the thing that must tell a client is whatever HTTP exchange is holding that
 * client's subscription open. They never meet, so an event bus sits between them, and
 * both halves of the service hold the same one.
 *
 * SPEC: D-80, `spec/mcp-async.md`
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerEvent, ServerEventBus, ServerNotifier } from "@modelcontextprotocol/server";

/** The URI a client subscribes to in order to follow one review. */
export function reviewUri(reviewId: string): string {
  return `lore://review/${reviewId}`;
}

const URI_PREFIX = "lore://review/";

/** The review a `resource_updated` event is about, or `undefined` if it is not one. */
function reviewOf(uri: string): string | undefined {
  return uri.startsWith(URI_PREFIX) ? uri.slice(URI_PREFIX.length) : undefined;
}

/**
 * Tells subscribed clients that a review moved.
 *
 * Deliberately an interface rather than the SDK's notifier directly: the store and the
 * worker should not import an MCP type to say a review changed, and every test that
 * exercises the loop would otherwise have to build a transport to observe it.
 */
export interface ReviewEvents {
  /**
   * The review's STATE changed — the only thing that wakes a subscriber.
   *
   * Not findings. `Store.recordFinding` publishes nothing, deliberately: a round writes
   * its findings in one burst, and the client cannot act on any of them until the round
   * ends anyway (D-55). Publishing per finding cost N-1 wasted polls per round.
   */
  changed(reviewId: string): void;
}

/**
 * The no-op used when nothing is serving MCP — the CLI, and most tests.
 *
 * Publishing into the void is correct there and must stay silent: a review driven from
 * the CLI has no subscriber by construction, and warning about it would train a reader
 * to ignore the log that carries real faults.
 */
export const NO_EVENTS: ReviewEvents = { changed: () => {} };

/**
 * Bridge to the SDK's publish side.
 *
 * `resourceUpdated` is a no-op when no subscription is open, so this is safe to call
 * unconditionally — which matters, because the alternative is the caller deciding
 * whether anyone is listening, and a caller that guesses wrong either spams or goes
 * silent. Neither is recoverable from the outside.
 */
export function eventsFor(notify: ServerNotifier): ReviewEvents {
  return {
    changed: (reviewId) => {
      notify.resourceUpdated(reviewUri(reviewId));
    },
  };
}

// ---------------------------------------------------------------- authorization

/**
 * Who is on the other end of one subscription stream.
 *
 * `tokenHash` rather than the token: it is what the `token` table stores, it is not a
 * credential anyone can present, and it is the only thing that can answer "has this
 * been revoked since the stream opened".
 */
export interface Subscriber {
  readonly principal: string;
  readonly repoId: string;
  readonly tokenHash: string;
}

/** What the bus must be able to ask about a subscriber, without importing the store. */
export interface SubscriberChecks {
  /** The principal and repo a review belongs to, or `undefined` if there is no such review. */
  ownerOf(reviewId: string): { readonly principal: string; readonly repoId: string } | undefined;
  /** Whether the token that opened a stream is still live. */
  tokenLive(hash: string): boolean;
}

const CURRENT = new AsyncLocalStorage<Subscriber>();

/**
 * Run an MCP exchange as a known subscriber.
 *
 * The SDK's listen router calls `bus.subscribe()` from inside the request that opened
 * the stream (in the `ReadableStream`'s `start`, synchronously), and hands the bus a
 * bare callback with no identity attached. So the identity has to arrive out of band,
 * and an async-local is the only channel that survives the SDK's internals unchanged.
 *
 * `http.ts` wraps every authenticated MCP exchange in this.
 */
export function asSubscriber<T>(who: Subscriber, fn: () => T): T {
  return CURRENT.run(who, fn);
}

/**
 * A `ServerEventBus` that will not tell you about a review that is not yours.
 *
 * **The SDK's listen router authorizes nothing.** It matches an event's URI against the
 * `resourceSubscriptions` list the client asked for, and that is the whole check — so
 * with the stock in-memory bus, any authenticated client could subscribe to
 * `lore://review/<somebody else's id>` and be woken by every state change and every
 * finding on it. Not the *contents*: reading the resource still goes through `mine()`.
 * But D-23 is that **possession of a review id is never authentication**, and `mine()`
 * answers a foreign id with NOT FOUND precisely so that it cannot be used to confirm
 * an id is real. A stream that wakes on that id confirms it, and tells you when
 * somebody is working, which is the same oracle one layer along.
 *
 * The capability bit is declared once, for the SERVER, and is not a per-resource
 * decision — which is what the comment in `server.ts` says and what is easy to read
 * past.
 *
 * So delivery is filtered here, by the two facts that can change after a stream opens:
 *
 *   * **the review's owner** — checked per event rather than per subscribe, because a
 *     review's principal is fixed but a subscription may name an id that does not exist
 *     yet, and answering "no such review" by staying silent is what `mine()` does too;
 *   * **the token** — a revoked credential must actually cut access. Authentication
 *     happens once, when the exchange opens; a stream opened an hour ago would
 *     otherwise outlive the revocation of the token that opened it, and `make revoke`
 *     would be telling an operator something false.
 *
 * Every branch of that decision is tested directly in `events.test.ts` rather than over
 * a socket. A negative assertion about one client's stream needs a barrier on THAT
 * stream, and a client entitled to nothing has none — the end-to-end version of these
 * tests rested on file-descriptor servicing order and would have stayed green through a
 * regression. Raised on the round after the fix landed.
 *
 * **A foreign subscription is accepted and then silent**, because the acknowledgement
 * is written by the SDK before this bus is ever consulted and cannot be narrowed. That
 * is the one shape this project distrusts on principle — but here it is the same answer
 * `mine()` gives, for the same reason: refusing loudly would confirm the id exists.
 */
export class ScopedEventBus implements ServerEventBus {
  private readonly listeners = new Map<(event: ServerEvent) => void, Subscriber | undefined>();
  private readonly checks: SubscriberChecks;
  /** Reported, never swallowed: a listener with no identity is a wiring fault. */
  private readonly onerror: (e: Error) => void;

  // Fields declared rather than written as constructor parameters: `erasableSyntaxOnly`
  // is on, because Node runs this TypeScript directly with no build step, and parameter
  // properties are the one shorthand that cannot be erased.
  constructor(checks: SubscriberChecks, onerror?: (e: Error) => void) {
    this.checks = checks;
    this.onerror = onerror ?? ((e) => console.error(`[events] ${e.message}`));
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    // Captured HERE, not at publish time: publishing happens on a worker's stack, which
    // has no idea who is listening. This is the only moment the two are in the same
    // async context.
    this.listeners.set(listener, CURRENT.getStore());
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: ServerEvent): void {
    // Resolved once per event rather than once per listener: the owner is the same for
    // everyone, and this runs on every state change of every review.
    const reviewId = event.kind === "resource_updated" ? reviewOf(event.uri) : undefined;
    const owner = reviewId === undefined ? undefined : this.checks.ownerOf(reviewId);

    for (const [listener, who] of this.listeners) {
      if (!this.mayHear(event, owner, who)) continue;
      try {
        listener(event);
      } catch (e) {
        // One failing stream must not silence the others.
        this.onerror(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /** Open streams, for tests and introspection. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  private mayHear(
    event: ServerEvent,
    owner: { readonly principal: string; readonly repoId: string } | undefined,
    who: Subscriber | undefined,
  ): boolean {
    if (who === undefined) {
      // FAIL CLOSED, and say so. Every stream is opened through `http.ts`, which
      // authenticates first and wraps the exchange in `asSubscriber` — so this means
      // the wiring has come apart, and the safe reading of "I do not know who this is"
      // is not "tell them everything".
      this.onerror(new Error("a subscription stream has no principal attached — delivering nothing to it"));
      return false;
    }
    // We publish nothing else today. If we ever do, a list-changed event is about the
    // server rather than about anyone's data, so everyone may hear it.
    if (event.kind !== "resource_updated") return this.checks.tokenLive(who.tokenHash);
    // Unknown or foreign review: silence, exactly as `mine()` answers NOT FOUND.
    if (owner === undefined) return false;
    if (owner.principal !== who.principal || owner.repoId !== who.repoId) return false;
    return this.checks.tokenLive(who.tokenHash);
  }
}
