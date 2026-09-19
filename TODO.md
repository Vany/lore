# TODO — `lore`

Phases, rationale and done-criteria live in **`PLAN.md`**. This is the working
checklist. One task at a time; finished work moves to `MEMO.md` with what was
learned, then gets struck here.

**Rewritten 2026-08-04**, because it had drifted badly: it still listed the SQLite
store, the git boundary and the whole MCP service as unstarted while all of them
were deployed in Docker and had carried two reviews to `passed`. A stale checklist
is the same defect this tool exists to catch — a claim nobody checks — and it was
sitting in our own repo while we fixed five of them in the code.

**WHAT BELONGS HERE CHANGED ON 2026-08-08 (D-82): a defect found is fixed now.** This
file is no longer where a bug waits. What is left in it is one of four things, and each
says which:

1. **Vany's to decide** — anything changing which model is called or what it costs.
2. **Waiting on evidence** — measure-first items whose measurement has not been taken,
   or that need a day of real use.
3. **Needs somebody who is not me** — Phase 3's fresh-session criterion.
4. **Argued deferral** — a defect deliberately not fixed, with the argument for why
   waiting is cheaper than fixing written down beside it.

Anything else that turns up gets fixed in the change that finds it. The reason is in
SPEC D-82 and it is not tidiness: a recorded defect goes stale in the direction that
hurts. The replica monitor was recorded, carefully and correctly, thirty minutes before
it pointed an operator away from a database that had become unreadable.

**And the batch is reviewed WHOLE.** A round costs a t0 sweep, an ingest and one model
call whether it reads one commit or twenty, so fourteen commits in three reviews is four
to five times cheaper than fourteen reviews — and stronger, because findings interact:
t3's best pass this week found a chain of four defects each invisible without the others.

A phase is ticked when its code is **running and observed**, never when it is
merely written. Where a phase shipped with a part that has never been exercised,
that part is pulled out into its own open item rather than hidden inside a tick.

---
## Now — nothing here is about writing more features

**Pruned 2026-09-16.** This file had reached 2423 lines, 179 items, **114 of them already
struck** — more than half of "Now" was August history that the header above says should
have moved to `MEMO.md` and been removed. It did move; only the removal never happened, and
that is why taking it out here costs nothing — `MEMO.md` and the git log carry every one of
them, while a checklist you have to scroll past to reach live work is a checklist nobody
reads. What is below is only what is OPEN, grouped
by whose move it is. Three defects in the file itself were fixed in the same pass: the two
entries about the OOM kills that reached opposite conclusions are now one; the 2026-09-03
entry claiming D-141 and D-142 had never reached a container was struck (both are live —
this session's own `review_inbox` returned `waiting_note` and `quiet_since`, and the
connect handshake carried `SERVER_INSTRUCTIONS`); and its sibling, "not measurable until it
is deployed", is now measurable and says so.

---

### 2026-09-17 — the production findings are fixed, and there were THIRTEEN of them

`rev_kq7psOFQqIKn1di0XjMEal7e` is `cancelled` — deliberately, not abandoned: it was pinned
to a tree from 2026-09-15 and the files have moved since, so answering it in place would
have meant composing fixes against code that no longer exists. The fixes are on
`origin/main` — **pushed 2026-09-19 as `ab20c09`**, after `rev_C5CMA4EtqehIp7JTIRCjz1dO`
reached `passed_thin_ladder`.

**Until that push this entry said "on main" meaning the LOCAL branch, and `eb9827b3`
caught it.** For two days it claimed a tree `origin/main` did not carry, so a rollback
to `origin/main` after an incident would have silently restored the five defects listed
below — the `review_inbox` ~1ms hot loop among them — while this file said they were
fixed. Kept as the record of the shape, because it is the third of its kind this month:
unpushed is a state a checklist has to name, since the window in which the entry is
interesting is exactly the window in which it is true.

**The inbox showed five; cancelling returned thirteen.** The other eight had been delivered
to the session that started it and never reached this file — which is worth remembering as a
property of the protocol rather than a mistake: `review_poll` consumes what it returns, so a
session that collects and then ends takes the only copy with it. `lore://review/{id}` and
`review_cancel` are the two ways back to the full list, and neither is reached by a reader
of this file.

All thirteen are fixed, on the same unpushed batch. Five by this session (the channel's
silent death, not-yours rows, the interval hot loop, `spec/mcp-api.md` §2.4, the CLI's
conflated skip list — commit `2ad2fe9`), and eight by the rounds that followed on that
branch, each verified against the working tree one at a time rather than assumed:

* `21aea4dd` (HIGH) — the migration's docstring promised `assertNotDowngrade` would refuse a
  rollback while `SCHEMA_VERSION` still read 22, so the guard could not fire and an older
  build's sweep would have expired 201 real verdicts. It is 23 now, and the docstring says
  the sentence stood there while the version did not.
* `2df1e05f`, `b632d279` — the CLI no longer tells a thin ladder it failed, and no longer
  reuses a concluded `passed_thin_ladder` for another round.
* `8b920173`, `abfe5238` — the `spec/agent-docs.md` §3 draft and the `deploy/` comments.
* `9eb9f13c`, `9ba556af`, `b919fcc0` — three successive rounds on one paragraph of
  `docs.ts`, ending with the tier/engine/vendor-count split that is in the live text now.

### 2026-09-19 — the batch is reviewed, attested and pushed, and t2 was dead for the first half of it

Nine commits (`2ad2fe9..ab20c09`) reached `passed_thin_ladder` and are on `origin/main`,
signed at tree `739e11d7`: 5 findings, 5 fixed, 0 justified. The deployment is at that
commit and `/status` is `ok` with no problems.

**THIN, and worth reading rather than rounding up.** t1 never left a trusted read of this
tree, and t3 was answered by a stand-in from a vendor already in the ladder — so two
vendors (z-ai, moonshotai) read nine commits across three tiers, not three. `eslint` did
not run (no config here) and semgrep's `react-insecure-request` stayed suppressed at
`src/service/refusing.test.ts` by development rule `de7fb2b3`.

**The first attempt of this batch came back `failed`, which is why D-154 exists.** t2's
provider had been renamed upstream; `make doctor` knew and nobody asked it. The open
question that came out of that — should `review_start` preflight the ladder — is in
"Vany's to decide" above.

- [ ] **Housekeeping:** the scratch refs `review/37560c1c` and `review-base/37560c1c`
      were pushed and deleted in the same command, as D-77 requires. Nothing sweeps
      `refs/heads/review/*`, so the ones named in the 2026-09-17 entry below are still
      worth a look.

### 2026-09-17 — the batch is reviewed, attested and pushed

Thirteen commits (`9263e28..8c33458`) reached `passed_thin_ladder` and are on `origin/main`,
signed at tree `47ae1a35`: 3 tiers, 9 findings, 6 fixed, 1 justified. D-150 was reviewed as
part of it. **Every tier that ran was z-ai** — kimi and openai both refused — so the ladder
was full depth and correlated opinions, which is the ending Phase 6 step 1 exists to stop
buying.

- [ ] **Housekeeping:** `lore-channel` and `rename-cleared` are fully merged into `main` and
      can be deleted. Eleven `worktree-wf_*` branches are left from workflow runs in an
      earlier session — provenance unknown, so nobody should delete them blind. The scratch
      refs `review/9c1ed291…` and `review-base/9c1ed291…` stay on origin while that review
      is open.

### 2026-09-16 — the t0 sandbox is OOM-killed on 22% of rigid rounds

- [ ] **THE KILLS ARE TWO PROBLEMS AND ONLY ONE OF THEM IS MEMORY.** `tsc` and `eslint`
      are OOM-killed (exit 137) on rigid-monorepo: **187 of 859 t0 runs since 2026-09-07,
      22%**, 74 of them on 09-15 alone. All rigid; lore's own 29 runs, none. Reported twice
      on 2026-09-16 by the `Auth + ledger reconciliation` session, the second time
      (`rev_YJ_Ypte2HB8OosBQd8-JQlpg`) with host load at 5.77.

      **lore reports it honestly, which is the part worth keeping:** the round closes
      `interrupted`, never `clean`, and `checks_skipped` says *"eslint: `pnpm run lint` did
      not complete (killed, exit 137) — almost always a memory limit … Nothing it would have
      found is known either way."* The defect is lost COVERAGE, not a false claim.

      **This entry said "no code change fixes it" and that was wrong** — corrected the same
      day by measuring rather than reasoning from the cap. Split by how many sandboxes were
      running when the kill happened: **25% of the kills had NO other sandbox on the box**,
      so a quarter of them are a single container exceeding 6 GiB on its own, which more
      host memory cannot buy back. `ps` inside a live sandbox found why: ten concurrent
      `eslint` processes — turbo's default `--concurrency 10` — in a container with
      `--cpus 2`, RSS 320–580 MB each, `memory.peak` 5.48 GiB of 6 with 8 of 33 packages
      started. The fan-out buys nothing (two cores either way) and costs everything.

      The remaining three quarters happen with at least one other sandbox running, and the
      fleet has no bound at all: peak **19 concurrent sandboxes**, each entitled to 6 GiB, on
      a 7.75 GiB Docker VM. At 11 or more concurrent the interrupted rate is ~75%. Whether
      each of those kills was contention or the same fan-out is not separated by the data —
      what IS certain is that the entitlements have summed to more than the machine for
      weeks. `deploy/docker-compose.yml` still reassures the reader with arithmetic
      about `LORE_CONCURRENCY` — the knob the lines directly below it say D-101 removed — so
      the bound that comment describes has not existed for weeks.

      D-151's memory door does not touch either half: it refuses a review that walks up to a
      machine ALREADY short, which is a third thing.

      **THE FIRST HALF IS FIXED — D-152, 2026-09-17.** `TURBO_CONCURRENCY` and a
      `NODE_OPTIONS` heap cap, both derived from the container's own `--cpus` and
      `--memory`, plus `--oom-score-adj 1000` so the kernel takes a sandbox rather than lore
      or opencode. One more measurement went in with it: node's default `heap_size_limit`
      inside the sandbox was **2240 MB, sized from the host's 7.75 GiB**, not from the
      cgroup's 6 — ten of those is 22 GB of entitlement in a six-gigabyte box. **Shipped,
      not yet observed:** the next rigid round after a deploy is the first real test, and
      the number to watch is the `interrupted` share in `tier_run`.

- [ ] **Vany's: the 12 GiB, the per-sandbox ceiling, and whether the door should also count
      lore's own sandboxes.** More memory alone moves the cliff rather than removing it —
      two sandboxes at the 6 GiB ceiling still overrun 12 GiB. After the fan-out cap the
      ceiling should come DOWN (~3 GiB), because sum-of-ceilings under VM-total is what
      makes every kill a cgroup kill (attributed, already reported honestly) instead of a VM
      kill that picks a victim. Peak measured: 19 concurrent sandboxes on a 7.75 GiB VM.
      Throughput and deployment, so not mine.

- [ ] **`review_submit` has no memory door and should not get this one.** 446 of 675
      t0-running rounds since 09-07 arrive through a submit; refusing one strands fixes the
      client has already made — the abandonment the inbox surface exists to fight. It needs
      a mechanism that KEEPS the work (`held_diff` is close to the right shape), which is a
      design question rather than a missing line.

### 2026-09-16 — Phase 6, token economy (PLAN.md has the why, the gates and the order)

Order **0 → 1+4 → 2 → 5 → 3**. Each step moves a number from step 0's report, or it
does not ship.

- [ ] **0a** record each reviewer tool call's argument (command/path), not only its count

- [ ] **0b** check the three opencode plugins for per-step injection; remove any that do

- [ ] **0c** find how each plan meters: tokens, requests or steps

- [ ] **0d** `make tokens` + board panel: tokens per concluded verdict, first-read share,
      steps per first read, correlated share, no-verdict share — the baseline

- [ ] **1** skip a deep tier whose only route is a vendor that already read (`skip_correlated`)

- [ ] **4a** deny webfetch/web search in reviews · **4b** weekly refusal backs off for hours ·
      **4c** stacked branch reviewed into its parent (TOOL_DOCS.start)

- [ ] **2a** per-repository concurrency cap, queue position told to the client

- [ ] **2b** no deep stage on a branch already merged or gone

- [ ] **2c** attempts: reclaim does not spend one; opencode-down bounded by 30 min continuous

- [ ] **5** per-call "waiting on" persisted and said; opencode restart detection, panel, page

- [ ] **3a** deterministic diff context (library search first) · **3b** repository brief per
      trunk commit · **3c** prompts.ts · **3d** replay gate, then the step budget

**Three of those steps are already designed, and the design is worth keeping beside the
line it belongs to:**

- [ ] **The attempts fix (D-149's sibling).** Design is settled: a lore-caused requeue — a
      deploy or worker restart — does not spend one of a job's three attempts, and an
      unreachable opencode is bounded by 30 minutes of CONTINUOUS unreachability rather than
      a count; no message says "requeued" once it will not be. It failed two rigid reviews on
      2026-09-15 and is Phase 6 step 2c.

- [ ] **A provider-stated park outlives a plan change** (D-150 `[OPEN]`). lore re-tests only
      the parks it guessed, so Vany's z.ai upgrade was invisible and plan 2 stayed parked
      until cleared by hand. Phase 6 step 4b.

- [ ] **Why opencode exits cleanly and is restarted** — seven times in two hours on
      2026-09-15, `exit 0`, nothing logged before any of them, no event history left. lore is
      robust to it now; the cause is upstream and undiagnosed. Phase 6 step 5 would at least
      make it visible.

### Vany's to decide

- [ ] **Should `review_start` preflight the configured ladder?** (D-154, 2026-09-19.)
      `make doctor` resolves every configured model against opencode and says, in these
      words, *"NOT ready … A review would start, spend on the diff and T0, and then not
      run."* On 2026-09-19 it was right: models.dev had renamed t2's provider, doctor said
      so, nobody typed it, and a round spent a t0 sweep, a knowledge ingest and t1 before
      dying on t2 with a 500.

      **The check exists, is cheap and is read only by a person.** Calling it at
      `review_start` would refuse in a second instead of failing in ten minutes. What it
      costs is the thing that makes it a decision rather than a chore: lore would then
      have a way to refuse a review over a check of ITS OWN, and a false negative there —
      opencode slow to answer `/config/providers`, a catalog fetch failing — turns a
      working ladder into a closed door. A gate that refuses to run is the failure this
      project is named after, arriving from the other side.

      Shapes worth weighing, cheapest first: cache doctor's verdict and refuse only on a
      model that resolved false RECENTLY; warn in `review_start`'s reply without refusing;
      or fail the round early with doctor's own sentence rather than a provider 500. Mine
      to implement, yours to pick.

- [ ] **The silence bound on a single model call.** A call can sit 45 min
      (`DEFAULT_TIMEOUT_MS`); Kimi once took 21.5 min to refuse. Bounding silence falls back
      sooner, which changes which model is called.

- [ ] **Metered OpenRouter.** $190.35 left (granted $6177, used $5986.65). `LORE_ALLOW_METERED`
      unset blocks it; t2's and t3's first fallbacks are OpenRouter routes.

- [ ] **`lore/data` holds the service's database, its git mirrors and every pinned review
      worktree, gitignored, INSIDE the repository working tree.** Git protects the source
      from lore's data; nothing protects lore's data from the source's tools.

      Measured the hard way on 2026-09-10, by me: a `pathlib.rglob("*.ts")` in a rename
      script descended into `lore/data/repos/<repo>/wt/<review>/` and rewrote 40 files in
      the pinned worktree of a review that was running at that moment. Restored from git
      after about three minutes; disclosed in that review's ticket, because I cannot prove
      no tier read a mutated file in the window.

      **It was not a careless glob — it is the default behaviour of every recursive tool.**
      `find -exec`, a codemod, `eslint --fix`, `prettier --write`, a `grep -rl | xargs sed
      -i`: all of them walk in, and none of them can be told not to by `.gitignore`. The
      one thing that would have saved me is the data not being there.

      **The fix is a deployment change and therefore yours.** `LORE_DATA_DIR` already
      points wherever compose says, and D-60 requires only that the path means the same
      thing on both sides of the bind — so moving it to `~/lore-data` (outside `~/l/rev`)
      costs a compose edit and a `make mirror`. What it buys is that no tool aimed at the
      source can reach the service's state, which is a property, not a habit.

      **Why I did not just do it:** it changes where a running deployment keeps its
      database, and a mistake means restoring from litestream. Not mine to spend.

- [ ] **A REVIEW REACHED `state: passed`, `clean: true`, AND ITS SIGNED LINE SAYS
      `PARTIAL`.** Measured on `rev_ZJHfthwOzYjTw7hqlym0jwmY` (D-144's own batch, the first
      full `passed` in weeks — everything else has been `passed_thin_ladder`, which is why this
      surfaced now rather than earlier).

      Three surfaces, three answers:

      * `review_poll` → `state: "passed"`, `clean: true` — the strongest verdict lore has;
      * `review_attest` → *"1 tier(s) never left a trusted read of this tree, so this is
        PARTIAL, 7 findings, 6 fixed, 0 justified"*;
      * `open_count: 1`, against a resource showing 7 findings and 6 settlements.

      **Neither surface is malfunctioning; they encode different rules.** The attestation
      is right and says so deliberately — `attest.ts` carries `lore-ok[20310406]` naming
      exactly this case, *"a tier that read a genuinely earlier tree and was never re-run
      (D-6)"*. t1 ran rounds 1 and 2 and correctly never re-read after the ladder escalated
      (D-6, "a closed tier stays closed"). So the signed tree genuinely was not read by
      every tier. The ladder's own pass test asks a different question: no tier SKIPPED
      above the highest that ran, and no vendor collapse (`ladder.ts`) — t1 is not skipped,
      it ran, so the ladder says `passed`.

      **README sides with the attestation**: *"`passed` still requires that every tier
      actually read the tree it is signing."* By that sentence the state is wrong. By D-6
      the attestation is unavoidable for any review that escalates — which would make
      `passed` unreachable for every review that ever raised a finding, and reachable only
      for one that was clean at the top tier on round 1.

      **That is the decision, and it is not mine:** either `passed` means what README says
      and the ladder must stop issuing it when a lower tier's last read is an earlier tree
      (making `passed_thin_ladder` the normal ending for any review with rounds), or D-6's
      closed-tier rule is a deliberate exception and README and the attestation should say
      so instead. Both are defensible; what cannot stand is the client being told `clean:
      true` while the signed record says PARTIAL, because the client merges on the first
      and the operator reads the second.

      **D-147 (2026-09-10) did not settle this and may sharpen it.** The rename gave the
      wire an `evidence: "full" | "thin"` field computed from the LADDER's rule, so a
      review can now report `cleared: true, evidence: "full"` beside a signed line saying
      PARTIAL — the same disagreement, now with a field literally named "evidence" on one
      side of it. Deriving `evidence` from the attestation's rule instead would make them
      agree and would also make nearly every multi-round review thin. That is still the
      choice below, unchanged; D-147 deliberately moved no verdict while renaming one.

      **Separately, and smaller:** `16211efb` is open with no settlement and no
      `will_not_settle`, on a review that passed. The code it asked for IS fixed (the
      publish guard in `tell`, plus a test that fires the interleaving) — t3 simply never
      recorded a verdict for it, while recording one for the two findings raised beside it
      in the same round. So a review can reach a terminal verdict with a finding it raised
      neither settled nor refused, and `review_poll`'s own contract says that pairing is a
      bug in lore rather than a fact about the branch.

      **A SECOND INSTANCE WAS CLAIMED ON 2026-09-17 AND THE CLAIM WAS WRONG.**
      `rev_yFUVBiGGTWvu5LAD5oWb-QWU` ended `passed_thin_ladder` with `open_count: 2`, and
      that was recorded here and in `MEMO.md` as lore dropping two verdicts. It was not.
      Checked afterwards by running `hunkStillPresent` against the merged tree, which is the
      thing that should have been done before writing it down: both findings' recorded
      25-line windows are **still present, intact**, so `codeMoved` is false and `settleFixed`
      correctly declined to settle either.

      * `5736234a` named `src/ops/heartbeat.test.ts:151`; the fix went into `cfg()` seventy
        lines above. Textbook `BUGS.md` §5, *"fixed one layer in"* — the protocol's two
        remedies are a `lore-ok` at the named line or `fixed_elsewhere` on the submit, and
        the answer used neither.
      * `55aeca68` named `README.md:297`, but the 25 lines captured around 297 are the
        "rules it is built on" section, not the mermaid node the finding quotes. The model
        named a line that was not the text it was talking about, so the scope watched a
        region no fix would ever move. **That one is worth its own thought**: settlement is
        anchored to a line a MODEL chose, and nothing checks that the line contains what the
        claim describes.

      So `16211efb` below is still the only observed instance, still unexplained, and the
      entry stays open on one data point rather than two. **The false second instance is
      kept here deliberately** — it was written from arithmetic ("9 findings, 6 fixed, 1
      justified, so two were dropped") without running the predicate, which is `BUGS.md` §9
      committed by the person who reads that file, one day after re-reading it.

- [ ] **`review_submit` needs a tree both sides can name.** *(Vany's to weigh — it is a
      change to the MCP contract three clients depend on.)*

      A review's tree is the pinned one plus every patch already applied, and it exists
      only inside lore. So a session that did not make the earlier submit cannot check it
      out, cannot diff against it, and cannot compute a matching tree hash from its own
      branch. **A review that has taken one submit is unanswerable by every later
      session**, and the only exit is `restart: true`, which re-pays the cheap tiers and
      discards every justification the review has ratified.

      Measured on this deployment, and it is not an edge case: **16 reviews passed out of
      128**, against 58 `failed`, 28 `cancelled` and 18 `expired` — with one branch
      reviewed **thirteen** times and four others four or more. The docs cite "six reviews
      of one branch in two hours" as a past incident; it is the standing pattern.

      A real client hit it today, did exactly what the error told it to, and restarted:
      *"the review is pinned to its own tree plus a previous session's submissions, which
      have drifted from the pushed branch, so my diff did not apply. Taking the sanctioned
      route instead: land them on the branch and restart."*

      **The proposal:** `review_submit` accepts a pushed `commit` as an alternative to a
      `diff`. lore already mirrors the remote, so it restores the review's worktree to
      that tree and carries on with the SAME review — same findings, same ratified
      justifications, same ladder position. The tree hash check survives intact, because
      both sides can name that tree. It also fixes the rebase case, where a diff is
      hopeless by construction, and it SAVES quota: every restart it prevents is a t0
      sweep plus a full climb from t1.

      Additive and breaks nothing. Waiting only on the decision.

      The symptom is fixed: the failure message no longer tells a resumed session to
      "resend the whole diff", which for it was impossible, and tells it to report rather
      than retry — the retry loop is what turns one review into thirteen.

### Needs a person who is not me

- [ ] **CHECK WHETHER KIMI AND OPENAI ARE ACTUALLY DEAD, NOT JUST RATE-LIMITED.** Both
      `kimi-for-coding/k3` and `openai/gpt-5.6-terra` have refused every D-125 probe —
      **27 consecutive failures each**, one every 15 minutes for roughly a day, backoff
      now maxed at 24h. Both refusals classify as quota ("out of quota" / usage-limit
      wording), never auth, so D-125 keeps re-testing correctly and lore has no way to
      tell "still rate-limited" from "the plan actually lapsed" from in here — both look
      identical from the refusal text alone. 27 straight misses is long enough that the
      two stop being equally likely.

      **Needs a person on the provider's own dashboard** — lore holds no billing access
      and this is not a code question. If either has genuinely lapsed, the probe will
      quietly retry it forever at the 24h ceiling, burning nothing (good) but also never
      telling anyone the *right* fix is a renewed subscription rather than patience.

      Every deep review meanwhile reads `passed_thin_ladder`: t2 and t3 both fall through to
      `zai-coding-plan2` — the only non-metered entry in either fallback list, per D-117 — so
      all three tiers land on one vendor. Not a bug: the honest consequence of the outage
      above, once vendor independence is properly enforced (D-49, widened 2026-08-17).

      **The model on that fallback is `glm-5.3` since D-150 (2026-09-16), not `glm-5.2`**,
      and the reasoning this entry used to carry — "plan2 simply does not carry 5.3" — was
      true until Vany upgraded the second subscription and the 5.3 entries were added to the
      host's `opencode.json`. What has NOT changed is the shape of the problem: one vendor
      reading for all three tiers is a correlated read, which is exactly what Phase 6 step 1
      exists to stop asking for.

- [ ] **Three people hold tokens on `rigid-monorepo` and the perimeter changed.**
      Provisioned 2026-08-07 for `koray` and `max`; `LORE_BIND` moved from `127.0.0.1`
      to `0.0.0.0` on Vany's call, so the service answers on every interface this laptop
      joins and **the tokens are the perimeter**. Two consequences that were theoretical
      yesterday: D-78 below is now live rather than hypothetical, and nothing yet has
      ever driven this service except sessions I primed — see Phase 3's done-criterion.

- [ ] **Prove Phase 3's actual done-criterion.** A fresh Claude Code session, given
      no instructions beyond the MCP tool descriptions, drives a review to `passed`.
      Every review so far has been driven by hand with shell scripts, so what is
      proven is the service, not the documentation — and `spec/agent-docs.md` §1 says
      the docs *are* the interface.

### Mine, ready — no decision needed, only a turn

- [ ] **eslint has NEVER run on lore's own repository, and the blocker is upstream.**
      Every review of this repo reports `eslint: no `lint` script and no eslint config` in
      `checks_skipped` — one of T0's four engines dark on the repo whose whole purpose is
      catching what people miss. Surfaced 2026-08-17; **tried and measured 2026-09-17**.

      **`typescript-eslint` does not support this repository's TypeScript.** Latest stable
      is 8.70.0, whose peer range is `typescript >=4.8.4 <6.1.0`; lore is on `typescript
      7.0.2`. Installed anyway with `--legacy-peer-deps` to find out whether the range was
      merely conservative, and it is not — the plugin refuses at load, in its own words:

      ```
      Error: typescript-eslint does not support TS 7.0.
      ```

      So this is not "we have not got round to it": there is no configuration of the
      current release that can parse this codebase. Only the `8.70.1-alpha.*` line is newer
      and it is the same major.

      **The unblock is a one-command check, not a design decision:** when
      `npm view typescript-eslint peerDependencies` names a range including 7.x, install it,
      add a flat config and a `lint` script, and run it over the tree ONCE before committing
      — a config that lights up eighty thousand lines would flood T0 with findings on the
      next review, which is the reason to look before shipping it rather than after.

      Downgrading TypeScript to 6.x to buy eslint is the other direction and is not obviously
      wrong, but it is Vany's: it changes what the compiler checks on every file in the repo
      to gain a linter on the same files.

- [ ] **Eighteen orphaned docblocks left, in the three files that carry more than one.**
      A docblock that ends where another begins describes the SECOND one's subject, and
      whatever it was written about has no comment at all — pinned mechanically in
      `one-definition.test.ts`, whose baseline may shrink and never grow.

      **Six fixed 2026-09-17, one per file, and they were three different defects** — which
      is the argument for doing the rest by hand rather than by script:

      * `cooloff.ts`, `git/diff.ts`, `git/repo.ts`, `mcp/server.ts` — a real docblock
        STRANDED from its member by a later insertion (`retryAt`, `renderDiff`,
        `applyPatch`, `newReviewId`). Moved back to what it describes.
      * `core/errors.ts` — a TOMBSTONE for a deleted function (`looksUnreachable IS GONE`).
        Nothing can ever sit under it, so it is prose and is now written as `//` comments.
      * `t0/sandbox.ts` — TWO docblocks for one constant, the stranded one being an older
        wording of the same thing. The detail only it carried is folded into the live block.

      What is left is `reviewer/opencode.ts` (3), `reviewer/review.ts` (5) and
      `store/store.ts` (10). Left deliberately: they are the three largest files in the
      repository, each orphan needs its own reading to tell which of those three shapes it
      is, and a batch that size is a worse review than it is a fix.

- [ ] **Should a reviewing model be able to originate an escalation?** *(Vany's: it costs
      a change to the contract every tier's output is parsed against.)*

      **The DRIFT half is fixed, 2026-09-17.** This entry began as "the spec says the
      reviewing agent resolves a knowledge conflict, and it cannot" — a false claim about
      agency, which is this repository's most common defect. `spec/knowledge.md` §7.2 had
      already been corrected in its own text; §7.1 still said *"the reviewing agent must
      actually resolve it"* and now says who actually does: `knowledge_resolve` over MCP
      under a token, which records who, or the board button, which records that a person
      did and deliberately not which one.

      **What is left is a product decision, not a defect.** The model is the party best
      placed to judge a contradiction and the only one shown the question — it is told to
      resolve it or say it cannot, and its answer is parsed by nothing, has no field in the
      findings contract to arrive in, and reviewers hold no lore MCP to act through. Wiring
      it in makes D-39 true and lets an escalation be raised that the deterministic
      heuristic cannot see; it also changes the shape every tier's reply is validated
      against, and a tier that starts emitting a field the parser rejects fails the review
      rather than degrading. That is why it is yours.

      The alternative is to leave escalation deterministic and say so, which is now what the
      documents do — so nothing is false today whichever way this goes.

### Argued deferrals — deliberately not fixed, each with its argument

- [ ] **THE DRAFT UNDER §3 `review_poll` HAS NOT MOVED WITH `TOOL_DOCS.poll` FOR SEVERAL
      FEATURES, not just the one this round added.** Found while adding a mechanical pin
      for fingerprint `3f3d375e` (a passed review must not read as the end of the
      client's whole task) — the fix that round needed reached three ledgers
      (`docs.ts`'s failure-mode list, `spec/agent-docs.md` §2, the behaviour-pin table in
      `docs.test.ts`) plus `TOOL_DOCS.poll` and this same file's §3 draft, and only the
      last one turned out to hide a much bigger, pre-existing gap once I read it closely
      against the live text.

      Confirmed by direct comparison, not guessed: the draft's state list (`queued`,
      `running`, `findings_ready`, `awaiting_diff`, `fast_clean`, `needs_human`, `passed`,
      `passed_thin_ladder`, `failed`, `expired`) is missing `findings_stale` and `cancelled`,
      both live in `REVIEW_STATES` (`src/core/review-state.ts`). It still says "wait and
      poll again — start at 10s, back off to 60s" — the EXACT wording
      `docs.test.ts`'s own "THE MOST EXPENSIVE INSTRUCTION THIS SERVICE EVER SHIPPED"
      test exists to keep out of every live document, replaced everywhere else by
      `check_back_note`'s shrinking-interval mechanism. It has no mention of
      `check_back_after_ms`, the retry-at-most-once-on-`failed` rule (arguably the
      single most consequential sentence in the live doc — the one tied to a client
      that retried an unwinnable review five times over two days), `human_decision`, or
      the "seen N×" two-different-problems guidance, and its `checks_skipped` paragraph
      names only one of the three cases the live text distinguishes.

      **What is fixed here, same round:** the one sentence this round's fix actually
      added to `TOOL_DOCS.poll` ("closes THIS review, not your task") is now in the
      draft too, in the right place.

      **What is deliberately NOT fixed here:** the rest of the above. `review_start`'s
      own draft two sections up got a dedicated, verified pass under D-130 (it still
      carries the `lore-ok[45d7c573]` marking exactly that); `review_poll`'s draft
      apparently never got the equivalent pass and has been quietly accumulating drift
      since. A full resync is a careful, from-scratch transcription of a ~150-line live
      tool description into the same condensed prose style the rest of §3 already uses —
      real work, not a two-line fix, and not what the round that found it was for.
      Argued deferral in the same shape as the two entries below: real, named, not
      silently absorbed into an unrelated change.

- [ ] **A COMPLETED SYNC PASS IS NOT A PER-REPO GUARANTEE, and nothing threads the gap
      through.** `mirror-refresh.sh`'s `serve_requests` calls `one_pass` (which fetches
      every registered repo and returns a count of how many failed) and deletes the
      request once `one_pass` RETURNS — whatever it returned. A network outage, an
      expired credential, or one bad repo among many can fail the fetch for the exact
      repository a client is waiting on, get logged to `mirror.log`, and still be
      reported to lore as `fetched: true`. Found by lore's own t2, reviewing D-127's
      batch, against `review_submit`'s commit form — but it is the same claim
      `addWorktree` has made since D-100, on the same evidence.

      **What is already fixed, same commit:** both messages that read `fetched: true`
      (`src/git/repo.ts`'s branch-missing refusal, `src/mcp/server.ts`'s commit-missing
      refusal) no longer claim the branch/commit is "confirmed absent" or "not a timing
      problem" — they say a pass completed, name the likelier explanation (bad
      name/wrong repo), and point at `mirror.log` for the narrower case. That closes the
      actual harm: a caller no longer told something false with confidence.

      **What is deliberately NOT fixed here: a real three-state `RefreshOutcome`.**
      Proper per-repo failure tracking needs `one_pass` to record WHICH repos failed
      (not just how many) somewhere lore can read it — a per-repo status file, or a
      failed-ids list written beside the heartbeat — then `RefreshOutcome` gaining a
      third state and both call sites gaining a third branch. That is a protocol change
      to `mirror-refresh.sh` (shell, with the exact per-repo/per-pass race conditions
      D-100's own comments show this file has been burned by before), not a two-line
      fix, and it deserves the same deliberateness those comments were bought with —
      not a same-day addition to an unrelated speed pass. Argued deferral: the softened
      messages remove the false certainty today; the real fix is worth its own change.

- [ ] **I WRITE THE SPEC CLAIM WIDER THAN THE CODE, AND THE REVIEWER KEEPS CATCHING IT.**
      Five findings in one round carried `seen 7× before in this repo — a pattern rather
      than an incident. Worth asking why it recurs, not only fixing it here.` They asked,
      so here is the answer rather than a sixth fix.

      Every one was the same shape: **a rule stated in one place and applied in another,
      where the statement is the more ambitious of the two.** Concretely, from one night:

      * `spec/operations.md` said the paid-route ticket fires on "the first CALL each UTC
        day" when it fires on the first review ROUND — the screen, `propose` and bootstrap
        reach paid routes and are not wired to it.
      * D-49's SPEC entry said the spread is stored "because the attestation and the
        operator board are written from the state", while the board did not read it.
      * `markAnsweredBy`'s own contract said "only ever called on the fallback path" in the
        same commit that made it called for every member.
      * D-117's entry said the operator-alert shape had shipped when only its log half had.

      **Why it recurs: I write the prose while holding the INTENT, and the code while
      holding the mechanism, and nothing forces the two into the same sentence.** The
      existing mechanical checks catch the code-to-code version of this (`one-definition`,
      `docs.test.ts`, the `/status` field test) — there is no check at all for a SPEC
      sentence describing behaviour that does not exist, because prose cannot be executed.

      **The candidate rule, not yet built:** every SPEC claim about behaviour names the
      symbol that implements it, and a test asserts the symbol exists and is reachable from
      where the claim says it fires. That is a real check for a third of these — the
      "fires on X" and "written from Y" kind — and no check at all for the rest.

      Deliberately left open rather than half-built. The honest interim is smaller and it
      is a habit, not a tool: **write the SPEC sentence last, from the code, not first from
      the intent.**

- [ ] **The board is forgotten every time the ladder learns a new fact** — third
      occurrence, and the reviewer asked for the cause rather than another manual fix.

      The shape: a field is added to `LadderState`, `/status` and the attestation learn to
      read it, and the operator board does not — because `parseLadder` extracted exactly
      one number and discarded the rest, so every new fact needed a fifth edit that nobody
      had a reason to think of. Fixed at the cause on 2026-08-17: it returns the parsed
      ladder, so a new field is AVAILABLE there the moment it exists.

      **That removes the step that was being missed, and does not remove the class.**
      Nothing forces anybody to RENDER an available field. A real answer would be a
      mechanical check — every `LadderState` field that reaches `/status` or `attest` must
      also reach the board payload — and it is not obvious how to write one that is not
      itself a list somebody has to remember to update. Left open deliberately, with the
      third occurrence recorded, because the next one should be a rule and not a fix.

- [ ] **The paid-route ticket is wired only into review rounds.** The hourly knowledge
      screen, the bootstrap survey and `propose` all reach a paid route through
      `concreteRoute`, and under `LORE_ALLOW_METERED=1` they can spend unattended with no
      ticket at all — the 2026-08-16 shape ($101.36, nobody looking) on the one path the
      alert was never wired into. `concreteRoute` is the chokepoint and would be the place,
      but it is a pure function with no store and no alerter, so wiring it means threading
      both through four callers or moving the notice to where usage is RECORDED, which is
      the one place every paid call already passes through. The second is probably right
      and is more than a night's change.

- [ ] **3. D-118's CONFIG WINDOW — the READ half is built (2026-08-17); the WRITE half and
      the token button are not.**

      Built: `/config.json` and `ops/config-view.ts` — every parameter with value, chosen
      vs defaulted, what it does and how to change it; the ladder resolved to real routes;
      one derived sentence saying whether an outage costs money or coverage.

      **Not built, and the reason is not time.** A live-editable knob means every reader
      going through one resolver, and `concreteRoute`, `noRouteBecause` and `renderStatus`
      read `process.env` directly. Wiring some of them would have the window assert a value
      the ladder does not use — the defect class five findings had just been raised about.
      Doing it properly is: one `settingOf(key)` resolver over a store-backed override with
      the env as default, every reader routed through it, and a test that no reader reads
      the variable directly. That is the real shape and it is a session of its own.

      Also not built: the token button (`make new` from the page, creating the repo row
      when the URL is new). It inherits one rule that cannot bend — the plaintext is shown
      once and never stored — and it is a credential-issuing endpoint on a page with no
      authentication of its own, which needs its own thinking rather than an hour at the
      end of a long night.

      **Still rendered nowhere.** `/config.json` answers, and the board page does not show
      it yet — the section is the small remaining piece of the read half. It was load-bearing before and
      it is more so now: with the ceiling gone, `LORE_ALLOW_METERED` is the ONLY money
      control in the service, and it lives in an env var in a `.env` nobody reads — which
      is the complaint that produced D-118 in the first place.

**Decided and NOT to be built, with the reasoning, so nobody re-opens them by accident:**

- **Metered stays OFF while Kimi's cycle is out.** I predicted weaker verdicts and was
  wrong: our own review of D-121 came back `passed`, not `passed_thin_ladder`, with
  `checks_skipped` reading *"t2 was answered by an equivalent stand-in"* — the free Z.ai
  plan covered the dead Kimi seat at $0, on seven calls that would have cost ~$34. Full
  coverage, no spend. Revisit only if a verdict actually returns partial.
- **The clear-before-release check stays.** It carries `raised 3× and justified away 2×`,
  and it was RIGHT the third time, on a real session leak. A resource-leak detector with a
  one-in-three hit rate is cheap to answer and expensive to miss.
- **No `oxlint` or `biome` swap; wait for typescript-eslint.** Adding one is not swapping a
  linter — T0 detects engines by config file, parses their output, extracts rule classes
  and wires them into D-83 appeals. That is a new engine surface for coverage that overlaps
  `tsc` and the model tiers. The gap is REPORTED rather than silent, which is the part that
  mattered.

- [ ] **A CONFIG window on the operator board** (D-118). Vany: *"make config window on web
      with this checkbox, also put all parameters there. And issue new key for button, also
      it may create new repo if needed."*

      Every knob in one place, read and write: tier ladder, D-117's metered toggle
      (`LORE_ALLOW_METERED`, live as an env var since 2026-08-17), sweep intervals,
      admission limit. Today they are split across a `.env`
      nobody reads, a JSON file on the host, and `make` targets only I run — an operator
      cannot see the shape of their own deployment.

      Plus a button that issues a token and CREATES THE REPO when the URL is one lore does
      not have, replacing `make new NAME=… GIT=…`. **It inherits the one rule that cannot
      bend: the plaintext is shown once and never stored** — only its hash — so a database
      backup is not a set of live credentials.

- [ ] **A channel for "this arrived malformed and we kept it anyway."** The missing piece
      behind three refusals that can still cost a finding (D-116's `[OPEN]`): a
      non-positive `line`, a malformed `cwe`, an unknown key under `.strict()`. Each is a
      drift detector that fails by DISCARDING a report — the trade D-115 and D-116 have
      now reversed twice. `discarded` already reaches the client through `checks_skipped`
      ("t1 produced a finding this review does NOT contain"); this is its mirror, and with
      it all three can drop the offending field and keep the record.

- [ ] **CHECKPOINT VERDICTS — the piece that makes incremental safe** (D-112, `[OPEN]`).
      A review that accretes for ever produces no signed statement about anything: D-40
      says a signature covers a TREE, so a moving tree has no verdict. The shape: the
      review stays open and warm, and on request settles what it has read and signs THAT
      — "as of tree X, these tiers read it and agreed" — then carries on from the same
      sessions. Rejected alternative: close and reopen per checkpoint, which throws away
      the warm session that is the whole point.

      **Not built deliberately.** It touches `review_attest`, which today requires a
      terminal state, and INV-1's rule about what a verdict may assert. Getting that
      wrong produces a signature over a tree nobody read, which is worse than having no
      checkpoint at all.

- [ ] **Per-principal admission share — the one real gap, deliberately unbuilt.** The 128
      is global, so one principal can take every slot and lock out colleagues. It cannot
      fire at this workgroup's volume (busiest day: about a dozen open), and the refusal
      already names `review_cancel` as the remedy. **The trigger to build it is the first
      refusal caused by somebody else's reviews** — until then it is a mechanism for a
      problem nobody has.

- [ ] **Adopt the MCP Tasks extension when the SDK ships it** (D-110, `[OPEN]`, gated —
      NOT closed, and NOT a design question any more).

      The protocol answer is settled and favourable: 2026-07-28 moved tasks into the
      official `io.modelcontextprotocol/tasks` extension (SEP-2663) with `tasks/get`,
      **`tasks/update` for client-to-server input**, `tasks/cancel`, a `CreateTaskResult`
      handle carrying `ttlMs`/`pollIntervalMs`, an `input_required` state with
      `inputRequests`, and optional `notifications/tasks` pushes over
      `subscriptions/listen`. That is lore's own state machine with standard names —
      `review_submit` is `tasks/update`, `needs_human` is `input_required`. D-110 has the
      full mapping.

      **The blocker is the LIBRARY.** `@modelcontextprotocol/server@2.0.0` carries only
      the superseded 2025 vocabulary (deprecated, no runtime, refused by the typed request
      path); its 2026 registry has no `tasks/*` and no `notifications/tasks`. No npm
      package implements the extension. Do not hand-roll the wire against an SDK that
      refuses those methods.

      **The check is on the SDK, not the announcement.** When `tasks/get`/`tasks/update`
      appear in its 2026 registry with a runtime, this becomes work: adopt, keep
      `review_poll` as the floor, and decide what happens to the delta semantics
      (`tasks/get` returns whole state — BUGS.md §3 says that is the better behaviour, so
      the delta model is the part that needs defending).

- [ ] **Never answer a protocol question from `node_modules` again** (2026-08-16). D-110
      was recorded three times and twice wrongly, each time by reading the installed SDK
      and reporting it as the specification — which cannot work, because a grep over
      `node_modules` returns a union of both wire eras and never says which question it
      answered. The spec says what is standard; the SDK says what our dependency supports
      today; the two diverge for months at a time. Both sources, named separately, or the
      note is not checked.

- [ ] **The `.mcp.json` test guards the shape, not the client.** It asserts
      `mcpServers` / `http` / `${LORE_TOKEN}`, which is what today's client reads —
      pinned by observation, not by anything that would notice the client changing.
      A dependency bump elsewhere cannot break it; a Claude Code release can, and
      silently. Cheap mitigation: re-run the header-echo probe when the client
      updates. Recorded so the guarantee is not overread.

- [ ] **Cool a provider off instead of rediscovering it every review** (D-84).
      Vany's to decide: it changes which model is called and what it burns.

      Z.ai went out of quota on 2026-08-09 and answered NOTHING — no 429, no error, both
      its models silent while kimi and openai replied in 3-4s to the same one-line prompt.
      So the classifier's quota signal is absent in exactly the case it was written for,
      and the condition arrives as a hang.

      What is built already keeps reviews finishing: the deadline bounds the stall, and
      D-48-widened promotes the tier's work upward at `passed_thin_ladder`.

      What is NOT built is the tracking, and it has a measurable price. It was **two dead
      tier attempts** per review; `skip_if_quota` (D-85) took that to one, and D-87 took
      the screen from one call per changed document to one for the pass. What is left is
      the first call of each, and it is still the full 45-minute deadline every time,
      re-learning a fact whose expiry date we already know.

      **We know the reset time and nothing in the running system holds it.** Z.ai named it
      — `2026-08-10 18:19:09` — in a refusal measured directly on 2026-08-08, and it lives
      only in SPEC prose. The cheapest honest shape needs no credentials and no inference:
      a per-tier `unavailable_until` the operator sets, skipping the tier without calling
      until it passes. The probe-and-infer design below is the expensive alternative.

      The shape of it: presume exhaustion from repeated timeouts while another vendor
      answers, cool the tier off SERVICE-WIDE for the window, re-probe once it could
      plausibly have refilled (Z.ai is a 5-hour rolling window, D-5/D-17), and label the
      inference as an inference wherever it is shown. Plus `/status` saying so — a
      provider at its limit is currently invisible from inside the service
      (`spec/operations.md` §2.4.2), which is the stale-mirror failure again.

- [ ] **The success and failure paths count tokens differently, and I caused it.**
      The failure path (D-85) sums every assistant message — the session. The success path
      reads the ONE message a prompt reply carries — a single turn. In a real 73-turn
      session the per-message cache reads were 100k-450k each and summed to 17.9M, so
      identical work now records a far larger row when it FAILS than when it succeeds, and
      any total across both is meaningless.

      Fixing the failure-path blindness introduced this. `usageFromMessages` already
      exists and the success path can use it; `GET /session/:id` returns the true totals
      in ~700 bytes. It changes what the spend ceiling sees — inert today, since every row
      carries cost 0 on these subscriptions — which is why it is a decision rather than a
      quiet edit.

- [ ] **The nineteen seam proposals are unappraised, not rejected.** `refactor.md` holds
      them. Each names one measurement; none has been run. The reason none was taken is
      that this codebase binds its incidents to positions in the code, and moving code
      is how it forgets its own bugs — so a seam change needs a reason beyond being
      tidier. If one of them ever has that reason, its `Settled by` line is already
      written.

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

- [ ] **Nothing watches the one disk fact that is ours.** The host-disk alerts are gone
      (2026-08-06): a full disk belongs to whoever owns the machine, exactly as a
      failing suite belongs to whoever owns the repository (D-71), and lore was
      alerting in red about 826 GB it neither caused nor could fix.
      What remains unwatched is real. The sandbox `node_modules` cache grows without
      bound and is **4.4 GB of lore's 4.7 GB total** — a curve with no ceiling and no
      monitor. The right measure is lore's own footprint against a budget it sets, not
      the host's percentage. Recorded rather than covered by the number that was
      measuring something else.

### Waiting on evidence

- [ ] **D-141 SHIPPED A TEXT AND CLAIMS NOTHING ABOUT ITS EFFECT.** `SERVER_INSTRUCTIONS`
      reaches every connecting session now, saying: ask the inbox first, a submit starts a
      round rather than answering one, cancel is the honest exit for findings you cannot
      answer. Whether that moves the abandonment rate is unproven and only measurable in
      use.

      **The baseline, taken the day it shipped, so nobody has to reconstruct it:** on
      `rigid-monorepo` since 2026-08-20, 108 reviews started, 71 reached a verdict, 15
      abandoned (`findings_stale` or `expired`), 11 cancelled, 9 failed. Across all repos:
      159 started, 140 reached findings, 6 never collected at all. A round takes a median
      19 minutes to produce collectable findings (p90 32).

      **What would count as working:** the abandoned share falling, or — just as good and
      more likely first — `cancelled` rising against `findings_stale`, because a session
      that stops deliberately instead of walking away is the honest ending the text
      actually asks for. Re-measure after a week of real use with the same queries.

      **IT IS DEPLOYED NOW, so the measurement is owed rather than blocked.** This entry
      read "NOT MEASURABLE UNTIL IT IS DEPLOYED" from 2026-09-02 until 2026-09-16, which was
      true when written and stopped being true at some deploy nobody came back to strike it
      after — the stale-in-the-direction-that-hurts shape D-82 names. Proven live rather
      than assumed: a session connecting on 2026-09-16 was handed `SERVER_INSTRUCTIONS` at
      the handshake and `review_inbox` answered with D-142's `waiting_note` and
      `quiet_since`. Two weeks of real use are in the store; the queries above are the ones
      to re-run.

- [ ] **Measure where the cheapness stops.** A kept session hits 97–99% prompt cache, so
      marginal turns are cheap — until it compacts at 2/3 of the window, and compaction
      discards REASONING to keep code. So "it already knows this codebase" holds for hours
      and then quietly stops. Nothing measures that boundary; the economic case for
      incremental review rests on it.

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

- [ ] **Measure the loop against the batch baseline:** emissions per run,
      time-to-first-finding (the new number that matters), and whether MAX_EMISSIONS=32
      is ever hit in anger. Baseline: `research/t2-token-cost.md`. Genuinely still
      open — checked 2026-08-24, no measurement of this shape exists in `MEMO.md`,
      `SPEC.md` or `research/`.

- [ ] **Measure whether D-79 actually improved reviews.** The change rests on a
      diagnosis, not on a before-and-after: `PLAN.md` Phase 1's measurement harness
      was never built, so a prompt rewrite is currently being judged by the person who
      wrote it — the exact shape D-75 exists to be suspicious of.
      Cheapest honest version: take the last N reviews' diffs, re-run them under the
      new prompts, and count what changed — how many findings, how many carry a real
      failure scenario, how many the author accepted as true. Halving the count while
      keeping the two that mattered is evidence. Anything else is taste, and should be
      reverted rather than defended.

- [ ] **Does `check_back_after_ms` actually change client behaviour?** Same shape as the
      restart-refusal item: the number is shipped, the belief that a client will honour
      it is a hypothesis, and no client has met it yet. Read the poll counts per review
      after a day of real use and compare against the 10s-to-60s era. If clients keep
      looping, the instruction is not the lever and something else is.

- [ ] **What D-80's kept sessions actually save, and the half that was never built.**
      `Tier.conversation` shipped 2026-08-12 and the saving has never been measured against
      its own baseline (`research/t2-token-cost.md`, with the numbers already in `usage` and
      `tier_run`) — the same question Phase 6 step 0 now asks in a wider form. And the half
      that is still not built: handing a mid-round submit to the LIVE session. D-55 refuses
      a submit while a round runs; a kept session makes accepting one possible, and nothing
      does it.

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
