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
5. **T0 does not fit the CPU budget** on an ARM SBC (D-37).
6. **arm64 dependency incompatibility** breaks test execution (D-24).

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
  with security rules; then its tests in a sandboxed container (D-24). Normalise all
  output into findings.
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

## Phase 4 — Deployment and operations ✅ *(arm64 tests still pending a device)*

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
~5 CPU-hours/day for one developer. Measured: a T0 round on this repo is ~2 s of
typecheck plus ~7 s of tests, with installs cached. At 30 PRs × 5 rounds that is
**~25 minutes/day**, not five hours. T0 is still the local bottleneck, and the
caching in D-37 is still worth having, but it is not the constraint the plan feared.
Caveat: lore is a small repo; a large monorepo will be slower.

**tailscale is not installed on the host.** The security model assumed it: D-33
reasoned that WireGuard is the perimeter and bearer tokens only scope one teammate
from another's repo. Without it, on a LAN, **the tokens are the perimeter**. The
compose bind now defaults to loopback so that choice has to be made deliberately.

| test | method | if it fails |
|---|---|---|
| **deps install on arm64** | `npm ci` for each target repo in `arm64v8/node` | D-24 is undeliverable here; emulate (slow) or move the host |
| **tests pass on arm64** | `npm test` in the same container | same |
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

Deploy it. `deploy/docker-compose.yml`, then `lore new --name … --git …`, then point
a Claude Code session at the endpoint with no other instructions and watch where it
goes wrong — every failure it invents becomes a sentence in the tool descriptions.
