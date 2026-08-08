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

| condition | why it is urgent |
|---|---|
| **replica behind the database** | the knowledge base *is* the product; losing it loses everything the workgroup taught it. Measured as *behind*, never as *recently written*: litestream writes only when there is something to replicate, so an idle database and a dead replicator look identical under a freshness test. lore mounts the replica folder read-only so the beat can see it at all; a deployment that does not reports `unconfigured`, which is not green |
| **no replica whatsoever** | worse than a late one — there is nothing to restore from right now. Held back for five minutes after startup: litestream is a sibling container that starts *after* lore and Docker creates the bind path if it is missing, so an empty folder is the normal first seconds of every deploy. `/status` says so immediately regardless; only the unsolicited page waits |
| **heartbeat missed** (§3) | the service is down, or the monitoring is |
| provider auth failure | every review stops at once. Its own error type, raised where the provider's status is classified and paged by the worker — not folded into the failing-as-a-class window, which would spend ten more reviews proving the same thing before it fired |
| **daily spend ceiling hit** | a runaway loop at $500–2,600/month can burn fast — but see §4: under a subscription this cannot fire at all |
| all reviews failing over a window | systematic breakage, not a bad branch |

### 2.2 Ticket — next working day

Elevated review failure rate; spend anomaly against trend; a mirror `make status`
shows in red (D-65 — the host refresher has stopped or cannot reach the remote, which
lore itself cannot detect);
queue depth sustained high enough that reviews are waiting on CPU
(`spec/deployment.md` §3); `needs_human` findings ageing without resolution.

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

That is the same defect as the spend ceiling and the replica monitor, in the field a
dashboard reads first: a guard whose answer cannot vary is decoration a reader
believes.

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

`/status` and the heartbeat know about the queue, the replica, the database, the footprint
and — since 2026-08-08 — stale mirrors. They know nothing about a PROVIDER that has
stopped answering, which is the condition that stops the gate every review must clear.

It is the same class of fact as the stale mirror, and that one reported `ok: true` for
seventeen hours. The difference is that a stale mirror is a file lore can stat, and a
provider's remaining quota is not published by anybody (D-84, D-50). What lore can see is
the shape: repeated timeouts from one provider while another answers in seconds.

Not built. Recorded here rather than covered by a check that measures something else,
which is the failure §2.5 is about — and named so that a reader of this table does not
read its absence as coverage.

### 2.5 Disk is not lore's to alert on

**Removed 2026-08-06.** There were two disk conditions — page above 90%, ticket above
75% — reading the host filesystem through `statfs` and feeding `ok`.

**A full disk belongs to whoever owns the machine, exactly as a failing test suite
belongs to whoever owns the repository (D-71).** lore's entire footprint is under 5 GB
against a host at 826 GB used, so it was alerting in red, repeatedly, about a condition
it neither caused nor could fix — and one whose owner already has better tools for it.
Every alert it emitted that day was noise, and an alert channel is only worth having
while every entry in it is worth reading.

It also made `ok` a claim about the machine rather than about the service, and reached
into tests: the heartbeat suite asserted `ok: true` and passed all afternoon at 89%,
then failed the moment the host crossed 90% with nothing in the code having changed.

**The measurement is cached and never taken inside a request.** It was, and it took the
service down within a minute of deploying on 2026-08-08: one `readdir` plus one `stat`
per file, against 374,457 files in 7.1 GB, across a Docker Desktop bind mount where every
call crosses the VM boundary. `/status` stopped answering; `/healthz` kept saying `ok`, so
from outside the service looked alive while the endpoint that reports its health hung.

Worse than slow — `checkHealth` awaited it *before* reporting anything, so the integrity
and replica checks were queued behind it. **The thing that watches was blocked by the size
of the thing it watches**, and it degrades exactly as the cache grows, which is exactly
when the number begins to matter. A reader now gets the last measurement or `undefined`,
and a stale one schedules a walk it does not wait for; one walk at a time, hourly. A disk
budget is a slow-moving number and `undefined` was already the honest answer for "not
measured".

**What is genuinely ours is unmonitored, and that is stated rather than implied.** The
sandbox's `node_modules` cache grows without bound and is the largest thing lore
writes — 5.6 GB of its 7.1 GB total. That is a real growth curve with no ceiling and
nothing watching it. The right measure is lore's own footprint, not the host's
percentage, and it is not built; it is an open item in `TODO.md` rather than a gap
covered by a number that was measuring something else.


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

## 4. Spend control

Usage is logged per repo, tier and model (D-13). On top of that:

- a **daily spend ceiling**, which pages when hit and **stops starting new reviews**
  rather than continuing quietly,
- anomaly alerting against the trailing average.

A cheap tier looping on a pathological branch is exactly the shape that runs up a
bill nobody sees until the invoice. Stopping is the correct behaviour; a review not
started is honest, while a review that runs and cannot be paid for is not.

**The ceiling cannot fire under a subscription, and says so.** It sums `cost_usd`,
and both current providers bill a flat rate, so every usage row carries zero.
`/status` reports `spend_ceiling.metered: false` with a note that a zero means
*unmeasured*, not *headroom* — because "$0 spent against a $100 ceiling" and "nothing
here can measure spending" are opposite facts that look identical in a dashboard. A
guard that cannot fire must say so rather than being mistaken for one that looked.

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

## 6. Deploying without throwing work away (D-72)

    make deploy      drain, wait, rebuild, start
    make drain       drain and wait, nothing else
    make drain-off   change your mind

The worker stops **claiming**; everything else keeps working. In-flight rounds run to
completion, MCP serves normally, and new reviews queue for the next container.

A restart loses no state — it is all in SQLite — but an interrupted round is requeued
and re-run from scratch, so the cost is model time paid twice. `make drain` names what
it is waiting for and times out loudly rather than hanging.

The drain flag is cleared by the process that starts after it, so a forgotten drain
cannot leave a service that reports healthy while claiming nothing. `/status` carries
`draining`, because from outside a drained service and an idle one look the same.

## 7. Transport

A generic **outbound webhook**, with severity, condition, and a short human
description. It works with Slack, Alertmanager, a Plane integration or a shell script
without `lore` knowing which.

Configured per deployment. If the webhook itself is unreachable, that failure is
logged **and** surfaced by the heartbeat's absence at the far end — the one signal
that does not depend on our own alerting working.
