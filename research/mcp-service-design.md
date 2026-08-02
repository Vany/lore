# MCP service design constraints

**Verified 2026-08-03** against `modelcontextprotocol.io/specification/draft`
(authorization and transports pages, fetched directly).

---

## 1. Credentials must not live in the URL

The spec is explicit:

> Access tokens **MUST NOT** be included in the URI query string.

and

> MCP client **MUST** use the Authorization request header field:
> `Authorization: Bearer <access-token>` … authorization **MUST** be included in
> every HTTP request from client to server.

**This contradicts the original provisioning design** ("returns the MCP url, key is
in the url").

Nuance, stated honestly:

- Authorization is **OPTIONAL** in MCP. A server may authenticate however it likes;
  the requirement above governs *OAuth access tokens*.
- A high-entropy opaque token in the URL **path** (not the query string) is not
  literally the forbidden case, and several real services do it.
- But the practical hazards are real regardless of spec letter: URLs are recorded
  in proxy and access logs, land in client configuration files that get committed,
  and are awkward to rotate.

**Recommendation: header.** Vany's own `opencode.json` already proves the client
side works — the `plane` MCP entry passes `x-api-key` via `headers`. Provisioning
can still emit a single paste-able config blob; the secret simply sits in a header
field.

```json
{
  "mcp": {
    "lore": {
      "type": "remote",
      "url": "https://lore.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:LORE_TOKEN}" }
    }
  }
}
```

## 2. Long-running reviews must be polled, not pushed

> servers do not initiate JSON-RPC requests and clients do not send JSON-RPC
> responses.

There is no server-initiated completion message. A review that outlives the
request must therefore return an id immediately and expose a poll tool. **This is
not a workaround — it is the only correct shape**, and it matches the intended
workflow exactly.

Progress notifications exist within a request's lifetime, but the requirement is
"no progress, we can't promise anything", so they are unused.

## 3. Transport

**Streamable HTTP**: every message is an HTTP POST to a single MCP endpoint;
replies come back as a JSON object or a request-scoped SSE stream. Cancellation on
this binding is the client closing the response stream — so an abandoned poll must
not abort the underlying review job.

stdio is the other standard binding, and is what the development CLI can use
locally without any HTTP surface.

## 4. Protocol metadata

All protocol metadata travels in the message body under
`_meta.io.modelcontextprotocol/*`. Streamable HTTP additionally mirrors selected
fields into HTTP headers so intermediaries can route without parsing bodies, but
**the body remains the source of truth**.

## 5. Consequences for `lore`

| constraint | design consequence |
|---|---|
| No server-initiated requests | `review.start` returns an id; client polls |
| Token in header, not URL | provisioning emits a config blob, not a secret URL |
| Client closes stream to cancel | a dropped poll must never kill the review job |
| Auth optional but audience-bound if OAuth | opaque bearer tokens, scoped per repo, revocable |

## 6. Open items

1. Whether to grow into full OAuth 2.1 later. For a workgroup, opaque revocable
   bearer tokens are proportionate; a public product would need the real flow.
2. Rate limiting and abuse controls per token — unspecified, and not urgent at
   workgroup scale, but the hooks belong in the design now.
3. Token rotation procedure. A token that cannot be rotated without breaking every
   client is a token nobody will rotate.
