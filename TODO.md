# TODO — `lore`

Phases, rationale and done-criteria live in **`PLAN.md`**. This is the working
checklist. One task at a time; finished work moves to `MEMO.md` with what was
learned, then gets struck here.

**Rewritten 2026-08-04**, because it had drifted badly: it still listed the SQLite
store, the git boundary and the whole MCP service as unstarted while all of them
were deployed in Docker and had carried two reviews to `passed`. A stale checklist
is the same defect this tool exists to catch — a claim nobody checks — and it was
sitting in our own repo while we fixed five of them in the code.

A phase is ticked when its code is **running and observed**, never when it is
merely written. Where a phase shipped with a part that has never been exercised,
that part is pulled out into its own open item rather than hidden inside a tick.

---

## Now — nothing here is about writing more features

### Measured 2026-08-05: the first day a client drove it

Until today every review was driven by me, by hand, with shell scripts. Today a
Claude session in `rigid-monorepo` drove them. Read straight off the live database,
read-only, with the service left running.

|                              | all time |    today |
| ---------------------------- | -------: | -------: |
| reviews                      |       30 |       15 |
| reached `passed`             |        2 |        0 |
| left in `findings_ready`     |       11 |        8 |
| `failed`                     |       15 |        5 |
| findings                     |      106 |       31 |
| findings never delivered     |       18 |       18 |
| verdicts answered            |       95 |        8 |
| verdicts on `rigid-monorepo` |    **0** |    **0** |

The last row is the whole story. The customer's repository has produced 21 findings
and answered none of them, so nothing has ever been learned from it: the knowledge
base is the product, and for the one repo with a real user it is not being written.
The five items below are what the numbers say is in the way, in order of size.

What the numbers also confirm, so it is not re-litigated: **prompt caching works**
(97.3% of everything sent to t1 was cached, 99.1% for t2, 95.8% for t3 — 7.8M cached
against 183k fresh, D-29); **the retry earns its place** (5 of 53 t1 replies and 5 of
22 t2 replies were usable only after one retry); and **INV-1 holds** — every one of
the 15 failures is a refusal that named its cause, not a review that quietly found
nothing.

- [ ] **A stale mirror is the largest single cause of failure, and the client cannot
      clear it.** 3 of 9 failed jobs, and 3 of 5 today — more than any model or
      transport fault. `MAX_MIRROR_AGE_MS` is 30 minutes; the refusal at 18:23 today
      read *last fetched 192 minutes ago*. The refusal is right (D-40, D-63) and the
      message names the fix, but the fix is `make mirror REPO=…` **on the host**, and
      the client is an agent inside the repository with no host shell. So it reads an
      instruction it cannot follow, and the only move left is to ask a human and wait.
      The fourth review of `fix/RIGID-135` was started two minutes after that refusal.
      Related and same root: `branch 'feat/RIGID-125-network-txn-id' not found on
      origin` at 10:39, which was the mirror predating the push.
      Not a bug to patch blindly — the options (a longer window, a fetch the client
      can trigger, a mirror refreshed on a timer) differ in who holds credentials,
      which is D-63's whole subject. Wants a decision.

- [ ] **The client restarts reviews instead of continuing them.** Six reviews of
      `feat/RIGID-125-network-txn-id` between 10:39 and 12:46; four of
      `fix/RIGID-135-cardholder-velocity-scope` between 13:29 and 18:25; four of
      `main`. 13 of 30 reviews stop at round 1, and the ladder's whole design — carry
      findings forward, escalate, settle — needs round 2. Each restart re-pays t0 and
      t1 from scratch: today's 14 tier calls bought one round each rather than one
      review's worth of depth.
      Whether the client restarts because it prefers to, or because it does not know
      `review_submit` continues the same review, is **not answered by this data**. The
      texts in `src/mcp/docs.ts` are the only place it could learn, which makes this
      first a documentation question, not a code one.

- [ ] **18 findings were produced and never collected.** All 18 are from today, across
      four reviews (6 + 5 + 4 + 3), and 14 are t0 `high`. The review reached
      `findings_ready` and nothing ever polled it. `delivered_at` already records this
      per finding, so the fact is available to the service and it says nothing about
      it — `make status` shows queue depth and active reviews, not *this review has
      been holding six high-severity findings for six hours*. A finding nobody reads
      is the same failure as a review that did not run, one step later.

- [ ] **The ingester was fixed today and not one row in the database came from the
      fixed one.** `dda312f` landed at 17:27 ("the knowledge base was 78% fragments,
      because it read physical lines"). Every live ingested row predates it — 8 from
      08-03T20:55, 8 from 08-05T10:44 (all of `rigid-monorepo`), 3 from 10:55, 48 from
      14:40. Re-ingestion is triggered by *the source document changing*, not by the
      ingester changing, so improving the reader does not reach what it already wrote.
      What remains is visible: 9 of lore's 59 live rules and 1 of rigid's 8 begin
      mid-sentence — `spec. Hand-rolled HTTP against opencode is a last resort`,
      `response, an exhausted quota and a timeout are all "did not run"`.
      Needs a re-ingest of both repos, and a reason for one to happen when the
      ingester's own behaviour changes. Retiring is non-destructive (`retired_reason`,
      907 rows already retired that way), so this is cheap — but it rewrites the
      product, so it is Vany's call, as agreed.

- [ ] **`rigid-monorepo` starts every review from 11 rules.** lore has 68. Its eight
      ingested ones are the pre-fix output above, and two of them carry no content at
      all: `Specifically forbidden` (22 characters) and `task cancellation. Its
      failures never block execution`. The three derived ones are the only earned
      knowledge there, all from repeated t0 findings (CWE-319 ×4, an insecure-request
      semgrep rule ×4, the suite failing ×3). With zero verdicts on that repo, nothing
      else can be derived — this item and the `verdicts: 0` row are the same problem
      seen from two ends.

- [ ] **T0 is partly blind on the repository it actually reviews.** Of 7 t0 runs on
      `rigid-monorepo`: ast-grep unconfigured in 5, eslint in 1, tsc in 1 — against 5
      and 5 of 85 on lore. It reports this honestly in `unavailable` and the ladder
      carries it, so nothing is claimed falsely. But `ast-grep` is unconfigured in
      *every* repo it has ever met, which makes it an engine that has never once run
      in production. Either it needs a default ruleset it can bring itself, or it
      should stop being counted as a gate.

- [x] **lore holds no git credentials** (D-63). Done 2026-08-04. `make mirror` fetches
      on the host as the operator into `data/repos`; the container sees nothing
      outside the project. `ensureBare` checks presence and freshness and refuses
      loudly. Provisioning issues a token and the `.mcp.json` to paste — no key, for
      any url, which supersedes D-62 a day after it shipped.

- [x] **The docs describe the deployed system again.** Done 2026-08-04. The sweep
      found `spec/mcp-api.md` listing six tools under dotted names when ten are
      registered with underscores; `spec/deployment.md` still requiring an off-device
      replica that D-59 replaced; `spec/review-ladder.md` and `spec/operations.md`
      alerting on deploy keys that no longer exist; README claiming *undeployed* with
      a 180-test badge. The provisioning output's `.mcp.json` was wrong in three
      independent, individually fatal ways and is now checked structurally.

- [ ] **The `.mcp.json` test guards the shape, not the client.** It asserts
      `mcpServers` / `http` / `${LORE_TOKEN}`, which is what today's client reads —
      pinned by observation, not by anything that would notice the client changing.
      A dependency bump elsewhere cannot break it; a Claude Code release can, and
      silently. Cheap mitigation: re-run the header-echo probe when the client
      updates. Recorded so the guarantee is not overread.

- [x] **The knowledge base is replicated** (D-59). Done 2026-08-04. Litestream runs
      as a first-class service — no profile, no credentials — writing a
      continuously-restorable copy into a folder beside the deployment, from which an
      outer script takes it off the machine. Restoring from the *live* replica gives
      `integrity: ok`, schema v4 and all 440 rows; `make backup-drill` repeats it end
      to end on a copy, source destroyed first. `make status` warns when the replica
      has not been written in an hour, and `backup-check` says plainly that it can
      only see the local half.

- [x] **T0's sandbox is no longer untested.** Done 2026-08-04: a package whose
      `npm test` is a hostile script, run through the real `runTests` path with the
      deployed config. The knowledge base, the attestation signing key, the deploy
      keys, the docker socket, every host root, DNS, TCP and writes to the read-only
      sources were all blocked; `CapEff` is zero, pids capped at 512, memory at 2 GiB.
      A `sleep 600` suite is killed at the limit and reported as *did not finish*
      rather than *fails*, which are different claims. Transcript in `MEMO.md`.
      Worth stating plainly since the probe was written the other way round: the real
      threat here is a **careless** suite, not a hostile one. Nobody is attacking this
      workgroup. The containment matters because a test can hang, eat the box, or
      write where it should not by accident — and it holds against all of that.

- [ ] **The sandbox writes as uid 0, and the cache it writes to is shared.** Not a
      security item — the threat here is a *stupid* test suite, not a malicious one,
      and against accidents the container is already enough. It is an ownership
      problem: `cacheRoot` and `scratchRoot` live under the data directory and are
      reused across reviews, so a suite running as root leaves root-owned files that
      `lore` (uid 1000) then cannot rewrite or clean up. Watch for it when
      `LORE_RUN_TESTS` goes on; `--user` fixes it, and needs those two directories
      to be writable by whichever uid is chosen.

- [x] **T0 executes the target's suite** (D-60). Done 2026-08-04.
      `LORE_RUN_TESTS=1`, and four faults had to be cleared before anything ran —
      the image had the docker socket but no client, the socket's group was not
      granted, the data directory did not mean the same thing inside the container
      as on the host (so Docker mounted an empty one), and the sandbox's sync
      swallowed its own failure. Verified both directions: lore's suite runs clean
      in the sandbox, and a deliberately failing suite yields exactly one
      high-severity finding.

- [x] **Announce a diff too big for the tier** (D-58). Done 2026-08-04. `usage` now
      records every run's diff size, and a round warns before spending when the diff
      exceeds the largest that tier has ever *finished*. The threshold is the tier's
      own demonstrated best rather than a constant — with no evidence it says
      nothing, and a timed-out run never raises the ceiling.

- [ ] **Set the exploration cap from data** (D-50) — and the data still says *not yet*.
      84 completed runs, re-measured 2026-08-05 (the 2026-08-04 table had 54):

      | tier | n  | p50 | p90 | p95 | max | latency p50 | p90   | max   |
      |------|----|-----|-----|-----|-----|-------------|-------|-------|
      | t1   | 53 | 20  | 35  | 40  | 59  | 289s        | 489s  | 590s  |
      | t2   | 22 | 41  | 52  | 52  | 68  | 820s        | 1180s | 1851s |
      | t3   | 9  | 11  | 16  | 16  | 16  | 135s        | 1633s | 1691s |

      Twenty-two more t1 runs, six more t2 and two more t3 moved **no maximum at all**
      — 59, 68 and 16 are the same ceilings the smaller sample showed. That is the
      useful result: the tails are stable, not merely unsampled.

      I claimed earlier this showed the cap must be per tier. Reading the spread
      rather than the medians says the opposite: t1's max is 1.5× its p95 and t2's is
      1.3×, so the tails are long, and t3 still has **nine** samples — calibrating a
      cap on that is exactly the trap this item exists to avoid. **No runaway has ever
      occurred**, so the cap protects against something unobserved while risking
      killing paid-for reviews that are merely thorough.
      What it needs: more t3 runs, and a real mid-flight abort — `countSteps` is read
      after the reply, so capping means polling during the call and calling
      `session.abort`, which is machinery worth building only once there is something
      to catch.

- [x] **T0 runs the target's own tooling, in the sandbox.** Done 2026-08-05.
      `tsc` and `eslint` resolved their binaries out of the target's `node_modules`
      and ran in the SERVICE container — the same dependency tree the sandbox exists
      to contain, next to the knowledge base, the signing key and every provider
      credential. Both now run inside the sandbox off one install, and where the
      target declares `typecheck` or `lint`, that script is what runs.

      Verified on a real pnpm monorepo PR, and it took three passes to become true:
      the first reported all three of its gates failing, which was our missing pnpm;
      the second still reported typecheck and lint failing, which was pnpm fetching
      its own declared version under `--network none`; the third reported only the
      suite failing, which the author's commit says is deliberate. Two rounds of
      confident false claims about someone else's branch before it was right.

## Later

- [ ] **Exercise the three paths that have never happened.** `passed_partial`
      (D-48/49), `needs_human` (D-39 — zero conflicts recorded, ever), and a real
      quota exhaustion. All three have code and tests; none has occurred in
      production, and a path whose first real execution is during an incident is a
      path nobody has reviewed.

- [ ] **The spend ceiling guards nothing today.** Zero of 84 usage rows have
      `cost_usd > 0` (re-checked 2026-08-05, 30 more runs, still zero), because both
      providers are subscriptions, and `ops/spend.ts`
      sums exactly that column. Not wrong — inert. It needs either a metered provider
      to be meaningful, or an honest statement that it cannot fire under a
      subscription, so nobody reads its silence as headroom.

- [x] **The claim cap was the wrong 300** (D-64). Decided 2026-08-05 by Vany: raise
      it to 500. The number now lives in one place and is interpolated into the
      output contract the models read, so the prompt can no longer state a limit the
      schema does not enforce, and both tests derive from the constant.

- [ ] **One bad finding still discards a whole reply.** Separate from D-64 and still
      open: `extractFindings` fails the batch if any finding fails the schema. Raising
      the cap removes the trigger that fired four times; it does not change what
      happens when something else in a batch is malformed — `cwe: ""` and `cwe: null`
      both did, and both are now forgiven individually rather than by policy. The
      question left is whether partial acceptance with a loud record of what was
      dropped beats failing the batch. Wants a decision, not a patch. The evidence
      below is what D-64 was decided on and is kept because it is the best record of
      what the all-or-nothing rule costs.

      **2026-08-05, the fourth occurrence and the worst.** t2 spent **40 minutes** on
      round 5 of lore's own review and returned one finding over the 300-character
      `claim` cap. Told the exact rule, it retried — and came back **still over**:

      | reply | claim length | over |
      |---|---|---|
      | first | 358 | 58 |
      | retry | 314 | **14** |

      Both discarded; the review is `failed`. The retry shortened the claim by 44
      characters and missed by 14, which is the detail that matters: the model is
      trying to comply and cannot land it. (An earlier note here said 42 characters
      over — measured wrong, from the error text rather than the reply.)

      The claim it threw away was **correct and load-bearing** — `openFindings` had
      no latest-verdict gate, so a justification accepted and later rejected counted
      as neither open nor settled. Fixed in `966b12a`, from the error message alone.
      So the cap did not filter noise; it filtered a real defect and charged 40
      minutes for it.

      Also worth weighing: **the retry does not work on this rule.** It names the
      violated constraint and the model exceeds it again — twice now. Whatever is
      chosen should not assume a second retry converges.

      Options, none free: raise the cap; accept the batch and truncate the claim with
      the full text kept in evidence; accept the valid findings and record loudly
      what was dropped; or keep failing and treat the cap as a real contract. **This
      changes how much quota a failed round burns, so it is Vany's call** — the
      project rule is that anything altering model spend gets discussed first.

- [ ] **Prove Phase 3's actual done-criterion.** A fresh Claude Code session, given
      no instructions beyond the MCP tool descriptions, drives a review to `passed`.
      Every review so far has been driven by hand with shell scripts, so what is
      proven is the service, not the documentation — and `spec/agent-docs.md` §1 says
      the docs *are* the interface.

- [ ] **The Orange Pi.** The deployment is arm64 and running, but on a MacBook via
      Docker Desktop. `spec/deployment.md` and `PLAN.md` §4.1 target the device, and
      D-37's T0 throughput budget was measured for it, not for this.

---

## Done

Ticked because it is **running and observed**, not because it was written.

- [x] **P0 — the pure core.** Findings + Zod schema with optional `cwe` (D-44) and
      the fingerprint `sha256(normalized_claim ‖ file ‖ enclosing_symbol)`; the
      SQLite store behind a repository interface (8 tables, WAL, migrations that can
      only add columns); verdict staleness via `scope`, watched expiring a real
      justification in production; the `lore-ok` parser, now **three** forms — `//`,
      ` * ` in a block, and `<!-- -->` (D-57); the escalation state machine,
      property-tested to terminate from any starting point; and review types as
      named pipelines (D-43).
- [x] **P1 — one real review.** Git boundary (bare clone, worktree per review,
      fresh `into` fetch), T0's deterministic engines, the agentic opencode reviewer
      with one retry then loud failure and caching from the first call (D-29 —
      observed at 100k+ cached tokens per call), tier prompts by position (D-31),
      doc ingestion (433 ingested rules), and the CLI with exit codes as its API.
      **Except the test sandbox, which is open above.**
- [x] **Phase 2 — knowledge.** 440 rows when this was ticked on 2026-08-04; 986 today,
      79 of them live and 11 derived, the rest retired as their sources changed. Its
      done-criterion is
      met and was watched happening: D-51 carried an accepted justification into a
      later review of the same repo — `lore-ok d6d9cd72 (carried)` — with a test
      covering the cross-review path.
- [x] **Phase 3 — the service.** MCP surface with `type` from day one, resources,
      the review prompt, provisioning, scheduler, two-stage, inbox, attestation.
      Two reviews reached `passed` and both attested. **Except the fresh-session
      criterion, which is open above.**
- [x] **Phase 4 — deployment and operations.** arm64 images, docker compose,
      heartbeat deadman, spend ceiling, and the coloured operator view (`make
      status`) which is what caught several of this session's defects.
      **Except backups and the device, both open above.**
- [x] **Phase 5 — review types and security.** `security/{sbom,osv,vex}` wired as
      T0 engines, reachability guidance in the tier prompts, real CycloneDX VEX.
- [x] **The four measurement questions P1.7 asked** are answered for the deployed
      ladder, in `MEMO.md`: latency and turns per tier (table above), parse-failure
      modes and their causes, the diff-size ceiling, and cost — `$0`, because both
      tiers are subscriptions (D-54). What is *not* answered is the original form of
      the question: candidate models compared over branches with known defects from
      `~/c`. That comparison was overtaken by the subscriptions being bought.
- [x] **Toolchain, landscape, MCP and security research.** `research/*`, each dated.
- [x] **Plan.** `PLAN.md`.
