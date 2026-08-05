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

Five of the six items below were fixed the same evening; what they say is kept
because the numbers are the reason the fixes happened.

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

- [x] **A stale mirror was the largest single cause of failure.** Done 2026-08-05,
      D-65. It was 3 of 9 failed jobs and 3 of 5 that day — more than any model or
      transport fault — and the refusal at 18:23 read *last fetched 192 minutes ago*.
      The refusal was right and its instruction was unfollowable: `make mirror` runs
      on the host, and the client is an agent with no shell there.
      Vany's call, and the right one: *"make mirror is not the client's
      responsibility, our service must do this, we can be on another machine or
      another user."* So a process on the host does it: `mirror-refresh.sh` every five
      minutes under launchd, outside docker, with the credentials this machine already
      has. lore still holds no git credentials and still refuses a stale mirror — what
      changed is that nobody has to remember. `make mirror-daemon` installs it.
      Its one weak point is that lore cannot tell whether the timer is alive, which is
      why `make status` prints every mirror's age and turns red at the threshold that
      refuses a review.

- [x] **The reviewer container could read every secret on the box.** Found and fixed
      2026-08-05 while deciding where a git credential could safely live — checked
      rather than assumed, and the assumption was wrong. `opencode` runs third-party models
      with file-reading tools, as the **same uid** as `lore` (it must: it writes its
      own session state), and mounted the entire data directory read-only. Verified
      from inside that container: the attestation signing key `attest_ed25519.pem`
      (mode 0600, defeated by the uid match), `lore.db` at 0644, and a leftover D-62
      deploy key still on disk from an earlier decision. None of it is needed to read
      a worktree. It now mounts `<data>/repos` only, re-verified after the restart.

- [x] **The client restarts reviews instead of continuing them.** Fixed 2026-08-05.
      Six reviews of `feat/RIGID-125`, four of `fix/RIGID-135`, four of `main`, and 13
      of 30 stopping at round 1 — while the ladder needs round 2 to settle anything.
      Both halves were missing: nothing told the client `review_submit` continues a
      review, and nothing noticed it starting a fifth. `review_start` now refuses with
      the id to continue, and `restart: true` is the deliberate way through after a
      rebase. Refused rather than silently returning the open review — handing back an
      id that is not the one asked for is the quiet substitution this project refuses.
      **Whether this actually changes the client's behaviour is unmeasured.** The
      refusal is new, no client has met it, and the belief that it will help is a
      hypothesis. Re-read the per-branch review counts after a day of real use.

- [x] **18 findings were produced and never collected.** Fixed 2026-08-05. The fact
      was in `delivered_at` the whole time and nothing asked. `make status` now has a
      "waiting to be collected" section and `/status` an `uncollected` array, both with
      the age and the high count. It lit up immediately: **23 findings across 5
      reviews, 16 of them high, unread for seven hours.**

- [x] **The ingester was fixed and no row in the database came from the fixed one.**
      Done 2026-08-05, on Vany's approval to re-ingest both repos. `dda312f` landed at
      17:27; every live row predated it, because re-ingestion triggers on *the source
      document* changing, not on the reader changing. Retired 59 + 8 rows with a reason
      naming the fix and re-read the docs. The genuinely broken fragments are gone —
      `spec. Hand-rolled HTTP against opencode is a last resort`,
      `response, an exhausted quota and a timeout are all "did not run"`.
      What my "starts mid-sentence" count still reports is a **false positive**: the
      survivors begin with lowercase *identifiers* (`claimJob`, `tenantId`,
      `networkTxnId`, `make status`) and are complete sentences. Worth recording so
      the metric is not read as unfinished work.

- [x] **`rigid-monorepo` started every review from 11 rules.** Fixed 2026-08-05, and
      the cause was not the ingester's parsing at all — it was that nothing ever opened
      a decision record. `discoverable()` returned the six root files; `RULE_DIRS` sat
      beside it looking used, consumed only to *scope* a rule that could never be
      found. `spec/knowledge.md` §2 promised "CLAUDE.md, PROG.md, SPEC.md, ADRs" the
      whole time. rigid has **37 ADRs** and lore has a whole `spec/`, none of it read.
      Now: rigid 8 → **128** rules from 41 documents, lore 59 → 116 from 9. Spot-checked
      rather than counted — *"Money values use Money<Currency>, never number"*,
      *"expires_at is mandatory (NOT NULL) on every hold"*, *"tenantId must be a UUID,
      lower-cased on the way in so one tenant has one spelling in RLS"* — which is
      exactly the reasoning a reviewer cannot infer from the code.
      Still true that **zero verdicts exist on that repo**, so nothing is being
      *derived* there yet. That half remains open above.

- [x] **T0 is partly blind on the repository it actually reviews.** Resolved
      2026-08-05, by deciding what `unavailable` is for. ast-grep needs
      project-authored structural rules and no repository lore has ever met has any,
      so it reported NOT RUN on every review for a check that never existed. That
      trains the reader to skim the list — including on the day it says the test suite
      did not run. Optional engines are now **absent** rather than **missing**, logged
      for the operator and kept out of the client's report. tsc and eslint stay gaps
      when they are missing, because for a JS project they are.

### What the client's own report adds

`~/c/REPORT-2026-08-05-manual-lore-prs.md` §5–§7, written 17:57 by the session that
drove today's reviews. It is the first outside account of this service, and its
verdict is the strongest evidence the project has: *"Working, and it earned its place
on the first run — it overturned a 'ready to land' call that I had made and that
GitHub's own signals supported."* Specifically, lore caught that the full suite fails
on `fix/RIGID-135` where GitHub was green (PR checks run `turbo … --affected`, lore
runs all of it), and that the branch was 22 commits stale while GitHub said
`MERGEABLE`. It names `history` — *"seen 6× before in this repo — this is a pattern,
not an incident"* — as the thing nothing else in their toolchain does. That is D-14
landing with a real user, and it should not get lost among the defects below.

- [x] **The running service was 21 commits behind.** Deployed 2026-08-05 22:5x. The
      container had been built at 15:15 and everything since was unrunning, including
      the two items the report's §7 listed under "Needs you — lore, as its owner":
      `2c527c1` *"`failed` carried no reason, so the client invented one"* and
      `49179a2` *"the reviewer recomputed the diff with two dots and invented a bundled
      refactor"*. Both are live now, along with the ingest fix, `LORE_RUN_TESTS` off by
      default, the mirror-scope fix and `relocate`.
      Worth keeping as a habit rather than an incident: **the code being right is not
      the service being right**, and nothing in `make status` says how old the running
      image is. That gap is its own item below.

- [x] **A new client's first question about the knowledge base was answered `0`.**
      Fixed 2026-08-05. The report's §7 recorded `knowledge_query` → `count: 0` and
      concluded *"the knowledge store is empty"*. The query worked; the zero was true
      and meant something else. `bootstrap` runs on the first **review** (D-35,
      deliberately — there is nothing to read until a mirror exists), so between
      provisioning and the first completed review the honest reading of a bare zero is
      *this product is empty*. Now the `note` distinguishes three cases: nothing
      learned YET (with the two things that resolve it), a filter that matched nothing
      against a repo that does know things, and a normal answer. `TOOL_DOCS.query` says
      so too, and two tests hold it.

- [x] **A justified finding is still raised at `high` every time.** Decided
      2026-08-05 as **D-67: it stays.** The finding is TRUE — a loopback URL in a test
      really is an unencrypted request, and what makes it acceptable is context a rule
      engine does not have. Demoting on familiarity would make the second sighting of
      a real defect report as less serious than the first, and the same machinery that
      quiets a known false positive would quiet a known-and-recurring genuine one.
      `history` informs the reader and never discounts; the docs now say so. The place
      to spend a justification is the finding, not the class — an accepted one settles
      it and carries forward (D-51), which is quieter and says something true.
      *Superseded reasoning below, kept because it is what the decision was made on.*

  <details><summary>the evidence D-67 was decided on</summary>

      **A justified finding is still raised at `high` every time.** Narrowed from what
      I first wrote here, which overstated it. Two of the four findings the client
      evaluated are semgrep `http://` hits in **test fixtures** at `high`, and lore has
      derived the rule on both repos — *"This codebase repeatedly produces CWE-319
      findings (4 so far)"* — plus a full accepted justification explaining why a
      loopback URL in a test file is not a plaintext risk.
      What I got wrong: the client **does** see this. `enrich()` attaches
      `priorOccurrences` and the related rules to every finding including T0's, and the
      report praises exactly that (*"seen 6× before in this repo"*) as the
      differentiator. So knowledge reaches the client; it does not reach the
      **severity**. `src/t0/runner.ts` never calls `knowledgeFor`, and an engine's
      rating is fixed at the engine.
      Whether accumulated verdicts should move a severity is a real question — it
      changes what gets reported as `high`, and a finding that is genuinely true should
      probably not be demoted for being familiar. Wants a decision, not a patch.

  </details>

- [x] **Nothing says how old the running image is.** Fixed 2026-08-05. `make up`
      stamps the checkout's commit into the image and `/status` reports it, with
      `-dirty` when the tree had uncommitted changes and `unknown` for a build that
      was not stamped — honest rather than plausible.

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

- [x] **The sandbox writes as uid 0, and the cache it writes to is shared.** Fixed
      2026-08-05: it runs as lore's own uid, asked of the process rather than
      configured. Verified rather than assumed, because it affects every review that
      typechecks — the sandbox image's own user is already uid 1000, the shared cache
      and scratch are writable from it, and `npm ci` runs clean under `--network none`.
      *Original note below.*

  <details><summary>what the ownership problem actually was</summary>

      **The sandbox writes as uid 0, and the cache it writes to is shared.** Not a
      security item — the threat here is a *stupid* test suite, not a malicious one,
      and against accidents the container is already enough. It is an ownership
      problem: `cacheRoot` and `scratchRoot` live under the data directory and are
      reused across reviews, so a suite running as root leaves root-owned files that
      `lore` (uid 1000) then cannot rewrite or clean up. Watch for it when
      `LORE_RUN_TESTS` goes on; `--user` fixes it, and needs those two directories
      to be writable by whichever uid is chosen.

  </details>

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

- [x] **Exercise the three paths that have never happened.** Done 2026-08-05:
      `passed_partial`, `needs_human` and quota exhaustion now run end to end through
      `runRound` against a real worktree and store. Writing them corrected my model of
      the ladder twice — one unpayable tier is `fast_clean` with more to come, not a
      partial pass, and the ladder steps OVER an exhausted tier to try the next rather
      than giving up, failing only when nothing is left that could read the code.
      Still true that none has occurred in **production**; what is closed is that
      their first real execution will not be their first execution.

- [x] **The spend ceiling guards nothing today.** Fixed 2026-08-05 by making it say
      so. It cannot fire under a subscription and never could; what changed is that
      `/status` reports `metered: false` with a note that a zero means *unmeasured*,
      not *headroom*. Those are opposite facts and looked identical.
      *Original note below.*

  <details><summary>why it is inert</summary>

      **The spend ceiling guards nothing today.** Zero of 84 usage rows have
      `cost_usd > 0` (re-checked 2026-08-05, 30 more runs, still zero), because both
      providers are subscriptions, and `ops/spend.ts`
      sums exactly that column. Not wrong — inert. It needs either a metered provider
      to be meaningful, or an honest statement that it cannot fire under a
      subscription, so nobody reads its silence as headroom.

  </details>

- [x] **The claim cap was the wrong 300** (D-64). Decided 2026-08-05 by Vany: raise
      it to 500. The number now lives in one place and is interpolated into the
      output contract the models read, so the prompt can no longer state a limit the
      schema does not enforce, and both tests derive from the constant.

- [x] **One bad finding still discards a whole reply.** Decided and fixed 2026-08-05
      as **D-66**: the rejected finding loses its own line, the valid ones survive, and
      the loss travels to the client in `checks_skipped` — the same channel as an
      engine that could not run, because it is the same fact. The all-or-nothing rule
      turned on the word *silently*, and discarding everything drops the same defect
      plus every valid finding beside it. A reply where nothing parsed is still a
      failed round. *The evidence it was decided on is below.*

  <details><summary>the evidence D-66 was decided on</summary>

      **One bad finding still discards a whole reply.** Separate from D-64 and still
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

  </details>

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
