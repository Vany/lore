# MCP subscriptions and long-running work

**Verified 2026-08-06** against the published spec revision `2026-07-28` and the
installed `@modelcontextprotocol` packages. Re-check before relying on it: this is the
newest part of the protocol and the one most likely to move.

Sources:
- <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions>
- <https://modelcontextprotocol.io/specification/2026-07-28/server/resources>

---

## 1. The claim this retires

`SPEC.md` §2 and D-41 justify polling with *"MCP servers cannot initiate requests"*.
That is true about **requests** and has been carrying an argument it cannot support: a
server can send **notifications**, and since `2026-07-28` there is a mechanism built
precisely for "tell me when this long thing changed".

Everything downstream of that sentence — `review_poll`'s delta loop, the two-stage
split (D-34), `review_inbox`, "the client owns the alarm" — was designed around a
constraint that is narrower than stated.

## 2. `subscriptions/listen`

**It replaces the former `resources/subscribe` RPC and the HTTP GET endpoint.** One
long-lived request opens a server→client notification stream that stays open until
cancelled.

```jsonc
// client → server
{
  "jsonrpc": "2.0", "id": 1,
  "method": "subscriptions/listen",
  "params": {
    "notifications": {
      "resourceSubscriptions": ["lore://review/rev_abc123"]
    }
  }
}
```

The server **MUST** answer first with an acknowledgment, and **MUST NOT** send any
notification type the client did not ask for:

```jsonc
// server → client, first message on the stream
{
  "jsonrpc": "2.0",
  "method": "notifications/subscriptions/acknowledged",
  "params": {
    "_meta": { "io.modelcontextprotocol/subscriptionId": 1 },
    "notifications": { "resourceSubscriptions": ["lore://review/rev_abc123"] }
  }
}
```

The acknowledgment echoes **the subset the server agreed to honour** — unsupported
types are omitted, and the client is expected to check what it got back against what it
asked for.

Then, whenever a watched resource changes:

```jsonc
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "_meta": { "io.modelcontextprotocol/subscriptionId": 1 },
    "uri": "lore://review/rev_abc123"
  }
}
```

The notification carries **only the URI**. It is a nudge, not a payload: the client
re-reads the resource to find out what changed.

### The filter is fixed, not general

| field | type | meaning |
|---|---|---|
| `toolsListChanged` | `boolean` | `notifications/tools/list_changed` |
| `promptsListChanged` | `boolean` | `notifications/prompts/list_changed` |
| `resourcesListChanged` | `boolean` | `notifications/resources/list_changed` |
| `resourceSubscriptions` | `string[]` | `notifications/resources/updated` for these URIs |

**There is no "subscribe to an arbitrary event".** The only per-object subscription is a
list of resource URIs, so anything lore wants a client to wait on has to *be* a
resource. `lore://review/{review_id}` already is one, and already returns the full
audit trail — richer than `review_poll`.

### Correlation and closure

- Every message on the stream carries `io.modelcontextprotocol/subscriptionId` in
  `_meta`; the value is the JSON-RPC id of the `subscriptions/listen` request. On stdio
  all subscriptions share one channel, so clients **MUST** demultiplex on it.
- A client may hold several subscriptions at once.
- The client cancels by closing the SSE stream (HTTP) or sending
  `notifications/cancelled` (stdio).
- When the **server** ends one — shutdown — it **SHOULD** first reply to the original
  `subscriptions/listen` request with an empty result, then close. A stream that closes
  *without* that response was an abrupt drop, and a client may reconnect on it. The
  distinction is exactly INV-1's shape at the transport layer: a clean ending and a
  failure must not look alike.
- On stdio the server holds **no** subscription state across reconnects; the client
  re-sends `subscriptions/listen`.

### Capability

```jsonc
{ "capabilities": { "resources": { "listChanged": true, "subscribe": true } } }
```

`subscribe` and `listChanged` are independent; a server may declare either, both or
neither. lore declares both (`src/mcp/server.ts`); `listChanged` comes free with
`registerResource`, `subscribe` had to be asked for. Without the `subscribe` bit the
listen router drops `resourceSubscriptions` from the honoured filter and answers the
subscription with an empty ack — accepted, and silent forever.

## 3. Tasks, the other candidate

The same revision carries a task model — `tasks/get`, `tasks/list`, `tasks/status`,
`tasks/result`, `tasks/cancel`, `CreateTaskResult`, task-augmented requests — present in
both `core` and `server` of the installed SDK.

Conceptually it is the closer fit: `review_start` returns an id and the client polls
*because a review outlives a request*, which is the exact problem tasks were added for.
Against it: adopting tasks changes the shape of the client contract, where subscription
is additive and reuses a resource that already exists. Not researched in depth here;
recorded so the choice is made knowingly rather than by default.

## 4. The era is opt-in on the client — measured 2026-08-06

`subscriptions/listen` exists **only on a 2026-07-28 connection**, and the official
client SDK does not open one by default:

```ts
// @modelcontextprotocol/client 2.0.0 — the shape that actually compiles, copied from
// src/service/subscribe.test.ts rather than paraphrased:
new Client({ name, version }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });

// `mode` takes one of three values:
//   'legacy' (THE DEFAULT) — no probe, plain 2025 connect, byte-identical to a 2025 client
//   'auto'                 — probe with `server/discover`, fall back to legacy on anything
//                            short of definitive modern evidence
//   { pin: '2026-07-28' }  — modern or fail loudly
```

Measured, not read off the docs: `src/service/subscribe.test.ts` connected with the
defaults and `client.listen()` threw

> `subscriptions/listen requires a 2026-07-28-era connection (negotiated: 2025-11-25)`

even though the server advertised `resources.subscribe` and served the modern era. The
test pins the revision.

The consequence for lore is not small. A client that connects the ordinary way sees the
2025 surface, cannot subscribe, and must poll — so **polling is the majority path, not
the fallback for stragglers**, until a specific client is shown to negotiate up.

Note also that `LATEST_PROTOCOL_VERSION` in the SDK is `2025-11-25`: the modern revision
is a separate constant (`MODERN_WIRE_REVISION`), not the maximum of that list. Reading
`LATEST_PROTOCOL_VERSION` as "the newest thing this SDK speaks" is wrong.

## 5. What is still NOT verified

**What Claude Code negotiates.** The SDK default above is evidence about the SDK, not
about the client we actually have — Claude Code may configure it. This is the first
thing to establish, by pointing one at the service and reading what it sends, not by
reasoning about it.

That order matters here more than usual. The paste-able `.mcp.json` was wrong in three
independent, individually fatal ways for weeks because nobody checked it against a
client that worked (MEMO session 31), and this is the same class of assumption about
the same client.

**Polling therefore stays**, whatever is built on top. It is the floor, not the shape.
