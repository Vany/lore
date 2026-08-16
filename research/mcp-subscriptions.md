# MCP subscriptions and long-running work

**Wire protocol verified 2026-08-06. §7, the SDK layer, added 2026-08-08** after four
wrong diagnoses in one evening — read that section before writing any client, because
every trap in it fails SILENTLY and the wire half below is not enough to avoid them.
**§3 rewritten 2026-08-16** and now separates two questions this file kept conflating:
what the PROTOCOL defines (read from the spec) versus what the installed SDK IMPLEMENTS
(read from `node_modules`). Tasks is the right shape and the SDK does not carry it.

Checked against the published spec revision `2026-07-28` and against the INSTALLED
`@modelcontextprotocol` packages at **2.0.0**, which is what this deployment runs.
Re-check before relying on it: this is the newest part of the protocol and the one most
likely to move.

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

## 3. Tasks — the right shape, blocked on the SDK. Checked 2026-08-16 against the SPEC

**Read the distinction in this section's title before anything below it.** What the
PROTOCOL defines and what the installed SDK implements are different questions with
different sources, and every wrong answer this file has carried came from answering the
first with the second.

### What the protocol says (2026-07-28 changelog, key change 6)

> *"Move experimental tasks out of the core protocol and into an official extension
> (`io.modelcontextprotocol/tasks`). The redesigned extension replaces the blocking
> `tasks/result` method with polling via `tasks/get` and a new `tasks/update` for
> client-to-server input, removes `tasks/list`, and allows servers to return task handles
> unsolicited without per-request opt-in (SEP-2663)."*

So the live surface is `tasks/get`, `tasks/update`, `tasks/cancel`, with
`CreateTaskResult` (`resultType: "task"`, carrying `taskId`, `ttlMs`, `pollIntervalMs`)
returned in place of a blocking result. Status is `working | input_required | completed |
failed | cancelled`; the last three are terminal. A task that needs input moves to
`input_required` and exposes `inputRequests`, which the client answers with
`tasks/update`. Servers MAY push `notifications/tasks` carrying the full task state, opted
into through `subscriptions/listen` — so a streaming client needs no poll at all, and
polling is the documented default rather than the only way.

`tasks/list` and `tasks/result` are REMOVED, and there is no compatibility shim for the
2025 experimental API.

### What the installed SDK implements (server@2.0.0, core@2.0.0)

**Not that.** It carries the *superseded* 2025 vocabulary and nothing of the new one. The
SDK keeps two wire-era registries (`dist/src-CX2iR2pK.mjs`: `rev2025RequestMethods` vs
`rev2026RequestMethods`):

- **2025-11-25** — `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`, plus
  `notifications/tasks/status`. Every schema annotated *"2025-11-25 wire vocabulary with
  no SDK runtime; kept importable for interoperability only"*, and `codecResultValidator`
  says the result map *"deliberately excludes the `tasks/*` methods, so the spec-method
  overload refuses them up front"*.
- **2026-07-28** — `tools/call`, `tools/list`, `prompts/get`, `prompts/list`,
  `resources/list`, `resources/templates/list`, `resources/read`, `completion/complete`,
  `server/discover`, `subscriptions/listen`. **No `tasks/*`, no `notifications/tasks`.**
  Also no `resources/subscribe`: `subscriptions/listen` replaced it.

No npm package carries the extension either — `@modelcontextprotocol/ext-tasks`,
`/tasks` and `/extensions` are all 404 — and `github.com/modelcontextprotocol/ext-tasks`
describes itself as under development.

### The conclusion, and the two ways this file got it wrong

Tasks is the right shape for a review service and cannot be built today; the gate is SDK
support, not the protocol. See D-110 for the method-by-method mapping onto lore's tools.

Twice a conclusion about the PROTOCOL was drawn from `node_modules`:

1. 08-08 — *"the same revision carries a task model"*. Present in the SDK: true. Same
   revision: false. A grep for method names finds both eras at once and returns a union.
2. 08-15/16 — first *"there is no `tasks/update`, so Tasks is poll-shaped"* (that was the
   2025 vocabulary; `tasks/update` is exactly what 2026-07-28 ADDED), then *"the 2026
   registry has no `tasks/*`, so the protocol dropped it"* (that is an SDK that has not
   implemented the extension).

**`node_modules` answers what our dependency supports today. It cannot answer what the
protocol says, and it will not tell you which question you asked.** Cost: a decision
recorded three times, twice wrong, corrected only when Vany asked whether the problem was
the library or the mechanism.

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

---

## 7. Using the TypeScript SDK (`@modelcontextprotocol/client` 2.0.0)

**Checked 2026-08-08 against `node_modules`, not from memory.** Everything here was
learned by getting it wrong against the live service; each one produces an acknowledged,
open, healthy stream that delivers nothing, which is indistinguishable from "the review
has not changed yet".

### 7.1 `listen()` takes the filter UNWRAPPED — the single worst trap

```ts
// core/dist: the two shapes, and why one is silently accepted
const SubscriptionFilterSchema = z.object({
  toolsListChanged: z.boolean().optional(),
  promptsListChanged: z.boolean().optional(),
  resourcesListChanged: z.boolean().optional(),
  resourceSubscriptions: z.array(z.string()).optional(),
});
const SubscriptionsListenRequestParamsSchema =
  BaseRequestParamsSchema.extend({ notifications: SubscriptionFilterSchema });
```

`client.listen(filter)` takes a **`SubscriptionFilter`** and wraps it into
`params.notifications` itself.

```ts
await client.listen({ resourceSubscriptions: [uri] });              // RIGHT
await client.listen({ notifications: { resourceSubscriptions: [uri] } }); // WRONG
```

The wrong form is not rejected. `SubscriptionFilterSchema` is a plain `z.object` with
**every field optional**, so a filter whose only key is `notifications` validates
perfectly and matches nothing. The server honours an empty filter, acknowledges it, and
sends no events for ever.

**So an empty `honoredFilter` means exactly what it says: nothing was honoured.** I
briefly documented the opposite — that it "can be empty on a subscription that is
working" — after seeing it empty on a subscription I had broken this way. Measured:
unwrapped → `honoredFilter.resourceSubscriptions` echoes the URI and the wake arrives;
wrapped → `{}` and silence.

### 7.2 The 2026 era is opt-in

```ts
LATEST_PROTOCOL_VERSION            = "2025-11-25"
DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26"
```

`subscriptions/listen` needs revision `2026-07-28`, and the client will not negotiate it
unless asked:

```ts
new Client(info, { capabilities: {}, versionNegotiation: { mode: "auto" } })
```

Without it the method throws `MethodNotSupportedByProtocolVersion` — which reads like the
SERVER lacking support, and is not. `mode: "auto"` probes with `server/discover` and
falls back to the legacy handshake; `{ pin: "2026-07-28" }` fails loudly instead.

Note `resources/subscribe` is **removed** in the modern era: on a 2026 connection it
throws, and the listen filter is the whole mechanism. There is no "subscribe first".

### 7.3 Register a handler; the fallback will not fire

```ts
client.setNotificationHandler("notifications/resources/updated", (n) => { ... });
```

A plain method string. `fallbackNotificationHandler` fires only when nothing else is
registered, and the SDK registers its own for this method — so a client that only sets
the fallback receives nothing and concludes the server is quiet.

`ResourceUpdatedNotification` is exported as a TYPE, not a runtime schema value; passing
it where a schema is expected yields `undefined`.

### 7.4 Do not send it as an ordinary request

`client.request({ method: "subscriptions/listen", ... })` applies the client's request
timeout to the WHOLE STREAM, so the subscription is acknowledged and then cancelled by
your own client when that elapses. Raising the timeout only moves the moment.
`client.listen()` resolves on the acknowledgement and holds the stream; the standard
timeout applies to the ack phase only.

### 7.5 `closed` distinguishes the three endings

```ts
sub.closed.then((how) => { /* 'local' | 'graceful' | 'remote' */ });
```

`local` is your own `close()` or abort — **including your process exiting**, which is
worth knowing before reading `remote` into a short-lived script. `graceful` is the server
ending it deliberately. `remote` is an unexpected drop: re-listen if you still want
events.

### 7.6 What lore must do on the server

Declare the capability explicitly — `registerResource` advertises `listChanged` and stops
there, and the listen router honours `resourceSubscriptions` only against a declared
`subscribe` bit:

```ts
new McpServer(info, { capabilities: { resources: { subscribe: true } } })
```

Without it the server accepts the subscription, acknowledges it with an empty filter, and
never delivers — the same observable failure as §7.1, from the other side.
