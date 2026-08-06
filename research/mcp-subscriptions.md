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
neither. **lore currently declares no resource capability at all.**

## 3. Tasks, the other candidate

The same revision carries a task model — `tasks/get`, `tasks/list`, `tasks/status`,
`tasks/result`, `tasks/cancel`, `CreateTaskResult`, task-augmented requests — present in
both `core` and `server` of the installed SDK.

Conceptually it is the closer fit: `review_start` returns an id and the client polls
*because a review outlives a request*, which is the exact problem tasks were added for.
Against it: adopting tasks changes the shape of the client contract, where subscription
is additive and reuses a resource that already exists. Not researched in depth here;
recorded so the choice is made knowingly rather than by default.

## 4. What is NOT verified

**Whether a real client negotiates any of this.** The spec is clear that a server may
send only what the client subscribed to, so a client that never issues
`subscriptions/listen` gets exactly today's behaviour however much lore declares. What
Claude Code actually does is unknown and is the first thing to establish — by pointing
it at a stub and reading what it sends, not by reasoning about it.

That order matters here more than usual. The paste-able `.mcp.json` was wrong in three
independent, individually fatal ways for weeks because nobody checked it against a
client that worked (MEMO session 31), and this is the same class of assumption about
the same client.

**Polling therefore stays**, whatever is built on top. It is the floor, not the shape.
