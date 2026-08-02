# AI code review: what the products do, and which models to use

**Verified 2026-08-03.** Model IDs from `opencode models` on this machine (360
available). Benchmarks fetched from Artificial Analysis. Product architecture from
CodeRabbit's docs and Greptile's engineering blog. `WebSearch` was unavailable all
session (harness error), so nothing here comes from search results — every claim
below traces to a fetched page or a command run locally.

---

## 1. What CodeRabbit and Greptile actually do

The two things worth copying are not model choices.

### 1.1 Deterministic tools run first, and do most of the work

CodeRabbit integrates **50+ linters and analyzers** — ESLint, Ruff, Semgrep, Trivy,
Pylint, Clippy, RuboCop, `oasdiff` for breaking API changes — alongside the LLM,
plus AST pattern rules via `ast-grep` and CI/CD signal through GitHub Checks.

The lesson: **an LLM should never be paid to do what a typechecker does for free,
deterministically, in one second.** Anything `tsc` or ESLint can decide is decided
before a token is spent. This both cuts cost and — more importantly — removes the
mechanical noise that otherwise crowds out real findings.

### 1.2 Executing the code beats reading it

Greptile's **TREX** is "an execution layer for AI code review that actually runs
the code," built explicitly because static reading misses a class of bug. Their
framing: they moved *beyond* static analysis, not around it.

### 1.3 Agentic review beats diff-in-a-prompt

Greptile's v3 rewrite adopted "an agentic approach to code review" and reports
**70.5% higher acceptance rates** with substantially better quality metrics.

This directly condemns the `~/c/review` pattern (paste the diff into a prose
prompt). The reviewer should hold tools and explore the repo.

### 1.4 Noise is a first-class engineering problem

Greptile has a whole post titled *"How to Make LLMs Shut Up"* (URL guessed and
404'd — **unread**, worth finding). They also note *"codebases are uniquely hard to
search semantically."* Their product decisions come from analysing **700K+ pull
requests monthly**.

### 1.5 Independence is a product principle, not just our preference

Greptile: *"Software Needs An Independent Auditor"* — arguing for separation
between code generation and code review to avoid a conflict of interest.

A company with 700K PRs/month of data reached SPEC D-1 independently. This is the
strongest external validation we have for keeping reviewers off the author's model.

### 1.6 Learnings persist

CodeRabbit lets teams *"teach CodeRabbit your review preferences using
natural-language chat"*, detects code guidelines from repo files such as
`.cursorrules`, supports path-based instructions via glob patterns, and exposes
learnings over an API. It also caches code and dependencies to speed reviews up.

This is the same idea as SPEC D-9 (the learnings database) — arrived at from the
other direction.

---

## 2. Model landscape, August 2026

From Artificial Analysis. **Caveat: "cost/task" is what their harness spent
completing benchmark tasks, not a per-token price**, and their coding measure is
SciCode — which is not PR review. Treat these as *relative* quality signals, not as
a review-quality ranking.

| Model | Intelligence | Speed t/s | Cost/task | Context |
|---|---|---|---|---|
| Claude Opus 5 (max) | 61 | 54 | $2.34 | 1M |
| Claude Opus 5 (xhigh) | 60 | 52 | $1.80 | 1M |
| **GPT-5.6 Sol (max)** | **59** | 68 | $1.86 | 1M |
| Claude Opus 5 (high) | 59 | 53 | $1.23 | 1M |
| GPT-5.6 Sol (xhigh) | 58 | 64 | $1.17 | 1M |
| **Kimi K3 (max)** | **57** | 35 | **$0.86** | 1.05M |
| Claude Opus 5 (medium) | 56 | 52 | $0.72 | 1M |
| GPT-5.6 Sol (high) | 56 | 59 | $0.77 | 1M |
| GPT-5.6 Terra (max) | 55 | 134 | $0.73 | 1M |
| **GLM-5.2 (max)** | **51** | 148 | $0.69 | 1M |
| **Gemini 3.6 Flash** | **50** | **212** | $0.56 | 1M |
| Qwen3.7 Max | 46 | 203 | $1.28 | 1M |
| DeepSeek V4 Pro (max) | 44 | 57 | **$0.05** | 1M |
| MiniMax-M3 | 44 | 91 | $0.14 | 1M |
| DeepSeek V4 Flash | 29 | 117 | $0.03 | 1M |

### 2.1 ~~Why GLM-5.2 was dropped~~ — RETRACTED, see §2.1a

The original argument used Artificial Analysis's **cost/task** to conclude GLM-5.2
was dominated by Gemini 3.6 Flash. **That was the wrong metric**, and §2.1a
overturns it. Kept here so the mistake is visible rather than quietly edited away.

### 2.1a Actual per-token pricing — verified 2026-08-03

From OpenRouter's public models API (`GET /api/v1/models`), so these are prices, not
a benchmark's spend:

| Model | Int. | $/M input | $/M output | context |
|---|---|---|---|---|
| **GLM-5.2** | 51 | **0.28** | **0.89** | 1.05M |
| GPT-5.6 Terra | 55 | 1.00 | 6.00 | 1.05M |
| Gemini 3.6 Flash | 50 | 1.50 | 7.50 | 1.05M |
| Gemini 3.5 Flash | — | 1.50 | 9.00 | 1.05M |
| Kimi K3 | 57 | 3.00 | 15.00 | 1.05M |
| GPT-5.6 Sol / Sol Pro | 59 | 5.00 | 30.00 | 1.05M |

**GLM-5.2 is 5.3× cheaper on input and 8.4× cheaper on output than Gemini 3.6
Flash, while scoring one point higher.** The earlier conclusion was exactly
backwards.

**Gemini 3.6 Flash is dominated twice:** GLM-5.2 is cheaper at equal capability,
and GPT-5.6 Terra is *both* cheaper ($1/$6 vs $1.50/$7.50) *and* stronger (55 vs
50). It has no remaining niche.

#### What went wrong

Artificial Analysis's "cost/task" is **tokens consumed × price** on their eval
suite, not a price. GLM-5.2 costing $0.69/task at $0.28/M input means it emits a
great many tokens — heavy reasoning. Reading that as "expensive per token" was a
category error.

The caveat that survives: **cheap tokens × many tokens can still add up.** Whether
GLM's verbosity eats its price advantage on *our* workload is unknown and is now
the specific thing T1 must measure — tokens spent per review, alongside defects
found.

#### Why our workload differs from the benchmark

A reviewer reads a lot and writes a little: a diff, ten explored files and the
knowledge context in; a small findings record out. **Input tokens dominate**, and
that is the axis where GLM is cheapest. AA's tasks are code *generation*, which is
output-heavy — the opposite shape.

### 2.1b Vendor diversity is worth paying for

Three tiers from two vendors share blind spots. GPT-5.6 Terra and Sol Pro are the
same family, so a ladder of GLM → Terra → Sol is really two independent opinions,
not three.

Kimi K3 costs 3× Terra for 2 more points of intelligence — poor value on capability
alone, but it buys a **third distinct vendor**. Since the entire premise of the
ladder is independent perspectives (D-1), that is worth the money.

### 2.2 The effort knob is a bigger lever than the model

GPT-5.6 Sol: **max = 59 at $1.86**, **high = 56 at $0.77**. Same model, 95% of the
intelligence for 41% of the cost. Reasoning effort deserves to be a first-class
tier dimension, not a constant — SPEC's ladder should escalate *effort* before it
escalates *model*.

### 2.3 Free models exist, including code-specialised ones

`opencode models` lists free options on the `opencode/` provider:

| id | note |
|---|---|
| `opencode/north-mini-code-free` | Cohere, code-specialised |
| `opencode/laguna-s-2.1-free` | poolside, code-specialised |
| `opencode/mimo-v2.5-free` | Xiaomi MiMo |
| `opencode/ling-3.0-flash-free` | inclusionAI |
| `opencode/nemotron-3-ultra-free` | NVIDIA 550B |
| `opencode/deepseek-v4-flash-free` | DeepSeek V4 Flash (29 int) |

Given the requirement is *"a lot of runs against the improved code"*, a **free gate
tier** is worth measuring. None of these are benchmarked above except DeepSeek V4
Flash (29 — weak). Unknown until tested, but the downside is zero.

---

## 3. Chosen lineup — revised 2026-08-03

Model IDs verified present in `opencode models`; prices from OpenRouter's API.

| Tier | Purpose | Model | Int. | $/M in | $/M out | vendor |
|---|---|---|---|---|---|---|
| **T0** | deterministic | *the target's own* `tsc`, ESLint, tests, `ast-grep` | — | free | free | — |
| **T1** | cheap gate | `openrouter/z-ai/glm-5.2` | 51 | 0.28 | 0.89 | Z.ai |
| **T2** | main reviewer | `openrouter/moonshotai/kimi-k3` | 57 | 3.00 | 15.00 | Moonshot |
| **T3** | adversarial | `openrouter/openai/gpt-5.6-sol-pro` | 59 | 5.00 | 30.00 | OpenAI |

Three tiers, three vendors, ascending capability, cheapest possible gate (§2.1b).

**Dropped: `google/gemini-3.6-flash`** — dominated on both price and capability
(§2.1a). **Restored: `z-ai/glm-5.2`**, which should never have been cut.

Alternative worth measuring: `gpt-5.6-terra` (55 int, $1/$6, 134 t/s) instead of
Kimi K3 at T2 — 3× cheaper and 4× faster, at the cost of sharing a vendor with T3.

## 3.1 Estimated cost per review

**Estimates, not measurements.** Token counts are assumed; T1 replaces them with
real numbers.

Assume one pass ≈ 55k input (diff + ~10 explored files + knowledge) and 8k output:

| Tier | per pass |
|---|---|
| T1 GLM-5.2 | ~$0.02 |
| T2 Kimi K3 | ~$0.29 |
| T3 Sol Pro | ~$0.52 |

A converging review — five T1 passes (every fix resets the ladder), two T2, one T3
— lands near **$1.20**. At 100 reviews/month that is **~$120**.

For comparison, a single ChatGPT Pro seat is $200/month and would cover one tier
for one user with no parallelism. **The usage is cheaper than the subscription**,
which is the whole answer to the subscription question.

Two things that could break this estimate, both in the same direction:

- An agentic reviewer that explores widely could use 200k+ input per pass, ~4×.
- Heavy reasoners emit far more output than assumed (§2.1a).

And one that cuts the other way: **prompt caching** — see §3.2, which turns out to
be the largest lever available.

## 3.2 Prompt caching is the real cost lever

Cache-read prices from OpenRouter's API, verified 2026-08-03:

| Model | input | **cache read** | discount |
|---|---|---|---|
| `z-ai/glm-5.2` | $0.2842/M | **$0.0528/M** | 5.4× |
| `moonshotai/kimi-k3` | $3.00/M | **$0.30/M** | 10× |
| `openai/gpt-5.6-sol-pro` | $5.00/M | **$0.50/M** | 10× (write $6.25/M) |

Every round of the loop re-reads mostly the same repo context — the same files, the
same knowledge, the same settled findings — with only the diff changing. That is
precisely the shape caching exists for.

Re-estimating a pass at 45k stable context + 10k fresh + 8k output:

| Tier | no caching | cached |
|---|---|---|
| T1 GLM-5.2 | $0.023 | **$0.012** |
| T2 Kimi K3 | $0.285 | **$0.164** |
| T3 Sol Pro | $0.515 | **$0.313** |

A converged review drops from **~$1.20 to ~$0.70**. Caching is not an optimisation
to add later; it is most of the cost model.

### 3.2.1 Output dominates the expensive tiers

With input cached, T3 costs $0.07 of input against **$0.24 of output** — 77% of the
bill is what the model *writes*.

This makes the structured-findings rule (`spec/review-ladder.md` §3) a cost control
as well as a design one. A reviewer that writes essays instead of records costs
several times more, at every tier, forever.

### 3.2.2 The 272k cliff on Sol Pro

`gpt-5.6-sol-pro` carries a pricing override: above **272,000 prompt tokens**, rates
double to **$10/M input and $45/M output**.

The model advertises a 1.05M context, so nothing stops a wide-ranging agentic review
from sailing past 272k and silently doubling the most expensive tier's price. T3
context must be measured and capped below that line, and exceeding it should be a
logged event rather than a surprise on the invoice.

## 3.2.3 Real volume — corrected 2026-08-03

The earlier "100 reviews/month" was invented, and the first correction to it was
still too low. Vany's actual figures: **20 reviews in a weekend**, and **~30 PRs on
a working day**. Solo. This is a workgroup, so multiply.

Per review, cached: T1 $0.06 (5 passes), T2 $0.33 (2), T3 $0.31 (1) = **$0.70**.

| devs | reviews/mo | T1 | T2 + T3 | **total/mo** |
|---|---|---|---|---|
| 1 | ~740 | $44 | $474 | **$518** |
| 3 | ~2,200 | $132 | $1,408 | **$1,540** |
| 5 | ~3,700 | $222 | $2,368 | **$2,590** |

(22 working days at 30/day, plus weekend activity.)

Three consequences.

**Cost is a first-order design constraint.** This is a $500–2,600/month tool. Every
structural choice that changes tier invocation counts is worth real money, and
`usage` logging (D-13) is load-bearing rather than nice-to-have.

**Uncached, multiply by ~1.7** — $880/month solo, $2,600 at three developers. D-29
is not an optimisation, it is the difference between viable and not.

**Latency matters as much as price.** 30 reviews a day cannot queue behind each
other. Throughput, per-provider concurrency and the operator status view (D-26) stop
being polish — and any quota-metered plan becomes actively dangerous, because a
burst of 30 PRs is exactly when the window empties.

### 3.2.4 A large error bar, in the useful direction

The $0.70 assumes ~55k input per pass — a substantial diff plus wide exploration.
**30 PRs a day implies small PRs**, and a small diff means a smaller read and less
exploration. Real cost could plausibly be $0.30–0.50, halving every figure above.

It could equally be worse: a wide-ranging agentic reviewer on an unfamiliar module
can burn far more than 55k. The estimate is soft in both directions and only T1's
measurement settles it. Nothing expensive should be bought on these numbers.

## 3.3 Should we buy the Z.ai coding plan for T1?

**No.** GLM sits at T1 and therefore takes most of the *calls* — but load and cost
are different distributions.

Per converged review (5 × T1, 2 × T2, 1 × T3, cached):

| Tier | share of calls | share of cost |
|---|---|---|
| T1 GLM-5.2 | **62%** | **9%** |
| T2 Kimi K3 | 25% | 47% |
| T3 Sol Pro | 13% | 45% |

The cheap tier is cheap. Subsidising it optimises the smallest line on the bill.

**On price, it depends on volume — break-even is ~300 reviews/month.** GLM Coding
Plan Lite is **$18/month** (verified 2026-08-03: 2,000 credits per 5 hours, 10,000
per week; GLM-5.2, GLM-5-Turbo, GLM-4.7).

| devs | reviews/mo | T1 tokens | vs $18 plan |
|---|---|---|---|
| 1 | 220 | $13 | plan loses $5 |
| 3 | 660 | $40 | plan saves $22 |
| 5 | 1,100 | $66 | plan saves $48 |

So above roughly 300 reviews/month the plan does win on price — **and it barely
matters.** The saving is $22–48 against a $460–770 bill: **5–6%**. Buying it
optimises the wrong 9% of the invoice while adding a second provider, a second auth
path, and a quota that can stall the system.

**What "credits" means is unverified.** The docs say credits, not tokens or
requests. If they are token-denominated, a heavy-reasoning model like GLM-5.2 could
burn the weekly allowance far faster than a per-request reading suggests. Nobody
should buy this plan without knowing which it is.

**The quota structure is worse than the price.** The plan enforces a **5-hour
rolling window** and a weekly cap. T1 is the highest-volume tier *and* the gate every
review must clear before reaching T2 or T3. Exhaust that quota and **every review in
the system stalls**, for up to five hours, including ones that would have passed.

Putting the highest-throughput, most latency-critical tier on the most
quota-constrained billing model is backwards. If any tier ever justified a flat rate
it would be T2 or T3, where the money actually is — and those carry the seat-licence
problem instead.

Unverified: whether Z.ai's terms permit backend or shared use. Their docs do not say,
and a Team Plan exists, which implies the individual plan is not meant for it.

**If it is bought anyway**, it must have an **announced overflow** to per-token
OpenRouter when the window is exhausted — never a stall, never a silent switch
(`PROG.md`: no silent fallback). That is cheap to build precisely because the
OpenRouter key exists regardless.

## 3.4 Where the leverage actually is at this volume

T2 + T3 are **91% of spend at every volume**. Three levers, in order of size:

### 3.4.1 Caching — decided (D-29)
~1.7× on the whole bill. Worth ~$330/month at three developers. Already the plan.

### 3.4.2 T3 always runs — decided, and not a cost lever
**Vany's call:** *"run it always but at final, not bother it with stupid mistakes,
code must be almost fixed."*

So conditional or sampled T3 is off the table. The attestation keeps its strongest
meaning — **every tier agreed** — and does not degrade to "the tiers we chose to
run agreed". At 44% of the bill that is a deliberate purchase of certainty, which is
the right way to spend money on a tool whose entire output is a claim about quality.

It also states the ladder's premise more sharply than the spec did: **the expensive
tier's job is not to find everything, it is to find what two independent reviewers
missed.** That has a design consequence — see D-31, tier prompts by position.

T1's measurement should still record what T3 catches that T2 missed. Not to justify
cutting it, but because a near-zero number would mean T2 and T3 are duplicating each
other, which is a *quality* problem: two tiers with the same blind spot are one tier
being paid for twice.

### 3.4.3 Fewer rounds
Every fix resets the ladder to T1 (D-6), so round count multiplies everything. The
knowledge layer should reduce rounds over time as recurring mistakes stop being
made — which makes `spec/knowledge.md` a cost lever as well as the product.

**Not chosen but noted:** Claude Opus 5 leads the table at 61. It is excluded by
SPEC D-1, because Claude writes the code under review. Independence costs us the
best model on purpose (§1.5 says this is the right trade).

---

## 4. Local toolchain for the T0 layer

Verified on this machine 2026-08-03:

| tool | status |
|---|---|
| `ast-grep` / `sg` | **present** (`/opt/homebrew/bin`) |
| `tsc` | present (per-project) |
| `semgrep` | **missing** |
| `eslint` | **missing globally** — correct; see below |
| `knip` | missing |

**Design consequence: T0 runs the *target repo's* tooling, not ours.** A repo's own
`tsc`, ESLint config and test script are what that project actually enforces;
running our config against someone else's code manufactures findings the team has
already rejected. `lore` detects and invokes what the target has, and reports
plainly when a target has none.

`node:sqlite` is built into Node 26 and works (verified) — the learnings store
needs no dependency.

---

## 5. Open items

1. Greptile's *"How to Make LLMs Shut Up"* — **not read**, URL guessed wrong.
   Their noise-suppression technique is the most directly applicable thing they
   have published. Find and read it.
2. No benchmark here measures *code review* specifically. SciCode measures code
   generation. Our own measurements on real branches are the only trustworthy
   ranking (TODO T1).
3. Free-tier model quality (§2.3) is unmeasured.
4. Whether OpenRouter's `:free` variants carry rate limits that make them useless
   for high-volume runs.
