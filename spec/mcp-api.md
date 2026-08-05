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
3. Emits a paste-able `.mcp.json` fragment with the token **in a header** (D-21).

**No key is issued** (D-63, superseding D-62). lore does not clone and does not
fetch; `make mirror` does, on the host, as the operator, into `data/repos` — the one
directory the container already sees. A deploy key would be a credential on disk
that nothing reads. So the operator's remaining step is `make mirror`, before the
first review and before each later one: a mirror older than `MAX_MIRROR_AGE_MS` is
refused rather than reviewed.

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
  token's principal. A valid id from another tenant fails exactly as a forged one
  does.
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

`review_inbox()` returns deep findings across **all** the caller's reviews since
they last collected — the batch view the workflow actually needs. Per-review
`review_poll` remains for driving a single review to completion.

Without this, a developer with 30 open reviews either polls 30 ids or loses
findings. Both are failures.

Each entry carries `highest`, the worst severity among its new findings, so a client
can triage 30 reviews without reading 30 lists. It is **computed over the whole set**,
not taken from the first row — reading position 0 was how it came to report `low` for
a review whose worst finding was `medium` (D-50, `spec/review-ladder.md` §3.2). The
findings themselves are ordered worst first, there and in `review_poll`.

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
- A client closing its poll stream cancels nothing. Cancellation is explicit.

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
