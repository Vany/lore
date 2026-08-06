# The asynchronous surface

How the MCP tools look once a review is a conversation and nothing polls. **D-80,
`[OPEN]`** — this is the design, not the deployed shape. Protocol facts:
`research/mcp-subscriptions.md`, verified 2026-08-06.

---

## 1. The loop

```
 review_start(branch, into, ticket) ─────────────► {review_id}          returns at once
        │
        ├─ subscriptions/listen  lore://review/{review_id}
        │     └─ notifications/resources/updated ──► read the resource
        │
        └─ review_submit(review_id, diff, tree_hash)  ── at ANY time, returns at once
                                                          the diff goes to the model
                                                          that raised the finding
```

The client is never waiting. It subscribes, does other work, and is woken. It may
submit the moment it has a fix — including while a tier is reading — because the fix is
not an interruption of the review, it is the next thing said in it.

## 2. What an event means

One notification type, `notifications/resources/updated`, carrying only the URI. The
client re-reads `lore://review/{review_id}` to find out what happened, and the resource
already returns the full audit trail.

Three things are worth waking a client for, and they are what the resource will show:

| what changed | what the client does |
|---|---|
| a **finding** was raised | answer it — a diff, or a `lore-ok` |
| a finding was **settled** — or refused | nothing, or answer again with a reason that holds |
| the review reached a **terminal state** | `passed` → attest and merge; anything else → read `nextStep` |

**Silence is not a state.** A client that hears nothing has learned nothing, exactly as
a poll returning `running` says nothing. The resource is the answer to every question;
the notification only says the answer changed.

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

**A client that never sends `subscriptions/listen` gets nothing.** The spec is explicit
that a server may send only what was subscribed to, so polling is the floor for any
client that does not negotiate one. Whether the clients we actually have do is
**unverified** and is the first thing to establish — which is also why the fallback is
not hypothetical.

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
3. **What a real client negotiates.** Point one at a stub and read what it sends.
