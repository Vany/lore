# SPEC — `lore`

A hosted MCP service that reviews a branch before it merges, and — the actual
point — **remembers the codebase between sessions**.

Status: **implemented**, 2026-08-03. All phases in `PLAN.md` have code; 174 tests.
Unproven until deployed: real model calls, container launches, and arm64.

| document | subject |
|---|---|
| this file | purpose, workflow, architecture, decisions |
| `PLAN.md` | build order, phases, what each retires |
| `spec/mcp-api.md` | the MCP surface, provisioning, review state machine |
| `spec/knowledge.md` | the knowledge layer — the product |
| `spec/review-ladder.md` | tiers, findings, verdicts, invariants |
| `spec/agent-docs.md` | tool descriptions, resources, the `review` prompt |
| `spec/deployment.md` | the arm64 host, Tailscale, T0 throughput budget |
| `spec/operations.md` | client alarms vs devops alerts, the heartbeat, spend control |
| `research/` | verified external facts, each dated |

---

## 1. Purpose

**Every Claude session starts amnesiac.** It rediscovers the same conventions,
re-raises the same settled questions, and repeats the same mistakes. `lore` is the
memory: a shared, per-repo body of knowledge about a codebase, built by reviewing
it and readable by every session and every teammate (D-14).

Review is the mechanism. Shared knowledge is the product.

The reviewing half is independent by construction: **every reviewer tier is
non-Anthropic**, because Claude writes the code under review. That costs us the
strongest model on the board on purpose. Greptile reached the same conclusion from
700K PRs/month — *"software needs an independent auditor."*

---

## 2. Workflow

```
 developer finishes, commits, pushes
        │
        ▼
 review.start(branch, into) ─────────────► {review_id}   (returns at once)
        │
        │   ┌──────────────────────────────────────────┐
        │   ▼                                          │
        ├─ review.poll(id) ─► new findings ────────────┤
        │                                              │
        └─ review.submit(id, diff, tree_hash) ─────────┘
                                    │
              all tiers agree there is nothing left
                                    ▼
                      review.attest(id) ─► signed one-liner
                                    │
                                    ▼
                        developer merges into `into`
```

A review outlives an MCP request, and **MCP servers cannot initiate requests** — so
`start` returns an id and the client polls. That is the only correct shape, not a
workaround (`research/mcp-service-design.md` §2). There is no progress estimate,
because we cannot honestly give one.

Fixes arrive as diffs and are applied to a private worktree without committing —
the client keeps ownership of its own history. Each submission carries a
`tree_hash` that the server verifies after applying, so a partial apply is caught
rather than silently reviewed.

---

## 3. Architecture

```
 MCP client ──► lore-mcp (Docker)
                  │
                  ├─ MCP surface     review.* / knowledge.*
                  ├─ scheduler       per-provider concurrency, backpressure
                  ├─ review workers  ──► opencode servers ──► models
                  ├─ repo cache      bare clone + one worktree per active review
                  └─ SQLite (WAL) + Litestream ──► continuous backup
```

SQLite is sufficient at workgroup scale and stays behind a repository interface, so
outgrowing it costs a swap rather than a rewrite. WAL mode plus continuous
replication; a knowledge base without backups is a knowledge base you will lose.

---

## 4. Tenancy

Vany's workgroup (D-13). One repo today, several expected. Trusted identities, so
no abuse-hardening — but **usage is logged per repo, tier and model** even though
nobody is billed, because that is what makes the subscription question answerable
later.

Knowledge is **per repo**, shared freely between all sessions working on it
(D-18, D-19).

---

## 5. Decisions

| # | decision | status |
|---|---|---|
| **D-1** | Reviewers are non-Anthropic — independence from the author | hard |
| **D-2** | `lore` never commits or pushes; the client owns its history | confirmed |
| **D-3** | TypeScript, no build step (§6) | confirmed |
| **D-4** | Host-agnostic core; MCP and CLI are both adapters over it | confirmed |
| **D-5** | Measure before buying any subscription | confirmed |
| **D-6** | Reset to T1 after any change; advance only on nothing-new | confirmed |
| **D-7** | GLM-5.2 → Kimi K3 → GPT-5.6 Sol Pro. Three vendors | **revised** |
| **D-8** | T0 is deterministic tooling, using the *target's* config | confirmed |
| **D-9** | Learnings enrich every report | confirmed |
| **D-10** | Justification is a `lore-ok` comment; the **reviewer** rules on it | confirmed |
| **D-11** | Specs are reviewed as code; drift is a defect both ways | confirmed |
| **D-12** | Reviewers inherit the full opencode context (MCP, plugins) | confirmed |
| **D-13** | Workgroup tenancy, multi-repo, no billing, usage logged | confirmed |
| **D-14** | **Purpose is knowledge shared between sessions**; review is the means | confirmed |
| **D-15** | Attestation is one signed line asserting what was done | confirmed |
| **D-16** | MCP is the product; the CLI is the development surface | confirmed |
| **D-17** | One OpenRouter key. No subscriptions — usage is cheaper | answered |
| **D-18** | Knowledge is queryable by any token holder, any time | confirmed |
| **D-19** | Knowledge is per-repo; no cross-repo layer | confirmed |
| **D-20** | Sources: taught > ingested > derived, each with provenance | confirmed |
| **D-21** | Credentials in a header, never in the URL | **revised** |
| **D-22** | `@modelcontextprotocol/server` v2 + Zod v4 schemas | confirmed |
| **D-23** | `review_id` is CSPRNG and bound to its principal; possession ≠ auth | confirmed |
| **D-24** | T0 runs the target's tests — in a container holding no secrets | confirmed |
| **D-25** | Build order was a walking skeleton: CLI did a real review first | done |
| **D-26** | Operator status view: is parallelism running, or queueing? | confirmed |
| **D-27** | Docs in three layers: tool descriptions, resources, prompts | confirmed |
| **D-28** | A `review` prompt drives the whole loop as a slash command | confirmed |
| **D-29** | Prompt caching across loop rounds — most of the cost model | confirmed |
| **D-30** | T3 context capped below 272k tokens; crossing it doubles the rate | confirmed |
| **D-31** | Tier prompts differ by position; T3 is told it is the last line | confirmed |
| **D-32** | T3 always runs. No sampling — the attestation keeps its meaning | confirmed |
| **D-33** | arm64 Orange Pi, LAN-bound. No tailscale yet — tokens are the perimeter | **revised** |
| **D-34** | Two stages: T0+T1 inline, T2+T3 async, collected via `review.inbox` | confirmed |
| **D-35** | Bootstrap on first review — at provisioning there is nothing to clone | **revised** |
| **D-36** | Git submodules, not monorepos — a gitlink bump is expanded | confirmed |
| **D-37** | T0 is the local bottleneck — but ~25 min/day, not 5 hours | **measured** |
| **D-38** | `ticket` text is required — enables the scope-creep axis | confirmed |
| **D-39** | Knowledge conflicts are findings; unresolvable ones need a human | confirmed |
| **D-40** | Reviews are explicit and snapshot-pinned; attestation covers a tree | confirmed |
| **D-41** | Developer alarms are the client's job; `lore` provides information | confirmed |
| **D-42** | `lore` alerts devops about itself, with a heartbeat deadman | confirmed |
| **D-43** | Review **types**; `code-arch` is the default, `security` is next | confirmed |
| **D-44** | Findings carry an optional CWE id — the shared vocabulary | confirmed |
| **D-45** | The project is **`lore`** | confirmed |
| **D-46** | A conflict block must have an exit: resolve, or escalate | confirmed |
| **D-47** | D-1 is enforced by **absence**: no Anthropic credential is deployed | confirmed |
| **D-48** | An unfundable tier is *skipped*, not fatal — `passed_partial` | confirmed |
| **D-49** | A single-vendor ladder reaches `passed_partial`, never `passed` | `[OPEN]` |
| **D-50** | Exploration is **counted per review before it is capped**; no cap yet | `[OPEN]` |
| **D-51** | An accepted justification is **repo knowledge**, carried across reviews | confirmed |
| **D-52** | The per-tier cap bounds *iteration*, so a clean tier escalates past it | confirmed |

**D-7, revised.** The earlier version dropped GLM-5.2 on Artificial Analysis's
*cost per task* — which is tokens consumed × price on their benchmark, not a price.
On actual OpenRouter pricing GLM-5.2 is **5.3× cheaper on input and 8.4× cheaper on
output than Gemini 3.6 Flash, at one point higher intelligence**. The original
conclusion was backwards. Gemini is dropped instead, dominated on both axes — GPT-5.6
Terra is cheaper *and* stronger. Full retraction:
`research/ai-code-review-landscape.md` §2.1a.

The ladder is now GLM-5.2 → Kimi K3 → GPT-5.6 Sol Pro: ascending capability across
**three distinct vendors**. Kimi K3 is poor value on capability alone (3× Terra for
2 points), but it buys a third independent vendor, and independence is the premise
of the whole design (D-1). Two tiers from one family are not two opinions.

**D-5 / D-17 — subscribe to nothing.** All three models are reachable with **one
OpenRouter key**. Subscriptions are *seat* licences: they authenticate a human, bind
to a single rate-limit bucket, and are the wrong shape for a backend serving a
workgroup in parallel — the exact case that motivated wanting one.

The arithmetic settles it. Estimated **~$1.20 per converged review, ~$120/month at
100 reviews** (`research/ai-code-review-landscape.md` §3.1), against $200/month for
one ChatGPT Pro seat covering one tier for one user with no parallelism. **The usage
is cheaper than the subscription.** Usage logging (D-13) stays, so this can be
revisited against real numbers rather than my estimates.

**No Z.ai plan for T1 either — because T1 is first, not despite it.** GLM takes
~62% of calls but only ~9% of cost; the cheap tier is cheap. GLM Coding Plan Lite is
$18/month against ~$6/month of T1 tokens. And its quota is a **5-hour rolling
window**: T1 is the gate every review must clear, so exhausting it stalls *every*
review in the system for up to five hours. Putting the highest-throughput,
most latency-critical tier on the most quota-constrained billing model is backwards.
`research/ai-code-review-landscape.md` §3.3.

**D-29.** Every loop round re-reads the same repo context with only the diff
changing — exactly what caching is for. Cache reads are 10× cheaper on Kimi K3 and
Sol Pro, 5.4× on GLM, taking a converged review from ~$1.20 to ~$0.70. Not a later
optimisation; it *is* the cost model.

With input cached, **77% of T3's cost is output** — which makes the
structured-findings rule (`spec/review-ladder.md` §3) a cost control too. A reviewer
that writes essays instead of records costs several times more at every tier,
forever.

**D-30.** `gpt-5.6-sol-pro` doubles its rate above 272k prompt tokens ($10/M in,
$45/M out) while advertising 1.05M of context — so nothing stops a wide agentic
review from silently doubling the dearest tier. Measure and cap; crossing it is a
logged event, not an invoice surprise.

**D-31 / D-32.** Vany: *"run it always but at final, not bother it with stupid
mistakes, code must be almost fixed."* So T3 is never sampled or skipped — the
attestation keeps its strongest meaning, **every tier agreed**, rather than
degrading to "the tiers we chose to run agreed". At 44% of the bill that is a
deliberate purchase of certainty, which is how a tool whose only output is a quality
claim should spend money.

It also sharpens the ladder's premise: **the expensive tier's job is not to find
everything, it is to find what two independent reviewers missed.** So a tier is told
where it stands (`spec/review-ladder.md` §1.1.2) — otherwise T3 spends its budget
re-deriving what T1 already established.

**Volume, corrected.** ~30 PRs on a working day, solo, plus a workgroup: **740–3,700
reviews/month**, i.e. a **$500–2,600/month** tool. Cost is a first-order design
constraint, and latency is too — 30 reviews a day cannot queue behind one another,
which makes any quota-metered plan actively dangerous. A burst of 30 PRs is exactly
when a rolling window empties. `research/ai-code-review-landscape.md` §3.2.3.

**D-33, revised 2026-08-03 — measured on the device.** arm64 is confirmed: node runs
natively, `npm ci` takes 9 s, the full suite 7 s, a typecheck 2 s. The one real
finding was that `node:*-alpine` ships **no git**, which failed 10 tests in the way
that matters most — not by refusing to run, but by running and producing failures
unrelated to the change, which T0 would have reported as high-severity findings.

**And tailscale is not installed on the host** — deferred deliberately, 2026-08-03:
the device is physically in the operator's hands and on a private LAN, which is a
real perimeter even if not a cryptographic one. The service binds to the LAN
address and the bearer token does the load-bearing work.

Revisit when the device leaves his possession, or when a second workgroup member
needs access from elsewhere. `LORE_BIND` is one line in `.env`, so getting the
tailnet perimeter back later costs nothing but installing tailscale.

The whole D-33 security argument originally assumed it. On a LAN the bearer tokens stop being mere scoping and become the
perimeter, so the compose bind now defaults to loopback: exposing it is a decision
someone has to make on purpose.

**D-37, measured.** The estimate of ~5 CPU-hours/day was an order of magnitude too
pessimistic; the real figure is ~25 minutes/day at 30 PRs × 5 rounds. The caching is
still worth having, and T0 is still the local bottleneck — but it is not the
constraint the plan feared.

**D-33 / D-37 — the host inverts the bottleneck.** Model calls are remote and cost
this machine nothing; **T0 is local, CPU-bound, and runs on modest ARM cores**. The
free tier is the one that costs wall-clock — roughly 5 CPU-hours/day for one
developer if T0 is run naively. Hence caching, incremental typechecking and
diff-scoped work on later rounds. Disk is plentiful and CPU is scarce, so spending
the former to save the latter is always right here. `spec/deployment.md`.

Tailscale also deletes work: no public TLS, no domain, no abuse surface. Tokens
remain, for per-repo scoping rather than network defence.

**D-34 — a fast pass is not a pass.** `fast_clean` (T0+T1 only) is its own state and
is never reported as `passed`. INV-1 in a new disguise: "the cheap tiers found
nothing" must never read as "the branch is clean". Only the full ladder attests.

**D-36.** A submodule pointer bump is two lines of diff that can carry thousands.
A reviewer shown only the outer diff would confidently call it low-risk without
having seen it — precisely the failure this project exists to prevent. Gitlink
changes are expanded, and never counted as a one-line diff.

**D-38 — the ticket buys the question correctness cannot ask.** Not *"is this code
right?"* but *"is this the **right** code?"* With the ticket a reviewer can see a
change that does less than was asked, or something else entirely, or — most common
in vibecoded work — **more than was asked**. An AI told to fix one thing will
cheerfully refactor three others; every unrequested change is code nobody decided to
write and no ticket justifies. Invisible without the ticket, which is why it is
required rather than optional (`spec/review-ladder.md` §6.2).

**D-39 — the one place the system stops and asks for a person.** A knowledge
conflict is not resolved by the store; it becomes a finding the reviewing agent must
actually work through. Newer *leans* correct, because code evolves — but that is a
prior, not a verdict, and a careless recent rule must not silently overwrite a
reasoned older one. If the agent cannot decide, it marks `needs_human` and says so.
While that is open the review cannot pass, cannot attest, and **cannot be closed
with `lore-ok`** — a justification is a claim about code, and this is a question about
which of two beliefs is true. The agent that could not decide must not write its way
past it.

**D-45 — the name.** `lore`: the accumulated knowledge of a domain, passed between
people. It names the **product** (D-14) rather than the commodity — everyone has a
reviewer; nobody has the memory.

It also unified a mechanism. A justification comment is `// lore-ok[fp]: reason`,
which reads as *proposing a piece of lore* that the reviewer then ratifies or
rejects. So an accepted justification is not merely a closed finding — it is **how
the codebase acquires a new fact about itself**, and the justification protocol and
the knowledge layer stop being two systems. Every argument won with a reviewer
becomes something the next session already knows.

Practical bonus: the previous working name shadowed `rev(1)`, a real coreutils
command.

**D-47 — independence enforced by absence.** Reviewers inherit this machine's
opencode configuration so they have what a Claude Code session has (D-12) — but
`make sync-opencode` **strips the Anthropic credential** and the plugin that
supplies it on the way.

Until now D-1 held only because the tier list happens to name non-Anthropic models.
One wrong model id, or one agent config naming an Anthropic model, and the author's
own model family grades its own work — silently, producing a *better-looking* review
than the honest one. With no credential in the container that failure mode is
unreachable rather than merely unlikely, and any attempt to use it fails loudly.

The staging script refuses to emit an auth file that still contains one.

**D-48 — a tier nobody can pay for is a limitation, not a failure.**

A provider that refuses on quota used to fail the whole review (exit 75). That is
right when a tier *could* have run and ran out mid-flight. It is wrong when the
deployment simply has no credit for the dearer models: the review would never
terminate, and a tool that cannot finish on the hardware you actually have is not a
tool.

So an exhausted tier is now **recorded as unavailable and stepped over**. When every
tier that *could* run agrees, the review reaches **`passed_partial`** — "we did
everything we can" — with its own exit code (**3**), never `passed` and never `0`.

The distinction is load-bearing and must not erode:

- **`passed`** — every configured tier agreed. Three independent vendors found
  nothing. That is the claim the attestation exists to make.
- **`passed_partial`** — every *available* tier agreed; the rest never looked.
  Weaker evidence, honestly labelled.

**The attestation names the tiers that ran and the tiers that did not, and why.**
Silently attesting a partial review as though it were complete would be the single
most damaging thing this system could do — it is the one output whose entire value
is that it can be trusted, and a reader has no way to tell the difference unless the
line says so.

**D-49 — a single-vendor ladder cannot reach `passed`.**

Found by the system reviewing itself. `loadTiers` printed a warning when every model
tier came from one vendor — and then let the review pass anyway. The reviewer named
the consequence exactly: *"attestation falsely claims multiple independent reviews
when there were only 2 unique models."*

That is the same shape as INV-8's missing agent file, and as the two permission bugs
that preceded it: **a check that only prints is a comment.** This codebase's own rule
is that every ambiguity resolves toward saying so loudly, and here it resolved toward
a clean-looking pass.

So a ladder whose *reachable* tiers share one vendor now reaches **`passed_partial`**,
never `passed` — the same outcome as D-48, for an independent reason, and the decision
carries both:

- **`skipped`** — tiers nobody could pay for (D-48)
- **`soleVendor`** — the one vendor behind every tier that ran (this)

Vendors are counted among tiers that *could run*, not tiers that were *configured*. A
three-vendor ladder with two tiers unpayable really did get one vendor's opinion, and
recording otherwise would count work nobody did (INV-1).

**The attestation names the vendor next to the tier count**, because the count is the
number a reader takes as a proxy for rigour, and it is exactly the number a
single-vendor ladder inflates: three tiers from one model family is one opinion asked
three times.

`loadTiers` still warns rather than throwing. A deployment funded for one provider
must be able to review; it must not be able to claim independence it does not have.

**Why this stayed advisory until now:** the deployed ladder *is* single-vendor —
Kimi is waitlist-only and a second subscription could not be bought. The honest
response to "we cannot afford independence" is to say so in the output, not to
quietly redefine `passed`. `[OPEN]` — revisit when a second vendor is reachable.

**D-50 — agentic exploration is counted before it is capped.**

Measured on the deployment: one T2 call read **~1.5M cached tokens** before it
answered. An agentic reviewer re-sends its accumulated context on every turn, so the
read count grows with the *square* of the exploration rather than with the size of
the diff. D-29 treats caching as a saving and per token it is — but against a
subscription **quota** the count is what runs out, which makes exploration, not model
choice, the cost driver.

The obvious response is a turn cap. **It is not shipped, deliberately.** A first
attempt proposed 80 turns; the two real review sessions that can be measured say that
number would have killed a good review. Counted from opencode's own store, both on
the same repo and round, both with the read-only agent:

| session | agentic turns | session cache reads | cost |
|---|---|---|---|
| `review_glm_r181` (GLM) | **82** | 8.85M | $0.85 |
| `review_sol_r181` (Sol) | **27** | 11.87M | $35.20 |

Both produced findings. So a cap of 80 sits *below* a healthy GLM review, and the
run that read the most tokens took a third as many turns as the one that read the
least — turns are not tokens, and one global step limit cannot mean the same thing to
two models. These are the predecessor's runs on another repo, which is why they are
two data points and not a distribution.

Two implementations were tried and both failed in the way this project exists to
catch:

- **Counting the reply's own `step-start` parts** reads *one* however far the agent
  went. A prompt reply is a single assistant message and an assistant message carries
  at most one `step-start` — 1415 of them across 1455 messages in a real opencode
  store. The audit half of that design could never have fired.
- **Watching opencode's event stream** and aborting on the cap looks right and
  degrades in silence: the SDK's SSE client swallows connection errors, calls an
  optional callback nobody passed, and the generator ends normally. A reviewer ran it
  against a dead port — 0 steps seen, cap never tripped, nothing printed. And when it
  did fire, the abort came back as `500: MessageAbortedError`, i.e. as the
  misdiagnosis the rest of this decision is about.

So what ships is the **measurement**: `usage.steps`, the agentic turns of one tier
run, taken from `GET /session/:id/message` after the answer (one session per tier
run, so the session total is the review's). `NULL` when it could not be taken —
never `0`, which would be a claim that the tier explored nothing, and would bias the
distribution downwards exactly when the measurement broke.

`[OPEN]` — set the cap from that column once there is a distribution, and note three
things it will not contain. `bootstrap()`'s model call records no usage row at all. Usage is recorded only for reviews that **complete**, so
a runaway ended by a timeout leaves no row (the motivating incident did answer, and
would have been recorded). And `usage`'s token columns are read from the ONE
assistant message a prompt reply carries, so they describe a single turn rather than
the session — in a real 73-turn session the per-message cache reads were 100k–450k
each and summed to 17.9M. `GET /session/:id` returns the session's true totals in
~700 bytes, so closing that is small; it changes what the spend ceiling sees, which
makes it a money decision rather than a bug fix.

**D-51 — an accepted justification outlives the review that accepted it.**

The thing this service exists for, and it was missing until it was watched failing.

A fingerprint belongs to the review that raised it. So a reason ratified last week
matched nothing this week: every new review re-raised every settled finding, and the
author re-submitted the same `lore-ok` comment forever. The memory was per-review,
which is precisely the amnesia the product is against — SPEC promised *"an accepted
justification becomes durable knowledge"* and the code delivered a note in a drawer
nobody opened again.

Observed rather than reasoned: a `lore-ok` accepted in one review of this repo was
ignored by the first round of the next, because justifications are collected before
findings are recorded and the new review's finding table was still empty.

So a raised fingerprint now inherits the last `justified-accepted` verdict from any
earlier review **of the same repo**. Two guards, neither optional:

- **Not if the model raised it this round.** A model that reads the recorded reason
  and complains anyway is disagreeing with the lore, and that disagreement is worth
  more than the convenience of auto-closing. It falls through to the normal ruling,
  which is where a bad justification gets rejected.
- **Not if the code moved.** The same staleness rule `expireStaleVerdicts` applies
  *within* a review, applied *across* them. A reason is about a piece of code and
  survives exactly as long as that code does; inheriting one blind is how a ladder
  rots into rubber-stamping.

Only `justified-accepted` carries. `fixed` does not — that verdict says the code
changed, and a fingerprint raised again means it did not stay changed.

The carried verdict records its provenance in the rationale, because a reader needs
to know a decision was inherited rather than made by the tier named beside it.

**D-52 — the per-tier cap bounds iteration, not results.**

The cap and the global budget sat together, checked before anything else. They read
as one idea — "bounds first, INV-1" — and they are not one idea.

The global budget is a ceiling on the whole review: tested every round, clean or
not, because a ceiling a good result may exceed is not a ceiling. The per-tier cap
bounds something narrower — *going round again with the same tier*. Checked in the
same place, it also fell on rounds where the tier came back **clean**, and then it
discarded the one result that proved the iteration had ended.

Observed, and paid for. `rev_UsgaL105JyrNJEBD8L9NwKFX` spent three rounds settling
three findings on this repo, ran a fourth at t1 for 485s and 29 turns, came back
clean — and was reported `failed`, because `tierRounds.t1` had reached 4. With a
default of 3 that makes `passed` unreachable for any change needing three rounds of
fixes, which is most changes worth reviewing. The ladder could not finish a real
branch, and the failure looked like the code's fault rather than the counter's.

So the cap is tested only inside the fresh-findings branch. Termination is what the
bounds owe us and it is untouched (`spec/review-ladder.md` §5): every round either
raises something fresh — still bounded — or is clean, and clean is terminal.

It is a **quota decision as well as a correctness one**, which is why it is written
down rather than filed as a bug fix: reviews that used to die at t1 now escalate
into the deep tiers, so this strictly increases what a hard review spends.

**D-43 — review types.** `review.start` takes a `type`, defaulting to `code-arch`:
*is this change correct and well-made?* The next type is `security`: *what
known-vulnerable things are we shipping, and can they be reached?* Different inputs
(the lockfile and SBOM, not just the diff), different scope (the whole dependency
tree), different cadence (a dependency turns vulnerable with no commit), and a
different output format (VEX). Running it on every merge would be waste and noise.

The `type` parameter exists in the MCP surface **from day one**, even while only one
type is implemented — adding a required argument later breaks every client.

**D-44 — CWE as the finding vocabulary.** There is no published database of code
*review* findings; CWE is the closest thing, a taxonomy of weakness kinds derived
from analysing 31,770 CVE records. An optional `cwe` on a finding buys comparability
across tiers, interoperability with scanners (Semgrep rules carry CWE natively), and
knowledge clustering that means something: *"eleven CWE-89 findings"* is a signal,
eleven differently-worded complaints are not. Optional, because forcing a CWE onto
"this test would pass without its fix" would be taxonomy theatre.
`research/security-review.md`.

**Deployment shape.** A folder in `$HOME` on the device containing a
`docker-compose.yml`, matching the workgroup's existing convention.

**D-41 / D-42 — two audiences, two channels, never blended.** `lore` does not notify
developers; it returns information and the client decides what deserves an alarm.
That is also forced by the protocol, since MCP servers cannot initiate requests. Our
obligation is to make urgency **machine-classifiable** — explicit `severity`,
`needs_human` as its own state, `fast_clean`/`failed`/`expired` never blended into
"not passed" — so a client never infers urgency from prose.

Separately, `lore` alerts **devops about itself**: backups stale, disk full, provider
auth dead, spend ceiling hit, reviews failing as a class. One review failing is a log
line.

**The heartbeat is the part that matters.** A monitoring system that fails silently
is INV-1 at a different layer — if the alerting path breaks, "no alerts" and
"everything is fine" become the same observation. So the service emits a heartbeat
and devops alerts on its *absence*. A dead service, a dead network, a dead alerter
and a full disk then all produce the same visible symptom instead of the same
invisible one. Push-only alerting cannot detect its own death.
`spec/operations.md`.

**D-40.** Reviews are started explicitly, never per commit, and are pinned to the
tree they began with plus submitted diffs. Commits pushed mid-review are invisible;
review them by starting a new review at the tip. This keeps a review converging on
something that stops moving. **The attestation therefore covers a tree hash, not a
branch name** — if the branch has moved, the signature does not describe what is
there now, and merging on it would be wrong.

**D-21.** The MCP spec: *"Access tokens MUST NOT be included in the URI query
string"*, credentials go in an `Authorization` header on every request. The
original plan put the key in the URL. Provisioning still emits one paste-able
config blob; the secret just moves to a header field, which Vany's own `plane` MCP
entry already demonstrates works.

**D-23.** MCP security guidance names "state handle hijacking" as an attack, and
`review_id` is precisely that handle: *"MCP servers MUST NOT treat possession of a
state handle as authentication."* Cheap to build now; the moment a sequential id is
stored anywhere, every log line becomes a credential.

**D-24.** Running the target's tests is arbitrary code execution, and the threat is
the dependency tree rather than the teammate. The service container holds every
repo's deploy key and the knowledge database, so it **must not** be where a
`postinstall` runs. Separate ephemeral container, no secrets, no network, hard
timeout (`spec/review-ladder.md` §1.1.1).

**D-25.** Walking skeleton: build a thin end-to-end slice, then deepen it. The
uncertainty in this project is whether a three-tier ladder converges on real
branches — not whether MCP servers and job queues work. Build the risky part where
it is cheapest to change, behind a CLI with no HTTP, containers or tokens in the
loop. Honest counter-argument in `research/implementation-approach.md` §5: it defers
the service's own integration risk.

**D-27 / D-28.** The client is an agent, so the documentation *is* the interface —
there is no support channel and no README a confused caller will read. The layers
are split by cost: tool descriptions sit in context every session and carry only
what an agent must not get wrong; resources hold reference detail and cost nothing
until read; prompts carry whole workflows and surface as slash commands. Every
sentence in `spec/agent-docs.md` §3 traces to a named failure mode in §2 — the
worst being an agent that polls once, sees `running`, and concludes the branch is
clean.

---

## 6. Language: TypeScript

Chosen freely, and the reviewed code decides it. Targets are JS/TS/Node/Bun, so the
T0 layer wants the TypeScript compiler API, ESLint's programmatic interface and
`ast-grep` — all native here.

Node ≥24 strips types and runs `.ts` directly, so there is **no build step**.
`node:sqlite` covers persistence with no dependency. The opencode SDK is generated
from its OpenAPI spec, so sessions, models and agents are typed.

It also deletes the failure class that broke the predecessor: `$(cat <<EOF)` under
bash 3.2, which failed at *runtime*, long after everything risky-looking had
succeeded.

---

## 7. Non-goals

- Not a GitHub app. It reviews branches over MCP; it posts nothing to a forge.
- Not a linter. It *runs* linters; it does not reimplement them.
- No autonomous commit, push, or merge. Ever.
- No repo-wide semantic index for now. Greptile notes codebases are uniquely hard
  to search semantically, and their own answer was agentic exploration.
- No claim that reviewed code is correct. The attestation says what was done.

---

## 8. Open questions

1. **D-17** — subscriptions, revisited once usage data exists.
2. Does T0 **execute** the target's test suite? Greptile built TREX because running
   code finds what reading misses, but an arbitrary suite has side effects.
3. Greptile's *"How to Make LLMs Shut Up"* is unread (URL 404'd). Noise suppression
   costs a whole fix cycle per false positive in a loop this shape.
4. Are the free code-specialised models good enough for a zero-cost gate below T1?
5. Token rotation procedure — a token that cannot be rotated without breaking every
   client is one nobody will rotate.
6. What happens when two reviews on one repo produce contradictory knowledge? The
   conflict is recorded (`spec/knowledge.md` §6), but nothing resolves it yet.
