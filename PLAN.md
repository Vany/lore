# PLAN

How `lore` gets built. `SPEC.md` says what it is; this says in what order, and why
that order.

**Ordered by risk retirement, not by layer.** A service whose pieces are each 80%
done proves nothing. Every phase ends with something that runs and can be judged.

---

## The risks, ranked

What could make this project fail, hardest first:

1. **The ladder never converges.** Reviews churn forever and no branch reaches
   `passed`. Everything else is decoration if this is true.
2. **The findings are noise.** Technically correct, practically useless — the
   problem both CodeRabbit and Greptile spend real engineering suppressing. In a
   Claude-driven loop every false positive costs a whole fix cycle.
3. **The knowledge layer does not actually help.** It is the product (D-14). If
   review N+1 is no better for what review N learned, we built an expensive linter.
4. **Structured output is unreliable** across three vendors, making "did not run"
   frequent.
5. **T0 does not fit the CPU budget** on an ARM SBC (D-37). *Retired: measured at
   ~25 min/day, an order of magnitude under the estimate.*
6. **arm64 dependency incompatibility.** Originally framed as breaking test
   execution; there is none now (D-71). It still breaks the **install**, which takes
   `tsc` and `eslint` with it, so the risk survives its original reason.

Risks 1, 2 and 4 are reachable **on a laptop, with a CLI, with no service at all**.
That is why the walking skeleton wins: it kills the top of the list first, where
changing your mind is cheapest.

Risks 5 and 6 need the device. They are planned now (§Phase 4) and run when the Pi
is in hand.

---

## Phase 0 — Core ✅

**Goal:** the logic, with no I/O anywhere. This is what must be right, and it is the
part testable without a model, a network or a repo.

- finding record + Zod schema, with optional `cwe` (D-44)
- fingerprint: `sha256(normalized_claim ‖ file ‖ enclosing_symbol)`
- SQLite store behind a repository interface — `repo`, `review`, `tier_run`,
  `finding`, `verdict`, `knowledge`, `usage`, `job`
- verdict staleness via `scope` (blob sha + hunk hash)
- `lore-ok` parser, both `//` and `<!-- -->` forms
- escalation state machine and its four termination bounds
- **review pipeline abstraction** — a review type is a *named pipeline of stages*.
  Costs almost nothing now and is the seam D-43 needs later; retrofitting it into a
  monolithic review would be painful.

**Done when:** tests green, and the state machine is property-tested to terminate
under every combination of the four bounds. No network in this layer, ever.

**Size:** small. **Retires:** nothing directly — but everything stands on it.

---

## Phase 1 — One real review, on a laptop ✅ ← *the phase that mattered*

**Goal:** `lore review --target . --branch X --into main --ticket "…"` runs the full
ladder against a real branch and converges.

- **git boundary** — bare clone, worktree per review, fetch `into` fresh (INV-2),
  working-tree diff (INV-3), untracked listing (INV-4), truncation notice (INV-7),
  **submodule expansion** (D-36)
- **T0** — detect and run the *target's* `tsc`, ESLint, `ast-grep`, and `semgrep`
  with security rules, normalising all output into findings. Originally it also ran
  the target's tests in a sandboxed container (D-24); **that is gone** — lore reads a
  suite and never runs one (D-71). The sandbox stays, because `tsc` and `eslint`
  resolve out of the target's `node_modules` and the install still runs.
- **opencode boundary** — read-only agent existence check (INV-8), session pooling
  (INV-5/6), agentic reviewer with worktree tools, structured output with one retry
  then loud failure, **prompt caching from the first call** (D-29), usage recorded
  per call
- **tier prompts by position** (D-31)
- **doc ingestion, read-only** — the reviewer gets the repo's own rules from
  `CLAUDE.md`/`PROG.md`/`SPEC.md`/ADRs. Deriving and teaching wait for Phase 2; this
  is just "read what the repo already says".
- **CLI**, with the exit codes as its API
- **measurement harness** — run each candidate model over branches with known
  defects mined from `~/c` history

**Done when:**
1. it converges to `passed` on a real branch, repeatedly;
2. Vany reads the findings and judges them worth the money;
3. cost and tokens per review are **measured**, replacing every estimate in
   `research/ai-code-review-landscape.md` §3.1;
4. structured-output parse failures are counted, per vendor.

**Size:** the largest phase. **Retires:** risks 1, 2, 4 — and settles D-7 and D-17
with data instead of benchmarks.

**This phase is also usable.** It replaces `~/c/review` immediately, and real use is
what surfaces design errors that reading a spec never will.

---

## Phase 2 — Knowledge ✅

**Goal:** the thing that makes this a product rather than a linter (D-14).

- derive rules from accepted `lore-ok` justifications and recurring fingerprint
  clusters
- `knowledge_query` / `knowledge_teach` as library functions
- provenance, verification dates, `scope` invalidation; ingested-doc rules
  **re-derived** when their source blob changes (D-20)
- conflicts as findings, with `needs_human` when unresolvable (D-39)
- review-time enrichment — *"seen 4×; the rule from 2026-07-11 says X"*
- bootstrap pass (D-35)

**Done when:** a second review of the same repo **demonstrably uses** what the first
learned. Write that as an explicit test, not a vibe — this is the product hypothesis
and it deserves to be falsifiable.

**Size:** medium. **Retires:** risk 3.

---

## Phase 3 — The service ✅

**Goal:** the workgroup can use it over MCP.

- `@modelcontextprotocol/server` v2 with Zod schemas (D-22)
- `review_start` / `poll` / `submit` / `attest` / `inbox`, `knowledge_query` /
  `teach` — **with the `type` parameter present from day one** even though only
  `code-arch` exists (D-43). Adding a required argument later breaks every client.
- `lore://docs/*` resources, the `review` prompt (D-27, D-28)
- provisioning: `make new`, a revocable bearer token in a header (D-21) and the
  `.mcp.json` to paste, CSPRNG `review_id` bound to its principal (D-23). The
  server-side deploy key this originally specified is **gone** — D-63 moved the
  fetch out to the host, so lore holds no git credentials
- scheduler with per-provider concurrency and queueing
- two-stage: T0+T1 inline, T2+T3 async (D-34)
- `tree_hash` verification on submit
- Ed25519 attestation

**Done when:** a **fresh Claude Code session, given only the MCP endpoint and no
other instructions**, drives a review to `passed`. Every place it goes wrong becomes
a sentence in the tool descriptions (`spec/agent-docs.md` §2). Docs written for an
agent must be tested against one.

**Size:** medium.

---

## Phase 4 — Deployment and operations ✅ *(still running on a laptop, not the device)*

**Goal:** it runs on the Pi and tells someone when it is sick.

- `docker-compose.yml` in a folder in `$HOME` on the device, matching the existing
  infra convention. arm64 images throughout.
- **T0 engineered for the host** (D-37): `node_modules` cache keyed by lockfile
  hash, `tsc --incremental` with persisted build info, **diff-scoped work from round
  2**, bounded concurrency
- Litestream to a **local folder** an outer script collects, and a **restore that has actually been
  performed**
- heartbeat deadman, webhook alerting, the page/ticket/log split (D-42)
- daily spend ceiling that stops starting reviews
- operator status view (D-26)

### 4.1 The arm64 tests — ✅ RUN 2026-08-03 on the device

> **The device was dropped 2026-08-07.** The deployment runs on a laptop the workgroup
> reaches over tailscale. These measurements are kept because they were real and because
> the arm64 constraint they justified still holds — the images stay arm64, so a
> single-board host remains available rather than becoming a port.

Orange Pi, RK3588, aarch64, 8 cores, 31 GiB, 3.2 TB free. Docker 29.6, compose 5.3.

| test | result |
|---|---|
| arm64 node container | **pass** — node 24.18.1 native, no emulation |
| `npm ci` | **pass, 9 s** |
| full 180-test suite | **pass, 7 s** — after fixing the image, below |
| `tsc --noEmit` | **pass, 2 s** |
| tailscale on host | **ABSENT** — see below |

**The one real finding: `node:*-alpine` ships no git,** and 10 of lore's own 180
tests failed without it. That failure mode is the dangerous kind — the suite does
not refuse to run, it runs and fails for reasons unrelated to the change, and T0
turns those into high-severity findings. A reviewer that manufactures defects costs
a fix cycle each. Fixed by building `deploy/sandbox.Dockerfile` with git present.

**The CPU budget was wrong by an order of magnitude, in our favour.** D-37 estimated
~5 CPU-hours/day for one developer. Measured: a T0 round on this repo was ~2 s of
typecheck plus ~7 s of tests, with installs cached. At 30 PRs × 5 rounds that is
**~25 minutes/day**, not five hours. T0 is still the local bottleneck, and the
caching in D-37 is still worth having, but it is not the constraint the plan feared.
Caveat: lore is a small repo; a large monorepo will be slower.

The ~7 s of tests is no longer spent at all — D-71 removed execution — so the real
figure is now lower than the one measured here. Left as measured rather than
re-estimated downward.

**tailscale is not installed on the host.** The security model assumed it: D-33
reasoned that WireGuard is the perimeter and bearer tokens only scope one teammate
from another's repo. Without it, on a LAN, **the tokens are the perimeter**. The
compose bind now defaults to loopback so that choice has to be made deliberately.

| test | method | if it fails |
|---|---|---|
| **deps install on arm64** | `npm ci` for each target repo in `arm64v8/node` | `tsc` and `eslint` go with it — they resolve out of `node_modules` — so T0 loses two engines; emulate (slow) or move the host |
| **security tooling on arm64** | `semgrep`, `osv-scanner`, `cdxgen` in the image | drop from T0 or run remotely |
| **T0 CPU budget** | time a full T0 round; multiply by 30 PRs × ~5 rounds | tighten caching, or T0 becomes the queue |
| **parallel container headroom** | N concurrent T0 runs until CPU saturates | sets the scheduler's concurrency cap |

The CPU-budget test is the one that could reshape the design, and it needs no target
repo — a synthetic project of representative size will do.

**Size:** medium. **Retires:** risks 5 and 6.

---

## Phase 5 — Review types, and security ✅

**Goal:** `type` becomes real, and the second type ships
(`research/security-review.md`).

- type registry over the Phase 0 pipeline abstraction
- **security pipeline**: SBOM via `cdxgen` (CycloneDX) → **OSV** query by
  package+version and by **commit hash** (needed for submodules) → `semgrep` security
  rules → **model tiers assess reachability** → **VEX output**

The models' job here is reachability, not detection: a scanner says a vulnerable
package is present, and only reading the code says whether it can be reached. That
judgement is where the noise lives and where the value is.

**Emit real VEX**, not a bespoke format — it is structurally the same as our
justification ledger (a reason attached to a finding, accepted or rejected, stale
when the code changes) and it makes the output consumable by tools we did not write.

**Open:** whether security review also runs on a schedule, since a dependency
becomes vulnerable with no commit to trigger anything.

**Size:** medium.

---

## Phase 6 — Token economy *(planned 2026-09-16)*

**Why this phase exists.** Every subscription ran dry within a week. Measured 2026-09-16
over everything since 09-07 (the `usage` table, 4376 rows):

- **98% of tokens are one repository**, rigid-monorepo: 178 reviews in nine days, average
  diff 152 KB.
- **The cost is re-reading, not writing.** Output is a rounding error; cached re-reads are
  10–20× fresh input. A reviewer re-sends its whole context on every tool step.
- **The first read is two-thirds of it.** A tier's first call on a rigid branch re-reads
  2.84M tokens over ~25 steps at ~114k context per step; by round 4 a call costs ~0.7M.
  `conversation: true` makes later rounds cheaper, not dearer.
- **The steps are exploration.** Across 78 logged sessions: 2,262 `bash` calls, 603
  `read`, 92 `grep` — the agent shelling around a repository it has read before. Reviewers
  are handed rules (`relevantTo`), never a map of the code.
- **37% of spend was correlated**: t2 and t3 falling back to `zai-coding-plan2`, the same
  vendor as t1, paying two full first reads for an opinion the ladder then calls thin.
- **~30% bought no verdict**: 351M tokens on cancelled reviews, 235M on failed. Restart-and-
  redo is only 61M of it; the recorded reasons are "stuck at round 0 under host load ~120",
  "wedged after the lore-wide retry", and "branch merged before the review finished".
- **One plan backstopped everything.** Every fallback chain ends in `zai-coding-plan2`, so
  when Kimi's weekly and OpenAI's limits went, that plan carried three tiers (43% of spend)
  and its 5-hour windows took the whole ladder down.

**The rule this phase is judged by: tokens per concluded verdict, with no loss of findings.**
A change that saves tokens by finding less is not an optimisation, it is a weaker gate —
the INV-1 failure in slow motion. So every step has a number it must move and a way to
check it did not cost findings.

### Decisions taken to plan it (Vany: *"all is good"*)

| | decision | default | revisitable because |
|---|---|---|---|
| D1 | a deep tier whose only route is a vendor that already read this tree is **skipped and named thin**, not asked | skip, per-tier `skip_correlated` | a second z.ai model does sometimes catch different things; the replay in step 3 measures it |
| D2 | reviews are **capped per repository** | rigid-monorepo: 2 at once; others unlimited | slower but finished beats fast and abandoned; tuned from the queue-wait numbers |
| D3 | a lore-caused requeue (deploy, worker restart) **does not spend an attempt**; an unreachable opencode is bounded by **30 min of continuous unreachability**, not a count | 30 min | a deep tier legitimately runs ~23 min at p90 |
| D4 | exploration **step budget** | none until step 3's replay picks one | picking it blind trades tokens for findings with no measurement |

Still open, and not part of this phase: the silence bound on a single model call (changes
which model is called — its own decision), and metered OpenRouter ($190.35 left).

### Step 0 — Measure what the steps are *(no behaviour change; first)*

- **0a. Record every tool call's argument**, not just its count. The event stream already
  sees each call; persist tool, command or path, session, tier, review. opencode keeps no
  readable session history (its storage dirs are empty), so lore must write this itself.
  Answers: which files, and how often the SAME files recur across reviews and tiers.
- **0b. Check the three opencode plugins** — `oh-my-openagent`, `agent-usage-reminder`,
  `directory-readme`. Any that injects text into every step multiplies its size by ~30 on
  every call. Removing one would be the cheapest saving in this phase.
- **0c. Find out how each plan meters** — tokens, requests, or steps. z.ai counting steps
  would make step count the lever for its 5-hour window, not context size.
- **0d. A standing token report** (`make tokens`, and a board panel): tokens per concluded
  verdict, first-read share, steps per first read, correlated share, no-verdict share —
  per day and per repository. Every later step is judged against this baseline.

**Done when** the baseline exists, the plugins are cleared or removed, and 0a has a week
of data or enough rigid first reads to see repetition.

### Step 1 — Stop correlated reads *(biggest measured waste; policy, not a build)*

- Before asking a fallback route, compare `vendorOf(route)` (`src/core/ladder.ts`) with the
  vendors that already read this tree in this review (`readBy`). A match with
  `skip_correlated` set marks the tier unavailable with the reason named, and the ladder
  ends thin exactly as it already does for a skipped tier.
- In the fallback walk in `src/reviewer/review.ts` — the same loop D-149 changed.
- `checks_skipped` says it in words; the attestation's vendor count already covers it.
- `deploy/tiers.*.json` gains `skip_correlated: true` on t2 and t3.
- Tests: a same-vendor twin is not asked; a different-vendor twin is; the thin ladder names
  the reason. **Metric:** correlated share of deep-tier tokens → ~0.

### Step 2 — Stop throwing work away

- **2a. Per-repository concurrency cap (D2).** `claimJob` (`src/store/store.ts`) skips a job
  whose repository already has N rounds running. The queue position reaches the client —
  "queued behind 2 reviews of this repository" — in `review_poll` and the inbox, so a
  waiting review is not mistaken for a stalled one (the client complaint of 2026-09-16).
- **2b. Do not start the deep stage on a branch that already merged** or no longer exists
  on the mirror. End it with a state and a reason that say NOT reviewed, before spending.
- **2c. The attempts fix (D3).** `claimJob` increments `attempts` on every claim, so a
  deploy-dropped round spends one. Startup reclaim stops counting; a `ServiceUnreachable`
  requeue is bounded by continuous-down time; no message says "requeued" once it will not
  be. It failed two rigid reviews on 2026-09-15.
- **Metric:** no-verdict share of review tokens, from ~30%.

### Step 3 — Keep the repository analysed *(the structural lever; gated on step 0)*

- **3a. Diff context, computed without a model.** For each changed symbol: its definition,
  its call sites, the types it touches — extracted deterministically and put in the prompt,
  budgeted (~25k tokens) and ranked by relevance. `src/reviewer/diff-context.ts`, one file.
  **Search for an existing library first** (tree-sitter bindings, ctags, the TypeScript
  language service) — large, well-known functionality.
- **3b. A repository brief per trunk commit.** Module map, public interfaces, invariants,
  conventions, how to build and test, ≤20k tokens. Built by the helper model when `into`'s
  tip moves — once per trunk commit, not per review — and updated from the previous brief
  plus the trunk diff. `src/knowledge/brief.ts`. A brief older than `into`'s tip is not used.
- **3c. Tell the model it has them**, in `src/reviewer/prompts.ts` — a model learning
  differently is exactly what that file is for — and set the step budget (D4) only after 3d.
- **3d. The replay gate.** Replay N real rigid reviews — same tree, ticket and base — with
  and without 3a+3b. Ship only if steps and tokens per first read fall materially **and** the
  replay still raises the findings the original run raised.
- **Caveat that decides the design:** these tokens are already provider-cached, and quota
  burns anyway. A brief re-sent on every step only moves the cost. It pays only by
  **removing steps**, so the metric is steps per first read, not brief size.
- **Metric:** first-read tokens per review, from ~8.5M.

### Step 4 — Small wastes *(ride along with step 1)*

- **4a.** Deny `webfetch` and web search in reviews (`DENIED_TOOLS`, `src/reviewer/opencode.ts`)
  — 23 calls in the sample, none a code review needs. Check the exa tool's exact name.
- **4b.** A refusal that names a **weekly** window backs off for hours, not the 15-minute
  `PROBE_INTERVAL_MS` (`src/core/cooloff.ts`) — Kimi was probed 80 times against a 7-day limit.
- **4c.** `TOOL_DOCS.start`: a stacked branch is reviewed `into` its parent, not `main` —
  #957 on #941 otherwise re-reads the parent's whole change.

### Step 5 — See opencode *(from the 2026-09-16 client complaint)*

- Per tier call in flight: route asked, asked since, last heard from opencode, when lore gives
  up — persisted on the tier row so a failed round keeps its reason (three 46–88-minute
  failures had none), and said in one sentence in `review_poll` and the inbox.
- opencode restarts counted from event-stream reconnects plus a health probe; a board panel;
  a page on a restart storm (seven clean exits in two hours paged nobody) and on long silence.

### Order, and what each deploy costs

**0 → 1+4 → 2 → 5 → 3.** Step 0 first because every later step is judged by it. 1 and 4 are
small, independent and the biggest immediate relief, so they ship together. 2 stops the
throwaway and unblocks the rigid sessions holding their starts. 5 before 3 because it makes
the replay gate's failures legible. 3 last because it is the most work and needs step 0's
data to be designed right.

**Deploys drop in-flight rounds**, so steps ship in as few deploys as possible, with the
rigid sessions warned first (they asked). **Reviewing this phase spends the same quota it is
trying to save**, and until the plans reset those reviews run t1 only — said in each batch's
commit rather than skipped silently.

### Risks

- **Fewer steps can mean missed findings** — the replay gate exists for this and is not optional.
- **A stale brief is worse than none**: it states wrong facts confidently. Keyed to the trunk
  commit and refused when behind.
- **Deterministic context in rigid's languages** — which languages rigid-monorepo actually
  is decides which extractor is viable. Unverified.
- **Skipping correlated reads** may drop a finding a second z.ai model would have caught;
  the replay measures that too.

## Deliberately deferred

- Cross-repo knowledge (`SPEC.md` §11.5) — per-repo is decided; the workgroup-wide
  layer waits for evidence it is needed.
- Effort escalation within a model before switching model
  (`spec/review-ladder.md` §1.2).
- opencode-agent and Claude-skill adapters over the core.
- Full OAuth 2.1 — opaque revocable tokens are proportionate behind Tailscale.
- A human browse UI for the knowledge base.

## Unknowns that could change this plan

1. **Convergence** (Phase 1). If reviews rarely reach `passed`, the ladder needs
   rethinking before anything else is built on it.
2. **Noise.** If T1 produces mostly false positives, the cheap gate costs more in fix
   cycles than it saves in tokens, and the tier lineup changes.
3. **`node:sqlite` write concurrency** under parallel reviews plus `knowledge_*` —
   untested. May need a single-writer funnel.
4. **T0 CPU on the Pi** (Phase 4). If it does not fit, T0 moves off-device or the
   host changes.
5. Greptile's *"How to Make LLMs Shut Up"* remains unread — the most directly
   applicable published work on risk 2.

## What writing it actually found

Every phase turned up something the spec had wrong. Recorded here because the pattern
is the point: the errors were not in the hard parts.

- **Phase 0** — "fingerprint dedup" was listed as a termination bound. It only holds
  for *identical* claims; a paraphrase reads as new work. The mechanical guarantee
  comes from the round caps (`spec/review-ladder.md` §3.1.1).
- **Phase 2** — bootstrap could not run at provisioning: there is nothing to read
  until a clone exists. Stated then as "the deploy key exists but a human has not
  yet added it to the repo"; the reason survived the key (D-63 — a human still has
  to run `make mirror`), which is why the finding outlived its explanation.
- **Testing** — the opencode SDK reports failure by **return value**, not by
  throwing, so a 429 was being reported as "unparseable findings" (exit 70) rather
  than "out of quota" (exit 75), losing the quota alert with it.
- **Review** — `needsHuman` was accumulated rather than derived, so a knowledge
  conflict permanently deadlocked a review; and nothing could resolve one. A block
  with no exit is a trap, not a safeguard.
- **Review** — nothing wrote to `tier_run`, so the attestation would have claimed
  "0 tiers": a false statement in the one output the service exists to produce.

## The next concrete action

**Phase 6, step 0** — before changing anything: record every reviewer tool call's
argument, check the three opencode plugins for per-step injection, find out how each plan
meters, and stand up the token report every later step is judged against.
