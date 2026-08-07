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

> **Superseded 2026-08-07, in the right direction.** `rigid-monorepo` now carries
> **117 verdicts** and 9 derived rules, against the zero above. Two of its branches
> reached `passed`, including `epic/RIGID-4-m1-managed` — the one that failed five
> times across two days and is still open below as an item. The table stays because it
> is what the fixes were decided on; this note stays with it so nobody argues from the
> zero again.

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

### 2026-08-06 — the second day, and what using it taught

The loop closed: a review of `rigid-monorepo` reached round 2 with every finding
settled, then the deep tier ran on that repo for the first time. Almost every defect
below was found by the client USING it or by me reading — not by lore reviewing
itself, which is the uncomfortable part.

- [x] **`needs_human` named no question.** Fixed: `open_questions` carries both
      statements and their sources, in `review_poll` **and** the inbox, which is where
      a client looks first and which I missed on the first pass.
- [x] **A token reached other repositories.** Scoping was per principal while tokens
      are minted per repository, and a workgroup provisions every repo to the same
      human — so the check did nothing (D-69).
- [x] **Findings from untouched files outranked the branch's own.** Marked
      `preexisting` and ranked last (D-68).
- [x] **The knowledge base taught reviewers to hunt for what the team had ruled out.**
      Recurrence was counted without reading the verdict; seven derived rules existed
      and not one was backed by a `fixed`. Now only fixed findings teach a lesson.
- [x] **A justification invalidated itself** (D-73). The livelock: one false positive
      justified and expired four times across nine rounds, 109 minutes of model time,
      21 duplicate rules written into the memory. `lore-ok` lines are stripped from the
      scope hash, and a fact is learned once.
- [x] **Test execution removed** (D-71), on Vany's call. lore reads a suite, never runs
      one.
- [x] **A deploy drains** (D-72) instead of throwing in-flight rounds away.
- [x] **The recurring shapes are checked mechanically** rather than by reading —
      `one-definition.test.ts`, and five of them taught to lore as knowledge, which had
      exactly ONE taught fact before today.

### 2026-08-06 — the debt sweep

Found by measuring the codebase rather than by reading it, after a proposal to
refactor. The code did not need restructuring — 11.6k lines, 47 modules, zero `any`,
zero `@ts-ignore`, zero `eslint-disable` — and every item below is something that was
*claimed* and not true, which is this repository's actual defect class.

- [x] **Three of nine devops alerts had no caller.** `backupStale`,
      `providerAuthFailed`, `needsHumanAgeing` — defined, believable, sent from
      nowhere, while `spec/operations.md` §2.1 listed two of them under *page,
      someone should look now*. The only replica check lived in `make status`, which
      is a command a human runs. lore now mounts the litestream folder read-only and
      beats on it; a rejected provider credential gets its own error type and pages
      immediately rather than waiting for the failing-as-a-class window.
      The replica condition is **behind the database**, not "not written recently" —
      rebuilding the freshness form would have re-earned the mute it got in D-59.
- [x] **`/status` always answered `ok: true`.** A literal, including on the beat that
      paged for a critical disk. Computed now, with `problems` naming why.
- [x] **`queryCommit` had no caller.** OSV by commit hash — `PLAN.md` Phase 5 names it
      "needed for submodules" and D-36 says this workgroup ships submodules. So the
      security review enumerated `package-lock.json` and reported clean about a
      vendored tree it never queried. The engine also shared `sbom`'s `package.json`
      gate, so a submodule-only repository skipped it entirely.
- [x] **A token could not be revoked.** `revokeToken` took the secret, which is shown
      once and never stored, so an operator revoking a leaked or lost token could not
      supply it. `make tokens` printed a `revoked_at` column nothing could set. Now by
      hash prefix, ambiguity refused rather than resolved. This answers SPEC open
      question 5.
- [x] **The check that should have caught all of this asked the wrong question.**
      `one-definition.test.ts` verified that an exported constant is read; `CONDITIONS`
      is read by three modules while three of its nine members were dead. It checks
      members of a routing table now — verified by planting a dead one and watching it
      fail by name.
- [x] **`isClean` was written as "the only predicate any caller should use" and no
      caller used it.** Four hand-written `state === "passed"`, including both `clean`
      fields the MCP surface hands a client. `passed_partial` has been left out of a
      hand-written state list three times here; in that field it would read as clean.
- [x] **Sixteen symbols exported and read only at home**, plus one genuinely dead
      (`quotaExhausted`, redundant with the live throw in `opencode.ts`). Both halves
      of the export sweep come back empty now.
- [x] **D-49's `[OPEN]` closed.** Its condition was "revisit when a second vendor is
      reachable"; D-74 made it three.
- [x] **The documents describe the deployed system again.** `spec/deployment.md` was
      the worst — Tailscale as the perimeter (D-33 retracted it), the T0 budget still
      counting test runs (D-71 removed them), replica freshness in hours (the Makefile
      does level-vs-behind), and a `### 3.1` orphaned between `## 5` and `## 6`.
      README said 488 tests in the badge and 355 in the body against an actual 552,
      `D-1…D-65` against D-74, GLM-5.2 and Sol in the architecture diagram against the
      deployed turbo and terra, and told the reader to run `make mirror` before every
      review, which D-65 made a host timer's job.

- [x] **Cap outbound model calls separately from worker concurrency.** Done
      2026-08-06. `LORE_MODEL_CONCURRENCY`, default 4 — above the 2 the deployment has
      been healthy at, well under the 12 that killed four reviews in 2.5 minutes. Work
      above it queues rather than failing, so being wrong low costs latency and being
      wrong high costs quota. Held for the whole session, not per request, because what
      loads a provider is the agentic exploration between prompt and reply. One
      `Reviewer` shared by every worker loop, or the limit multiplies by the worker
      count. `/status` reports `model_calls`, which is D-26's question for the half that
      could not previously queue at all.
      **Not done, and deliberately: the retry asymmetry.** `socket hang up` still is
      not retried while an unparseable reply gets one, which is backwards — a transport
      drop is the most obviously retryable failure there is, and D-66 showed the model
      does not reliably comply on the retry it does get. Left alone because a retry
      spends another call, which makes it a quota decision, and because the gate should
      remove most transport drops at source. Revisit with evidence from the gate rather
      than changing two things at once.

- [x] **Retire the duplicate derived rules the livelock wrote.** Done 2026-08-06: 19
      retired, keeping the oldest of each set — the one whose provenance names the
      review that earned it. rigid went from 27 derived rules to 8 real ones.
      Worth recording why this sat waiting: I held it, the re-ingest and the old
      fragments as though each were irreversible, when retiring keeps the row and its
      reason and every one was reconstructable. Vany: *"we can afford to lose some
      data."* Knowledge cleanups that are plainly improvements get done and reported,
      not asked about; what still gets a question is anything changing which model
      runs or how much quota burns.

- [x] **Kimi is in, and the ladder has one vendor per tier** (D-74). Done 2026-08-06:
      T1 Z.ai, T2 `kimi-for-coding/k3`, T3 OpenAI, three subscriptions. Model ids read
      from opencode's `/config/providers`, not from memory — `k3` carries 1M tokens of
      context against `k3-256k`'s 262k, and our largest review has already sent 204,609.
      Still unproven in the way that matters: **Kimi has not yet run a round.** A tier
      that is configured and has never executed is not a working tier, and this project
      says so about everything else.

- [x] **Submitting a diff through MCP is fragile in a way clients cannot diagnose.**
      Fixed 2026-08-06. `git apply --recount` absorbs the damaged hunk count — verified
      by reproducing the exact case, where plain apply fails and recount applies it
      correctly — and the leniency cannot produce a silently wrong tree because the
      tree hash is checked afterwards (D-40), which a test pins. Every failure message
      now names the fault rather than a position and says nothing was applied.
      `TOOL_DOCS.submit` carries both, since the client composes the diff.
      `applyPatch` had no test at all; writing one caught my own fixture being wrong in
      exactly the way the bug is about. *Original note below.*

  <details><summary>what the two failures were</summary>

      * **`corrupt patch at line 66`** — the diff ENDED on a whitespace-only context
        line, and reproducing it through a tool call dropped that line. The message
        names a line number in a string the client composed, which is the least
        useful place to point. Verified that `git apply` tolerates such lines being
        emptied, so the fault is specifically a diff whose LAST line is whitespace.
      * **`tree hash mismatch`** — I sent three of the five changed files. The guard
        worked exactly as designed (D-40: refuse rather than review a tree that
        exists nowhere) and the message was clear. Recorded because it is the honest
        half of the same session: one message was excellent, the other was not.

      Two cheap fixes: `git apply --recount` in `applyPatch`, which absorbs damaged
      hunk counts; and a message for a corrupt patch that says *what* is malformed
      rather than where — a client cannot debug a line number in its own payload.
      Worth doing before another agent meets it, because an agent that cannot submit
      cannot continue a review at all, and the loop stops there.

  </details>

- [x] **`make backup-check` could not see that the product was broken.** Fixed
      2026-08-06. It compared the replica against the database and never asked whether
      the database was READABLE, so it reported healthy for the whole period every
      table returned `database disk image is malformed` — a replica perfectly level
      with an unreadable file is a faithful copy of nothing. `make db-check` runs
      `PRAGMA integrity_check`, `backup-check` refuses before looking at the replica,
      and `make status` turns red on it. Through the container, because WAL over a
      Docker Desktop bind mount does not coordinate with a host `sqlite3`.

- [x] **The one-review-per-branch refusal pointed at stale reviews.** Fixed
      2026-08-06. It carries how long since the review last advanced, and past twelve
      hours says plainly that a snapshot the branch has left behind is reason enough to
      start again. Twelve is a working day's drift rather than a measured threshold — a
      hint to a reader who has the branch in front of them, not a rule. An unparseable
      timestamp reads as age zero, because "NaN hours old" in a refusal is worse than
      saying nothing.

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

- [x] **The replica monitor cried wolf.** Found and fixed 2026-08-06, on a restart.
      `make status` reported the replica stale while litestream was healthy and fully
      caught up — the newest replica file and the last write to `lore.db` carried the
      same timestamp to the second. The check asked *was a file written in the last
      hour*, and litestream writes only when there is something to replicate, so an
      IDLE database looks exactly like a dead replicator. It now compares the replica
      against the DATABASE: level is fine at any age, behind is a problem however
      recent the files are. Verified in both directions.
      Same shape as the spend ceiling, from the other side: one guard's silence read
      as safety, this one's noise read as danger. A monitor that cries wolf gets
      ignored, and this one guards the product.

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

- [x] **T0 executed the target's suite, and no longer does** (D-71 supersedes D-24).
      Removed 2026-08-06 on Vany's call: *"we will analyze it but not run, if test
      fails it is problem of repo owner."* Not disabled — removed. `tests` is not an
      engine, `LORE_RUN_TESTS` is gone, and nothing in the sandbox knows how to invoke
      a suite. Reading tests stays, and is a model-tier job.
      It had shipped and produced the best finding lore ever made, then spent a day
      reporting `tests: execution is disabled` on every single review — the `ast-grep`
      problem in the entry where skimming costs most. The record of what it took to
      make it work is below, because it is the honest history of a thing we removed.

      **Originally:** done 2026-08-04.
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

### 2026-08-07 — the day three people got tokens, and what the loop cost

Measured over one session that drove three reviews of this repository to a verdict: **17
findings, every one real**, 8 t2 calls and 112 minutes of deep-tier time. The items here
are what that session's own numbers say is in the way, not what reading suggested.

- [x] **Built 2026-08-07.** `review_submit` returns `will_not_settle` — the open
      findings naming code the diff did not change — sharing `codeMoved` with the real
      settle path rather than restating the rule, because a preview that drifts from what
      it previews is worse than none. `TOOL_DOCS.submit` also now says to diff from the
      returned `tree_hash`, which was a foot-gun I hit myself the same day.
      *The measurement that justified it:*

- [x] ~~`review_submit` knows what will settle and does not say so, for a round.~~ The
      largest measured saving on this list. Findings are settled by `settleFixed`, which
      is deterministic — not re-raised, and the hunk it named has moved — so at submit
      time lore already knows which of the client's fixes cannot settle. It waits a
      whole round (10–25 minutes, measured today) to say so by not settling them.
      Observed: three fixes submitted, two landed in a COLLABORATOR rather than at the
      named line, both sat open for a further round. "Fix it where the cause is" is an
      ordinary shape, so every client meets this repeatedly. The reply should say *"2 of
      3 name code this diff did not change; they will not settle on silence (D-56) —
      change the named line, or leave a `lore-ok` there saying where the fix landed"*.
      Costs nothing, changes no model routing, and teaches the mechanism at the one
      moment it is actionable.
      Second half, one sentence: `TOOL_DOCS.submit` should say the returned `tree_hash`
      is what to diff FROM next time. Getting that wrong is a foot-gun I hit once today;
      the refusal message caught it perfectly, which is the expensive way to learn it.

- [ ] **The per-tier bound counts rounds, not progress — and it has now killed two
      CONVERGING reviews.** `TODO.md` already argued the bound is the wrong instrument
      from a prose loop that never converged. Today is the opposite case, which is what
      makes it decidable:

      | | findings | settled | per-round | outcome |
      |---|---:|---:|---|---|
      | review 1 | 13 | 11 | 6, 3, 2 | bound |
      | review 2 |  6 |  5 | 3, 1, 1, 1 | bound |

      Both were answering nearly everything asked. Any single fresh finding in a fourth
      t2 round trips the bound however much was settled, so a review that answers 5 of 6
      questions gets the same verdict as one that answers none — and each restart costs
      a fresh t0+t1+t2 over the same tree (t1 alone was 1,251s on the third pass).
      **`core/ladder.ts` already learned this once**: the bound used to fire on CLEAN
      rounds too, and the comment there records a review that ran 485s, came back clean,
      and was reported `failed` by a counter. Bounding on **rounds that settled nothing**
      is that same correction one step further, and it still stops the prose loop, which
      settled nothing round after round — that is the discriminator the counter lacks.
      **Vany's call: it changes quota burn.** Not doing it is also a decision, and its
      cost is now measured rather than guessed.

- [x] **Fixed 2026-08-07.** `recordScreenedOut` deletes any earlier refusal of the same
      statement from the same document before writing, so there is one row per refused
      statement rather than one per time it was refused. The newest reason wins, being
      the one from the current reader and the current wording.
      *The measurement:*

- [x] ~~Screened-out rows accumulate one copy per document edit, for ever.~~ Measured
      after a single afternoon: 23 rows for 15 distinct statements, three copies of some.
      `retireForChangedBlob` only touches `retired_at IS NULL`, and a screen refusal is
      born retired — so an edited document writes a fresh set and the old set is never
      collected. `SPEC.md` and `spec/*` are edited most sessions. Same shape as the
      livelock that once wrote 21 duplicate derived rules, and the fix belongs beside it:
      retire-or-replace refusals for the same (provenance, statement) rather than
      appending. The all-refused case was fixed 2026-08-07; this is the changed-document
      case and it is still open.

- [x] **Fixed 2026-08-07.** A `lore-ok` is permanent in the source, so every later round
      found it matching nothing in ITS review and said so — 18 of 29 lines in three
      hours. Markers this repository HAS raised before are counted and summarised in one
      line; a marker matching nothing anywhere still gets its own, because that is the
      case the warning was written for (a typo, or an agent answering something never
      asked) and silence there would hide it.
      *The measurement:*

- [x] ~~`[lore:log]` is 60% noise, and it is the log INV-1 depends on.~~ 29 lines in
      three hours, **18 of them** `lore-ok[…] matches no finding in this review —
      ignored`: historical markers permanently in the source, 66 in this tree and rising
      with every justification anyone writes. The D-58 oversize warning and the knowledge
      counts share that log. A log nobody reads is exactly where a "did not run" hides.
      Two of the 18 are sharper than noise: `lore-ok[a1b2c3d4]` at `src/mcp/docs.ts:551`
      is **the example marker inside our own documentation**, parsed as though it were
      real. Harmless by luck here — but any repository whose docs SHOW clients how to
      write a `lore-ok` line gets it parsed as one, and an 8-hex-character collision with
      a live fingerprint would silently justify a finding nobody answered.

- [x] **Fixed 2026-08-07**, shipped with the bullet-whole change: lead-in (`…:`),
      `Label:` and gerund-head refusals. `Arguments: branch (required)` and
      `Two things a client must get right…:` are gone before the model is asked, which
      is work the screen no longer pays for.
      *The measurement:*

- [x] ~~The screen's three misses are mechanical, and I measured the rules that catch
      them without shipping them.~~ Live after the first real run: `Arguments: branch
      (required), into (required)` (a label line), the t2 prompt text `The easy defects
      are gone; look at design…` (quoted from elsewhere), and one carrying a stray `"*`
      markdown artifact. The lead-in, `Label:` and gerund-head refusals were measured at
      the time (51 rules, ~18%) and left out because the model screen was chosen instead.
      With the screen's own residue now known, they are complementary rather than
      redundant: cheap, deterministic, and they remove work the model is paying for.

- [x] **Fixed 2026-08-07, together with the integrity check — because the false alarm
      is what pointed an operator AWAY from the real fault.** `replicaState` now compares
      the newest replica file against what lore's own timestamps say it last WROTE, not
      against file mtimes; all four cases hold (idle level, dead replicator behind,
      unflushed WAL behind, touched-WAL-no-commit level). `deploy/Makefile`'s twin asks
      the container and falls back to file times SAYING WHICH IT USED, because it must
      answer while the service is down. Verified both ways.
      **And the incident that made it urgent**: the database became unreadable for twenty
      minutes and nothing noticed — `/status` was answering `ok:false` for this wrong
      reason the whole time. `checkHealth` now asks a FRESH reader whether the database
      can be read, on every beat. A check on the live handle reported clean against a
      genuinely corrupt file, because SQLite serves an open connection from its page
      cache; finding that out cost two attempts and is why the check opens a new
      connection.
      *The original entry:*

- [x] ~~The replica monitor cries wolf again, and it is the third version of the same
      mistake.~~ Observed 2026-08-07 immediately after a deploy: `/status` reported
      `ok: false, "replica 14m behind"` while litestream's own log said
      `txid.replica = txid.db = 000000000000061a` on every sync — the replica held
      exactly the transaction the database was at.

      | | |
      |---|---|
      | newest replica file | `…-000000000000061a.ltx`, mtime 18:46:49 |
      | `lore.db-wal` mtime | 19:00:21 |
      | litestream | `txid.replica == txid.db` |

      `replicaState` compares FILE MTIMES: newest replica file against
      `max(lore.db, lore.db-wal)`. SQLite touches `-wal` on open and on checkpoint, not
      only on commit, so a restart moves it with no transaction behind it. The quantity
      that matters is the transaction id — and litestream puts it **in the filename**.

      v1 asked *was a file written in the last hour*, and an idle database looked like a
      dead replicator. v2 (2026-08-06) compares the replica against the database, which
      is the right idea measured with the wrong instrument. A monitor that cries wolf
      gets muted, and this one guards the knowledge base, which is the product.

      Not a one-line change: `deploy/Makefile`'s `replica-state` implements the same
      predicate in shell — deliberately, so `make status` can answer while the service is
      DOWN — and `one-definition.test.ts` fails if the two disagree. Both move together
      or neither does.

- [ ] **Three people hold tokens on `rigid-monorepo` and the perimeter changed.**
      Provisioned 2026-08-07 for `koray` and `max`; `LORE_BIND` moved from `127.0.0.1`
      to `0.0.0.0` on Vany's call, so the service answers on every interface this laptop
      joins and **the tokens are the perimeter**. Two consequences that were theoretical
      yesterday: D-78 below is now live rather than hypothetical, and nothing yet has
      ever driven this service except sessions I primed — see Phase 3's done-criterion.

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

- [x] **`lore propose` — built 2026-08-07** (D-75, `spec/propose.md`). Vany's folder,
      commit and mode parameters, plus the `preserves` clause that keeps it a refactor
      tool. `conductSession` in `opencode.ts` now takes its extractor as a parameter, so
      proposals get the same gate, the same retry-carrying-what-was-wrong, and the same
      abort-on-failure that reviews do rather than a second copy of all three.
      What remains is the item below: nothing has been RUN, and the ideas are unmeasured.

- [x] **Ran `propose` across all eleven folders of `src/`, 2026-08-07.** 88 sessions,
      32 proposals surviving to `Appraise these`; `refactor.md` carries them and
      `lore/data/proposals/` the per-folder documents. Vany's call on the spend, after I
      argued for one folder first.
      **It paid for itself on its own folder.** It independently found the filename
      collision fixed by hand an hour earlier — and went further: `spec/propose.md` §1
      promised `YYYY-MM-DD-<n>.md` while the code shipped `<sha>`, drift introduced the
      same night. And it found a live defect: the budget guard checked `sessionsSpent`,
      incremented only after a SUCCESSFUL ask, so a run where every call failed never
      tripped the ceiling. Both fixed.
      Two faults in the tool, both fixed and both measured rather than imagined: four
      proposals named files that do not exist and nothing checked, and the knowledge
      screen classified every rule containing "do not" as a decision-against, which is
      most rules a codebase has.

- [x] **Appraised the 32 proposals, 2026-08-07.** Eight were real defects and are fixed
      (MEMO session 38); five the cross-vendor critic killed by itself, which is the
      design working and is worth more than the eight; the remaining nineteen are seam
      work whose value is unmeasured and which stay in `refactor.md`.
      **Four of the eight were INV-1 shaped** — a check that did not run reported as
      clean, a tier run open for ever, a review stuck `running`, a service that stopped
      working and said it was fine — in a codebase whose entire discipline is INV-1,
      found by models reading it cold. That is the argument for the tool.

- [ ] **Twenty-eight production sites still reach past the Store into SQL**, across
      **fourteen** files — not the seven I reported, which was a per-line grep missing
      `store.db\n  .prepare(`, and not the fifteen this item claimed until a review
      counted with the ratchet's own regex and got 28 across 14. A ratchet in
      `one-definition.test.ts` holds the list with a COUNT PER FILE and fails on a new
      file or a new site in an old one; both only shrink. Each site is a small missing
      method and the conversion is mechanical — but it is fourteen files of
      behaviour-adjacent change and should not be done in code with no ladder verdict.

- [x] **Re-measured 2026-08-07, and the stamp worked.** lore fell from **399 live
      ingested rules to 61** against a prediction of ~66, on the first review after the
      deploy, with nobody editing a document — which is the half that needed watching
      rather than assuming. rigid-monorepo still holds 181 old-reader rows and retires
      them on its own next review.
      Read twenty at random, then all 61: **about a fifth are still not rules**, and the
      cause was structural rather than semantic. `blocks()` takes a bullet whole and
      `extractRules` then split it back into sentences, so every multi-sentence bullet
      shed its tail as a free-standing "team decision" — *"The audit half of that design
      could never have fired"*, *"The easy defects are gone; look at design, seams…"*.
      Measured three variants over the real documents rather than arguing: bullet-whole
      with the modal required in the first sentence gives 38 rules and ~9% junk but
      **drops `CLAUDE.md` entirely**, because its bullets lead with an unmodalised
      summary. Bullet-whole with the modal anywhere gives 51 and ~18%. Adding lead-in,
      label and gerund-head refusals: still ~18%. Three narrowings, one floor.
      So the residue went to a model instead (D-81, below). The shape test was the right
      discriminator and is not a sufficient one; "stop mining prose" was the wrong
      conclusion to reach from the 20%, because 41 of the 61 are genuinely good rules
      nobody would have thought to teach by hand.

- [x] **The screen is measured, 2026-08-07, and it works.** First real run on this
      repository: **52 kept, 15 refused, and every refusal correct on inspection** —
      including three I had marked only "marginal" and one from prose written an hour
      earlier. Junk share 20% → 6%.
      **Cost, from `usage` once it recorded these at all**: 12 calls, 24s average and 99s
      worst, 70,800 fresh input tokens against 132,096 cached, $0 under the subscription.
      Against the same day's tiers — t2 156 min, t1 38, t3 27 — that is roughly **2% of
      review time**.
      What it does NOT catch is below. And `SPEC.md` D-81 still carries `[OPEN] — the
      screen has not been measured`, which is now stale in our favour: close it with the
      next change that fires a review rather than spending a review cycle on a paragraph.

- [x] **Built 2026-08-07: `lore knowledge` / `make knowledge`.** The product had no
      operator view at all — `lore` could list tokens, repositories and tiers, and the
      memory this service exists to build could only be read with hand-written SQL
      through the container, which meant only whoever wrote the SQL could read it. It
      shows live rules by source, kept-against-refused per document with the share, the
      unscreened count, and `--refusals` prints what was thrown away with the model's own
      reason — which is what makes D-81's "a refusal is recorded, not silent" worth
      anything. **It caught itself on first run**: the refusal list counted 40 beside a
      tally of 15, because a statement re-screened gets a freshly-worded reason each time
      and `DISTINCT` over three columns is not one row per statement.
      *The measurement that motivated it, kept:*

- [x] **Fixed 2026-08-07: `make status` carries it**, in the place an operator already
      looks — live rules, any UNSCREENED documents in red, and the worst refusal share
      per repository, with `make knowledge REFUSALS=1` named for the detail. A floor of
      four candidates before a share is reported, because the first version's "worst"
      was an ADR with one candidate refused, printed as 100% — a ratio on a denominator
      of one, in the line a reader is meant to act on. Measured per document on the first real screen run: `CLAUDE.md` and
      `PROG.md` were refused **0 of 13**; every one of the fifteen refusals came from the
      explanatory specs, and the worst three were the three edited most that day.
      `CLAUDE.md` says specs describe the system as it stands and change-narrative belongs
      in `MEMO.md` — so the screen is mechanically detecting where that rule was broken,
      which is not what it was built for and is more useful than what it was built for.
      Cheap to surface: refusals grouped by `provenance` in the operator view. A document
      whose refusal rate jumps is one where somebody has been writing session notes into a
      spec, and today that somebody was me.

- [x] **Fixed 2026-08-07: a bullet is one statement, and the rest is its `why`.**
      Coverage went from **5 of 66 to 30 of 58** over this repository's own documents,
      with real reasons — *"The moment ids are guessable, every log line that contains
      one becomes a credential"*. It removes the tail-fragment class at source rather
      than filtering it later, and the lead-in, label and gerund-head refusals went in
      with it. EXTRACT_VERSION 4.
      **The known cost, recorded rather than hidden**: a bullet that really holds two
      rules keeps only the first as a rule; the second becomes the reason, so it still
      reaches every prompt, attached rather than standing alone. Rarer than a rule
      followed by its justification, which was producing most of the fragments.
      *The original entry:*

- [x] ~~Only 3 of 61 extracted rules carry a `why`, and the fix is measured but not
      taken.~~ `splitReason` fires on *because / since / so that / otherwise* inside one
      sentence, and a bulleted rule states its reason as the NEXT sentence — so the
      reason is right there and gets thrown away, or worse, becomes its own contextless
      "rule".
      Measured 2026-08-07 over the real documents: treating a bullet as ONE statement,
      first sentence the rule and the rest the `why`, takes it from **3 of 61 to 25 of
      51** — real reasons, like *"The moment ids are guessable, every log line that
      contains one becomes a credential"*. It also removes the tail-fragment class at
      source.
      Not taken yet because it changes what every rule IS, not merely which survive, and
      it lands on top of a screen (D-81) that has itself not been measured. Doing both
      at once would leave neither attributable. Do this after the screen has a number.
      `why` is what the project says separates a rule from something the next reader
      deletes, so this half of D-20 stays unmet meanwhile, and knowingly.

- [ ] **The nineteen seam proposals are unappraised, not rejected.** `refactor.md` holds
      them. Each names one measurement; none has been run. The reason none was taken is
      that this codebase binds its incidents to positions in the code, and moving code
      is how it forgets its own bugs — so a seam change needs a reason beyond being
      tidier. If one of them ever has that reason, its `Settled by` line is already
      written.


- [x] **Mostly closed 2026-08-06 by `b860690`, and confirmed in production 2026-08-07:
      `epic/RIGID-4-m1-managed` reached `passed`.** `TooLargeForTier` decides before the
      call, from the model's own advertised window, and travels to the client in
      `checks_skipped` — so the branch that failed five times is reviewed rather than
      diagnosed. `compactToFit` shrinks the diff to the tier that will read it instead of
      to a constant.
      **What remains open is narrower and is the D-58 half**: the time-budget warning —
      *"this diff is N KB, larger than anything this tier has ever finished"* — is still
      `console.error` only. That case is different in kind: the diff FITS the window, so
      nothing refuses, and the risk is a tier spending its whole budget and timing out.
      It is worth carrying to the client for the same reason the context case was, and
      it has never happened since the context fix, so there is no evidence to size it by.
      *The original entry is kept below: it is the best record this repository has of
      what a correct diagnosis costs when it reaches the wrong reader.*

  <details><summary>the original item, and what the loop cost</summary>

      **lore knows why a branch cannot be reviewed and tells the one party who cannot
      act on it.** Five attempts on `epic/RIGID-4-m1-managed`, across two days, every
      one failing identically:

      | | |
      |---|---|
      | attempts | 5 (08-05 ×2, 08-06 ×3) |
      | diff | 741 KB against a 228 KB demonstrated t1 ceiling — **3.3×** |
      | spent | ~21 minutes of T0, 10 model calls (first + retry each time), all empty |
      | outcome | `failed`, every time, same cause |

      D-58's guard fires correctly on every attempt: *"this diff is 741 KB, larger than
      anything t1 has ever finished (228 KB)… A smaller review scope is the fix, not a
      longer timeout."* It is `console.error` to `[lore:log]` (`review.ts:196`) and
      reaches the client **nowhere** — not `failed_because`, not `checks_skipped`, not
      the poll response.

      What the client gets instead is *"first reply was EMPTY (usually a provider
      failure inside a 200)"*, and `TOOL_DOCS.poll` tells it `failed` is *"often
      TRANSIENT — an identical retry frequently succeeds — so retry once before
      concluding anything"*. **So lore diagnoses the problem correctly, sends the
      diagnosis to a log the client cannot read, and then instructs the retry loop it
      is watching.** The client is behaving exactly as documented.

      This is INV-1's shape one layer out: the information exists, is right, and is
      delivered to whoever cannot use it. The fix is not a bigger warning — it is that
      the oversize notice must travel to the client, in `checks_skipped` or
      `failed_because`, saying the diff is N× what this tier has ever completed and
      that the answer is a smaller review scope.

      **Whether it should also REFUSE above some multiple is a separate, harder call**
      and is Vany's: D-58 chose warn-and-proceed because a tier may manage more than
      its previous best and a review stopped by a guess is worse than one that runs
      long. That argument held at 1.2×. At 3.3×, with five identical empty replies and
      no successful run anywhere near that size, it is buying nothing and costing
      quota. Evidence now exists where it did not when D-58 was written.

      **The client's own account, which is worse than the numbers.** From its
      handover: *"lore — three times, never ran… After you said the viewer was fixed,
      the third attempt failed byte-identically. So the pre-ready gate has never run on
      this branch, and `failed` concluded nothing about the code. **This is the one
      thing I could not work around.**"*

      And then the damage that is not quota. It reported to its operator that it was
      blocked on *"whether to proceed without a lore pass given **its tier is still
      broken**"* — a **false diagnosis of lore, which lore manufactured**, escalated to
      a human as a decision.

      Verified while reading that report: `glm-5-turbo` answers a probe in 5s, and t1
      **completed a 218 KB diff at 14:55 the same afternoon**, after two of the epic's
      failures. Recent t1 runs are `ok` across the board. The tier is healthy; the diff
      is 3.4× the largest it has ever finished. Nothing lore said would let either the
      client or its operator work that out.

      **What the loop actually cost, beyond quota.** The same handover reports two real
      defects its local gate could not see — every package runs
      `vitest --exclude '**/*.integration.test.ts'`, so a green run was not evidence
      about those files, and one excluded e2e test *"still asserted an unrequested
      partial approval, i.e. it was asserting the defect that ticket exists to remove."*
      Whether a test asserts what its name claims is precisely the reading D-71 assigns
      to the model tiers. lore never ran, so it never looked. That is the value the
      oversize loop spent five attempts failing to deliver.

  </details>

- [x] **Rewrite the tier prompts and the finding presentation for D-79.** Done
      2026-08-06. `failureScenario` is the test rather than a field; the bar is stated
      before position and before the question; an open finding carries `asks`; and
      `renderEnrichment` reads the prior verdicts and asks accordingly. The first
      tier no longer hears "expect obvious defects, report them cheaply, do not
      agonise", which is what it was told while producing eleven findings on one
      commit, nearly all of them wording. `prompts.test.ts` pins the bar rather than
      the wording — the prompts had no test at all, which is how they drifted.

- [ ] **Measure whether D-79 actually improved reviews.** The change rests on a
      diagnosis, not on a before-and-after: `PLAN.md` Phase 1's measurement harness
      was never built, so a prompt rewrite is currently being judged by the person who
      wrote it — the exact shape D-75 exists to be suspicious of.
      Cheapest honest version: take the last N reviews' diffs, re-run them under the
      new prompts, and count what changed — how many findings, how many carry a real
      failure scenario, how many the author accepted as true. Halving the count while
      keeping the two that mattered is evidence. Anything else is taste, and should be
      reverted rather than defended.

- [ ] **"Seen 23× — a pattern, not an incident" leads to nothing.** Asked by Vany
      2026-08-06: why does that sentence not make a client fix the underlying problem?
      Measured rather than reasoned — the three most-recurring findings in the store:

      | count | verdicts | finding |
      |---:|---|---|
      | 23× | justified-accepted, justified-rejected | `react-insecure-request` |
      | 23× | justified-accepted | `react-insecure-request` |
      | 17× | justified-accepted | `react-insecure-request` |

      **Sixty-three occurrences of ONE semgrep rule, accepted as justified every
      time.** The sentence is true and the pattern it names is that lore keeps raising
      a check this repository ruled out sixty-three times.

      Nothing acts on it, for four reasons of which one is fixable:

      - **The client has no verb.** The contract offers fix-this-line or
        `lore-ok`-this-fingerprint. There is no way to say "this check does not apply
        to this path here" once and have it hold for the class.
      - **The enrichment is an adjective.** File, line and `justify_with` all say
        *answer this occurrence*; the count sits beside them changing nothing. D-9
        enriches the report, D-67 forbids demoting on familiarity, and neither creates
        an obligation.
      - **D-51 makes it survivable.** The justification carries forward and the finding
        closes unargued, so the loop tolerates it perfectly and nobody is forced to
        deal with it — it just costs a line in every report and a slot in every prompt,
        for ever.
      - **Derivation ignores it, deliberately, and that is the gap.** Only `fixed`
        findings teach a lesson now (fixed this morning, because counting justified-away
        ones taught reviewers to hunt for what the team had ruled out). Correct — and
        the consequence is that repeated ACCEPTANCE teaches nothing at all, when it is
        the strongest evidence available that a check is wrong for a repository.

      The shape of the fix: N accepted justifications of the same rule on the same path
      class should derive a **suppression** — knowledge that says *this engine's rule
      does not apply here, because …*, carrying the reason the team already gave
      sixty-three times. Not a demotion (D-67 is right that a true finding stays high),
      and not a deletion: a recorded, reviewable belief that the next round consults
      before raising. Wants deciding rather than patching, because a suppression the
      ladder honours is a thing that can go wrong quietly, which is the one shape this
      project refuses.

- [x] **Built 2026-08-07** (D-78). `mine()` is the single gate, so poll, submit, cancel,
      attest, vex and the `lore://review/{id}` resource are bound by construction;
      `review_inbox` stays repo-scoped and is now the answer to "which of these are
      mine". **Rotation decided**: a revoked binding falls back to repository scope,
      because stranding a colleague's in-flight work is worse than the accident this
      prevents among people already trusted with the repository. One clause to reverse.
      SCHEMA_VERSION 11.
      *The original entry, and the reasoning:*

- [x] ~~Bind a review's delta stream to the token that started it~~ (D-78).

      **Live as of 2026-08-07, not hypothetical.** `koray` and `max` hold tokens on
      `rigid-monorepo` and the service now answers on every interface. Three holders and
      one repository is the exact arrangement this describes: whoever polls a review
      first takes its findings, the others are shown silence, and nothing tells anybody
      it happened. This is the item to do first.

      **Polling someone else's review consumes their findings.** `review_poll` returns
      deltas and marks them delivered, and D-69 scopes access by *repository* — so any
      token for a repo can poll any review of it, and the owner is never shown what was
      taken. Nearly done on 2026-08-06: asked to watch a review this session had not
      started, the obvious move was to poll it. Caught before the call.

      Record which token authenticated and require it for `review_poll`,
      `review_submit` and `review_attest`. `review_inbox` stays repo-scoped —
      "everything waiting for me" is a question about a holder, not about one review. A
      valid id from another token fails as NOT FOUND, per D-23.

      **Scope note, after getting this wrong once.** This is not about attribution:
      *who* started a review is `principal`, the person, and every agent acting on
      their behalf is them. A first version of this item claimed an audit-trail gap
      and there is none.

      **The token is never revealed** — not the secret, not a hash prefix, nowhere a
      client can read. That reverses this morning's `lore tokens` / `make revoke`,
      which key on the prefix (`auth.ts:86`, `cli.ts:139`): fine as an internal handle,
      wrong as the thing an operator types. A token gets a NAME at provisioning and
      `make revoke NAME=<name>` uses it, refusing an ambiguous name rather than
      resolving it. The `token.label` column already exists and currently holds
      "provisioned for vany" — the principal again, identifying nothing.

      **Decide rotation before shipping it.** Revoking a token would orphan the reviews
      it started — right for a compromised credential, inconvenient for a routine
      replacement, and the procedure written for SPEC open question 5 assumes overlap.
      Nothing is lost silently (the operator view sees them, the sweep collects them),
      but whether rotation can hand reviews over is a decision, and making it after
      someone rotates is the wrong order.

- [x] **A client can be told a review finished; we had been assuming it cannot.**
      Built 2026-08-06, D-80. `subscriptions/listen` on `lore://review/{review_id}`,
      woken by every state change and by nothing else; eight tests drive it with a real
      MCP client (`src/service/subscribe.test.ts`). The premise it contradicted —
      *"MCP servers cannot initiate requests"* — was true about **requests** and had
      been carrying an argument about **notifications** in SPEC §2, D-41/42 and
      `worker.ts`; all three now say what is actually true.
      Tasks (`CreateTaskResult`, `tasks/get`) were the other candidate and are the
      better conceptual fit, but change the client contract; recorded in
      `research/mcp-subscriptions.md` §3 so the choice stays a decision rather than a
      default. What is left is the item below.

- [ ] **The per-tier round bound is doing its job, and it is the wrong instrument.**
      Two reviews of this repository have now ended `failed` on it — five rounds in
      session 34, nine on 2026-08-06 — and both for the same reason: every answer to a
      prose finding is new prose for the next round to fault. The bound is a real
      terminal answer and stopping is right; what it cannot say is *why* the loop
      happened, and raising it would only buy more rounds of the same.

      What has been done: the failure now names the bound, the tiers and the rounds,
      and says the thing that actually ends it — answer MINIMALLY, then start a fresh
      review of the final tree. `review_submit`'s docs already say the same.

      What is NOT done and needs a decision, because it changes quota burn and is
      therefore Vany's: whether a *documentation-only* answer should reset the per-tier
      counter differently from a code answer, or whether the honest fix is that lore
      should stop reviewing its own prose past round N. Measure first: of the findings
      in the two runs that hit the bound, count how many were about wording versus
      behaviour.

- [x] **Found out what Claude Code actually does.** Measured 2026-08-07, and the answer
      made the question moot: it parses `resources.subscribe: true`, records it, and
      exposes **no verb** that can send `subscriptions/listen` — so the negotiated
      revision does not matter. Deeper: an agent client is not a process, it exists only
      inside a turn, and between turns there is nothing for a notification to arrive at.
      Lore cannot wake it and never will; only the harness could.
      So the job became *make leaving cheap, and make "when to come back" a measured
      answer* — `check_back_after_ms` and `review_inbox` as step 0. SPEC D-80 and
      `spec/mcp-async.md` §4 carry the record; the subscription surface stays, correct
      and unreached.

- [ ] **Does `check_back_after_ms` actually change client behaviour?** Same shape as the
      restart-refusal item: the number is shipped, the belief that a client will honour
      it is a hypothesis, and no client has met it yet. Read the poll counts per review
      after a day of real use and compare against the 10s-to-60s era. If clients keep
      looping, the instruction is not the lever and something else is.

- [x] **Measured 2026-08-07, and the loop closes.** All **265 of 265** findings have
      been collected. Time from raised to collected: p50 0.1h, p90 15.8h, max 22h — and
      **88 were collected more than an hour later, 40 more than twelve hours later**,
      which no single session spans. Spread across four days (52 late on the 4th, 25 on
      the 5th), so it is not an artefact of my own polling today, which accounts for 8.
      Sessions do come back and `review_inbox` is what brings them.
      What is still not proven is that they come back BECAUSE of it rather than by
      habit; that needs a client that has never been told, which is Phase 3's criterion
      below and cannot be measured from this table.

- [ ] **Auto-resolve a conflict whose rules can be ordered** (D-39, revised
      2026-08-06). Specced, not built. A person is called only when neither `source`
      rank (taught > ingested > derived) nor `verified_at` can show one rule
      superseding the other; both columns already exist. Where one wins, retire the
      loser with its reason — the mechanism `knowledge_resolve` already uses — and let
      the review carry on.
      The argument is asymmetry, not tidiness: a wrong escalation stops a review and
      spends a person, a wrong auto-resolution is recoverable because the reason is
      kept. The detector has fired once in production and was wrong, so stopping is
      currently the more expensive error.
      **MEASURED 2026-08-07, and the measurement says do not build it yet.** The store
      holds **one** conflict, ever, and it is resolved. Under the proposed rules it
      would have settled on `verified_at` — and it is the one this file already records
      as a FALSE POSITIVE, so auto-resolution would have silently retired a rule that
      should never have been touched, with a reason that read as considered.
      That is the whole argument reversed by its own evidence: the asymmetry claim —
      a wrong escalation spends a person, a wrong auto-resolution is recoverable —
      assumes the detector is usually right. At n=1 with that one wrong, the honest
      reading is that the DETECTOR is what needs work before anything is automated on
      top of it. Building on a sample of one is the trap D-50 names.
      Revisit when there are conflicts to reason about. Until then the escalation is
      rare enough that stopping costs almost nothing, and it stops the right way.

- [ ] **The reviewing model cannot ask for a human, and the spec says it can.** Found
      2026-08-06 by Vany asking what we actually tell a model about escalating.

      `spec/knowledge.md` §7.1–7.2 says *"the reviewing agent must actually resolve
      it… If the agent cannot resolve it, it must say so rather than pick"*, and D-39
      calls this *"the one place the system deliberately stops and asks for a person"*.
      None of that is wired:

      - `needsHuman` is set at exactly one line — `review.ts:574`,
        `store.openConflicts(repoId).length > 0` — entirely from `conflict.ts`'s
        heuristic. **The model cannot originate one.**
      - `prompts.ts` never mentions a human or escalation. The only such text is in
        `renderConflicts`, shown only once a conflict already exists.
      - That text says *"if you cannot decide, say so plainly and stop"* — and there is
        **no channel to say it in**. The output contract is a findings array; prose is
        not parsed. The model's answer changes nothing either way.
      - It could not act even if it decided: `knowledge_resolve` is an MCP tool for
        clients, and reviewers have no lore MCP (the staged opencode config carries
        only `plane`).

      So the escalation path is entirely deterministic, driven by a token-overlap and
      polarity heuristic that has fired exactly once in production and **was wrong**
      (session 32). The model that could actually judge a contradiction is shown the
      question, told to answer, and ignored.

      Two directions, and they are different in kind. **Wire the model in** — give the
      findings contract a way to say *"this needs a person, and here is the question"*,
      which makes D-39 true and lets a model raise an escalation the heuristic cannot
      see. Or **narrow the spec** to what the code does: conflicts are detected
      deterministically and only a client resolves them. The first is the better
      product and costs a schema change; the second is honest and costs nothing.
      Either way the spec stops describing agency that does not exist.

- [ ] **A `failed` that names a symptom invites a diagnosis, and clients make one.**
      Generalised from the entry above, because the oversize case is one instance and
      the shape will recur.

      `TOOL_DOCS.poll` already tells the client not to infer a cause from the word
      `failed` and to repeat `failed_because` verbatim. It did. The message it repeated
      was *"first reply was EMPTY (usually a provider failure inside a 200)"* — true,
      and a symptom. The doc then adds *"`failed` is often TRANSIENT — an identical
      retry frequently succeeds — so retry once"*, which is what turned one wrong
      inference into five attempts and a false report to a human.

      So the rule needs sharpening on OUR side rather than the client's: **where lore
      knows the cause, `failed_because` must carry the cause and not the symptom.** It
      knew here — it had computed the ratio and written it to a log. Two candidates,
      both cheap: `describeReply`'s "usually a provider failure" is a guess presented
      as an explanation and should be dropped when a better-founded cause is in hand;
      and a round that failed with a known aggravating condition should attach it.

      Related and unmeasured: the retry advice may be net-harmful. It was written when
      transport drops were the common failure; the gate should have removed most of
      those. Worth re-reading the failure mix before leaving that sentence in.

- [x] **Fixed 2026-08-07: the ladder is pinned to the review that started on it.**
      `review.tiers` records `id:model` per tier at `review_start`, and a round refuses
      to resume when it no longer matches the configured ladder, naming both. REFUSED
      rather than remapped — remapping needs a rule for a tier that vanished and another
      for one that appeared, and each is a guess about what the operator meant. Reviews
      predating the column are not checked: they were never pinned to anything, and
      stranding them over a comparison nobody made would be the guard causing the harm it
      prevents. SCHEMA_VERSION 12.
      *The original entry:*

- [x] ~~Changing `LORE_TIERS` silently rebinds every open review's cursor.~~ Found
      2026-08-06 by doing it: the deployment was switched to a Kimi-only ladder to
      prove that tier, then back to the three-vendor one, with a review open in
      `findings_ready`.
      `LadderState.cursor` is *"index into the tier list"* and `step()` resolves it as
      `tiers[prev.cursor]` (`core/ladder.ts:256`) against whatever config is loaded
      NOW. A review that ran `[t0, t1=kimi]` and stopped at cursor 1 resumes on
      `[t0, t1=glm, t2=kimi, t3=openai]` with cursor 1 meaning glm — so `tier_run`
      would carry two rows both called `t1`, naming different models and vendors, in
      the one table that exists to say whether a review really ran. Not a crash: a
      corrupted audit trail, which is worse.
      It also invalidates what was already recorded. That review carries `soleVendor`,
      true of the ladder it ran on and false of the one it would finish on.
      Options: pin the resolved tier list into the review row at creation and read it
      back (most honest, and makes an attestation describe what actually ran); or
      refuse to resume a review whose recorded tiers no longer match config, which is
      louder and cheaper. Either way `review_start` should record the ladder, not just
      an index into a file that can be swapped.

- [x] **Half fixed 2026-08-07: the retention sweep now COLLECTS it.** Cache and scratch
      directories untouched for fourteen days are removed and the bytes freed are
      reported, so the number is visible rather than discovered with `du`. Fourteen
      rather than zero because the cache exists to make an install cheap and a repository
      reviewed fortnightly should still find its dependencies warm.
      **And watched, same day**: the heartbeat measures lore's own footprint against a
      10 GB budget it sets for itself and raises a TICKET over it — not a page, and never
      a refusal, because running out of disk is the operator's to act on. Not the host's
      percentage, which belongs to whoever owns the machine (D-71) and is what the
      removed alerts got wrong. The comment that replaced those said "lore's whole
      footprint is under 5 GB" as though it were stable; it was 6.8 GB two days later,
      unnoticed, because the only thing watching had been deleted along with what was
      wrong about it.
      *The original entry:*

- [ ] **Nothing watches the one disk fact that is ours.** The host-disk alerts are gone
      (2026-08-06): a full disk belongs to whoever owns the machine, exactly as a
      failing suite belongs to whoever owns the repository (D-71), and lore was
      alerting in red about 826 GB it neither caused nor could fix.
      What remains unwatched is real. The sandbox `node_modules` cache grows without
      bound and is **4.4 GB of lore's 4.7 GB total** — a curve with no ceiling and no
      monitor. The right measure is lore's own footprint against a budget it sets, not
      the host's percentage. Recorded rather than covered by the number that was
      measuring something else.

- [x] **The cheap half is mechanical, 2026-08-07: `make smoke`.** Six checks driving the
      real MCP surface over the wire, from OUTSIDE the container — transport, the 401,
      a real client connecting, every tool the loop needs registered, and every tool
      carrying a description an agent could act on, since the docs are the interface.
      READ-ONLY by construction: it never starts or polls a review, because `review_poll`
      consumes deltas (D-78) and a check that damages what it checks is worse than none.
      **The expensive half stays open**, below: a fresh session driving a review to
      `passed` on the tool descriptions alone cannot be a script, because what is under
      test is whether the docs teach an agent nobody briefed.
      *The original entry:*

- [x] ~~Make D-76 mechanical, or accept that it is discipline.~~ A change to lore is
      validated over MCP, never by a CLI run — written down 2026-08-06 after I reached
      for the CLI *because* MCP would have required pushing the branch, which turned an
      operator's decision into a workaround that avoided asking for it. The workaround
      then failed on its first command, since the CLI had never been run from the host:
      `EACCES: mkdir '/var/lib/lore'`, the sandbox cache root defaulting to a container
      path. A surface nobody exercises does not work.
      Today nothing enforces it. `src/service/http.test.ts`'s field test drives the real
      surface in-process — good for drift, not a client over the wire — and the Phase 3
      criterion below is the real check and still unmet. Options worth weighing: a
      `make smoke` that provisions a throwaway token and drives start/poll against the
      running service, or accepting discipline and saying so rather than implying a
      guard exists.

- [ ] **Prove Phase 3's actual done-criterion.** A fresh Claude Code session, given
      no instructions beyond the MCP tool descriptions, drives a review to `passed`.
      Every review so far has been driven by hand with shell scripts, so what is
      proven is the service, not the documentation — and `spec/agent-docs.md` §1 says
      the docs *are* the interface.

- [x] **The Orange Pi is dropped, 2026-08-07, on Vany's call.** The deployment target is
      this machine: arm64 images under Docker Desktop, reachable to the workgroup over
      tailscale since `LORE_BIND` moved to `0.0.0.0`. Two people now hold tokens against
      it, which is the thing the device was going to be for.
      **What the device was carrying, and where it went**: D-37's T0 throughput budget
      was measured on RK3588 hardware (`PLAN.md` §4.1, still a real measurement of a real
      board and kept as history). Nothing in the running system depends on it — T0's
      concurrency comes from `LORE_CONCURRENCY` sized by cores at runtime, and the
      sandbox memory limits were raised for this host after a 2 GB OOM. The one honest
      loss is that "unproven: the device" leaves the list without ever being proven, and
      that is now a decision rather than an omission.

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
