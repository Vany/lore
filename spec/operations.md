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
| **backup replication stale > 1h** | the knowledge base *is* the product; losing it loses everything the workgroup taught it |
| **heartbeat missed** (§3) | the service is down, or the monitoring is |
| disk > 90% | worktrees and `node_modules` caches grow without bound |
| provider auth failure | every review stops at once |
| **daily spend ceiling hit** | a runaway loop at $500–2,600/month can burn fast |
| all reviews failing over a window | systematic breakage, not a bad branch |

### 2.2 Ticket — next working day

Elevated review failure rate; spend anomaly against trend; a repo whose mirror is
refused as stale often enough to look like a habit rather than a slip (D-63 — that
one is a *person* forgetting `make mirror`, not the service breaking); disk > 75%;
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

## 5. Transport

A generic **outbound webhook**, with severity, condition, and a short human
description. It works with Slack, Alertmanager, a Plane integration or a shell script
without `lore` knowing which.

Configured per deployment. If the webhook itself is unreachable, that failure is
logged **and** surfaced by the heartbeat's absence at the far end — the one signal
that does not depend on our own alerting working.
