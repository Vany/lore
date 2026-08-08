# The review ladder

How a single review escalates. Model choice rationale:
`research/ai-code-review-landscape.md`.

---

## 1. Tiers

Cheapest → dearest. Each is a *gate*: dearer tiers only see code the cheaper ones
already passed.

| Tier | Purpose | Engine | Int. | $/M in | $/M out | vendor |
|---|---|---|---|---|---|---|
| **T0** | deterministic | the **target repo's own** `tsc`, ESLint, `ast-grep`, semgrep | — | free | free | — |
| **T1** | cheap gate | `openrouter/z-ai/glm-5.2` | 51 | 0.28 | 0.89 | Z.ai |
| **T2** | main reviewer | `openrouter/moonshotai/kimi-k3` | 57 | 3.00 | 15.00 | Moonshot |
| **T3** | adversarial | `openrouter/openai/gpt-5.6-sol-pro` | 59 | 5.00 | 30.00 | OpenAI |

**This table is the DEFAULT ladder, and a deployment usually replaces it.** `LORE_TIERS`
points at a tiers file that overrides every row (`core/ladder.ts`, `loadTiers`), and
what is deployed today is `deploy/tiers.zai-kimi-openai.json`:

| Tier | Model | Effort | Vendor | Paid by |
|---|---|---|---|---|
| **T1** | `zai-coding-plan/glm-5-turbo` | medium | Z.ai | subscription |
| **T2** | `kimi-for-coding/k3` | high | Moonshot | subscription |
| **T3** | `openai/gpt-5.6-terra` | high | OpenAI | subscription |

**Three vendors, one per tier**, which is what D-32 and D-49 have always asked for and
the deployment did not have until 2026-08-06: T1 and T2 were both Z.ai, so two thirds of
the ladder shared a blind spot. Nothing was reported falsely — D-49's sole-vendor check
only fires when EVERY tier is one vendor — but the independence was thinner than the
ladder implies. Read the tiers file for what is actually being spent, and `SPEC.md` D-54
for why T1 moved.

**`k3`, not `k3-256k`.** The suffix names the SMALLER variant: `k3` carries 1,048,576
tokens of context and `k3-256k` carries 262,144. The largest review this deployment has
run sent 204,609 tokens — 78% of the smaller window, with no room for a reply. Chosen on
the measurement rather than on the name, which reads the wrong way round.

Saying so because an operator consulting "the ladder" to approve a cost or diagnose a T1
failure would otherwise conclude GLM-5.2 was called when GLM-5-turbo was — the table was
accurate about the default and silent about being overridden, which reads the same as
wrong (43cd1237).

Tiers are configuration, not code.

**Three tiers, three vendors — deliberately.** Two tiers from one model family
share blind spots and are not two independent opinions. Kimi K3 is poor value on
capability alone (3× the price of GPT-5.6 Terra for 2 more points), but it buys a
third distinct vendor, and independence is the premise of the whole design (D-1).

### 1.1 T0 is not a model, and that is the point

CodeRabbit runs 50+ analyzers alongside its LLM. **An LLM must never be paid to
decide what a typechecker decides for free, deterministically, in one second.**

T0 runs **the target repository's own tooling** — its `tsc`, its ESLint config, its
test script — never ours. A project's config is what that team actually enforces;
imposing ours manufactures findings they have already rejected. If a target has no
tooling, `lore` says so plainly rather than substituting its own opinion.

T0 also removes the mechanical noise that would otherwise crowd out the findings
only a model can produce.

### 1.1.1 T0 does NOT execute the target's tests (D-71)

lore **reads** a test suite — whether the change is covered, whether a test asserts
what its name claims, whether a fix arrived without one — and never runs it. That
reading is a model-tier job and one of the more valuable things the ladder does.

A suite that fails belongs to whoever owns the repository, and their CI already tells
them. Running it here meant executing an arbitrary dependency tree on the review host
to rediscover a fact its owner has, and then reporting it as though lore had found
something. The cost was real and the finding was not ours to make.

**The sandbox stays, and D-24 still applies to it.** `tsc` and `eslint` resolve their
binaries out of the target's `node_modules`, so the *install* still runs — and an
install runs lifecycle scripts, with network. That is what the ephemeral container
contains now:

- no secrets mounted — no tokens, no signing key, no database, and no git credentials,
  because there are none in the deployment to mount (D-65)
- no network during the run, and every capability dropped
- read-only root filesystem apart from the worktree
- **runs as lore's own uid, not root** — an ownership guard rather than a security one:
  the cache and scratch directories are reused across reviews, and root-owned leftovers
  break the next review with a permission error in a directory it owns
- CPU, memory and PID limits, and a hard timeout
- destroyed after the run

### 1.1.2 A tier is told where it stands (D-31)

The same prompt at every tier wastes the expensive ones. A tier's position *is*
information, and withholding it means T3 spends its budget re-deriving what T1
already established.

- **T1** — broad sweep on code that only deterministic tooling has seen. Expect
  obvious defects; report them cheaply.
- **T2** — T0 and T1 found nothing new here. The easy defects are gone; look at
  design, seams, and what the tests do not cover.
- **T3** — *"Two independent reviewers, from different vendors, found nothing left.
  You are the last line. The remaining defects are the ones a careful reader misses:
  a lifecycle claim no test exercises, a race that needs two things to happen at
  once, a decline path that leaves state behind. Do not re-report style or anything
  a typechecker would catch — that work is done."*

This follows directly from Vany's framing: *don't bother it with stupid mistakes,
the code must be almost fixed.* The ladder already guarantees that; the prompt has
to say so, or the model does not know it.

### 1.2 Escalate effort before model

GPT-5.6 Sol scores 59 at max effort and 56 at high — 95% of the capability for 41%
of the cost. The ladder walks `(model, effort)` pairs, not models.


### Quota arrives as a hang, because opencode swallows the refusal (D-84)

Quota is detected from a status code — `429`, `402`, or a message matching
`rate.?limit|quota|insufficient`. **None of them reaches lore when a Z.ai plan is
exhausted**, and the reason is not the provider.

Measured 2026-08-09 in two passes, and the second corrected the first. Through lore's SDK
path: `kimi-for-coding/k3` answered in 4s, `openai/gpt-5.6-terra` in 3s, and both Z.ai
models never answered at all. Asked DIRECTLY, bypassing opencode, Z.ai answers instantly
and completely:

```
HTTP 429
{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted.
           Your limit will reset at 2026-08-10 18:19:09"}}
```

So the provider names the limit, which limit it is, and the exact reset time. **opencode
is what answers nothing**: the assistant message it leaves carries no error, no retry part
and no `finish`. It swallows the 429 whole. The `X-RateLimit-*` headers belong to the
open-platform RPM/TPM path; the Coding Plan puts everything in the body, and neither
endpoint sent any headers.

So the one signal the classifier depends on is absent in exactly the case it exists for,
and the condition arrives as a **hang** — at the call site indistinguishable from a broken
provider or a slow one.

Two consequences, and neither is optional:

- **The hang deadline is load-bearing.** Until 2026-08-08 it could not fire at all
  (`http.request`'s `timeout` is socket-inactivity, and a streaming peer resets it), so an
  exhausted subscription simply consumed the review — a t2 ran 2h46m. The deadline is what
  turns an invisible stall into a bounded, reportable event.
- **The tier must be steppable on a hang, not only on a refusal.** That is D-48 widened:
  after its retry is spent, the tier's work passes up and the review finishes
  `passed_partial` rather than dying. Without it, a provider at its limit takes down the
  gate every review must clear.

**`skip_if_quota` is the part of this that IS built.** A tier carrying it skips on its
FIRST failure instead of spending a second attempt, because an exhausted plan does not
become available by asking again — Z.ai names the reset time in its refusal. It is set on
t1, the Coding Plan seat. Absent, a tier keeps the retry, since for a metered API a blip is
worth asking twice.

`[OPEN]` — lore cannot read a subscription's remaining quota; nothing here publishes one.
What it can do is notice the SHAPE — repeated timeouts from one provider while another
answers in seconds — and cool the tier off service-wide for the window rather than
re-discovering it once per review. Z.ai's plan is a 5-hour rolling window (D-5/D-17), so
exhaustion is temporary and self-healing; today `unavailable` is per-review, so every new
review pays two dead attempts to learn what the service already knew. SPEC D-84 carries
the cost and the decision.

### A window a provider advertises is not always the window it enforces

`compactToFit` shrinks the diff to the tier that will read it, using the context limit
opencode reports from `/config/providers`. That is the right number to compact against
and it is not always the number that applies.

Measured 2026-08-07: `zai-coding-plan/glm-5-turbo` advertises **200,000 tokens**, so a
104 KB prompt sat well inside the computed budget and was sent unchanged — and the
endpoint answered `400 Prompt exceeds max length`. A subscription plan can cap a request
far below the model's nominal context, and nothing publishes that ceiling.

**So the refusal is classified as `TooLargeForTier`, not as a failure.** The difference
is the whole review: generic, it killed the run and six commits went unreviewed while t2
(1M) and t3 (500k) could each have held the diff comfortably. As a tier that could not
look, the ladder steps over it and finishes `passed_partial` — weaker evidence, honestly
labelled (D-48).

**It does not claim a limit it does not have.** The pre-call refusal names the window,
because there we computed that we would exceed it. This one says the provider refused it
and quotes what the provider said, because the number we hold is demonstrably not the
number that applies — printing it would invent the explanation. Quota is still checked
FIRST: an exhausted plan can answer with wording about limits, and stepping over a tier
for the wrong reason spends an escalation on a problem that waiting would fix.

## 2. Reviewers are agents, not prompts

Greptile's v3 went agentic and measured **70.5% higher comment acceptance**.
Pasting a diff into a prose prompt — what `~/c/review` does — is the weaker pattern
and is not inherited.

A reviewer gets the worktree, read-only tools, the diff as a starting point, the
relevant knowledge (`spec/knowledge.md`), and freedom to explore.

Reviewers run under the service's opencode configuration and inherit everything a
Claude Code session has — MCP servers, plugins, superpowers (D-12). **A reviewer
with less context than the author is not a peer.**

## 3. Findings

Structured records, never prose — prose cannot be deduped, tracked or adjudicated,
which is `~/c/review`'s central limitation.

**But a record in transport is a QUESTION in meaning** (D-79). A finding is something
the author missed and would be hurt by, put to them as: *fix this, or tell me why it is
not a problem.* Both are real answers, the reviewer may be wrong, and an accepted
justification is worth more than a compliant fix — it becomes a durable fact about why
the code is the way it is. An open finding carries `asks` saying so, because the record
shape alone reads as a verdict and clients treated it as one.

**Two tests gate reporting at all, and both must pass.**

- **Consequence.** Concrete inputs or state, then the wrong outcome. `failureScenario`
  is the *test*, not a field: if it comes out as "this is inconsistent" or "a reader
  might be confused", there is no finding. It used to be a required field, so a model
  wrote one for whatever it had already decided to report and a wording nit acquired a
  plausible consequence on the way out.
- **Missed.** Would the author, who knows what they meant and has just re-read this,
  still not have seen it? Not *is it subtle* — an off-by-one is obvious once pointed at
  and was still missed. The question is about the author, not the defect.

Prose clears the same bar rather than being excluded: documents are reviewable (D-11)
and drift is a real defect, but a prose finding must say **who is misled into doing
what**. The review that motivated this produced eleven findings, all correct, nearly
all wording — and one of them was a spec claim false because the *code* was wrong,
which is exactly the prose finding worth having.

**Reporting less is the job, not a failure to do it.** Every finding costs the author a
fix cycle, and a review spending them on observations is one they learn to skim — which
is how the real one gets skimmed too.

```jsonc
{
  "file": "src/pay/hold.ts",
  "line": 142,
  "severity": "high",
  "claim": "decline path leaves the hold active",
  "evidence": "hold released only in the success branch (hold.ts:142-151)",
  "failureScenario": "card declines → funds stay held until the 7d sweeper"
}
```

**An unparseable review is a failed review, not a clean one.** Parse failure → one
retry → loud failure. This is the most likely way a "green" run could silently mean
nothing.

**A finding the schema rejects loses its own line, not the batch (D-66).** The valid
findings in a reply are kept; each rejected one is logged in full and reported to the
client in `checks_skipped`, because *this tier looked at the code and said something
the review does not contain* is the same class of fact as an engine that could not
run. Discarding the whole reply dropped that defect **and** every valid finding beside
it, which is worse on the axis the rule was defending — five paid replies died that
way, the worst a forty-minute round whose single finding was correct, load-bearing,
and fourteen characters over the cap. A reply where **nothing** parsed is still a
failed round; there is no partial result to keep.

**A tool that needs project-authored rules is absent when they are missing, not
skipped.** `unavailable` means a check that should have run did not, and it only stays
worth reading while every entry is. `ast-grep` requires an `sgconfig.yml` no
repository lore has met, so it reported NOT RUN on every review for a check that never
existed — which teaches a reader to skim the list, including on the day it says the
test suite did not run. Optional engines are logged for the operator and left out of
the client's report. `tsc`, `eslint` and the suite stay gaps when they are missing,
because for a JavaScript project they are.

### 3.0.1 A justification is not part of the code it defends (D-73)

`lore-ok` lines are stripped before the scope hunk is hashed, so writing the marker —
or later losing it — never expires the reason. A real edit to the surrounding code
still does.

Without that, the annotation sat inside the hunk whose stability the justification
depended on, and justifying a finding invalidated the justification. One false positive
was justified and expired four times across nine rounds, cost 109 minutes of model
time, and ended on a bound.

### 3.1 Fingerprint

`sha256(normalized_claim ‖ file ‖ enclosing_symbol)`

Deliberately **not** the line number: lines shift under every edit, and a finding
that moved three lines down is the same finding. Severity is likewise excluded, so
a finding returning at raised severity after a rejected justification is recognised
as the same finding rather than as new work.

#### 3.1.1 What the fingerprint does *not* do

**It matches identical claims, not equivalent ones.** If T2 raises in different
words what T1 already settled, the fingerprint differs and the loop sees new work.

So termination bound 1 (§5) is weaker than first written. What actually holds the
line is:

- **the ledger in the prompt** — every reviewer is told what was already considered
  and why, and instructed to re-raise only with new evidence. That is a *prompt*
  defence, not a mechanical one, and it will sometimes fail.
- **bounds 2–4** — the per-tier round cap, global budget and quota, which are
  mechanical and do hold.

Discovered while implementing, and written down rather than quietly assumed. Two
candidate mitigations, neither built: a coarse similarity key of
`file ‖ symbol ‖ cwe` to catch paraphrases of the same weakness, or an explicit
dedup pass. Both wait for evidence from Phase 1 that paraphrase-churn actually
happens — measure before adding machinery.

#### 3.1.2 Short ids are ambiguous, and lookup must say so

`lore-ok[…]` carries the leading 8 hex, which is ~10k findings to a ~1% chance that
some pair shares a prefix. That is tolerable **only** because lookup by short id
treats ambiguity as an error rather than picking a winner — git's rule for short
object ids. Silently resolving to the wrong finding would close a defect nobody
examined.

### 3.2 Findings are presented worst first (D-50)

Every list of findings this service **hands to a client or a model tier** is ordered
**high, medium, low**, then by file, then by line, then by fingerprint. The last key
is unique within a review, so the same set of findings always comes back in the same
sequence rather than in whatever order the query plan happened to produce.

Two qualifications, because the sentence above was written unqualified once and was
wrong twice over:

- T0's findings carry **no fingerprint**, so their order is total only up to
  `(severity, file, line)`. `Array.sort` is stable, so ties keep the engine's order.
- The in-process comparator **approximates** the SQL rather than matching it: file
  comparison is JS UTF-16 against SQLite's BINARY, and they disagree above the BMP.
  It exists for lists the store never ordered, and re-sorting a store-ordered list is
  safe because the comparator is indifferent exactly where the store already decided.

This needs stating because the obvious spelling is wrong and looks right. `severity`
is stored as TEXT and SQLite orders TEXT lexicographically, so `ORDER BY severity`
means **high, low, medium**. Every findings query must rank explicitly; a query that
does not will present a low-severity finding above a medium one, and any consumer
reporting "the worst" from the first row will understate it.

**Order is a correctness property wherever a list is cut short**, and what a cut drops
is decided entirely by how the list was sorted. The T0 render caps the model prompt at
200 findings, so the order decides which facts about the tree the tier is given — not
which findings survive, since `runRound` records all of T0's regardless. Clients cut
too: `review_inbox` exists to be scanned rather than read, and an agent surfacing "the
top few" to a person is the intended use.

An unrecognised severity therefore sorts **first**, not last. It can only come from a
write that went around the schema — `severity` is plain TEXT with no CHECK constraint
— and last place is where a cut would silently discard it.

### 3.3 Verdicts, and what "settled" means

A verdict is append-only and there are three kinds. Only the **latest** one for a
fingerprint counts:

| verdict | closes the finding? |
|---|---|
| `fixed` | yes |
| `justified-accepted` | yes |
| `justified-rejected` | **no** |

`justified-rejected` leaves the finding open, and open in the worse way: the reviewer
read the reason and refused it, so the defect is still present *and* an argument for
it was trusted enough to be examined. A rejected justification is worse than a bug
nobody argued about.

**Latest, not any.** Verdicts accumulate, and a justification is invalidated when the
code it described changes (§4). A finding accepted and later rejected by that expiry
must read as open — matching any historical accepting verdict would leave it settled
for ever, which is precisely the rubber-stamping the expiry exists to prevent.

**One definition, used everywhere.** The set that closes a finding is declared once
and every view derives from it: the open-findings query, the settled-fingerprint set
the ladder steps on, and the per-finding shape `review_poll` returns. They are not
merely expected to agree — they must not be able to disagree. When they do, a
re-raised fingerprint looks fresh to the ladder (which resets) while the open query
excludes it and delivery has already happened, so the client is told `findings_ready`
and handed nothing, for ever, until a bound stops the review.

## 4. Justification is a proposal of lore, and the reviewer ratifies it

When the client believes a finding is wrong, it does not silently dismiss it. It
writes a comment at the site:

```ts
// lore-ok[a1b2c3d4]: bounded by the caller's schema check at api/route.ts:31,
// so a negative amount cannot reach here.
```

```ts
/**
 * Prose about the function.
 *
 * lore-ok[a1b2c3d4]: the block form, for a reason long enough to want a
 * paragraph. It ends at a blank ` *` line or at the closing delimiter, so it
 * cannot absorb the prose that follows it.
 */
```

```md
<!-- lore-ok[a1b2c3d4]: reason -->
```

Three forms, no more. A justification written in any other shape is not collected,
and a justification that is never read is the failure this mechanism exists to
prevent — it looks exactly like a client that never answered.

A file with no comment syntax at all — JSON, a lockfile, generated output — carries
its justification in **`.lore-ok.md` at the repo root** instead, in the markdown
form (D-57). That file is read on every round alongside the files findings point at.

The bracketed value is the first 8 hex of the fingerprint, which `lore` prints in
its report, so comment and finding link exactly.

**The reviewer, not the author, decides whether the reason holds** (D-10). On the
next pass the reviewer sees the comment in place and either:

- **accepts** — the finding closes and **the rationale becomes lore**: a recorded,
  reusable fact about why this code is the way it is; or
- **rejects** — the finding returns at **raised severity**, because a wrong
  justification means someone's *reasoning* was wrong, which is worse than a bug.

This is what keeps the independent-auditor property intact. If the reviewed party
could close its own findings, the loop would terminate when the client got
persuasive rather than when the code got correct.

It also leaves the *why* permanently in the source, where the next human reads it.

**The naming is not decoration.** Writing `lore-ok` is *proposing a piece of lore*;
the reviewer ratifies or rejects it. That makes the justification protocol and the
knowledge layer (`spec/knowledge.md`) one mechanism rather than two: an accepted
justification is not merely a closed finding, it is **how the codebase acquires a
new fact about itself**. Every argument the team wins with a reviewer becomes
something the next session already knows.

### 4.1 Verdicts go stale, and must

`scope` stores the file blob sha and a hash of the enclosing hunk at verdict time.
When that code changes the verdict is **invalidated** and the finding may
legitimately reappear.

Silently honouring a stale justification is how this design rots into
rubber-stamping. It is the failure I would most expect in six months.

### 4.2 A ratified justification carries between reviews (D-51)

This is the whole thesis of the product applied to one finding. When a later review
of the same repository raises a fingerprint this repository has **already** ratified,
and no model tier raised it this round, the justification is accepted without anyone
re-arguing it.

Three conditions, and all are load-bearing:

- **A model tier did not raise it.** If one did, it looked and objected, so the
  earlier ruling is contested and must be ruled on afresh.
- **The prior verdict has a `scope`,** and the code it described is still there. A
  carried justification obeys §4.1 exactly like a fresh one; carrying one blind is
  how the ladder rots into rubber-stamping.
- **The reason travels with it.** The recorded rationale names the original reason
  and the date it was *first* decided, so a reader knows the ruling was inherited
  rather than made by the tier named on the row.

The provenance does not accumulate. A justification surviving many reviews keeps one
line, not one per hop: the value of the field is the reason, and a wall of nested
provenance buries it.

## 5. Escalation and termination

- Tier produced **new** findings → report; the next pass runs **the same tier**, so the
  author's answer is judged by whoever asked the question (D-10).
- Tier produced **nothing new** → advance one tier. Top tier clean → **passed**.

"New" means a fingerprint not already settled, not a raw count. A tier that
re-raises three closed findings and nothing else is clean.

**A closed tier stays closed** (D-6, revised 2026-08-07). It used to reset to T1 on
every change, which meant the cheapest model ruled on the dearest model's findings —
four times in one review of this repository — and cost two rounds per deep finding.

**So `passed` is a narrower claim than it was, and the attestation says how narrow.**
Tiers below the cursor do not re-read the last diff. T0 runs every round, so the
deterministic engines see every fix; the model tiers below do not. `tier_run` records
the tree each run actually read, and the signed line names the tiers that read the tree
being signed — never every tier that ever ran, which would assert scrutiny the signature
does not cover.

### 5.1 Tiers that cannot be paid for (D-48)

A provider refusing on quota marks that tier **unavailable** and the ladder steps
over it. When every tier that could run agrees, the outcome is `passed_partial`
rather than `passed`: *we did everything we can*.

This is not a softening of INV-1. The review *ran* — it simply ran shorter than
configured, and the result says so in its own state, its own exit code, and its own
attestation line. What INV-1 forbids is a review that did not run being reported as
one that found nothing; a review that ran three of four tiers and says exactly that
is the opposite of that failure.

If **no** model tier could run, there is no review and it is a plain failure.

Four independent bounds guarantee termination:

1. **Fingerprint dedup** — a settled finding cannot re-trigger work *when re-raised
   in the same words*. See §3.1.1: this bound is softer than the other three, and
   the mechanical guarantee comes from them.
2. **Per-tier round cap** (default 3) — applied only to a round that raises
   something fresh (D-52).
3. **Global round budget** (default 12) per review.
4. **Quota exhaustion.**

Hitting 2, 3 or 4 is **not** a pass. It is a distinct terminal state, named.

The cap in 2 bounds *going round again with the same tier*, so it is tested only
where that could happen — on a round with fresh findings. A tier that comes back
**clean** has already stopped going round, and the ladder escalates however many
rounds it took to get there. The budget in 3 is different in kind: a ceiling on
the whole review, tested on every round, clean or not, because a ceiling a good
result may exceed is not a ceiling.

Termination survives this, which is the only thing the bounds owe us. Each round
either raises something fresh — bounded by 2 and 3 — or is clean, and clean is
terminal: it passes, asks a human, or escalates. Escalation moves the cursor only
**forward** through a finite tier list.

## 6. Scope of a review

- **Base**: the client's stated `into` branch, fetched fresh. Never a stale local
  ref (INV-2).
- **Diff**: `merge-base(into, branch)` → the review worktree, which includes any
  diffs submitted since (`spec/mcp-api.md` §4).
- **Untracked files** are listed by name — they are invisible to `git diff`
  (INV-4).
- **Truncation is announced** (INV-7). Reviewers are never assumed to have seen the
  whole change.

### 6.1 Submodules: a one-line diff that is not one

The workgroup uses **git submodules** rather than monorepos (D-36). That simplifies
T0 — one package per repo, one toolchain — but introduces a specific review hazard.

A submodule pointer bump appears in a diff as a single gitlink line:

```
-Subproject commit a1b2c3d
+Subproject commit e4f5a6b
```

Those two lines can represent thousands of changed lines in the submodule. A
reviewer shown only the outer diff will confidently report "small, low-risk change"
about work it has not seen — which is exactly the class of confident-but-blind
finding this project exists to prevent.

Therefore:

- Clones are `--recurse-submodules`.
- A gitlink change is **expanded**: the reviewer is given the submodule's own
  `old..new` diff, or told explicitly that it was too large to include and how large
  it was (INV-7).
- A gitlink change is **never** counted as a one-line diff for size or truncation
  decisions.

### 6.2 The ticket is a review axis (D-38)

Every review carries the task ticket text, which lets a reviewer ask the question
correctness alone cannot reach: **not "is this code right?" but "is this the right
code?"**

Four findings only the ticket makes visible:

| finding | why it matters here |
|---|---|
| **does not do what was asked** | the change is coherent, tested, and solves a different problem |
| **does less than was asked** | a requirement in the ticket has no corresponding code |
| **does more than was asked** | *scope creep* — see below |
| **contradicts the ticket** | the ticket says one thing, the code assumes another |

**Scope creep deserves its own emphasis in a vibecoding workflow.** An AI asked to
fix one thing will cheerfully refactor three others, rename a module, and "improve"
error handling nobody mentioned. Every unrequested change is code that no one
decided to write, no one budgeted risk for, and no ticket justifies. It is the most
common defect in this workflow and it is invisible to a reviewer that has no ticket.

An unrequested change is not automatically wrong — but it must be *noticed* and
justified, exactly like any other finding.

### 6.3 Specs are reviewed as code

Plans, ADRs and specs are **first-class review artifacts**, not context (D-11). A
spec is reviewed for what code is reviewed for: contradiction, ambiguity, an
unstated assumption, a decision with no rationale.

Drift is checked both ways: **code that contradicts its spec is a finding, and so
is a spec that no longer describes the code.** It is a defect regardless of which
side moved.

## 7. Inherited invariants

Each cost real debugging time in `~/c/review`. Incidents:
`research/prior-art-c-review.md`.

- **INV-1** — *A review that did not run is not a review that found nothing.* Every
  failure path is loud and terminal. Four silent failures in one day are why this is
  first.
- **INV-2** — Base is the fetched remote ref, never a stale local one. A stale local
  `main` once turned a one-file branch into a 496-file diff.
- **INV-3** — The diff includes uncommitted work in the review worktree.
- **INV-4** — Untracked files are announced explicitly.
- **INV-5** — No global lock. Contention is per-session; a leaked fd once let a
  daemon hold the review lock for its whole life, queueing runs for 10 hours.
- **INV-6** — opencode sessions are single-flight. Pool and reuse.
- **INV-7** — A truncated diff is announced.
- **INV-8** — Verify the read-only agent **exists**. `--agent` silently falls back
  to the write-capable default when it does not.
- **INV-9** — Reviewers are read-only. No write/edit/patch; no `git add`, `commit`,
  `checkout`, `reset`, `stash`.
