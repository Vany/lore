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

Twelve, registered with **underscores**. The dotted form is prose, not an address —
every document here once used it and an agent following them literally called
nothing.

| tool | arguments (`*` required) | returns |
|---|---|---|
| `review_start` | `branch*`, `into*`, `ticket*`, `pull_request`, `type` | `{review_id, state: "queued", note}` — returns immediately |
| `review_poll` | `review_id*` | `{state, clean, note, new_findings[], open_count, human_decision?}` — §2.1.1 |
| `review_submit` | `review_id*`, `tree_hash*`, exactly one of `diff` / `commit`, `fixed_elsewhere` | `{review_id, state, tree_hash, fixed_elsewhere_skipped?}` — §4.2 |
| `review_cancel` | `review_id*`, `reason` | `{state: "cancelled", stopped_in_flight, findings[], note}` — §2.5 |
| `review_attest` | `review_id*` | the signed line, with its tree hash |
| `review_inbox` | — | `{reviews[], needs_human, note}` — every OPEN review of the caller's, each with `waiting_on` and `expires_at` — §2.4.1 |
| `review_vex` | `review_id*` | `{summary, untriaged, document}` — CycloneDX VEX |
| `knowledge_query` | `path`, `contains` | `{count, items[]}` |
| `knowledge_teach` | `statement*`, `why*`, `path`, `kind` | `{id, recorded}`, plus `cite_as` for a `policy` |
| `knowledge_retire` | `rule*`, `why*` | `{retired}` — withdraw a development rule (D-83) |
| `knowledge_resolve` | `keep*`, `retire*`, `reason*` | `{resolved, retired, note}` |
| `knowledge_escalate` | `left*`, `right*`, `note*` | the conflict, raised for a person |

`kind: "policy"` records a **development rule**, which a finding can be appealed to:
`lore-ok[<fingerprint>]: rule <cite_as> — <why it covers this code>`. Reviewers are told
how many exist, never what they say; the text travels with the appeal that cites it, and
the tier rules on it (D-83). `knowledge_retire` is the other half — a rule that cannot be
withdrawn is a check that cannot be switched back on.

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

Its `findings` carry the store's raw `fingerprint` column — the full 64-hex digest,
not the 8-hex form `review_poll` hands out under the same field name — because
`buildVex` keys verdict lookups off that exact value. Each entry also carries `short`,
the 8-hex form `lore-ok[...]` actually accepts; a client recovering lost findings from
this resource (§2.1.1 — polling can't replay them) uses `short`, not `fingerprint`.

One prompt, `review(branch, into, ticket)`, drives the whole loop. It exists because
an agent handed only tools improvises the multi-round, stateful part, and improvises
it wrong.

### 2.0.1 Being woken instead of asking (D-80)

`lore://review/{review_id}` is also **subscribable**. The server declares
`resources: { subscribe: true }`, and a client on a 2026-07-28 connection opens

```jsonc
{ "method": "subscriptions/listen",
  "params": { "resourceSubscriptions": ["lore://review/<id>"] } }
```

**Unwrapped, exactly as shown.** A `notifications`-wrapped `params` is accepted and
acknowledged but never delivers — measured against the real wire, not just the
in-process harness, which cannot tell the two shapes apart (`subscribe.test.ts`,
"still honours a subscription a client builds for itself"). `subscribeTo` (server.ts)
emits the unwrapped shape for exactly this reason: it is the one proven to work.

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

### 2.0.3 When to come back, measured

`review_start` and `review_poll` return `check_back_after_ms` while a review is
`queued`, `running` or `fast_clean` — the **median completed round of the tier the
ladder is currently on, on this repository**, taken from `usage.latency_ms`. Not in
`findings_ready`: there the next move belongs to the client, and an interval would read
as permission to sleep on findings that are already its problem.

**Scoped per repository, because the note claims it is.** One `lore.db` serves every
repository a workgroup provisions, and their branches are not alike: a monorepo's 741 KB
diffs and lore's own 80 KB ones take the same tier wildly different times. Pooled, both
clients were handed one number and told it was *"measured on this repository"* — false
for at least one of them, in a field neither can check. The honest cost is that the
sample shrinks: a tier below the floor for a repository now gets **no** interval rather
than another repository's, which is the same trade as the thin-sample refusal below.

**This is not the progress estimate §2 refuses.** *"How far along is this review"* stays
unanswerable and stays refused. *"Nothing can have happened before the median round of
this tier"* is a fact about the tier, and it replaces an instruction that was costing
real money: every text used to say *"poll again in 10s, backing off to 60s"* against a
measured t1 median of 323s and t2 of 820s — seven to fifteen calls that could not
possibly return anything, each one a turn for an agent client.

**It is conditioned on how long the round has already run**, and that is not a detail.
The first version returned the median whatever the clock said, so a client that came back
at the median and found the round still going was sent away for another whole median — on
t2 that put it back at 1,528s for an answer written at 900s. The number now answers *how
much longer, from here*: the median of the runs that lasted at least this long. Measured
on this deployment, a t1 round at 322s elapsed goes from "322s more" to **109s**, and a t2
round at 764s from "764s more" to **183s**. At elapsed zero it is the plain median, so the
first call is unchanged.

**So the client must re-read the field, not cache it**, and the note says so in those
words. Reusing the first interval is precisely how a client waits twice as long as it
needs to.

**The run count in the note is the conditioned one**, not the sample size, and the
difference is the reader's whole basis for trusting the number. A t2 round 1,500s in is
compared against the two recorded runs that lasted that long, not against all 34 —
reporting 34 made the estimate look *more* certain exactly as the evidence behind it
shrank, in the one field that exists for a client to check it with. The note carries
both: the conditioned count it was computed from, and the full sample it came out of.

**Past every completed run, it says so and offers a short floor.** There is no
distribution left to ask, and substituting a median at the moment the data ran out is
inventing it. The note also says this is not a sign of failure — deep rounds have a long
tail, and a client told otherwise reports lore as broken.

**Elapsed and the distribution must measure the same thing**, and they did not. The
distribution is `usage.latency_ms`, which times the model session alone; elapsed came
from `tier_run.started_at`, which was stamped when the round was *entered* — before T0's
engines, before the document ingest, and before the knowledge screen's own model call.
Everything in that gap counted as elapsed against a distribution containing none of it,
so the wait shrank too fast and the overdue branch could tell a client the round had
outrun every recorded run before the tier had been asked anything. The stamp is now taken
where the tier's own work begins.

**Elapsed is asked of the tier being paced**, not of whatever round is open. During T0
the only open `tier_run` is T0's while the ladder cursor already points at the model
tier — so answering with any open row compared a T0-window elapsed against the model
tier's latencies. On a repository whose T0 takes minutes (this deployment has measured
~21), every poll from a few minutes in reported the model round as past every recorded
run before it had been asked anything, and then the advertised wait jumped back **up**
when the model's own row opened, contradicting the field's own promise that it only
shrinks. Before the tier starts there is no elapsed, which is the honest answer and the
one the caller wants: the first call gets the plain median.

**It is still not exact, and the note no longer claims more than it can support.** The
provider gate can queue a session behind another review's, inside the call and invisible
here, so the overdue sentence says the round has been **open** longer rather than working
longer, and says plainly that a round can wait behind another before it is asked
anything. A client told "this has run longer than everything we have measured" about a
round that has not started would report lore as broken, which is the failure mode this
whole field exists to remove.

**And the note names which clock it means**, because that sentence has already been
wrong once: it said the count ran "from when the round began" in the same change that
moved the stamp to the tier's own start. A client that has been waiting since
`review_start` reads that as including T0, so on a repository whose T0 takes ~21 minutes
the note's own explanation cannot account for the gap and the reassurance collapses. It
now says it counts from when **that tier** began, after the deterministic checks. A test
in `pace.test.ts` holds the claim, since prose about a measurement drifts from the
measurement exactly as easily as a doc drifts from code.

**It refuses rather than guesses**, on D-58's rule: fewer than 20 completed runs, or a
p90/p10 spread above 6, and no number is offered. t3 is the live example — n=12 across
126s–1691s, which is early refusals and real reviews pooled together, and a median of
that describes nothing. Failed runs are excluded for the same reason: they measure how
fast a tier can die.

### 2.0.4 The templates are invisible to at least one real client

`resources/templates/list` is a separate call from `resources/list`, and §2.0 has always
said a client reading only the latter never sees the templates. **Measured 2026-08-06
against Claude Code:** its resource-listing tool returns the five `lore://docs/*` and
neither template. So `lore://review/{review_id}` — the resource the whole subscription
design points at — is readable by a client that constructs the URI and undiscoverable by
one that lists.

The consequence is a documentation obligation, not a code one: every text that expects a
client to read that resource must spell the URI out, because the client cannot find it.

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

**Not every entry is "an engine did not run."** One kind is D-83's suppression
notice — an engine finding an ACCEPTED APPEAL silenced, quoting the development
rule's full statement verbatim (the client's channel is the audit trail and is
meant to carry the whole reason; the reviewer's own prompt gets only "a rule
exists", never what it says). That statement is TEAM-authored text, not lore's
internal vocabulary, so it is exempted from the same translation every other entry
gets, found by lore's own review (c1a9d4b6, fcf8e8cd) — a rule whose wording happens
to contain a URL or the word "opencode" is quoted exactly as written, not rewritten
into something the team never said.

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

## 2.3.3 Folder mode: a review with no base (D-130)

`review_start` normally diffs `branch` against `into`. Pass `mode: "folder"` and
`path` instead to review what is *at* a path — no base, no diff, every file read as
it stands rather than as a change. `into` and `path` are mutually exclusive; the
schema refuses either combined with the other mode.

**Mechanically, a folder review is a diff against git's well-known empty-tree
object** (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`, present in every repository
with no setup), scoped to `path`. That is what lets every consumer downstream of a
diff — T0, the model prompts, finding storage, `preexisting`/D-68, `review_submit`,
the ladder, attestation — work unchanged: none of it knows or cares whether the diff
came from two branches or from nothing. See `spec/review-ladder.md` §6.4 for the
scope semantics this produces.

**`path` has no default.** Pass `"."` to mean the whole tree explicitly; there is no
silent fallback to the repository root. A whole real repository's diff-against-empty
usually exceeds the diff size ceiling (§2.3.2's sibling concern, `MAX_DIFF_CHARS` in
`src/git/diff.ts`) and every tier that reads a truncated prompt spends real quota on
a prefix of the repository — an unscoped default would make that easy to trigger by
accident. Naming `path` explicitly is the same "refuse rather than infer" shape as
`into` failing loudly on a name lore cannot find, applied to scope instead of a ref.

**`mode` is an explicit enum, not inferred from an omitted `into`.** A client that
forgets `into` today gets a clear schema error naming the missing field. If omission
silently meant folder mode instead, that same mistake would silently review the
wrong thing at the wrong scope rather than fail loudly — the opposite of what every
other refusal in this surface is for.

**One-review-per-branch (§2.4.2) is keyed on `(branch, path)`, not `branch` alone.**
A folder review of `src/payments` and a diff review of the same branch are different
work, and so are folder reviews of two different paths on the same branch.
`pull_fresh` on an open folder review has to repeat the same `path` to find it,
exactly as it already has to repeat the same `branch`.

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

`review_inbox()` returns **every review of the caller's that is still open** in this
token's repository, together with any deep findings that have arrived since they last
collected — the batch view the workflow actually needs. Per-review `review_poll`
remains for driving a single review to completion.

Without this, a developer with 30 open reviews either polls 30 ids or loses
findings. Both are failures.

Each entry says **whose move it is** in `waiting_on`, and when the review will be taken
away in `expires_at`:

| `waiting_on` | states | what the client does |
|---|---|---|
| `you` | `findings_ready`, `findings_stale`, `awaiting_diff`, `needs_human`, or anything with uncollected findings | collect, answer with `review_submit`, or get a person |
| `lore` | `queued`, `running`, `fast_clean` | nothing — and specifically **not** a second `review_start` for that branch (§2.4.2) |

`expires_at` is `updated_at` + the retention sweep's `staleHours`, read from one
constant so the deadline stated and the deadline enforced cannot differ. It is absent
on a terminal review, which the sweep never touches.

**An open review appears here even when it has nothing new to collect**, and for most
of this service's life it did not: the filter was "has undelivered findings, or is
`needs_human`". A session that polled, began fixing and then ended left a review parked
in `findings_ready` with its deltas consumed — and the next session, making the call
whose entire stated purpose is *what is waiting for me*, was told nothing was. The
review then held a pinned worktree until the sweep called it `expired`, which by INV-1
never means "found nothing". Measured on lore's own repository: `rev_uFMG9` sat exactly
so for two days. A terminal review still appears while it holds undelivered findings —
a cancelled review hands its findings over and they are real — and drops out once they
are taken, because then there is nothing to come back to.

Each entry carries `highest`, the worst severity among its new findings, so a client
can triage 30 reviews without reading 30 lists. It is **computed over the whole set**,
not taken from the first row — reading position 0 was how it came to report `low` for
a review whose worst finding was `medium` (D-50, `spec/review-ladder.md` §3.2). The
findings themselves are ordered worst first, there and in `review_poll` — except that
findings the branch did not cause sort **below** the ones it did, whatever their
severity (D-68). Ordering is what a reader acts on, and severity alone put two
inherited pattern matches in untouched test fixtures above three spec contradictions
in files the author had written.

**`human_decision` means a person already answered, and the client must not ask again**
(D-99). A contradiction can be settled directly on the operator board, which resumes every
review it blocked — and from the client's side that is indistinguishable from an ordinary
requeue. Its standing instruction for `needs_human` is to take the question to its user, so
without this field it would ask somebody who has already decided and might get a second,
different answer. It names what was decided and by whom, and it is returned on EVERY later
poll rather than once: whichever session is alive when the review next moves needs the same
fact, which is the same argument `review_inbox` rests on.

When a review is parked at `needs_human`, the inbox and `review_poll` both carry
`open_questions` — **the question itself**: both contradicting statements in full and
where each came from. The state whose entire purpose is *a person must decide this*
shipped saying only that there was something to decide, and a client said plainly that
it could not surface a question it was never given. Being told to escalate something
unnamed leaves only inventing it or dropping it, and inventing it is what this service
forbids everywhere else.

### 2.4.1.1 `pull_request` — asked for every time, required never

`review_start` takes an optional `pull_request`: the http(s) URL of the change this
branch is proposed in.

**Optional, and it had to be.** Required would have failed every `review_start` from
every client already working the moment it deployed — three people on one repository —
and lore's own reviews are cut from scratch `review/<sha>` refs that have no pull request
at all. A missing link must never turn into a review that did not run (INV-1). So the
docs ask for it in the strongest terms a document has, and the schema does not punish its
absence.

The reason it is worth asking for is not bookkeeping. The operator board shows a **branch
name**, which is not clickable and does not say which repository or forge it belongs to;
with the URL, a person goes from *what is this review doing* to the change itself in one
click. The tool text also tells a client not to construct one from a pattern: a link to
the wrong change is worse than no link.

**`http(s)` only, checked at the boundary.** The value is rendered as an `href` on a page
that needs no credential, so a `javascript:` URL would be a script chosen by whoever
started the review, running in the operator's browser, on the exact page they open when
something is wrong. The page re-checks the scheme before linking, because rows written
before the validation existed are still rows.

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

**And a restart CANCELS the review it replaces — fixed 2026-08-14, found by Vany as a
"clash between cancelled reviews".** The flag used to fall straight through to creating
the new review and touched nothing, so the old one stayed open: two live reviews of one
branch, racing rounds against two pinned trees, burning double quota and raising two
sets of findings for one PR. Measured: `feat/RIGID-129` accumulated seven overlapping
generations this way, ended only by the operator mass-cancelling from the board. Now the
predecessor ends exactly as `review_cancel` would end it — `cancelled`, findings handed
over, the reason recorded as *superseded by a restart* — in the same call, state first,
so a round claimed in that instant finds a terminal review before spending. One live
review per dedup key is now an invariant of `review_start` rather than an etiquette —
the key itself is `(branch, path)` since D-130 added folder mode (§2.3.3), not `branch`
alone, so a diff review and a folder review of the same branch are correctly two.

**A second, still-live token of the SAME principal hits this refusal with no legal
way through, found by lore's own review (5e53c948) — the ordinary shape of a token
rotation's overlap window.** `review_poll` and `review_submit` are bound to the token
that STARTED the review (D-78), so the id this refusal hands back answers NOT FOUND
to the caller's new token. The refusal now says so and names `pull_fresh: true` as
the way through unconditionally, not only "if you pushed more commits" — `pull_fresh`
is repo-scoped, not token-scoped, so it works for this caller regardless of which
token started the review.

**Unconditionally offering it oversold what it does when origin has not moved,
found by lore's own review (393cf295) — the exact case the sentence exists for.**
Rotation overlap with nothing new pushed leaves origin unchanged, so `pull_fresh`
takes its `status: "unchanged"` reply — no re-pin, no requeue, nothing carried
forward — and hands back "push your commits, then call again" to a caller with no
commits to push. The message now says which of two things applies: if
anyone has pushed since, `pull_fresh` re-pins and carries everything forward, same as
always; if nobody has, it changes nothing, and the reliable way through is asking a
person to revoke the stale token instead. A revoked binding falls back to repository
scope (`mine`, D-78) rather than stranding the review, so poll and submit on the
caller's current token work immediately once that happens — no re-pin needed, and
independent of whether origin has moved. Revoking is CLI-only (`make revoke`, §1),
an operator's move, so the message names it as the ask rather than attempting it.

**`restart: true` refuses a colleague's review rather than cancelling it, found by
lore's own review (8d847ca4).** The dedup lookup behind this whole section is
repo-scoped, not principal-scoped, on purpose — §2.4.2's opening paragraph is two
teammates being told about each other's open review of one branch so neither
duplicates the other's work. That is a reason to *tell*, not a licence to *destroy*:
`restart` cancels whatever it finds open the same way `review_cancel` does, and
`review_cancel` has always refused a review that is not the caller's own (`mine`,
D-78). Before this fix `restart` used the repo-scoped lookup to decide what to
cancel with no such check, so one principal's `restart: true` on a branch could
cancel a different principal's in-flight review — every justification it had
ratified, any model call still running — with nothing to warn either side. The
check is by principal, not by `mine`'s full token binding: restart hands over no
data, it only destroys-and-replaces, so the caller's own review must stay
restartable from a rotated token exactly as §2.4.2's token-rotation paragraphs
above already promise.

**`pull_fresh: true` had the identical gap one paragraph over, found by lore's own
review (aa8cc149) against its own fix above.** It reads the same repo-scoped `open`
and was never checked against the caller's principal either — and unlike `restart`,
which at least *sounds* destructive, `pull_fresh` is documented as the safe
continuation, so a colleague reaching for it had no reason to expect harm. It is
worse in one respect: re-pinning recuts the worktree, and a submit is applied and
never committed (D-40, §4), so fixes the actual owner had already submitted but not
yet committed exist nowhere else — a colleague's `pull_fresh` could discard them
outright, reset the round bounds, and re-queue the review, all under the colleague's
action. Fixed the same way, by principal, before capability is even asked about: a
build with no `repin` wired at all must still refuse on ownership first, never fall
through to "this build cannot re-pin a review" for a caller who was never allowed to
ask in the first place.

### 2.5 `review_cancel` stops both ends, and says when it could not

`cancelled` is its own terminal state, not `expired`: expired means nobody came back,
cancelled means somebody decided. The findings already raised come back with it — the
tiers that ran did read the code — and everything learned about the repository is kept.

**Stopping means stopping in two places.** Abandoning the HTTP call does not stop the
model: an agent once went on reading a repository for millions of tokens after lore
had stopped listening. Telling opencode to abort does not free lore either — that was
measured on 2026-08-08, when three aborted sessions all answered 200 and the gate still
read `inFlight: 2` ninety seconds later, holding provider slots for reviews that no
longer existed until each hit its 2700s deadline. So `cancel` aborts the session **and**
the request: opencode stops the model, lore stops waiting for it.

**`stopped_in_flight` has three values, and they are three different claims.**

| value | claim |
|---|---|
| `true` | a call was running; it has been stopped at both ends |
| `false` | nothing was running |
| `null` | **this server could not look** — no reviewer was wired into it |

`null` exists because the deployed service answered `false` for months without being
able to look at all: `startHttp` was built with `store`, `worktreeFor`, `enqueue` and
`attest` and no reviewer, so the handler's `deps.reviewer?.cancel?.()` was
`undefined ?? false` on every cancel it ever served — rendered to the client as *"No
model call was in flight"* while a session opened seconds earlier ran on. A cancel that
cannot stop the model is worse than no cancel, because the operator sees a stopped
review and has no reason to suspect it is still billing. INV-1 applies to a cancel
exactly as it applies to a review: not knowing is a thing to say, not a thing to round
down to *no*. A deployed lore never answers `null`; the CLI and the tests can, and
`src/service/cancel-wiring.test.ts` is what keeps the deployment honest.

## 3. Review state machine

```
  queued
    │
    ▼
  running(Tn) ──┬──► findings_ready ──► awaiting_diff ──┐
                │         │                              │ review_submit
                │         │ 48h quiet (D-106)            ▼
                │         ▼                         running(T1)   ← reset, not resume
                │    findings_stale ── review_submit works here too; 7 days, then expired
                │
                ├──► tier_clean ──► escalate ──► running(Tn+1)
                │
                └──► top tier clean ──► passed ──► attested

  any state ──► failed | expired
```

**`findings_stale` is `findings_ready` wearing gray** (D-106). After `STALE_HOURS` of
silence the review dims instead of dying: everything still works — findings collectable,
`review_submit` accepted, the worktree held — for `STALE_GRACE_DAYS` more, counted from
the dimming. Then the sweep calls it `expired`, which still means *nobody came back*. The
board paints it gray; `review_inbox` keeps it under `waiting_on: "you"` with the real
deadline in `expires_at`.

**A closed tier stays closed** (D-6, revised 2026-08-07). A diff is re-read by the tier
that raised the finding, not by the cheapest one: the reviewer rules on the answer
(D-10), and resetting handed that ruling to a model which never asked the question.
`passed` therefore names the tiers that read the signed tree — see
`spec/review-ladder.md` §5.

`failed` and `expired` are **not** `passed`. A review that did not run is not a
review that found nothing (INV-1) — the invariant that outranks everything else,
restated here because this is where a hosted service would be tempted to blur it.

## 4. Applying a diff without committing

`review_submit` applies the client's diff to the review's private worktree. Nothing
is committed and nothing is pushed; the client remains the owner of its own history.

**The client sends a `tree_hash` and the server verifies it.** For a `diff`, that
happens after applying — without it, a partial or fuzzy apply leaves the server
reviewing code that exists nowhere, not in git, not on the client's disk. A mismatch
is a hard failure, never a warning: reviewing the wrong tree produces confident
findings about code no one has. `commit` checks earlier still — see §4.1.

### 4.1 `commit` — for a session that cannot diff (D-124)

`review_submit` takes exactly one of `diff` or `commit`, never both, never neither.
A review's tree is the pinned base plus every patch already applied, and that tree
lives only inside lore — a session that did not make the earlier submissions cannot
check it out, cannot diff against it, and cannot compute a matching hash. Before
`commit` existed, the only way through was `restart`, which discards every ratified
justification and re-pays the cheap tiers.

`commit` names a commit **already pushed to origin** — lore reviews what origin has,
never a working copy, and a commit it cannot see is refused by name. It is resolved
to a sha server-side (`git rev-parse --verify --quiet <ref>^{commit}`) before it can
reach any git argv, and normalised to the equivalent diff exactly once, so every
other path in this handler — the mid-round hold, the tree-hash check, the
fix-elsewhere notice — still works on a diff and cannot tell the two shapes apart.

**`tree_hash*` is checked twice for `commit`, not once.** Unlike a `diff`, whose
result tree genuinely cannot be known until it is actually applied, a commit's tree
is knowable directly — `resolved^{tree}` — so a mismatched claim is refused
synchronously, before anything is applied or held, naming the tree the commit
actually has (fingerprint 109d9211). What lands after that still goes through the
same after-applying check every `diff` gets: a verified claim and a verified result
are not the same guarantee.

**A `commit` cannot chain onto an outstanding `diff` hold.** A held raw diff's
claimed tree is the client's own local `git write-tree`, never pushed anywhere lore
can see — resolving it before the round ahead applies it fails as a missing object,
not an ordinary not-found. Refused by name until that hold is consumed; a second
`diff` is unaffected (chaining a raw diff is the client's own responsibility), and a
second `commit` chains correctly once nothing raw is outstanding.

### 4.2 `fixed_elsewhere` — a structured justification (D-133)

`review_submit` accepts an optional `fixed_elsewhere: {fingerprint, file, reason,
line?}[]`, answering a finding by pointing at where the fix actually landed instead
of writing a `// lore-ok[<fingerprint>]: ...` comment at the finding's own line. It
is ruled on exactly like a text marker — merged into the same `pending` set
`collectJustifications` builds, so the prompt, the silence-based ruling loop and
`settleFixed`'s exclusion set all see it identically. Silence next round records
`justified-accepted`; a re-raise records `justified-rejected`. No new verdict kind.

Validated INSIDE `withSubmitLock`'s callback, right where `patch` is finally known
for both `diff` and `commit` alike, and strictly before the held/applied fork,
`holdDiff`, and the apply itself all run — so a refusal here lands before anything
is applied or held, for either form:

- `fingerprint` must resolve against this review (`resolveShort`); if it does not,
  the **whole call** is refused. A fresh RPC argument naming a fingerprint this
  review never raised is a client mistake, not silently ignored data.
- `fingerprint` must not be AMBIGUOUS either — `resolveShort` throws when a short
  prefix matches more than one finding (§3.1.2 of `spec/review-ladder.md`), and
  this is caught and rephrased with the same D-133 framing rather than left to
  escape as a generic error.
- `file` must be part of **this submission's own** diff or commit
  (`filesTouchedByDiff`, which — unlike `filesInDiff` — also counts a file the
  diff DELETES: removing the whole buggy file is often the strongest evidence a
  claim can offer); otherwise the whole call is refused. Silence over a file the
  tier was never shown is not evidence of anything — a `fixed_elsewhere` claim
  needs the same kind of evidence an ordinary `lore-ok` carries inline as prose.
- A fingerprint that resolves but names a finding already settled by an earlier
  round is not an error: it is silently skipped and named in the reply's
  `fixed_elsewhere_skipped`, since the claim simply arrived after it stopped
  being needed. Best-effort for a submission that ends up held — see below.

**Persistence itself is deferred for a HELD submission.** A claim recorded
immediately, regardless of outcome, would survive a held diff that later fails to
verify at consume time (`consumeHeldDiffs`: a fuzzy/partial apply, or a tree-hash
mismatch) — a claim with nothing behind it, exactly what the file-in-diff check
above exists to refuse. So a validated claim travels WITH the held diff
(`held_diff.fixed_elsewhere`) and is written to `fixed_elsewhere_claim` only once
`consumeHeldDiffs` confirms that SPECIFIC diff actually landed; a diff that is
instead dropped takes its claims with it, unpromoted. On the applied path the diff
is already verified by the time this callback returns, so recording immediately
remains correct.

`Pending.scope` for a `fixed_elsewhere` entry is taken from the **finding's own**
file/line, never the claim's — `expireStaleVerdicts` looks the hunk up at the
finding's original location, so a scope taken from wherever the fix actually
landed would expire on the wrong edit. The verdict therefore only expires if the
originally flagged code later changes, not if the "elsewhere" fix is later
reverted — an existing limitation the `lore-ok`-at-the-original-line form already
has, not a new one.

The claim's `file`/`line` are folded into the `Pending`'s `reason` text
(`collectFixedElsewhere`), not carried as a separate field — `Pending` has none,
and the prompt renders exactly one string per entry. Without this the tier ruling
on a claim saw only free prose with no location, unable to tell it apart from a
claim naming nowhere at all.

`fixed_elsewhere_claim` cascades on its review (`ON DELETE CASCADE`), matching
every review-child table except `held_diff` (which predates the convention and is
pre-deleted by hand instead — see its own schema comment). Without it, the
retention sweep's `DELETE FROM review` would violate the FK the first time any
review carrying a claim aged past retention, rolling back the whole sweep, every
hour, for ever.

The reply's `will_not_settle` preview excludes any finding with a `fixed_elsewhere`
claim on record AT ALL — not only one this same call made. A HELD submission's
claims are not promoted into `fixed_elsewhere_claim` until `consumeHeldDiffs`
confirms that diff landed, which happens mid-round, after that round's own pending
set was already collected — so a claim promoted that way is not ruled on until the
NEXT round, and a later, unrelated submit's preview must still exclude it (that
next round is exactly what the later submit enqueues). Otherwise the preview would
tell a client an answer already on file "will not settle", the exact
fires-on-the-correct-answer false alarm the preview exists to avoid.

## 5. Concurrency

- One worktree per active review, off a shared bare clone per repo.
- **Nothing waits for a model slot.** A round launches its opencode session as soon as a
  worker loop claims it; there is no internal semaphore and no in-flight cap (D-98). What
  bounds the service is admission: `review_start` **refuses** when 128 reviews are already
  open, naming the count, the limit and `review_cancel` as the way to make room.
  Backpressure at the door rather than in the middle — a refused client can act, while a
  client whose review is silently queued sees a state name and a clock and cannot tell
  that from a service that is stuck.
- A review that dies on a 429 is still a review that did not run, and that is now visible
  rather than absorbed: the provider refusing is loud and names itself, where waiting was
  neither.
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

**A folder review's line names its scope (D-130).** The tree hash is still the
whole worktree's — hashed identically for every review, so an attestation stays
comparable and checkable against `git rev-parse` the same way regardless of mode —
but the tiers read only `path`, and asserting "reviewed tree X" with no further
word would claim more than that. The line instead reads `reviewed tree <hash>
(scoped to <path>)`, so a reader who takes only the signed line — never the
unsigned audit trail — cannot mistake a scoped read for a full one.
