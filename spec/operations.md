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

| condition | why it is urgent |
|---|---|
| **replica behind the database** | the knowledge base *is* the product; losing it loses everything the workgroup taught it. Measured as *behind*, never as *recently written*: litestream writes only when there is something to replicate, so an idle database and a dead replicator look identical under a freshness test |
| **heartbeat missed** (§3) | the service is down, or the monitoring is |
| disk > 90% | the sandbox's `node_modules` cache grows without bound and is by far the largest thing here — 3.4 GB against 200 MB of repositories, measured 2026-08-05. Worktrees are reclaimed on completion (§6) and are no longer the risk |
| provider auth failure | every review stops at once |
| **daily spend ceiling hit** | a runaway loop at $500–2,600/month can burn fast — but see §4: under a subscription this cannot fire at all |
| all reviews failing over a window | systematic breakage, not a bad branch |

### 2.2 Ticket — next working day

Elevated review failure rate; spend anomaly against trend; a mirror `make status`
shows in red (D-65 — the host refresher has stopped or cannot reach the remote, which
lore itself cannot detect); disk > 75%;
queue depth sustained high enough that reviews are waiting on CPU
(`spec/deployment.md` §3); `needs_human` findings ageing without resolution.

The `plane` MCP server is already configured in this workgroup, so filing these as
tickets is natural. Not a dependency — a webhook is the transport and Plane is one
consumer.

### 2.3 Log only

Individual review failures, individual model retries, normal escalation. Loud
enough to debug from, quiet enough not to train anyone to ignore alerts.

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
