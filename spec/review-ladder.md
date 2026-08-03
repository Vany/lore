# The review ladder

How a single review escalates. Model choice rationale:
`research/ai-code-review-landscape.md`.

---

## 1. Tiers

Cheapest → dearest. Each is a *gate*: dearer tiers only see code the cheaper ones
already passed.

| Tier | Purpose | Engine | Int. | $/M in | $/M out | vendor |
|---|---|---|---|---|---|---|
| **T0** | deterministic | the **target repo's own** `tsc`, ESLint, tests, `ast-grep` | — | free | free | — |
| **T1** | cheap gate | `openrouter/z-ai/glm-5.2` | 51 | 0.28 | 0.89 | Z.ai |
| **T2** | main reviewer | `openrouter/moonshotai/kimi-k3` | 57 | 3.00 | 15.00 | Moonshot |
| **T3** | adversarial | `openrouter/openai/gpt-5.6-sol-pro` | 59 | 5.00 | 30.00 | OpenAI |

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

### 1.1.1 T0 executes the target's tests, in a container that holds nothing

Greptile built TREX because running code finds what reading cannot. T0 therefore
runs the repo's test suite (D-24).

That is **arbitrary code execution** — `npm test` runs whatever the repo and its
entire dependency tree say, including lifecycle scripts. The threat is not the
teammate; it is the dependency tree.

**The test container is not the service container.** The service holds the deploy
keys for every registered repo and the knowledge database; one malicious
`postinstall` inside it reads all of both. So tests run in a **separate ephemeral
container per review**:

- no secrets mounted — no deploy keys, no tokens, no database
- no network, or egress through a deny-by-default proxy
- read-only root filesystem apart from the worktree
- CPU, memory and PID limits, and a **hard timeout**
- destroyed after the run

The worktree goes in; findings come out; nothing else crosses. The timeout is
mandatory — a hung suite otherwise holds a review slot forever, and looks like a
slow review rather than a stuck one.

**The suite never runs in the reviewed tree.** Sources are mounted read-only at
`/src` and copied to a throwaway `/work` per review. A suite that writes —
snapshots, coverage, build output, a lockfile npm decides to update — would
otherwise mutate the tree under review, and those files land in the next round's
diff as findings about work nobody did. **A review that invents its own defects is
worse than one that misses some.**

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

### 3.1 Fingerprint

`sha256(normalized_claim ‖ file ‖ enclosing_symbol)`

Deliberately **not** the line number: lines shift under every edit, and a finding
that moved three lines down is the same finding. Severity is likewise excluded, so
a finding returning at raised severity after a rejected justification is recognised
as the same finding rather than as new work.

#### 3.1.1 What the fingerprint does *not* do — corrected 2026-08-03

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

## 4. Justification is a proposal of lore, and the reviewer ratifies it

When the client believes a finding is wrong, it does not silently dismiss it. It
writes a comment at the site:

```ts
// lore-ok[a1b2c3d4]: bounded by the caller's schema check at api/route.ts:31,
// so a negative amount cannot reach here.
```

```md
<!-- lore-ok[a1b2c3d4]: reason -->
```

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

## 5. Escalation and termination

- Tier produced **new** findings → report; the next pass **resets to T1**.
- Tier produced **nothing new** → advance one tier. Top tier clean → **passed**.

"New" means a fingerprint not already settled, not a raw count. A tier that
re-raises three closed findings and nothing else is clean.

Four independent bounds guarantee termination:

1. **Fingerprint dedup** — a settled finding cannot re-trigger work *when re-raised
   in the same words*. See §3.1.1: this bound is softer than the other three, and
   the mechanical guarantee comes from them.
2. **Per-tier round cap** (default 3).
3. **Global round budget** (default 12) per review.
4. **Quota exhaustion.**

Hitting 2, 3 or 4 is **not** a pass. It is a distinct terminal state, named.

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
