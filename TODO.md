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

### 2026-09-02 — waiting on evidence: does the standing instruction actually change anything?

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

      **NOT MEASURABLE UNTIL IT IS DEPLOYED (Vany's call).** The instruction only reaches
      clients on a container recreate; `make restart` does not re-read anything. As of
      shipping it is on `main` and not on the deployment.

### 2026-08-28 — argued deferral: `spec/agent-docs.md`'s `review_poll` draft is stale well beyond the one sentence this round fixed

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
      `passed_partial`, `failed`, `expired`) is missing `findings_stale` and `cancelled`,
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

### 2026-08-28 — there was never a mirror bug: `refs/review/<sha>` misread a branch name as a top-level ref

- [x] **THE DIAGNOSIS BELOW WAS WRONG, not just the first fix for it.** CORRECTED same
      day, by lore's own review of the "fix": D-77's scratch ref is
      `refs/heads/review/<sha>` — a BRANCH under `refs/heads/*`, per SPEC.md's own
      worked example (`git push origin HEAD:refs/heads/review/<sha>`) — not a
      top-level `refs/review/*` namespace. The ONE refspec `mirror-refresh.sh` has
      always had, `+refs/heads/*:refs/remotes/origin/*`, already covers it and always
      has; `grep -rn refs/review src` returns nothing, confirming no code anywhere
      treats the top-level namespace as meaningful. A same-day fix that added a
      second `+refs/review/*:refs/review/*` refspec — verified working, against the
      wrong problem — was reverted; both `mirror-refresh.sh` and `deploy/Makefile`'s
      `mirror` target now carry `lore-ok` comments naming this so the same misreading
      does not recur a third time. What was real: CLAUDE.md's own prose ("a scratch
      `review/<sha>` ref") never spelled out `refs/heads/`, unlike SPEC.md — close
      enough to invite exactly this misreading, twice this session before being
      caught. CLAUDE.md corrected in the same change to say `refs/heads/review/<sha>`
      explicitly. The scratch-ref workflow has therefore worked correctly this whole
      time, via any `refs/heads/*`-scoped branch — which is exactly why this
      session's `refs/heads/review-scratch/<sha>` workaround succeeded on every
      single submission despite the believed-broken convention: it was never using
      the broken namespace to begin with, because it was never broken.
      ORIGINALLY (the wrong diagnosis, kept for the record): `mirror-refresh.sh` clones each repo with `git clone --bare`
      then sets `remote.origin.fetch` to `+refs/heads/*:refs/remotes/origin/*`
      explicitly (its own comment: "clone --bare populates refs/heads/* and NOT
      refs/remotes/origin/*... The refspec and the fetch are what finish the
      job") — every periodic and on-demand refresh since then, however many times
      it "completes" and logs `fetched`, only ever pulls `refs/heads/*`. A commit
      pushed to `refs/review/<sha>` (CLAUDE.md's own prescribed scratch-ref
      convention, "push and delete it in one command; nothing sweeps `review/*`")
      is therefore **never** fetched by lore's mirror, no matter how long a client
      waits or how many refreshes run. Confirmed directly on the deployment host
      (this machine): `git cat-file -t <sha>` against the bare mirror at
      `data/repos/<id>/bare.git` failed after several confirmed-successful
      `mirror.log` fetch lines; `git for-each-ref refs/review/*` there was always
      empty. `review_submit`'s own refusal message ("a single repository's fetch
      CAN fail inside a completed pass without lore seeing it") reads like a
      timing problem and sent me chasing one for the better part of an hour before
      I read `mirror-refresh.sh` and found the refspec — it is not a timing
      problem here, it is a namespace the fetch never asks for.

      **What this means today:** `commit`-form `review_submit` against a scratch
      `review/<sha>` ref cannot succeed, ever, until this is fixed. `diff`-form
      still works (it applies straight to the review's own private worktree and
      never touches the mirror), and is the only reliable path for a submission
      that was not already pushed to a branch the mirror actually tracks.

      **What is deliberately NOT fixed here:** the fix is either widening
      `remote.origin.fetch` to `+refs/*:refs/*` (mirrors everything, simplest, but
      changes what a stale/abandoned scratch ref costs to keep around — nothing
      currently sweeps `refs/review/*`, per CLAUDE.md's own text, so this needs
      that swept too or the bare mirror accumulates them forever) or teaching
      `review_submit`'s commit-resolution to do a targeted `git fetch origin
      <sha-or-ref>` outside the configured refspec when the ordinary fetch comes
      up empty (narrower, but a second fetch code path beside `mirror-refresh.sh`'s
      own, with its own failure modes to get right). Either is real shell/git
      surgery on the exact file `TODO.md`'s 2026-08-20 entry above already argued
      deserves its own deliberate change, not a same-day bolt-on. Vany's call
      which shape, and whether `refs/review/*` needs its own sweep either way.

### 2026-08-20 — argued deferral: `mirror-refresh.sh` can't say WHICH repo failed

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

### 2026-08-18 — needs a person, not a fix

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

      Every deep review meanwhile reads `passed_partial`: t2 and t3 both fall through to
      `zai-coding-plan2/glm-5.2` — the only non-metered entry in either fallback list,
      per D-117 — so all three tiers land on one vendor. `spec/review-ladder.md` already
      records why the fallback is 5.2 and not 5.3 (the GLM5.2 pool spanned both Z.ai
      plans and was deliberately split so a deep tier could not land on T1's own seat;
      plan2 simply does not carry 5.3). Not a bug — the honest consequence of the outage
      above, once vendor independence is properly enforced (D-49, widened 2026-08-17).

### 2026-08-17 — decided after D-121/D-122 shipped, in priority order

Vany: *"answer yourself."* These are mine, taken deliberately rather than deferred, and
each says why. They fold into SPEC as decisions when they are BUILT; until then this is
where they live, because SPEC describes what stands.

- [x] **1. A GARBLED FENCED BLOCK GETS ONE RE-ASK.** BUILT 2026-08-17 (D-123). Four findings were lost this way in a
      single day — every round of our own review carried *"t1 produced a finding this
      review does NOT contain — a fenced JSON block did not parse"*.

      The extraction is already right in the large: every candidate block is parsed, the
      ones that parse contribute, and a garbled sibling is reported loudly (D-66, measured
      — the old all-or-nothing rule binned five paid replies, one a 40-minute t2 round
      whose single finding was correct and load-bearing). The gap is narrow: `conduct`
      retries only when the WHOLE reply fails to yield a list, so a partially garbled reply
      is never re-asked, and the finding in the bad block is simply gone.

      **Re-ask once, for a `JSON.parse` failure only.** A syntax error is usually
      truncation and a re-ask has a real chance; a SCHEMA violation does not, and the code
      already knows it — told the exact rule twice, glm-5.2 shortened its claim by 44
      characters and still landed 14 over the cap. So this must not become a general
      retry-on-rejection: that trade was measured and lost. One turn, on the warm session,
      bounded per round.

- [x] **2. `review_submit` ACCEPTS A PUSHED COMMIT** BUILT 2026-08-17 (D-124). as an alternative to `tree_hash` — the
      proposal already written at the entry below, now decided. Additive to the contract,
      so no client breaks by not using it.

      The number is the argument: **16 reviews passed out of 128**, against 58 failed, 28
      cancelled and 18 expired, with one branch reviewed thirteen times. A review that has
      taken one submit is unanswerable by every later session, and the only exit discards
      every ratified justification. I hit it myself driving D-121: my submit failed on a
      tree mismatch and I fell back to force-pushing the ref and re-pinning.

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
  wrong: our own review of D-121 came back `passed`, not `passed_partial`, with
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



### 2026-08-16 — the metered fallback, which cost $101.36 in four hours

- [x] **The ceiling is GONE, and price decides nothing** — D-121, built 2026-08-17. Vany:
      *"we only show the price, there is no decision on the basis of it."* D-119's pause
      shipped on 2026-08-16 and lasted one day: it was right that `failed` was too strong,
      and still the wrong instrument. A paused gate is a gate that did not run, so the
      ceiling traded an invoice for the one outcome this project holds to be worst — and
      it stopped eight people who had not spent the money.

      Removed: `mayStart` and the enqueue refusal, `frozenBySpend` and the dispatcher
      freeze, the round-boundary backstop, the sweep exemption, both spend alerts,
      `hasMeteredUsage`, and `LORE_DAILY_CEILING_USD` — which now REFUSES TO START if it is
      still set, because believing a number caps the day when none does is worse than
      having no answer. `/status` publishes `allow_metered` instead.

      **What is given up, stated:** nothing bounds the total. Under `LORE_ALLOW_METERED=0`
      (the default, and this deployment) the bound is structural — no charging route is
      ever called. Under `=1` a lost subscription bills every call until a person notices,
      and that is now a purchase somebody made rather than one that happened to them.

- [ ] **eslint has NEVER run on lore's own repository, and cannot yet.** Every review of
      this repo reports `eslint: no `lint` script and no eslint config` in
      `checks_skipped` — one of T0's four engines dark on the repo whose whole purpose is
      catching what people miss, and we had both been reading past the line for weeks.
      Surfaced 2026-08-17 while driving our own review.

      **Blocked upstream, verified rather than assumed.** `typescript-eslint@8.67.0` (and
      its canary) peer-requires `typescript >=4.8.4 <6.1.0`; this repo is on 7.0.2. Forced
      into a scratch project it does not degrade — it THROWS at import: *"typescript-eslint
      does not support TS 7.0"*, pointing at
      https://github.com/typescript-eslint/typescript-eslint/issues/10940. The documented
      side-by-side workaround needs the RESOLVED `typescript` to be 6.x, which would take
      our own `tsc --noEmit` with it, and TS 7 is load-bearing here (`erasableSyntaxOnly`,
      no build step, D-33's source-is-the-binary).

      So: not forced, not faked. Options when 10940 lands, or sooner if it is worth the
      machinery — a separate lint workspace with its own TypeScript, or `oxlint`/`biome`,
      which parse TS themselves and have no TypeScript peer at all. **The gap stays
      REPORTED in the meantime**, which is the one part already working: the engine says it
      could not run rather than passing, exactly as INV-1 requires.

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

- [x] **A subscription falling through to a METERED route must say so at the moment it
      happens** — DECIDED 2026-08-16 (D-117), half built. Vany: *"metered is only
      openrouter. It is human managed."* So metered is a string test on the route that ran
      (`openrouter/`), answerable BEFORE the call, and whether to allow it is a checkbox in
      D-118's window rather than something the ladder infers. A deployment that bought
      metered capacity as a safety net wants the fallback; one on pure subscriptions wants
      `passed_partial` with the tier in `checks_skipped` — honest, free, already built.
      **BUILT 2026-08-17**: `isMeteredRoute` in `src/core/metered.ts` filters the fallback
      chain, `LORE_ALLOW_METERED` (default `0`) is the toggle, and it moves into D-118's
      window when that lands rather than waiting for it. The tier's own model is never
      filtered — configuring `openrouter/x` IS switching it on.

- [x] **The original write-up, kept for the evidence** (D-117). Kimi hit its billing-cycle limit at 05:06 UTC; D-48
      parked the route and walked the chain, correctly — onto
      `openrouter/moonshotai/kimi-k3`, the same model by a paid route, at ~$4.83 a call.
      Twenty-one calls, $101.36, every other tier that day costing zero. The route mark
      says `stated: false` and nothing else spoke until the $100 ceiling fired four hours
      later, taking out eight reviews across three colleagues' branches, most at round 0.

      The ceiling worked and is the wrong instrument: by the time it fires the money is
      gone and the people it stops are not the people who spent it. **Route health and
      route COST are different questions, and only one was being asked.**

      Answered 2026-08-17: the first shape, made switchable. Refused by default, restored
      by `LORE_ALLOW_METERED=1` for a deployment that deliberately bought the capacity. The
      second shape shipped too and is not an alternative — the per-call figure already
      reaches the operator log the moment a chain falls back. The third died with the
      ceiling (D-121).

- [ ] **A channel for "this arrived malformed and we kept it anyway."** The missing piece
      behind three refusals that can still cost a finding (D-116's `[OPEN]`): a
      non-positive `line`, a malformed `cwe`, an unknown key under `.strict()`. Each is a
      drift detector that fails by DISCARDING a report — the trade D-115 and D-116 have
      now reversed twice. `discarded` already reaches the client through `checks_skipped`
      ("t1 produced a finding this review does NOT contain"); this is its mirror, and with
      it all three can drop the offending field and keep the record.

### 2026-08-16 — incremental review (D-112)

- [x] **Say that a submit carries WORK, not only answers.** DONE. The engine already
      carried it — D-80's kept session, D-107's mid-round delivery, D-108's delta-only
      opener — and every text describing it said "your fixes". `TOOL_DOCS.submit` now says
      to send a feature, a refactor, or an unfinished direction, without waiting for a
      round and without a reason, and warns about the two consequences: findings will
      arrive about work still in progress (that is the point), and a verdict is always
      about the TREE the tiers actually read.

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

- [x] **(a) The round bounds fired on any long-lived review.** DONE 2026-08-16 (D-114).
      Both `perTierRounds` and `globalRounds` restart when the client delivers work, so
      they bound arguing rather than working. Termination is unchanged: with no new input
      the floor stops moving and the budget runs out exactly as before.

- [x] **(b) and (c) answered 2026-08-16: neither is broken, and that is the decision.**
      Admission counts parked reviews on purpose — a parked review holds a pinned
      worktree and becomes work again on the next submit — so longer-lived reviews raising
      the count is the bound working. Staleness distinguishes correctly too: an
      incremental review being fed moves on every submit, and one untouched for nine days
      is abandoned by any definition D-112 offers. SPEC D-114 carries the reasoning.

- [ ] **Per-principal admission share — the one real gap, deliberately unbuilt.** The 128
      is global, so one principal can take every slot and lock out colleagues. It cannot
      fire at this workgroup's volume (busiest day: about a dozen open), and the refusal
      already names `review_cancel` as the remedy. **The trigger to build it is the first
      refusal caused by somebody else's reviews** — until then it is a mechanism for a
      problem nobody has.

- [ ] **Measure where the cheapness stops.** A kept session hits 97–99% prompt cache, so
      marginal turns are cheap — until it compacts at 2/3 of the window, and compaction
      discards REASONING to keep code. So "it already knows this codebase" holds for hours
      and then quietly stops. Nothing measures that boundary; the economic case for
      incremental review rests on it.

### 2026-08-15 — delivery surfaces, and three fixes to today's fixes

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

- [x] **Transport changes in the same revision: NOT on a clock after all** (2026-08-16).
      Stateless transport drops `Mcp-Session-Id` — which lore's source never mentions, so
      there is nothing to migrate — and the deprecated legacy HTTP+SSE transport is one we
      do not use. Both were parked as "need a look before the offramp closes"; the look
      took one grep and found no exposure.

- [x] **Three fixes to fixes shipped the same day** (`884cdf8`). DONE. lore's own review of
      `main` found all three, and was right about each:

      `88ca976` did not fix what it claimed — it guarded three store WRITES and left every
      READ on the same path unguarded, and on the failure path the throw comes from inside
      `round()`'s own catch, escaping a promise detached with no `unhandledRejection`
      handler. The process still crashed in the window the commit said it had closed. The
      guard is now on the ROUND, which is the honest unit.

      `6130a65`'s wall-clock bound was granted fresh per `streamRun` invocation, and the
      catch-up pass re-invokes it up to 8× per member — "bounded at 90 minutes" could run
      ~13.5 hours. It is the round's budget now.

      `6130a65` also checked the deadline ABOVE `stillWanted()`, so a run crossing its
      budget could write `findings_ready` over a `cancelled` review — the resurrection this
      same loop had already fixed once for the sibling path.

      **The pattern, worth more than the three fixes:** each was correct about the defect
      and wrong about its BOUNDARY — the write but not the read, the call but not the loop,
      the check but not its order. All three passed tests and looked right. This is the
      case for the gate, made by the gate, against my own work.

### 2026-08-14 — the blocker, and it is not code

- [x] **The OpenAI plan's OAuth is dead, and it stops every review at t3.** DONE
      2026-08-15: Vany re-authenticated; the grant runs to 2026-08-25 and a probe through
      opencode answered. t3 reads directly again. It expires in ten days and will do this
      again — the failover now carries it (13 silent deaths became a working stand-in) and
      it pages, but a calendar note beats rediscovering it.
      ORIGINALLY: opencode's
      `auth.json` holds `openai` as an oauth grant whose refresh is rejected:
      `Token refresh failed: 401`, surfaced as a 500 `UnknownError`. Two reviews died on
      it within one window (`rev_n8sYlOP…` at round 8, after clearing t1 and t2; also
      `rev_whTzvU…`), and every review will keep dying there.

      **Only a person can fix it:** `opencode auth login` on the master machine, pick
      OpenAI, then copy `auth.json` into the container as we did for the second z.ai
      plan. lore holds no credentials for a remote by design (D-63), so there is no
      version of this it can do for itself.

      **The repair is already written and cannot deploy itself.** D-109 makes an auth
      failure a ROUTE fault — it walks the same-model fallback to
      `openrouter/openai/gpt-5.6-terra`, parks the dead route on the status line, and
      pages — but the deployed build predates that commit, so the branch that fixes the
      fallback is the branch the broken fallback refuses to certify. Re-auth first;
      then the review can reach a real verdict and the deploy is an ordinary one.

- [x] **D-109 is committed, reviewed to t2-clean, and NOT pushed** (`e2e0e81`). DONE
      2026-08-15: pushed on Vany's word with the review incomplete; `e8db997` is the
      statement of it. The debt is real and recorded, not waived.
      ORIGINALLY: t1 and
      t2 both came back clean over six submit rounds and 34 answered findings; t3 never
      read it. Per D-77 that is `failed`, not `passed`, so it waits — a tier that could
      not run is not a tier that found nothing. Once t3 is alive: fresh review of the
      same tree, then amend, push, deploy on Vany's word.

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

- [ ] **Cool a provider off instead of rediscovering it every review** (D-84).
      Vany's to decide: it changes which model is called and what it burns.

      Z.ai went out of quota on 2026-08-09 and answered NOTHING — no 429, no error, both
      its models silent while kimi and openai replied in 3-4s to the same one-line prompt.
      So the classifier's quota signal is absent in exactly the case it was written for,
      and the condition arrives as a hang.

      What is built already keeps reviews finishing: the deadline bounds the stall, and
      D-48-widened promotes the tier's work upward at `passed_partial`.

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

- [x] **The per-tier bound counts rounds, not progress — and it has now killed two
      CONVERGING reviews.** DECIDED 2026-08-28 (D-132): a documentation-only round
      (file extension/path — `.md`, `spec/`, `docs/`) does not trip the per-tier
      bound, the same shape as the existing clean-round exemption. The
      progress-based alternative named below — bounding on *rounds that settled
      nothing* rather than file type — is real and NOT what was built; it would
      also cover a prose loop happening inside `.ts` docstrings, which the shipped
      classifier cannot see. Left as a named, not-yet-built option rather than
      silently dropped.
      **CORRECTED same day (fingerprint 3407e345): the two reviews below predate
      D-114 (2026-08-16) and cannot recur via MCP the way they happened — D-114
      already resets this bound's counter on every tree-moving submit. What D-132
      actually protects today is `cli.ts`'s `lore review`, which reuses a review row
      across invocations without D-114's reset. Kept for that reason, not the one
      the table below was originally read as.**
      ORIGINALLY: `TODO.md` already argued the bound is the wrong instrument
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

### 2026-08-11 — a resumed session cannot answer a review, and it is expensive

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

### 2026-08-11 — found while deploying, not yet fixed

Both are defects, so under D-82 the default is to fix them in the change that found
them. Both are here instead, with the argument for waiting written out, because each
needs something this session cannot supply.

- [ ] **`review_start` accepts a branch identical to its base, and calls it `passed`.**
      Three tiers agreed that nothing contains no defects, which is INV-1's exact
      inverse: a review that read an empty tree reporting the strongest verdict this
      service can issue. It happened once, to me, by pushing `main` to the same commit
      as the review ref. **Waiting on:** nothing but a decision about the refusal's
      shape — refuse at `review_start` beside the stale-mirror and missing-ticket
      refusals, or let it run and end as its own state. The first is a one-line guard
      and the honest reading of *"a review that did not run is not a review that found
      nothing"*; the second says more but adds a state. Small either way; deliberately
      not bundled into a diff that was already ten files and answering a live finding.

- [x] **`drain.test.ts` fails intermittently.** Fixed 2026-08-11, third occurrence, and
      **found by reading rather than by reproducing** — 8 isolated runs and 3 full-suite
      runs all passed. The test slept a fixed 400ms and then asserted, but in that window
      the worker has to poll, claim a job and `git worktree add` off a bare clone before
      its reviewer is reached: comfortably under 400ms alone, not under a suite running
      fifty files at once. Exactly the signature it had. Three more sleeps in the file
      were the same latent race; they wait for the CONDITION now, which is faster in the
      normal case and correct in the slow one. The two that remain assert something did
      NOT happen, where elapsed time is the point.

### 2026-08-12 — found while building D-80's session continuity

Both are pre-existing, in code this change does not touch, and both are recorded rather
than fixed because each is a different subsystem from the one under change — a diff that
grows sideways is the one nobody can review.

- [x] **`apply.test.ts` copied a live `.git` with `cp -R` and raced.** Fixed 2026-08-12,
      same run as the drain timeout and for the same reason — it surfaced while gating this
      change. `cp -R` on a repository git is still writing to fails when a lock file or an
      auto-gc temporary disappears between readdir and open, and the error lands on an
      assertion about patch arithmetic that has nothing to do with it. Cloned now. Both
      flakes appeared only under this branch's suite, which adds nine HTTP-server tests:
      **added load did not create these races, it exposed them.** Worth stating because
      "it only started failing after my change" is a claim that usually means the opposite.

- [ ] **Twenty-four orphaned docblocks, found mechanically 2026-08-12.** A docblock that
      ends where another begins describes nothing: whichever declaration follows takes the
      SECOND block, and the first is stranded. `one-definition.test.ts` now counts them and
      holds a per-file baseline that may only go DOWN, so new ones fail — which is what the
      check was written for, after I made the mistake three times in one afternoon and one
      of the stranded blocks ended up asserting the opposite of the code beneath it.
      **Waiting on:** the judgement each one needs. Fixing them is mechanical but not
      automatic — you have to read what the stranded block was written about before you
      know where it goes — and two dozen of those would have swamped the diff a reviewer
      was already reading. Counts by file are in the baseline; `store.ts` has ten.

- [x] **A round finishing after the store closes throws an unhandled rejection.** DONE
      2026-08-15, after three more deploys went through that window in one day. The shape
      chosen: a store that ANSWERS closed rather than throwing, for the three
      round-completion writes only (`finishJob`, `updateReview`, `setFailureReason`).
      Safe because each is recoverable by construction — the job row stays `running` and
      `reclaimOrphanedJobs` requeues it, which is the same outcome the restart path
      already produces. Deliberately NOT a general shield: a write to a closed store
      anywhere else still throws, and a test pins that.
      ORIGINALLY:
      `Worker.round` → `Store.finishJob` → `database is not open` (`ERR_INVALID_STATE`),
      surfaced by vitest as an unhandled rejection out of `drain.test.ts`. **This is a
      drain-window defect, not a test artefact:** shutdown closes the store while a round
      is still in flight, and the round then writes its own completion into a closed
      handle. In the suite it is noise; in production it is an unhandled rejection during
      exactly the window three deploys have already gone wrong in. **Waiting on:** the
      right shape — a store that answers "closed" instead of throwing, or a round that
      checks before writing. Not bundled here because it belongs to the drain path.

- [x] **`drain.test.ts` times out roughly one full-suite run in eight.** Fixed the same
      day, because it was blocking this change's own review gate — a flaky suite in front
      of a push is not a deferrable defect. The cause was NOT the DNS message it prints
      (that string is fabricated by a stub; there is no lookup): these tests drive a real
      worker over a real bare clone, and the retried one does `git worktree add` + ingest +
      t0 twice inside vitest's 5s default. The report was the worse half — vitest killed
      the test at 5s while `until` still had 10s to run, so the error said "test timed out"
      and never named the condition. Every `until`-waiting test now has a 20s budget, so
      `until` always expires first and says what it waited for. Original text below. *"survives the
      interruption and finishes on the next attempt"* exceeded its 5s budget once in
      eight runs; the stderr names the cause — `getaddrinfo ENOTFOUND`, a REAL DNS lookup
      for the unreachable opencode the test points at. Fast when the resolver is idle,
      not fast under a suite running fifty files. This is the same file and the same
      shape as the 400ms-sleep race fixed on 2026-08-11: an assumption about timing that
      holds alone and fails under load. Verified not caused by this change: `promptBudgetChars`
      memoises its provider lookup, so building two prompts costs one HTTP call, not two.

- [ ] **Three people hold tokens on `rigid-monorepo` and the perimeter changed.**
      Provisioned 2026-08-07 for `koray` and `max`; `LORE_BIND` moved from `127.0.0.1`
      to `0.0.0.0` on Vany's call, so the service answers on every interface this laptop
      joins and **the tokens are the perimeter**. Two consequences that were theoretical
      yesterday: D-78 below is now live rather than hypothetical, and nothing yet has
      ever driven this service except sessions I primed — see Phase 3's done-criterion.

### 2026-08-14 — D-107 built, awaiting its own review

- [x] **The streamed conversation (D-107).** Emit-and-stop contract, held diffs landing
      at emission boundaries, mid-run delivery, the done declaration, gc pinning. Built
      and mutation-tested; driving through its own review gate now.
- [x] **Deploy D-107.** Stale checkbox, struck 2026-08-24: every deploy since
      2026-08-14 has shipped whatever was on `main`, and D-107's commits (`628f475`
      onward) have been ancestors of every one of them, including today's D-129 deploy
      — there was never a flag holding the behaviour back once it merged. Nobody had
      come back to strike this line.
- [ ] **Measure the loop against the batch baseline:** emissions per run,
      time-to-first-finding (the new number that matters), and whether MAX_EMISSIONS=32
      is ever hit in anger. Baseline: `research/t2-token-cost.md`. Genuinely still
      open — checked 2026-08-24, no measurement of this shape exists in `MEMO.md`,
      `SPEC.md` or `research/`.

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

- [x] **ZERO, 2026-08-08.** All twenty-eight converted across fourteen files, and the
      ratchet became the invariant it was named for: `no production file reaches past the
      store into SQL`, asserting an empty list rather than a shrinking one.
      **The assertion did not exist.** Recorded here and in the commit message as done, and
      it was not: only the failure message survived, pasted onto an unrelated guard. Written
      for real on 2026-08-08, and watched failing before being believed.
      Two of them were the `SELECT *` the ratchet's own comment called out, building
      `lore://review/{id}` and the VEX document — so the client-facing shape of both was
      a function of the schema. The replacement names every column and names exactly the
      ones `SELECT *` produced, so the published shape is pinned rather than changed: no
      client sees anything different today, and adding a column is a decision instead of
      an accident. `review.token_hash` landing on that table this week is the near miss
      that makes the point.
      Token queries moved too, and gained a reason of their own: a `SELECT *` over that
      table would put a credential hash into whatever the caller did next.
      *The original entry:*

- [x] ~~Twenty-eight production sites still reach past the Store into SQL~~, across
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

- [x] **Built 2026-08-08** (D-83). `lore-ok[<fp>]: rule <id> — <why>` is the citation, in
      all three comment forms; the cited rule's full text is quoted to the tier and the
      TIER rules on it — lore never closes a finding because a rule was pointed at it
      (D-10). An accepted appeal records a suppression for (engine rule class, FILE), which
      is consulted before T0's findings are recorded and announced in `checks_skipped`
      every time. Both reads join to live knowledge, so `knowledge_retire` / `lore rule
      --retire` switches every check it bought back on at the next review with nothing to
      sweep — including the individual verdict, which D-51 would otherwise carry forward
      for ever. Only T0 findings whose claim names a rule: a model finding is judgement,
      not a pattern, and a claim that is a sentence has no class, so nothing appeals past a red
      suite. SCHEMA_VERSION 14.
      **The remaining open question** is whether a model can originate the opposite claim
      — *this rule is wrong* — which is the same gap that leaves the escalation path
      unwired, and is worth solving once for both.
      *The item below is what measured the problem; this is the fix it could not name.*

- [x] **"Seen 23× — a pattern, not an incident" leads to nothing.** ANSWERED by D-83
      above: the client now has the verb it lacked. Asked by Vany
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

- [x] **The per-tier round bound is doing its job, and it is the wrong instrument.**
      DECIDED 2026-08-28 (D-132), same decision as the entry above: a
      documentation-only round does not trip the per-tier bound. "Documentation-only"
      is classified by file extension/path (`.md`, `spec/`, `docs/`), not by whether
      the model's ANSWER was wording versus behaviour — the measurement this entry
      asked for (wording vs. behaviour split of the findings that hit the bound) was
      not taken; the classifier shipped is a coarser, cheaper proxy for the same
      distinction, chosen without it.
      **CORRECTED same day: the session-34 and 2026-08-06 reviews below predate
      D-114 (2026-08-16), which already resets this bound on every tree-moving MCP
      submit — they cannot recur that way today. See the entry above for what D-132
      actually protects now.**
      ORIGINALLY: Two reviews of this repository have now ended `failed` on it — five rounds in
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

### 2026-08-11 — one session per review per tier (D-80 §6, designed); built 2026-08-12

- [x] **Stop restarting the model between rounds.** Built 2026-08-12: `Tier.conversation`,
      `src/reviewer/continuity.ts`, `Reviewer.release`, and the continued prompt. On in
      both deploy ladders for every model tier — **which is the quota-changing half, so it
      takes effect on the next deploy and that is Vany's call, not this commit's.**
      What is NOT built: handing a mid-round submit to the live session. D-55 still
      refuses a submit while a round runs; a live session makes that possible, not done.
      The saving is unmeasured until it has run a day — the baseline to measure against is
      `research/t2-token-cost.md`, and the numbers to compare are already in `usage` and
      `tier_run`.

      *(Vany's design, stated in full; his call on when it ships, because it changes
      quota.)*

      One session per (review, tier), initialised once and kept for the whole review;
      compacted at 2/3 of that tier's context window rather than restarted; a new tier
      enters empty of the previous tier's reasoning but on the fixed tree. Cold start stays
      as the fallback, so the floor is today's behaviour.

      **Measured opportunity:** 63 of 218 model rounds (29%) are a tier re-orienting on a
      review it has already read — t2's 36 repeats alone are ~$25 of the $97 it has cost.
      The saving is in TURNS: 31.6 per cold round against an estimated ~6 for a continued
      one, and turns are both the cost driver and inversely correlated with findings.

      **Supported by opencode:** `session.summarize`, and `CompactionPart.auto` shows it
      already compacts by itself — so the 2/3 rule replaces an inherited threshold with a
      chosen one.

      Design, evidence and the three risks: `research/t2-token-cost.md`.
