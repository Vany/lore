# MCP surface

The product. Constraints and their provenance: `research/mcp-service-design.md`.

---

## 1. Provisioning

```
make new NAME=vany GIT=git@github.com:org/repo.git
```

1. Creates the tenant and repo record. Registering a url that is already known
   **reuses** the existing repo — the same repository under two protocols was once
   two rows with two clones and its knowledge split between them.
2. Mints an opaque, revocable bearer token scoped to that repo, shown **once** and
   stored only as a hash.

   **Revocation is by the hash prefix, not the token** — `make tokens` lists them,
   `make revoke TOKEN=<short>` turns one off. It has to be, because the secret is
   shown once and never stored, so an operator revoking a leaked, lost, or departed
   teammate's token has never held it. The original function took the token itself,
   had no caller, and could not have had one; `revoked_at` was a column printed by
   `make tokens` that nothing in the system could set. Ambiguity in the prefix is
   refused rather than resolved (the rule from `spec/review-ladder.md` §3.1.2):
   picking a winner would lock out a teammate *and* leave the leaked token live.
3. Emits a paste-able `.mcp.json` fragment with the token **in a header** (D-21).

**No key is issued** (D-65). lore does not clone and does not fetch; a host process
does, as the operator, into `data/repos` — the one directory the container already
sees. The operator's remaining step is `make mirror REPO=<name>` once, then `make
mirror-daemon` so it stays current without anyone remembering.

Nothing is asked of the client. A mirror older than `MAX_MIRROR_AGE_MS` is refused
rather than reviewed, and since the client cannot fix that from where it stands, the
refusal says what to report rather than what to run.

## 1.1 This surface is what validates a change (D-76)

**A change to lore is not validated until a client has driven it over MCP** — real tool
calls, a real token, the deployed service. A CLI run is evidence about the core and
never evidence that the product works.

The rule exists because the CLI is always easier: no token, no mirror, no push, and it
reviews the working tree directly. On 2026-08-06 that is exactly why it was reached
for, to avoid pushing a branch — and the workaround then failed on its first command,
because the CLI had never been run from the host and the T0 sandbox's cache root
defaults to a path only the container has. **A surface nobody exercises does not work.**

The prerequisite is part of the rule rather than a reason to skip it: a review is cut
from the mirror of the remote (D-65), never from a working copy, so the branch must be
pushed first. *Push, then review.*

## 2. Tools

Ten, registered with **underscores**. The dotted form is prose, not an address —
every document here once used it and an agent following them literally called
nothing.

| tool | arguments (`*` required) | returns |
|---|---|---|
| `review_start` | `branch*`, `into*`, `ticket*`, `type` | `{review_id, state: "queued", note}` — returns immediately |
| `review_poll` | `review_id*` | `{state, clean, note, new_findings[], open_count}` — §2.1.1 |
| `review_submit` | `review_id*`, `diff*`, `tree_hash*` | `{review_id, state, tree_hash}` |
| `review_attest` | `review_id*` | the signed line, with its tree hash |
| `review_inbox` | — | `{reviews[], needs_human, note}` across all the caller's reviews |
| `review_vex` | `review_id*` | `{summary, untriaged, document}` — CycloneDX VEX |
| `knowledge_query` | `path`, `contains` | `{count, items[]}` |
| `knowledge_teach` | `statement*`, `why*`, `path`, `kind` | `{id, recorded}` |
| `knowledge_resolve` | `keep*`, `retire*`, `reason*` | `{resolved, retired, note}` |
| `knowledge_escalate` | `left*`, `right*`, `note*` | the conflict, raised for a person |

`review_poll` and `review_inbox` both return a `note` that restates the one rule in
machine-readable position: *only `passed` means clean*. A client that reads `state`
and nothing else is the client this service exists to protect against.

`knowledge_*` is available to anyone holding a token for the repo, at any time,
independent of any review (D-18). That is the point of the service: a session
should be able to ask what is known *before* it writes code, not only learn it
after being corrected.

### 2.0 Resources and the prompt

Tools are not the whole surface. `spec/agent-docs.md` §1 — the docs **are** the
interface — is why these are shipped by the server rather than written in a README
the agent never reads.

| resource | subject |
|---|---|
| `lore://docs/workflow` | the review loop, end to end |
| `lore://docs/lore-ok` | justification format |
| `lore://docs/findings` | finding schema and severities |
| `lore://docs/states` | every state, and which are terminal |
| `lore://docs/ladder` | why escalation exists |

Two are **templates**, and clients list them separately (`resources/templates/list`,
not `resources/list` — a client that reads only the latter never sees them):

| template | subject |
|---|---|
| `lore://review/{review_id}` | the full audit trail: every tier run, finding, verdict |
| `lore://knowledge/{+path}` | what is known about a path |

`lore://review/{id}` is deliberately richer than `review_poll`. Poll gives deltas, so
a client driving the loop is never shown the same finding twice; the resource gives
the whole history, for a person asking what happened.

One prompt, `review(branch, into, ticket)`, drives the whole loop. It exists because
an agent handed only tools improvises the multi-round, stateful part, and improvises
it wrong.

### 2.0.1 Being woken instead of asking (D-80)

`lore://review/{review_id}` is also **subscribable**. The server declares
`resources: { subscribe: true }`, and a client on a 2026-07-28 connection opens

```jsonc
{ "method": "subscriptions/listen",
  "params": { "notifications": { "resourceSubscriptions": ["lore://review/<id>"] } } }
```

and is then sent `notifications/resources/updated` — carrying the URI and nothing else
— **whenever that review's state changes, and only then**.

That is the whole rule, and it is narrower than the obvious one on purpose. Findings do
not wake anybody as they are recorded: a round writes them in one synchronous burst, so
six findings would be six notifications within milliseconds, and a client following the
instruction to poll on each wake would spend five LLM turns on empty deltas — the first
poll returns all six. It could not act on them either, because §2.4 refuses a submit
while the round is running. The round ends by moving the review to `findings_ready`, and
that is the wake worth having.

So a wake means exactly one thing: **the review's state changed and there is something
new to do.** A write that changes no state — the ladder advancing a cursor, a round
boundary rewriting `running` over `running` — sends nothing, for the same reason.

**A subscription starts at NOW, and there is no replay.** Nothing is delivered for what
happened before the stream opened, so a client must `review_poll` once immediately after
subscribing. This is not a nicety: `findings_ready`, `awaiting_diff` and `needs_human`
are states whose next move belongs to the client, so a review sitting in one produces no
further events at all. A session that restarts, or that picks a review up from
`review_inbox`, would subscribe exactly as instructed and then wait until the 48h sweep
expired it — which is D-70's abandonment, recreated by the mechanism built to end it.
Raised by t2 against the commit that added subscriptions.

The events are per URI **and per principal**. Subscribing to one review does not
deliver another's, and subscribing to a review that is not yours delivers nothing at
all — see §2.0.2.

**Two things a client must get right, both of which fail silently:**

- **Check the acknowledgement.** The ack echoes the subset the server agreed to serve.
  An empty one means the subscription was accepted and will never deliver.
- **Expect to be unable to subscribe.** `subscriptions/listen` exists only on a
  2026-07-28 connection, and the official client SDK negotiates the 2025 era by default
  (`research/mcp-subscriptions.md` §4). A host that cannot subscribe is the common case,
  not a fault in lore, and the tool texts say so — because a client concluding "lore is
  broken" is this project's most expensive failure mode.

### 2.0.2 A subscription is not a way around D-23

**The MCP listen router authorizes nothing.** It matches an event's URI against the
`resourceSubscriptions` list the client asked for; the `resources.subscribe` capability
is declared once, for the server, and is not a per-resource decision. On the stock
in-process bus, any authenticated client could therefore subscribe to
`lore://review/<somebody else's id>` and be woken by every state change and every
finding on it.

Not the contents — reading the resource still goes through the ownership check. But
D-23 is that **possession of a review id is never authentication**, and §2.2 answers a
foreign id with NOT FOUND precisely so it cannot be used to confirm that an id is real.
A stream that wakes on that id confirms it, and says when somebody is working. It is
the same oracle one layer along, and an open stream would also outlive the revocation
of the token that opened it — making `make revoke` a false statement to an operator.

So delivery is filtered on the server, per event, against two facts that can change
after a stream opens: **who owns the review**, and **whether the token is still live**.
A subscription to a review that is not yours is accepted and then silent — the ack is
written before the filter is consulted and cannot be narrowed — which is the same
answer §2.2 gives, for the same reason: refusing loudly would confirm the id exists.

Raised by t2 against the commit that added subscriptions.

So: subscription answers *when*, `review_poll` answers *what*, and polling remains the
floor for every client that cannot reach the newer revision.

### 2.1 `review_poll` returns deltas

Each poll returns findings **new since the caller's last poll**, plus running
counts. A client that polls twice must not be shown the same finding twice — the
loop is driven by an LLM, and duplicate work is indistinguishable from real work.

#### 2.1.1 What a finding carries, and the three shapes

Always: `fingerprint` (the short id used in a `lore-ok`), `file`, `line`, `symbol`,
`severity`, `claim`, `evidence`, `failure_scenario`. Conditionally: `cwe`, and
`history` — what this codebase already knows about this defect, which is what tells a
client whether to fix the line or fix the habit (D-9).

Then **exactly one** of three shapes, and the shape *is* the instruction:

| shape | fields | what it means |
|---|---|---|
| open | `justify_with` | nobody has argued about it. Fix it, or answer with that line |
| open, refused | `justify_with` + `justification_rejected` | a reviewer read a reason and refused it. Worse than untouched: the code is wrong *and* an argument for it was believed long enough to be checked |
| closed | `settled` + `settled_because`, **no** `justify_with` | nothing to do; it is here only because it is new to this caller |

A closed finding usually arrives by D-51 — a justification this repository ratified in
an earlier review, carried forward and accepted without anyone re-arguing it.
`settled_because` names the original reason and when it was first decided. Writing a
`lore-ok` for one duplicates the marker already in the file, and every word submitted
is fresh surface for the next tier.

`checks_skipped` is present when a deterministic engine did not run — no installed
dependencies, no test script, a suite disabled for the deployment — with
`checks_skipped_note` beside it saying the same thing in a sentence a client can pass
straight on. Both are absent, not empty, when everything ran, so a client never has to
tell `[]` from "all of them".

It exists because INV-1 has a quiet failure mode on this surface. T0's engines go
missing without raising anything: `tsc` and `eslint` shell out through the target's
own `node_modules`, and a repository whose install fails simply produces no findings
from either. The model tiers are told in their prompt and the CLI prints it, so the
gap was only ever on the MCP side — where the client deciding whether to merge is.
A `passed` with `checks_skipped` means the tiers that ran agree, not that the tests do.

`failed_because` is present on `failed` and `expired`, carrying the reason the round
stopped. Without it a client sees the word and nothing else — which is INV-1's shape
exactly, since "did not run" and "found nothing" become indistinguishable to whoever
must act. Worse, it invites a diagnosis: a client given only `failed` reported that
its repository was not registered with lore, when the repository was registered,
mirrored, and had just authenticated with its own token. The true reason was a stale
mirror, and the message naming the fix already existed one table away.

`open_count` counts findings still open across the whole review, not just this poll.
It and the per-finding shapes are derived from the same definition of settled
(`spec/review-ladder.md` §3.3), so they cannot disagree; if they ever do, that is a
defect in lore rather than a fact about the branch, and a client should say so rather
than pick one.

### 2.2 `review_id` is a state handle, and handles get hijacked

MCP is stateless with no protocol-level sessions, so `review_id` is exactly the
"state handle" the MCP security guidance names as an attack surface (D-23,
`research/implementation-approach.md` §2). The spec's requirements are not
optional:

- **Possession of a `review_id` is never authentication.** Every `poll`, `submit`
  and `attest` re-verifies the bearer token *and* that the review belongs to that
  token's **repository** — not merely to its principal (D-69). Tokens are minted per
  repository while this was checked per principal, and a workgroup provisions every
  repository to the same human, so the check was doing nothing: one person's token for
  repo A read their reviews of repo B. A client reported seeing another repository's
  branches through its own token.
- **A valid id from elsewhere fails as NOT FOUND**, never as forbidden. "This exists
  but is not yours" confirms to an unauthorized caller that the id is real, and an id
  is the one thing worth guessing.
- **Handles are CSPRNG-generated**, never sequential. The moment ids are guessable,
  every log line that contains one becomes a credential.

Cheap now, expensive to retrofit.

### 2.3 Operator status (D-26)

A view for the operator, not for clients — `review_poll` already serves clients.

Active reviews and the tier each is on; queue depth and what is waiting on what;
rate-limit headroom per provider; model usage and spend from the usage log (§6);
failed and expired reviews with their reason.

Its job is to answer one question: **is parallelism actually running, or silently
queueing?** Those look identical from the client side, and only one of them is
fine.

## 2.3.1 `ticket` is required, not optional (D-38)

Most merges here are task-based, so `review_start` **fails without ticket text**.

A reviewer that does not know what the change was *meant* to do can only ask "is
this code correct?" — never "is this the right code?". With the ticket it gains the
axis that matters most for vibecoded work (`spec/review-ladder.md` §6.2): did the
change do what was asked, only what was asked, and all of what was asked.

Plain text, pasted by the client. The `plane` MCP server is already configured in
this workgroup, so a client can fetch the ticket body from there — but `lore` takes
text and does not integrate with any tracker. One less thing to break.

## 2.3.2 A review is pinned to a snapshot (D-40)

Reviews are **started explicitly**. Never one per commit.

Once started, a review sees exactly one tree: the one it began with, plus whatever
arrives via `review_submit`. **Commits pushed to the branch during a review are
invisible to it.** To review those, start a new review — it begins at the branch tip
as it then stands.

This keeps a review deterministic: it always converges on a tree that stops moving,
rather than chasing a branch that does not.

**Consequence for the attestation, and it matters: the signature covers a tree hash,
not a branch name.** If the branch has moved since, the attestation does not describe
what is now there, and merging on the strength of it would be wrong. The tree hash is
in the signed line precisely so this is checkable rather than assumed.

## 2.4 Two-stage review (D-34)

At 30 PRs a day nobody waits for a full ladder. The review splits:

| stage | tiers | latency | how it is consumed |
|---|---|---|---|
| **fast** | T0 + T1 | seconds to ~a minute | inline — you wait for it |
| **deep** | T2 + T3 | minutes | asynchronous — collected later, in batches |

`review_start` runs the fast stage and `review_poll` returns its findings almost
immediately, so the developer keeps moving. The deep stage continues in the
background and its findings land whenever they land.

**A fast pass is not a pass.** `fast_clean` is its own state and is never reported
as `passed`. Only the full ladder produces `passed`, and only `passed` supports an
attestation. This is INV-1 in a new disguise: "the cheap tiers found nothing" must
never read as "the branch is clean".

### 2.4.1 `review_inbox`

With deep findings arriving asynchronously across dozens of open reviews, polling
each one individually does not scale.

`review_inbox()` returns deep findings across all the caller's reviews **in this
token's repository** since they last collected — the batch view the workflow actually
needs. Per-review `review_poll` remains for driving a single review to completion.

Without this, a developer with 30 open reviews either polls 30 ids or loses
findings. Both are failures.

Each entry carries `highest`, the worst severity among its new findings, so a client
can triage 30 reviews without reading 30 lists. It is **computed over the whole set**,
not taken from the first row — reading position 0 was how it came to report `low` for
a review whose worst finding was `medium` (D-50, `spec/review-ladder.md` §3.2). The
findings themselves are ordered worst first, there and in `review_poll` — except that
findings the branch did not cause sort **below** the ones it did, whatever their
severity (D-68). Ordering is what a reader acts on, and severity alone put two
inherited pattern matches in untouched test fixtures above three spec contradictions
in files the author had written.

When a review is parked at `needs_human`, the inbox and `review_poll` both carry
`open_questions` — **the question itself**: both contradicting statements in full and
where each came from. The state whose entire purpose is *a person must decide this*
shipped saying only that there was something to decide, and a client said plainly that
it could not surface a question it was never given. Being told to escalate something
unnamed leaves only inventing it or dropping it, and inventing it is what this service
forbids everywhere else.

### 2.4.2 One review per branch

`review_start` refuses a branch that already has an open review, naming the one to
continue. The ladder reaches its deep, independent tiers only by ADVANCING — findings
carry forward, ratified justifications stay ratified, severity escalates where an
answer did not hold — so a restart discards all of it and re-pays the cheap tiers.
Measured before the refusal existed: six reviews of one branch in two hours, and 13 of
30 reviews stopping at round 1, on a repository that produced no verdict all day.

Refused rather than silently returning the open review: handing back an id that is not
the one asked for is a quiet substitution. `restart: true` is the deliberate way
through when a rebase or force-push has made the pinned snapshot meaningless.

## 3. Review state machine

```
  queued
    │
    ▼
  running(Tn) ──┬──► findings_ready ──► awaiting_diff ──┐
                │                                        │ review_submit
                │                                        ▼
                │                                   running(T1)   ← reset, not resume
                │
                ├──► tier_clean ──► escalate ──► running(Tn+1)
                │
                └──► top tier clean ──► passed ──► attested

  any state ──► failed | expired
```

**Reset to T1 after a diff, never resume.** A fix is unreviewed code, and the
cheapest tier is the cheapest possible regression check.

`failed` and `expired` are **not** `passed`. A review that did not run is not a
review that found nothing (INV-1) — the invariant that outranks everything else,
restated here because this is where a hosted service would be tempted to blur it.

## 4. Applying a diff without committing

`review_submit` applies the client's diff to the review's private worktree. Nothing
is committed and nothing is pushed; the client remains the owner of its own history.

**The client sends a `tree_hash` and the server verifies it after applying.** Without
it, a partial or fuzzy apply leaves the server reviewing code that exists nowhere —
not in git, not on the client's disk. A mismatch is a hard failure, never a warning:
reviewing the wrong tree produces confident findings about code no one has.

## 5. Concurrency

- One worktree per active review, off a shared bare clone per repo.
- Reviews are queued when a provider's concurrency cap is reached. **A review that
  dies on a 429 is a review that did not run**, so backpressure queues rather than
  fails.
- A client going away cancels nothing — neither stopping its polling nor closing a
  `subscriptions/listen` stream. Cancellation is explicit (`review_cancel`). A dropped
  connection is far more often a client crash or a network blip than an intention, and
  a review killed by one is spend already burned for no verdict.

## 6. Usage logging

No billing (D-13), but every model call is recorded: repo, review, tier, model,
tokens in/out, latency, outcome. This is what turns the subscription question
(D-17) from a guess into arithmetic, and what shows whether parallelism is actually
hitting rate limits.

## 7. Attestation

One line, signed (D-15):

```
lore: reviewed <tree-hash> against this repo's rules and lore's own rules —
3 tiers, 47 findings, 44 fixed, 3 justified.  [ed25519:<sig>]
```

It asserts **what was done**, never that the code is flawless. "Our models stopped
finding things" does not imply "no defects remain", and the first bug that ships
behind an overclaiming badge is the one that discredits the whole service.
