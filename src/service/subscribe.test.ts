/**
 * The subscription surface, proved against a real MCP client.
 *
 * This is the one test in the suite that runs the 2026-07-28 path end to end. Every
 * other MCP test posts a bare JSON-RPC body, which classifies as 2025-era and is
 * served by the stateless legacy fallback — so it exercises the tools and proves
 * nothing at all about `subscriptions/listen`.
 *
 * A real client, not a hand-written envelope, deliberately. The modern era needs a
 * `_meta` envelope, a version-negotiation probe and an ack-first stream, and a test
 * that hand-rolls those encodes my guess at the wire rather than the wire. `lore`'s
 * defining failure is a client acting confidently on a contract nobody checked; the
 * paste-able `.mcp.json` was wrong in three independent, individually fatal ways for
 * weeks because it was reasoned about instead of run.
 *
 * What this pins down, all of which have silent failure modes:
 *
 *   1. the server DECLARES `resources.subscribe` — without it the listen router
 *      quietly drops `resourceSubscriptions` from the honoured filter and the client
 *      waits forever on a stream that was accepted;
 *   2. the MCP handler outlives the request that opened the stream;
 *   3. `store.events` is actually wired to that handler's bus;
 *   4. the events are scoped to the review the client asked about;
 *   5. **and to the principal it belongs to** — the SDK's router authorizes nothing,
 *      so without `ScopedEventBus` a subscription is an existence oracle for any id
 *      a caller can guess or find in a log (D-23).
 *
 * **Every negative assertion here is ordered, never timed.** "Do nothing, wait 50ms,
 * check nothing arrived" passes on a fast machine and rots quietly: the day delivery
 * regresses, the duplicate crosses the socket at 60ms and the suite stays green. So
 * each one fires a *known* event afterwards and asserts that is the next thing seen —
 * events on one stream are ordered, so anything that should not have been sent would
 * have to arrive before it.
 *
 * SPEC: D-80, `spec/mcp-async.md`
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { grantToken, revokeByPrefix } from "../mcp/auth.ts";
import { reviewUri } from "../mcp/events.ts";
import { DEFAULT_HEARTBEAT } from "../ops/heartbeat.ts";
import { DEFAULT_SPEND } from "../ops/spend.ts";
import { Store } from "../store/store.ts";
import { startHttp } from "./http.ts";

/** A client, plus what it has been told and a way to await the next thing. */
interface Watcher {
  readonly client: Client;
  readonly seen: string[];
  next(): Promise<string>;
}

let store: Store;
let stop: () => void;
let base: string;
let alice: Watcher;
let aliceToken: string;
let bobToken: string;
const open: Client[] = [];

/** A different port per test, for the reason given in `http.test.ts`. */
let portSeq = 39_811;

/**
 * Connect one client, pinned to the modern revision.
 *
 * PINNED, not `auto`. The SDK client defaults to `versionNegotiation: 'legacy'` and
 * `auto` falls back to the 2025 handshake on anything short of definitive modern
 * evidence — so a regression in the server's `server/discover` would show up here as
 * "subscriptions/listen requires a 2026-era connection" from every test at once, with
 * nothing saying the server had stopped offering the era. Pinning makes it one loud
 * failure at connect.
 */
async function watcher(token: string, name: string): Promise<Watcher> {
  const seen: string[] = [];
  const waiters: ((uri: string) => void)[] = [];
  const client = new Client({ name, version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  client.setNotificationHandler("notifications/resources/updated", (n) => {
    seen.push(n.params.uri);
    waiters.shift()?.(n.params.uri);
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  open.push(client);
  return {
    client,
    seen,
    next: () => new Promise<string>((resolve) => waiters.push(resolve)),
  };
}

beforeEach(async () => {
  store = new Store(":memory:");
  const demo = store.upsertRepo("demo", "git@x:demo.git");
  const other = store.upsertRepo("other", "git@x:other.git");
  aliceToken = grantToken(store, demo.id, "alice");
  bobToken = grantToken(store, other.id, "bob");

  for (const id of ["revS", "revOther"]) {
    store.createReview({
      id,
      repoId: demo.id,
      principal: "alice",
      branch: "feat/x",
      intoRef: "main",
      ticket: "t",
      type: "code-arch",
      state: "queued",
      ladder: initialState(),
    });
  }
  // Bob's own review, so his stream has an ordering barrier of its own. Ordering holds
  // WITHIN one stream and not between two — the first version of the cross-principal
  // test below used alice's arrival as the barrier for bob's silence, which is a race
  // across two sockets, and it passed against the unfixed code.
  store.createReview({
    id: "revBob",
    repoId: other.id,
    principal: "bob",
    branch: "feat/y",
    intoRef: "main",
    ticket: "t",
    type: "code-arch",
    state: "queued",
    ladder: initialState(),
  });

  const port = ++portSeq;
  base = `http://127.0.0.1:${port}`;
  ({ close: stop } = startHttp(
    store,
    {
      store,
      worktreeFor: async () => "/tmp/nowhere",
      enqueue: () => undefined,
      attest: async () => "lore: attested",
    },
    {
      port,
      host: "127.0.0.1",
      heartbeat: { ...DEFAULT_HEARTBEAT, dataDir: "/tmp" },
      spend: DEFAULT_SPEND,
    },
  ));

  alice = await watcher(aliceToken, "alice-client");
});

afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  stop();
  store.close();
});

const FINDING = {
  fingerprint: "fp1",
  file: "src/a.ts",
  severity: "high" as const,
  claim: "unbounded read",
  evidence: "no length check",
  failureScenario: "a 4GB body exhausts the heap",
  origin: "t1",
  round: 1,
  firstSeen: "2026-08-06T00:00:00.000Z",
};

describe("subscriptions/listen", () => {
  it("negotiates the modern protocol revision at all", () => {
    // If this fails, every other test in this file is testing the legacy fallback
    // and passing for the wrong reason. Named separately so that shows up as its
    // own failure rather than as a mysterious absence of notifications.
    expect(alice.client.getServerCapabilities()?.resources?.subscribe).toBe(true);
  });

  it("honours a resource subscription, rather than accepting and dropping it", async () => {
    const sub = await alice.client.listen({ resourceSubscriptions: [reviewUri("revS")] });
    // The ack echoes the subset the server agreed to serve. An empty one here is the
    // exact silent failure `resources.subscribe` exists to prevent: the stream opens,
    // the client is satisfied, and no event ever arrives.
    expect(sub.honoredFilter.resourceSubscriptions).toEqual([reviewUri("revS")]);
    await sub.close();
  });

  it("wakes a subscriber when the review changes state", async () => {
    const sub = await alice.client.listen({ resourceSubscriptions: [reviewUri("revS")] });
    const arrived = alice.next();
    store.updateReview("revS", { state: "running" });
    expect(await arrived).toBe(reviewUri("revS"));
    await sub.close();
  });

  // A WAKE MEANS ONE THING: THE REVIEW'S STATE CHANGED. Findings do not wake anyone
  // on their own, deliberately — a round records them in one synchronous burst, so N
  // findings meant N notifications and, under "poll on each wake", N-1 empty polls at
  // an LLM turn each. The client could not have acted on any of them either: D-55
  // refuses a submit while the round is running. The round ENDS by moving the review
  // to `findings_ready`, and that is the wake worth having.
  it("does not wake on a finding, only on the state change that ends the round", async () => {
    const sub = await alice.client.listen({
      resourceSubscriptions: [reviewUri("revS"), reviewUri("revOther")],
    });

    // Ordered, not timed: three findings and a re-raise are followed by a change to
    // the OTHER review, and that must be the FIRST thing this stream sees. Any wake
    // from a finding would arrive before it, whenever it arrived.
    const first = alice.next();
    expect(store.recordFinding("revS", FINDING)).toBe(true);
    expect(store.recordFinding("revS", { ...FINDING, fingerprint: "fp2" })).toBe(true);
    expect(store.recordFinding("revS", { ...FINDING, fingerprint: "fp3" })).toBe(true);
    expect(store.recordFinding("revS", FINDING)).toBe(false);
    store.updateReview("revOther", { state: "running" });
    expect(await first).toBe(reviewUri("revOther"));

    // And the round ending IS the wake.
    const ended = alice.next();
    store.updateReview("revS", { state: "findings_ready" });
    expect(await ended).toBe(reviewUri("revS"));
    expect(alice.seen).toEqual([reviewUri("revOther"), reviewUri("revS")]);

    await sub.close();
  });

  it("hands the woken client the whole review when it re-reads the resource", async () => {
    // The notification carries only a URI — it is a nudge, not a payload. That is
    // only useful if the URI it names is readable on the same connection, which is
    // a separate claim from "the event arrived": the resource is registered on the
    // per-request instance and the event comes from the shared handler.
    const sub = await alice.client.listen({ resourceSubscriptions: [reviewUri("revS")] });
    const arrived = alice.next();
    store.updateReview("revS", { state: "findings_ready" });
    await arrived;

    const res = await alice.client.readResource({ uri: reviewUri("revS") });
    // `contents[0]` is text-or-blob in the type; this resource declares JSON, and a
    // blob here would be a change in the resource, which the assertion below catches.
    const first = res.contents[0] as { text?: string } | undefined;
    const trail = JSON.parse(first?.text ?? "{}") as { review?: { state?: string } };
    expect(trail.review?.state).toBe("findings_ready");
    await sub.close();
  });

  it("does not leak another review's events onto the stream", async () => {
    const sub = await alice.client.listen({ resourceSubscriptions: [reviewUri("revS")] });
    const arrived = alice.next();

    // `revOther` belongs to the same principal, so this is not an authorization
    // check — it is the narrower claim that the filter is per URI. A stream that
    // delivered everything would still "work", and would hand a client findings it
    // never asked for, which is the delta-consuming hazard `review_poll` already has.
    store.updateReview("revOther", { state: "running" });
    store.updateReview("revS", { state: "running" });

    expect(await arrived).toBe(reviewUri("revS"));
    expect(alice.seen).toEqual([reviewUri("revS")]);
    await sub.close();
  });
});

describe("a subscription is not a way around D-23", () => {
  it("tells a stranger nothing about a review id they merely possess", async () => {
    // The whole point. Bob is authenticated, for a DIFFERENT repo, and asks to follow
    // alice's review by id — which is all an id-in-a-log gives anyone. The SDK's listen
    // router matches URIs and authorizes nothing, so without `ScopedEventBus` this is
    // an existence-and-activity oracle for exactly the thing `mine()` returns NOT FOUND
    // for.
    const bob = await watcher(bobToken, "bob-client");
    // Bob asks for BOTH: alice's review, which is not his, and his own. The barrier is
    // on his own stream — if he were entitled to `revS` it would arrive there first,
    // whenever it arrived. Alice's socket cannot order anything for bob's.
    const bobSub = await bob.client.listen({
      resourceSubscriptions: [reviewUri("revS"), reviewUri("revBob")],
    });
    const aliceSub = await alice.client.listen({ resourceSubscriptions: [reviewUri("revS")] });

    const heard = alice.next();
    const bobHeard = bob.next();
    store.updateReview("revS", { state: "running" });
    store.updateReview("revBob", { state: "running" });

    // Alice is the positive control: the event fired and crossed a socket.
    expect(await heard).toBe(reviewUri("revS"));
    // Bob's first and only event is his own.
    expect(await bobHeard).toBe(reviewUri("revBob"));
    expect(bob.seen).toEqual([reviewUri("revBob")]);

    // The subscription was ACCEPTED — the ack is written by the SDK before the bus is
    // consulted and cannot be narrowed. Asserted rather than glossed over, because a
    // reader who assumed a refusal would go looking for one.
    expect(bobSub.honoredFilter.resourceSubscriptions).toEqual([reviewUri("revS"), reviewUri("revBob")]);

    await bobSub.close();
    await aliceSub.close();
  });

  // WHAT REVOCATION PROMISES AN OPERATOR: `make revoke` cuts the access. Asserted here
  // as the thing that IS testable over a socket — the credential stops working — while
  // the delivery half is `events.test.ts`.
  //
  // The delivery half was here, and it was a race: a negative assertion about alice's
  // stream needs a barrier on ALICE'S stream, and a client entitled to nothing has
  // none. Using bob's arrival as the barrier orders nothing — both frames are written
  // inside the same synchronous publish, so which client sees its own first is decided
  // by file-descriptor servicing order. It never false-failed, which is exactly why it
  // would have stayed green through a regression. Third racy negative in this file;
  // the first two were caught the same way.
  it("refuses a revoked token, which is what `make revoke` promises", async () => {
    const sub = await alice.client.listen({ resourceSubscriptions: [reviewUri("revS")] });
    const before = alice.next();
    store.updateReview("revS", { state: "running" });
    expect(await before).toBe(reviewUri("revS"));

    const row = store.db.prepare("SELECT hash FROM token WHERE principal = 'alice'").get() as {
      hash: string;
    };
    expect(revokeByPrefix(store, row.hash.slice(0, 12)).kind).toBe("revoked");
    expect(store.tokenLive(row.hash)).toBe(false);

    // A fresh exchange on the dead credential is refused at the door.
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);

    await sub.close();
  });
});
