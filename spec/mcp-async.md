# The asynchronous surface

How the MCP tools look once a review is a conversation and nothing polls. D-80.
Protocol facts: `research/mcp-subscriptions.md`, verified 2026-08-06.

Two halves, at different stages:

- **Subscription — built.** `subscriptions/listen` against `lore://review/{review_id}`,
  woken by every state change and by nothing else (§2). Proved end to end against a
  real MCP client in `src/service/subscribe.test.ts`.
- **Conversation per tier — `[OPEN]`, not started.** §3 and §6 describe the design; the
  reviewer still runs cold rounds, and `review_submit` still refuses mid-round per D-55.
  Nothing in §3 is deployed.

---

## 1. The loop

```
 review_start(branch, into, ticket) ─────────────► {review_id}          returns at once
        │
        ├─ subscriptions/listen  lore://review/{review_id}
        │     ├─ review_poll ONCE — a subscription starts at now, nothing replays
        │     └─ notifications/resources/updated ──► read the resource
        │
        └─ review_submit(review_id, diff, tree_hash)  ── at ANY time, returns at once
                                                          the diff goes to the model
                                                          that raised the finding
```

The client is never waiting. It subscribes, does other work, and is woken. It may
submit the moment it has a fix — including while a tier is reading — because the fix is
not an interruption of the review, it is the next thing said in it.

**None of that last sentence is deployed.** It describes the conversation half, which
is `[OPEN]`. Today D-55 still refuses a submit during a running round, and the states
that accept a diff are `findings_ready` and `awaiting_diff` — not `fast_clean`, where
the deep round is already queued against the worktree. The shipped texts say so; this
section does not describe what a client should do today.

## 2. What an event means

One notification type, `notifications/resources/updated`, carrying only the URI. The
client re-reads `lore://review/{review_id}` to find out what happened, and the resource
already returns the full audit trail.

**A wake means the review's STATE changed, and nothing else does.** Findings do not
wake anyone as they are recorded — a round writes them in a burst, and a client cannot
act on one until the round ends anyway (D-55). What the client sees:

| the state it woke to | what the client does |
|---|---|
| `findings_ready` / `awaiting_diff` | answer every finding — a diff, or a `lore-ok` — then submit |
| `needs_human` | take the question to a person; `knowledge_resolve` resumes it |
| terminal | `passed` → attest and merge; anything else → read `nextStep` |

**Silence is not a state.** A client that hears nothing has learned nothing, exactly as
a poll returning `running` says nothing. The resource is the answer to every question;
the notification only says the answer changed.

**And a stream starts at now.** Nothing that happened before it opened is delivered, so
subscribing is always followed by one poll. Three of the states — `findings_ready`,
`awaiting_diff`, `needs_human` — produce no further events *by design*, because the next
move is the client's; a client that subscribes to a review already in one of them and
waits, waits until the sweep expires it. That is D-70 rebuilt inside its own cure, and
the one poll is what prevents it.

## 3. Submitting

`review_submit` **applies the patch immediately and returns**. It does not wait for a
verdict and does not refuse because a tier is busy.

What happens after it returns: the patch is applied to the review's worktree, the tree
hash is verified against what the client sent (D-40, unchanged — a partial apply is
still caught rather than reviewed), and the diff is handed to the live session as the
next message. The model answers when it answers, and that answer is an event.

**This retires the refusal in D-55**, which existed because a submit rewrote files a
tier was reading and the findings would then describe a tree that never existed. In a
conversation the change is announced rather than silent: the model is told what moved
and answers about the tree as it now stands.

`review_cancel` remains the way to stop, and is now the only thing that ends a review
early.

## 4. Subscription is the way; polling is the fallback

**Subscribing is how a client is meant to use this**, and the docs say so in that order.
A client that subscribes never waits, never loops, and never has to decide how long to
back off for. Everything about the loop is designed around it.

`review_poll` stays, for two reasons, and neither is reluctance:

**A client that never sends `subscriptions/listen` gets nothing**, and that is the
common case rather than the odd one. The spec is explicit that a server may send only
what was subscribed to; worse, `subscriptions/listen` exists only on a 2026-07-28
connection, and a client on the official SDK negotiates the **2025 era by default**
(`ClientOptions.versionNegotiation` defaults to `'legacy'` — measured, not read:
`src/service/subscribe.test.ts` had to pin `2026-07-28` to reach the stream at all).

So the server offering subscriptions changes nothing for a client that connects the
default way. Polling is not a courtesy to stragglers — it is what every unconfigured
client will do, and the subscription path is a capability a client has to reach for.

**And a notification is a nudge, not a delivery.** It carries a URI and nothing else.
Something still has to fetch the findings, and `review_poll`'s delta semantics — never
show the same finding twice — remain the right way. What subscription removes is the
*waiting*, not the reading.

So the two are not alternatives doing the same job badly. Subscription answers *when*;
poll answers *what*. A subscribing client uses both and never sleeps; a client that
cannot subscribe falls back to asking *when* repeatedly, which is the shape we have
today and the one we are leaving.

## 5. What this does not change

- The ladder still climbs, and a tier that has been conversing with the author is not a
  substitute for the tiers that have not looked (D-1, D-49). How the deep tiers enter a
  conversation the cheap tier has been having is **open**.
- `tree_hash` is still verified on every submit (D-40).
- Findings are still records, and still questions (D-79).
- `passed` still means every tier agreed, and nothing else means clean.

## 6. Open before this ships

1. **Cost.** A conversation re-sends its accumulated context every turn (D-50); a cold
   round re-reads the repository but hits 97–99% cache. Which is cheaper is genuinely
   unknown and must be measured, not argued.
2. **The deep tiers.** Whether they join the existing conversation, start their own, or
   read a transcript.
3. **What Claude Code negotiates.** Answered for the official SDK client — legacy
   unless configured otherwise (§4). Not answered for Claude Code itself, which is the
   client we actually have; establish it by pointing one at the deployed service and
   reading what it sends, not by reasoning from the SDK default.
