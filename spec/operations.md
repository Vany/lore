# Operations

Two audiences, two entirely separate channels. Conflating them is how one of them
gets muted.

| audience | who alerts them | how |
|---|---|---|
| **developer** | their own client | `lore` provides information; the client decides to shout (D-41) |
| **devops** | `lore` itself | outbound alerts about the *service*, not about any review (D-42) |

---

## 1. Developer-facing: information, never notification (D-41)

`lore` does not notify developers. It returns state and findings; the client decides
what deserves an alarm.

This is also forced by the protocol — **MCP servers do not initiate requests**, so
there is no push channel to a developer even if we wanted one.

Our obligation is therefore to make the information **unambiguous and
machine-classifiable**, so a client never has to infer urgency from prose:

- every finding carries an explicit `severity`
- `needs_human` is a distinct state, not a severity
- `fast_clean`, `failed` and `expired` are distinct states, never blended into
  "not passed"

And the agent docs tell the client plainly to surface `needs_human` and high-severity
findings through whatever alerting it has, rather than logging them
(`spec/agent-docs.md` §3).

## 2. Operator-facing: the service tells devops when it is sick (D-42)

Only about `lore` itself. A single review failing is a log line; **reviews failing as
a class** is an alert.

### 2.1 Page — someone should look now

Every row here is **sent by the heartbeat or by the worker — except `heartbeat
missed`, which by construction can be sent by neither.** That one is the deadman: it
is the far end noticing our silence (§3), so no code in this service can raise it, and
it is the only condition whose alerting path survives this service being dead. The
distinction matters because auditing coverage is exactly what this preamble is for,
and an unqualified "every row" told a reader that the watcher is watched from in here.
It is not.

Three of the rest were sent by nothing at all, for the whole of this service's life —
the replica, provider auth, and ageing `needs_human` — while this table listed them.
The conditions existed in `ops/alerts.ts` and nothing called them, and
`one-definition.test.ts` passed because it asked whether the exported table was read
rather than whether each route was. It checks members now. A page nobody is paged by
is not a page, and a routing table that lists a route nobody dispatches is a claim
about monitoring that does not exist.

**Ageing `needs_human` was wired unlatched — found by lore's own review
(eb3d53ea).** `findingsUncollected`, the sibling condition below, was fixed for
exactly this once already, with the reasoning kept in `ops/heartbeat.ts`'s own
comment: the beat runs every 60s and a parked review can stand for days, so an
unlatched send posts the identical ticket on every beat for as long as it lasts —
up to 1,440 copies in a day, before the sweep even starts its own 24h clock. That
is the wolf-crying this whole table exists to prevent, reintroduced in the
condition right beside the one it was already fixed for. Latched on the COUNT now,
the same way: a second review ageing past the threshold is new information and
speaks again; the same one standing for a ninth day does not.

| condition | why it is urgent |
|---|---|
| **replica behind the database** | the knowledge base *is* the product; losing it loses everything the workgroup taught it. Measured as *behind*, never as *recently written*: litestream writes only when there is something to replicate, so an idle database and a dead replicator look identical under a freshness test. lore mounts the replica folder read-only so the beat can see it at all; a deployment that does not reports `unconfigured`, which is not green |
| **no replica whatsoever** | worse than a late one — there is nothing to restore from right now. Held back for five minutes after startup: litestream is a sibling container that starts *after* lore and Docker creates the bind path if it is missing, so an empty folder is the normal first seconds of every deploy. `/status` says so immediately regardless; only the unsolicited page waits |
| **heartbeat missed** (§3) | the service is down, or the monitoring is |
| provider auth failure | every review stops at once. Its own error type, raised where the provider's status is classified and paged by the worker — not folded into the failing-as-a-class window, which would spend ten more reviews proving the same thing before it fired |
| all reviews failing over a window | systematic breakage, not a bad branch |
| **a paid route is now answering reviews** | a ticket, and the notice the 2026-08-16 incident did not have: at 05:06 a subscription hit its billing-cycle limit, the chain walked onto a metered twin, and the first thing to speak was a daily ceiling four hours and $101.36 later. Fires on the first REVIEW ROUND each UTC day that runs on a route lore reached rather than one the operator configured, naming the tier, the route and that call's cost. **It does NOT cover the other callers that can reach a paid route** — the hourly knowledge screen, the bootstrap survey and `propose` resolve a tier through `concreteRoute` and can hand opencode a metered twin under `LORE_ALLOW_METERED=1`, spending unattended with no ticket. That gap is recorded in `TODO.md` rather than papered over here: this row said "the first call" when it meant "the first round", which is the overstatement the alert exists to prevent, made about the alert itself An EVENT and not a threshold — no total is consulted, so D-121 stands — and it cannot fire under `LORE_ALLOW_METERED=0`, because no metered call happens |
| **high findings nobody has collected** | a ticket, and the last rotting condition with no channel (D-126). `make status` has listed these since D-96 and the operator is precisely who CANNOT act — the findings belong to another principal's token, and `review_inbox` is correctly scoped to it. Fires at 24h, on the branch's OWN high findings only (D-68): an alert that repeats the same inherited pattern match daily is one nobody reads. Excludes `cancelled` (findings handed over explicitly at cancel time) and `expired` (a week of escalating signal already given) — NOT `failed`, which shipped excluded by mistake and let a HIGH finding on `master` sit invisible for four days: a round can fail on its first attempt, with no warning and no handover |
| **a tier lore has stopped calling** | not an alert but a `/status` field and a `make status` banner (D-90): `tiers_not_being_asked` names any tier in a cool-off, with when it will be retried. Deliberately not a page — a cheap tier being down is degraded service, not an outage, and the ladder steps over it — but it was invisible from inside the service until it existed, and it is the single explanation for every slow review while it stands |
| **a review accepted but never queued** | `review_start` writes the row, answers `state: "queued"`, and enqueues afterwards — so a throw in between leaves a review with **no job**, and nothing reconciles that: `reclaimOrphanedJobs` frees jobs stuck `running`, not reviews that never got one. It would wait until the sweep called it `expired` two days later, which means *nobody came back*. The review is now marked `failed` with the reason, so the client's next poll says so; the page is because the process stays alive and `/status` still reads `ok: true`, exactly as for a dead worker loop — one missing job is invisible to everything else |

### 2.2 Ticket — next working day

Elevated review failure rate; a mirror `make status` shows in red (D-65 — the host
refresher has stopped or cannot reach the remote, which lore itself cannot detect);
queue depth sustained high enough that reviews are waiting on CPU
(`spec/deployment.md` §3); `needs_human` findings ageing without resolution; **high
findings nobody has collected** for over 24h.

**Spend anomaly against trend is GONE, deliberately** (D-121). It was listed here from the
day this file was written; the alert behind it was deleted with the ceiling, and leaving
the row would be exactly what §2.1's preamble forbids — a routing table naming a route
nobody dispatches. It matters more here than elsewhere: with no ceiling, a phantom
money ticket is the only backstop the doc would appear to offer, and an operator relying
on it would be relying on nothing.

**Queue depth counts jobs a worker could actually claim** (D-97), which is narrower than
"rows in state `queued`" and has to be. `claimJob` refuses a job whose review has ended,
and nothing used to close those rows — so they accumulated, unclaimable, and the depth
reported a backlog on an idle service. Measured: three such rows, the oldest nineteen
hours, while eleven workers sat idle and three model slots were free. This ticket would
eventually have fired on work that did not exist.

The `plane` MCP server is already configured in this workgroup, so filing these as
tickets is natural. Not a dependency — a webhook is the transport and Plane is one
consumer.

### 2.3 Log only

Individual review failures, individual model retries, normal escalation. Loud
enough to debug from, quiet enough not to train anyone to ignore alerts.

### 2.4 `/status` answers whether it is healthy, and can say no

`ok` was the literal `true` — on every beat, including the one that paged for a
critical disk. It is computed from the page-level conditions now, with `problems`
naming them, because `ok: false` alone is the same ambiguity pointing the other way.

That is the same defect as the replica monitor, in the field a dashboard reads first: a
guard whose answer cannot vary is decoration a reader believes. The daily spend ceiling
was the other example and is gone (D-121) — it could not fire under a subscription, and
the one day it could, it stopped eight reviews that had nothing to do with the bill.

### 2.4.1 An unreadable database is served, not died on

The one fault that ends the service outright, and the one it used to handle worst. On
2026-08-08 the database became malformed mid-review; the first statement after startup
threw, the process exited 70, Docker restarted it, and that loop would have run for ever.
For every second of it `/status` was a refused connection — which from outside is
indistinguishable from the machine being off, the port having moved, or Docker being
broken.

The heartbeat had been taught to check integrity on every beat the day before, after the
same fault went unnoticed for twenty minutes. It was no use, and the reason generalises:
**a check only runs while the service is healthy enough to run it.** A database bad enough
to kill startup kills the check that would have reported it — INV-1 one layer up, where
the thing that did not run is the thing that says whether things ran.

So the integrity check moved to the one moment that is always reached — immediately after
the open, on a fresh read-only connection, because the live handle answers from its page
cache. A fault does not exit. It:

- pages once, with the cause and the remedy (`CONDITIONS.databaseUnreadable`);
- starts **no** worker, heartbeat or sweep — writing into a damaged file is how a
  recoverable fault becomes permanent;
- serves `503` on every route. `/status` answers JSON with `ok: false` and the same
  `problems` key the healthy path uses, so a monitor needs no second shape; everything
  else, `/mcp` included, gets the plain-text refusal. Never `200`: a client handed a
  success with an error body carries on.

It does not retry, and says so. A malformed database is malformed on the next open too,
and restarting only overwrites the evidence in the logs.

### 2.4.2 A provider at its limit is invisible from in here

`/status` and the heartbeat know about the queue, the replica, the database and — since
2026-08-08 — stale mirrors. They know nothing about a PROVIDER that has
stopped answering, which is the condition that stops the gate every review must clear.

It is the same class of fact as the stale mirror, and that one reported `ok: true` for
seventeen hours. The difference is that a stale mirror is a file lore can stat, and a
provider's remaining quota is not published by anybody (D-84, D-50). What lore can see is
the shape: repeated timeouts from one provider while another answers in seconds.

Not built. Recorded here rather than covered by a check that measures something else,
which is the failure §2.5 is about — and named so that a reader of this table does not
read its absence as coverage.

### 2.4.3 The board — the same facts, for a person rather than a monitor (D-96)

`/status` answers *is it healthy* in JSON, for something that will page. It is a poor
answer to the question actually asked out loud four times in one week — **"what is
running right now, and why has that one been going forty minutes?"** — which needed a
shell into the container and three SQL queries every time.

`GET /` is that answer. One page, pushed over SSE at `/board/events`, with `/board.json`
for anything that would rather read once than hold a stream.

**Every review is collapsed, and collapsed carries four things**: its state, which step
it is on, how long it has been going in total, and **how long since anything moved**.
The last is the whole point, and its definition is load-bearing: the newest of the
review's own `updated_at`, any tier run's start or finish, and any finding's first
sighting. `updated_at` alone moves only on STATE changes, and a tier can read a
repository for twenty minutes without one — so a board built on it would report every
healthy deep round as stalled, and an operator who learned to ignore that would have
nothing left to notice a real hang with.

Two facts are pulled out of the detail into the collapsed row because they are alarms
rather than data:

- **`no tier`** — a `running` review with every tier row closed. That is the shape of the
  stall that once cost four and a half hours, and it was behind a click in the first
  version, which is one click more than an alarm may cost.
- **the stall clock turns yellow past twenty minutes and red past forty-five**, the
  latter being the hang this whole line of work started from.

A finished review's total **stops** — carried as `endedAt` rather than counted to now,
because a number that grows while nothing happens is this project's own failure mode
rendered in a table. Finished reviews stay for two hours: a verdict that vanishes at the
moment it arrives is the one you were watching for.

**It is pushed, and only when something changed.** A timer recomputes the snapshot every
two seconds while at least one board is open and writes nothing if the payload is
identical, so an idle board transfers nothing and every message means the picture really
moved. Elapsed times animate in the browser from absolute timestamps. The timer starts
with the first watcher and stops with the last — an unattended service does no work for a
board nobody has open. A poll rather than the event bus deliberately: `store.events`
fires on state changes only, by design, and this board is about what happens BETWEEN
them; wiring operator events into every write path is a change whose failure mode is a
silently stale board, and a poll cannot miss anything.

**A `needs_human` review carries the whole question, not the word.** Both statements that
cannot both be true, each with where it came from, and the two calls that end the block —
`knowledge_resolve` or `knowledge_escalate`. This is the one state where a person is the
mechanism: no tier, retry or sweep can move it, so the reader of this page is what the
state is waiting for. Printing the label alone is what the MCP surface did until a client
answered that it could not surface a question it was never given, and that guessing is
what lore forbids everywhere else.

Conflicts belong to the repository rather than the review, exactly as `review_inbox`
reports them. So a parked review with **no** open conflict is a real state — the question
was settled and nothing re-queued the review — and the board says that in words instead of
rendering an empty box.

**And the reader can answer it** (D-99). Each statement carries a button that says what
choosing means — *this one is right, and retire the other* — confirmed first, quoting what
is being kept, because a second click cannot undo it. `POST /board/decide` runs the same
`decide` as `knowledge_resolve`, so a decision made here and one relayed by an agent are
indistinguishable afterwards. The outcome is reported **outside the review list**: deciding
changes a review's state, which pushes a snapshot and rebuilds every row, so a message
written into the row is erased by its own success — and the case that most needs reading is
the one that survives least, *"decided, and NOTHING resumed, because another contradiction
still blocks these reviews"*.

The decision is unattributed and says so: the page holds no credential. Loopback-only was
written and removed — inside a container a browser's request arrives from the docker
gateway, so it would have refused every real use while looking like security. `knowledge_resolve`
is the attributed path.

**The branch links to its pull request** when the client supplied one at `review_start`
(`spec/mcp-api.md` §2.4.1.1). A branch name alone is not clickable and does not say which
forge it lives on, so the board was a place you read about a change and then went
searching for it by hand. Plain text when there is no URL — a dead link would be worse —
and the scheme is re-checked before rendering, because an `href` on a page that needs no
credential is somewhere `javascript:` must never reach.

**Each step carries its findings, collapsed.** Three levels: review → tier attempt →
finding. A finding opens to everything the tier said about it — claim, evidence, failure
scenario, CWE, the symbol, and the verdict that settled it where one exists. Grouping is
by `(origin, round)`, which is exactly how a `tier_run` is identified, so it is a join
rather than a guess; it was checked against the live database first, where every finding
matches. **A finding that matches nothing is shown as an orphan rather than dropped** —
the grouping is a presentation choice, and a presentation choice must never decide what
exists.

Two distinctions the list would otherwise lose:

- **settled findings say so** and do not count as work. A board where answered work looks
  like outstanding work is one whose reader stops trusting the numbers.
- **a tier that ran and raised nothing says "raised nothing"**, rather than showing an
  empty space that a tier whose findings are missing would also show (INV-1).

Full text is in the snapshot, not fetched on expansion — measured at 240/351/341
characters for claim/evidence/scenario and 7 KB for a whole active board, so a second
route could only add a way to fail while somebody is reading. Forty findings per review,
with the remainder **counted and stated**.

**Unauthenticated, on the MCP interface, on Vany's explicit call** knowing `LORE_BIND` is
`0.0.0.0`, and **so is the finding text** — asked for directly after the first version
shipped without it. That is a real widening: a claim names a defect in somebody's unmerged
branch, and it is now readable by anything that can reach the port. `/status` already
published the branch names; this publishes what is wrong inside them.

### 2.5 Disk is not lore's to alert on — none of it

**Removed in two steps, on one argument.** The host conditions went 2026-08-06: page
above 90%, ticket above 75%, read through `statfs` and fed into `ok`. **A full disk
belongs to whoever owns the machine, exactly as a failing test suite belongs to whoever
owns the repository (D-71).** lore was alerting in red, repeatedly, about a condition it
neither caused nor could fix, and whose owner already has better tools for it. Every
alert it emitted that day was noise, and an alert channel is only worth having while
every entry in it is worth reading. It also made `ok` a claim about the machine rather
than the service, and reached into tests: the heartbeat suite asserted `ok: true` and
passed all afternoon at 89%, then failed the moment the host crossed 90% with nothing in
the code having changed.

**The self-footprint budget replaced it, and went the same way 2026-08-12** — Vany's
call: *"it is not lore's responsibility."* It measured lore's own data directory against
a 10 GB budget it set for itself and raised a ticket over it. The argument that had kept
it — that lore's own growth is lore's to watch — is true about the growth and false about
the alert: disk on this machine is the operator's to size and the operator's to act on,
and lore knowing a number does not make it the one who acts. What it produced in practice
was a ticket on every beat, for a threshold nobody had agreed to, in the channel that is
supposed to carry real faults.

**What bounds the growth is the retention sweep, and it is not an alert.** The sandbox's
`node_modules` cache is keyed by lockfile and is the largest thing lore writes; the sweep
collects what is unused on a schedule. If it stops keeping up, that shows as disk on a
machine somebody owns, and that person has a monitor for it.

**What the removal also takes with it is a whole outage class**, worth recording because
the code is gone and the lesson is not. Measuring it once took the service down within a
minute of deploying, 2026-08-08: one `readdir` plus one `stat` per file over 374,457
files in 7.1 GB, across a Docker Desktop bind mount where every call crosses the VM
boundary. `/status` stopped answering while `/healthz` kept saying `ok`, so from outside
the service looked alive while the endpoint that reports its health hung. And
`checkHealth` awaited it *before* reporting anything, so the integrity and replica checks
queued behind it — **the thing that watches was blocked by the size of the thing it
watched**, degrading exactly as the cache grew. The cache-and-refresh fix that followed
was correct, and it is also gone: the cheapest version of a measurement nobody acts on is
not taking it.

## 3. The deadman: absence of signal must alert

**A monitoring system that fails silently is INV-1 at a different layer.** If the
alerting path breaks, "no alerts" and "everything is fine" become indistinguishable —
and this project exists because four reviews once failed silently in one day.

So the service emits a **heartbeat on a fixed interval**, and devops alerting fires on
its *absence*. That inverts the failure mode: a broken service, a broken network, a
broken alerter and a full disk all produce the same visible symptom — silence where a
heartbeat should be — instead of the same invisible one.

Push-only alerting cannot detect its own death. This is the difference between
monitoring and hoping.

## 4. Money: reported, never acted on (D-121)

Usage is logged per repo, tier and model (D-13). `cost_usd` is whatever opencode reported
for the call — lore holds no rate card and calculates no price. The figures reach
`/status` (`spendToday`, `spend_today_by_tier`) and the operator board, **and nothing
branches on them.** No total refuses a review, stops a round, suspends the queue or
expires anybody.

There was a daily ceiling that did all four. It was removed after the one day it fired: by
the time a total can speak the money is spent, and the people it stops are not the people
who spent it — eight reviews across three colleagues' branches, most at round 0, over a
bill an unrelated batch ran up four hours earlier. A gate that did not run is this
project's worst outcome, so trading an invoice for a stopped gate is the wrong trade.

**The one place money decides anything is the route (D-117).** A route is metered iff its
id begins with `openrouter/` — every other provider here is a flat subscription — and
`LORE_ALLOW_METERED` (default `0`) says whether a fallback chain may walk onto one. Asked
per call, before the call, from the id alone. When the answer is no the chain steps over
the metered entries; if none are left the tier is skipped, which is D-48's existing path
and reaches the client as `passed_partial` with the tier named in `checks_skipped` —
honest, free, and a weaker claim said out loud. A tier's OWN model is never filtered:
configuring `openrouter/x` *is* the operator switching it on.

`LORE_DAILY_CEILING_USD` **refuses to start the service** if it is still set. Believing a
number caps the day when none does is worse than having no answer at all.

**A failed call leaves a usage row too** (D-85), written with `outcome: 'failed'` and read
back from the session opencode leaves behind — before 2026-08-09 a call that timed out
recorded nothing while the provider counted every token. Anything reading this table for
latency or round counts should exclude that outcome; anything summing tokens across both
outcomes is currently wrong for a different reason, recorded in SPEC §3.

## 5. Reviews end, or they are ended (D-70)

**A review that is finished gives its worktree back at once.** Its tree hash is
already recorded, attestation reads only the store, and `review_submit` refuses a
finished review — so the worker releases the worktree the moment a review reaches
`passed`, `passed_partial`, `failed` or `expired`. An hourly sweep repeats this with a
zero-day window, prunes git records whose directory has gone, and deletes review rows
after 90 days. Findings and verdicts cascade with them; **knowledge never does**, and
has no foreign key to a review precisely so that it outlives one.

Release goes through `git worktree remove`, never a bare `rm`. git keeps its own
record under `bare.git/worktrees/<id>`, and deleting the directory leaves it listing
paths that are not there.

**Orphaned reviews are normal, not exceptional.** Measured across eleven of them on
2026-08-05:

- **Nothing obliges a client to finish.** It polls, collects the findings, and stops.
  The review then sits in `findings_ready` holding a pinned worktree until the
  staleness sweep expires it. This is the dominant cause, and it is a property of the
  loop rather than a fault in any client.
- **Restarting instead of continuing** accounted for four, all on one branch, before
  `review_start` began refusing a branch that already has an open review.
- **A round that fails** leaves a worktree its review will never use again.

Reclamation is therefore a routine duty rather than an error path. What must never
happen is an expired review reading as a clean one: `expired` is its own state, never
`passed`, because a review somebody walked away from told us nothing about the code.

## 6. Deploying drops the rounds in flight and restores them (D-72, revised by D-104)

`make deploy` is `make up`. It does NOT drain.

Draining — stop claiming, wait for every in-flight round, then swap — protected model time:
an interrupted round is requeued and paid for twice, and one morning that cost 109 minutes
of t2 work. That cost is real and it is the smaller one. What draining produced in practice
was a flag that outlived the deploy that set it, three times in one day: a timed-out
deploy, a backgrounded one that was interrupted, and one nobody watched finish. Each left
`draining=1` and the service answering `ok: true` while claiming nothing — once for
thirteen hours, with eight of the team's reviews behind it.

**A queue nobody can see is worse than work that has to run again.**

What restores the dropped rounds:

- `reclaimOrphanedJobs` at startup requeues any job left `running`, and says how many. Its
  attempts bound stops a round that reliably kills the worker from looping for ever.
- A round that CATCHES the interruption — `socket hang up`, `could not reach opencode` —
  is requeued rather than failed (D-104). That half was missing and ended two reviews on
  the first restart after the policy changed.
- **The kept sessions survive it** (D-80, made durable 2026-08-17). Vany: *"deployment must
  not kill the full ladder, may be one step."* The session ids were held in `Reviewer`
  memory and nowhere else, so a restart forgot every warm conversation lore was holding —
  while opencode still had all of them, its session store being a named volume that
  outlives the container. Every open review therefore re-read its whole diff cold on its
  next round, at full price, and nothing reported it. The ids are rows in `meta` now
  (`session-id:<review>:<tier>:<model>`), written when the session opens rather than when
  the round ends, because a round that dies mid-call is the case they exist for.

**So a deploy costs ONE STEP.** The interrupted member is re-asked; a member of the same
rung that had already answered keeps its rows and resumes its session, which costs one
`continue → done` exchange rather than a re-read. The ladder, the findings, the ratified
justifications and the pinned worktree were always in SQLite. A stored id that outlives its
session — opencode's volume replaced, its data pruned, a database restored from an older
backup — is forgotten on the 404 and the tier starts cold once, rather than failing that
tier on every future round.

`make drain` still exists for a deliberate pause. It is off the deploy path, so a deploy
that does not finish cannot leave it set.


## 7. Transport

A generic **outbound webhook**, with severity, condition, and a short human
description. It works with Slack, Alertmanager, a Plane integration or a shell script
without `lore` knowing which.

Configured per deployment. If the webhook itself is unreachable, that failure is
logged **and** surfaced by the heartbeat's absence at the far end — the one signal
that does not depend on our own alerting working.
