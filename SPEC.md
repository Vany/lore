# SPEC — `lore`

A hosted MCP service that reviews a branch before it merges, and — the actual
point — **remembers the codebase between sessions**.

Status: **deployed and reviewing itself**, 2026-08-05. All phases in `PLAN.md` have
code; 391 tests. Live: 21 reviews, 2 attested, 871 knowledge rows, 82 model calls.
Unproven: the Orange Pi itself, and three paths that have never executed —
`passed_partial`, `needs_human`, quota exhaustion. `TODO.md` keeps those open rather
than folding them into a tick.

**This file describes the system as it stands.** Decisions carry the reasoning that
makes them right, not the sequence of changes that produced them; what changed when,
and what it cost to learn, lives in `MEMO.md` and in the git history.

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
 review_start(branch, into) ─────────────► {review_id}   (returns at once)
        │
        │   ┌──────────────────────────────────────────┐
        │   ▼                                          │
        ├─ review_poll(id) ─► new findings ────────────┤
        │                                              │
        └─ review_submit(id, diff, tree_hash) ─────────┘
                                    │
              all tiers agree there is nothing left
                                    ▼
                      review_attest(id) ─► signed one-liner
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
                  ├─ MCP surface     review_* / knowledge_*
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
| **D-24** | *(superseded — lore reads a suite and never runs it; see D-71)* | superseded |
| **D-25** | Build order was a walking skeleton: CLI did a real review first | done |
| **D-26** | Operator status view: is parallelism running, or queueing? | confirmed |
| **D-27** | Docs in three layers: tool descriptions, resources, prompts | confirmed |
| **D-28** | A `review` prompt drives the whole loop as a slash command | confirmed |
| **D-29** | Prompt caching across loop rounds — most of the cost model | confirmed |
| **D-30** | T3 context capped below 272k tokens; crossing it doubles the rate | confirmed |
| **D-31** | Tier prompts differ by position; T3 is told it is the last line | confirmed |
| **D-32** | T3 always runs. No sampling — the attestation keeps its meaning | confirmed |
| **D-33** | arm64 Orange Pi, LAN-bound. No tailscale yet — tokens are the perimeter | **revised** |
| **D-34** | Two stages: T0+T1 inline, T2+T3 async, collected via `review_inbox` | confirmed |
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
| **D-53** | One round at a time **per review**; reviews still run in parallel | confirmed |
| **D-54** | t1 is `glm-5-turbo`: glm-4.7 answers 200 with an empty body | confirmed |
| **D-55** | A submit is **refused** while a round is reading the worktree | confirmed |
| **D-56** | A **fix** is settled by qualified silence over code that moved | confirmed |
| **D-57** | `.lore-ok.md` justifies findings in files that cannot hold a comment | confirmed |
| **D-58** | An oversized diff is announced against the tier's **own** demonstrated ceiling | confirmed |
| **D-59** | Replication is **local and always on**; an outer script takes it off the box | confirmed |
| **D-60** | The data directory is the **same path** inside the container as on the host | confirmed |
| **D-61** | Git may never climb out of the directory it was aimed at | hard |
| **D-62** | *(withdrawn — lore holds no git credentials at all; see D-63)* | withdrawn |
| **D-63** | *(superseded — the refresh is automated on the host rather than manual; see D-65)* | superseded |
| **D-64** | `claim` is capped at **500** — one sentence, and a refused reply costs the round | confirmed |
| **D-65** | mirrors are refreshed by a **host process outside lore**; a stale one is refused | confirmed |
| **D-66** | A rejected finding **loses its own line, not the batch** — and the loss is reported | confirmed |
| **D-67** | Severity is the engine's. Recurrence informs the reader, and never demotes | confirmed |
| **D-68** | A finding outside the diff from a pattern engine is **inherited**: reported, ranked last | confirmed |
| **D-69** | A token reaches **its own repository** and no other — scoping is per repo, not per principal | confirmed |
| **D-70** | A finished review **gives its worktree back at once**, through git, not in a week | confirmed |
| **D-71** | lore **reads** a test suite and never runs it; a failing suite is the repo owner's | confirmed |
| **D-72** | A deploy **drains** — stop claiming, finish what is in flight, then swap | confirmed |
| **D-73** | A justification is **not part of the code it defends**, and is learned once | confirmed |
| **D-74** | **One vendor per tier** — the deployed ladder is Z.ai, Moonshot, OpenAI | confirmed |

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

Failing the whole review on quota (exit 75) is right when a tier *could* have run and
ran out mid-flight. It is wrong when the deployment simply has no credit for the
dearer models: the review would never terminate, and a tool that cannot finish on the
hardware you actually have is not a tool.

So an exhausted tier is **recorded as unavailable and stepped over**. When every tier
that *could* run agrees, the review reaches **`passed_partial`** — "we did everything
we can" — with its own exit code (**3**), never `passed` and never `0`.

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

A warning is not a control. If every model tier that runs comes from one vendor, the
attestation would claim multiple independent reviews over what is one opinion asked
several times — so the ladder cannot reach `passed` at all, whoever wrote the tier
file.

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
down rather than filed as a bug fix: a review that would otherwise stop at t1 climbs
into the deep tiers instead, so this strictly increases what a hard review spends.

**D-53 — one round at a time per review.**

`claimJob` took the oldest queued job of any review and called that safe, "so two
workers never take the same one". True, and the wrong invariant. What must not
happen twice is not a job — it is a **round on a review**, because `runRound` reads
the ladder, runs a tier, and writes the ladder back.

Both `review_start` and `review_submit` enqueue, and `enqueue` inserted
unconditionally. Starting a review and submitting a diff moments later — the normal
shape of the loop, not an abuse of it — left two `fast` jobs for one review, and two
worker loops took one each.

Observed on `rev_cuZabwdrspNwv3OV6eu0IHA_`, 2026-08-04: two overlapping t1 calls of
550s and 590s, both paid. The interleaved read-modify-write left the ladder at
`round: 1, tierRounds: {t1: 1}` after two rounds had completed, so one finished
review that returned `ok` was discarded; `tier_run` and `usage` disagreed about
which tier ran, because different rounds wrote them.

Worse than a stall: it spends money and corrupts the audit trail, in the one table
that exists to say whether a review really ran. It is also precisely the hazard
`reclaimOrphanedJobs` refuses to risk mid-flight — "requeues a job that is still
running, so the same review runs twice and pays twice" — arriving through the front
door while the back one was guarded.

So the claim skips any job whose review already has one running, and `enqueue`
collapses an identical queued round. Parallelism **between** reviews is untouched,
which is the concurrency worth having; a blocked job stays queued and the loop
polls again. Deduplication is on (review, stage), not review alone: collapsing a
`deep` into a waiting `fast` would silently drop an escalation.

**D-54 — t1 is `glm-5-turbo`, because glm-4.7 stopped answering.**

Measured, not assumed. On 2026-08-04 glm-4.7 returned an empty body three times —
twice inside a review, once to a direct probe — with HTTP 200 and tokens counted
(`output: 1`). That is a provider refusing inside a success status, which is what
`describeReply` was taught to name hours earlier, and it named it correctly first
time: *"first reply was EMPTY (usually a provider failure inside a 200)"*.

Not the account. On the same subscription, at the same minute: glm-5.2 answered in
8s, glm-5-turbo in 6s, both `$0`. `glm-5.2-highspeed` was also empty, and with zero
input tokens, so it never started.

`glm-5-turbo` over promoting glm-5.2 into t1: making t1 and t2 the same model would
leave the cheap regression check (D-6) doing the same work as the deep tier, and the
ladder would stop being a ladder. Still multi-vendor, so `passed` stays reachable
(D-49). Its review quality was unmeasured when chosen; its first two rounds took
271s/13 turns and 162s/11 turns, against glm-4.7's 500–600s and 30+ turns, and it
found a real defect in the attestation fixtures.

**The operator chose this**, per the rule that anything changing which model is
called is discussed before it ships. Recorded here rather than beside the code
because `deploy/tiers.zai-openai.json` cannot carry a `lore-ok` — JSON has no
comments and the tier schema is `.strict()` — which is its own open problem, in
TODO.

**D-55 — a submit is refused while a round is reading the worktree.**

D-53 stopped two rounds running at once, and stopped there. The worktree has a
writer that is not in the queue at all: `review_submit` applies the client's patch
to the same directory the running tier is exploring.

So a tier computes its diff, begins reading, and a submit rewrites the files
underneath it. Its prompt and its `tier_run` row describe the old tree while its
tools see a new or half-patched one, and a `clean` from that describes a tree that
has never existed anywhere — the exact failure the tree-hash check was built to
prevent (D-40), arriving from the other side.

**The check must count a QUEUED round, not only a running one.** Asking whether a
round is *running* leaves a TOCTOU: a job sitting queued reads as "nothing in
flight", the handler yields on its next `await`, a worker claims that job and
`computeDiff` starts reading, and the handler resumes and patches the files
underneath it. The tree hash would then match a tree the findings never described —
the very thing being prevented. A queued round counts, so
there is nothing left for a worker to claim; the window is closed rather than
narrowed, and the worktree is resolved before the check so no `await` sits between
the check and the write.

Refused rather than queued. The client already polls (D-34), a fix genuinely cannot
be reviewed until the current round finishes, and holding pending patches would put
a review's tree in two places at once — the ambiguity this project exists to refuse.
The error names what to wait for and states that nothing was applied.

**D-56 — a fix is settled by qualified silence.**

`VerdictKind` had three values and production wrote two. The missing one was the
*most common ending a review has*: the author changed the code and the complaint no
longer applies. Nothing recorded it, so an open finding stayed open for ever.

A fix has to be recorded as a verdict, or the attestation cannot count it. A signed
line reading `5 findings, 0 fixed, 2 justified` when three of the five were fixed
understates its own review and implies three findings were ignored, which is worse
than no line at all.

The mechanism is the one §4 already uses for justifications: **the reviewer rules by
not re-raising.** Two guards make silence mean something, and neither is optional:

- **Only a QUALIFIED tier's silence counts.** `origin` records the tier that raised
  it, and tiers are ordered by strength. t1 not repeating what t3 found says nothing
  about the code — t1 may be unable to see it — so closing a t3 finding on t1's
  silence is INV-1 exactly inverted. Only a tier at or above the origin may settle
  it; T0 settles only its own, and re-scans the whole worktree so its silence is
  authoritative there.
- **The code must have MOVED.** A tier that stops mentioning untouched code has
  changed its mind, which is not a fix. The finding's scope is recorded when it is
  raised; absent scope means "cannot tell" and never settles.

And never a finding this round answered another way. Both cases were caught by
existing tests within a minute of the rule landing, and both would have been silent
damage: a `lore-ok` is written INTO the file it defends, so the code moves and a
justification would have been recorded as a fix, losing the reason; and
`expireStaleVerdicts` re-opens a finding *because the code moved*, so closing it here
on that same fact would use one observation to both open and close it — no
justification could ever expire, quietly removing the guard against rubber-stamping.

**D-57 — `.lore-ok.md`, for files that cannot hold a comment.**

A justification is a comment, and some files have no comment syntax: JSON,
lockfiles, generated output, anything binary. A finding raised against one of those
had nowhere to put its reason, so it could only be fixed — and if it should not be
fixed, it was re-raised for ever with no way to answer. Hit on
`deploy/tiers.zai-openai.json` (`c618aec7`), where the tier schema is `.strict()`, so
smuggling a key in is a parse error rather than a workaround.

A justification's scope is taken from **the code it defends**, never from wherever
the reason is written. That only looked like a detail while the two were the same
file: `expireStaleVerdicts` looks the hunk up in the finding's file, so a ledger
entry recorded a hunk of markdown that can never appear in the JSON it defends, and
expired the round after it was accepted — re-opening the finding and restarting the
ladder for ever, which is the exact loop this decision exists to end (`3f0e2139`).
It is the better rule for the in-file case too: a reason should go stale when the
CODE moves, not when someone rewords the comment beside it.

One markdown file at the repo root, read on every round in addition to the files
that carry findings. Markdown so the existing `<!-- lore-ok[...] -->` form works and
no new syntax enters the vocabulary; a single listed path rather than discovery,
because a justification nothing reads is the failure the mechanism exists to prevent
— so where one may live stays a closed set.

**D-58 — an oversized diff is announced before the money is spent.**

Measured 2026-08-04: glm-5.2 at medium completed 21–30 KB diffs in 685–1193s and
blew the entire 1800s budget at 69 KB. Discovering that costs a full deep-tier
budget to learn nothing and reports `failed` — honest (INV-1), and honest far too
late. INV-7 already announces a *truncated* diff; nothing announced an oversized one.

**The threshold is the tier's own demonstrated best, never a constant.** `usage`
records the diff size of every run, and the ceiling is `MAX` over the runs that
tier actually **finished** — completed only, because a run that timed out proves the
opposite of capacity, and counting it would raise the ceiling every time the tier
failed, going quiet exactly as the problem got worse. With no evidence there is no
warning at all: a threshold nobody has calibrated fails real reviews for nothing,
which is the trap D-50 names and refuses.

It warns and proceeds rather than refusing. The tier may well manage a diff larger
than its previous best — that is how the ceiling rises — and a review stopped by a
guess is worse than one that runs long. The fix it names is review scope, not a
longer timeout: 21 commits accumulated on one base is not one review.

**D-59 — replication is local and always on; carrying it away is not lore's job.**

The knowledge base was to be replicated to an off-device S3 target, and the
consequence was that it was replicated nowhere: the credentials were never set, the
container was behind a `backup` profile, and **an opt-in backup is one that is off**.
440 rows sat on a laptop with no second copy while the spec said losing them loses
everything the workgroup taught the service.

So the split moves. Litestream writes a continuously-restorable copy into a folder
beside the deployment, and an **outer script** takes the files off the machine. lore
does not know how, and does not need to: the half it can be responsible for, it now
does properly and without configuration. There are no credentials, so there is
nothing to gate, so the container is a first-class service rather than a profile.

**This alone is not a backup, and the tooling says so rather than implying
otherwise.** A copy on this disk survives a corrupted database, a bad bulk write and
a wrong `down-hard`; it does not survive the disk. `make backup-check` reports that
it is checking the local half only. `make status` warns when the replica is **behind the
database** — not when it was last written. litestream writes only when there is
something to replicate, so an idle database and a dead replicator are identical under
a freshness test, and the freshness test cried wolf the first time it mattered: the
newest replica file and the last write to `lore.db` carried the same timestamp to the
second, and the monitor called it stale. A monitor that cries wolf gets ignored, and
this one guards the product.

Proven on the live deployment, 2026-08-04: restoring from the running replica gives
`integrity: ok` and every knowledge row (schema v4 and 440 rows at the time; the
schema is v7 now and the rows have multiplied, which is the point of proving the
mechanism rather than a count). `make backup-drill` repeats
that end to end on a copy, including destroying the source first.

**D-60 — the data directory is the same path on both sides, by construction.**

T0 runs the target's suite by asking the **host** daemon to start a sibling
container with the review worktree bind-mounted (D-24). The daemon resolves that
path on the HOST, so it has to mean the same thing in both places. The compose file
said so in a comment and nothing enforced it.

Where it does not match, Docker does not refuse. **It creates an empty directory and
mounts that**, so the sources silently were not there, and the first symptom was npm
reporting no `package-lock.json` in a repository that plainly has one — a true
statement about a directory nobody meant to look at, three layers from the cause.

So the container mounts the data directory at its own host path
(`${LORE_HOST_DATA}:${LORE_HOST_DATA}`) and `LORE_DATA_DIR` follows it. There is no
constraint left to violate, rather than a constraint plus a warning. The sandbox's
cache and scratch roots read the same variable instead of hardcoding `/var/lib/lore`,
which was only ever correct on a deployment whose data happened to live there.

The sync inside the sandbox must not swallow its own failure. It fails loudly, and
separately refuses an empty `/src`: `cp` exits 0 with nothing to copy, so a
misconfigured mount otherwise reports success and the suite runs against nothing.

**D-61 — git may never climb out of the directory it was aimed at.**

Git's default is to walk **up** from the working directory until it finds a
repository. A command aimed at a directory that is not one therefore retargets
itself, silently, at whatever encloses it — and lore's data directory sits inside a
checkout in every deployment run from one.

The hazard is concrete. Asking `rev-parse --git-dir` whether a freshly-created empty
directory is a repository reports the **enclosing** checkout, so a clone looks
unnecessary and the fetch that follows runs **inside the operator's own working
repository**. Read-only mounts stop it; anywhere writable it would
have pruned their refs and tags.

That is lore writing to a user's repository, which D-2 forbids and INV-9 forbids
again — reached without a single line of code intending it, through a default.

Two changes, because one of them is the class and one is the instance:

- **`GIT_CEILING_DIRECTORIES` is set to `cwd` on every git invocation.** Discovery
  may find a repository AT the directory given and nowhere above it. Cheaper and far
  more total than auditing every call site for whether its target exists.
  One call site is not the wrapper: `applyPatch` feeds the patch on stdin, which
  `git()` cannot express, so it sets the same env itself. "Every invocation" was
  written here before that was true, and a reviewer found the gap rather than a
  reader of the sentence (`a88aa1e2`) — which is the argument for the wrapper, not
  against it.
- **`ensureBare` asks `--resolve-git-dir .`**, which is a question about the path
  given, rather than `--git-dir`, which is a question about the tree.

Marked **hard** rather than confirmed: this one is not a preference. The test builds
the exact shape — an empty bare directory nested inside another repository — and
fails if either half is reverted.

**D-65 — the mirror is refreshed by a host process, and lore refuses a stale one.**

lore holds no credentials for any remote, and must not: a service holding a key holds
everything that key opens. A personal key is never asked for, and forwarding an agent
into a container that already has the docker socket would hand it the ability to sign
as the person. That is D-63's argument and it stands.

**What D-63 got wrong was whose job the refresh is.** It made it the operator's, by
hand, before each review — and the party that hits a stale mirror is the *client*, an
agent usually on another machine with no shell on this host. Told "run `make mirror`",
it can do nothing at all. Measured on 2026-08-05: that single cause failed more
reviews than every model and transport fault combined, ending with one refused against
a mirror 192 minutes old.

**So a process does it, outside docker, on the host.** `deploy/mirror-refresh.sh` runs
every five minutes under launchd (macOS) or a systemd --user timer (Linux), reads the
repository list straight out of the SQLite registry read-only, and fetches each mirror
using the credentials the host already has. Reading the registry rather than asking
the container means it keeps working while lore is down, restarting or being rebuilt
— which is exactly when a stale mirror would otherwise go unnoticed.

It refreshes **all** registered repositories, which is not what `make mirror REPO=`
refuses. That refusal is about an interactive command reaching remotes nobody named
because one was asked for; here, keeping every mirror current *is* what was asked
for, once, when the daemon was installed.

**lore does not get a deploy key of its own, though it easily could.** The host
already authenticates to the forge as someone allowed to read these repositories, so a
credential for lore would be a second secret to hold, inside the container that also
holds the knowledge base and the signing key, plus a key to authorize on a repository
the operator may not own. More machinery for a fetch that is already possible.

**Freshness has three answers, not two:** `no-remote`, `never-fetched`, `fetched(at)`.
Only the first passes without comment — nothing can be behind nothing. `never-fetched`
is a mirror with a remote configured and no `FETCH_HEAD`, which is what a successful
clone followed by a failed fetch leaves behind; it is the most dangerous state rather
than the mildest, because `refs/remotes/origin/*` does not exist either, so a worktree
cut from it would resolve the local branch frozen at the clone commit.

**Freshness is a question about cutting a base, not about running a round.** A review
is pinned to a snapshot (D-40): once its worktree exists it sees that tree plus
whatever `review_submit` applies, and never reads the mirror again. `worktreeFor` is
the one function that obtains a worktree — for the worker and for `review_submit`
alike — and it checks presence and freshness when it creates one, presence alone when
it reuses one. Requiring freshness on every round would fail any review slower than
thirty minutes, and every deep-tier review is slower than that.

Thirty minutes against a five-minute refresh is six missed passes before anything is
refused.

**A refusal now means the refresher is down, not that someone forgot**, so the
messages say what to report rather than what to run — the reader cannot run anything.
The gap this leaves is that nothing in lore knows whether the timer is alive, so
`make status` prints every mirror's age and turns red at the same threshold that
refuses a review. That is the whole safety net for the arrangement, and it has a test.

**Provisioning issues a token and nothing else.** No key is generated for any url.
The operator's remaining step is `make mirror REPO=<name>` once, and `make
mirror-daemon` so it stays current without anyone remembering.

**D-8, extended — T0 runs the target's own tooling, in the sandbox.**

Everything that needs the target's `node_modules` runs **inside the sandbox**, off
one install per review: the suite, the typecheck and the lint. `tsc` and `eslint`
resolve their binaries out of the target's dependency tree, so running them is
executing code the target controls — which D-24 places in the sandbox and nowhere
else. The service container holds the knowledge base, the signing key and every
provider credential; a `postinstall`-shaped risk must not have a second door.

`semgrep`, `ast-grep`, `sbom` and `osv` stay outside it. Those are lore's own
binaries reading files: they need no install and execute nothing from the tree.

**Where the target declares a script, that script wins.** A monorepo's answer to
"does this typecheck" is `turbo run typecheck` across every package, not one `tsc`
at a root that has no `tsconfig.json`. A script's output is not a format we can
parse into per-line findings, so a failure becomes one finding carrying its tail —
which beats reporting nothing, and beats reporting clean. Where there is no script,
the structured `tsc`/`eslint` parse still runs and still gives per-line findings.

**Installation follows the lockfile.**

T0 runs the target repository's tooling rather than ours, and that includes how it
installs. The lockfile decides: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
otherwise npm. The managers are baked into the sandbox image rather than fetched by
corepack at run time, because install and test are two separate containers and the
only thing mounted into both is `node_modules`.

This is not a convenience. A pnpm monorepo cannot be installed by npm — the
`packageManager` field and a `preinstall` guard both refuse it — and the failure is
not confined to the suite: `tsc` and `eslint` run through `npx --no-install` and
resolve out of `node_modules`, so an install that does not happen silently removes
three of T0's engines at once.

A lockfile naming a manager the image does not carry — bun, which is a runtime and
not merely an installer — is reported as an **unavailable engine**. Installing with
npm instead and presenting the result as that project's suite would be a confident
claim about something that never ran.

**D-74 — one vendor per tier, and the deployment finally has one.**

The deployed ladder is T1 `zai-coding-plan/glm-5-turbo`, T2 `kimi-for-coding/k3`, T3
`openai/gpt-5.6-terra` — three vendors on three subscriptions, no metered API.

Until 2026-08-06 T1 and T2 were both Z.ai. Nothing was reported falsely: D-49's
sole-vendor check fires only when EVERY model tier shares a vendor, and T3 was OpenAI
throughout. But two thirds of the ladder shared a blind spot, and a ladder's whole
claim is that a dearer tier is an *independent* look rather than the same opinion
asked again. The check was doing what it says; what it says is weaker than what the
ladder implies, and that gap is worth naming rather than leaving for someone to
discover in a `passed`.

**Moonshot sits at T2 rather than T3** because T3's argument is unchanged (D-30): the
last line of defence is where an independent vendor is worth most, and OpenAI's capped
rolling window fits the rarest call in the ladder. T2 is the first deep look and the
first place independence starts to matter.

**`k3`, not `k3-256k`, and the naming reads backwards.** `k3` carries 1,048,576 tokens
of context; `k3-256k` carries 262,144 — the suffix names the SMALLER variant. The
largest review this deployment has run sent 204,609 tokens, which is 78% of the smaller
window with no room for a reply. Chosen on that measurement; choosing on the name would
have picked the one that runs out.

**Model ids come from opencode, never from memory.** The provider is `kimi-for-coding`
and the ids were read from `/config/providers` on the running server. `DEFAULT_TIERS`
still names `openrouter/moonshotai/kimi-k3` for a gateway route nobody here uses, which
is a guess nothing has verified — it applies only when `LORE_TIERS` is unset, and this
deployment always sets it.

**D-73 — a justification is not part of the code it defends, and its fact is learned
once.**

`lore-ok` lines are stripped before the scope hunk is hashed. The marker is an
annotation *about* code, not code, so writing it or removing it never expires the
reason it carries. A real edit to the surrounding code still does, which is the whole
point of expiry (D-20): a reason must not outlive the thing it was about.

**Without this, a justification invalidated itself by existing.** Clients are told to
write the marker at the site; the scope deciding whether the justification survives was
the hunk around that same line. So the reason lived inside the code it depended on
staying stable. Observed 2026-08-06 as a livelock: one semgrep false positive, in a
file the branch never touched, justified and expired four times across nine rounds —
accepted at 2, expired, 4, expired, 6, expired, 8, expired, with a byte-identical hunk
every time. It cost 109 minutes of model time and ended when the review hit a bound.

This is what `spec/knowledge.md` already asserted and the code did not do: *a
justification's scope is taken from the code it defends, never from wherever the reason
is written.* The rule was right; nothing made it true.

**An accepted justification teaches its fact once.** Ratifying the same reason again is
the same fact, not a new one. Nothing checked, so the livelock wrote it on every cycle:
21 of one repository's 27 derived rules were a single sentence about a single false
positive, and every copy then entered the next reviewer's prompt. Matched on the
statement, because the statement *is* the fact; a differently-worded reason for the same
finding is a different claim and is kept.

**The client is no longer told to prefer a lore-ok.** `TOOL_DOCS.submit` advised
choosing it over a rewrite because "a settled finding does not restart the ladder" —
true, and advice to optimise for the review ending rather than for the code being
right. It now says to choose on whether the finding is true, and notes that a
justification for a finding you privately agree with is the most expensive answer of
all: the next tier reads it, and a refused justification returns at higher severity.

**D-72 — a deploy drains rather than interrupts, and blue/green is the wrong shape.**

`make deploy` sets a drain flag, waits for in-flight rounds to finish, then rebuilds
and starts. Draining affects **claiming only**: MCP keeps serving throughout, clients
poll and submit and start reviews as normal, and new work simply queues for the next
container. Nobody sees an error.

**What a restart costs is model time, not state.** Everything is in SQLite, so
nothing is lost — but `reclaimOrphanedJobs` requeues an interrupted round and it runs
again from scratch, paid for twice. One morning that was 109 minutes of t2 work in a
container that could have been drained first.

**The flag must not survive the restart it was for**, and the starting process clears
it — in code, so every start path is safe including a plain `docker compose up`. A
persisted flag would mean a container that starts, claims nothing, and answers
`/status` with `ok: true` while the queue grows: healthy and doing nothing, which is
the failure this project exists to refuse. `/status` reports `draining` for the same
reason — from outside, a drained service and an idle one look identical.

**Two live containers is not a smaller version of this; it is a different and worse
thing.** `reclaimOrphanedJobs` runs unconditionally at startup and requeues every job
in `running` state — so a second container would requeue the rounds the first is
actively working, and both would run them: two workers on one review, both writing
findings, both stepping the ladder. Making that safe needs a worker identity and lease
column so a process can tell its own orphans from another's live work, a file-based
install lock instead of the in-process one, and a proxy for the port.

It would buy nothing. MCP is stateless by construction (`sessionIdGenerator:
undefined`) and every request is milliseconds; the only long-lived thing here is a
background job, and a job does not need to be served by a particular container — it
needs not to be killed halfway. Draining achieves that with a flag and a wait.

**`make drain` says what it is waiting for** — review, branch, elapsed seconds — and
times out loudly with a choice rather than hanging or quietly giving up. A deep tier
legitimately takes twenty minutes; a stuck one never finishes, and only a person can
tell those apart.

**D-71 — lore reads a test suite and never runs it.**

Test execution is gone: not disabled, not opt-in, removed. `tests` is no longer a T0
engine, there is no `LORE_RUN_TESTS`, and nothing in the sandbox knows how to invoke a
suite. Reading tests remains, and is a model-tier job — is the change covered, does a
test assert what its name claims, did a fix arrive without one.

**A failing suite belongs to whoever owns the repository.** Their CI runs it on every
push and already tells them. Running it here meant executing an arbitrary dependency
tree on the review host to rediscover a fact its owner has — real cost, real risk,
and a finding that was never ours to make.

This supersedes **D-24**, which made execution opt-in and defaulted it off.
The honest history is that it shipped, produced its best-ever finding (a suite failing
where GitHub's `--affected` check could not see it), and was then turned off by default
the same day — after which every `code-arch` review carried a permanent
`tests: execution is disabled` in its skipped list. An engine that reports NOT RUN on
every review is the `ast-grep` problem in the entry that matters most: it trains a
reader to skim the one list where skimming is expensive.

**The sandbox stays and D-24 is unchanged.** `tsc` and `eslint` resolve their binaries
out of the target's `node_modules`, so the *install* still runs, and an install runs
lifecycle scripts with network. That is what the ephemeral container contains.

**D-70 — a finished review gives its worktree back immediately.**

A terminal review's worktree serves nothing. Its tree hash is already recorded,
attestation reads only the store, and `review_submit` refuses a finished review — so
the moment a review reaches `passed`, `passed_partial`, `failed` or `expired`, the
worker releases the worktree. The hourly sweep keeps a zero-day window as the backstop
for anything that path missed.

**Released through git, never by deleting the directory.** git keeps its own record
under `bare.git/worktrees/<id>`, so an `rm` leaves `git worktree list` naming
directories that are not there and administrative files nobody collects. The sweep did
exactly that, and it had never shown because the seven-day window meant nothing was
ever old enough to remove.

**Why a review becomes orphaned**, measured on 2026-08-05 across 11 abandoned reviews:

- **Nothing obliges the client to finish.** It polls, collects the findings, and stops.
  A review then sits in `findings_ready` for ever, holding a worktree, until the
  staleness sweep expires it 48 hours later. This is the dominant cause and it is not
  a bug in the client — the loop simply has no deadline in it.
- **Restarting instead of continuing** orphaned four of the eleven, all on one branch.
  Fixed separately: `review_start` refuses a branch that already has an open review.
- **A review that fails mid-round** leaves a worktree its review will never use again.

Orphaned is therefore normal, not exceptional, and reclamation is a routine duty
rather than an error path. What must NOT happen is an expired review reading as a
clean one: `expired` is its own state, never `passed`, because a review somebody
walked away from told us nothing about the code (INV-1).

**D-68 — a finding outside the diff, from a pattern engine, belongs to the repository
rather than to the branch.**

T0 scans the whole worktree, so semgrep and ast-grep report every match in the
repository — and the same matches then appear on every unrelated branch, for ever.
They are marked `preexisting`, ranked below the branch's own findings, and reported
with a note saying they are worth a ticket but not this merge's to answer.

Reported, never dropped: the defect is real, and dropping it would be INV-1's failure
wearing a tidier coat. What was wrong was the attribution, and the cost of getting it
wrong is ordering — a client triaging by severity answered two inherited `high`
pattern matches in test fixtures it had never opened before three `medium` spec
contradictions in files it had written.

**Only pattern engines.** semgrep and ast-grep match text that was already there, so
"outside the diff" really does mean "not this branch". `tsc`, `eslint` and the test
suite are project-wide: a change here genuinely can break an untouched file, and
calling that pre-existing would be the more dangerous mistake of the two.

**D-69 — a token reaches its own repository and no other.**

Tokens are minted per repository. Access control asked only whether the PRINCIPAL
matched, and a workgroup provisions every repository to the same human — so one
person's token for repo A listed and fetched their reviews of repo B. Reported by a
client that could see lore's own branches through a rigid-monorepo token.

Both the inbox and the review lookup are scoped by `repo_id` now. A valid id from
another repository fails as **not found**, not as forbidden: "this exists but is not
yours" tells an unauthorized caller the id is real, and an id is the one thing worth
guessing (D-23).

The test that should have caught this was called *binds each token to its own repo*
and asserted that the token ROWS carry different `repo_id`s. It passed throughout,
because it never checked that anything was scoped by them — a test named for a
property it did not test.

**D-66 — a finding the schema rejects loses its own line, not the whole reply.**

The valid findings in a reply are kept; the rejected ones are recorded and reported.

This reverses the earlier rule, and the reversal turns on one word. The argument for
all-or-nothing was that keeping the good findings would *silently* drop a defect the
model actually found — and it is the silence that does the damage, not the dropping.
Discarding the whole reply drops that same defect and every valid finding beside it,
so it is strictly worse on the axis it was defending.

Measured before changing it: five paid replies binned this way. The worst was a t2
round of forty minutes returning one finding, over the cap by fourteen characters,
which was correct and load-bearing — `openFindings` had no latest-verdict gate, so a
justification accepted and later rejected counted as neither open nor settled. It was
fixed from the error message alone. The cap filtered a real defect and charged forty
minutes for it. **And the retry does not rescue this**: told the exact rule, the model
shortened its claim by 44 characters and still landed 14 over, twice.

So the loss is made loud instead of total. It is logged in full, and it travels to the
client in `checks_skipped` — the same channel as an engine that could not run, because
it is the same class of fact: *this tier looked at the code and said something the
review does not contain*. A reply where NOTHING parsed is still a failed round; there
is no partial result to keep, and calling it clean would be INV-1's exact failure.

**D-67 — severity belongs to the engine that raised it. Recurrence informs the reader
and never demotes.**

A finding that has been raised and justified before keeps its severity. `enrich()`
attaches `priorOccurrences` and the related rules to every finding, including T0's, so
the reader is told *"seen 6× before in this repo — this is a pattern, not an
incident"* and can weigh it. What the accumulated verdicts do not do is lower the
severity.

The tempting change is the other one: semgrep's `http://` rule fires `high` on test
fixtures every time, this codebase has justified it four times, so demote it. The
reason not to is that **the finding is true**. A loopback URL in a test file really is
an unencrypted request; what makes it acceptable is context a rule engine does not
have. Demoting on familiarity would mean the second occurrence of a real defect
reports as less serious than the first — and the same machinery that quiets a known
false positive would quiet a known-and-recurring genuine one, which is the more
dangerous direction by a long way.

The right place to spend a justification is the finding, not the class: an accepted
one settles it and carries forward (D-51), which is quieter than a demotion and says
something true.

**D-64 — `claim` is capped at 500.**

The cap enforces *shape*. A finding that sprawls cannot be compared with another
finding, and output tokens are ~77% of the top tier's cost once input is cached
(D-29), so a reviewer that writes essays instead of records costs several times more
at every tier, forever.

500 is where it sits because a model writing one precise sentence about a subtle
cross-file invariant lands between 310 and 360 characters, and the cost of refusing
one is the **whole reply**: the batch is discarded, the retry is charged, and a model
told the exact rule does not reliably comply with it. A tier that spends twenty
minutes and returns one correct finding must not lose it to a clause. 500 clears that
range with margin while staying four times smaller than `TEXT_MAX`, so `claim` is
still the field that must be short and `evidence` the one that may be long.

**The cap is raised rather than the claim truncated.** A claim cut mid-clause is a
finding that says something its author did not — the same failure as every other one
in this file.

**The number exists in exactly one place** and is interpolated into the output
contract the models read, so the prompt cannot state a limit the schema does not
enforce. A test greps the source for an executable `300` or `500` on any line
mentioning a claim; it matches the current value too, so raising it again cannot leave
a fresh literal behind. Comments are exempt: a comment recording what a model once
wrote against an older cap is history, and rewriting it would falsify the record that
justifies the number.

**D-43 — review types.** `review_start` takes a `type`, defaulting to `code-arch`:
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

**D-24 — the sandbox contains what the target controls.** *(Its test-execution half
is superseded by D-71: lore reads a suite and never runs one.)*

The containment holds and is still needed: no network during the run, every capability
dropped, no host filesystem, no docker socket, no sight of the database, hard limits
and an ephemeral container.

**Because running nothing was never the same as executing nothing.** `tsc` and
`eslint` resolve through the
target's `node_modules`, so the install still runs — and an install runs lifecycle
scripts, with network, because a registry needs one. Turning tests off narrows the
exposure; it does not remove it. A deployment that wants none of it must accept that
the deterministic tier reports typecheck and lint as unavailable too.

**D-24.** Running the target's tests is arbitrary code execution, and the threat is
the dependency tree rather than the teammate — a *careless* suite, not a hostile
one. The service container holds the knowledge database, the attestation signing key
and every provider credential, so it **must not** be where a `postinstall` runs. It
holds no git credentials at all (D-65). Separate ephemeral container, no
secrets, no network, hard timeout (`spec/review-ladder.md` §1.1.1).

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
