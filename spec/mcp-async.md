# The asynchronous surface

How the MCP tools look once a review is a conversation and nothing polls. D-80.
Protocol facts: `research/mcp-subscriptions.md`, verified 2026-08-06.

Two halves, at different stages:

- **Subscription — built.** `subscriptions/listen` against `lore://review/{review_id}`,
  woken by every state change and by nothing else (§2). Proved end to end against a
  real MCP client in `src/service/subscribe.test.ts`.
- **Conversation per tier — DESIGNED 2026-08-11, not built.** §3 and §6 describe it, and
  §6's two open questions are now answered (SPEC D-80): a deep tier enters from an EMPTY
  prompt on the fixed tree — inheriting would make three tiers one opinion asked three
  times — and the cost question is measured in `research/t2-token-cost.md`. The shape is
  one session per (review, tier), initialised once, **compacted at 2/3 of that tier's
  context window rather than restarted**.
  The reviewer still runs cold rounds, `review_submit` still refuses mid-round per D-55,
  and nothing in §3 is deployed. It changes how much quota burns, so it ships on the
  operator's word.

---

## 1. The loop

```
 review_start(branch, into, ticket) ─────────────► {review_id}          returns at once
        │
        ├─ subscriptions/listen  lore://review/{review_id}
        │     ├─ review_poll ONCE — a subscription starts at now, nothing replays
        │     └─ notifications/resources/updated ──► read the resource
        │
        └─ review_submit(review_id, diff, tree_hash)  ── [OPEN, NOT BUILT] at any time
                                                          today: only in findings_ready
                                                          or awaiting_diff (D-55)
```

**The bottom branch is a design, not a deployment**, and it is drawn here because the
rest of the loop is real and it is the shape they will make together. A diagram is
skimmed, so the caveat is on the line rather than under the picture.

Today D-55 refuses a submit during a running round; the states that accept a diff are
`findings_ready` and `awaiting_diff` — not `fast_clean`, where the deep round is already
queued against the worktree. The shipped texts say exactly that.

What the `[OPEN]` half would be: the client submits the moment it has a fix, including
while a tier is reading, because the fix is not an interruption of the review — it is
the next thing said in it, handed to the session that raised the finding.

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

**Its `reason` is stored, and a cancel may never borrow an explanation.** The tool
describes the reason as *"recorded, and the only account anyone gets"*, so it is written
to `review.failed_because` with who stopped it — a cancel is somebody's decision, not a
thing that happened — and `review_poll` surfaces it for `cancelled` alongside `failed`
and `expired`. Without that it is written and unreadable, and a cancel reads exactly like
an abandonment, which is the distinction the state exists to draw.

`failureReason` otherwise falls back to the last `job.last_error`, and that fallback is
**refused for `cancelled`**. For a `failed` review a round's error is usually the truest
account there is; for a cancelled one it would hand back a transport error from an
unrelated earlier round as a person's stated reason. A cancel with nothing recorded says
nothing was recorded, and tells the reader not to infer why.

## 4. Subscription is the way; polling is the fallback

**Subscribing is how a client is meant to use this**, and the docs say so in that order.
A client that subscribes never waits, never loops, and never has to decide how long to
back off for. Everything about the loop is designed around it.

`review_poll` stays, for two reasons, and neither is reluctance:

**The client we actually have cannot subscribe at all, and the measurement is done.**
Claude Code parses lore's `resources.subscribe: true`, records it, and exposes no verb
to the model that can send `subscriptions/listen`. The negotiated protocol revision is
therefore moot — there is no way to reach the method on either era. The evidence was in
front of me the whole time and I did not read it: the tests in
`src/service/subscribe.test.ts` are driven by a hand-built SDK client precisely because
the harness offers no other way to open that stream.

**And an agent client is not a process.** It exists inside a turn; between turns there
is nothing for a notification to arrive at. Even with the verb, the harness would have
to turn a notification into a new turn — machinery lore cannot reach and never will.
The wake has to be initiated on the client's side.

That retires the framing this section was written in. Lore's job is not *"wake the
client"* — for the client we have, it cannot. It is:

> **make leaving cheap, and make "when to come back" a measured answer.**

Which is `check_back_after_ms` (`spec/mcp-api.md` §2.0.3), and `review_inbox` as the
first call of every session — because a session ends, its subscription dies with it,
and the only thing that survives is the next session asking what is waiting.

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

## 6. Answered before it ships

Both questions that held this open are settled. **The decision is made; the code is not
written.** Full reasoning and the measurement are in SPEC D-80 and
`research/t2-token-cost.md`.

**Is a long conversation cheaper than repeated cold rounds?** Measured across 128 completed
t2 rounds: a cold round spends **31.6 turns** re-orienting in a worktree it read minutes
ago — 972K cached reads, 95K fresh, $0.69 — and **29% of all model rounds are a tier
re-reading a review it already knows**. The objection that kept this open, that a
conversation re-sends its whole context every turn and so loses as it lengthens, was an
argument against an unbounded one. **Compaction at 2/3 of the tier's window** bounds it;
opencode provides `session.summarize`, and `CompactionPart.auto` shows it already compacts
by itself, so this chooses the threshold rather than inventing the mechanism.

**How does a deep tier enter a conversation the cheap tier has been having?** It does not.
It opens a new session, empty of the previous tier's reasoning, on the tree as it now
stands. Independence in this ladder is ACROSS tiers (D-1, D-49) — a tier that read the
previous model's conclusions would make three opinions into one asked three times. What
travels is the record, not the reasoning: `settledBlock`, so the new tier does not re-raise
what the author has already answered to somebody else.

**Compaction, never restart.** The distinction is the point: the worktree remembers the
CODE, not why the model looked where it looked or what it ruled out. Restarting on the
fixed tree keeps the former and throws away the latter, which is the thing `settledBlock`
already tries to reconstruct and cannot.

Three implementation obligations, none of which reopen the decision: sessions are released
when the review ends (128 admitted reviews × 3 tiers is 384 live sessions if nothing closes
them); a lore restart loses the in-memory session map, so a requeued round falls back to a
cold start rather than failing; and the property being given up — fresh eyes each round — is
measurable as findings per round and how often a finding is withdrawn after a fix.
