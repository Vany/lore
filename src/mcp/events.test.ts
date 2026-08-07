/**
 * Who may hear about a review, decided without a socket.
 *
 * `subscribe.test.ts` proves the wire; this proves the DECISION. The two are separate
 * on purpose, and the reason is a finding raised against the end-to-end version: a
 * negative assertion about one client's stream needs a barrier on THAT stream, and a
 * client entitled to nothing has none. Both frames are written inside the same
 * synchronous publish, so "the other client heard something" says nothing about
 * whether this one did — it rests on which file descriptor the event loop services
 * first. That is not determinism, it is a coin that has been landing the right way.
 *
 * So every negative here is a direct call: publish, and look at what the listener was
 * handed. No transport, no ordering, nothing to get lucky about.
 *
 * SPEC: D-23, D-80, `spec/mcp-api.md` §2.0.2
 */

import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@modelcontextprotocol/server";
import { asSubscriber, reviewUri, ScopedEventBus, type Subscriber, type SubscriberChecks } from "./events.ts";

const ALICE: Subscriber = { principal: "alice", repoId: "repo-a", tokenHash: "hash-alice" };
const BOB: Subscriber = { principal: "bob", repoId: "repo-b", tokenHash: "hash-bob" };

/** A store stand-in: alice owns `revA`, bob owns `revB`, and `hash-dead` is revoked. */
const CHECKS: SubscriberChecks = {
  ownerOf: (id) =>
    id === "revA"
      ? { principal: "alice", repoId: "repo-a" }
      : id === "revB"
        ? { principal: "bob", repoId: "repo-b" }
        : undefined,
  tokenLive: (hash) => hash !== "hash-dead",
};

const updated = (id: string): ServerEvent => ({ kind: "resource_updated", uri: reviewUri(id) });

/** Attach a listener as `who`, and return what it is handed. */
function listenAs(bus: ScopedEventBus, who: Subscriber | undefined): ServerEvent[] {
  const heard: ServerEvent[] = [];
  const add = () => bus.subscribe((e) => heard.push(e));
  if (who === undefined) add();
  else asSubscriber(who, add);
  return heard;
}

describe("ScopedEventBus", () => {
  it("tells the owner of a review that it changed", () => {
    const bus = new ScopedEventBus(CHECKS);
    const heard = listenAs(bus, ALICE);
    bus.publish(updated("revA"));
    expect(heard).toStrictEqual([updated("revA")]);
  });

  // The whole reason this class exists. The MCP listen router matches URIs and
  // authorizes nothing, so without this bob is woken by every change to a review whose
  // id he merely possesses — an existence-and-activity oracle for exactly the thing
  // `getReview` answers NOT FOUND to (D-23).
  it("says nothing to a stranger holding somebody else's review id", () => {
    const bus = new ScopedEventBus(CHECKS);
    const heard = listenAs(bus, BOB);
    bus.publish(updated("revA"));
    expect(heard).toStrictEqual([]);
  });

  // An id that does not exist is answered exactly like one that is not yours — the
  // same reason `getReview` refuses as NOT FOUND rather than as forbidden.
  it("says nothing about a review that does not exist", () => {
    const bus = new ScopedEventBus(CHECKS);
    const heard = listenAs(bus, ALICE);
    bus.publish(updated("no-such-review"));
    expect(heard).toStrictEqual([]);
  });

  // Authentication happens once, when the exchange opens; a listen stream is one
  // exchange that stays open for hours. Without re-checking, `make revoke` would tell
  // an operator the access was cut while the stream kept delivering.
  it("stops delivering once the token that opened the stream is revoked", () => {
    const bus = new ScopedEventBus(CHECKS);
    const heard = listenAs(bus, { ...ALICE, tokenHash: "hash-dead" });
    bus.publish(updated("revA"));
    expect(heard).toStrictEqual([]);
  });

  // FAIL CLOSED. Every stream is opened through `http.ts`, which authenticates and
  // wraps the exchange in `asSubscriber` — so a listener with no identity means the
  // wiring has come apart, and the safe reading of "I do not know who this is" is not
  // "tell them everything".
  it("delivers nothing to a listener with no principal, and reports it", () => {
    const errors: string[] = [];
    const bus = new ScopedEventBus(CHECKS, (e) => errors.push(e.message));
    const heard = listenAs(bus, undefined);
    bus.publish(updated("revA"));
    expect(heard).toStrictEqual([]);
    expect(errors.join(" ")).toMatch(/no principal/i);
  });

  it("stops listening when the stream unsubscribes", () => {
    const bus = new ScopedEventBus(CHECKS);
    const heard: ServerEvent[] = [];
    const off = asSubscriber(ALICE, () => bus.subscribe((e) => heard.push(e)));
    off();
    bus.publish(updated("revA"));
    expect(heard).toStrictEqual([]);
    expect(bus.listenerCount).toBe(0);
  });

  // One failing stream must not silence the others, or a client with a broken
  // connection takes everyone else's notifications down with it.
  it("keeps delivering after a listener throws", () => {
    const errors: string[] = [];
    const bus = new ScopedEventBus(CHECKS, (e) => errors.push(e.message));
    asSubscriber(ALICE, () =>
      bus.subscribe(() => {
        throw new Error("socket gone");
      }),
    );
    const heard = listenAs(bus, ALICE);
    bus.publish(updated("revA"));
    expect(heard).toStrictEqual([updated("revA")]);
    expect(errors).toContain("socket gone");
  });
});

/**
 * A SUBSCRIPTION MUST BE AS NARROW AS `mine()`, and it claimed to be while it was not.
 *
 * After D-78 a review is bound to the token that started it, and `review_poll` on it from
 * a different live token of the SAME PERSON answers NOT FOUND. The stream authorised on
 * principal and repository alone, so that second token was woken on every state change of
 * a review it could never read — told repeatedly that something had happened and unable
 * to find out what.
 *
 * The rules are written twice on purpose: the bus must not import the store. That makes
 * them exactly the kind of pair that drifts, so the pair is what this asserts.
 */
describe("a stream hears only what its own token could read", () => {
  const BOUND = "hash-alice";
  const SECOND: Subscriber = { principal: "alice", repoId: "repo-a", tokenHash: "hash-alice-2" };

  const checks = (live: (h: string) => boolean): SubscriberChecks => ({
    ownerOf: (id) => (id === "revBound" ? { principal: "alice", repoId: "repo-a", tokenHash: BOUND } : undefined),
    tokenLive: live,
  });

  it("wakes the token that started the review", () => {
    const bus = new ScopedEventBus(checks(() => true));
    const heard = listenAs(bus, ALICE);
    bus.publish(updated("revBound"));
    expect(heard).toStrictEqual([updated("revBound")]);
  });

  it("stays silent for another live token of the same person", () => {
    const bus = new ScopedEventBus(checks(() => true));
    const heard = listenAs(bus, SECOND);
    bus.publish(updated("revBound"));
    expect(heard, "review_poll answers NOT FOUND here, so the stream must say nothing").toStrictEqual([]);
  });

  // The same rotation answer `mine()` gives, and for the same reason: stranding a
  // colleague's in-flight work is worse than the accident it prevents.
  it("falls back to repository scope once the binding is revoked", () => {
    const bus = new ScopedEventBus(checks((h) => h !== BOUND));
    const heard = listenAs(bus, SECOND);
    bus.publish(updated("revBound"));
    expect(heard).toStrictEqual([updated("revBound")]);
  });
});
