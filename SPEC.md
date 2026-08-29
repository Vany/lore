# SPEC — `lore`

A hosted MCP service that reviews a branch before it merges, and — the actual
point — **remembers the codebase between sessions**.

Status: **deployed and reviewing itself**, 2026-08-06. All phases in `PLAN.md` have
code; 552 tests. Live: 53 reviews, 3 attested, 332 live knowledge rows, 132 model
calls. Unproven: `passed_partial` and quota exhaustion, which
have never executed; and Kimi at T2, configured and not yet used for a round.
`needs_human` has fired once and was wrong. `TODO.md` keeps those open rather than
folding them into a tick.

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
| `spec/propose.md` | `lore propose` — the idea generator, which gates nothing |
| `spec/mcp-async.md` | the asynchronous surface: one conversation per tier, nothing polls (D-80) |
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

A review outlives an MCP request, so `start` returns an id and the client is told the
answer later. There is no progress estimate, because we cannot honestly give one.

**Two ways of being told, and the order matters.** A client that can reach the
2026-07-28 protocol revision opens `subscriptions/listen` on `lore://review/{id}` and is
woken by `notifications/resources/updated`; a client that cannot calls `review_poll` in
a backoff loop. Subscription is the designed path — it is the one that removes the
waiting, and it is what the tool texts lead with (D-80, `spec/mcp-async.md`).

The old justification here — *"MCP servers cannot initiate requests"* — was true about
**requests** and was carrying an argument it could not support: a server has always been
able to send notifications, and since `2026-07-28` there is a mechanism built for exactly
this shape. It shipped on 2026-08-06.

Polling is still the floor, and for a measured reason rather than caution: the official
client SDK negotiates the 2025 era **by default**, and `subscriptions/listen` does not
exist there. So most clients will poll until one is shown to negotiate up
(`research/mcp-subscriptions.md` §4). That is also why a client that must poll has no
deadline, and why reviews are abandoned in `findings_ready` until a sweep expires them
(D-70).

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
| **D-6** | A closed tier stays closed; the tier that asked judges the answer | **revised** |
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
| **D-20** | Sources: taught > ingested > derived, each with provenance | confirmed; extended 2026-08-07 |
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
| **D-33** | The host is whatever the workgroup can reach; **tokens are the perimeter** | **revised twice** |
| **D-34** | Two stages: T0+T1 inline, T2+T3 async, collected via `review_inbox` | confirmed |
| **D-35** | Bootstrap on first review — at provisioning there is nothing to clone | **revised** |
| **D-36** | Git submodules, not monorepos — a gitlink bump is expanded | confirmed |
| **D-37** | T0 is the local bottleneck — but ~25 min/day, not 5 hours | **measured** |
| **D-38** | `ticket` text is required — enables the scope-creep axis | confirmed |
| **D-39** | Knowledge conflicts are findings; unresolvable ones need a human | confirmed; the 2026-08-06 narrowing is decided, not built |
| **D-40** | Reviews are explicit and snapshot-pinned; attestation covers a tree | confirmed |
| **D-41** | Developer alarms are the client's job; `lore` provides information | confirmed |
| **D-42** | `lore` alerts devops about itself, with a heartbeat deadman | confirmed |
| **D-43** | Review **types**; `code-arch` is the default, `security` is next | confirmed |
| **D-44** | Findings carry an optional CWE id — the shared vocabulary | confirmed |
| **D-45** | The project is **`lore`** | confirmed |
| **D-46** | A conflict block must have an exit: resolve, or escalate | confirmed |
| **D-47** | D-1 is enforced by **absence**: no Anthropic credential is deployed | confirmed |
| **D-48** | A tier that cannot ANSWER — unfundable, or dead after its retry — is *skipped*, not fatal. What that costs the verdict is D-88 | confirmed; widened 2026-08-08, narrowed 2026-08-09 |
| **D-84** | ~~opencode swallows the limit and the reset time~~ — **WRONG, see D-91.** It swallows them in the message BODY and publishes them on its event stream | corrected 2026-08-09 |
| **D-85** | A tier on a metered plan carries `skip_if_quota` — one attempt, then skip. A failed call's tokens are recorded | built 2026-08-09 |
| **D-86** | **A cancel stops both ends**, and `stopped_in_flight: null` says when the server could not look | built 2026-08-09 |
| **D-87** | The knowledge screen stops for the pass on a fault that belongs to the TIER, not to the document | built 2026-08-09 |
| **D-88** | **A tier skipped BELOW one that passed does not weaken the verdict.** The ladder is a gate; its work was done again above it | built 2026-08-09 |
| **D-89** | **The knowledge screen runs in the background.** No review waits for a model call that only decides what its prompt looks like | built 2026-08-09 |
| **D-90** | **A tier that stopped answering is not asked again** — until the provider's own reset time (D-91), or a doubling cool-off when it named none. A STATED time also skips it in reviews | built 2026-08-09; widened same day |
| **D-91** | **Subscribe, never wait.** opencode narrates every call on its event stream; a quota refusal arrives in seconds, with its reset time | built 2026-08-09 |
| **D-92** | **t0 is not re-run on a tree it has already read**, and its pattern engines see the branch's files, not the repository | built 2026-08-09 |
| **D-93** | **An exhausted subscription asks elsewhere** — a list of routes, tried in order, verified at startup | built 2026-08-09; list 2026-08-12 |
| **D-94** | **A cooled-off tier is asked again every 15 minutes.** lore could hear a tier die and not hear it recover | built 2026-08-10 |
| **D-49** | **Fewer vendors than tiers** reaches `passed_partial`, never `passed` — widened from single-vendor 2026-08-17 | confirmed |
| **D-50** | Exploration is **counted per review before it is capped**. Distribution measured 2026-08-11: longer rounds find LESS | cap `[OPEN]` |
| **D-51** | An accepted justification is **repo knowledge**, carried across reviews | confirmed |
| **D-52** | The per-tier cap bounds *iteration*, so a clean tier escalates past it | confirmed |
| **D-53** | One round at a time **per review**; reviews still run in parallel | confirmed |
| **D-54** | t1 is `glm-5-turbo`: glm-4.7 answers 200 with an empty body | confirmed |
| **D-55** | A submit is **refused** while a round is reading the worktree | revised by D-107: held, delivered at the next emission — built 2026-08-14 |
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
| **D-75** | `propose` is an **idea generator for the maintainer**, never a gate | built; ideas unmeasured |
| **D-76** | A change is validated **over MCP**; a CLI run is never evidence the product works | `[OPEN]` |
| **D-77** | **Commit, review to a verdict, amend, push.** Batches, not commits — revised 2026-08-15, see below | `[OPEN]` |
| **D-78** | A review answers to **the token that started it**, not to its repository | built |
| **D-79** | A finding is **what the author missed and would be hurt by** — asked, not filed | confirmed |
| **D-80** | A review is **one conversation per tier**, not a series of audits. Fully async | subscription live; continuity built 2026-08-12; streamed conversation built 2026-08-14 (D-107) |
| **D-81** | Extraction stays deterministic; a **model may only VETO** what it mined | built; screen unmeasured |
| **D-82** | **A defect found is fixed now**, and the batch is reviewed whole — one big diff, not many | confirmed |
| **D-83** | A project's **development rules are appealable**: cite one, the tier rules on it | built |

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

**D-39, revised 2026-08-06 — a person is called only when the two rules cannot be
ORDERED.**

The original stopped on every detected contradiction. That is too eager, and the
production record says so: the path has fired exactly once and was wrong — two ADR
sentences restating one constraint, read as a contradiction because `polarity()`
cancelled negations across a whole statement. It halted a review whose findings were
all settled, and demanded a person for a question that did not exist.

The two errors are not symmetric, which is what settles it. **A wrong escalation stops
a review and spends a person; a wrong auto-resolution retires a rule with its reason
preserved** (§7.1) and is recoverable by reading it back. With the detector at one for
one, stopping is the more expensive mistake.

**DECIDED, NOT BUILT — and the tense here matters, because this document is the one a
session trusts.** What follows is what the code SHOULD do; `knowledge/conflict.ts`
consults neither column today and every detected contradiction still escalates. The
ordering it will use is already in the store:

- **Source rank** — `taught` > `ingested` > `derived` (D-20). Different ranks will
  decide it: a rule a human stated outranks one inferred from reviews, and no person
  needs asking to know that.
- **Recency** — `verified_at`. Same rank, different times: the later one wins. That is
  D-39's own prior, to be acted on rather than noted and then ignored.

**A person will be called when neither separates them** — same source rank and no
usable difference in time, which is exactly what two rules re-ingested from one
document revision look like. Then there genuinely is no way to tell which is current,
guessing would be a coin toss, and the coin is a belief injected into every future
session.

Until it is built, every conflict calls a person, which is the original behaviour and
the more expensive of the two mistakes. `TODO.md` carries it, and `spec/knowledge.md`
§7.1 says the same thing in the same tense — this paragraph did not, and a reader who
trusted this document alone would have believed rank and recency were in effect.

Everything else about D-39 stands: the loser is retired with its reason rather than
deleted, and while a `needs_human` is open the review cannot pass, cannot attest, and
cannot be closed with `lore-ok` — a justification is a claim about code, and this is a
question about which of two beliefs is true.

*Original, kept because it is what the revision narrows:* a knowledge conflict is not
resolved by the store; it becomes a finding the reviewing agent must actually work
through. Newer *leans* correct, because code evolves — but that is a prior, not a
verdict, and a careless recent rule must not silently overwrite a reasoned older one.
If the agent cannot decide, it marks `needs_human` and says so.
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

**D-120 — the client is never told anything about lore's budget. WE ARE SERVING; we do not
hand our responsibility to the person we serve. DECIDED 2026-08-16.**

Vany: *"never tell client anything about the budget. Here is SLA, we serving. We do not
hand off our responsibility to the client."*

A client asked for a review. Whether lore can afford to run it is **lore's problem**, and
saying so in a client channel does three bad things at once: it hands somebody an
operational fact they cannot act on, it implicitly asks them to work around a service that
exists to serve them, and it invites exactly the wrong behaviour — retrying, waiting,
downgrading their own expectations, or merging unreviewed because the tool said it was out
of money.

**What the client may be told, and it is a complete list:** what was examined, what was
NOT examined and therefore what the verdict is worth, and what to do next. INV-1 is fully
served by that — `passed_partial` naming the tiers that did not run is the honest weaker
claim, and it stays. What must never appear is WHY in money terms: no ceiling, no spend
figure, no per-call cost, no "out of quota", no "come back when the budget resets".

**Two live leaks this decision closes**, both of which read as diligence and are not:

* `failed_because: "not started: today's spend 101.36 has reached the 100.00 ceiling"` —
  the exact string eight of other people's reviews carried today. It is lore's ledger,
  printed in their failure. Removed at the source a day later: nothing refuses a review for
  money any more (D-121), so the sentence has no way to be written.
* The metered-fallback notice in `checks_skipped`, which briefly carried `THIS CALL COST
  $4.83`. Fixed the same day it shipped: the client's line names the ROUTE — which is
  genuinely theirs, because D-49's independence claim rests on which models read the code
  — and the figure moved to the operator log.

**The distinction is the audience, not the honesty.** D-41/D-42 already say lore has two
audiences and two channels; this is that rule applied to the one subject where the
temptation to blur them is strongest, because a budget failure *feels* like something to
confess. It is something to fix. The operator gets everything — the ceiling, the
per-call cost, the parked route, the pause; the client gets a service that either reviews
their code or says plainly what it did not examine.

**A vendor verdict must REPLACE, never merge. FIXED 2026-08-17.**

Two findings, one root, both from lore's own review of D-49's widening. `soleVendor` was
seeded by `initialState` from the CONFIG, before a single tier had run, and `step()`'s
terminal branch only ever ADDED it back on a fresh collapse — an object spread of `base`
cannot delete a key `base` already carries. So a one-model-tier ladder that finished
`passed` was signed *"every tier that ran was X, so these are not independent opinions"*,
and — worse, because it is the ordinary shape rather than an edge case — a three-tier
all-one-vendor CONFIG that diversified mid-review through a cross-vendor fallback was
signed the same way about a review a second vendor had genuinely read.

Fixed by removing the write entirely, in both directions. `initialState` writes nothing:
nothing has run at round 0, so there is nothing yet to attest. And the terminal branch of
`step()` now destructures `soleVendor`/`vendorSpread` OUT of `base` before building the
returned state, then conditionally re-adds them — REPLACE, not merge — so a review that
reaches this branch a second time (a client's late fix, a `pull_fresh`, taking it through
another terminal pass) cannot inherit a verdict from the pass before it. The one thing
tying both readers together — `/status` and the signed attestation neither have access to
the tier config at read time, only the persisted `LadderState` blob — is unchanged; what
changed is that the blob is now authoritative for THIS assessment alone.

**SECURITY — a client's `commit` reached git's argv as an option. FIXED 2026-08-17,
same day it shipped.** D-124's commit form passed the caller's string straight into
`git diff <tree> <commit>`; git parses any argument beginning with `-` as an OPTION rather
than a ref, so `commit: "--output=<path>"` made git write the diff over an arbitrary file
— reachable by any token holder from an ordinary `review_submit` call, against a service
whose database IS the product, and a direct breach of D-61 (git may never be aimed outside
the directory it was given). Raised by lore's own t2 at high, against code deployed hours
earlier. Fixed with the pattern already used for a client-supplied branch: `rev-parse
--verify --quiet <ref>^{commit}`, checked to be 40 hex characters, so only a sha ever
reaches argv — an option resolves to nothing and is refused by name.

**And the fix for THAT exposed a second bug: the resolution itself raced a running round
(D-55).** Computing the delta called `treeHash(worktree)` — `git add -A` plus
`write-tree`, which mutates the shared index — unconditionally, before checking whether a
round was mid-read of the same worktree. A submit that only wanted to know what changed
could collide with the round's own periodic re-hash (`withHoldLock` in `runRound`); when
the round's side of that race lost, it surfaced as something that was not a route fault,
so a tier's catch rethrew it and the WHOLE REVIEW failed — over a submit that never
touched the tree it corrupted.

Fixed by not needing the live snapshot at all: the review's own `treeHash` column,
written back on every prior submit and round boundary, already records what its worktree
currently represents — the same value D-40's pin discipline treats as authoritative
everywhere else. Reading it is a query, not a filesystem write, so it cannot collide with
anything the round is doing; `treeDelta` itself was never the hazard, since `git diff
<tree> <tree>` reads two committed objects and touches no index. Falls back to a live
snapshot only when no tree is recorded yet AND no round is pending — a state a review
reaching `review_submit` should not be able to reach, since the tool's own precondition
(`findings exist`) implies a completed round, which always writes this field.

**D-130 — a review can target a folder instead of a diff: no base, every file at a
path read as it stands. BUILT 2026-08-25.**

Every review before this was diff-scoped — `review_start` required `branch` and
`into`, and the whole pipeline (T0, the model prompts, findings, the ladder,
attestation) was built around "what changed between two refs." Vany asked for a
second, explicit way in: point lore at a folder — a whole repository, or a
subdirectory — and review what's *there*, with diff mode staying the default.

**The move that kept this small: represent it as a diff against git's well-known
empty tree, scoped to a path.** `git diff 4b825dc642cb6eb9a060e54bf8d69288fbee4904
-- path` (that hash exists in every repository, no setup needed) is an ordinary
unified diff where every file is shown as added — verified directly before writing
any code. Because the result is a genuine `ReviewDiff` (`src/git/diff.ts`), almost
every mechanism downstream of one needs **no changes**: T0's pattern engines are
already scoped to `diff.changedFiles` (D-92), which `wholeTreeDiff` populates as
exactly the files under `path` — so they read what folder mode means to review, not
the whole worktree, with nothing folder-specific added; the model prompts, finding
storage, staleness (D-56), `review_submit` and the ladder all consume a
`ReviewDiff`/worktree generically and never inspect how the diff was produced.
Attestation is the one exception, below. `wholeTreeDiff` is a new function beside
`computeDiff`, not a branch inside it —
`computeDiff` is dense with incidents about resolving a real `into` (merge-base,
`behindBy`, `mergesClean`, overlap since divergence), none of which has an answer
without one, and threading a fake base through it risked exactly the kind of edge
case its own comments document this project having been burned by before.

**`renderDiff` needed a real branch, not just graceful degradation.** Its header
text ("THIS DIFF IS THE CHANGE THE BRANCH INTRODUCES", a commit list, "the fork
point") is actively wrong for a folder review — mechanically nothing crashes
(zeroed `commits`/`behindBy` collapse those blocks harmlessly), but the framing
would mislead a model into treating a stable, unremarkable folder as a suspicious
zero-history branch. `ReviewDiff` gained one field, `scopePath: string | undefined`,
so `renderDiff` (and the empty-diff refusal in `runRound`) can self-detect the mode
from the diff object itself rather than a second mode parameter threaded everywhere
one travels. Set, it prints instead: *this is a full read of `path`, not a diff
against a prior version — every line below is shown as added because that is how a
whole tree renders as a diff, not because it is new code.*

**MCP surface: `review_start` gained `mode` and `path`, not a new tool.**
`mode: z.enum(["diff", "folder"])`, default `"diff"` — today's exact behaviour when
omitted. `path` is required when `mode: "folder"`, refused otherwise; `into` is
required for `mode: "diff"` (unchanged), refused for `"folder"`, which has no base
for it to name.

*Why an explicit `mode` rather than inferring folder mode from an omitted `into`:*
today, forgetting `into` gets a clear schema error. If omission silently meant
folder mode instead, that mistake would silently review the wrong thing at the
wrong scope instead of failing loudly — a footgun this project's whole ethos
(INV-1, D-40, "refuse rather than guess") argues against for the sake of one
shorter parameter.

*Why `path` has no default to the repository root:* a whole real repository's
diff-against-empty-tree usually exceeds the existing 600,000-character ceiling
(INV-7) and every tier that reads it spends real quota on a mostly-truncated
prompt. Silently defaulting an unscoped "review the folder" to the whole repo risks
a client burning a full ladder's quota by accident; `"."` said explicitly costs
nothing and matches how every other ambiguous client intent in this surface is
refused rather than guessed.

**Store layer: one migration, one pre-existing constraint worked around rather than
relaxed.** `review.review_path TEXT` is a plain additive `ADD COLUMN` (`schema.ts`),
nullable, matching every migration before it. `into_ref` predates this feature and
is `TEXT NOT NULL` in the original `CREATE TABLE` — and this project's migration
list can only express `ADD COLUMN`, deliberately (`applyMigrations` refuses anything
else). Relaxing an existing `NOT NULL` needs a real table rebuild, which was real
risk on a live database for a boundary this narrow. Folder-mode rows instead write
`""` to `into_ref` — confined entirely to `store.ts`'s read/write boundary and
translated back to `undefined` there, never leaking the sentinel into the rest of
the codebase, which sees `ReviewRow.intoRef?: string` exactly as if the column were
truly nullable. Unambiguous rather than merely convenient: git itself refuses an
empty ref name, so `""` cannot collide with a real branch.

**One-review-per-branch (D-40) is keyed on `(repo, branch, path)`, not `(repo,
branch)`.** `store.openReviewFor` gained a `path` parameter, compared with SQL `IS`
rather than `=` (which never matches NULL, and would have made every ordinary
diff-mode review invisible to its own dedup check). A folder review of one path no
longer collides with a diff review of the same branch, or a folder review of a
different path on it. Consequence stated plainly rather than left to be discovered:
`pull_fresh` on an open folder review must repeat the same `path` to find it, same
as it already has to repeat the same `branch`.

**D-92's argv-scoping is what actually keeps a folder review inside `path`, and it
needed no code of its own to change — corrected here after first describing this
the other way round.** Pattern engines are invoked with `files: diff.changedFiles`
(`review.ts`), turned into their argv by `scopePaths` (`t0/engines.ts`) — so in
folder mode they scan exactly `path`'s contents, never the rest of the worktree,
automatically. **D-68's `preexisting` demotion is a real safety net underneath
that, not the primary mechanism keeping a folder review scoped:** `scopePaths`
falls back to scanning everything (`["--", "."]`) once a change-set exceeds 200
files, and only THAT path — the same one an ordinary large diff already takes —
can produce an out-of-`path` pattern-engine hit for D-68 to correctly rank below
the review's own findings. Below that fallback, there is nothing outside `path` to
demote, because nothing outside it was ever scanned.

**Attestation DOES need a change — found by lore's own review, medium severity,
after the paragraph above first claimed otherwise.** The signed line's tree hash
is the whole worktree's, identically for every review (D-40) — that stays, so a
signature remains checkable against `git rev-parse` regardless of mode — but the
tiers behind a folder review read only `path`, and "reviewed tree X" with nothing
further would claim more than that to a reader who takes the signed line on its
own, as its whole design intends they should be able to. `attest.ts` now appends
`(scoped to <path>)` right after the tree hash when `reviewPath` is set — a plain
fact stated beside the claim it qualifies, not a caveat conditioned on anything
having gone wrong.

**A submodule inside `path` used to lose its findings to D-68's own demotion —
found by lore's own review, verified directly against a real git submodule fixture
before fixing.** `changedFiles` came from `git diff --name-only`, which lists a
submodule only by its gitlink name ("inner"), never the files inside it — true even
with `--submodule=diff`, confirmed empirically. The patch text (same flag) DOES
expand it. So a pattern-engine hit on `inner/deep.txt` read `diff.changedFiles` as
not containing it and was marked `preexisting`, sorted last, exactly the demotion
D-68 gives a hit genuinely outside the review. In a full read — where the workgroup's
own submodule shape (D-36, §6.1) makes this a real case, not a hypothetical one —
that silently buried a first-class finding as inherited repository debt. Fixed by
building `changedFiles` from the patch text itself (`filesInDiff`, moved here from
`reviewer/review.ts` — diff-text parsing belongs beside the code producing diff
text, not one layer up in the code consuming it) rather than a separate
`--name-only` call.

**The tier-facing prompt wrapper still asked "does it do MORE than was asked?" —
found by lore's own review, contradicting the very header it wraps.** `renderDiff`'s
folder-mode framing ("judge it as the code that exists, not as a change someone just
made") was fixed in an earlier round of this same review, but `reviewPrompt`'s own
"THE TASK THIS CHANGE IMPLEMENTS" section — unconditional, no branch on scope —
still told every tier to flag "unrequested refactors, renames and improvements" as
code nobody decided to write. In folder mode almost everything read is exactly that:
code nobody "just wrote". A compliant tier reading both instructions would flag a
stable module's entire pre-existing contents as scope creep. `taskFraming()`
(`reviewer/prompts.ts`) now branches on `scopePath`: folder mode asks whether the
code matches what the ticket says it should do, and explicitly says not to flag
existing code as unrequested.

**`path` reaching outside the worktree was neither refused nor given lore's own
failure vocabulary — found by lore's own review, matching the precedent `into`
already set.** `"../shared"` or an absolute path (natural for an agent, which the
review loop's own prompt trains it to think in) normalized without complaint and
reached `wholeTreeDiff`'s `git diff ... -- <path>` call, which exits non-zero for a
pathspec outside the repository — the exact "raw git vocabulary about a directory
nobody can see" failure `computeDiff`'s own comments document `into` being given a
curated refusal to prevent. `path` now gets the same: refused at the door, before
anything is looked up or spent, naming the actual problem rather than a git
internals error about a path on the client's machine.

**Found a second time, same finding: the refusal checked absoluteness on the
NORMALIZED path, and normalizing can erase the very thing being checked for.**
`normalizeReviewPath("/")` is `"."` — `posix.normalize("/")` is `"/"`, and the
trailing-slash strip that turns `"src/"` into `"src"` then empties it, landing on
the same `"."` fallback an ordinary whole-tree request produces. A refusal reading
only the normalized value saw a harmless relative path and let it through — an
absolute `path: "/"` silently became a review of the entire repository, exactly
the unscoped-by-accident shape `path` having no default exists to prevent.
`pathEscapesWorktree` now takes both the raw input and its normalized form:
absoluteness is asked of what the client actually sent, `..`-escaping of the
normalized value (which needs normalizing to catch — `"foo/../.."` is not
obviously escaping otherwise) — each check reads the input built to answer it.

**A NUL byte in `path` used to fail from Node's own `execFile`, after the review
row already existed and a slot was already spent.** `wholeTreeDiff` passes `path`
straight through to git as an `execFile` argument, which Node refuses outright for
any argument containing `"\0"` — not a git error, not a lore-worded one, and not
until the worker actually ran. Refused at the door now instead, the same shape as
every other `path` validation here.

**A non-ASCII filename inside `path` was reported under git's quoted form, not its
real name — and the first fix only closed the common case.** git C-style-quotes any
path needing it, which by default means any non-ASCII name (`+++
"b/src/caf\303\251.ts"`, confirmed directly), and `filesInDiff`'s plain `+++
b/<path>` match does not un-quote it — the same shape of gap the submodule finding
above named, a different cause. `wholeTreeDiff`'s git calls pass `-c
core.quotePath=false`, which asks git for the real bytes instead (applied to
`ls-files` too, since an untracked non-ASCII filename has the identical failure) —
**but that setting only controls the non-ASCII case.** Found a second time, HIGH
severity: a control character, a backslash or a literal `"` in a filename is
C-style-quoted UNCONDITIONALLY, config or nothing, because git's line-oriented
format would otherwise be ambiguous around them (`+++ "b/src/a\tb.ts"`, confirmed
directly for a tab). `filesInDiff` now decodes git's quoting itself
(`unquoteGitPath`) rather than relying on the config flag alone.

**And found a THIRD time: `filesInDiff` is not only fed `wholeTreeDiff`'s own
output.** `review_submit` also runs it on a CLIENT-supplied diff, generated under
whatever git config the client has — `core.quotePath=true`, git's own default,
unless they set it otherwise — so the "never a multi-byte sequence" reasoning the
decoder was first written under was true of `wholeTreeDiff`'s own diffs and false
in general. A non-ASCII character is SEVERAL octal-escaped bytes together
(`café.ts` as `\303\251` is two bytes forming one UTF-8 codepoint, not two
characters), and the first decoder converted one `\NNN` escape to one JS code unit
— correct for a single-byte escape, wrong for this one: byte-by-byte produced
mojibake (`Ã©`) instead of the real name. `unquoteGitPath` now collects raw BYTES
(a plain character contributes its own byte, a mnemonic escape its byte, `\NNN`
exactly the byte git wrote) and decodes the whole run as UTF-8 once at the end,
which reassembles a multi-byte escape correctly instead of one code unit at a time.

**And a fourth site with the identical gap: `untracked` had no decoding applied at
all.** `ls-files` C-quotes a control character, backslash or literal quote in a
filename unconditionally too, the same rule as `diff` — but unlike `changedFiles`,
`untracked` was built straight from `ls-files`' raw lines, with none of the
un-quoting `filesInDiff` does for the patch. A tab in an untracked file's name
would have shown up as git's literal quoted string, quote marks and all, both in
the list itself and — merged in — in `changedFiles`. Each line is now passed
through `unquoteGitPath` individually.

**Two more places still described `review_start` as branch-against-`into` only,
after the tool's own doc string had already been fixed.** `spec/agent-docs.md`'s
`review_start` tool-description draft (§3) and `TOOL_DOCS.submit`'s embedded
`pull_fresh` recipe both predate this change and neither was touched by it — found
by lore's own review, twice more, the same shape as the `review` MCP prompt earlier
in this same review. Both now show the folder-mode form beside the diff-mode one.

**The folder-mode header uppercased the path along with the sentence around it.**
`` `${where.toUpperCase()}` `` ran over the whole interpolated string, so a path
like `src/PayRoll` printed as `` `SRC/PAYROLL` `` in the one sentence whose job is
telling a tier what to (re-)read — a path that does not exist on a case-sensitive
filesystem. Found beside a second, real gap: the test meant to pin this asserted
only that the RENDER contained the path's lowercase form, which the patch body
(`+++ b/src/a.txt`) satisfies regardless of what the header itself says — a test
named for a property it did not check. Fixed by keeping the emphasis static (caps
around the path) rather than a transform applied to it, and by rewriting the test
to read the header line specifically, with a mixed-case path.

**Explicitly out of scope for this slice, named rather than silently dropped**
(D-25's walking-skeleton precedent): the CLI (`cli.ts`) gaining a `--path` flag —
MCP is the validated path (D-76), and the CLI is unaffected, still sending an
explicit `into` always; chunking or sharding a folder too large for the diff
ceiling, which falls back to the same truncate-and-announce degradation (INV-7)
every oversized diff already gets.

**D-129 — `commandsFor` stops assuming every repository is a JS project, and T0
gains real project-type detection ahead of Rust support. BUILT 2026-08-24.**

Found live, provisioning `atuin` (a pure Rust project) as this deployment's first
non-JS repository: `review_start` sat with zero `tier_run` rows and zero logged
activity for **15 minutes**, indistinguishable from a hang. It was not one.
`commandsFor` checked for `pnpm-lock.yaml`, `yarn.lock`, `bun.lock*` — found none, as
expected for a Rust repo — and then unconditionally fell through to `"npm"`, never
having asked whether `package.json` existed at all. T0's sandboxed phase then queued
a genuine `npm ci` behind `withInstallLock`'s `no-lockfile` cache bucket, a directory
every OTHER repository with no recognised JS lockfile ALSO shares — atuin wasn't
stuck, it was waiting in a line it had no business standing in, for an install that,
once it finally ran, installed nothing (there was no `package.json` to install
from) in about two seconds.

**Fixed at the root rather than the symptom — described here as it stands after
three rounds of the review finding this description had not kept up with the code
it describes.** `commandsFor` now returns a `ToolchainOutcome` — `{ok:true,
toolchain}` or `{ok:false, why}` — and gates on `package.json` at the worktree root
FIRST, before any lockfile is even asked about: everything below that gate (pnpm,
yarn, bun, then npm as the remaining case — `package-lock.json` included, with no
dedicated check of its own) only ever decides WHICH manager, never WHETHER this is
a JS project. A repository with no root `package.json` falls to `detectEcosystems`
(below) to say WHERE one was found nearby, if anywhere, rather than reusing the
same reason for every shape of absence — the old hardcoded bun message, reused
verbatim for every `undefined`, is gone the same way. `why` is always carried from
the exact branch that produced it, and `runner.ts`'s `sandboxed()` turns it
straight into an honest `unavailable` for tsc/eslint — never reaching
`lockfileKey`, `withInstallLock`, or an install attempt at all.

**And the foundation for the reason atuin is here at all.** `detectEcosystems`
(`src/t0/sandbox.ts`) reports every project marker T0 finds in a worktree — `npm`
(`package.json`), `cargo` (`Cargo.toml`) — as an independent fact rather than a
single classification, because a repo can genuinely be more than one: teammater's
root is plain JS served as static files with no `package.json` anywhere, while its
nested `server/` is a real Cargo project. Landed with no CARGO caller yet — cargo
check/clippy sandboxed execution is still the next slice (D-129's own tracking
task #2), kept separate so that part is reviewable and tested against real
fixtures before anything acts on it, matching D-25's walking-skeleton precedent.
(It gained an NPM-side caller within this same batch — see below — which is a
different thing: `commandsFor` consulting it to describe what it already found is
not the cargo-execution slice this paragraph is deferring.)

**The first version of that sentence claimed teammater as verification and was
wrong to — caught by lore's own t1, inside the same round.** `detectEcosystems`
checked only the worktree root, so `detectEcosystems(teammater) === []`: the exact
repository named as the reason this returns a list instead of one answer was
invisible to it. Unlike an npm or cargo WORKSPACE, which always declares its
members from a root manifest, teammater's `server/` is not a workspace member of
anything — an unrelated crate sharing a repository, with nothing at the root
marking it — so root-only detection served every case except its own motivating
one. Fixed by walking one level down, not arbitrary recursion: `detectEcosystems`
now checks the root and each immediate subdirectory (skipping dotfiles,
`node_modules`, `target`, `dist`, `build`, `vendor`), and returns WHERE each marker
was found (`{ecosystem, dir}`), not just whether one exists — which the next slice
needs anyway, since `cargo check --manifest-path=...` has to be pointed somewhere.
`detectEcosystems(teammater)` now correctly answers `[{ecosystem: "cargo", dir:
"server"}]`, checked directly against the real checkout, not a fixture standing in
for it. Deeper nesting and true workspace-aware discovery are still out of scope,
deliberately — the next slice needs manifest paths regardless and is better placed
to decide how far to look.

**A third finding, in the same round, on a repo neither fixture had imagined:
`commandsFor` and `detectEcosystems` disagreed about a real repository this
deployment actually reviews.** `acdc` keeps its only manifest at
`infra/package.json` — no root one — and `commandsFor` said `{ok: false, why: "no
package.json — not a JS/TS project"}` while `detectEcosystems`, checked against the
same tree, correctly reported `[{ecosystem: "npm", dir: "infra"}]`. Two functions
in the same file, answering overlapping questions, free to disagree — exactly the
shape this codebase's own recurring finding class names. `commandsFor` still
cannot DRIVE an install from a nested manifest (the sandbox mounts nothing but the
worktree root, and wiring that is real scope, correctly left to the next slice),
but it can stop claiming the repository is not JS/TS at all when it plainly is.
Fixed by having `commandsFor` ask `detectEcosystems` before giving up, so the two
cannot state the same fact two different ways: `ok: false` now says exactly what
was found and where — `"package.json exists at infra/, not the worktree root —
installing from a nested manifest is not supported yet"` — checked directly
against `acdc`'s own mirror, not invented from the finding's description of it.

**A fourth and fifth finding, same round: a stale lockfile was trusted as proof of
a manifest that might no longer exist, and the final refusal still overclaimed.**
`commandsFor` used to treat any of the four lockfiles as its OWN sufficient
evidence, on the reasoning that no manager writes one without a `package.json` to
install against — true when the lockfile was WRITTEN, not guaranteed true when it
is READ. A branch that deletes its manifest but leaves a stale `package-lock.json`
behind (a bad merge, a mid-migration commit) resolved `ok: true` regardless, and
the install this triggered had nothing to install — recreating the exact
wasted-queueing shape this whole decision exists to remove. Fixed by gating on
`package.json` at the root FIRST, once, before any lockfile is even asked about;
every lockfile check below it now only ever decides WHICH manager, never WHETHER
this is a JS project. Separately: the final "not a JS/TS project" refusal is
itself bounded by a one-level walk (`detectEcosystems`), so a manifest genuinely
two levels deep (`apps/web/package.json`) is possible and unseen — the message now
says "as far as this checked" rather than asserting a fact about the whole
repository that only one level of `readdir` was ever positioned to support.

**D-131 — cargo check/clippy run in T0's sandboxed phase, alongside tsc/eslint.
BUILT 2026-08-27.**

D-129 taught T0 to detect a Rust project without acting on it, deliberately —
"the next slice" its own entry named. This is that slice: `T0Engine` gains
`cargo-check`/`cargo-clippy`, `CODE_ARCH.t0` lists both unconditionally the same
way tsc/eslint already are, and `runEngine` refuses to run either on the host —
the identical D-24 boundary tsc/eslint already draw, and for the identical
reason: `cargo check` fully compiles and RUNS any `build.rs`/proc-macro
dependency, arbitrary target-controlled code, not just a script.

**A real correctness fix along the way, not a design choice.** Clippy's own rule
ids are module-path-shaped (`clippy::needless_return`); `RULE_CLASS`
(`engines.ts`) excluded `:` from its body character class, so every clippy
finding read back with no class at all — the identical D-83 gap already fixed
once for scoped eslint plugins (`@typescript-eslint/...`), reopened here for a
different punctuation mark. Traced by hand against every existing negative test
case before shipping: none regain a class, since each already fails the match
before reaching where `:` would matter.

**`sandboxedCargo()` (`runner.ts`) is its own function beside `sandboxed()`, not
a branch inside it** — the two ecosystems share nothing real. Its own cache,
keyed on `Cargo.lock`'s content the same way `lockfileKey` keys on a JS lockfile
(`cargoLockKey`, new in `sandbox.ts`); its own scratch directory, so its `SYNC`
step cannot race npm's when `runT0` runs both concurrently (extending D-127's
existing host/sandbox split to three branches); no `Toolchain`-style choice to
make, since it is always cargo. Detection for EXECUTION is `detectEcosystems`,
not `detect()`'s root-only check — the nested-aware one-level walk D-129 already
built, because `teammater` (plain JS at the root, the real crate in `server/`)
is exactly the shape a root-only check misses, and it is the repository the
whole `dir` field exists to answer for. `--manifest-path` threaded through every
invocation accordingly; multiple cargo projects found (root plus nested, or
several nested) take the first, the same bounded choice `commandsFor` already
makes for multiple lockfiles — true multi-crate awareness stays out of scope.

Three cargo invocations per round, all through `runInSandbox` directly rather
than `install()` (which is genuinely npm/`Toolchain`-shaped and has nothing
cargo needs): `cargo fetch --locked || cargo fetch` (network on, the same
frozen-then-resolving fallback shape pnpm/yarn already use here), then `cargo
check`/`cargo clippy --message-format=json` (network off). Parsing
(`parseCargoJson`, `engines.ts`) is verified against the Cargo Book and rustc's
own JSON diagnostic docs rather than assumed: `reason: "compiler-message"`
wraps a nested rustc-shaped `message` (`code: {code, explanation} | null`, not a
bare string); `note`/`help` level diagnostics only ever nest inside a parent's
`children`, never arriving as their own top-level entries, so filtering to
`error`/`warning` at the top level is sufficient on its own. A whole-crate
summary with no span ("aborting due to 2 previous errors") is dropped — no
information beyond the individual diagnostics already reported. `file_name` in
a span is relative to the MANIFEST's own directory, never the worktree root and
never absolute — confirmed by actually running `cargo check --manifest-path`
against a nested fixture, not assumed — so `parseCargoJson` rebases it onto the
crate's own directory (found by lore's own review, fingerprint 47ddd7fa; a
`teammater`-shaped repo would otherwise have gotten findings anchored to files
that do not exist at the paths they claimed).

**[OPEN] That rebase is verified for a single nested crate, not for a workspace
manifest (one Cargo.toml, members below it) — left unresolved, not fixed
blind.** Lore's own review raised it (fingerprint eaea5664): a workspace
member's `file_name` may come back relative to the WORKSPACE ROOT (this
rebase already correct) or relative to the MEMBER's own directory (it is
not — `message.package_id`, present in the schema and read by nothing here,
would be the fix, itself needing either a `cargo metadata` call to resolve it
to a path or correct parsing of its own format). Genuinely unclear without
running real cargo against a real workspace, which nothing here can do until
the toolchain lands — named as a specific item for that follow-up's own
verification pass to check, rather than guessed at now.

**Three more rounds of lore's own review, each catching something the wiring
above did not actually do despite being written to.** The cache mount at
`baseArgs`' `cacheMountPath` was wired and nothing ever pointed cargo's own
`$CARGO_HOME`/`$CARGO_TARGET_DIR` at it — every fetch silently used each
container's own ephemeral `$HOME/.cargo` instead, so nothing was ever actually
cached (fingerprint d341a76e; fixed by exporting both at the front of every
cargo script string, `CARGO_ENV` in `runner.ts`). `CODE_ARCH.t0` listing
cargo-check/cargo-clippy unconditionally meant every non-Rust review — most of
what this deployment reviews — carried two permanent NOT RUN lines, the exact
"ast-grep problem" D-71 already named (fingerprint c37f7c9b; `sandboxedCargo`
now reports `skipped`, not `unavailable`, when no Cargo.toml is found at all).
The missing-binary text heuristic also matched a genuine dependency error
("fatal: repository … not found" from a broken git dependency) as though cargo
itself were absent, discarding a real high-severity finding (fingerprint
01270153; exit 127 decides it now, structural rather than textual — widened
again two rounds later into `cargoToolMissing`, see below). The manifest path
— a directory name from the branch under review,
not a value this code chooses — was interpolated unquoted into a shell string;
a one-level directory containing a space would word-split and break a healthy
repo's own check (fingerprint 2b5a78f6; `shQuote` wraps it now, the same
"paths from the branch are not values we choose" reasoning `scopePaths`
already documents one file over).

**The sharpest of the four: mounting the cache AT `/work/.cargo` put it
directly on cargo's own config-discovery path.** Cargo walks up from its
working directory (`/work`) looking for `.cargo/config.toml`; `SYNC`'s
`cp -a /src/. /work/` copies dotfiles too, so a reviewed repo's own committed
`.cargo/config.toml` landed inside the bind-mounted, cross-review, Cargo.lock-
hash-keyed cache — and `cp -a` never removes what a later sync doesn't
overwrite. A repo pinning a registry mirror or build target would silently
configure every OTHER review sharing that lockfile hash: cross-branch,
potentially cross-repository, contamination in lore's own voice (fingerprints
a461dd72/54900638). Fixed by moving the mount entirely off `/work` — a sibling
`/cargo-cache`, shared by nothing cargo's own discovery walks — with
`CARGO_HOME`/`CARGO_TARGET_DIR` pointed inside it. A useful side effect: a ROOT
crate's own `.cargo/config.toml` now reads correctly, from its natural,
ephemeral, per-review location, once nothing is mounted over it. **A NESTED
crate's own `.cargo/config.toml` is still not read, and this is now a
confirmed limitation, not a guess** — verified by running real cargo with
`--manifest-path` against a nested fixture and inspecting the actual `rustc`
invocation: config discovery starts from the process's own working directory,
never from the manifest's, so a crate one level down never has its own
config file found regardless of where the shared cache lives. Fixing it needs
the working directory itself to move per crate, which is bigger than this
slice.

**Deliberately does not touch `deploy/sandbox.Dockerfile`.** Asked Vany how the
sandbox image should get a Rust toolchain — rustup (honours a target's own
`rust-toolchain.toml`, the same "run the target's own configuration" principle
D-8 already applies to tsc/eslint/pnpm, at the cost of a real musl/Alpine
target-triple complication and image-size growth) versus Alpine's own `apk add
cargo rust` (simpler, musl-native, no per-project version fidelity). Answer:
"nothing for now." So the wiring above is complete and tested (the fake-`docker`
mock pattern `runner.test.ts` already uses for tsc/eslint, extended — no real
Docker, no network) but **every real review of a Rust repo reports
`cargo-check`/`cargo-clippy` `unavailable: "cargo is not available in the
sandbox image"` until a follow-up decides how the image gets a toolchain and
rebuilds it.** Distinguished explicitly from a genuine dependency-fetch failure
(`checkTypes`'s bare-tsc branch already drew the identical distinction once,
fingerprint 1fa9229d: the likelier explanation for this shape of failure is the
tool never being installed, not a defect in the branch's own dependencies) —
`cargo fetch`'s own failure path — and `checkCargo`'s identical need one call
site over — both go through one shared `cargoToolMissing` (`runner.ts`) before
falling into the generic "dependencies do not fetch"/"fails on this branch"
findings. It grew across three more rounds of lore's own review, each finding
a shape the one before did not cover: a bare `code === 127` (fingerprint
01270153, replacing an earlier text-only hedge that caught a genuine
dependency error — a broken git dependency's own "not found" — as a false "no
toolchain") was not enough once `cargo-clippy` entered the picture, since it
is its OWN binary — a separate rustup component or distro package from bare
cargo — and can be absent when cargo itself works fine, exiting 101 with
`error: no such command:` rather than 127 (fingerprint f2b0d6c3). Then a
RUSTUP toolchain that HAS cargo but lacks specifically the clippy component
fails a THIRD way — confirmed by removing the component from a real local
toolchain and restoring it after: `error: 'cargo-clippy' is not installed for
the toolchain '…'`, exit 1 (fingerprint c618f5cb). And the text match alone,
with no other requirement, would also match a target's own `build.rs`
printing similar text as part of a genuine failure (fingerprint 57dea7e8) —
the identical over-broad-hedge class 01270153 already named once. All three
confirmed shapes (and rustup's own long-documented "no default toolchain
configured", the same shape though not separately reproduced) share one
structural signature instead: dispatch itself is what failed, so nothing
project-controlled has run yet and stdout is always empty — `cargoToolMissing`
now requires that alongside the message/exit-code check, narrowing the
`build.rs`-collision window without a dedicated pre-check invocation.

Out of scope, named rather than silently dropped: multi-crate/true
workspace-aware discovery beyond one level (`detectEcosystems` itself does not
go deeper); honouring a project-pinned toolchain the image does not carry
(`RUSTUP_HOME` is not cached/mounted); clippy-lint-group-aware severity finer
than error→high/warning→medium; a NESTED crate's own `.cargo/config.toml`,
confirmed unreachable by this invocation shape (see above) and not fixed here.

**D-132 — a documentation-only round does not trip the per-tier bound. BUILT
2026-08-28.**

Two real reviews were killed by the per-tier round bound (default 3) while
answering nearly everything asked, both on rounds that kept raising fresh
FINDINGS about their own prose — a genuinely converging review, stopped by a
counter that cannot tell "still arguing" from "still fixing." A clean round
already does not trip this bound (`ladder.ts`, the 2026-08-03 fix); a
docs-only round now behaves the same way. `git/diff.ts` gains an exported
`isDoc` beside the existing (still private) `isTest` — file extension `.md`,
or paths under `spec/`/`docs/`.

**The two cited incidents predate D-114 (built 2026-08-16, ten days later)
and cannot recur via the MCP flow they happened on — found by lore's own
review of this decision (fingerprint 3407e345), same day.** D-114 resets
`tierRounds` to `{}` the moment the client delivers real work (a submitted
diff or `pull_fresh` whose tree genuinely moved), applied at the top of
EVERY round (`review.ts`, `store.withClientWork`) — traced end to end:
`server.ts`'s `review_submit` handler calls `store.noteClientWork` whenever
the applied tree hash actually changes, and the very next round consumes
that signal before anything else runs. Both incidents were driven over MCP
(the D-77 workflow, "as a client, not through the CLI" — D-76) and answered
nearly every finding each round, meaning nearly every round moved the tree
— exactly the condition that resets the counter today. Independently
confirmed by this session's own history: dozens of multi-round D-77 cycles,
this bound never once fired. **What D-132 actually protects today is
narrower: `cli.ts`'s `lore review`**, which reuses the same review row
across repeated invocations (`existingReview`, `cli.ts:440`) and never calls
`noteClientWork` — a developer iterating locally with the CLI hits exactly
the bound the two cited incidents describe, D-114 or not. Kept for that
reason, not the one first written down; the mechanism and its tests are
unaffected, only the justification was wrong.

**What actually gates the bound is NOT the branch's diff — found by lore's
own review of the first version of this fix (fingerprint 6a6ae919), same
day.** The obvious-looking implementation read `ReviewDiff.docsOnly` (every
file the BRANCH has changed since its pinned base is a doc file) straight
into `StepInput.docsOnly`. Both MEMO-recorded incidents this decision cites
were CODE branches that also touched prose — a `.ts` finding settled early,
then every later round argued only about `SPEC.md`. `computeDiff` recomputes
the same cumulative, whole-branch diff every round, so that branch's
`docsOnly` was `false` for its entire life: the fix never fired on the exact
shape it was built for, and the one test written for it only ever exercised
a branch whose sole commit was a `.md` edit — the motivating shape was never
tested. **The corrected signal**: right before the round's `step()` call
— by which point this round's own findings and verdicts are already written
(`store.recordFinding`/`recordVerdict` both run earlier in `runRound`) — read
`store.openFindings(reviewId)` fresh and check every one's OWN `file` against
`isDoc`. `tierRounds` itself still increments unconditionally regardless, a
truthful count of how many rounds a tier has run; only whether that count
STOPS the review is affected, exactly mirroring the clean-round exemption's
own shape.

**`ReviewDiff` itself carries no `docsOnly`/`changedDocs` — found by lore's
own review a second time, same day (fingerprint 8456d656).** The first
correction (above) left them on the interface anyway, computed at both
construction sites, justified as "a real, independently useful fact." Nothing
in production ever read them; only this change's own tests did, which made
them look load-bearing to the next reader without being it. That is the exact
shape `one-definition.test.ts`'s `RULE_DIRS` rule polices for a bare exported
constant and cannot see on an interface field — and it is the same field,
under the same tempting name, that baited fingerprint 6a6ae919's bug one
correction earlier: wired in because it existed and was named right, not
because it was correct. Removed rather than wired up for its own sake; `isDoc`
stays exported, with `review.ts` as its one production reader.

**Deliberately scoped to file extension/path, not diff content.** No attempt
to detect a comment-only change inside a `.ts` file (a docstring, a
`TOOL_DOCS` string) — that is a materially harder, more error-prone
classifier, and not what was decided. Two named consequences, not hidden:

- if the original prose-loop incidents that motivated this bound were
  themselves in `.ts` docstrings rather than `.md` files, this classifier does
  not catch them — TODO.md's own alternative, bounding on *rounds that settled
  nothing* rather than file type, would cover that case too and remains a real,
  not-yet-built option;
- exempting `docsOnly` rounds from the fast per-tier bound leaves only the
  global bound (default 12) as backstop for a genuinely non-convergent
  `SPEC.md` argument — four times the cost before it stops, accepted knowingly.
  The global bound is deliberately NOT given `docsOnly`: `ladder.ts`'s global
  check stays unconditional.

**D-133 — `fixed_elsewhere` on `review_submit`: a structured alternative to a
`lore-ok` comment at the finding's own line. BUILT 2026-08-29.**

The correct fix for a finding is routinely not at the line it was raised on — a
caller, a shared helper — and the only way to say so was a
`// lore-ok[<fingerprint>]: fixed elsewhere, see X` comment planted AT THE
ORIGINAL line: a synthetic edit to a file the real fix never touched, purely to
carry a marker. `review_submit` now also accepts `fixed_elsewhere:
{fingerprint, file, reason, line?}[]`, ruled on identically — merged into the
same `pending` array `collectJustifications`'s text markers already populate
(`review.ts`, new `collectFixedElsewhere`), so the prompt, the silence-based
ruling loop and `settleFixed`'s exclusion set all see it for free. No new
verdict kind: silence next round records `justified-accepted`, a re-raise
records `justified-rejected`, exactly like any other justification.

**Persisted, not passed through memory — but not always IMMEDIATELY, corrected
in this same round by lore's own review, fingerprint d2c5ca38.** `runRound`
executes off the job queue, disconnected from `review_submit`'s synchronous
handler — a claim living only in the request would be gone before any round
read it. New table `fixed_elsewhere_claim` (`schema.ts`, `SCHEMA_VERSION` 21),
read back by `collectFixedElsewhere` the same way `collectJustifications`
reads marker text off disk. The first version wrote a claim to that table
unconditionally, at submit time, for both the applied AND held paths — and a
HELD diff can still fail LATER, at consume time (`consumeHeldDiffs`: a fuzzy
or partial apply, or a tree-hash mismatch), dropping that diff and everything
queued after it. The claim survived regardless, ratified in a later round
against a fix that never actually landed — exactly the "claim with nothing
behind it" the file-in-diff check exists to refuse. Fixed by deferring
persistence for the held path: the validated claims ride WITH the held diff
(`held_diff.fixed_elsewhere`, JSON, migration-only column, `holdDiff`'s new
parameter) and are promoted to real `fixed_elsewhere_claim` rows only once
`consumeHeldDiffs` confirms that SPECIFIC diff actually verified — never for
one that hits either mismatch return, where the claim is simply never
promoted, same as the diff it rode in on. The applied path is unaffected: by
the time that path's callback returns, the diff is already verified, so
recording immediately remains correct.

**Validated inside the submit lock, before the held/applied fork — including a
THIRD refusal outcome missed on the first pass, also found by lore's own
review, fingerprint cf48ccb1.** An unresolvable `fingerprint` (`resolveShort`
returns `undefined`) or a `file` outside `filesInDiff` of THIS submission both
throw — a fresh RPC argument naming a fingerprint this review never raised, or
claiming evidence for a file the tier was never shown, is a client mistake to
fail loudly on, not silently swallow. `resolveShort` has a third outcome
besides "resolves" and "does not resolve": it THROWS `AmbiguousFingerprint`
when the short prefix matches more than one finding (spec/review-ladder.md
§3.1.2) — a real, if rare, case the first version left uncaught, an
unenumerated third path none of the surrounding text described. Caught now
and rephrased with the same D-133 framing the other two refusals carry,
naming which findings collide so the client can send more of the fingerprint.
A fingerprint that resolves but names an already-settled finding is not an
error: silently skipped, named in the reply's `fixed_elsewhere_skipped`,
since the claim simply arrived after it stopped being needed — this check is
best-effort for a diff that ends up held, since the in-flight round that made
it wait can itself settle findings before the hold is consumed, but that is
harmless: `collectFixedElsewhere` re-filters against `store.openFindings` at
the point it actually rules, regardless of what was true at submit time.

**`will_not_settle` excludes ANY finding with a `fixed_elsewhere` claim on
record, not only one THIS call just made — the first version got half of this
right and lore's own review found the other half, fingerprint a5bc9f62, same
round it named cf48ccb1/d2c5ca38.** The preview (`server.ts`, computed after
the apply/hold fork) only ever checked `codeMoved`/`alreadyAnswered`, neither
of which reads the new store table, so a finding validly claimed via
`fixed_elsewhere` still showed up as "will not settle" — telling a client its
own just-submitted answer had failed. The first fix threaded a
`justClaimedElsewhere` set (this call's own claims) into the preview loop,
which covers the ordinary case but misses one: a HELD submission's claims are
not promoted into `fixed_elsewhere_claim` until `consumeHeldDiffs` confirms
that diff landed, and that happens MID-ROUND — after that round's own
`pending` was already collected near the top of `runRound`. So a claim
promoted that way sits unruled until the NEXT round, and a LATER, unrelated
submit's preview (whose own `fixed_elsewhere` says nothing about that
fingerprint) still listed it as unsettleable, even though the round that very
submit enqueues is exactly the one that will rule on it. Fixed by reading
`store.fixedElsewhereFor(review_id)` directly instead — every claim on
record, regardless of which call made it — which made `justClaimedElsewhere`
fully redundant (by the time the applied path returns, its own claims are
already written to that same table) and it was deleted rather than left
beside its replacement.

**`Pending.scope` is the finding's own file/line, never the claim's.**
`expireStaleVerdicts` looks the hunk up at the finding's ORIGINAL location, so
a scope taken from wherever the fix actually landed would expire on the wrong
edit — matching `collectJustifications`'s own reasoning exactly. This means
the verdict only expires if the originally flagged code later changes, not if
the "elsewhere" fix is later reverted — an existing limitation the
`lore-ok`-at-the-original-line form already has, not a new one. `citedRule` is
never set on a `fixed_elsewhere` entry: it is not a D-83 rule appeal, and
setting it would wrongly buy a class suppression for an ordinary "I fixed it,
here's where" claim.

**The "refused claim rolls back nothing" gap named in an earlier draft of this
entry is CLOSED, incidentally, by the same restructuring that fixed
d2c5ca38.** Validation moved from after `withSubmitLock` resolves to INSIDE
its callback, right where `patch` is finally known (both forms) and strictly
BEFORE the held/applied fork, `holdDiff`, and `applyPatch` all run — needed
regardless, because the held path's claims must be validated before they can
ride along with `holdDiff`'s new parameter. So every `fixed_elsewhere` throw
(unresolvable fingerprint, wrong file, ambiguous fingerprint) now refuses the
WHOLE call before anything lands or is held, for both `diff` and `commit`
alike — no asymmetric handling needed, because `patch` was already uniform by
the point validation runs.

**Four more, same review, later same day: retention, deletion-as-evidence, a
stale reply, and a claim's location never reaching the tier that rules on
it.**

- **`fixed_elsewhere_claim` was created WITHOUT `ON DELETE CASCADE` — fingerprint
  f83d72a1.** The one thing `deleteReviewsBefore`'s own docblock already names as
  fatal: a review-child row with no cascade makes the retention sweep's plain
  `DELETE FROM review` violate the FK and roll back the WHOLE transaction, every
  hour, for ever, from the first terminal review that carries a claim. `held_diff`
  has this exact shape and is pre-deleted by hand for exactly that reason — this
  table repeated it one row down in the same file, in the same feature that had
  the lesson sitting right beside it. Unlike `held_diff`, this table had never
  been deployed, so there was no existing database to be stuck with: fixed by
  adding the cascade directly rather than a migration.
- **The file-in-diff check refused a claim naming a file the fix DELETED —
  fingerprint 23c8b393.** It reused `filesInDiff`, which excludes a deletion by
  design (no marker left to scan in a file that no longer exists) — correct for
  its other three callers, wrong here: deleting the whole buggy file is often the
  strongest evidence a claim can offer, and the refusal's own suggested fallback
  (a `lore-ok` at the original line) can be equally impossible when that line is
  what got deleted. Fixed with a sibling function, `filesTouchedByDiff`
  (`git/diff.ts`), reading both `+++ b/` and `--- a/` — a new function rather than
  a flag on `filesInDiff`, since the two callers want genuinely different things.
- **`will_not_settle_note` still named only the `lore-ok` comment — fingerprint
  20f24c95.** The reply text shown at the exact moment a client learns its
  fix-elsewhere did not settle never mentioned `fixed_elsewhere`, the field this
  whole change exists to offer — CLAUDE.md's rule that client-facing strings ARE
  the interface, missed for the one string surfaced at the decision point itself.
  Fixed in place.
- **The claim's own `file`/`line` never reached the tier that rules on it —
  fingerprint c380dbe9.** `collectFixedElsewhere` built each `Pending` from
  `claim.reason` alone; `Pending` has no location field, and the prompt renders
  exactly one string per entry. So the one structured datum a `fixed_elsewhere`
  claim supplies beyond an ordinary `lore-ok` — WHERE the fix landed — was invisible
  to the model deciding whether to ratify it, which saw free prose indistinguishable
  from a claim naming nowhere at all. Fixed by folding `claim.file`/`claim.line`
  into the `reason` string itself, rather than widening `Pending` for a field only
  one of its two producers has: the ruling loop and `settleFixed`'s exclusion set
  never read location, only the prompt does, and it already renders `reason`
  verbatim.

**Two more, next round: the deletion fix repeated for a rename, and the two
documents that actually drive a client's loop never caught up.**

- **`filesTouchedByDiff` still missed a PURE rename — fingerprint 10617a99.** A
  100%-similarity rename (`git mv` with no content change) emits neither `+++`
  nor `---` at all — no hunk to show — only `rename from <path>` / `rename to
  <path>` lines, which nothing in the function read. The same defect class as
  23c8b393, one git format rarer: naming either side of a rename-only fix (moving
  a misplaced module) was refused. Fixed by also matching `^rename (?:from|to)
  (.+)$`.
- **The two documents that actually drive the client loop step by step never
  learned the field at all — fingerprint 39cf990a.** `will_not_settle_note` was
  fixed (20f24c95, above) to mention `fixed_elsewhere`, but `RESOURCE_DOCS["lore
  ://docs/workflow"]` and `REVIEW_PROMPT_TEXT` — the texts a prompt-driven client
  actually learns the loop FROM, both named in CLAUDE.md's texts-move-with-the-
  behaviour rule — still taught step 3 as "fix it, or justify it with `//
  lore-ok[fp]: <reason>`" with no mention of the field. A client that never hits
  the nag (because its own step 3 already told it what to do) never learns the
  field exists. Fixed in both; a new mechanical pin (`docs.test.ts`) checks both
  documents mention `fixed_elsewhere`.

**D-134 — `checkTypes`'s bare `tsc` fallback actually uses `--incremental` now;
`spec/deployment.md` had claimed this since before it was true. BUILT
2026-08-29.**

Surfaced by Vany asking about T0's timing, not by a review round. `checkTypes`
(`t0/runner.ts`) has two paths: when the target declares its own `"typecheck"`
script, lore runs that unmodified (a monorepo's `turbo run typecheck` gets
whatever incrementality it already has — lore has no safe way to inject flags
into an arbitrary target-defined command and does not try); otherwise, when a
root `tsconfig.json` exists with no script, lore runs `tsc` itself, directly.
That second, lore-controlled path carried no `--incremental` flag at all, so a
target without its OWN `tsconfig.json` opting into `"incremental": true` — most
of them, since it is not TypeScript's default — got a full, uncached typecheck
on every single round, contradicting `spec/deployment.md`'s own "T0 is
engineered for this host" table, which had listed `tsc --incremental` as one of
the reasons the local bottleneck stays affordable.

**Round 1 shipped with the buildinfo in `/work` (`scratch`) — and lore's own
review caught that this is a no-op, fingerprint e6ad293d, same day.** The
reasoning for that placement was wrong on the one fact that mattered:
`sandboxed()`'s own `finally` block `rm -rf`s the WHOLE `scratch` directory at
the end of every single call, so nothing written there is ever read back by a
later round. Round 1's `.lore-tsc.tsbuildinfo` was written, then deleted before
the review's next round could exist — every claim in this entry's first
version (that `scratch` "survives between rounds," cleared only by the
14-day-idle sweep) was simply false, checked against the wrong code. `cacheDir`
(`/work/node_modules`) was the other candidate and is no better, for a
different reason: verified directly that `npm ci` itself deletes a stray file
placed there before it runs, independent of lore's own teardown — so even a
target using `npm ci` with `scratch`'s bug fixed would still lose the buildinfo
every round.

**Round 2: a THIRD, dedicated mount, `tscCache` (`t0/runner.ts`), mirroring
cargo's own `CARGO_MOUNT` (`/cargo-cache`) pattern exactly.** Neither existing
mount can carry a value that must outlive one call, so this is a new
`${scratchRoot}/${basename(worktree)}-tsc` directory — a sibling of both
`scratch` and the lockfile-hash cache, created once, mounted at a fixed
`/tsc-cache`, and never touched by either teardown. Keyed by `reviewId`
(`basename(worktree)`), not by lockfile hash: a `.tsbuildinfo` is a claim about
SOURCE content, and sharing one across different branches that merely happen
to share a dependency tree would be a correctness risk, not just a missed
optimization. Cleanup needs no new code: the 14-day-idle sweep in
`ops/retention.ts` already iterates every subdirectory of `scratchRoot`
generically. `baseArgs`/`runInSandbox` (`t0/sandbox.ts`) gained an optional
second mount to carry it, since `checkTypes`'s npm/tsc path needs BOTH
`node_modules` and this new cache simultaneously — unlike cargo, which replaces
the node_modules mount rather than adding to it.

**The regression test was rewritten too, not just the code — the first
version would not have caught this.** It asserted only that `--incremental`
and `--tsBuildInfoFile` appeared in the constructed command, which round 1's
actual (broken) code also satisfied; a flag can be present and correctly
spelled while writing into a directory that is deleted before anything reads
it back. The rewritten test instead asserts the two properties that actually
distinguish a working cache from a no-op: the mount's host directory still
exists after the round returns, and a second call reuses the identical path
rather than a fresh one.

**Round 3: `--incremental` unconditionally is unsafe on legacy TypeScript,
fingerprint b6650506.** `--incremental` together with `--noEmit` is a hard
OPTION ERROR before TypeScript 4.0 (Aug 2020) — `TS5053: Option 'noEmit'
cannot be specified with option 'incremental'`, no `file(line,col):` prefix, so
`TSC_LINE` never matches it and it fell through to a false "did not exit
cleanly... most likely not installed," misdiagnosing a real, previously-working
typecheck this change broke as a missing tool. `npx --no-install` runs the
TARGET's own pinned compiler, so this could not be assumed away. Fixed with
`tsSupportsIncremental(cacheDir)`: reads the target's actual installed
TypeScript version straight from `cacheDir` on the HOST side (the exact bind-
mount host path the sandbox exposes as `node_modules` — no extra container
round-trip needed) and adds the incremental flags and mount only when the
major version is 4 or above; anything that stops the version from resolving
(not installed, unreadable, malformed) is treated as NOT supporting it, since
a full uncached typecheck is strictly better than a misdiagnosed hard failure.

**The same round also raised a finding against the round-2 test that was
already stale when it was raised, fingerprint dc0503f2 — rejected with a
`lore-ok`, not fixed.** Its evidence quoted the NAME and BODY of round 1's
test (a single `runT0` call, bare flag-presence assertions) as if it were
still current; round 2, landed in the SAME batch this finding was raised
against, had already replaced it with the two-call, existence-and-reuse
version described two paragraphs up. Checked directly against the actual tree
before rejecting: no test by the name the finding quotes exists in it.
wrong are a silent, ongoing false pass.** A bare `tsc --noEmit --incremental`
genuinely persists and correctly re-reads a `.tsbuildinfo`: confirmed with
`--extendedDiagnostics`, which reported a real "BuildInfo read time" on the
second run rather than a stale zero. More important, checked BOTH directions of
the one way this could have silently weakened the check rather than only sped
it up: an unchanged file whose error was never fixed is RE-REPORTED, identically,
on every subsequent run — `--incremental` skips re-verifying what has not
changed, it does not skip re-reporting what is still broken — and a genuinely
fixed error correctly clears on the next run. Both confirmed with a real `tsc`
invocation in a throwaway directory before any code changed.

**Cargo already had the equivalent, for a different reason.** `CARGO_ENV`
(`t0/runner.ts`) points `CARGO_TARGET_DIR` at a persistent mount, which is all
Cargo's own incremental compilation needs — no flag required, unlike `tsc`. This
closes the same class of gap for the one sandboxed engine that did not already
have it for free.

**Not extended to eslint in this change.** ESLint has an analogous `--cache
--cache-location` pair with a similar safety shape, but it was out of scope for
what was actually asked and investigated here; a future change doing the same
for eslint should verify its own re-report-vs-suppress behavior the same way,
not assume the tsc result transfers.

**D-128 — a finding that names its fields "title"/"detail" is a naming drift, not a
malformed reply: repaired at the boundary rather than gambled on a retry. BUILT
2026-08-20.**

Vany, looking at a live review of a real financial reconciliation branch: *"seems we
seriously failed."* He was right, and precisely: `rev_Orn2HYgY43GwgxkSvQaEdmA0`
(`rigid-monorepo`, a client's own repo lore reviews), round 7, t3 raised a **critical**
finding about a genuine bug in settlement reconciliation
(`services/clearing-settlement/src/logic/run-reconciliation.ts`) — the widened position
fetch D-49's earlier round had produced now pulls in positions whose matching ledger
credit is still filtered out, reported as a permanent phantom shortfall. Real money-
handling logic, real bug, and lore nearly lost the finding that caught it.

**The model wrote `{"title": ..., "detail": ..., "severity": "critical", ...}`.**
`FindingSchema` wants `claim`/`evidence`, and is `.strict()` besides — so this was refused
twice over: the unknown keys, and `claim` being genuinely absent underneath them. It
reached the client only as `checks_skipped`: *"t3 produced a finding this review does NOT
contain"*, with the raw rejected JSON as the only trace.

**It was not actually lost — but only because the retry `opencode.ts` already sends on a
whole-reply failure happened to land on the right names the second time, and nothing
guarantees that.** `conduct`'s retry restates the contract and asks the model to try again;
here the second attempt used `claim`/`evidence` correctly and the finding survived, one
round-trip later, as a NEW finding (`d97e8bed`, same file, same mechanism, differently
worded — a second, independent generation of the same finding, not a copy of the first).
Nothing compares a retry's content against the attempt it replaces, so nothing would have
noticed had it come back paraphrased worse, missing a detail the first had, or not
recovered at all — **the actual near-miss was total loss of a critical finding, gambled on
a second roll**, not the specific difference this decision first reached for. `d97e8bed`
was fixed and verified by round 8; the review reached `passed`. The bug is closed. The
near-miss is what this decision is about.

**Corrected by lore's own t1, reviewing this very fix: severity was never actually at
risk.** The first draft of this decision read the two attempts' differing severity words
(`critical`, then `high`) as a regression the retry caused. It is not one: D-115 maps any
word `SEVERITIES` does not recognise — `critical` included — to `high`, on every attempt
identically, so a perfectly-named first try reporting `severity: "critical"` would have
recorded `high` too. `finding.test.ts` proves it directly: the repaired reply's own test
asserts `severity` is `"high"`, for the same reason a correctly-shaped one would be. Left
uncorrected, this would have been believed rather than checked the next time severity
fidelity across a retry mattered — the drift this project polices, caught in its own
newest decision before the ink dried.

**Fixed at the boundary, matching D-115/D-116's established rule that validation here must
not be able to lose a finding — extended from "the model got a value wrong" to "the model
got a NAME wrong."** `repairFieldNames` in `src/core/finding.ts` runs first in the
preprocessing chain (before `foldOverlongClaim`, which reads `claim` by name and would
no-op on a finding still calling it `title`): when the canonical field is missing AND a
plausible alias is present, it promotes the alias and notes the substitution in `evidence`
— `title` → `claim`, `detail` → `evidence`. Where `failureScenario` has no third field to
draw from, it reuses the promoted `evidence` rather than leaving the finding one required
field short, and says so. This removes the retry — and the total-loss risk a second,
independent generation of the finding carries — for the one substitution actually
observed, rather than trusting a second attempt to fix what the first got wrong.

**A second finding, from the same review of the same fix: the delete lived outside the
guard that earned it.** The first version promoted `title`→`claim` and `detail`→`evidence`
each inside their own `if`, then deleted BOTH alias keys unconditionally afterward — so a
reply with `evidence` already correct but a stray `detail` sitting beside it fell through
the `!hasEvidence` guard, consumed nothing, and still had `detail` deleted with no note,
on the exact path `.strict()` exists to police as drift. Fixed by moving each `delete`
inside the guard whose promotion it belongs to, so an alias that was never consumed is left
exactly where it was: a stray key for `.strict()` to name, not content silently discarded.

**A third finding, from the review of THAT fix: the entry guard was checking the wrong
question.** `if (hasClaim || ...) return input` treated "claim is already fine" as "there
is nothing here to repair" — but the two fields are independent, and a reply that gets
`claim` right while still calling `evidence` `detail` (the same substitution, one field
along, half right instead of all wrong) was returned untouched before either per-field
guard could run, sent through the same whole-reply retry and total-loss risk this decision
exists to remove. Fixed by asking each field's own question at entry — `needsClaim`,
`needsEvidence` — and proceeding if either is true, rather than letting one field's health
stand in for the other's.

**A question, from the review of THAT fix: should `claim: 7` beside a good `title` be
silently overwritten?** No — and the line the answer sits on already exists in this file.
`cwe`'s rule is "blank is forgiven; WRONG is still rejected" (D-116), and `still rejects
[89], [{}], [[]] as a cwe` pins the wrong-type half of it. A canonical field that is
absent, `null`, or an empty/blank string said nothing, which every other repair here
already forgives; a canonical field holding a NUMBER or an OBJECT where a string was asked
for is a stronger, more specific drift signal — the reply's TYPES have parted from the
contract, not just its NAMES — and an alias silently papering over that would hide exactly
what `.strict()` exists to surface. So `missing()` now checks for absent/null/blank only;
a wrong-typed canonical field is left alone, its now-genuinely-unused alias stays present
too, and the schema names both problems in one rejection.

**A fourth finding, sharper than the first three: a repair note is not proof, and the
final step let it stand in for one.** `title` alone — no `detail`, no `evidence` under
either name — still reached the note-appending join at the end of the function, which had
nothing real to attach its note to and fell back to making the note itself the entire
`evidence` value: `"lore read \"title\" as \"claim\" — the reviewer used the wrong field
name."` satisfies `evidence: z.string().min(1)` and reads exactly like proof, to the next
tier and to the client, of nothing. Fixed by appending the note only where usable content
already exists to attach it to; a finding with genuinely no evidence anywhere still fails
the required-field check precisely as it would have without any of these repairs, going
through the ordinary retry rather than being admitted on a sentence about its own repair.

**A fifth finding: the previous paragraph's own safety claim about `repairStructure` was
false, and lore's own t2 caught it inside the same round.** It said that join "only ever
runs on a finding whose `evidence` this schema already required and never touches" —
backwards. The required-field check is the Zod parse that runs AFTER every preprocessing
step, `repairStructure` included, so nothing has required `evidence` yet by the time it
runs — `repairStructure` predates D-128 and carried the identical fabricate-evidence-from-
a-note defect the whole time, unnoticed because nothing had constructed a bad `line`/`cwe`
finding with no evidence anywhere to trigger it. Fixed the same way, in the same function
shape: the note is appended only where real content already exists.

**A sixth finding: the `failureScenario` backfill still used the OLD blank-or-wrong-is-
the-same test, one field after `claim`/`evidence` were fixed to tell them apart.**
`usable(o["failureScenario"])` read `failureScenario: 42` as absent, so the backfill
silently overwrote it with the promoted `evidence` and wrote a note — *"lore could not
find a distinct failure scenario"* — that was now false: one was given, just wrong-typed.
Fixed by reusing `missing()` here too, so a wrong-typed `failureScenario` is left alone
for the schema to refuse on its own terms, matching `claim` and `evidence` beside it
rather than lagging them by one field, which is exactly how D-115 and D-116 came to be
three separate decisions instead of one.

**Deliberately narrow, on purpose, twice over.** It fires only when the canonical field is
genuinely missing: a reply that already has a correct `claim` and ALSO sends a stray
`title` still hits `.strict()` exactly as `finding.test.ts`'s existing "rejects unknown
keys rather than dropping them" expects — an extra field beside otherwise-correct output
is a stronger drift signal than a substitution for an absent one, and this repair leaves
it alone (now correctly, on both fields). And it repairs the two names actually seen rather
than a speculative table of synonyms for every field: `severity`'s synonym list (D-115)
grew the same way, one real incident at a time, and this starts from one.

**D-127 — host engines and the sandbox run CONCURRENTLY within one T0 pass, not in
sequence. BUILT 2026-08-20.**

Vany: *"it spend a lot of time, throw out unnecessary, speed it up as we can."* Measured
first rather than guessed: `tier_run` shows fresh code-arch T0 passes at p50 346s / p90
873s over the preceding week — an order of magnitude past the "T0 runs in 5–11s" a
`runner.ts` comment had claimed since the file was written, and past `spec/deployment.md`
§3.1's own measured p90 of 537s. Both were true once, on lore's own small repo with a warm
cache; neither is the shape of a review against a larger, colder target.

**`runT0` ran ast-grep and semgrep in a `for` loop, then separately awaited the sandboxed
install+tsc+eslint phase — two independent pieces of work, paid one after the other for no
reason beyond the order they were written in.** They share no state: the host engines are
lore's own binaries reading `worktree` read-only (D-24's boundary keeps them out of the
sandbox, not the other way round), and the sandbox works entirely inside its own `/work`
copy and its own node_modules cache, touching `worktree` only through its `:ro` mount. A
two-second ast-grep/semgrep pair sat and waited for an unrelated multi-minute install.
Fixed with two `Promise.all`s — host engines against each other (same independence
argument) and the host group against the sandboxed group — in `runT0` (`src/t0/runner.ts`).
Outcome order is unchanged, since `Promise.all` resolves in input order regardless of
completion order.

**Considered and set aside: running `checkTypes` and `checkLint` against each other,
inside the sandboxed phase, the same way.** They are NOT independent the way the outer
split is — both are currently wired to the SAME `scratch` directory and the SAME
node_modules `cacheDir`, and `withInstallLock`'s own history (the comment on `sandboxed`
in `runner.ts`) is a record of exactly this shape of race already costing two rounds of
confident false claims about someone else's branch, from tsc and eslint sharing a
directory with an install. Doing this safely needs its own scratch subdirectory per
phase — cheap, since `SYNC` already re-syncs from `/src` at the start of every phase
regardless of what a sibling left there — and probably a read-only mount for node_modules
during the read-only phases, which is a separate design question (some target-authored
`lint`/`typecheck` script writing into node_modules would go from "races silently" to
"fails loudly as a false finding," and INV-1 makes that trade worth thinking through
rather than assuming). Left for a change that can justify it on its own, not bundled into
a same-day speed pass.

**Considered and set aside: raising the sandbox's `--cpus 2` limit.** Never a reasoned
decision — `git log` shows it as the value the file was born with, unexplained, while
`--memory` was later raised from 2g to 6g with a comment naming the exact incident
(`turbo run typecheck` OOM-killing a 30-package fan-out). `spec/deployment.md` §4 names
CPU as the scarce resource on a 16-core host with a 14-core Docker VM, so 2 is
conservative on the numbers alone — but it is a shared-host resource question with a
real number to pick and a blast radius that lands on colleagues' concurrent reviews under
a burst, not a single reviewable code change. Flagged rather than changed.

**Not done: disabling SBOM/OSV over its 100% failure rate on this deployment.** Read
before touching — `generateSbom`'s cdxgen path calls `npx --no-install`, which is
specifically documented to fail immediately rather than reach the network when the
package is not cached, so the "no SBOM could be produced" outcome seen in the data is a
fast, correct `unavailable` report (INV-1 working as designed), not wasted wall-clock.
Nothing to fix here — the security review type this belongs to was not this pass's
subject anyway.

**D-126 — a review nobody delivered to is an operator ticket, EXCLUDING only the endings
that genuinely self-resolve. BUILT 2026-08-17; corrected 2026-08-18.**

`make status` has shown a review holding an undelivered HIGH finding since D-96, and
nothing ever alerted on it — the one party who can see it is the operator, and the
operator cannot act, because the findings belong to another principal's token and
`review_inbox` is correctly scoped to that token. `uncollectedHighOlderThan(hours)` counts
these; the heartbeat tickets it once, latched on the count so it does not repeat while it
stands, and re-arms when the count changes.

**Shipped excluding every terminal state, which was one exclusion too many — found
LIVE, a day after it shipped.** A HIGH finding on `master` sat undelivered for **four
days**, invisible to this query the whole time, because the review carrying it happened to
end `failed` and `failed` shared `TERMINAL_SQL`'s exclusion with `cancelled` and `expired`.
That set answers "is this review over"; the right question is "did this ending already
account for whoever should have seen the finding" — and only two of the three terminal
states do:

* **`cancelled` hands its findings over explicitly**, at the moment of cancelling —
  `review_cancel` calls `markDelivered` on everything raised, by design, as its own
  comment says: *"a cancelled review still found what it found... marked delivered,
  because this is the handover."* Genuinely self-resolving.
* **`expired` only happens after days of escalating, repeated signal** —
  `findings_ready` sitting unanswered dims to `findings_stale` at 48h and is swept a week
  after that. By the time a review reaches `expired`, the client has been told, twice,
  and chose not to come back.
* **`failed` has neither property.** A round can fail on its very first attempt, with no
  warning and no handover, and nothing anywhere marks what it had already found as
  delivered. It is the round's own mechanical conclusion, not a person's or the clock's
  decision, and it says nothing about whether anyone ever saw what a tier found before it
  died.

Fixed by excluding `PERSON_OR_CLOCK_DECIDED_SQL` (`cancelled`, `expired`) instead of
`TERMINAL_SQL` — the distinction `decidedByPersonOrClock` already existed to make, for a
different but related reason (D-107's late-diff handling), applied here for the first
time. `passed` and `passed_partial` were never excluded and still are not: a review's own
terminal step does not hand its findings over either, and the normal client loop (poll
until terminal, one more poll to see it) already collects them in the ordinary case — this
only fires where that loop did not happen.

**D-125 — D-94's probe covers ROUTES, not only tiers. BUILT 2026-08-17.**

Vany, on being offered a manual route-clear: *"no, everything must be automated."*

`shouldProbe` was only ever asked about the TIER mark — and every outage this service
actually has is a ROUTE mark, so nothing re-tested one. A parked route sat out its entire
doubling backoff untouched.

**Measured the morning it was found.** `openai/gpt-5.6-terra` parked until a GUESSED
19:18Z, last asked at 00:46Z — eleven hours earlier. `kimi-for-coding/k3` likewise. So t2
and t3 both answered on `zai-coding-plan2/glm-5.2`, all three tiers were z-ai, and ten
consecutive reviews came back `passed_partial` for a total vendor collapse. Every finding
in them was solved; what was missing was a second opinion, and the ladder had one available
that nobody was asking. OpenAI's limit on that plan is a rolling window which had almost
certainly reset several times over.

**A GUESS IS RE-TESTED; A STATED RESET IS HONOURED TO THE SECOND.** That is the whole rule.
When a provider names its reset (D-91) it has told us something true and probing it is
re-asking an answered question — which is the cost Vany refused when he said *"I do not
want a regular check for quota if nothing happens."* A doubling backoff lore invented is
not information, and re-testing it costs about twelve seconds since D-91 made a refusal
arrive fast. Twelve seconds against a whole vendor is not a close trade.

Bounded by `PROBE_INTERVAL_MS` exactly as the per-tier probe is, and stamped BEFORE the
call so a hanging route is not probed again by every review that starts meanwhile. A mark
written before this existed has no stamp, which reads as "never probed" — so the first
review after it ships re-tests every route parked on a guess, which is exactly right.

D-90's original reasoning — do not re-ask a dead provider every round — was written when
asking cost 2700s. D-91 made it twelve seconds; D-94 acted on that for tiers and left
routes behind, and the gap was invisible because a route mark and a tier mark look alike
from outside.

**D-123 — a fenced block that will not PARSE is asked for again, once. BUILT 2026-08-17.**

A reply carrying two fenced blocks where one parses and one does not looks healthy: items
came back, the round succeeds, and whatever was in the bad block is gone. Loudly gone —
D-66 already puts it in `checks_skipped` as *"produced a finding this review does NOT
contain"* — but gone, and the retry could not help because it fires only when the WHOLE
reply fails to yield a list. Four such losses in one day, on lore's own review of D-121.
That is the rate this project exists to refuse.

**Only a parse failure, never a schema rejection, and the difference is measured.** Told
the exact rule twice, glm-5.2 shortened an over-long claim by 44 characters and still landed
14 over the cap: re-asking a refusal buys a second refusal and a paid turn. A syntax error
is usually truncation, and a re-send on a warm session is one cheap exchange.

Carried as its own field (`garbled`) rather than sniffed out of the prose in `rejected`,
because the two losses have opposite remedies and a string that must be pattern-matched is
the drift shape this repository keeps paying for. It stays in `rejected` as well: **the
re-ask can only add.** If the model cannot reconstruct the block either, the client is told
exactly what it was told before this existed.

**The provider's own balance is not tracked and never will be.** Vany: *"this information
has no meaning for us, do not track it, we can't use it for a decision."* Consistent with
D-121 — a number about money does not decide anything here — and it forecloses the
plausible-looking feature of checking credit before walking a fallback chain.

**Two more bugs in the re-ask, found by lore's own review of D-123 the day it shipped —
both FIXED 2026-08-18.**

**The merge could make a loss QUIETER than no feature at all.** The re-ask's own prompt
invites the model to reply with an empty array when the lost block "held nothing you have
not already reported" — an ordinary, well-behaved reply. The merge dropped the loss note
from `rejected` whenever the recovery reply merely *parsed* (`recovered.ok`), and an empty
array parses as readily as a real finding does. So the one well-behaved reply the prompt
itself asks for made the loss note vanish with nothing recovered to justify it — pre-D-123
the client at least saw *"produced a finding this review does NOT contain"*; this made
D-123 lose it more silently than before D-123 existed. Fixed by dropping the note only when
the recovery produced at least one real item (`recovered.items.length > 0`). An empty-array
reply does not resolve what a truncated block held — it is the model's own unverifiable
claim that there was nothing more, the same self-report this project does not trust
standing alone anywhere else (INV-1: "I looked and found nothing" is not "I did not look").

**And the re-ask could erase a genuine `done` declaration from the SAME turn.** The
streamed loop's `flag.done` is set by re-invoking the caller's `extract` closure — once on
the turn's real reply, and AGAIN on the re-ask's recovery reply, because `conduct`'s
garbled-block handling does not know it is inside a streamed run. A recovery reply is about
ONE missing block, never about the state of the whole tree, so a compliant one carries no
`done` marker — and the closure's unconditional `flag.done = r.done === true` let that
second, narrower answer silently un-set what the FIRST reply had genuinely declared. The
loop then failed to break on INV-1's own load-bearing marker, bought an unwanted extra paid
turn, and could re-invite findings after the model had already considered itself finished.
Fixed by making the assignment monotonic — `flag.done = flag.done || r.done === true` — so
a later, narrower answer can never retract an earlier, authoritative one.

**D-49 widened — ANY vendor repeat costs the verdict, not only a total collapse.
DECIDED and BUILT 2026-08-17.**

The rule asked the weakest possible version of its own question: *are they ALL the same
vendor?* So three tiers read by two vendors was a clean `passed`, and the entire range
between "three independent opinions" and "one opinion asked three times" was worth nothing.

**D-117 made that range the common case rather than a rarity.** When a subscription runs
out, the free fallback is by construction another plan from a vendor already in the ladder
— that is *why* it is free — so every metered refusal trades money for vendor diversity.
Measured on lore's own review of D-121, which passed CLEAN on exactly this shape: t1 on
`zai-coding-plan/glm-5.3` and t2 answered by `zai-coding-plan2/glm-5.2` are both `z-ai`, t3
was OpenAI. Two opinions, three tiers, a clean pass, and only a `checks_skipped` sentence
saying otherwise.

Vany, asked what two-of-three should be worth: **downgrade on any collapse.** I argued the
cost and he took it anyway — see below; the argument is recorded because it is the thing to
re-read if this turns out to have been wrong.

**The collapse is a REPEAT, not `distinct < tiers`.** A ladder of one model tier has one
vendor by construction, and the obvious arithmetic would have refused `passed` to every
single-tier configuration for a property it cannot have.

**What it costs, stated rather than discovered.** `passed_partial` already means "a tier
could not answer", and this loads a second meaning onto it. While a subscription is out —
which is now — every deep review reaches `passed_partial` rather than `passed`. A state
that is normal during an outage teaches people to ignore it, and that is the risk taken
here deliberately: the alternative was a verdict that says three independent opinions read
the code when two did, which is the kind of quiet overstatement INV-1 exists to refuse.

**Measured over every vendor that READ the review, not the one each tier is on now.**
`answeredBy` is last-write-wins — it exists so a warm session is not abandoned when a route
flips, and it must forget. Independence borrowed that field and inherited the forgetting: a
tier that ran on Kimi for five rounds and Z.ai for two reported only Z.ai, so the verdict
claimed a collapse most of the review did not have; reverse the order and it claims three
independent opinions while one vendor read the code twice. Wrong in both directions and
invisible from outside. Vany, asked what it should be measured over: every vendor that read
the review.

So `readBy` accumulates beside `answeredBy`, and the recording changed at the source: what
ACTUALLY answered is recorded, including a tier's own model, where before only fallbacks
and pool picks were. Crediting the CONFIGURED model instead would be worse than the bug —
a tier dead since round 0 would be counted as an opinion nobody gave, which is INV-1
exactly.

**Accumulation is also what makes the arithmetic honest.** Over a last-write-wins field the
test had to be "some vendor appears twice", because `distinct < tiers` would have refused
`passed` to every single-tier ladder for a property it cannot have. Over the union,
`distinct < tiers` is simply right: one tier contributing one vendor is `1 < 1`, false; and
a tier that ran on two vendors contributes both, so a review where Moonshot read at t2
before Z.ai covered for it really did get three opinions and says so.

`soleVendor` is KEPT beside the new `vendorSpread` and still means exactly what it always
did — every tier was one vendor. A client reading the old field is never told anything
false; it is simply the extreme case of the new one. The spread is carried in the ladder
STATE and not only in the `Decision`, because the attestation and the operator board are
written from the state after a review ends, and a collapse visible only inside a decision
would be invisible in both places a reader goes to find out what a verdict was worth.

**D-122 — a kept session outlives the process that opened it, so a deploy costs ONE STEP.
DECIDED and BUILT 2026-08-17.**

Vany: *"deployment must not kill the full ladder, may be one step."*

D-80 made a review one conversation per tier instead of a series of cold audits, and that
is most of this service's cost model. The session ids lived in a `Map` on the `Reviewer`
instance and nowhere else — so a restart forgot all of them, and every open review started
its next round cold, re-reading its whole diff at full price.

**opencode had lost nothing.** Its session store is the `opencode-data` named volume, which
survives the container being recreated; only lore's index of it was gone. So the expensive
half of every deploy was avoidable bookkeeping, and it was invisible: no alert, no status
field, nothing in the logs. The `109 minutes of t2 work` one morning attributed to the
requeue was mostly this.

The ids are now rows in `meta`, keyed by the composed `sessionKey` (review, tier, MODEL) so
there is one definition of that key and it lives beside the sessions in
`reviewer/continuity.ts`. **Written when the session OPENS, not when the round ends** — a
round that dies mid-call is precisely the case they exist for, and an end-of-round write
would not exist for any of them.

`Reviewer` reaches them through a `KeptSessions` port rather than the store, because it
talks to opencode and should not also know what a database is — and because the claim worth
testing is *"a NEW Reviewer continues what the old one opened"*, which is a two-instance
question a private field cannot express at all.

**What a deploy costs now:** the member that was mid-call. A sibling of the same rung that
had already answered keeps its rows and resumes, one `continue → done` exchange. Everything
else — ladder, findings, ratified justifications, pinned worktree — was always durable.

**And the ordering it makes load-bearing.** `clearSessionTrees` deletes the session-id rows
too, and after a restart those rows are the ONLY record of what a review holds — so both
release paths had to be inverted: RELEASE first, reading the ids, then clear. Clearing
first deleted them and left `release` enumerating nothing, so no delete ever reached
opencode and the sessions lived until opencode itself restarted. That is the accumulation
`release` exists to prevent, reintroduced by the change that made the ids durable.

**The failure this makes reachable, and its bound.** A stored id can outlive its session:
opencode's volume replaced, its data pruned, this database restored from a backup older than
the session. `session.prompt` answers 404, which gets its own error type rather than a
status to sniff for — the first version threw it as a generic `HttpStatus`, the classifier
flattened it to `DidNotRun`, and the recovery silently stopped working. On it, lore forgets
the row and starts cold ONCE. Left unhandled that row would have failed its tier on every
future round of the review: permanent, and strictly worse than the cold start it avoided.

**D-121 — a price is REPORTED, never acted on. The daily spend ceiling is gone.
DECIDED and BUILT 2026-08-17, one day after it cost eight people their reviews.**

Vany: *"we only show the price, there is no decision on the basis of it."*

lore records what opencode says each call cost, sums it per tier and per day, and shows the
figures on `/status` and the board. Nothing anywhere branches on them. No total refuses a
review, stops a round, suspends the queue or expires anybody.

**lore never calculated a price and does not start now.** There is no rate card in this
codebase. `cost_usd` is whatever the provider reported (`usageFromMessages`), summed — so
what is removed is a *decision*, not any arithmetic.

**What the ceiling actually did, on the one day it fired.** It refused admission at $100,
and the money was already spent by then; the people it stopped were not the people who
spent it. Eight reviews across three colleagues' branches, most at round 0, having read
nothing, because an unrelated batch had walked onto a metered route four hours earlier.
D-119 softened that from `failed` to a pause the same day — right about `failed`, and
still the wrong instrument: a paused gate is a gate that did not run, which this project
holds to be its worst outcome. Converting a money problem into an availability problem is
a bad trade for a service whose entire product is *the review actually happened*.

**A total is the wrong shape for this question.** It can only speak after the fact, it
cannot distinguish who spent it, and its remedy is necessarily collective. The question
worth asking is per call and answerable before the call: *is this route one that charges?*
That is D-117, it costs nothing when the answer is yes, and it is now the only place money
enters a decision at all.

**What went, concretely:** `mayStart` and the enqueue refusal, `frozenBySpend` and the
dispatcher freeze, the round-boundary backstop, the retention-sweep exemption, both spend
alerts, `hasMeteredUsage` and the `metered` flag that existed only to explain that the
ceiling could not fire, and `LORE_DAILY_CEILING_USD` — which now REFUSES TO START if it is
still set, because believing a number caps the day when none does is worse than having no
answer. `/status` publishes `allow_metered` in its place.

**What this gives up, plainly:** nothing bounds the total. A deployment that sets
`LORE_ALLOW_METERED=1` and then loses a subscription will bill on every call until a person
notices, and D-117's route gate is what makes that a decision somebody made rather than one
that happened to them. Under `LORE_ALLOW_METERED=0`, the default and this deployment's
setting, the bound is structural: no route that charges is ever called.

**D-118 — the operator board grows a CONFIG window, and it is where the knobs live.
DECIDED 2026-08-16; the READ half built 2026-08-17, the write half and the token button
deliberately not.**

Vany: *"make config window on web with this checkbox, also put all parameters there. And
issue new key for button, also it may create new repo if needed."*

Everything that is currently an environment variable, a tiers file or a `make` target
becomes visible and editable in one place, for one reason: the knobs that matter are the
ones that cost money or decide what runs, and today they are spread across a `.env` nobody
reads, a JSON file on the host, and commands only I run. An operator cannot see the shape
of their own deployment.

* **Every parameter, in one window** — the tier ladder, D-117's metered toggle, the sweep
  intervals, the admission limit. Read AND write. (The spend ceiling was on this list until
  D-121 deleted it; what remains of money in the config is the one yes/no.)
* **A button that issues a token**, replacing `make new NAME=… GIT=…`. It creates the
  repository row when the URL is one lore does not have yet, so provisioning a new person
  on a new repo is one action rather than a shell session.
* **The token is shown once and never again**, exactly as `make new` behaves now: the
  plaintext is not stored, only its hash, so a database backup is not a set of live
  credentials. The window must not weaken that — it is the one rule the button inherits.

**What is built (2026-08-17): `/config.json` and `ops/config-view.ts`** — every parameter
with its value, whether it was CHOSEN or defaulted, what it does, and how to change it;
the ladder RESOLVED to the routes that will actually be called rather than the nicknames
the file names; and one derived sentence answering whether an outage costs money or
coverage. That is the whole of D-118's stated problem — *an operator cannot see the shape
of their own deployment* — and on 2026-08-16 the answer to "why did this cost $101.36" was
one variable that nothing anywhere displayed.

**Why the write half is NOT built, as a decision rather than an unfinished edge.** A
live-editable knob needs every reader of it to go through one resolver, and several read
`process.env` directly today — `concreteRoute`, `noRouteBecause`, `renderStatus`. Wiring
some of them leaves the window asserting a value the ladder does not use, which is exactly
the defect class five findings in one round had just been raised about: a rule stated in
one place and applied in another. Each row therefore says how to change it, and nothing
pretends to. `source` is on every row for the same reason — "0" means nothing without
"because you set it" or "because that is the default", and the post-mortem needed precisely
that distinction.

A credential is never rendered: `LORE_WEBHOOK_URL` shows `(set)`, and a test asserts the
value cannot appear anywhere in the payload.

**D-117 — a metered route is one the operator switched on, and that operator is a person.
DECIDED 2026-08-16 after it cost $101.36 in four hours; BUILT 2026-08-17.**

Vany: *"metered is only openrouter. It is human managed."*

Two things follow, and they are what makes this buildable rather than a heuristic.

**Metered means `openrouter/`, and nothing else needs inferring.** Every other provider in
this deployment is a flat subscription; OpenRouter is the only one that bills per call. So
"did the fallback chain walk onto the meter" is a string test on the route that ran, not a
cost model, and it is answerable *before* the call rather than after it.

**Whether to allow it is a human decision, held in config** (D-118's window, as a
checkbox) rather than inferred by the ladder. A deployment that has deliberately bought
metered capacity as its safety net wants the fallback; one running purely on subscriptions
does not, and would rather have `passed_partial` with the tier named in `checks_skipped` —
honest, free, and already implemented. Neither is right in general, so lore stops guessing
and asks once.

The incident this decides, kept because it is the evidence: at 05:06 UTC the Kimi
subscription hit its billing-cycle limit — `403: you have reached your usage limit for this
billing cycle`. D-48 parked the route and walked the chain exactly as designed, onto
`openrouter/moonshotai/kimi-k3`: the same model, metered, ~$4.83 a call. Twenty-one calls,
$101.36, every other tier that day costing zero. The route mark said `stated: false`, the
fallback is invisible to clients by design, and the only thing that finally spoke was the
daily ceiling — four hours and a hundred dollars later, to everyone except the person who
had spent it.

**The fact worth preserving past the fix: route health and route COST are different
questions, and only one of them was being asked.** Every fallback chain in this service is
written as "keep going", and none of them asks what continuing costs.

The metered-fallback notice already carries the per-call figure (built 2026-08-16), which
is the half of this that changes nothing about what runs and so did not wait for a
decision.

D-48 makes "cannot pay" a route fault: park the route, walk the fallback chain, keep the
review alive. That is right, and it is silent about the one thing that turns out to matter
most — **whether the chain walked to another free seat or onto the meter.**

What happened, exactly. At 05:06 UTC the Kimi subscription hit its billing-cycle limit:
`403: You've reached your usage limit for this billing cycle`. `kimi-for-coding/k3` was
parked, correctly, and every subsequent t2 call fell through to
`openrouter/moonshotai/kimi-k3` — the same model by a metered route. Twenty-one calls
later the day's spend was **$101.36, all of it t2, at roughly $4.83 a call**, against a
$100 ceiling that had been fine every previous day. Every other tier that day cost zero,
being on subscriptions.

**Nothing said so.** The route mark carries `stated: false`; the fallback is by design
invisible to the client, which is what D-48 wants; and the only thing that eventually
spoke was the spend ceiling — four hours and a hundred dollars after the event. It then
spoke to everyone at once: **eight reviews across three colleagues' branches failed, most
at round 0**, having read nothing.

The ceiling worked. It is the wrong instrument to find this out from, because by the time
it fires the money is spent and the people it stops are not the people who spent it.

**And the SECOND branch is now built too, which it was not when this said it was.** The
per-call figure reached the operator LOG the day the gate shipped, and that sentence was
written here as though the shape were complete. It was not: a log line is read by somebody
already looking, and during the four hours of 2026-08-16 that cost $101.36, nobody was.
Since 2026-08-17 the FIRST REVIEW ROUND each UTC day that runs on a paid route lore reached
itself — not one the operator configured — sends a **ticket** naming the tier, the route
and what that call cost. **Only review rounds**: the hourly screen, the bootstrap survey
and `propose` reach paid routes through `concreteRoute` and are not wired to it, so a
deployment at `LORE_ALLOW_METERED=1` whose screen is paying hourly with no reviews running
gets no ticket at all. Recorded in `TODO.md` as an open gap rather than described as
covered — the first version of this paragraph said "the first call", which is the same
overstatement the alert exists to prevent. An EVENT, not a threshold: no total is consulted, so D-121 is
untouched, and it cannot fire at all under `LORE_ALLOW_METERED=0`. Latched per day, because
a message about money repeated every round is one an operator learns to skip.

The test is `ranOn !== member.model`, and deliberately not `exemptLiteral`: that predicate
answers whether a tier's MODEL is exempt from the gate, and a tier with an ordinary
subscription model falling back to a paid twin has an exempt model while being exactly the
event worth reporting. The question is who chose the route, lore or the operator.

**Settled, 2026-08-17: the first branch, made switchable.** A metered fallback is refused
by default — `passed_partial` with the tier in `checks_skipped`, which is honest, free and
was already implemented — and `LORE_ALLOW_METERED=1` restores it for a deployment that has
deliberately bought metered capacity, which was the objection to refusing outright. The
second branch (stay available, become loud) shipped as well and is not an alternative to
this one: the per-call figure already reaches the operator log the moment a chain falls
back — as a ticket since 2026-08-17, not only a log line. The third — a ceiling with a
second dimension — died with the ceiling (D-121).

**Where it lives:** `isMeteredRoute` in `src/core/metered.ts`, applied to the fallback
chain AND to a tier's route pool in `runRound`, with the exemption defined once in
`exemptLiteral` because there are three gate sites and both holes found so far were a site
that did not have the rule.

**The exemption needs TWO conditions, and shipping with one was a hole in the configuration
this repository distributes.** A literal `openrouter/x` is the operator switching a paid
route on — but only if the operator wrote the ladder it is in. `DEFAULT_TIERS` is three
literal `openrouter/` models chosen by nobody, and `deploy/docker-compose.yml` passes
`LORE_TIERS: ${LORE_TIERS:-}`, where blank means exactly that default. So on a fresh copy
of the shipped compose, `LORE_ALLOW_METERED=0` gated NOTHING and every call billed, while
five documents promised no charging route is ever called. Vany, asked which way to resolve
it: exempt only an operator-written ladder. When the default ladder is in use and metered
routes are refused, the service starts and says at once that no review can run — because
the honest state is "running and unable to review anything", which is recoverable by
either a tiers file or the toggle, and a refusal to boot would break a first `make up`.

Only the LITERAL model id of an operator-written ladder is exempt:
naming `openrouter/x` as the tier's model is the operator switching it on, since it runs
every round at a cost that is chosen and immediate. Everything else is conditional — a
fallback is insurance, invisible until a subscription dies, then billing every call for as
long as the outage lasts; and a POOL MATE is lore picking between interchangeable routes,
which is not a choice anybody made per call.

**And it is gated at BOTH places routes are chosen**, not just in the round:
`concreteRoute` resolves a tier for the callers that are not a review — the hourly
knowledge screen, the bootstrap survey, and `propose` (proposer and critics) — and it
shuffles a pool exactly as the round does. Gating only `runRound` left every one of those
able to hand opencode a paid route, once an hour, indefinitely, under a deployment
documented as never paying. The check lives inside `concreteRoute` so the next caller is
gated by existing rather than by somebody remembering.

**The pool was the hole** (findings `ccccf0db` and `08d4834f`, 2026-08-17).
The gate first covered the chain alone, on the reasoning that a tier's own model is
explicit. A NICKNAME breaks that: `routesFor` expands it to a pool and `poolOrder` shuffles,
so a metered pool mate becomes the unfiltered PRIMARY in some fraction of rounds — and in
every round once the free routes are parked, which is the 2026-08-16 shape exactly. It
would have falsified D-121's claim that at `LORE_ALLOW_METERED=0` no charging route is ever
called — twice over, since the same reasoning had left `concreteRoute` open too. The lesson
is the general one: **an exemption written for a literal value must be re-checked against
every indirection that can produce that value.** Reachable with a validly-named pool (`zai-coding-plan/glm-5.2` and
`openrouter/z-ai/glm-5.2` are one model by two routes; the loader rejects a pool whose
members are different models, which is why the finding's own K3 example would not load).

The fact the day proved, kept: **route health and route COST are different questions, and
only one of them was being asked.**

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

**Why this stayed advisory, and why it no longer is.** When the rule was written the
deployed ladder *was* single-vendor: Kimi was waitlist-only and a second subscription
could not be bought, so the honest response to "we cannot afford independence" was to
say so in the output rather than quietly redefine `passed`. The `[OPEN]` marked that
it was decided under that constraint and should be revisited when a second vendor
became reachable.

**It became reachable** (D-74, 2026-08-06): the ladder is Z.ai, Moonshot and OpenAI,
one vendor per tier. The rule now costs this deployment nothing and would only fire
if the ladder collapsed back onto one vendor — which is exactly the condition it
exists to refuse to call `passed`. Confirmed rather than open.

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

**The distribution arrived, 2026-08-11** (`research/t2-token-cost.md`), and it says the
opposite of what a cap usually has to argue against. Across 128 completed t2 rounds,
matched to the findings each raised on `(review_id, origin, round)`:

| t2 rounds | count | findings/round | high found | $/round | $/high |
|---|---:|---:|---:|---:|---:|
| under 25 steps | 50 | **2.12** | **5** | **$0.19** | **$1.85** |
| 25–39 steps | 45 | 1.53 | 4 | $0.81 | $9.13 |
| 40+ steps | 33 | 0.97 | **1** | $1.31 | **$43.14** |

**Longer exploration finds LESS, in absolute terms.** Thirty-three rounds of 40+ steps
produced one high-severity finding between them; fifty short rounds produced five. And it
is not about how much code was given: a **7 KB diff cost $0.95** while an **803 KB diff
cost less, in eight steps**. The dearest band is 20–80 KB — big enough to look worth
investigating, small enough not to fill the budget.

Both readings of that correlation argue the same way. Either long exploration is
unproductive, or the agent explores long BECAUSE it is finding nothing; on each, a cap
saves money and loses nothing. The only reading that argues against — *it would have found
it on step 45* — is measured at one high finding across thirty-three such rounds.

`[OPEN]` — **the cap itself, which is Vany's to set**, because it changes how much quota
burns. Capping t2 at ~25 steps is worth roughly **$60 of $89**. Two things it must do when
it fires: report itself in `checks_skipped` with the step count, because a round that
stopped early did not finish and `clean` would be INV-1 exactly inverted; and be read
alongside D-80's session continuity, which attacks the same number from the other side — a
continued session needs ~6 turns where a cold one needs 31.6, so the two together are not
additive.

`bootstrap()`'s model call still records no usage row at all, so it is in none of the above.

**A failed call now DOES leave a row** (D-85), read back from the session opencode leaves
behind and written with `outcome: 'failed'`. Before 2026-08-09 it left none, so two
45-minute attempts against an exhausted plan showed as zero spend while the provider
counted every token.

**And that has made the two paths disagree, which is worse than either alone.** The
SUCCESS path reads the token columns from the ONE assistant message a prompt reply
carries, so it describes a single turn rather than the session — in a real 73-turn session
the per-message cache reads were 100k–450k each and summed to 17.9M. The FAILURE path sums
every assistant message, so it records the session. Identical work therefore produces a
much larger row when it fails than when it succeeds, and any total across both is
meaningless.

That is a defect introduced by fixing the other one, and it is stated rather than left to
be discovered by whoever first sums the column. Closing it is small — `usageFromMessages`
already exists and the success path can use it, or `GET /session/:id` returns the true
totals in ~700 bytes. Nothing decides on these numbers any more (D-121), so the risk is to
the operator's reading of their own deployment rather than to what runs — which lowers the
practical stakes and not the honesty requirement.

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

**D-6, revised 2026-08-07 — a closed tier stays closed.**

The original reset the ladder to the cheapest model tier after any change, on the
grounds that a fix is unreviewed code and must face the cheap gate again. Vany's call
to retire it: *"if a level is closed, it is closed finally, you will return there only
in the next review… it is submitted, it is reviewed by the model ASAP and you can go
next."*

**The reset broke D-10.** `settle()` runs on whichever tier the round is on, so after a
reset the CHEAPEST model ruled on justifications for findings the dearest had raised.
Observed four times in one review of this repository — t1 coming back "clean" and
closing t2's questions. D-10 says the reviewer rules on the answer; the reset quietly
gave that ruling to a model that never asked the question. A cheap model ratifying
answers to an expensive model's findings is worse review, not more of it.

**And it made the sawtooth.** Every dear-tier finding cost two rounds, because t1 had to
re-clear the fix before t2 could look again: five findings cost nine rounds, and two
reviews of this repository died on the per-tier bound that way.

**What is given up, and it is real.** The tiers BELOW no longer read the last diff. T0
still runs every round, so `tsc`, `semgrep` and the tests see every fix; what is lost is
a second model opinion, from a *weaker* model, on the final tree. So `passed` now means
*"every tier agreed, and these tiers read this tree"* — narrower than before, and the
attestation says which (`spec/review-ladder.md` §5). `tier_run.tree_hash` exists for
exactly that, because an attestation that counted every tier that ever ran would claim
scrutiny the signed tree never received.

**What it does NOT fix.** The bound is per tier, not per round, so a conversation that
loops on prose still stops at the same place — cheaper, same wall. That remains open.

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
  authoritative there — **unless that round's T0 was itself interrupted** (an
  engine killed, out of memory; `T0Result.interrupted`, found by lore's own review
  of the OOM-kill fix, fingerprint dd98f788). An engine that did not finish proves
  nothing about a finding it might have raised again, and there is no per-finding
  record of which of T0's several engines raised which — so one interrupted engine
  withholds T0's silence from settling anything that round, not only its own.
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

**D-80 — a review is a conversation, and the whole loop is asynchronous.**

Today a round is a fresh opencode session: prompt, answer, session discarded. A fix
starts a new one, which re-reads the repository from nothing. The client meanwhile
polls, because nothing can tell it anything.

Both halves are worked around rather than designed, and the protocol and the model
runtime each grew the missing piece.

**The session stays open.** One conversation per tier, for the life of the review. The
reviewer raises a finding; the author's diff is applied and handed to *that same
session* as the next message — *"this is the change that answers your finding; does
it?"* — and the model, which already holds the repository, answers whether it is
settled, or why it is not, or what the fix broke instead.

That is what a review is. A thread between two parties, not a sequence of independent
audits of a moving tree. And it is how the ratification in D-10 was always described:
the reviewer rules on the answer. It has been implemented as *a different model
instance re-deriving everything and inferring assent from silence*, which is the same
idea with the conversation removed.

**Nothing waits.** `review_submit` applies the patch and returns at once; the model's
answer arrives later as an event. The client subscribes with `subscriptions/listen` on
`lore://review/{review_id}` and is woken by `notifications/resources/updated` — it does
not poll and does not block, and may submit at any moment, including while a tier is
mid-read (`research/mcp-subscriptions.md`).

**Subscription is the main path and `review_poll` is the fallback**, in that order,
including in the tool descriptions a client actually reads. The two are not rivals:
subscription answers *when*, poll answers *what*, and a subscribing client uses both
without ever sleeping. Polling survives because a client that never sends
`subscriptions/listen` receives nothing at all — the server may only send what was
subscribed to — and because a notification carries a URI rather than the findings.
What is being left behind is not the poll but the loop around it.

**This retires D-55 rather than violating it.** That decision refused a submit during a
running round because the tier's findings would describe a tree that no longer existed
— the reviewer reading files changing underneath it, silently. In a conversation the
change is not silent: it is the next thing said. The model is told what changed and
answers about the tree as it now stands, which is what D-55 wanted and could not get
from a request/response round.

**What it costs, and this is the part to watch.** An agentic session re-sends its
accumulated context every turn (D-50) — one measured call read ~1.5M cached tokens
before answering. A conversation across ten exchanges grows monotonically, and the
exchange that settles a one-line fix pays for the whole history. Against that: today
each round pays to re-read the repository from scratch, and the measured cache hit is
97–99%, so the comparison is not obvious in either direction. **It must be measured
before this is called cheaper.**

**And it changed what the ladder means** — settled by revising D-6 on 2026-08-07,
ahead of the conversation half. The tier that raised a finding now judges its own fix,
which is what D-10 always said and what the reset had been quietly preventing. The
ladder still climbs; it climbs from a settled conversation rather than from a fresh
audit, and `passed` names the tiers that read the signed tree rather than implying all
of them did.

**The subscription half is built; the conversation half is not.** `subscriptions/listen`
against `lore://review/{review_id}` is live and proved end to end against a real MCP
client (`src/service/subscribe.test.ts`): the server declares `resources.subscribe`, one
handler for the process owns the listen router, and a **state change** — nothing else —
wakes the subscribers of that review and nobody else.

That rule got narrower twice under review, both times for the same reason. Findings do
not wake anyone as they are recorded: a round writes them in one burst, so six findings
were six notifications and, under "poll on each wake", five wasted LLM turns on empty
deltas — and D-55 refuses the submit until the round ends anyway. A write that changes
no state does not wake anyone either: every round boundary rewrites `running` over
`running`, so a review climbing the ladder woke its subscriber twice per tier with
nothing to report. A notification per non-event teaches a client to ignore the stream,
which costs more than every notification saves.

**And it does not weaken D-23, though the first version did.** The MCP listen router
authorizes nothing: it matches URIs against what the client asked for, so on the stock
bus a subscription to somebody else's review id would have been an existence-and-activity
oracle for exactly the thing `getReview` answers with NOT FOUND — and a stream would have
outlived the revocation of the token that opened it. Delivery is filtered per event
against the review's owner and the token's liveness (`spec/mcp-api.md` §2.0.2). Raised by
t2 against the commit that added subscriptions, which is D-77 doing its job on the change
that made it possible.

**Built, correct, and unreachable from the only client we have.** Measured 2026-08-06:
Claude Code parses `resources.subscribe: true`, records it, and gives the model no verb
that can send `subscriptions/listen`. The negotiated revision does not matter, because
there is nothing to reach the method with on either one. The evidence had been sitting
in the tests all along — they are driven by a hand-built SDK client because the harness
offers no other way to open that stream.

**And the deeper reason it will stay that way: an agent client is not a process.** It
exists inside a turn; between turns there is no recipient for a notification. A harness
would have to convert one into a new turn, which lore cannot influence. So the job is
not *"wake the client"* but **make leaving cheap, and make "when to come back" a
measured answer** — `check_back_after_ms` from `usage.latency_ms`, and `review_inbox`
as the first call of every session, because a session ends, its subscription dies with
it, and only the next session asking survives that.

The subscription surface stays exactly as built: correct, tested, free to keep, and
ready the day a harness wires notifications to turns. What it no longer does is open
the tool descriptions with an instruction the only real client cannot execute.

**Both questions were answered 2026-08-11, and the session half was built 2026-08-12.**

**Which half.** *A tier keeps one session for the life of a review* is built and on by
default for every model tier (`src/reviewer/continuity.ts`, `Tier.conversation`). *A submit
is handed to that live session mid-round* shipped as D-107 (built 2026-08-14): held at
submit, applied and delivered at the next emission of the streaming loop. D-55's refusal
is retired — its protection survives as the hold.
The saving claimed below is the one now collected: repeat rounds enter a session that
already holds the repository, instead of re-orienting from nothing.

**How a deep tier enters.** It does not inherit anything. Vany: *"a tier enters from an
empty prompt but on a fixed tree."* Reaching t2 opens a NEW session, empty of t1's
reasoning, on the tree as it now stands. That is not a compromise — it is the ladder's
value: a tier that read the previous model's conclusions would make three tiers into one
opinion asked three times, which is what D-1 and D-49 exist to prevent. What still travels
is the RECORD, not the reasoning — `settledBlock`, so the new tier does not re-raise
questions the author has already answered to somebody else.

**Whether it is cheaper, measured** (`research/t2-token-cost.md`). Against 128 completed t2
rounds: a cold round spends **31.6 turns** against a context averaging ~31K tokens — 972K
cached reads, 95K fresh, $0.69. Almost all of those turns are re-orientation in a worktree
the model examined minutes earlier. **63 of 218 model rounds (29%) are a tier re-reading a
review it already knows**; t2's 36 repeats alone are ~$25 of the $97 it has ever cost.

The objection that kept this open — that a conversation re-sends its whole context every
turn, so it wins early and loses late — was an argument against an UNBOUNDED conversation.
Vany's rule removes it: **compact at 2/3 of that tier's context window**, never restart.
opencode supports it directly (`session.summarize`; `CompactionPart.auto` shows it already
compacts on its own, so this chooses a threshold rather than inventing a mechanism). What
remains is the saving that matters, and it is in TURNS — which the same measurement shows
to be both the cost driver and INVERSELY related to findings: rounds under 25 steps average
2.12 findings at $0.19, rounds over 40 average 0.97 at $1.31.

**Compaction, not restart, and the distinction is the whole point.** I proposed dropping
the session and starting cold on the current tree, arguing that the worktree is the memory.
Vany: *"I said compact, who said restart?"* He is right. The worktree remembers the CODE;
it does not remember why the model looked where it looked, what it ruled out, or what it
was suspicious of and let go. `settledBlock` exists to reconstruct a fraction of that for a
fresh session, badly.

**So: one session per (review, tier), started and initialised exactly once per review,
compacted at 2/3, with a cold start as the fallback — which is today's behaviour, so the
floor is no worse than now.**

Three things the implementation had to get right, none of them reopening the decision, and
all three are how it is built:

- **Sessions are released when the review ends, by whichever path it ends.**
  `Reviewer.release(reviewId)` deletes every session that review opened. Kept alive and
  never closed, 128 admitted reviews × 3 tiers is 384 live sessions, so this is not
  housekeeping — and the worker alone was not enough, because **two terminal paths never
  reach it**. `review_cancel` on a review sitting in `findings_ready` runs with no job in
  flight, so `cancel` releases its own; and the retention sweep marks abandoned reviews
  `expired` in SQL, which nothing in that path could have known to release. The third
  mechanism is therefore a RECONCILE in the worker's claim loop, on a one-minute timer —
  kept sessions whose review is terminal, or gone, are released — written that way
  deliberately so the next terminal path nobody thinks of is collected too. **On a timer
  and not on the loop's idle branch**, which is where it was first put: a service with a
  full queue never goes idle, and a queue is full exactly when expiries accumulate. Every
  existing way a review can end predates the session map, which is the argument for not
  enumerating them.
- **A lore restart loses the session map**, which is in memory by choice. A requeued round
  finds nothing and starts cold — today's behaviour, already proven, so a restart costs
  re-orientation and never a failure. What it does NOT recover is the sessions the previous
  process left in opencode: nothing knows their ids any more, so they live until opencode
  restarts. Accepted rather than solved — persisting the map would make a stale id
  survive a restart and be spoken to as though it held a conversation it no longer has,
  which is a worse failure than an idle session — but it is the reason a deploy is not free
  here.
- **One property is given up: fresh eyes each round.** A long-lived session may defend its
  earlier findings rather than re-read. The design is consistent with D-10 — the tier that
  raised a finding should judge the answer — but whether it costs anything is measurable:
  findings per round, and how often a finding is withdrawn after a fix. **Not yet
  measured**, and the baseline to measure against is `research/t2-token-cost.md`.

**What the continued round is told, and why it is short.** The initial prompt orients: the
bar, the guidance, the tree, the whole of `settledBlock`. The continued prompt does not
repeat any of it, because the session still holds it — it names what changed and which of
its own findings are still open, and asks about those. Re-sending the orientation would be
the cold start this replaces wearing a different name.

**A session belongs to a (review, tier, MODEL), and the model is not decoration.** It was
keyed on (review, tier) until 2026-08-12, which held for exactly as long as a tier only ever
ran on one model. A tier standing in on its twin keeps its ID and changes its MODEL, so the
primary's session was handed to the fallback — and two things went wrong at once. The
fallback model was sent the CONTINUED prompt on its first contact with the review, which
says *"the author has answered"* to a reviewer that has never read the code. And opencode
ties a session to the model that opened it, so a call lore addressed to `zai-coding-plan`
came back carrying OpenRouter's `402 Insufficient credits`: **the route lore reported as
tried was not the route that answered.** That is the serious half — `unpayable` means every
route refused, and it was being written after a call nobody had made. Observed live on
rev_8ZM1XT7, in the first review that ran with a fallback chain configured.

**Compaction is measured on the LAST turn, not the session total.** The number that matters
is the context the next turn will carry — input plus cache reads on the most recent
assistant message. The cumulative sum across a round is ~30× larger, and using it would
compact almost immediately and then on every turn after, which is the failure mode that
throws away exactly the reasoning this exists to keep. An unreadable window compacts
nothing: a tier whose context we cannot measure keeps the behaviour it had before this
existed, and a compaction that fails is logged and stepped over, never fatal — a review
must not end over housekeeping.

**D-83 — a project's development rules are appealable, and an appeal is argued to the
tier rather than granted.**

Vany: *"project may have development rules… model must have access to this rules, and
client may appeal to this rule, when rejected finding."*

**Most of this already exists and the missing piece is small and specific.**
`knowledge_teach` already lets a client record a rule over MCP; ingestion already reads
`CLAUDE.md`, `PROG.md` and ADRs; both land in one store; and `relevantTo()` already puts
rules in front of every reviewer. What does not exist is the APPEAL — a way to answer a
finding with *"this applies a standard this project has ruled against"* rather than with
reasoning from scratch.

The difference is not cosmetic. A `lore-ok` today says *trust my judgement about this
line*. An appeal says *you are enforcing something we decided not to enforce*, which is
a claim about the REVIEWER rather than about the code, and it is the claim 63 accepted
justifications of one semgrep rule have been making one occurrence at a time with no way
to say it once.

**THE TIER DECIDES, and that is the whole design.** The rule and the appeal go into the
next round's prompt; the reviewing model closes the finding by not re-raising it, or
rejects the appeal by raising it again. lore never closes a finding because a rule was
cited at it. D-10 is the reason: the author never closes its own finding, and a rule the
author also wrote would otherwise be a way to do exactly that — write the rule, cite the
rule, silence the check, with the audit trail reading like due process.

**An accepted appeal settles the CLASS under a PATH, not the one finding.** It records a
suppression — *this engine's rule does not apply under `src/…`, because `<the rule>`* —
carrying the reason the team gave. Not a demotion: D-67 is right that a true finding
stays high, and this is not about severity. It is about a check that is wrong for a
place, said once instead of sixty-three times.

**Stored in the knowledge base, and NOT injected wholesale.** This is the half that
differs from how knowledge works today, and it is deliberate: up to sixty rules already
go into every prompt under *"treat these as this team's decisions"*, and a fifth of them
were fragments before D-81. Development rules would double that cost to say something no
reviewer needs until a client cites one.

So the prompt **indicates** rather than recites: this project has N development rules,
and a `lore-ok` citing one is a statement of team policy rather than an opinion — weigh
it as such. **The rule's text arrives with the appeal**, because that is the only moment
it is relevant, and it arrives in full so the tier rules on what was actually written.

**Any token holder may add one, and who added it is recorded.** The same trust
`knowledge_teach` already extends, for the same reason: three colleagues share
`rigid-monorepo` and every other part of this system treats them as colleagues. What
makes that safe is that a rule cannot silence anything by itself — it can only be argued.

**Built.** Two of the three open questions are settled by building them; the third is
still open and is not blocking.

- **How a client cites a rule:** `lore-ok[<fp>]: rule <id> — <why it covers this code>`,
  in any of the three comment forms the parser already reads. No new tool — the docs are
  the interface, and a fourth call an agent must learn costs more than a fourth shape in a
  parser that has three. `knowledge_teach` at kind `policy` returns the id to cite.
- **What a suppression does to a later round:** the engines run, and their findings are
  filtered before anything is recorded — which is where the saving is, since a suppressed
  finding never resets settling, never costs a round and is never re-argued. Every one
  lands in `checks_skipped` naming the engine rule, the path, the development rule and the
  date. It is scoped to the FILE that was argued about, never a directory: a wider
  suppression than the one that was argued is a check switched off where no tier looked.
- **A suppression is only as alive as its rule.** `knowledge_retire` (or `lore rule
  --retire`) switches every check it bought back on at the next review with nothing to
  sweep — the class by a JOIN to live knowledge, and the individual finding it was argued
  about through `verdict.via_rule`, which would otherwise keep being carried forward as
  settled (D-51) while the operator was told every check now reports again. The
  suppression rows are kept: they are the record of what earlier reviews did not cover.
  `via_rule` is NULL for an ordinary justification, and that is the point — an ordinary
  reason was argued on its own words and nothing can be withdrawn from under it. It is
  recorded rather than inferred because the first version matched the finding's rule class
  and path against revoked suppressions, which also re-opened ordinary justifications that
  merely shared a class and a file with somebody else's appeal.
- **Only a T0 finding whose claim names a rule.** A model finding has no engine rule at
  the head of its claim and re-raising it is judgement, not a pattern re-firing; silencing
  a class of those is silencing a kind of thought. A claim that is a sentence yields no
  class either, so nothing appeals its way past a red suite.

`[OPEN]` — **whether the model can ORIGINATE the appeal's opposite**: *"this rule is
wrong"*. Today a tier can say nothing but findings, which is the same gap that leaves the
escalation path unwired. Worth solving once, for both.

**D-84 — Z.ai names its limit and its reset time; opencode swallows both, so quota
reaches lore as a hang rather than a status code.** — **CORRECTED BY D-91.**

**The second half is false and it cost three days.** opencode swallows the limit and the
reset time *in the message body*, which is where lore was looking. It publishes both,
verbatim and within seconds, on its event stream — a channel nothing here had subscribed
to. Everything below about the hang is accurate; every conclusion drawn from *"the fact is
unreachable"* is not, including the cool-off that guesses a duration the provider states
and the credential trade I twice put to Vany as the only way to learn it.

Kept in full rather than rewritten, because the measurements are real and the reasoning
was sound on a premise nobody checked — and *"which channel did you read?"* is the
question this failure teaches. D-91 has what is true now.

Vany, 2026-08-09: *"z.ai is out of the limits. we must track it."*

**What was measured, in two passes — and the second corrected the first.**

Through lore's own SDK path, the same one-line prompt — *"Reply with exactly: OK"*:

| provider / model | result |
|---|---|
| `kimi-for-coding/k3` | 200 in 4s |
| `openai/gpt-5.6-terra` | 200 in 3s, replied `OK` |
| `zai-coding-plan/glm-5-turbo` | never returned; cut at 240s |
| `zai-coding-plan/glm-5.2` | never returned; cut at 75s |

Two vendors answered in seconds through the identical harness, and BOTH Z.ai models
answered nothing — so this is the account, not a model, and not opencode, the network or
lore.

**Then the provider was asked directly, bypassing opencode, and it answers perfectly
well:**

```
HTTP 429
{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted.
           Your limit will reset at 2026-08-10 18:19:09"}}
```

Immediate, with the code, which limit (weekly, not the 5-hour one) and the exact reset
time. Not in headers — the `X-RateLimit-*` headers belong to the open-platform RPM/TPM
path and neither endpoint sent any; the Coding Plan puts it in the body.

**So the first conclusion was wrong and is corrected here rather than left standing.** An
exhausted subscription does NOT answer nothing. **opencode** answers nothing: the
assistant message it leaves behind carries no error, no retry part and no `finish`. It
swallows the 429 whole, almost certainly by treating it as retryable and retrying inside
the one request. That is the root cause of a customer's failed reviews and of a t2 round
that ran 2h46m.

**The part that matters to the design: no 429 reaches lore.** `Reviewer.review` classifies
quota on `status === 429 || 402` or a message matching `rate.?limit|quota|insufficient`,
and an exhausted Z.ai subscription produces none of them. It accepts the request and
never replies. So the one signal lore relies on to say *"this tier could not be paid
for"* is absent in exactly the case it was written for, and the condition arrives instead
as a hang — indistinguishable, at the call site, from a broken provider or a slow one.

**This is why the hang deadline is load-bearing rather than defensive.** Until
2026-08-08 the 30-minute bound could not fire at all (`http.request`'s `timeout` is
socket-inactivity, and a streaming peer resets it), so an exhausted subscription simply
consumed the review — a t2 ran 2h46m. The deadline is what converts an invisible stall
into a bounded, reportable event, and D-48-widened is what keeps the review alive
afterwards.

**What "track it" has to mean, and what it cannot.** The number exists and is one cheap
call away — but that call needs the provider key, and lore deliberately holds none:
`auth.json` is mounted into opencode alone (D-24), so that a container holding the
knowledge base and the signing key cannot leak a provider credential.

`[OPEN]` — **whether lore may read the provider keys, read-only, for quota checks.** It
buys a 4-token call that returns exhausted/not plus an exact reset time, replacing a dead
45-minute attempt per review and letting the tier be skipped before anything is spent. It
costs a stated security property. Vany's, and not taken here.

Failing that, what lore CAN do is notice the shape — repeated timeouts from one provider
while other vendors answer in seconds — and say so rather than rediscovering it per
review.

`[OPEN]`, and the cost is measurable rather than theoretical: with t1 pointed at an
exhausted provider, every new review now spends **two dead attempts** before promoting —
at the 45-minute deadline that is 90 minutes of wall-clock per review to re-learn a fact
the service already had. Three things follow, and the third is Vany's:

- **Record the shape.** A tier whose calls time out repeatedly, while another vendor
  answers in seconds, is presumed out of quota. That is an inference, so it must be
  labelled as one wherever it is shown.
- **Cool off rather than re-probe.** Z.ai's Coding Plan is a **5-hour rolling window**
  (D-5/D-17), so exhaustion is temporary and self-healing. A service-wide cool-off on the
  tier — skip it immediately, re-probe once the window could plausibly have refilled — is
  what turns 90 minutes per review into one probe per window. Today `unavailable` is
  per-review state and every new review pays the discovery again.
- **Say it where an operator looks.** `/status` and the heartbeat know nothing about it;
  `make status` shows tier runs but not "this provider has answered nothing for an hour".
  A provider at its limit stops the gate every review must clear, which is the same class
  of fact as a stale mirror — and that one was `ok: true` for seventeen hours.

**Not built here**, because a cool-off changes which model is called and how much quota
burns, which is Vany's to decide (§9). What IS built is the part that keeps reviews
finishing: the deadline, and promotion to the next tier.

**D-85 — a tier on a metered plan skips rather than retries, and a failed call's tokens
are recorded.**

Two things follow from D-84, and both are built.

**`skip_if_quota`, optional, per tier, set on t1.** A tier carrying it is skipped on its
FIRST failure instead of spending a second attempt. A retry only pays for itself when the
fault might be transient, and an exhausted plan is not — Z.ai names the reset time in its
refusal, and that does not become untrue by asking again. Each attempt costs the full
deadline, so the retry was 45 minutes of wall-clock to re-learn a fact with a published
expiry date. t1 is the Coding Plan seat, which is why it is the one marked.

Absent means the previous behaviour — one retry, then promote — because for a metered API
a blip really is worth asking twice. It is deliberately **not** part of
`ladderFingerprint`: it changes neither which model is called nor how it is asked, so
pinning it would refuse every open review at the next config change. That is exactly what
adding `effort` to the pin did on 2026-08-08, killing a converging review.

**A failed call's tokens are recorded, and this changes what `usage` means.** Rows were
written only on success, so a failed call's spend was invisible while the provider counted
every token: two 45-minute attempts against the exhausted plan left the trailing-5h usage
reading **zero**. Any accounting built on that under-counts precisely when the provider is
at its limit, which is the one moment it must be right.

The session survives the failure and still carries per-message tokens, so the spend is read
back and written with `outcome: 'failed'` — so a reader cannot mistake recovered spend for
a completed review, and anything averaging latency or counting rounds can exclude it.

Two details that are load-bearing rather than incidental:

- **Attached to the error, not stored on the Reviewer.** An instance field is shared by
  every concurrent round, so with four calls in flight one review's spend would be
  recorded against another's — worse than not recording it at all.
- **Nothing spent reports absent, never a row of zeroes.** A zero row is indistinguishable
  from a call that ran and used nothing. And no dollar total is written: these are
  subscriptions, every message reports `cost: 0`, and a structurally-zero cost is the inert
  ceiling `/status` already warns about. Tokens and credits are the only units that mean
  anything here.

**The hang deadline is 2700s, and the number is measured.** It bounds a hang; if it sits
below a legitimate call it is not a detector but truncation — which 1800s was, since the
recorded maximum across every tier is 1851s. From `usage.latency_ms`: t1 n=129 max 1250s,
t2 n=68 max 1851s, t3 n=22 max 1766s. 2700s clears the observed maximum by 46%.

**D-48, widened — a tier that cannot ANSWER is skipped, not only one nobody can pay for.**

Vany: *"if a low tier is limited it's okay, just pass its work to a higher tier."*

D-48 already did that for `TierUnavailable`. It did not for a tier that simply never
answers, and from where it matters the two are the same event: the review is dead, and
the reason is not the client's to fix. A customer hit it — t1 cut at the deadline on both
attempts, the whole review failed, while two other vendors sat there able to read the
code. That repository's t1 has 54 recorded calls with a maximum of 1047s, so it was a
hang rather than slowness.

**Not on the first failure.** A provider blip deserves the cheap tier again, not
promotion to the dearer one; promotion spends the expensive quota, which is precisely why
it must not answer a transient fault. The trigger is the tier having already ended badly
once in THIS review, read from the `tier_run` rows already recorded rather than tracked
separately.

**It costs a vendor, and the result says so.** The outcome is `passed_partial`, the
`checks_skipped` entry names the tier, the error and the consequence — *"this review is
evidence from one fewer independent vendor"* — and the attestation cannot claim what did
not run. Independence is the ladder's premise (D-1); spending one to keep a review alive
is a trade, not a free win, and the label is what keeps it honest.

**The promoted tier is now told the truth.** `position()` counted the CONFIGURED index, so
a promoted t2 was told *"cheaper tiers found nothing new"* about a tier that never looked,
and t3 that *"2 independent reviewers from different vendors found nothing left"* when one
was skipped. That is not cosmetic: the entire purpose of telling a tier where it stands
(D-31/32) is to stop it re-deriving what the tiers below established — so a tier told the
easy defects are gone, when nobody looked for them, deliberately looks past exactly the
defects nobody has looked for. It counts tiers that can actually run.

**D-86 — a cancel stops both ends, and says so when it could not.**

Cancelling has two halves and lore was doing neither reliably.

**Telling opencode to stop does not free lore.** `session.prompt` is one long HTTP
request, and the server abandoning the model does nothing to it. Measured 2026-08-08:
three sessions aborted through opencode's API all answered 200, and ninety seconds later
`/status` still read `inFlight: 2` with **no active review at all** — provider slots held
for reviews that no longer existed, until each hit its 2700s deadline. `Reviewer` now
keeps an `AbortController` per session and passes its signal to the request, so `abort`
does both: opencode stops the model, lore stops waiting. Ours goes first because it is
instant and cannot fail, and a slow opencode must not hold a client's cancel open.

**A cancelled request is named as ours, not as the tier failing.** Everything downstream
treats a throw as the tier misbehaving — `runRound` closes the tier run `failed`,
`tierFailureCount` counts it, and one more count promotes that tier's work to a dearer
one. A cancel presenting as a tier failure would spend somebody else's quota answering
for a review a person deliberately ended. `longFetch` carries `AbortSignal.reason` for
the same reason: a cancel, an idle socket and a blown deadline all arrived at the caller
as the word *aborted*, and they lead three different places.

**`stopped_in_flight` is three-valued.** The deployed service could not abort anything at
all: `startHttp` was built with `store`, `worktreeFor`, `enqueue` and `attest` and **no
reviewer**, so `deps.reviewer?.cancel?.()` was `undefined ?? false` on every cancel it
ever served, and the reply told the client *"No model call was in flight"* while a
session opened seconds earlier ran on. `null` now means *this server could not look*,
distinct from `false` meaning *nothing was running*. INV-1 applies to a cancel exactly as
to a review. The wiring is fixed; `src/service/cancel-wiring.test.ts` fails without it,
because every other test in the suite built the server the same broken way production did
— so the defect was the only path under test.

**D-87 — the knowledge screen stops for the pass on a fault that belongs to the tier.**

The screen is one model call per changed document and it fails open, so a tier that could
not answer at all was asked again for every remaining document, each waiting out the full
hang deadline. On 2026-08-08 t1's plan was exhausted, six documents had changed, and a
review sat in the screen for 45 minutes per document — four and a half hours — and never
reached a tier at all. The answer was known after the first call and re-bought five more
times. `skip_if_quota` (D-85) did not help: it governs the ladder's retry, and the screen
runs before `openTierRun` and had never heard of it.

The split is between the TIER and the DOCUMENT. `TooLargeForTier` is about this
document's prompt — the next may be a tenth the size — so it does not condemn the pass.
**The result carries which it was**: `ran: false` said only *"nothing was screened"* and
meant both, so one oversized document ended the pass and marked a healthy tier unavailable
for an hour. `Screened.tierFault` is the distinction, and the background pass reads it.
An exhausted plan, a rejected key, an unreachable opencode or a hang are properties of
the tier, and none becomes untrue by asking about a different file.

Stopping costs nothing that was not already lost: the remaining documents are stamped
`unscreened`, which is exactly what one failure already did to the document it happened
on, and that stamp is what brings the next ingest back to do the work. Erring toward
stopping is the cheap direction — stopping wrongly costs one ingest's screening,
continuing wrongly costs the deadline per document before the review has begun.

**D-88 — a tier skipped below one that passed does not weaken the verdict.**

Vany: *"quota on t1 must allow to skip it and start t2. passing of t2 must make t1 not
needed."*

The ladder is a **gate** — dearer tiers only see code the cheaper ones already passed —
so whatever a skipped cheap tier would have read was read again above it. Its absence
made the review dearer, not less certain. Every skip used to force `passed_partial`,
which said the opposite.

| where the skipped tier sat | outcome |
|---|---|
| below the dearest tier that answered | does not prevent `passed` |
| at or above it | `passed_partial` — nothing read this code at that level |

D-49's sole-vendor rule is untouched and independent.

**The pivot is the dearest tier that ANSWERED, never the cursor**, because `runRound`
promotes a dead tier by calling `step` with nothing raised — so a tier that failed arrives
at the decision indistinguishable from one that came back clean, except for its entry in
`unavailable`. Reading the cursor would forgive the top tier's own failure and call the
review `passed` when nothing had read it at that level: INV-1 inverted, inside the change
that relaxes the rule.

**Every skipped tier is still disclosed on a `passed`.** What changed is which skips cost
the verdict, never which are named.

I argued against this and was overruled; both objections and the measurement behind them
are in `spec/review-ladder.md` §5.1.1, kept because they may age better than the decision.
The short form: §1 says the ladder is ordered by VENDOR and not by capability — K3 costs
3× GPT-5.6 Terra for two fewer points and is in the ladder only because it is a third
vendor — and t1 has raised 13 high-or-critical findings to t2's 3. Neither is decisive,
because the gate means t1 simply goes first.

**D-89 — the knowledge screen runs in the background.**

Vany: *"can we run it in the background?"*

The screen decides which extracted candidates are not rules (D-81). It ran inside
`runRound`, before the tier — so a model call that only decides *what the prompt looks
like* sat on the critical path of every review that touched a document, and a dead cheap
tier could wedge a review **before any tier had been asked anything**. On 2026-08-08 that
cost four and a half hours.

**The review never needed it, and production already proved that.** A screen that cannot
run keeps every candidate, stamps it `<version>-unscreened`, and those rows are LIVE.
When this was written, **27 of 181 live rules had never been screened** on a service that
had been reviewing for a week. Waiting decided only *when* the fragments left the prompt.

So the coupling is cut rather than tuned:

- **stays on the review path** — the deterministic extract. Free, and the review must see
  today's rules.
- **moves off** — the model call, to a pass on the retention sweep's hourly timer.

**It works from the ROWS, not from the repository.** The screen's whole input is a
document path and a list of statements, and the rows carry both — so the background pass
needs no worktree, no mirror, and no opinion about which branch is current. It judges
exactly the rows a reviewer would be handed.

Three things this changes in kind:

- **Unscreened is a QUEUE, not a fault.** `make status` said `✗ … UNSCREENED` in red;
  that is now the ordinary state after any document edit. Red for the ordinary state is
  how an operator learns to ignore a colour. What still deserves attention — and what no
  check inside the service can see — is a count that stops falling.
- **Quota is spent outside a review.** Same volume, since it only fires when a document
  changed, but at a time nobody requested. It queues at the same provider gate, so it
  cannot starve a review.
- **A background screen has no review**, so `review_cancel` cannot reach it, exactly as
  for `propose` and provisioning. It stops with the process.

**D-90 — a tier that stopped answering is not asked again.**

Vany: *"if t1 is skipped, it must not even initiate screen."*

D-89 took the screen off the review's critical path, which stopped it delaying anything —
and left it hanging for 45 minutes an hour against an exhausted plan, holding a quarter of
the provider gate to re-learn a fact already written down. A deadline bounds a wasted
call; **not making it costs nothing.**

The missing piece was that *this tier is dead* was known only inside one review's ladder.
`LadderState.unavailable` is per-review by construction, so every review and every pass
started ignorant. It is now a service-wide record in `meta`, surviving restarts, because a
process that forgot would go straight back to hanging.

**Learned, never inferred.** The mark is written when a call actually fails with a fault
belonging to the tier rather than the request (D-87's distinction), and deleted the moment
one succeeds. That is the only evidence available: opencode swallows the provider's
refusal (D-84), so there is no status code to read and no limit to retrieve — which is
what makes probing the wrong shape and a failed call the right one.

**The wait doubles, capped at a day.** A blip and an exhausted subscription want opposite
answers and are indistinguishable at the moment of failure. Doubling converges on either:
a blip costs one wasted hour, and a four-day outage costs 1+2+4+8+16+24+24… ≈ **seven**
wasted calls instead of ninety-six. The cap exists so a tier that recovered is noticed
within a day; the backlog it screens has no deadline at all.

**And it is visible, which it never was.** `spec/operations.md` §2.4.2 has listed "a
provider at its limit is invisible from inside the service" as a gap since it was written.
`make status` now says it above the reviews — because every slow review below is slow for
that one reason — and `/status` carries `tiers_not_being_asked`, present and empty when
healthy, since a key that vanishes when things are fine teaches a monitor to ignore its
absence.

**Scope — widened the same day, once D-91 made the distinction real.**

A review now also skips a tier in cool-off without calling it, but **only when the wait
came from a time the provider stated.** D-91 cut a dead tier from 2700s to a measured 41s;
41 seconds per review is still spent re-confirming a fact Z.ai stated once, with a date,
and *"wasting time is a crime"*.

The line is between a fact and an inference, and it is the whole of this decision:

- **a stated reset time** is the provider's claim about itself. It is true for every
  review at once, and re-learning it costs each of them a round's latency. A review may
  act on it, and may record it for the others.
- **our doubling backoff** is a guess. It stays local to the screen and to the review that
  earned it — `skip_if_quota` (D-85) already spends only one attempt — because imposing it
  across reviews would narrow one review's coverage using evidence it never saw.

**The row records WHICH IT IS, because for a while only the write side knew.** Both marks
go under the same `tier-unavailable:` key, and a review reading it could not tell a stated
time from a guess — so the rule above was honoured where marks are written and broken
where they are read. `stated` is now on the row and defaults to **false**, so a mark
written before the field existed bounds the screen and never a review.

A skipped tier is still disclosed: the `tier_run` row closes `unpayable`, `checks_skipped`
says *"was not asked"* and names when it will be retried, and D-88 decides whether the
verdict is weakened by where the tier sat. **"Not asked" must never be quieter than "asked
and failed"**, or the cheaper path becomes the less honest one.

**D-91 — subscribe to what opencode says; never wait out a clock for a fact it has
already published.**

Vany: *"flat cost is stupid, can we subscribe for finish or fail?"* and then *"wasting
time is a crime."*

**Extended 2026-08-13 with a bound on retries the classifier does not recognise.** Vany:
*"monitor the logs of opencode — if it starts retrying a lot, do not allow it to wait
more than 5 minutes; treat openai as down and go to the fallback."* `quotaRefusal` kills
a refusal it KNOWS in seconds — and openai's phrasing was unknown for three days, so
every t3 round rode a silent retry loop to the 2700s deadline while the narration
carried the refusal the whole time. The classifier learned those words the same day; the
5-minute storm bound is the backstop for the NEXT phrasing nobody has met. A session
whose retries are still arriving five minutes after they began is aborted as `Exhausted`
with no reset time — the type the fallback chain advances on, and an unstated time
becomes the doubling backoff rather than a fact nobody stated. The clock is cleared by
any non-retry status, and a storm that merely STOPS is left to the deadline: recovery
announces itself, silence is the deadline's to own.

**D-84 was wrong, and three days of work rested on it.** It said Z.ai names its limit and
its reset time and opencode swallows both. opencode swallows them **in the message body**
— which is where lore was looking — and publishes them verbatim on `/event`, keyed by
session. Measured 2026-08-09 against the live exhausted plan:

```
{"type":"session.status","properties":{"sessionID":"ses_…","status":{
   "type":"retry","attempt":1,
   "message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-10 18:19:09",
   "next":1786237732180}}}
```

The prompt went out at 01:08:45; that arrived by **01:08:52**, and four more inside ninety
seconds. lore was waiting **2700 seconds** for a fact that took seven.

`session.prompt` is one long HTTP request that says nothing until it returns. The
`Reviewer` now holds one subscription for the life of the process and routes
`session.status` by `sessionID` to the call in flight. A `retry` whose message is a quota
refusal aborts that call immediately — **with an `Exhausted` as the abort reason**, so the
error the round catches already carries the provider's words and its reset time, and every
consumer downstream (D-48's step-over, `skip_if_quota`, D-90's cool-off) needed no change.

Three things this corrects:

- **The 45-minute flat cost is gone.** A dead tier costs seconds. The 2700s deadline stays
  as the backstop for a stream that is down — it is now the exception, not the mechanism.
- **D-90 stops guessing.** Its doubling backoff was written believing nobody would ever
  tell us when the limit lifts. When the provider names a time, that time is used, clamped
  to [now+1min, now+7d]; the doubling is the fallback for a refusal that names none.
- **The credential question is closed.** I twice put it to Vany that reading provider keys
  would buy the reset time at the cost of a stated security property. It buys nothing
  lore cannot already hear.

**An ordinary `retry` is left alone.** opencode retrying a 500 is correct behaviour, and
killing the call on any retry would turn a recoverable blip into a stepped-over tier. Only
the message separates them, and it is the provider's own words.

**The reset time is read as UTC and the provider does not say which zone it means.** Z.ai
is a Beijing company, so this may be UTC+8 and lore may wait eight hours too long — the
safe direction, and self-correcting: the tier is retried after it, succeeds, and the mark
clears. Reading it the other way costs one more hang, which is the thing being removed.

**D-92 — t0 is not re-run on a tree it has already read, and its pattern engines are
pointed at the branch.**

Vany: *"why did we return to t0 after t1?"*, then *"call t0 only if diff was applied. and
only on this files."*

t0 runs at the head of every round so a fix that breaks the build is caught. A round that
follows an **escalation** rather than a submit reads a byte-identical tree, and t0 is
deterministic — that is the property that makes it t0. Measured across every t0 run ever
recorded: **18% of t0 time on rigid-monorepo and 26% on lore** went on re-reading a tree
already read in the same review. Nineteen minutes on one repository, four minutes at a
time, in front of a person waiting for a verdict.

The findings survive without being re-raised: they are recorded against the review and
stay open until something settles them (D-56), so re-running only re-raised the same
fingerprints for the deduplicator to drop. What does **not** survive by itself is
`unavailable` — an engine that could not run is a check nobody made — so it is carried
forward explicitly, and a test holds it there.

**And it is carried forward PER AUDIENCE.** `unavailable` has two versions: the client's
quotes the development rule an accepted appeal cited, the reviewer's says a check was
silenced and never what the rule says (D-83). Only the client's was ever stored, which was
harmless while every round recomputed both — and became a **standing prompt injection**
the moment a round could reuse a stored t0, because the reused text feeds `renderT0` and
`renderT0` is in every model prompt for every later round. One accepted appeal would have
put its rule into that repository's reviews for ever. `tier_run.unavailable_for_tier`
holds the reviewer's version. NULL there means **unknown**, and the round then re-runs the
engines rather than guessing — falling back to the client's list was the first attempt and
re-opened the hole it closed, because `lastT0` reads only t0 rows, so the only NULL it can
ever see is a pre-split row, which is exactly the kind whose client text can quote a rule.
An empty string is a recorded *nothing to tell the reviewer* and is used as it stands.
Not knowing what a reviewer was told is a reason to derive it again; the price is one t0
run on a review left open across a deploy.

**The pattern engines see the branch, not the repository.** semgrep and ast-grep match one
file at a time, so scanning a monorepo to review a ten-file branch is the same answer for
more money — and it drops the inherited matches in untouched code that D-68 already ranks
last and a team ends up justifying repeatedly. Beyond 200 paths it scans the tree instead:
an argv is not unbounded, and the fallback **widens** coverage, which is the only safe
direction for a bound nobody can see from outside.

**Deleted files are filtered out first.** A branch's diff names what it removed as well as
what it changed, those paths are not in the worktree, and semgrep treats a missing
scanning root as fatal — so one deleted file killed the whole semgrep run and surfaced as
*"semgrep produced unparseable output"*, which points at the wrong thing entirely. The
filter lives in `runT0`, the layer that holds the worktree; a caller computing a diff has
no reason to know which engines read the disk.

**`tsc` and `eslint` are NOT narrowed, and that is a refusal rather than an omission.**
Type checking is whole-program. Changing one exported signature breaks its callers, and
checking only the changed file is precisely how that class stops being caught — the class
a reviewer most wants from a type checker. They also run in the sandbox, where the cost is
the install and parsing the program, which a subset still pays through its imports. Asked
for *"only these files"* and this is the part I did not do; the reason is here so the next
person can overrule it deliberately.

`sbom` and `osv` are unnarrowed for a third reason: they are about the dependency
manifest, and the lockfile is usually not among a branch's changed files.

**D-93 — an exhausted subscription asks the same model somewhere with credit.**

Vany: *"we have some openrouter credits… if there is no quota on the subscription fallback
to openrouter."*

An exhausted plan used to cost the review that tier entirely: its work promoted to a
dearer one (D-48), the verdict labelled `passed_partial`, an independent vendor lost. But
the model is not gone — only that route to it — and opencode has OpenRouter configured
with a twin of every model in the deployed ladder:

**A POOL IS NOT A CHAIN — added 2026-08-12.** Vany: *"we have model definitions in a
configuration file like `{"GLM5.2": ["zai-coding-plan/glm-5.2", "zai-coding-plan2/glm-5.2"]}`,
and in tiers we use these identifiers. If there is more than one model under a nickname we
use a random one with quota; if all are empty we return that we have no model for this.
But `openrouter/...` is a dedicated fallback."*

A nickname is the MODEL; its list is the ROUTES that reach it. Two subscriptions to one
company are one reviewer available twice — the same opinion, twice the quota — and the
config could not say that before: `fallback` had to carry both *"the same model somewhere
else"* and *"something else entirely"*, with an entry's position the only hint which was
meant. The pool answers *"these are interchangeable, take one"*; the chain answers *"that
failed, try something worse"*. Both are walked the same way and only ever advanced by a
ROUTE fault; only the chain is reported as a concession, because a second plan is the
model the tier was always going to use.

**A route fault is quota — or a rejected credential (widened 2026-08-14, Vany: "okay,
dead, why not fall back?").** The OpenAI subscription's OAuth died mid-ladder: `opencode
returned 500: UnknownError: Token refresh failed: 401`, unmatched by every classifier
pattern, so a review that had cleared t1 and t2 failed 0.4 seconds into t3 with a healthy
OpenRouter twin configured and never asked — and the status line showed the provider
green, because only a classified refusal writes the mark it reads. Auth now classifies
(`ProviderAuthFailed`, the token-refresh shape included), parks the route under the
doubling backoff (no provider states when a credential heals; the D-94 probe discovers
the re-login), and walks the same chain quota walks. The one asymmetry is deliberate:
when NOTHING rescues the tier, quota takes D-48's quiet step-over, while auth keeps its
own type all the way to the worker — which pages, because quota heals on the provider's
clock and a credential heals only by a person.

**Optimistic to begin with, and it learns.** Vany: *"at the start assume all connections
have quota, and clarify if it is; and if it is not, what time of release when it rejects to
work."* A route nobody has seen refuse is believed good — nothing is inferred from a plan's
name or the calendar, so a fresh service asks and learns from the answer. A refusal writes
`route-unavailable:<model>` with the reset the provider named, and one success forgets it.

**Per ROUTE, because a per-tier mark cannot say it.** Two subscriptions behind one tier
have independent quota: `zai-coding-plan` can be dry while `zai-coding-plan2` is untouched,
and both are `t2`. Marking the tier would either strike out the plan that is fine or keep
asking the one that is empty.

**Any refusal parks the route until its `until` passes — revised the same day it shipped,
on Vany's correction.** The first version held D-90's tier rule at route level too: only a
provider-STATED reset could skip a call, a guessed backoff could not. The measured price
was two refused kimi calls per t2 round, every round, to learn nothing — the marks were
in the store and forbidden to act. Vany: *"I do not want a regular check for quota if
nothing happens."* So a route that refused is not asked again until its mark expires: the
provider's own date when it named one (clamped by `RESET_CAP_MS`), lore's doubling backoff
(1h → 24h cap) when it did not. **The recheck is the backoff expiring, not a schedule** —
the first round after `until` asks again, a success clears the mark, another refusal
doubles the wait.

**Why this may part from D-90, in one sentence:** skipping a TIER on a guess costs a whole
opinion, while skipping a ROUTE costs nothing while any twin or fallback answers — and
when nothing answers, the tier is skipped with a named comeback time, which is the same
outcome as calling every route and being refused by every route, minus the calls. D-90
stands unchanged at tier level, and D-94's probe outranks the parking: a probing round
exists to reach a provider we believe is down, so it is never filtered by that belief.

**And when every route is parked, the refusal names the earliest release.** That is what
*"we have no model for this"* should say to be worth reading: not only that nothing can run,
but when something can. Asking anyway would spend a call to be told again what we were
already told.

**The filter applies everywhere a route is about to be asked** — the primary (lone or
pooled), every pool twin, and every fallback entry — with one exception: a D-94 probing
round bypasses it entirely, because the probe is the mechanism by which lore learns a
provider recovered before its mark ran out. An earlier version scoped the filter to pools
only, reasoning that a lone route was the per-tier cool-off's business; that left the
lone-primary case (t2's kimi, exactly) re-confirming its refusal on every round, which is
the case the whole feature was asked about.

**A nickname must work everywhere a model id does, and every place it did not was found
by shipping it.** Six defects in the day after pools went live, all one family: some
consumer of `tier.model` received the pool's NAME. The background screen died every hour
(`model id 'GLM5.2' is not provider/model` — loud, bounded, four documents waiting); the
prompt budget read "no such model" as "no measurable window" and silently disabled the
fit-check; the proposer and its critic would have done the same, and the critic's vendor
comparison read the nickname as its own vendor — one company criticising itself wearing
two names. The fixes: one-shot callers resolve through `concreteRoute` (and say "no model
for this" out loud when every route is parked); the budget fits the SMALLEST twin in the
pool, because the prompt is built before the roll; the critic compares vendors of
resolved routes. Two guards came with them: a pool that mixes models is refused at load —
its routes are interchangeable by definition or the tier's identity means nothing — and a
synthetic "all routes parked" refusal never writes a tier cool-off, because *"the
provider said its limit resets then"* must not be written when no provider said anything.

**Random, and the reason outranks the choice.** Nothing publishes how much of a
subscription is left, so any policy cleverer than a coin toss would be guessing dressed as
arithmetic. **Chosen once and then kept** — Vany: *"if a model is chosen, use it; this rule
is only for the initial choosing."* Re-rolling every round would hand a kept session (D-80)
a different model to continue, which is a cold start wearing the configuration of a warm
one. The record IS `answeredBy`, so stickiness and the vendor count read the same fact.

**Sticky is a preference, not a blindfold.** The first version collapsed the pool to the
chosen route alone, which threw the feature away exactly when it was needed: once that
plan ran dry the review jumped to the metered fallback with the second subscription
untouched. The kept route goes first and the rest stay behind it.

**And `unpayable` now names every route, including the first.** The failure listed only
the fallbacks and leaned on the primary's own error text to identify the primary — which
works while that text comes from opencode and names the model, and stops working the
moment a pool chooses the route, because then nobody can tell which plan refused first.

**A LIST, TRIED IN ORDER — revised 2026-08-12.** Vany: *"let's use an array for fallback
in config; let's fall back on t2 and t3 to openrouter, and then, if there is no quota, to
zai-coding-plan/glm."*

| tier | subscription | fallbacks, in order |
|---|---|---|
| t1 | `zai-coding-plan/glm-5.2` | `openrouter/z-ai/glm-5.2` |
| t2 | `kimi-for-coding/k3` | `openrouter/moonshotai/kimi-k3`, then `zai-coding-plan/glm-4.7` |
| t3 | `openai/gpt-5.6-terra` | `openrouter/openai/gpt-5.6-terra`, then `zai-coding-plan/glm-4.7` |

**t1 moved off `glm-5-turbo` on 2026-08-12, and the reason is the window, not the price.**
Turbo advertises 200K of context, which `promptBudgetChars` turns into 280K characters of
prompt — and measured over 161 t1 rounds in the preceding week, **32 of them (20%) carried
a diff too large for it** and were compacted, which means one t1 round in five reviewed part
of the branch and was told so. Against `glm-5.2`'s 1M window, not one of those 161 would
have been cut. Both are the same flat subscription, so this buys nothing and costs nothing
in money; what it buys is t1 seeing the whole change. (The metered twin gets cheaper as a
side effect: `z-ai/glm-5.2` reads cache at $0.10/M against turbo's $0.24/M.)

**The last resort is `glm-5.2`, because it is the SUPER FALLBACK — Vany's word for what it
is for.** It is reached only when every other route to that tier is gone, so its job is to
be the best reader still available, not to add diversity to a ladder that has already lost
it. I argued for `glm-4.7` there, to keep a degraded ladder from becoming three tiers of
what t1 runs, and that was the wrong trade: it pays a CERTAIN cost — a 205K window, which
truncated 20% of t1's rounds when t1 lived on a window that size — against a RARE risk, in
the one situation where the alternative is no review of that tier at all.

**And it is not rare that it fires.** Measured the day it was configured: 36 of t2's 65
runs in 24 hours ended `unpayable` — kimi's plan out of quota and OpenRouter at $-0.04 —
so on more than half of t2's work the super fallback is the difference between a deep read
and nothing. What IS rare is the state that costs independence, which needs the openai plan
to go too.

**What that makes load-bearing is the check, not the choice.** Independence was decided
against `tier.model` — the model the CONFIG NAMES — which was sound for as long as every
fallback was the same model by another route: a kimi tier answered by kimi-through-OpenRouter
is still kimi's opinion. A chain ending at a different model breaks that equivalence, and
with this ladder a degraded review is one model asked three times while the tier list still
reads as three vendors. `passed` in that state is this product's central claim, false.

So `LadderState.answeredBy` records the model that actually answered a tier whenever it was
not the configured one, and `soleVendorOf` prefers it. A tier that ran on its own model
records nothing, so an ordinary review stores nothing and states written before this read
exactly as they did. This closes the `[OPEN]` raised above when the list was introduced.

**And it needed a second half, which the first half made necessary.** `vendorOf` read the
provider id, so ONE company reached under two names counted as two vendors:
`zai-coding-plan` and `z-ai` are both Z.AI, `kimi-for-coding` and `moonshotai` are both
Moonshot. That was harmless while only configured models were compared, because those names
never move. Feeding fallbacks in moved them — a tier falling back to its own OpenRouter twin
changes the string it contributes, so an all-Z.AI ladder whose t2 went through OpenRouter
would count two vendors and allow `passed`. `vendorOf` now folds a vendor's names onto one
through an explicit table.

**A table, not a heuristic**, and an unknown id stands for itself. Stripping a trailing
digit to match `zai-coding-plan2` would also fold `glm-5` into `glm`; inferring that two ids
are one company because they look alike is how a rule that must be exactly right becomes
approximately right. Standing for itself over-counts vendors, which is the safe direction
for a rule that gates `passed`. **A second subscription to the same company is the same
vendor** — `zai-coding-plan2` is in the table for that reason: it buys quota, not a second
opinion.

**Why one was not enough.** On 2026-08-11 OpenRouter ran to zero — $5165.00 granted
against $5165.04 used — and every deep tier's single twin was as out as the subscription
it was covering for. t2 went `unpayable` with a fallback configured, present and tried.
One metered account is a single point of failure for every tier at once, which is the one
shape a fallback list can fix and a single fallback cannot.

**The second entry changes what a fallback MEANS, and that is deliberate.** The first is
still the same model by another route. The last resort is a different model on a plan that
is still paying — spare capacity, not a twin. That is a weaker substitute and the right
one: a tier answered by a different model is still an independent read of the code, where
a tier that cannot run at all is nothing. What it costs is vendor accounting, and that is
`[OPEN]` below.

**This is the only path in lore that spends metered money**, so the bounds stay narrow and
tested. It fires on `Exhausted` **alone** — a tier that returned garbage, or whose window
could not hold the diff, will do the same through any provider, and retrying those buys the
same failure for real money. The chain steps forward on quota and stops on everything else.
Bounded by the list, which is short and written down: the old note said "no fallback for
the fallback, because a chain of retries is how a bounded cost becomes an unbounded one",
and that objection is about retrying the SAME route — it does not reach a second one named
in the config. A route may not appear twice, and may not name its own tier's model;
`loadTiers` refuses both, because the chain is only ever walked when a provider has said
quota and the same route can only say it again.

**The vendor count follows the model that ANSWERED — closed 2026-08-12, same day it was
raised.** `soleVendorOf` read `tier.model` at load, so a review whose t2 was answered by
`zai-coding-plan/glm-5.2` while t1 ran on the same plan was two vendors wearing three names,
and D-49's rule could not see it. Before the list, every fallback was the same model at a
different provider and the configured vendor was always right about independence; a
cross-model last resort is what made it wrong. It stayed open for as long as it was
theoretical — about an hour, until the deployed ladder's last resort became the model t1
runs, at which point the degraded path was the normal one. `LadderState.answeredBy` now
carries it into the verdict.

**Priced before it was built, against a real day.** Nine reviews of this repository, at
OpenRouter's published rates: **$3.80** for the lot — t2's 6.9M cached-read tokens are
$3.63 of it — on the metered route, which is the only way this deployment pays anything.

**The ceiling this was priced against is gone (D-121), and the estimate above is exactly
why a total was the wrong guard.** $3.80 for nine reviews is 25× headroom, right up until a
subscription dies and the same nine reviews are billed on the fallback — which on
2026-08-16 was $101.36 in three and a half hours. The number that decides is not a total
against a budget; it is whether the route about to be called charges at all (D-117).

**The fallback is verified at startup**, because a fallback is a promise about what happens
when a subscription runs out, and the moment it is configured nobody worries about that
case again. A promise that cannot be kept is worse than none: it fails at the worst moment,
looks like the provider being down, and gets diagnosed as anything but a typo in a tiers
file. Not fatal — a ladder without a fallback is the one lore ran for its whole life — so
it tickets, names the model, and starts.

**D-94 — a cooled-off tier is asked again every fifteen minutes.**

Vany: *"our z.ai subscription is unfrozen, did lore realize this?"* It had not, and could
not: the mark said *until 18:19:09* and it was 16:58.

**lore could hear a tier DIE and had no way to hear one RECOVER.** The refusal arrives on
the event stream within seconds (D-91); nothing carried the opposite news. A subscription
that came back **81 minutes early** went on being skipped for all 81, paying a metered
provider throughout — measured: $1.45 in the eight minutes before it was cleared by hand.

**The trade that justified "do not even initiate" has inverted.** When D-90 was written,
asking a dead tier cost the full 2700s deadline, so skipping was obviously right. D-91
made that same question cost about **twelve seconds**, and D-93 made the alternative a
metered call that has cost as much as **$4.94**. Twelve seconds to maybe save a dollar is
worth taking.

So a review honours a cool-off, but asks once per `PROBE_INTERVAL_MS` (15 minutes)
regardless. The probe is **not special-cased** — it is the ordinary call, so a live tier
simply works and a dead one falls through the existing fallback path unchanged. The stamp
is written BEFORE the call, so a tier that hangs is not probed again by every review that
starts while it hangs.

**The stamp survives a rewrite of the mark, and the interval is nothing without that.**
A probe that is refused writes the refusal — and the write is `markTierUnavailable`,
which erased the stamp it had made seconds earlier, so `shouldProbe` read *never probed*
and the next review probed at once. The rate limit was void wherever a fallback was
configured, which is every deployed tier, while every test still passed. An update that
does not name a `probedAt` therefore keeps the one already stored; only a real call names
a new time, and `clearTierUnavailable` is what forgets. Deliberately in the store rather
than at the call sites: one of them is reached by the cool-off's own synthetic
`Exhausted`, where no provider was asked at all, and a site stamping `now` there would
push the probe forward for a call that never happened — never probing at all under steady
load, which is the same failure wearing the opposite mask. Raised against the D-94 commit
by lore's own t1.

**And one success now clears the mark**, which the operator banner has promised since D-90
shipped while only the background screen delivered it: a review could prove a tier alive
and the mark stood until its clock ran out.

**The background screen still never probes.** It has no urgency and no deadline — its
backlog can wait — so the strict reading of *"if t1 is skipped, it must not even initiate"*
stays exactly where it was asked for. Only the path a person is waiting on, and that spends
metered money, buys information with twelve seconds.

Vany, after a day of it: *"we fix bugs in this project immediately."*

**The evidence is that deferral here has a specific, repeating cost: the note goes
stale in the direction that hurts.** Not "we forget" — we write it down carefully, and
then the world moves and the note stays still.

- The replica monitor was recorded at 19:00 on 2026-08-07 as *"cries wolf again,
  recorded not fixed"*, with a full diagnosis. Thirty minutes later the database was
  unreadable and `/status` was answering `ok: false` **for that wrong reason**, pointing
  an operator at a healthy replicator during the twenty minutes the product was dying.
  The note did not merely fail to help; the defect it described did the harm.
- *"lore's whole footprint is under 5 GB"* was written into a comment as a settled fact
  while deleting the check that measured it. It was 6.8 GB two days later, and nothing
  noticed, because the only thing watching had gone with the thing it was wrong about.
  The lesson is about the SENTENCE, not the check: a measured number written down as a
  standing fact rots from the moment it is written. The check that was built in answer to
  it is itself gone now (2026-08-12) on a different argument — that disk here is not
  lore's to alert on at all — and this entry survives it, because "do not record a
  measurement as a permanent property" is true whether or not anything is watching.
- Twenty-eight SQL sites sat behind *"should not be done in code that has no ladder
  verdict"* — reasonable, and it meant the client-facing shape of `lore://review/{id}`
  stayed a function of the schema while `review.token_hash` was added one join away.
- Four `tier_run` rows claimed a tier had been reading for forty-six hours. Nothing
  alerted; the question *"what is reviewing now?"* found them.

**So the default inverts.** A defect is fixed in the change that finds it. Writing it
into `TODO.md` instead is a decision that has to be argued, and the argument has to say
what makes waiting cheaper than fixing — not merely that fixing is inconvenient now.

**Three things this does NOT mean**, because each is a different owner or a different
question, and calling them deferral would be wrong:

- **Anything changing which model is called, or how much quota it burns, is still
  Vany's** and waits for him. That is not a delay, it is the person who pays deciding.
  The per-tier round bound has now killed two converging reviews and still waits, and
  should.
- **Measure-first still means measure first.** D-39 said to count the conflicts before
  automating them; the count was one, and it was a known false positive, so the honest
  outcome was to record the number and not build. Refusing to build on evidence is not
  the same as postponing.
- **A defect in someone else's repository is theirs** (D-71). We report it.

**And ONE BIG DIFF IS BETTER THAN MANY SMALL ONES, which is not the trade-off it first
looked like.** I wrote this the other way round and Vany corrected it; the arithmetic
says he is right, and by a wide margin.

**The ladder reads a TREE, not a diff.** A round costs a full t0 sweep, a document
re-ingest, and one model call at the current tier — measured 2026-08-07: t1 averages
441s, t2 766s, t3 245s. Almost none of that scales with how many commits are in front of
it. So the unit of cost is the ROUND, and the unit of value is the CHANGE, and batching
moves one without moving the other. Fourteen commits reached `passed` in three reviews.
Reviewed one at a time they would have been fourteen, each paying for its own t0, its own
ingest, and its own climb from t1 — four to five times the model time for a strictly
weaker result.

**Weaker, because findings interact.** t3's last pass on that batch produced a chain: a
concurrent-ingest race, a session the cancel could not reach, the provider-gate window
one layer earlier, and then the worker writing `failed` over the `cancelled` that the
third fix had just made reachable. Each is invisible with the others absent. A reviewer
shown one commit at a time sees four unrelated small things, at best.

**The real limit on a big diff is the context window, not the review process** — and it
is now handled: a prompt a tier cannot hold makes that tier `TooLargeForTier`, so the
ladder steps over it and finishes `passed_partial` rather than failing the review (D-48).
That is what turns "too big" from a wall into a degradation.

D-77 still holds and nothing skips the ladder. What changes is that batching is the
DEFAULT rather than a compromise: fix everything found, review it together, push it
together.

**D-116 — an over-long claim folds; it never costs the finding either. BUILT 2026-08-16.**

D-115 fixed `severity` and wrote the rule beside it: *validation at the reviewer boundary
must not be able to lose a finding*. `claim` was the other instance of that rule and was
not fixed with it. Eleven minutes before D-115 was committed, review
`rev_dCU6W98KgCZiwIXtnHtWeq-x` lost a t2 finding on `reversal-apply.ts:514` — a ledger read
ordered before a local bound check — to `claim: Too big: expected string to have <=500
characters`, in the same review where two t3 findings were lost to the severity word.
Three real findings, one review, one rule, one field behind.

Raising the cap is what the last three occurrences did (300 → 500, D-64) and it does not
converge: the retry does not shorten reliably — a model told the exact rule cut 44
characters and still missed by 14 — so every raise buys time until someone writes a longer
sentence. This one overshot by well over a hundred characters, not by a clause.

Truncating alone is worse, and was itself the bug D-64 found in `t0/engines.ts` and
`security/osv.ts`: *a claim silently cut mid-clause is a finding that says something its
author did not*. So the fold is neither. **The full claim is carried into `evidence`
verbatim, and what remains in `claim` is cut at a word boundary and marked with an
ellipsis** — nothing is lost and nothing is silent. `CLAIM_MAX` is unchanged and the prompt
still asks for one sentence; this governs only what happens when a model does not comply.

One case is lossy and is asserted as such: `claim` and `evidence` share `TEXT_MAX`, so a
claim longer than the entire evidence budget cannot be carried whole *and* leave the
original evidence intact. The claim wins, because it is the field that was about to cost
the finding, and the clamp is marked.

**`evidence` and `failureScenario` are clamped by the same change, because fixing the
third instance one field at a time is how the first two came to exist.** Both had the
identical `.max(TEXT_MAX)` refusal, and a refusal on any one field discards the whole
finding. This clamp is lossy at the tail and cannot not be — `claim` had somewhere to go,
`evidence` has nowhere, and carrying it into `failureScenario` would move the problem one
field along while corrupting a field that means something else. The tail is cut and
MARKED, which is the whole difference from the silent truncation D-64 condemns. A small
visible loss beats a total silent one, and the model has been paid either way.

**Two of the three remaining refusals are now REPAIRS, and each repair says so.** A `line`
that cannot be a line and a malformed `cwe` are dropped rather than costing the finding:
the line degrades it to file-level, which the schema already supports, and the CWE is a
taxonomy field most findings do not carry at all. Both were justified as drift detectors,
and the objection to them was that they detected drift *by discarding the report* — the
trade D-115 and D-116 reversed twice before this.

**The channel is `evidence`, following the precedent `foldOverlongClaim` set with
`Claim in full:`.** No new field to keep in sync, no plumbing through the round, and it
lands in front of every reader at once: the client polling it, the operator board, and the
next tier — which is the one that can judge whether the drift matters. `checks_skipped`
carries LOSSES; this carries REPAIRS, and a repair is part of the finding rather than a
fact about the round.

`[OPEN]` — **`.strict()` on unknown keys is deliberately left alone**, and it is the one
refusal that can still cost a whole report. It is the strongest drift signal the schema
has: an unknown key means the prompt and the contract have parted company, which is a
larger fact than any single finding. The same repair would work — drop the keys, say so in
`evidence` — and reversing the strongest of the three is a decision rather than an obvious
repair, so it is written down rather than taken quietly alongside the two that are not in
doubt.

**D-115 — a severity nobody planned for maps; it never costs the finding.
BUILT 2026-08-16.**

`severity` was `z.enum(["high","medium","low"])`, and Zod rejects the whole object on one
bad field — so a model that wrote `critical` had its entire finding discarded at the door.
Measured on this repository: t1 raised a `critical` finding about an unbounded round loop,
the parse failed, and what reached the client was a `checks_skipped` line saying a finding
existed and could not be shown. Honest, and still **a review that found something and said
nothing**, which is INV-1 in its purest form. It only surfaced at all because the model
re-raised the same defect at a permitted severity on its next emission; nothing guarantees
that.

The scale stays three (D-50) and is not up for renegotiation — a model reaching for a
fourth word is expressing urgency, not proposing a taxonomy. So the word is mapped and the
finding survives: the obvious synonyms go where they belong, and **anything unrecognised
becomes `high`**, because an unplanned severity points at escalation far more often than
at a nit, and `severityRank` already ranks an unknown value first for exactly that reason.
A severity that is not a string at all is still refused — that is a malformed report, not
an unfamiliar word.

The general rule this is an instance of: **validation at the reviewer boundary must not be
able to lose a finding.** Refusing input protects the store; here it was discarding the
product.

**D-114 — the round bounds count ARGUING, not WORKING. BUILT 2026-08-16.**

`perTierRounds: 3` and `globalRounds: 12` counted a review's whole life. That is right for
a gate on a snapshot and wrong for the incremental review D-112 opened up: a review that
follows the work accumulates rounds *because someone keeps feeding it*, so a developer
using it as intended would be stopped at twelve **for succeeding**, with `stopped` — a
non-verdict that reads as failure.

So both counters restart when the CLIENT delivers work — a submitted diff, or a
`pull_fresh` onto commits that genuinely moved (`clientDeliveredWork`). New work is new
material, not the same argument continuing.

**WORK MEANS THE TREE MOVED, and the distinction is a whole ladder.** `applyPatch` no-ops
on an empty diff, its tree hash still verifies, and lore's own texts tell a client with
nothing to change to submit an empty diff — so a reset on *any* verified submit is an
unbounded loop that a compliant agent walks into, each nudge wiping the counters, pushing
`updated_at` past the stale sweep and buying t0 plus a model tier on the shared
subscriptions. The callers therefore test the tree (`applied !== before`, the same test
`pull_fresh` already makes), never the call.

**And exactly one writer touches the ladder per round.** A held diff is submitted *while a
round is in flight, by definition*, and that round writes its own ladder at the end from
the snapshot it took at the start — so a reset written at submit time lived one round and
vanished. D-114 then held for a client that waited for a quiet moment and failed for one
that followed the documented "submit any time" cadence, which is backwards. The round
applies the reset itself, at the emission boundary where the diff lands and the tree is
observed to move.

**Termination is untouched, and that is the whole justification.** The property the bounds
guarantee is *"a ladder arguing with itself stops"*, and that is preserved exactly: with no
new input the floor stops moving and the budget runs out in the same number of rounds it
always did. What a client can now do is extend a review indefinitely by continuing to
submit — which is not a runaway, it is the feature. `round` itself is never rewound: it
numbers `tier_run` rows, and two rounds sharing a number would corrupt the one table that
exists to say whether a review really ran.

**The other two things D-112 was thought to break turn out not to be, and saying so is the
decision** (2026-08-16). Both were listed as needing answers before the incremental loop
opened up; the answer in each case is that the existing behaviour is right, for a reason
worth writing down rather than a mechanism worth building.

* **Admission's 128 is not measuring the wrong thing.** It counts open reviews including
  parked ones, deliberately — a review in `findings_ready` holds a pinned worktree and
  becomes work again on the next submit, so it occupies the service whether or not anyone
  is currently thinking about it. Longer-lived reviews raise the count, which is exactly
  what a bound is for. The busiest day this service has had held about a dozen; 128 is
  far above traffic by design, and it is not a throughput knob.
  The real gap is fairness, not arithmetic: **the limit is global, so one principal can
  consume every slot and lock out colleagues.** Not built, because with this workgroup's
  volume it cannot fire — the trigger to build it is the first refusal caused by somebody
  else's reviews, and the refusal message already names `review_cancel` as the remedy.
* **Staleness reaping tells the two apart correctly.** `findings_stale` at 48h and
  abandonment a week later are judged by time since the review last moved, and an
  incremental review that is being FED moves on every submit and every `pull_fresh`. A
  review nobody has touched for nine days is abandoned by any definition D-112 offers,
  and the sweep is what keeps INV-1 honest about it — `expired` never means "found
  nothing", which is precisely why it must eventually fire.

**D-113 — a review's change-set is PINNED, and an empty one is a failure, not a pass.
BUILT 2026-08-16.**

Found by driving lore, not by reading it. `computeDiff` measured every round from
`merge-base(intoRef, HEAD)`, and `intoRef` is a branch NAME re-resolved on each round. So
the question "what is this a review of" was re-answered continuously against a moving
target, and the answer could reach *nothing at all*:

> when the base branch advances to CONTAIN the branch under review, `merge-base` returns
> HEAD itself, and `git diff HEAD` from a worktree at HEAD is empty.

Every tier is then shown an empty diff. A tier shown nothing raises nothing, and the merge
cannot distinguish that from a tier that looked and was satisfied — so the ladder settles
on the silence and can return **`passed` over a diff of zero bytes**. INV-1's failure in
its most complete form, reached without any component malfunctioning.

**This is not a corner case; it is the ordinary end of every branch.** A branch that
merges triggers it. So does D-77's own batch gate, whose commits reach `origin/main`
before the ladder has ruled — which is how it was found, on lore's own batch review,
sitting in `findings_ready` looking ready to continue.

**Two changes, and the second is the one that must never be removed:**

1. **`review.base_commit`** (schema 19) holds the commit the change-set is measured from,
   resolved at PIN time and only at pin time — the first round, and every `pull_fresh`. A
   pin is the one moment the client has said *"this is my branch now"*, which is exactly
   when the question may be re-answered: a developer who merged the base into their branch
   to catch up gets a base that accounts for it, instead of a frozen one that would report
   all of the base's commits as their work. Between pins nothing moves. A NULL — every row
   written before this — recomputes exactly as before, because back-filling a base for a
   review already in flight would silently redefine what it is attesting to. A pinned sha
   that no longer resolves falls back to the live merge-base rather than failing the diff.

2. **A round whose change-set is empty FAILS, with a reason.** The pin makes the collapse
   rare; it does not make it impossible, and a guard that only usually fires is the shape
   this project exists to refuse. `failed_because` names both ways to arrive — the branch
   is already merged, or the review was pinned against a base that already contains it —
   because the remedy differs and neither is guessable from the outside.

`mergesClean`, `behindBy` and the overlap analysis still ask about `into` **as it stands
now**. Pinning is about what is MEASURED, not about pretending the base stopped moving;
staleness is one of the few things a reviewer can act on. Overlap in particular must use
the LIVE merge-base: computed from the pin it degenerates precisely where D-113 matters,
because once `into` contains the branch, `diff(pin, into)` covers the branch's own
change-set and every file it touched is reported as changed by both sides — sending a deep
tier to hunt for conflicts between the branch and its own merged work, every round.

**A pin outlives the ref it was cut from.** The base-ref existence check runs only when
there is no usable pin, because the batch procedure above *guarantees* the ref will vanish:
both scratch refs are deleted as documented cleanup and the mirror's `fetch --prune` drops
them within five minutes, while the review stays open for days. With a resolving pin the
missing ref means the staleness questions cannot be asked — `behindBy: 0`,
`mergesClean: undefined`, no overlap — not that the review is dead.

**D-112 makes this urgent rather than tidy.** A review that follows the work is a review
that outlives its branch's merge, so the collapse stops being an edge and becomes the
expected end of every long-lived review.

**D-112 — the review is INCREMENTAL and CHECKPOINTED: it follows the work instead of
gating a snapshot. Framing built 2026-08-16; checkpoint verdicts `[OPEN]`.**

Vany: *"my idea was incremental reviews. We create an initial review, then the user sends
us updates and we add them to the review we partially did, then the user fixes findings
and sends a new update, and then new updates — maybe even while we are in the middle of
reviewing exactly this piece of code. And the user sends not only findings-fixes, it sends
its WORK, and we see the full story and review it. Because the review is incremental we do
not need to spend a lot of effort reading a lot of the code — it is already in cache and
we know something about it, so incremental review is cheap."*

**MOST OF THIS IS ALREADY BUILT, and saying so is the useful part.** D-80 keeps one
session per (review, tier) for the whole review, compacted rather than restarted. D-107
hands a submitted diff to that live session at its next emission boundary — mid-round, no
waiting, no reset. D-108 makes every way the tree advances look identical to the model: a
`treeDelta` between what that session last saw and what is there now, plus a t0 delta,
never a re-read. The expensive thing this idea exists to avoid — a tier re-orienting in a
worktree it read minutes ago, measured at 31.6 turns and 29% of all model rounds — is
already gone.

**The cheapness is real and DECAYS, which is the part to design around rather than
assume.** A kept session re-sends accumulated context every turn against a 97–99% prompt
cache, so marginal turns are cheap. But the session compacts at 2/3 of the window and
compaction discards REASONING to keep code. So "it already knows this codebase" holds for
hours and then quietly stops: a review living for days is not a reviewer with days of
memory, it is one with the last two thirds of a window and a summary. Nothing measures
that boundary today.

**WHAT IS ACTUALLY NEW, and what this decision adds:**

*A submit carries WORK, not only answers.* `review_submit` is framed as "your fixes" and
the settle logic is built around findings being answered. A client pushing ordinary
development — a feature, a refactor, half-finished thinking — is carried by the machinery
unchanged and contradicted by every text describing it. That is a framing defect, not an
engine one, and it is fixed in the texts (D-111's push-then-`pull_fresh` is already the
cheapest way to send work, since it needs no diff at all).

*The reviewer reads the STORY, not the endpoint.* This is the half worth the most and it
falls out of D-108 for free: a session that receives deltas sees the sequence — a fix that
was wrong and then patched, a decision made and reversed, a workaround that outlived its
cause. Reviewing an evolution is strictly more information than reviewing a tree, and no
snapshot review can see it.

**THE HARD PART, and it must be settled BEFORE the loop is opened up: what does `passed`
mean when the tree never stops moving?** D-40 says a signature covers a TREE; INV-1 says a
review that did not run is not a review that found nothing. A review that accretes for
ever produces no signed statement about anything — it becomes a companion rather than a
gate, and the thing a person would merge on does not exist.

**So: CHECKPOINTS.** `[OPEN]`. The review stays open, warm and incremental; on request it
settles what it has read and signs THAT — *"as of tree X, these tiers read it and
agreed"* — and then carries on from the same sessions. One conversation, periodic
verdicts. The alternative considered and rejected is closing and reopening a review per
checkpoint, which throws away the warm session that is the entire point.

Three things it collides with, all of which need answers first:

- **The per-tier round bound** (default 3) fires on any long-lived review. TODO already
  carries this as *"doing its job, and it is the wrong instrument"* — an incremental
  review makes that urgent rather than theoretical.
- **Admission.** 128 open reviews is a very different number if reviews never end, and a
  permanent review permanently holds a worktree, a slot, and N kept sessions.
- **Staleness.** `findings_stale` at 48h and expiry a week later exist to reap abandoned
  reviews. An incremental review is indistinguishable from an abandoned one by the only
  signal those use — time since anything moved.

**What must NOT bend:** a checkpoint is a claim about a TREE, made by the tiers that
actually read that tree. Incremental delivery changes WHEN the ladder runs and what the
model already knows; it changes nothing about what a verdict may assert.

**D-111 — the client loop's own defects, found by DRIVING it. Two built 2026-08-15, a
third (D-133) 2026-08-29, one `[OPEN]`.**

Vany: *"is it convenient to use our service right now, or do you have good ideas how to
improve user experience?"* Answered from a day spent as the client rather than reading the
code, which is the only way most of this is visible. Full list and costs: `BUGS.md`.

**1. A DIFF SHOULD NOT CROSS THE WIRE AT ALL. (documented 2026-08-15; the mechanism
already existed.)** A unified diff is whitespace-significant — a context line for a blank
source line is a single space — and a tool-call argument strips it. Verified directly:
writing `"a\n \nb\n"` through one produced `"a\n\nb\n"`. So an agent composing a diff
into `review_submit` corrupts it, silently, every time, and cannot tell. `git apply
--recount` happens to forgive that particular loss, which is luck rather than design.

The deeper cost is that ~40 KB must be RETYPED with no way to verify before sending. The
answer is not a better encoding: it is that **`pull_fresh` already does this without a
diff**. The client pushes; lore re-pins the same review to origin's new tip; findings,
justifications and the ladder all carry. Nothing whitespace-significant crosses the wire
and the tree hash comes from git rather than from a claim. `TOOL_DOCS.submit` now leads
with push-then-`pull_fresh` and keeps `review_submit` for clients that genuinely cannot
push — no remote, no credentials, work not wanted in history yet.

**2. `will_not_settle` WITHHELD THE ID ITS OWN INSTRUCTION NEEDED. (built 2026-08-15.)**
It said *"say so at the named line with a `lore-ok[<fingerprint>]`"* and returned `file`,
`line` and `claim` — no fingerprint. The instruction was unfollowable: a poll returns only
NEW findings, so the ids it names are exactly the ones the client will never be shown
again. Driving the loop by hand, the only recovery was a SQL query inside the container,
which no client can run on a machine it is not on. It now carries `fingerprint` and a
ready-to-paste `justify_with`.

**3. BUILT — see D-133.** A FIX HAS NO WAY TO SAY WHERE IT WENT. D-56 settles a finding
only when the code AT THE NAMED LINE moved, and the right fix is routinely elsewhere: a
caller, a writer that never existed, a shared predicate. The protocol's answer is a
`lore-ok` at the original line explaining the fix is elsewhere — which works and costs a
full deep round each time. The `pull_fresh` seam took FOUR rounds this way, each a
genuine defect, each correctly raised. `fixed_elsewhere` on `review_submit` — naming the
finding and where it went, ruled on like any justification — collapses that. D-10's
boundary held: the reviewer still ratifies or rejects it, exactly as a comment-form
justification does, so this widens the CHANNEL a client may assert through, not what its
assertion is worth.

**4. `[OPEN]` — THE PARAPHRASE TAX, and §3.1.1's evidence has now arrived.** The same
defect arrives twice under two fingerprints when a tier rewords its claim between rounds,
and each needs its own marker: `49451a88`/`d9ec8874` were one defect, and the second's own
text says *"the same finding, reported twice"*. §3.1.1 deferred a similarity key
(`file ‖ symbol ‖ cwe`) "for want of evidence that paraphrase-churn actually happens".
Twice in one review, on 2026-08-15, is that evidence.

**What is NOT wrong, recorded because a defect list read alone is misleading:**
`check_back_after_ms`, measured from this repository's own completed rounds and shrinking
as a round ages, was trusted all day and was right. The operator board answers "what is
happening" at a glance. And the findings themselves were consistently correct — including
three defects in fixes shipped hours earlier, which is the product working exactly as
designed.

**D-77 REVISED, 2026-08-15 — the gate is a BATCH gate, and this is written down rather
than practised silently.**

D-77 said nothing reaches `origin/main` that a ladder has not read. On 2026-08-15 that was
overridden five times in one day, each override recorded in its own commit. Vany, asked
whether to restore the gate or relax it: *"keep overriding, review in batches."*

So the rule changes rather than continuing to be broken. **A commit may reach
`origin/main` unreviewed; a BATCH may not go unreviewed indefinitely.** The review is
deferred, not waived, and the deferral is stated in the commit that carries it — as
`e8db997` does — so the history never claims a verdict it does not have.

**What was traded, stated plainly, because the day produced the evidence both ways.**
Against: on this same day the ladder read four commits and found three defects in fixes
shipped hours earlier — a write guarded without its read, a bound granted per call
instead of per round, a check placed above the one it must follow. Every one passed its
tests and looked right to me. Batching means defects of that shape live in `main` for
however long the batch runs. For: the loop costs 25–50 minutes per round and several
rounds per change, which on a day of small corrections is most of the day, and a gate
expensive enough to be skipped is not a gate — it is a ritual with an override.

**What does NOT change, and is the whole reason this is a revision rather than a
repeal:** INV-1 still governs what a review MEANS. A batch review that fails is a failure;
a tier that could not run is not a tier that found nothing; and `passed` still requires
that every tier actually read the tree it is signing. Relaxing WHEN the ladder runs does
not relax what its verdict claims.

`[OPEN]` — what bounds a batch. Nothing yet says how many commits or how many days may
accumulate before a review is owed, and "in batches" without a bound is "eventually",
which is how the debt got to five in the first place.

**D-110 — how a client LEARNS a review moved: two surfaces built, and a third that is
the right shape and cannot be built yet. `[OPEN]`, gated on the SDK — 2026-08-16.**

Vany: *"let's investigate how these Anthropic channels work, can we use them instead of
subscriptions? if yes, let's add this into methods of receiving findings and review
state… so we will have resource subscriptions, channels, and polling if there is no
working async method. The model has to choose what the harness is supporting."*

**"Channels" is not an MCP primitive, and that part was never in doubt.** In the current
wire revision (2026-07-28) the server-to-client push surface is `subscriptions/listen` — a
single long-lived stream a client opts into per notification type, replacing both the HTTP
GET endpoint and `resources/subscribe`/`resources/unsubscribe`. **lore already implements
it**: the server declares `resources: { subscribe: true }` (the declared bit is what makes
the SDK honour a listener's filter at all), and wakes every subscriber with
`notifications/resources/updated` on each state change (D-80, D-103). There was never
anything to adopt INSTEAD of subscriptions — the thing the question reached for is the
thing we have.

**What is built, and stays the client's choice:**

| surface | state | what it is for |
|---|---|---|
| `subscriptions/listen` | BUILT (D-80) | a harness that can hold a stream; woken on state change |
| `review_poll` | BUILT | the floor — always works, needs nothing from the harness |

**Polling is the FLOOR and must stay that way.** Every other surface is an optimisation
over it, and a client that supports none of them must still be able to complete a review.
That is not a fallback in the apologetic sense: it is the only surface that cannot be
taken away by a harness limitation, and INV-1's reasoning applies — a delivery mechanism
that silently does not work is indistinguishable from a review that found nothing.

**The MCP Tasks extension is the right shape for what lore is, and the fit is close
enough to be uncomfortable.** 2026-07-28 moved tasks out of the experimental core into an
official extension, `io.modelcontextprotocol/tasks` (SEP-2663, specified at
`github.com/modelcontextprotocol/ext-tasks`). The redesign drops the blocking
`tasks/result` and `tasks/list`, keeps polling via `tasks/get`, and **adds `tasks/update`
for client-to-server input into a running task**. Status pushes exist as
`notifications/tasks`, opted into through `subscriptions/listen` and carrying the whole
task state, so a client that can hold a stream needs no `tasks/get` round-trip at all.

Every bespoke tool lore has is a spelling of something this extension already names:

| lore | Tasks extension |
|---|---|
| `review_start` returns an id immediately | `CreateTaskResult`, `resultType: "task"`, `taskId` |
| `review_poll` | `tasks/get` |
| `check_back_after_ms` | `pollIntervalMs` |
| review expiry (`findings_stale`, then abandoned) | `ttlMs` |
| `review_submit` — the client sends WORK into a running review (D-112) | `tasks/update` with `inputResponses` |
| `needs_human` — the ladder stops and waits for a person | status `input_required` with `inputRequests` |
| `review_cancel` | `tasks/cancel` (cooperative, same as ours) |
| `queued`/`running` → `passed`/`failed`/`cancelled` | `working` → `completed`/`failed`/`cancelled` |
| resource wake on state change (D-80) | `notifications/tasks` over `subscriptions/listen` |

The extension's own motivating examples are *"CI pipelines, human approvals, review
steps"*. lore is not adjacent to this shape; it is an instance of it, built before the
shape had a name.

**It cannot be built today, and the blocker is the LIBRARY, not the protocol.**
`@modelcontextprotocol/server@2.0.0` and `core@2.0.0` carry only the *superseded* 2025
task vocabulary — `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`,
`notifications/tasks/status` — every schema annotated *"2025-11-25 wire vocabulary with no
SDK runtime; kept importable for interoperability only"*, with the result map excluding
`tasks/*` so the typed request path refuses them outright. The SDK's 2026-07-28 registry
carries no `tasks/*` and no `notifications/tasks`. No npm package implements the extension
(`@modelcontextprotocol/ext-tasks` and siblings are 404), and the extension repo describes
itself as under development.

**So the gate is SDK support, and nothing else.** Adopting it means the delta over what we
already run is small — the state machine, the durable handle, the mid-flight input and the
cooperative cancel all exist — and the gain is that a harness which has never heard of
lore can drive a review. Hand-rolling the wire against an SDK that refuses those methods is
the one thing not to do. Re-check the SDK, not the announcement; when the methods appear in
its 2026 registry with a runtime, this becomes work rather than a question.

**One semantic we would have to give up or defend:** `review_poll` returns DELTAS and
consumes them, while `tasks/get` returns the whole task state every time. BUGS.md §3 is
already the complaint that a client which loses its notes cannot recover its open findings
— so on that point the standard shape is better than ours, and the delta model is the part
to justify rather than the part to preserve.

**The transport changes in the same revision cost lore nothing.** Stateless transport drops
`Mcp-Session-Id` — a string lore's source never mentions — and the legacy HTTP+SSE
transport is deprecated with a year-long offramp we do not use.

**How this was got wrong twice, recorded because the method is the lesson.** Both earlier
readings concluded a PROTOCOL fact from a LIBRARY artifact: first *"there is no
`tasks/update`, so Tasks is poll-shaped"* (reading the 2025 vocabulary, when `tasks/update`
is precisely what 2026-07-28 added), then *"the 2026 registry has no `tasks/*`, so the
protocol dropped it"* (reading an SDK that has not implemented the extension). Grepping
`node_modules` answers what our dependency supports today; it cannot answer what the
protocol says, and it silently returns a union of both wire eras. Vany asked the question
that separates them — *is this the library or the mechanism?* — and the answer flipped.
Checked 2026-08-16 against the published 2026-07-28 changelog and the Tasks extension
documentation, with the SDK read only for what the SDK can answer.

**D-109 — the deep tiers run together: a ladder of RUNGS, findings crossing between the
models as they are found. BUILT 2026-08-14.**

Vany: *"run t2 and t3 in parallel — if one of the models finds something, deliver it to
all parallel models; if fixes arrive, deliver the fixes to all models in parallel. Fix
everything on an available t1 first."*

**The ladder walks RUNGS, and a rung is a set of tiers that run together.** In the tiers
file a rung is written as a nested array — `[ {t0}, {t1}, [ {t2}, {t3} ] ]` — and a bare
tier is a rung of one, so every existing config means exactly what it meant. Nothing
about tier IDENTITY changes: `tier_run` rows, findings' origins, `answeredBy`, quota
marks and sessions all stay per tier. What changes is only WHEN: the members of a rung
run concurrently, on the same pinned worktree, each in its own kept session.

Within a running rung, two kinds of message cross at the emission boundary — the only
insertion point D-107 established:

- **A peer's finding.** Each member's next boundary carries what its siblings raised
  since its last one, marked as a co-reviewer's: *do not spend your budget re-deriving
  it; contradict or extend it if you have evidence; otherwise keep searching elsewhere.*
  Duplicate hunting stops, and a standing adversarial check falls out free — a member
  that re-raises a peer's finding CONFIRMS it (the recorded origin rises to the stronger
  tier, exactly as re-raises always have).
- **The author's fix.** A held diff is applied to the shared worktree ONCE, at the first
  boundary any member reaches; every member then receives it at its own next boundary as
  the same author-answered message D-107/D-108 defined — each session diffs against what
  IT has seen, so to every model it is simply a new diff arriving. This is the honest
  price of one tree with two readers: between the apply and a sibling's next boundary,
  that sibling can read post-fix bytes it has not been told about. The window is one
  emission wide (D-107 messages are short), the fixes message re-orients, and the
  alternative — a worktree per member — doubles the pin and lets the copies drift apart.

**The round is the RUNG's round.** Every live member runs each round (a fix is delivered
to all, which is the point), each member's `tier_run` row records its own outcome, and
the ladder's bookkeeping generalises member-wise: fresh findings from ANY member hold the
rung (the next round re-runs it, sessions kept); the rung is clean only when every member
that could run is; escalation steps past the whole rung. A member that cannot be paid for
goes to `unavailable` alone and the rung continues with the survivors — all the D-48/D-88
accounting is already per tier and does not change. If a member dies on a fault that
requeues (a deploy window, an unreachable runtime), the whole round requeues and the rung
re-runs: finished siblings resume kept sessions on an unchanged tree, which costs a
"continue → done" exchange, and that price was chosen over cross-attempt bookkeeping of
half-finished rungs.

**Silence still settles rank-wise, member-wise.** A finding settles on the silence of
the strongest member that ran and was qualified to see it (D-56's rule, unchanged —
the rung just supplies the strongest present member); a justification is rejected if ANY
member re-raised the finding, because a second model confirming a defect is more
evidence, not a tie to break.

**What this buys and what it spends.** The deep phase's wall-clock drops from t2+t3 to
max(t2, t3); both subscriptions burn simultaneously instead of in sequence, and the
total is roughly what the sequential ladder already spent — every member was going to
run anyway. Cross-delivery adds a few prompt tokens per peer finding and saves whole
duplicate hunts. What is genuinely given up: t3 no longer reads only code t2 has already
passed — the gate property (§1 of the ladder spec) now holds between rungs, not inside
one. That is the decision: within a rung the members are PEERS, and their independence
is spent on breadth at the same tree instead of depth behind a gate.

**The grouping is pinned — for every review pinned after this ships.** Rung membership
joins `ladderFingerprint` (spelled so that every singleton-rung config — which is every
config that existed before this — fingerprints exactly as before), and a regroup
mid-review refuses resumption with the same words a repointed model does. A review
whose pin PREDATES the field is the standing exception, the same one every field the
pin has ever gained lives under: an old pin has no opinion about fields it never
recorded, so the one generation of reviews open across this deploy resumes onto the
rung rather than refusing — t2 re-runs beside t3 and is billed a round nobody chose,
which was judged cheaper than refusing every open review at the deploy (the exact
incident the shared-field comparison exists to prevent). Raised by lore's own t2, which
read the earlier absolute wording against the tolerance test and was right.

**D-108 — the pin advances, the review does not reset: `pull_fresh`, and every advance
looks the same to the model. BUILT 2026-08-14.**

Vany, watching client models answer findings by restarting: *"the client's model does not
want to use our diff update and always does this restart — tell it restart is for explicit
cases. Introduce a pull-fresh argument: it must tell us to pull the new branch for review
and recut the worktree — but continue the same review, not create a new one."* And the
constraint that shaped the mechanism: *"for the model, everything must look like a new
diff arrived — never some restart."*

**Three ways to continue, now ranked in every text a client reads:** `review_submit` (you
fixed things — send the diff), `pull_fresh: true` on `review_start` (you pushed commits —
the SAME review re-pins to origin's new tip: sync first and explicitly, because the branch
still resolves at its old tip and the missing-branch sync would never fire; worktree
removed and recut at the same review id; findings, ratified justifications and the ladder
all carried; same review_id returned), and `restart: true` — demoted in its own schema
text to *"ALMOST NEVER WHAT YOU WANT"*, reserved for a person deciding to discard the
review's history. A re-pin is refused while a round runs: a held DIFF waits safely at the
emission boundary, but replacing the whole tree under a reading tier is exactly what the
hold exists to prevent.

**And the model cannot tell the ways apart, by construction.** Each streamed run records
the tree its session last saw (`session-tree:` per review and tier); the next round, on a
kept session over a different tree, OPENS with the author-answered prompt carrying exactly
the unseen delta — `git diff` between the two pinned tree objects, which the gc pin keeps
resolvable. Submit, held diff, re-pin: one presentation. This also closed a real gap the
constraint exposed: before it, a kept session's post-submit round opened with "continue
from where you were" and the model was never told the tree had moved at all. A fresh
session is unaffected — the prompt pair routes it to the full orientation — so the record
survives lore restarts harmlessly.

**t0 reaches a kept session as a DELTA, never a repeat — extended 2026-08-14.** The
orientation carries the full deterministic render once; every later message (a fix at the
boundary, a re-pinned round's opener) carries only what MOVED: findings the new tree
resolved (named), findings it introduced (listed, worst first), and the count that stands.
What each session was shown is recorded beside its seen-tree; the NOT-RUN section is
never delta'd, because "nothing checked this" is the one fact repetition cannot cheapen.
The full list still reaches the CLIENT untrimmed — recorded ≠ told is the standing
distinction, and the trim is on the model's side only, where the session's own memory
holds the unchanged findings.

**D-107 — findings stream out as they are found; a submitted fix streams back in at the
next emission, into the same session. BUILT 2026-08-14.**

Vany: *"when the diff is pushed, it must be delivered to the model next message. We have
a new diff; the model must review it and respond whether it satisfies the finding, and
continue on the same ladder. The model answers 'I have a finding', it is delivered to the
client, the client fixes, sends the diff, we apply it to the tree, hand it off to the
model, and wait until it emits its view of this input."*

**What changes: `review_submit` during a running round is ACCEPTED AND HELD instead of
refused.** The held diff lives in the store — a deploy must not lose it (D-104) — and is
applied when the running round returns: worktree patched, tree hash verified, t0 re-run
(D-92 reuses an unchanged tree), and the diff handed to the SAME session as its next
message, exactly as a between-rounds submit already is since D-80's continuity shipped.
The ladder continues from where it stood; nothing resets. The client's loop collapses to
poll → fix → submit → poll, with no "wait and resubmit the same diff" choreography.

**What D-55 was protecting is kept, not repealed.** The refusal existed so a reviewer
never has files rewritten under it mid-read. The hold preserves exactly that: the diff
waits at the boundary; the round in flight finishes against the tree it started on. What
is removed is only the part the client paid for — being told to come back and perform
the retry themselves.

**Findings are emitted IMMEDIATELY, and the emission is the insertion point — extended
2026-08-14.** Vany: *"the model must emit a finding immediately, not at the end of the
session — so emitting a finding is the perfect time to insert the data about the fix; and
when the model reacts to the fix, it continues checking and searching for new ones, or
finishes if everything was examined."*

This dissolves the granularity problem rather than working around it. The constraint is
real and unchanged — `session.prompt` is one long request, and nothing can inject into a
running agentic turn — but the tier-run stops being ONE long prompt with a report at the
end. It becomes a LOOP of short prompts over the same kept session:

1. *"Review. When you find your next finding, report it and STOP."* The model explores,
   emits one finding (a batch is accepted if it has several ready), and its message ends.
2. lore records the finding and the client can collect it AT ONCE — delta findings flow
   while the tier is still reading, instead of arriving in one burst at the end.
3. If a held diff is waiting, this boundary is where it lands: worktree patched, hash
   verified, t0 re-run (D-92), and the next prompt says *"here is the author's fix for
   your findings — does it satisfy them? Then continue searching."* Otherwise the next
   prompt is just *"continue."*
4. The model rules on the fix, keeps searching, and the run ends when it DECLARES the
   tree examined — an explicit done marker, never an empty reply.

So the prompt boundary — the only place opencode allows an insertion — now occurs
exactly where Vany wants it: at every finding. A fix submitted while the model chases
finding N is in front of the same model, with its reasoning still in context, one
finding later.

Three more things this half must get right:

- **The done marker is load-bearing (INV-1).** A run ends when the model SAYS it has
  examined everything, in the contract's own shape. A session that dies mid-search must
  be indistinguishable from nothing — never from "finished clean". Absence of findings
  is not completion; only the declaration is.
- **Emit-and-stop is a model discipline the prompt must enforce and the harness must
  survive.** A model that dumps three findings in one message is fine — take the batch.
  One that explores forever without stopping is bounded by what already exists: the
  deadline, D-50's caps, and 2/3 compaction on the session it is filling.
- **"Round" changes meaning and the ledgers must follow.** A tier-run becomes the whole
  loop-to-done; submits no longer open rounds — they are absorbed at the next emission.
  The D-50 bounds re-anchor on turns and findings within the run; `tier_run` spans the
  loop; the board's row shows the loop's progress, not one prompt's.

Four things the implementation must get right, none reopening the decision:

- **A failed apply surfaces loudly, later — except the one claim lore can check without
  applying.** The tree-hash check on a diff's RESULT moves from submit time (synchronous
  refusal) to apply time (asynchronous) — so a mismatch must land the review in
  `awaiting_diff` with the reason on the next poll, never be a silently dropped diff.
  This is INV-1's corner of the feature. D-124's `commit` form gets one synchronous
  check anyway: `resolved^{tree}` is knowable without applying anything, so a wrong
  `tree_hash` CLAIM is refused immediately rather than accepted into a held chain and
  discovered wrong at consume time (found live, fingerprint 109d9211). The claim is
  checked early; the result is still checked late; those are not the same guarantee.
- **Held diffs chain deterministically.** A second submit while one is held is built on
  top of the first, and lore's worktree moves only when lore applies — the review agent
  is read-only — so verify in arrival order; a mid-chain mismatch drops the tail with a
  loud note. For the raw `diff` form the CLIENT builds each patch on the one before; for
  D-124's `commit` form LORE computes the patch itself, and had to be TAUGHT the same
  invariant separately — found live, not designed: it built from `review.treeHash` alone
  (the last APPLIED tree, which `holdDiff` deliberately never advances while a diff sits
  held), so a second commit-form submit arriving while the first was still held was
  built from the SAME base as the first rather than from what the first's own hold
  claims it will produce. Applying both in sequence landed the second on a tree it never
  diffed against, failed its hash check, and dropped the WHOLE chain — `awaiting_diff`
  with no diagnosis anywhere in the response, the review parked wherever the first
  commit-form submit landed. Fixed in `review_submit` (`src/mcp/server.ts`): `at` reads
  `store.heldDiffs(review_id)`'s last row's own claimed tree first, falling back to
  `review.treeHash` only when nothing is held.
- **A `commit` cannot chain onto an outstanding raw `diff` hold.** That hold's claimed
  tree is the CLIENT's own local `git write-tree`, never pushed anywhere lore can see —
  resolving it before the round ahead applies it fails as a missing object, not the
  ordinary not-found `review_submit`'s other refusals are written for. Refused by name
  until the raw hold is consumed; unaffected: a second raw `diff` (chaining it is the
  client's own job, per the bullet above) and a second `commit` once nothing raw is
  outstanding.
- **Crossing findings are stated in the client texts.** The round in flight will report
  findings the held diff may already fix; the next delivery settles them. An agent not
  told this will double-fix.
- **The accounting is unchanged.** Each delivery is a round: a `tier_run` row, the D-50
  bounds, the same board row. A held diff is not a side channel — it is the next round,
  queued inside lore instead of inside the client.

**The worktree is a checkout; the STATE is a git hash, and already was.** Vany: *"we are
not committing anything — everything is in this folder; it can't clash."* Half confirmed,
in the good direction: `treeHash` is `git write-tree`, so every submitted state is a tree
object in the shared odb with its hash pinned on the review row, and `restoreTree` can
rebuild the folder from any recorded hash — the folder is reconstructible, not precious.
The FOLDER stays named by review id: it is the mutable checkout, its content stops being
the named hash at the next submit, and two reviews can legitimately share a base commit
(two branches on one commit; a restart with no new commits) while their diff chains
diverge — hash-named folders would collide exactly there; hashes themselves cannot.

- **Fifth obligation: the odb's gc horizon must outlive a review.** The pinned trees are
  UNREACHABLE objects — no ref points at them — so git gc may prune them after its grace
  period (14 days by default). A review now lives up to ~9 days (48h bright, 7 gray),
  inside that window by luck, not contract. The implementation pins it: a
  `refs/lore/<review>` ref on the trees it must be able to restore, or `gc.pruneExpire`
  set explicitly on the bare — otherwise a long-gray review's restore path dies silently,
  which is INV-1 in a place nobody would look.

**Why the cost points the right way:** each delivery is one turn into a session that
already holds the repository — the exact case D-80's continuity made cheap — and the 2/3
compaction already bounds the growth. The expensive alternative is what exists today:
the client polls, is refused, waits, and resubmits into a fresh round.

**D-106 — findings dim before they die.**

Vany: *"let's add state findings_stale — happens after ready STALE_HOURS, lasts a week,
and the same as ready, but gray."*

`findings_ready` used to be taken by the sweep at 48 hours, straight to `expired` — and
`expired` concludes NOTHING, so two days of quiet threw away a review whose findings were
delivered, real, and still answerable. Now it dims instead: after `STALE_HOURS` the state
becomes `findings_stale`, which is `findings_ready` wearing gray — findings collectable, a
submit accepted (the gate is `hasPendingRound`, which never looked at the state), the
worktree held, `waiting_on: "you"` in the inbox. It lasts `STALE_GRACE_DAYS` (7), counted
from the DIMMING — the graying write restarts the clock — and only then does the sweep
call it `expired`, which still means *nobody came back*.

The whole life of an unanswered review is therefore 48 hours bright, seven days gray,
then gone. `expires_at` in the inbox names the real deadline — the moment the review
stops accepting an answer — so a bright review shows both clocks summed and a gray one
its remainder. The board paints the state with the dim gray it means; the client texts
say "still answerable, at most a week left" rather than teaching gray as a different
protocol, because it is the same protocol with less time.

**D-104 — a deploy drops the rounds in flight and restores them; it does not drain.**

Vany: *"do not queue — just drop sessions and restore after restart."*

`make deploy` used to drain: stop claiming, wait for every in-flight round, then swap. The
argument was model time — an interrupted round is requeued and paid for twice, and one
morning that cost 109 minutes of t2 work. It is a real cost and it is the smaller one.

**What draining actually produced, three times in one day, was a flag that outlived the
deploy that set it.** A timed-out `make deploy`, a backgrounded one that was interrupted,
and one nobody watched finish — each left `draining=1`, and each time the service answered
`ok: true` while claiming nothing. Once for thirteen hours, with eight of the team's
reviews stuck behind it. **A queue nobody can see is worse than work that has to run
again.** `make drain` remains for a deliberate pause; it is off the deploy path, so a
deploy that does not finish can no longer leave it set.

**And "restore" had a hole that the first restart found.** `reclaimOrphanedJobs` requeues a
round whose job was left `running` — but a round far enough along to CATCH the error wrote
`failed` and stayed there. Two of the team's reviews ended that way with `socket hang up`
and `could not reach opencode (getaddrinfo)`, and both had to be revived by hand.

So a connection-level fault against **lore's own opencode** is now `ServiceUnreachable`,
and the worker requeues the round instead of ending the review: nothing was learned about
the code, so nothing is concluded about it. Narrow on purpose — a provider hanging up is a
real failure of that tier and stays one, because retrying somebody else's outage would
spend our quota proving it. Bounded on attempts, because a sidecar that is genuinely down
rather than restarting would otherwise loop in silence.

**D-103 — the client is asked to poll; the subscription is kept and no longer advertised.**

Vany: *"we are keeping our subscription mechanism, but it is not yet ready in the client —
the client can only poll. So we ask the client to poll, and keep the subscribing model
hidden."*

The server still declares `resources: { subscribe: true }`, still honours
`subscriptions/listen`, and still wakes a subscriber on every state change (D-80). What
stopped is ADVERTISING it. Every reply carried a ready-made `subscribe` frame, a
`subscribe_filter`, and several hundred words on why an SDK helper needs the second shape —
so a client that cannot subscribe had to read an instruction it would fail at before
reaching the interval it actually needed, and the polling advice read as a consolation.

**A suggested interval is now always under two minutes.** The measured conditional median
is honest about when an ANSWER is likely and is the wrong number to hand a client that can
only poll: t2's is over twelve minutes, and a client told to come back then leaves a review
sitting in `findings_ready` for most of it. Coming back early costs one call; coming back
late is how reviews are abandoned, which is the dominant way they are wasted here. The
median is capped rather than replaced — under two minutes the client still gets the
measured number.

`subscribeTo` is kept as a function that returns nothing, so the call sites still say where
the hint used to go and restoring it is one edit rather than an excavation.

**D-102 — a reused t0 is recorded as reused, never as clean.**

Vany, reading the board: *"why is there a round 2 on t0?"*

D-92 skips t0 when the tree hash AND the engine set are unchanged — a deterministic engine
set given the same bytes cannot answer differently, and it saves 18% of t0 time on
rigid-monorepo. The skip is right. What it recorded was not: the reuse produces zero
findings, so the row closed as `clean`, and the operator board rendered
`t0 · round 2 · 0s · clean · raised nothing`.

**A check that did not run, written into the audit trail as a check that found nothing.**
That is INV-1, in the one table whose purpose is to say whether a review really ran, and
the board's wording claimed more than the database did. The only trace of the truth was a
log line no client and no board ever sees.

`reused` is its own outcome now, rendered as `↺` rather than a tick, saying the tree was
unchanged so the earlier sweep still stands. It stays OUT of the did-not-look set —
deliberately: the reuse requires the same tree, so that run read these exact bytes, and
counting it as a miss would weaken every verdict resting on it for nothing. It is the one
outcome that looked without working.

**D-101 — there is no worker pool; a claimed job starts at once.**

Vany: *"a job must be picked immediately"*, and then, of the knob that sized the pool,
*"there is no such thing as LORE_CONCURRENCY."*

There was: a default of 12 loops, each claiming one job and AWAITING the entire round
before claiming another. So the thirteenth review sat in `queued` however idle the machine
was — an invisible queue, which is exactly what D-98 removed at the provider and left in
place here. Worse, the board explained a queued review by blaming that pool while eleven of
the twelve loops were idle and the real cause was a stale drain flag.

One dispatcher now claims as fast as jobs exist and starts each round WITHOUT awaiting it,
so `queued` is a state a review passes through rather than one it sits in. `LORE_CONCURRENCY`
is deleted, and the service refuses to start if it is still set — a knob wired to nothing is
decoration a reader believes, which this repository has now been bitten by three times.

**What bounds the service is admission and the machine, in that order.** 128 open reviews,
refused at the door where a client can see it (D-98); below that, sixteen cores against a
t0 whose p90 is 537 seconds of sandboxed install. The second is a real ceiling and it is no
longer a number anybody picked — it is the host, and the board shows rounds in flight so it
is visible rather than inferred.

**The dispatcher dying is now a page, and that is a real loss.** A pool degraded — N loops
to N-1 to zero, with `/healthz` still green. One thread of control stops ALL claiming at
once. Its body catches everything it can and the outer catch alerts; the trade was taken
knowingly, because an invisible queue is worse than a loud stop.

**No kitchen on the wire at all — the same revision, generalised the same day.** Vany:
*"remove all internal kitchen from MCP."* The boundary now TRANSLATES (`src/mcp/plain.ts`):
`failed_because` and `checks_skipped` render for the client — opencode becomes "lore's
model runtime", a quota refusal becomes "out of capacity" with the provider's sentence
kept and its billing upsell dropped, model routes and plans vanish behind the tier id,
and a stand-in is called a stand-in. The RAW string stays in the store, the logs and the
board, where an operator debugging wants the exact words. Translation, never
summarisation: a reason no rule matches passes through untouched, because hiding an
unknown reason would be worse than leaking its vocabulary. The tool docs went through
the same sweep — worktrees became "the review's pinned copy of your branch", context
windows became "more than that tier can take in" — and the docs field test pins the
contract sentences so the vocabulary cannot quietly return.

**The mirror is never a word on the wire — D-65 revised, 2026-08-14.** Vany: *"remove
all mentions of the mirror; the code must be in the origin — it is the only
requirement."* Every client-facing text — tool docs, refusals, the branch-missing
message — now speaks only of ORIGIN: what reached it, whether lore could sync with it,
when lore last did. The mirror, the request files, the daemon and the bare paths are
lore's mechanism; a client can act on none of them, and naming them taught clients to
reason about machinery instead of about the one thing that is theirs — pushing. The
operator-facing halves of refusals keep their command names (`make mirror`,
`make mirror-daemon`) because those are the fix, carried verbatim through the client to
a person.

**D-100 — a missing branch asks the host to fetch before it is an error.**

Vany: *"branch missing → refresh mirror. Mirror refreshed and no branch → error."*

A client pushed at 19:43:11 and called `review_start` at 19:44:28 — seventy-seven seconds
later, which is exactly what `TOOL_DOCS.start` tells it to do, including *"you do not have
to refresh anything"*. The host refresher runs on a five-minute timer, so the branch was
not in the mirror yet and the review died as `failed`: by INV-1 the ladder did not read the
code, and the merge is blocked. The client could not have avoided it, and the message it
got — *push it and run `make mirror`* — named a shell it does not have, about a push it had
already made.

**lore still does not fetch.** D-65 stands: no key, no agent socket, and deliberately no
business having either, on repositories the operator may not own. It ASKS. The channel is
the data directory, bind-mounted at the same absolute path on both sides — the only thing
container and host already agree on, so there is no port to open and no secret to
distribute. lore writes a request; the host's refresher fetches and DELETES it, and the
deletion is the whole protocol because a deletion cannot be half-written.

Three properties make the failure honest rather than merely delayed:

- **The heartbeat separates "fetching" from "nobody listening".** The loop stamps one every
  pass. A missing or stale heartbeat is refused immediately, naming `make mirror-daemon` —
  without it a review would wait its full timeout for a daemon that is not running, turning
  a fast correct refusal into a slow one on every review.
- **The request is deleted after the fetch, never before.** Deleting first would tell lore
  the mirror was current mid-fetch, and it would report a branch missing that was seconds
  from arriving — precisely the failure this ends.
- **The error now says what was already tried.** A branch still absent after a real fetch is
  not a timing problem, and the message says so instead of advising a push that happened.

The daemon is therefore **resident** rather than a timer, since a request would otherwise
wait up to five minutes for the next tick. Measured end to end on this host: noticed in
under a second, both repositories fetched, answered in seven. Upgrading needs
`make mirror-daemon` re-run; an older agent never sees a request, and lore says so.

**D-99 — the person reading the board can answer the question, and the client is told they
did.**

Vany: *"in the place where a human is needed, let's add a button for each variant — but the
variants must be human-understandable, with the context of the problem. If one of the
variants is pressed, it means the human made their decision and we use that variant.
Otherwise we need to receive a diff from the client with this decision. If the human chose
a variant via the web, we need to notify the client that a human has already made a
choice."*

`needs_human` is the one state where a person IS the mechanism — no tier, retry or sweep
can move it. The board already showed the question in full (D-96); until now the only way
to ANSWER it was for an agent to relay the decision through `knowledge_resolve`, so the
person who was already looking at the contradiction had to go and tell a machine to tell
lore.

**The button says what choosing MEANS, not "left" or "right".** Whoever arrives at this
page has not read the ADR, the code or the conversation behind either statement — that is
why a judgement is needed at all — so the control carries its own consequence: *this one is
right, and retire the other*. It is confirmed before it fires, quoting what is being kept,
because a second click cannot undo it.

**Both paths run the same function.** `knowledge_resolve` over MCP and the button both call
`decide`, so a review resumed by an agent relaying its user and one resumed by a person
clicking are indistinguishable afterwards: same retirement, same resume rule — only when
NOTHING else in the repository is still open — and the same record that a human decided.
Two implementations of one decision is how they come to disagree, and this one ends with a
statement retired from the shared memory.

**The client is told, and this is the half that would otherwise rot.** From a client's side
a resume looks exactly like an ordinary requeue, and its standing instruction for
`needs_human` is to take the question to its user. So it would ask somebody who has already
answered, and quite possibly get a second, different answer — which is how a repository
comes to believe two things again. The decision is written onto every resumed review and
`review_poll` returns it as `human_decision` on every later poll, not once: whichever
session is alive when the review next moves needs the same fact.

**Unattributed, deliberately and visibly.** The page carries no credential, so a decision
made there is recorded as *"a person on the operator board (no credential, so no name
recorded)"*. The obvious tightening — loopback only — was written and then removed: inside
a container a browser's request arrives from the docker gateway, so it would have refused
every real use of the button while looking like security. D-33 already makes the tailnet
the perimeter. A teammate who wants their name on a decision uses `knowledge_resolve`,
which records it.

**D-98 — a round never waits for a model slot; the service refuses at the door instead.**

Vany: *"there may be no situation where a job waits for the session in opencode — launch
immediately. If you need limits, okay: do not accept a request if there are already 128
reviews going."*

`reviewer/gate.ts` held a semaphore: N model calls in flight, the rest queued FIFO. It was
real protection, bought with real evidence — on 2026-08-05 at twelve concurrent calls four
reviews died within 2.5 minutes, two `socket hang up` in the same second and two empty
replies inside a 200, with the host fine throughout. **What it produced day to day was a
review sitting in `queued` with a clock running and no surface able to say whether it was
waiting or wedged**, which is the confusion that started this whole line of work.

So the bound moved to admission. `review_start` refuses when 128 reviews are already open,
and everything admitted launches as soon as a worker loop reaches it. **A refused client
knows**: it can cancel something abandoned, tell its user, or come back. A queued one sees
a state name and a clock.

- **128 is far above normal traffic** — the busiest day here held about a dozen. It is not
  a throughput knob. Reaching it means something has gone wrong, and accepting more would
  make the wrongness harder to see.
- **Open means not finished**, including reviews waiting on their client: a parked review
  holds a pinned worktree and can become work again on the next submit. The refusal names
  `review_cancel` because that is the remedy in the client's own hands.
- **Counted service-wide**, not per repository. The resources it protects — one opencode
  process, one host, one set of worker loops — are shared, and four repositories with
  their own allowance would put four times the load on the one provider that matters.
- **Nothing is created when a review is refused.** This fires before anything is promised,
  so there is no row to mark `failed` and no client holding an id. (It is now the only
  thing that refuses a review at all: the spend ceiling that also did died with D-121.)

**What this gives up, stated plainly.** Concurrent model calls were then bounded by the
worker pool — twelve, which is exactly the number with a measured failure — and D-101 has
since removed that too. The trade is deliberate: waiting is invisible and unbounded, while
a provider refusing is loud, lands as *this review DID NOT RUN*, and names itself.
`LORE_MODEL_CONCURRENCY` is **deleted**, not defaulted — a setting that no longer does
anything is decoration a reader believes.

**AND THE REMEDY THIS PARAGRAPH ORIGINALLY NAMED NO LONGER EXISTS.** It said *"the lever is
`LORE_CONCURRENCY`"* — a variable D-101 deleted one decision later, and which now makes the
service refuse to start. An operator hitting exactly the fault this decision is about would
have read the spec, set it, and crash-looped the deployment; that already happened once,
from the compose file alone. If provider faults return, the levers are the tier
configuration and admission, and the honest answer is that nothing throttles concurrency
below that any more. Raised by lore's own t2, which read D-98 and D-101 together.

**D-97 — a review that has ended leaves no work behind it, and the queue counts only what
can be claimed.**

Vany, reading the board: *"a job must be picked immediately. Why has nobody claimed it?"*
Three jobs had been `queued` for up to nineteen hours against eleven idle worker loops and
three free model slots. My first answer — that loops were held by rounds waiting at the
model gate — was wrong, and the numbers on the page said so: one call in flight, none
waiting.

**They were not waiting for anything. They were dead.** All three belonged to `cancelled`
reviews. `claimJob` refuses a job whose review is terminal, which is correct — a cancelled
review must not go on being paid for, and that check was itself added after cancelled
reviews were found still being claimed. But nothing ever CLOSED those rows, so they sat in
`queued` for ever and `queueDepth` counted them.

That number is read by `/status`, by the operator board, and by the `queueBacked` ticket.
So an idle service reported a growing backlog — and the failure is the familiar one
pointing the other way: not *healthy while broken*, but *busy while idle*. Left alone it
would have filed a ticket about work that did not exist.

Three changes, because the cause, the count and the leak are three different things:

- **The cause.** Reaching a terminal state closes that review's `queued` jobs. In
  `updateReview`, so no future caller can forget — and separately in `expireStaleReviews`,
  which writes state in SQL rather than going through there. That split has already cost
  one bug: it was the single review-state mutation that woke no subscriber.
- **The count.** `queueDepth` joins to the review and excludes terminal ones. Narrow even
  with the cause fixed, because a review can end between an enqueue and a claim, and the
  number must never overstate in that window either.
- **The leak.** The hourly sweep closes any that remain and **reports how many**, so a
  non-zero number after this is a question rather than housekeeping.

Jobs are marked `failed` with a reason, never deleted: the job table is the record of what
the scheduler did, and `last_error` is where a reader learns the round never ran. A
`running` job is left alone — it belongs to the worker aborting it, which is the code that
reports what the abort cost.

**D-96, revised 2026-08-28 — a board at `/`, because "what is running?" was being answered with SQL.**

Vany asked *"what is running right now?"* four times in one week. Every time the answer
needed a shell into the container and three queries, and twice the thing I found that way
was a review that had been wedged for the better part of an hour.

`/status` already holds these facts and is the wrong shape for them: it answers *is it
healthy* to something that will page. So `GET /` serves one self-contained page — no
build step, no CDN, because a board about a wedged service must not need to fetch
anything to render — pushed over SSE, with `/board.json` for `curl`.

**Collapsed by default, and collapsed says: state, step, time used, time since anything
moved.** The last is the number the page exists for, so its definition is load-bearing —
the newest of `updated_at`, any tier boundary, and any finding's first sighting.
`updated_at` alone moves on STATE changes, and a deep tier can read for twenty minutes
without one; a board that called that stalled would train its reader to ignore the only
signal that matters.

Two things are promoted out of the detail because they are alarms, not data: **`no tier`**
in the collapsed row when a `running` review has every tier row closed — the four-and-a-
half-hour stall's exact shape, which the first version hid behind a click — and a stall
clock that goes yellow at twenty minutes and red at forty-five.

**A finished review's clock stops.** Counting to now for ever would say a review that
passed on Monday is still spending time, which is this project's own failure mode drawn
in a table.

Pushed on change only, from a timer that runs solely while somebody is watching: an idle
board transfers nothing, and an unattended service does no work for it. Deliberately a
poll rather than new operator events on `store.events`, whose state-change-only semantics
are argued for elsewhere and whose extension would fail by going quietly stale.

**The branch links to its pull request.** `review_start` takes an optional
`pull_request` — optional because required would have failed every call from every client
already working, and because lore's own reviews run on scratch `review/<sha>` refs that
have none; a missing link must not become a review that did not run. The docs ask for it
every time, since a branch name is not clickable and does not name its forge. `http(s)`
only, checked at the boundary and again before rendering: this is an `href` on a page that
needs no credential, so `javascript:` there would be a script chosen by whoever started
the review, running in the operator's browser.

**Findings hang under the tier attempt that raised them**, collapsed, and open to
severity, file, line, symbol, CWE, and the verdict that settled them if one did —
never to claim, evidence or failure scenario (revised below). The nesting is what makes "which tier said this" need no label. It is a join and
not a heuristic: `finding.origin` is the tier id and `finding.round` the round, exactly
the pair a `tier_run` is identified by, verified against the live database as matching
every finding it holds. Anything that fails to match is still shown, as an orphan — where
a finding is filed must never decide whether it is seen.

A settled finding says so and is not counted as work, because a board where answered work
reads as outstanding work is one whose reader learns to discount it.

Unauthenticated on the MCP interface, **Vany's call**, made knowing `LORE_BIND` is
`0.0.0.0`. `/status` already exposed the same branch names and counts to the same
audience, so this widens who can see THOSE comfortably rather than who can see
anything at all.

**REVISED 2026-08-28 — finding TEXT is not part of that widening.** A version
shipped that also put claim, evidence and failure scenario into the same
unauthenticated snapshot — reasoned about at the time as a further deliberate
widening — and `service/http.ts`'s own route comment never agreed: it kept saying
the board "deliberately does NOT carry finding TEXT... theirs to hand out, not ours
to publish" while the code did exactly that, until lore's own review of this module
caught the two disagreeing. The comment was right about what should be true. A
claim describing a defect in somebody's unmerged branch is theirs to hand out, and
the tailnet is wider than the people entitled to read it. What stays unauthenticated:
severity, file, line, symbol, CWE, fingerprint, the verdict that settled it — enough
to say a tier is unhappy and where. What moved behind the same bearer token every
other finding-bearing route already needs: what it is unhappy about, read back
through `review_poll` or `lore://review/<id>`.

**The rationale behind a settled verdict moved with it, one round later (fingerprint
969fa523).** The first pass of this revision named three fields and missed a fourth:
a `justified-accepted` rationale is the developer's own words about why a claim does
not need fixing, and those words routinely restate the claim — the identical
disclosure, carried in the verdict's text instead of the finding's.
`justified-rejected` never reaches this at all: the ladder rejecting a justification
leaves the finding open, not settled. The verdict KIND stays (a status, not a
description); the rationale behind it does not.

Capped at forty findings per review with the remainder **counted and stated**, because a
list that silently stops at forty reads as a complete list of forty.

Detail in `spec/operations.md` §2.4.3.

**D-95 — the inbox lists every OPEN review, not only the ones with something fresh.**

`review_inbox` filtered on *has undelivered findings, or is `needs_human`*. So the review
it hid was precisely the one its own documentation is about: **parked in
`findings_ready`, its findings already collected, waiting on a `review_submit` that never
came.** That is not an exotic path. It is what happens every time a session polls, starts
fixing, and ends — the deltas are consumed by the session that dies, and the next one,
making the call whose stated purpose is *what is waiting for me*, is told nothing is.

The review then holds a pinned worktree until the sweep calls it `expired`, and by INV-1
`expired` never means "found nothing" — it means a review was paid for and concluded
nothing at all. Abandonment was measured as the dominant cause of wasted reviews here,
and the mechanism built to prevent it could not see the commonest case.

Found on lore's own repository, from the operator side rather than the client side:
`/status` listed `rev_uFMG9` in `findings_ready` for two days while `review_inbox`
returned `{"reviews":[]}` to the same principal. Two views of one database disagreeing
about whether anything was waiting.

So the filter is now *open, or holding undelivered findings*, and each entry says whose
move it is:

- **`waiting_on: "you"`** — `findings_ready`, `awaiting_diff`, `needs_human`, or any
  review with uncollected findings. Nothing happens until the client acts.
- **`waiting_on: "lore"`** — `queued`, `running`, `fast_clean`. Listed deliberately even
  though there is nothing to do, because a resumed session that cannot see its own
  running review starts a second one, and `review_start` discards every justification the
  first has ratified (§2.4.2).
- **`expires_at`** — `updated_at` plus the sweep's own `staleHours`, from one constant, so
  the deadline stated and the deadline enforced cannot drift apart. Absent on a terminal
  review, which the sweep never touches; a deadline there would be fiction.

A terminal review still appears while it holds undelivered findings — cancelling hands
its findings over and they are real — and drops out once they are taken.

**D-81 — extraction stays deterministic, and a model may only VETO what it mined.**

Doc ingestion has always been a pure function of the document, on the argument that it
runs on every change, must be free, and must give the same answer twice. The first two
still hold; the third is now qualified, and this records what bought the qualification.

**Three successive deterministic narrowings all stopped in the same place.** The reader
that took every declarative sentence produced 423 live rules for this repository, about
nine tenths of them not rules. The shape test (bullets and single-sentence paragraphs,
with dangling-referent and mid-sentence refusals) cut that to 61 — a real win, and the
measurement that justified it. Adding lead-in, label and gerund-head refusals took it to
51. **The share that are not rules went 90% → 20% → 18%.** The floor is not a coincidence:
what remains differs from a rule by what the words *mean*, and every rule sharp enough to
separate *"Cost. A conversation re-sends its accumulated context every turn"* from
*"Handles are CSPRNG-generated, never sequential"* also refused real rules — the strictest
variant measured dropped `CLAUDE.md` entirely, because its bullets lead with an
unmodalised summary.

**Why a fifth is not tolerable.** Up to sixty of these enter every review prompt under
*"treat these as this team's decisions"*. A fragment there is not noise in a file; it is a
confident instruction to a model reading somebody's branch, and the reader cannot tell it
from the rules beside it.

So the cheapest model tier is asked one question per document — *which of these are not
rules* — and three properties keep the non-determinism bounded:

- **It only removes.** It never rewrites, invents or reorders. The base is still a
  function of the documents; the model chooses a subset.
- **A refusal is a row.** Every rejected candidate is written born-retired with the
  model's reason, so *"why is that rule not in the base"* is answerable. This is the
  whole objection to filtering — a rule that never arrives is invisible — and it is
  answered with a record rather than with confidence.
- **It fails open and says so.** Unreachable, out of quota, or unparseable, every
  candidate is kept and stamped `-unscreened`, which the next ingest retires and
  re-screens. The knowledge base is the product; it is never emptied to protect a
  filter, and "kept for now" never silently becomes "kept for ever".

**What it costs.** One t1 call per document, and only for a document whose text or reader
changed — `ingestDocs` asks that before it asks the model, because it runs on every review
and almost always finds nothing changed. Eleven calls for this repository after a reader
bump, one after an edit.

`[OPEN]` — **the screen has not been measured.** The 18% is what the deterministic reader
leaves; whether the model actually removes it, and what it wrongly removes with it, is
unknown until it has run on both repositories. The born-retired rows are what makes that
measurable: read them and count how many should have lived.

**D-79 — a finding is something the author missed and would be hurt by, addressed to
them as a question.**

The prompts do not ask for that, and the output shows it. Vany's diagnosis,
2026-08-06, and the evidence is our own.

**What we ask for today.** T1 is told *"Expect obvious defects. Report them plainly and
cheaply; do not agonise."* — an instruction to produce volume. The output contract
requires a `failureScenario`, so a model writes one for whatever it found rather than
using *"can I state a real failure?"* as the test for reporting at all. Nothing anywhere
says the bar is consequence.

**What comes out.** Kimi's review of the D-77 commit produced eleven findings; every one
was correct and nearly all were documentation drift — *this sentence asserts what the
code does not do*. Real, worth fixing, and not what an independent auditor is for.
Meanwhile one semgrep rule has been raised 63 times across this deployment and accepted
as justified 63 times. MEMO session 30 named the shape a year of evidence now confirms:
**the ladder converges on code and oscillates on prose.**

**So the purpose is stated in the prompt, not assumed.** A reviewer exists to find what
the author *missed* and would be hurt by. Two tests, both of which must pass:

- **Consequence.** Can you state concrete inputs or state, and the wrong outcome that
  follows? If not, it is an observation, not a finding. `failureScenario` stops being a
  field to fill and becomes the gate for reporting.
- **Missed.** Would the author, who knows what they meant and has just re-read this,
  still not have seen it? A defect they would have caught on their own next pass costs
  a round and teaches nothing.

**Not "non-obvious", and the distinction matters.** An off-by-one is obvious the moment
it is pointed at, and was still missed — filtering on obviousness would drop the cheap
tier's whole job (D-31) and much of what a reviewer is actually good for. The filter is
*would the author still have missed it*, which is a question about the author rather
than about the defect.

**And prose stays in scope.** D-11 makes specs reviewable, and this was not idle: the
same review that produced the documentation drift also caught `knowledge_resolve`
never resuming the review it unblocked — a spec claim that was false because the CODE
was wrong. What must change is not that prose is read but that a wording nit and a
production hazard arrive in the same shape at the same severity. A prose finding has to
clear the consequence test like anything else: *who is misled, into doing what*.

**The finding is addressed to the author, not filed against them.** Today a finding is
a record: file, line, severity, claim. It should read as an ask with two legitimate
answers, one of which is disagreement — *"I found this. Fix it, or tell me why it is
not a problem."* That is already the mechanism (D-10: the reviewer rules on a
justification), and the presentation hides it. Disagreement is a first-class answer,
and a client that reads the shape as a verdict argues less well than one that reads it
as a question.

**Recurrence changes the ask, not the volume.** Where a finding has been seen before,
the sentence is not *"and here it is again"* but *"this has happened N times — if it is
wrong, the fix is whatever keeps producing it."* One instance answered N times is a
process failure being paid for repeatedly. This is the missing verb behind the 63
accepted justifications: the count is currently an adjective, and it should be the part
that asks a different question.

**Built 2026-08-06.** `prompts.ts` states the bar before position and before the
question; `OUTPUT_CONTRACT` makes `failureScenario` the test rather than a field, and
`claim` "what you would say to the author's face"; an open finding carries `asks`;
`renderEnrichment` reads the prior *verdicts* and asks accordingly. The schema is
unchanged, severity stays the engine's (D-67), and a rejected finding still loses only
its own line (D-66) — this changed what we ask for and how we say it back, nothing
else.

`src/reviewer/prompts.test.ts` pins the bar rather than the wording, because the
prompts had no test at all, which is how they drifted into asking for volume in the
first place.

**Third test, added 2026-08-07 and paid for in advance.** *Not already said.* If a
finding's evidence is the change ITSELF recording that something was not done — a spec
paragraph marking it `[OPEN]`, a comment naming it deferred — then the author did not
miss it, the second test fails, and it must not be reported.

The evidence is one t3 round on this repository. It asked the question only the ticket
makes possible, read the diff's own paragraph saying half the ask was deliberately not
built, **cited that paragraph as its evidence**, and raised the gap as `medium` anyway.
Nothing changed — the only possible answer was a `lore-ok` — and the reset it triggered
consumed the last three rounds of the global budget: without it the trace ended `t3
clean → passed` at round 10, with it the review stopped at 13. One finding, no defect,
verdict destroyed.

The question stays, and stays valuable: an **undisclosed** gap between ticket and code
is the most useful thing a review can find, and a reviewer cannot know in advance which
kind it is, so it must look. What changed is what to do once it has. And a disclosure
that is itself false — the spec saying "not built" while a tool description promises it
— remains a finding, and a good one.

**The prompt was also lying about position, fixed 2026-08-07.** `position()` keyed on the
TIER and nothing else, so a tier on its fifth pass was told *"You are the FIRST model to
see this change"*. On round 11 of this repository's own review that sentence went to t1,
which had read and cleared that tree four times with t2 and t3 clean behind it. Told it
is first, a model behaves like it is first: it re-audits, and on a tree whose only new
material is the author's comments, what it finds is comments. Five such re-reads cost 28
minutes — 37% of that review's model time — and produced nothing.

A re-read now says what it is: *the tree was cleared, the author has answered, judge the
ANSWER.* Not a licence to skim — the fix is unreviewed code written under pressure, and
one of that review's real findings came from exactly such a re-read — a licence to stop
re-auditing what this tier already passed.

**And the prompt now says what the diff is made of**, when three quarters or more of the
added lines are comments or documentation. A reviewer given a diff that is almost
entirely prose will find prose; it cannot otherwise distinguish "the author rewrote a
comment" from "the author changed the system". Documentation findings still count —
drift is this repository's most common real defect — but in such a round one must name a
READER and what they would DO wrongly. Measured on the same review: the first pass found
8 defects and 0 drift; the passes over the fixes found 1 defect and 8 drift.

**Unmeasured, and that is the honest caveat.** Whether this produces better reviews is
not yet known: `PLAN.md` Phase 1's measurement harness was never built, so the change
rests on a diagnosis rather than on a before-and-after. The diagnosis is well-evidenced
— eleven findings on one commit, nearly all documentation drift; one rule raised 63
times and justified away 63 times — but a prompt rewrite judged by the person who wrote
it is exactly the shape D-75 exists to be suspicious of. The cheap check is to re-run
recent reviews' diffs under the new prompts and count what changes; `TODO.md`.

**D-78 — a review answers to the token that started it.**

D-69 scoped access by **repository**: a token reaches its own repo and no other. That
was the right fix for the bug it found, and it is one step short. Tokens are minted per
repository and a workgroup provisions several to the same person, so any token for a
repo can currently poll any review of that repo — including one another agent is in
the middle of.

**And `review_poll` is not a read.** It returns deltas and marks them delivered, so
polling somebody else's review silently consumes findings its owner has not seen and
will never be shown again. Nearly done on 2026-08-06: asked to watch a review this
session had not started, the obvious move was to poll it, which would have eaten the
client's findings while reporting on its progress. Caught before the call, by Vany.

So `review_poll`, `review_submit` and `review_attest` require **the token that created
the review**, not merely one scoped to the same repository. `review_inbox` stays
repo-scoped, because "everything waiting for me" is a question about a holder rather
than about one review.

**This is about the delta cursor, not about attribution.** *Who* started a review is
already answered, and answered at the right level: `principal` is the person, and every
agent acting on their behalf is them. A first draft of this decision claimed the audit
trail could not say who — reasoning from "I cannot tell which agent" to a gap that does
not exist, and Vany corrected it. The question a reader asks is answered; what is not
protected is one caller's stream of findings from another caller's poll.

**The token itself is never revealed** — not the secret, not a hash prefix, not in
`make status`, `lore://review/{id}`, or an error. The binding is checked against the
stored hash internally. A token gets a name at provisioning so an operator can say
which credential to revoke, and that name is the only handle that ever surfaces;
`make revoke` should take it rather than the hash prefix it takes today, refusing an
ambiguous name rather than resolving it (`spec/review-ladder.md` §3.1.2) — revoking the
wrong client while leaving the intended one live is worse than refusing.

A valid id presented by another token fails as **not found**, never as forbidden, for
D-23's reason: "this exists but is not yours" confirms the id is real, and the id is
the one thing worth guessing.

**Rotation was the wrinkle, and it is decided: a revoked binding falls back to
repository scope.** Revoking a token would otherwise orphan every review it started —
correct for a compromised credential, wrong for the routine replacement that is the
common case. What this defends against is an ACCIDENT between colleagues, not an
attacker: the obvious way to answer *"how is that review doing"* is to poll it. Against
that, stranding somebody's in-flight work on a rotation is the worse failure, and the
people who could then reach those reviews are the ones already trusted with the
repository. Reversible if the threat model ever changes, and the change is one clause.

**A review with no recorded token stays repository-scoped.** Rows written before the
column was added were started under that rule and were never bound to anything;
inventing a binding for them would lock out the client that legitimately owns them.

Built 2026-08-07. `mine()` in `src/mcp/server.ts` is the single gate, so `review_poll`,
`review_submit`, `review_cancel`, `review_attest`, `review_vex` and the
`lore://review/{id}` resource are all bound by construction rather than one at a time —
`review_inbox` is the only reader that does not go through it, which is exactly the
split above. `TOOL_DOCS.poll` and `TOOL_DOCS.inbox` say so to the client, because a
client that finds a colleague's review NOT FOUND on a repository it holds a token for
would otherwise conclude lore had lost it.

**D-77 — commit, review it to a verdict, amend, then push.**

lore gates other people's branches and has never gated its own. Every commit in this
repository reached `origin` on the strength of a typecheck and a test suite — the two
things D-8 says a model should never be paid to do — while the ladder that exists to
catch what those cannot ran, at best, hours later and usually not at all.

So the loop closes on ourselves:

1. **Commit** locally. The message says what changed and why, as now.
2. **Review it, over MCP, as a client** (D-76). Not one round — answer each finding by
   fixing it or justifying it, and send the answer back with `review_submit` so the
   ladder re-reads the corrected tree. Repeat until it reaches **`passed`** or
   **`passed_partial`**, which are the only two states that mean a ladder read this
   code and was satisfied.
3. **Amend** that commit with exactly what was submitted, and record in its message
   what the review found and what was done about it.
4. **Push.**

**The fixes go through `review_submit`, not straight into the amend.** Written the
other way — review, then amend with the fixes, then push — the tree that reaches
`origin` is not the tree the ladder read, and the property is lost in the last step of
the workflow that exists to protect it. Submitting means the final round is run against
the code that is actually pushed.

**`needs_human` is not a stopping point, and D-77 said it was.** Caught by the first
review this decision ever ran on — its own. The code's terminal set is
`{passed, passed_partial, failed, expired}` (`core/review-state.ts`); `needs_human`
is a review PARKED on a question, and `spec/knowledge.md` §7.2 is explicit that while
one is open the review cannot pass, cannot attest and cannot be closed with `lore-ok`.
Reading D-77 literally, an operator would have stopped there and pushed code carrying
an unresolved conflict the ladder had flagged and could not settle — the exact class of
thing "nothing reaches origin that a ladder has not read" exists to prevent.

So `needs_human` means **get a person and settle the question with
`knowledge_resolve`**, which re-queues every review that was waiting on it and reports
how many. `knowledge_escalate` is the other half and does NOT unblock: it records that
a person is required, which is the point of it.

That resumption had to be built to make this sentence true. `spec/knowledge.md` §7.3
promised the ladder recomputes `needsHuman` each round — correct, and unreachable,
because settling a conflict scheduled no round. A client that resolved and waited, as
instructed, waited for nothing, and since `needs_human` is not terminal the staleness
sweep turned the review into `expired` two days later. An exit sign over a wall, caught
by the review of the commit that wrote the sentence.

**What fires a review, and what does not.**

Code or specs changed → review. **A test-only change does not**, and neither does
`TODO.md` or `MEMO.md`: a checklist and a diary make no claim about how the system
behaves, and a ladder reading them spends three model tiers to have an opinion about
housekeeping. Specs are in because D-11 makes them reviewable artifacts and because
prose asserting what the code stopped doing is this repository's most common defect —
the exact thing a reviewer catches and a test cannot.

**With one exception, and it is not a technicality: a test-only diff that REMOVES
tests still fires.** Adding a test cannot weaken anything. Deleting one, or cutting
assertions out of one, changes what the gate catches — a behaviour change in the
checking apparatus, invisible to the suite because the suite is what shrank. And a
test can be wrong in its own right: the session driving `rigid-monorepo` on 2026-08-06
found an e2e test *"still asserting an unrequested partial approval, i.e. asserting the
defect that ticket exists to remove"*. Whether a test asserts what its name claims is a
model-tier job by D-71, so the one shape that must not skip the model tiers is the one
where a test got smaller.

**A skipped review is recorded, never silent.** The commit says which rule let it
through. An unreviewed commit that looks like a reviewed one is this project's defining
failure applied to its own history, and "it was only tests" is exactly the sentence
that would later turn out to be untrue.

**Amend rather than a follow-up commit**, for two reasons. The history should show the
tree that was reviewed, not a broken state followed by a repair — a reader six months
out wants the reviewed commit, not the archaeology. And the commit is unpushed, so
amending rewrites nothing anybody has.

**Push is the gate.** Nothing reaches **`origin/main`** that a ladder has not read.
That is the property, and it is the same one lore sells to everyone else.

**`origin/main`, not `origin` — and the earlier wording was simply false.** This
workflow pushes the *unreviewed* commit to `origin` as `refs/heads/review/<sha>` in
step 2; an absolute "nothing reaches origin" is contradicted by the rule's own
machinery, and calling that push "transport, not a release" was a comment excusing a
sentence rather than a reconciliation. Caught by the first review D-77 ever ran, on
itself.

The scratch ref is real exposure and is bounded rather than waved at: it is fetchable
from a public remote for the length of the review, and if the session dies between the
push and the delete **nothing sweeps `review/*`** — the ref stays until someone
removes it. So the delete belongs in the same command as the push rather than in a
later step a crash can skip, and stale `review/*` refs are something to look for. What
the property actually guarantees is that no reviewed-by-nobody tree becomes the branch
anyone builds on.

**A BATCH NEEDS A SECOND SCRATCH REF, FOR THE BASE.** `into: main` names "before this
change" only while none of the change is on `main` — and under the batch gate part of it
always is, because a commit may reach `origin/main` unreviewed while the batch waits. Once
that happens `merge-base(main, HEAD)` no longer marks the start of the batch: it slides
forward commit by commit, so the ladder is handed a fraction of the work while the ticket
describes all of it, and when `main` catches up entirely the change-set is empty. Both
failures are silent from the client's side — the review looks healthy and reports on less
and less. So a batch pushes **`review-base/<sha>` at the commit before the batch begins**
alongside `review/<sha>` at its tip, and starts the review `into` the base ref. Two refs,
deleted in the same command as they are pushed, and nothing sweeps either.

Measured on lore's own batch: pinned at a base three files back while the ticket described
ten commits, then zero files once `main` had absorbed the lot. D-113 stops the change-set
moving underneath a running review, and this stops it being wrong at the start.

**And the amend is not checked against what was reviewed.** "Submitting means the final
round runs against the code that is actually pushed" was stated as fact and the
procedure never verifies it: the reviewed tree is the snapshot plus submitted diffs,
the pushed tree is whatever the amend produced, and a stray staged hunk between the two
would push a tree the ladder never read — silently, with every report saying otherwise.
Both hashes are known, so **compare them before pushing**: `git write-tree` against the
`tree_hash` the last `review_submit` returned. Not built; it is the missing step in
`make review`.

**A review that FAILED blocks the push exactly as open findings do — and the response
is to fix lore, not to push past it.**

This is the half with teeth, and without it the rest is decoration. `failed` means the
ladder did not read the code, which is INV-1 in its original words: *a review that did
not run is not a review that found nothing*. Treating it as "well, we tried" is the
precise failure this project was built to refuse, committed by the thing built to
refuse it.

**`expired` is a different animal and was wrongly lumped in here.** Its ordinary cause
is abandonment — nobody polled, the staleness sweep collected it (D-70) — and the
remedy is to start a review, not to go hunting a bug in a healthy service. Read
literally, the sentence sent a reader who walked away over a weekend to debug lore. It
shares one property with `failed` and only one: **neither is a pass, and neither may be
pushed on.**

So when a review of lore fails, **fixing lore is the work** — ahead of whatever the
commit was for. Not a retry in hope, not a workaround, not a note in TODO to look at
later. The gate is down, and a gate that cannot run makes every claim behind it
worthless.

Today is the evidence, and it is the whole argument. Five identical failures on one
branch over two days; lore had computed the cause and written it to a log no client can
read; the client retried as its own documentation instructed, then told its operator it
was blocked on *"whether to proceed without a lore pass given its tier is still
broken"*. That is a reasonable person reaching the only conclusion available — and it
is unreviewed code shipping, arrived at honestly.

**What is ours and what is not.** A tier nobody can pay for is already handled: it is
recorded unavailable and stepped over (D-48); whether the review still reaches `passed`
turns on whether a dearer tier answered above it (D-88).
A provider that is simply down is not a defect here and the answer is to wait, not to
push. Everything else — an empty reply nobody explained, a prompt that will not fit, a
message that sends its reader the wrong way — is ours, and is fixed before the commit
that was waiting on it.

**The bootstrap, stated rather than left to be discovered.** Fixing lore produces a
commit, and that commit needs reviewing, which is the thing that is broken. So the fix
commit is the one review that may run last: it is pushed once reviewing works, and its
own successful review is the proof that it worked. If it cannot be reviewed even after
the fix, the fix was not one.

**The obstacle, and it is real: lore reads the mirror, not the working tree.** A review
is cut from `origin/<branch>` (D-65, D-40), so a commit that exists only on this disk
cannot be reviewed — which is precisely the friction that made me reach for the CLI and
earned D-76. The workflow above therefore needs the tree to reach the mirror *without*
reaching `main`, and the honest way is a scratch ref:

```
git commit                                   # local
git push origin HEAD:refs/heads/review/<sha> # transport, not a release
  … review that branch against main, to a verdict …
git commit --amend                           # fixes + what the review found
git push origin main
git push origin --delete review/<sha>
```

`[OPEN]` on two counts, both of which are Vany's rather than mine.

**Cost.** A full ladder cycle per commit is not free. This session produced eleven
commits; eleven cycles through t1, t2 and t3 would be hours of model time and a serious
share of three rolling quota windows. Plausible relaxations, none chosen: full ladder
only on the last commit before a push; deep tiers only when T0 or t1 raise something;
or batching a session's commits into one review of the whole range. Anything that
changes how much quota burns is discussed before it ships.

**And the scratch-ref dance is machinery.** It is the simplest thing that satisfies
"review before push" given the mirror, but it is five commands where the rule is one
sentence, and `make review` ought to be what actually runs it. Not built.

**This decision was not followed for the commits that introduced it**, including this
one — recorded plainly, because a rule whose own commit violates it is exactly the kind
of claim this repository exists to catch.

**D-76 — a change is exercised through the MCP surface, and a CLI run proves nothing
about the product.**

MCP is the product; the CLI is the development surface (D-16). What that decision did
not say is which one **validates a change**, and the answer has to be written down
because the CLI will always be the easier path: no token, no mirror, no push, and it
reviews the working tree directly.

Observed 2026-08-06, on this repository, by me. Asked to review lore's own last
commit, I reached for the CLI — specifically *because* MCP would have needed the
branch pushed first, since a review is cut from the mirror of the remote (D-65) and
never from a working copy. The reasoning was sound and the choice was wrong: it routed
around the only path a client ever takes, and it turned a question that was the
operator's (*may I push?*) into a workaround that avoided asking. **Quietly choosing
the easier surface is the same substitution this project refuses everywhere else.**

The workaround did not even work. The CLI had never once been run from the host, and
failed immediately — `EACCES: mkdir '/var/lib/lore'`, because the T0 sandbox's cache
root reads `LORE_DATA_DIR` and the default is a path only the container has. A surface
nobody exercises does not work, which is this project's oldest lesson arriving from the
direction nobody was watching.

So:

- **A change to lore is not validated until a client has driven it over MCP.** Tool
  calls, a real token, the deployed service.
- **A CLI run is evidence about the core, never evidence the product works.** It is
  the right tool for iterating on the ladder, the parser and the store, which is what
  D-25 built it for.
- **The prerequisite is part of the rule, not an excuse.** Validating over MCP requires
  the branch pushed, because the review is cut from the mirror. That friction is
  precisely why the CLI gets reached for, and precisely why this is a rule rather than
  a preference. *Push, then review* is the workflow; a push is the operator's decision
  to authorise, and asking is cheaper than the workaround.

`[OPEN]` — nothing enforces this mechanically. The field test in `src/service/http.test.ts`
drives the real MCP surface in-process, which catches drift but is not a client over
the wire against a deployment; `PLAN.md` Phase 3's done-criterion (a fresh session
reaching `passed` with no instructions but the tool descriptions) is the real check and
is still unmet. Until one of those closes, this holds by discipline, which is the
weakest kind of guard and is named as such.

**D-20, extended 2026-08-07 — the knowledge base holds rules, not quotations.**

Vany asked me to find a significant improvement, and it was not in the code. It was in
the artefact D-14 calls the product.

**The store held 423 live rows. Nine had been written as rules.** The other 414 were
sentences copied out of prose composed for a different reader: `extractRules` lifted
them from spec paragraphs, and an accepted `lore-ok` was filed verbatim as a fact about
the codebase. **92% had no `why`** — while `TOOL_DOCS.teach` tells every client that a
rule without one gets deleted by the next reader. We required that of humans and nothing
of ourselves.

What that produced: *"It has to be, because the secret is shown once"*. *"A required
field is therefore free money for every in-flight decision"*. *"Asked to review lore's
own last commit, I reached for the CLI"* — a MEMO diary entry, stored as something the
codebase knows about itself. Subjects missing, "therefore" pointing at a sentence never
captured.

**And up to sixty of them go into every review prompt, every round**, under *"WHAT THIS
CODEBASE ALREADY KNOWS ABOUT ITSELF — treat these as this team's decisions, not
suggestions."* 218 of the 399 came from lore's own documents, so on each round three
frontier models were handed sixty fragments of lore's incident diary and told they were
binding. That is this project's defining defect — a confident false statement — inside
the artefact it exists to produce, aimed at the judgement everything else rests on.

Three changes, in `spec/knowledge.md` §2.1.1 and §2.2.0:

1. **Only rule-shaped content is ingested** — bullets, and single-sentence paragraphs.
   Measured 2026-08-06: `SPEC.md` went from 111 rules to 15, the repository from 218 to
   66. A measurement with a date, not a standing figure — `SPEC.md` is edited most
   sessions, so its yield moves without the reader changing.
2. **A statement that cannot stand alone is not a rule** — dangling referents and
   mid-sentence starts are refused.
3. **An accepted justification is a verdict, not a rule.** It is already in every prompt
   with its finding, and already outlives its review through the verdict table.

**And the reader is now part of what a rule depends on.** `source_blob` enforced *a rule
must not outlive its text*; nothing enforced *nor the reader that produced it*, so
narrowing the extractor would have changed nothing already stored — re-ingestion
triggers on the document, and no document changed. Every ingested rule now carries the
extractor version, and an older stamp retires it. `ingestDocs` runs on every review, so
the store heals itself on the next one.

**Why nobody had seen this.** Eleven folders of models reviewed `src/` in the `propose`
sweep and not one of them looked at the database, because they were pointed at the code.
I measured the machine — 0 suppressions, 0 dead exports, 745 tests — and never opened the
output. `refactor.md` is a document about a program; the program's product is a table.

**D-75 — `propose` generates ideas for the maintainer, and is not part of the ladder.**

Every review this service performs is **diff-scoped**. Nobody ever asks about the
whole, which is why on 2026-08-06 lore found almost nothing wrong with lore: the
client found defects by using it and the maintainer found the rest by measuring, while
the ladder found none of them, because none of them were in a diff.

`lore propose` is the deliberate opposite of a review. It asks the dearest models an
open question — *what would you change about this codebase if you could change
anything?* — spends a great deal of quota doing it, and produces **suggestions a human
appraises**. Run rarely, for inspiration, never on a merge.

**It is a generator, and it is not made safe by being constrained.** The obvious design
is to make each idea a finding with `evidence` and `failureScenario`, reusing the
ladder's machinery. That is the wrong instinct and it was the first one tried: a
finding schema is a **conservatism device**, and forcing a model to be defensible makes
it boring in exactly the dimension this tool exists to explore. The filter here is a
person, deliberately, and everything below is about making that person's job possible
rather than about making the model behave.

**Buy the maximum, not the average.** The value of an idea generator is its best
output, not its mean, and that inverts the usual design:

- **N models, one idea each — never one model asked for thirty.** Asked for a list, a
  model pads to fill the count and the padding is generic. Asked for the single change
  it would make if it could make only one, it answers with what it believes.
- **Lenses are forced apart.** The same question to three models returns three versions
  of the safe answer. Each proposer gets a different vantage — the data model, the
  failure modes, the seams, and one told it has six months and no compatibility
  constraint. **Consensus here is a smell, not a signal**: agreement means the question
  was too easy, and the ideas worth having are the ones only one model saw.
- **A different vendor attacks each proposal.** D-1's independence premise applied to
  ideas rather than code, and it does most of the filtering for nothing: *"add a
  repository pattern"* dies the moment a model that did not write it is asked what the
  change costs and what the repository already says.

**Every proposal carries its own kill criteria, and this is the load-bearing part.**
Not evidence — that is the conservatism trap again. Four fields, of which the last
matters most:

- what would have to be **true** for this to be worth doing
- what it **costs if wrong**
- what in the repository **contradicts** it
- **what one measurement would settle it**

A proposal that cannot name its own falsifying measurement is one nobody can appraise,
and that is precisely the kind that costs a fortnight. The motivating case is the
session that produced this decision: a large refactor was proposed, `wc -l` and a
twenty-line export-reachability script killed it in ten minutes, and the measurement
was the entire appraisal. **The danger is never a bad idea — it is a plausible one.** A
bad idea dies in five seconds; a plausible-but-wrong one eats a fortnight, and this
project's whole defect history is confident false statements. So `propose` is built to
be *hard to be convinced by*, not persuasive.

**The knowledge base screens before a human reads anything.** This is the one filter
that removes ideas without blunting them, because it removes only the ones already had:
a proposal to split `store.ts` arrives annotated *"considered 2026-08-06, rejected
because…"* rather than landing fresh. Everything rejected is written back as a decision
record, so the second run is cheaper than the first and the same idea cannot cost the
same appraisal twice.

**Two boundaries, both hard.**

It **never produces a finding, never gates a merge, never attests, and never enters the
review path.** That separation is exactly what makes it safe to be reckless inside it.
The moment an unconstrained idea can reach a `passed`, the one output whose entire
value is that it can be trusted is contaminated.

And it **runs beside the gate, bounded by its required budget — revised 2026-08-13.**
It refused to start while any review was queued or running from the day it shipped,
on a measured fear: our largest t2 review sent 203,904 cached tokens, a whole-repo
question has no diff to anchor exploration, and eight such sessions could empty a
rolling subscription window — stalling every review in the system. Vany overruled the
refusal while waiting on it, and the ground had moved under the fear: a tier's quota is
a pool of subscriptions with a fallback chain behind it (D-93), so a burst degrades a
review to its next route rather than to nothing — and D-98 had already removed every
other invisible wait on the argument that backpressure belongs at the door. On a busy
day the refusal did not protect the gate; it meant propose simply never ran.

**CLI, not MCP** (D-16). It is run by the maintainer, rarely, and its output is read by
a person — so it needs no tool description, no client contract and no place in the
agent docs. It writes a dated document into `proposals/`, beside `research/`.

**Built 2026-08-07, with three parameters Vany added and one constraint.** `--folder`
(default the repository root), `--commit` (default the head of `master`, cut from the
mirror), `--mode` from the review-type vocabulary. The constraint is `preserves`: every
proposal states what must keep working identically and how a person would check, because
*"keep the overall functionality"* is what separates a refactor tool from a redesign one.
A model asked to improve something will, given room, improve what it is FOR.

**And the folder is the subject, not the boundary.** A proposer reads outward — callers,
dependants, the specs that govern the code — because a proposal about a folder made
without reading its callers is a proposal about code nobody uses. But the change must
land inside, or the idea is dropped with its reason. Without that rule a folder-scoped
run silently becomes another whole-repo run, which is what a model does unprompted.

`[OPEN]` — **nothing has run yet.** Whether these models produce *good* architectural
ideas is entirely unmeasured, and this is the output most likely to be plausible and
useless. It is the best first customer for the measurement harness rather than a reason
to skip it.

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

**D-71 addendum — part of the reviewer's instructions live outside this repository.**
`[OPEN]`

D-12 and D-47 make reviewers inherit the operator's own opencode configuration, so
that a reviewer has what a Claude Code session has. The consequence, unnoticed until
2026-08-06: **the `readonly` agent definition — the prompt every reviewer runs under —
is not in this repository.** lore's ladder never reviews it, no test covers it, and a
decision here cannot reach it.

D-71 removed test execution and updated `src/reviewer/prompts.ts`. The agent file still
said *"explores, runs tests"* in its description and *"You explore the codebase, run
tests"* in its body, while carrying `bash: true` — so every reviewer afterwards was
instructed to do the one thing that had just been removed, holding the tool to do it.
Not proven to have happened; the one session whose tool use is still in the logs made
53 bash calls to 13 reads, and the instruction was there for all of them.

`sync-opencode.sh` refuses to stage an agent file that instructs running tests, which
is the same shape as its INV-8 refusal and for the same reason: a check that only warns
is a comment. It matches **per clause on a flattened file**, and both simpler versions
were wrong in ways worth keeping:

- matching the line refused the *corrected* file, whose point is the sentence "do not
  run the project's test suite";
- dropping any line containing a negation let the *original* through, because
  `explores, runs tests, never edits files` carries a "never" belonging to a clause
  about editing.

That is `knowledge/conflict.ts`'s lesson arriving in a build gate — negation binds to
its own clause, and cancelling it across a statement makes a compound sentence come out
as its own opposite. The instruction also **wraps across a line break** in the original,
so anything working line by line cannot see the very file it exists for.

`[OPEN]` — the check covers the one claim that has actually gone stale. Nothing yet
covers the general problem, which is that an operator's local edit can change what
every reviewer is told without any of this project's machinery noticing. Owning the
file here would break D-12 deliberately, so the question is what else is worth pinning.

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
developers; it returns information and the client decides what deserves an alarm. That
was once forced by the protocol as well; since D-80 it is not — lore *can* wake a
subscribed client — and it remains true as a decision: waking a client is not the same
as deciding something is urgent, and the client still owns that judgement. Our
obligation is to make urgency **machine-classifiable** — explicit `severity`,
`needs_human` as its own state, `fast_clean`/`failed`/`expired` never blended into
"not passed" — so a client never infers urgency from prose.

Separately, `lore` alerts **devops about itself**: replication behind, provider auth
dead, spend ceiling hit, reviews failing as a class, `needs_human` ageing. One review
failing is a log line.

**Disk is not on that list, deliberately, and no part of it is.** The host conditions
went on 2026-08-06: a full disk belongs to whoever owns the machine, exactly as a failing
test suite belongs to whoever owns the repository (D-71) — lore alerted in red about a
condition it neither caused nor could fix. A budget on lore's OWN footprint replaced them
and was removed on 2026-08-12, Vany's call: *"it is not lore's responsibility."* That the
sandbox cache grows without bound is true and remains true; what does not follow is that
lore should raise a ticket about it. Sizing this machine and acting on it are the
operator's, they have better tools for both, and a ticket on every beat for a threshold
nobody agreed to only teaches the reader to skip the channel. **What actually bounds the
growth is the retention sweep, which is not an alert.** `spec/operations.md` §2.5 carries
the whole argument, including the outage that measuring it once caused.

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
5. *(answered 2026-08-06)* Token rotation: `make new` mints, `make revoke
   TOKEN=<short>` retires, and the two overlap — a client keeps working on the old
   token until it is revoked, so rotation is issue, paste, revoke, in that order and
   with no outage. Revocation is by hash prefix because the secret is shown once and
   never stored; `spec/mcp-api.md` §1.
6. What happens when two reviews on one repo produce contradictory knowledge? The
   conflict is recorded (`spec/knowledge.md` §6), but nothing resolves it yet.
