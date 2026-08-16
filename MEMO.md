# MEMO — development memory for `lore`

Newest first. Updated at the end of each task: what changed, what I learned, what
surprised me.

## 2026-08-16 — D-110, wrong twice: `node_modules` cannot answer a protocol question

**What changed.** D-110 is `[OPEN]` and gated on the SDK, having been "closed" twice today
on readings that were both wrong. Tasks is ALIVE: 2026-07-28 moved it into the official
`io.modelcontextprotocol/tasks` extension (SEP-2663) with `tasks/get`, **`tasks/update`
for client-to-server input**, `tasks/cancel`, a durable `CreateTaskResult` handle, an
`input_required` state with `inputRequests`, and optional `notifications/tasks` pushes over
`subscriptions/listen`. What blocks adoption is `@modelcontextprotocol/server@2.0.0`, which
carries only the superseded 2025 vocabulary. SPEC, `TODO.md` and
`research/mcp-subscriptions.md` §3 rewritten; no code moved, because nothing had been built
on any of the wrong premises.

**What I learned — the error, stated plainly, because it is a method and not a slip.**
Three times I answered *what does the protocol define* by grepping `node_modules`:

1. 08-08 — *"the same revision carries a task model."* Present in the SDK, yes; same
   revision, no. The grep found both wire eras and returned a union.
2. 08-15 — *"there is no `tasks/update`, so Tasks is poll-shaped, so it is interop not
   delivery."* That was the 2025 vocabulary. `tasks/update` is exactly what 2026-07-28
   ADDED.
3. 08-16 — *"the 2026 registry has no `tasks/*`, so the protocol dropped it."* That is an
   SDK which has not implemented the extension, described as a protocol that retired it.

The SDK says what our dependency supports today. The spec says what is standard. They
diverge for months, and `node_modules` will not tell you which question you just asked.

**Surprised me — twice, in opposite directions.** First that the SDK annotates its own
Tasks schemas *"no SDK runtime; kept importable for interoperability only"*, which reads
exactly like a retired feature and is in fact a library mid-migration. Then how close the
real extension is to lore: `review_submit` is `tasks/update`, `needs_human` is
`input_required`, `check_back_after_ms` is `pollIntervalMs`, expiry is `ttlMs`, and the
extension's own motivating examples are *"CI pipelines, human approvals, review steps"*.
We built an instance of this shape before it had a name. The one place we differ, lore is
the weaker side: `tasks/get` returns whole state while `review_poll` consumes deltas, which
is BUGS.md §3's complaint about our own design.

**What actually found it.** Vany asked *"may it be problems with the library, not with the
mechanism itself?"* — the one question that separates the two sources. Nothing in my own
re-check would have found it, because my re-check was a better grep of the same wrong
place.

Also recorded: the transport items parked as "on a clock" cost nothing. Stateless transport
drops `Mcp-Session-Id`, a string lore's source never mentions, and the deprecated legacy
HTTP+SSE transport is one we do not use. That one really was a single grep.

## 2026-08-14 — D-109: the deep tiers run together, and a dead credential walks the chain

**What changed.** The ladder walks RUNGS — a nested array in the tiers file is a set of
tiers that run concurrently on one worktree, each in its own kept session. Peer findings
cross at emission boundaries (`streamPeer`); a held diff applies ONCE at the first
boundary any member reaches and every member hears of it at its own, reading the shared
chain's unseen tail under a rung lock. The deployed config groups t2+t3, so the deep
phase costs max(t2, t3) wall-clock instead of the sum. `runRound` restructured around
`runMember` + `Promise.allSettled` merge; skip/promote paths return outcomes instead of
stepping the ladder from inside one member's catch. Same day, from a live failure:
`ProviderAuthFailed` joined `Exhausted` as a route fault — auth walks the same-model
fallback, parks the route (status line goes red), and keeps its own type when nothing
rescues so the worker pages.

**What I learned.** The D-107/D-108 machinery made parallelism almost free — sessions,
tree-tracking and t0 deltas were already per-tier; the whole change is topology plus
three shared-state disciplines (one lock, two watermarks). The delicate parts were all
in the merge: whose silence settles (strongest member), who stamps a rejection (the
member that re-raised, at the highest rank), and stepping from `ladderNow` rather than
the stale `review.ladder` so a skipped sibling stays skipped.

**Surprised me.** rev_gOhsCu died 0.4s into t3 — after clearing t1 and t2 through two
fix cycles — because an OAuth refresh token expired and the 401 arrived dressed as a
500 UnknownError. Three independent guards (fallback chain, page, status mark) all sat
behind the same one-line classifier miss. When one string not matching disables three
defenses, the classifier IS the defense.

**Also fixed in passing.** `stopAndDrain` in drain.test.ts — the suite's teardown
closed the store under in-flight rounds, theoretical for months, every-run once the
round gained awaits. And the position narration no longer counts a rung-mate mid-read
as a reviewer who "found nothing left".

**Then the gate read it, six submit rounds, and this is the part worth keeping.** 34
findings, answered to zero: t1 clean, t2 clean, five findings argued rather than changed
and accepted as `justified-accepted`. Twice it caught a defect *in the fix for the
previous defect*, which is the loop doing the one thing no amount of care replaces:

- `pull_fresh` compared against the fixes-applied tree, so a no-op re-pin rewound a
  review past every submitted fix. Fixed with an `origin_tree_hash` column — and the
  reviewer found the fix was DEAD CODE, because `review_start` writes the row before any
  worktree exists, so the column was NULL exactly when the guard needed it. Fixed again
  at round 0. Then it found the guard still DESTROYED the worktree before deciding
  nothing had moved. Fixed again. Then it found the destroy-first fix read
  `refs/heads/<branch>` while a production mirror only advances
  `refs/remotes/origin/*` — local heads frozen at clone time — so the guard was wrong in
  both directions, *and* that the test fixture was hiding it by fetching with the
  non-production refspec. Four rounds on one seam, each one a real defect.
- Streamed usage summed per-emission figures that are each the session's CUMULATIVE
  total: ~n²/2 inflation on the exact number the daily spend ceiling reads.
- `held_diff` had no `ON DELETE CASCADE`; one submit-then-cancel review aging past
  retention would have wedged the hourly sweep for ever, hourly, silently.

**What that says about writing fixes.** Every one of those was a fix that looked right,
tested green, and was wrong about something one layer out — the writer that never ran,
the namespace the mirror actually uses, the arithmetic of a cumulative counter. The
common shape is a correct local edit resting on an assumption about a DIFFERENT file,
never checked. That is precisely what an independent reader is for, and precisely what
"I verified it" cannot cover.

**And it ended `failed`, not `passed`.** t3 threw `Token refresh failed: 401` on round 8
— the OpenAI plan's refresh token is rejected — so the third vendor never read this code
and the verdict says so. The fix for that failure is IN this commit and cannot help,
because the deployed build predates it: the branch that repairs the fallback cannot be
validated by the ladder it repairs. Nothing pushed, nothing deployed; it waits on a
person re-authenticating that plan.

---

## 2026-08-14 — session 56: the review becomes the conversation it was specified to be

D-107 built, on Vany's design, in his order: *"the model must emit a finding immediately
… emitting a finding is the perfect time to insert the data about the fix … continue
checking, or finish if everything was examined."* The tier-run is now a loop of short
prompts over the kept session: STREAM_CONTRACT makes the model emit-and-stop; emissions
are recorded and collectable WHILE the tier reads; a submit that lands mid-round is HELD
(never refused) and applied at the next emission with the model asked to rule; the run
ends only on the model's done declaration. The empty findings list is refused by the
extractor — under emit-and-stop, nothing-more-to-say IS done, and `[]` is confusion.

What the mutations caught this time: my "records each emission as it arrives" test
passed with mid-run recording deleted — it never checked WHEN. The probe hook (assert
the store between emissions, from inside the fake) is the pattern that pins timing
claims; final-state assertions cannot.

The one deliberate override: a held diff that cannot land outranks the ladder's ending —
`awaiting_diff` with the reason — because the client was told "you do not need to
resubmit", and a quiet findings_ready would be a silently dropped diff (INV-1).

Also: all reviews dropped by operator instruction before the build (219 reviews, 528
findings, history cleared; knowledge and usage kept), and gc.pruneExpire pinned to 45
days on every bare — the write-tree states must outlive a review by contract, not luck.

---

## 2026-08-13 — session 55 (continued): the day after the pool

**t3's three days of 45-minute hangs were four words the watcher did not know.** The
openai plan is out of quota; opencode retries "The usage limit has been reached" for
ever, so the session never ends and the deadline is all that ends it. The D-91 narration
carried the refusal the whole time — quotaRefusal's regex knew five phrasings and not
openai's. Measured live with a 40-second event-stream probe before fixing; one
alternation, and the parking/chain machinery catches everything downstream. The lesson
sits beside D-91's original one: the answer was on the stream, and the cost of not
recognising it was three failed reviews and a propose run.

**Vany removed propose's idle-system refusal** — it waited for a quiet system and a busy
system is never quiet; pools and chains have dissolved the starvation argument it rested
on. And the board's status line now answers the week's real question — which route is
out, and when is it back — instead of counting queues that no longer exist.

**D-106, findings_stale:** 48 hours bright, seven days gray, then expired. The graying
write restarts the clock; the submit gate never looked at the state, so gray accepts an
answer unchanged. The sweep's order (expire first, gray second) keeps the reasoning
checkable: what dies today was gray a whole week.

---

## 2026-08-13 — session 55: the pool ships, and six defects surface in a day

Vany asked one diagnostic question — *"look what happens with rev_zbFO, why t2 never
run?"* — and the answer was "it ran twice", but pulling that thread found six defects in
the pool feature I had shipped hours earlier. All one family: **every consumer of
`tier.model` was a latent caller of the nickname**, and I had fixed only the round's
primary call.

1. **The fallback route re-rolled every round** — t2 on plan1 in r2, plan2 in r3, so the
   session that raised the findings was abandoned and a cold one judged the fixes. Vany's
   rule has no exception clause: *"if a model is chosen, use it."*
2. **`usage.model` recorded the nickname**, making per-subscription spend untraceable
   exactly when two subscriptions is the point.
3. **A synthetic all-parked refusal was laundered into a stated tier cool-off** — my own
   error object's `resetAt` flowed into "the provider said its limit resets then", which
   no provider said, and D-94 then probed the fake mark and un-parked the route. Caught by
   the stickiness test's second round asking a parked primary.
4. **The hourly knowledge screen died every hour after the deploy** — `model id 'GLM5.2'
   is not provider/model`, loud and bounded (rules stay live, documents wait), found by
   greping the live log while hunting. The screen now resolves through `concreteRoute`
   and skips the hour out loud when every route is parked.
5. **The prompt budget silently died for pooled tiers** — `contextLimit("GLM5.2")` found
   nothing, and "no measurable window" means "send everything", so the fit-check was off
   for exactly the tiers pools serve. Budgets now fit the SMALLEST twin, because the
   prompt is built before the roll.
6. **The critic's vendor comparison read the nickname as its own vendor** — a pooled
   proposer could be handed a critic from the same company, one model criticising itself
   wearing two names.

Plus two guards: a pool mixing models is refused at load, and the chain never re-asks the
primary route (a fallback POOL can contain it even though a literal repeat is refused).

**Method note, because it is the whole story:** four of the six were found by mutation —
break the behaviour, watch which test fails, and when none does, the test was theatre.
The stickiness test itself was caught passing on a coin toss (two routes, one round) and
rebuilt as four routes across two rounds. The screen breakage was found by *reading the
production log*, not the code: the code looked right and the log said otherwise. And the
laundered cool-off was found by a test failing for what looked like a test bug and was
the third real defect.

---

## 2026-08-12 — session 54b: disk stops being lore's business, and a fallback becomes a list

**Disk watching is gone entirely.** The host-percentage alerts went on 2026-08-06 (D-71);
what replaced them was a budget on lore's OWN footprint, and Vany removed that too: *"it
is not lore's responsibility."* He is right in the place I would have argued: lore's
growth being lore's fault does not make the alert lore's to raise. Sizing this machine and
acting on it belong to whoever owns it, and what the check actually produced was a ticket
on every beat for a threshold nobody had agreed to — in the channel that is supposed to
carry real faults. What bounds the growth is the retention sweep, which is not an alert.

Two things worth keeping from the removal. The measurement had already caused an outage —
one `readdir` plus a `stat` per file over 374,457 files across a Docker Desktop bind mount,
inside `checkHealth`, so the thing that watches was blocked by the size of the thing it
watched. And two heartbeat tests used the footprint ticket as a BARRIER: proof the beat had
actually run, so that "no page arrived" was a claim about behaviour rather than about the
clock. That pattern had to survive the deletion, and it did — the barrier is now a queue
ticket forced with `queueWarnDepth: 0`.

**A fallback is now a list, tried in order.** Vany: *"let's use an array for fallback in
config; let's fall back on t2 and t3 to openrouter, and then, if there is no quota, to
zai-coding-plan/glm."* The reason is the day it was asked: OpenRouter had run to zero —
$5165.00 granted against $5165.04 used — so every deep tier's single twin was as out as
the subscription it covered for, and t2 was `unpayable` with a fallback configured and
tried. One metered account is a single point of failure for every tier at once.

**The second entry changes what a fallback means.** The first is still the same model by
another route; the last resort is a DIFFERENT model on a plan that is still paying. That is
a weaker substitute and the right one — a different model still reads the code, where a
tier that cannot run reads nothing. What it costs is vendor accounting: `soleVendorOf`
reads the CONFIGURED model, so a t2 answered by z.ai while t1 runs on z.ai is two vendors
wearing three names. Recorded as `[OPEN]` in D-93 rather than fixed, because it belongs to
attestation.

**I made the exact mistake the guard now refuses**, within minutes of adding the feature: a
tier whose primary is the z.ai plan got a last resort on the z.ai plan. The chain is only
ever walked because a provider said QUOTA, so that entry could only refuse again — a real
call spent buying a certainty, in the outage the list was written for. `loadTiers` refuses
it now rather than filtering it, because silently dropping an entry leaves an operator
believing in spare capacity lore has quietly decided not to use.

**Model ids were read from `/config/providers` on the running opencode, not from memory** —
which needed the basic-auth credentials from the container's own environment. `zai-coding-plan`
carries `glm-5.2`, `glm-5.2-highspeed`, `glm-4.7`, `glm-5-turbo`; the flagship is the last
resort, not `glm-5-turbo`, because that is t1's model and a deep tier answered by the fast
tier's model is one opinion asked twice.

---

## 2026-08-12 — session 54: the model stops being restarted between rounds

D-80's session half, built to Vany's design after the research session priced it: *"the
main idea is to stop restarting it and continue the session in opencode, and manage it so
each model will be started and initialised only once per review."*

**What it is.** `Tier.conversation` opts a tier in. The reviewer keeps a session per
`(review, tier)`, sends the full orientation once and a short continued message every round
after, compacts at 2/3 of the window instead of restarting, and `release(reviewId)` deletes
the sessions when the review reaches a terminal state. Everything is in
`src/reviewer/continuity.ts` with the reasoning; the mechanism is spread over
`opencode.ts`, `prompts.ts`, `review.ts` and `worker.ts`.

**The correction that shaped it.** I proposed dropping the session and starting cold on the
fixed tree, arguing the worktree is the memory. *"I said compact, who said restart?"* He is
right and the distinction is the whole feature: the worktree remembers the CODE, never why
the model looked where it looked or what it ruled out. `settledBlock` exists to reconstruct
a fraction of that for a fresh session, badly.

**A design decision I got wrong and the type caught late.** `continuedPrompt` first took
`PromptInput`, so the caller invented `tierIndex: 0, modelTierCount: 1` for fields it never
reads — and the day anyone rendered `position(i)` there, a t2 round would have introduced
itself as *"tier 1 of 1"* with nothing failing. It has its own three-field type now. A
prompt that lies quietly is the worst defect shape this project has.

**Then the same class again, on the other side.** The continued prompt handed the tier
every open finding on the review. D-10 says the tier that raised a finding judges the
answer to it — so t1 would have been asked to rule on what t3 raised. `round.test.ts`
already refuses to let a weaker tier CLOSE a stronger tier's finding; nothing stopped it
being ASKED. Filtered on `origin`, with a test.

**The config would have crash-looped the service, and the suite could not see it.**
`TierSchema` is `.strict()`, so adding `"conversation": true` to the deploy ladders made
them malformed — and `loadTiers` throws rather than falling back, which is right. The
suite had never parsed a single file in `deploy/`. One probe test proved the boot failure
before it could happen; the permanent guard reads the directory and loads every
`tiers.*.json`, because a config nobody remembered to add to a list is the one that breaks.
**This is the same shape as the LORE_CONCURRENCY crash loop the day before**, which took
the service down for twenty minutes: a value the container passes, that the code refuses,
found only by deploying it.

**Three mutations to prove the tests could fail**, after the board-page stub that returned
`[]` and made six assertions vacuous earlier this week. Two of my first mutations were
absorbed silently — a `throw` inside `.then` lands in the `.catch` chained after it — so
the compaction-failure test looked covered while proving nothing. The mutation that
escapes the promise chain is the one that counts.

**Two session leaks, found by asking who else ends a review.** The design note put
"sessions are released when the review ends" first among the things to get right, and I
wired it to the worker — which only runs when a JOB finishes. `review_cancel` on a review
sitting in `findings_ready` has no job in flight, and `Reviewer.cancel` returned early in
exactly that case: the one path that leaks was the one that returned first. The retention
sweep marks abandoned reviews `expired` in SQL and nothing there could know about a model
session. Fixed as one immediate release in `cancel` and a RECONCILE on the worker's idle
ticks — written as a reconcile on purpose, because every existing way a review can end
predates the session map and the next one nobody thinks of gets collected too.

**And I got the submit ORDER wrong again — fourth time.** The fix for the leak went in one
submit and the `lore-ok` explaining that the cause was fixed ELSEWHERE went in the next.
`will_not_settle` told me immediately: the finding names `releaseIfFinished`, that method
is correct and did not move, so a tier that stops raising it has changed its mind rather
than been satisfied. By then the round had already started and D-55 refused the second
submit — so the acknowledgement waits for `findings_ready` and the deep tier pays for a
round it did not need to run. **The rule, stated plainly because remembering it has not
worked: when a finding is fixed somewhere other than where it was raised, the `lore-ok`
goes in the SAME submit as the fix.** It is not a follow-up; it is half the answer.

**Found on the way, both pre-existing, both recorded rather than bundled:** a round
finishing after the store closes writes into a closed handle (`ERR_INVALID_STATE`,
unhandled rejection, in the drain window three deploys have already gone wrong in), and
`drain.test.ts` times out about one full-suite run in eight on a REAL DNS lookup.

**Not built, and the spec now says so in the same place:** handing a mid-round submit to
the live session. D-55 still refuses a submit while a round runs. A live session makes that
possible; it does not make it done. The saving is unmeasured until it runs for a day —
baseline in `research/t2-token-cost.md`, comparison data already in `usage` and `tier_run`.

---

## 2026-08-11 — session 53: a board, and what looking at it found

Vany asked for a web view — *"on the / of some port over http on localhost, draw
interactive push updates there, all current reviews and collapsible details"* — and then
kept reading it. Almost everything below was found by him or by lore looking at the board,
not by me looking at the code.

**The board (D-96).** One self-contained page at `/`, SSE-pushed, collapsed by default.
Three levels: review → tier attempt → finding. The number it exists for is *time since
anything moved*, and its definition is the load-bearing part — the newest of `updated_at`,
any tier boundary and any finding's first sighting. `updated_at` alone moves on STATE
changes and a deep tier reads for twenty minutes without one, so the naive version would
have called every healthy t2 round stalled and trained its reader to ignore the only
signal that matters.

**What only LOOKING found.** I built it, asserted it, and then took a screenshot — and the
screenshot was where the real defects were. `NO TIER IS WORKING`, the four-and-a-half-hour
stall's own shape, was behind a click. The two clocks had no labels. A finished review's
total kept climbing for ever, saying a review that passed on Monday was still spending
time. Later, `no tier` started firing on QUEUED rows, where having no tier is ordinary —
an alarm on the normal case is one nobody reads twice. **A UI verified only by assertions
is a UI whose layout nobody has checked.**

**Vany asked why nobody claimed a job, and my answer was wrong** (D-97). I said worker
loops were held at the model gate; the board's own numbers said one call in flight and
none waiting. The three queued jobs belonged to CANCELLED reviews — `claimJob` refuses
them, correctly, and nothing ever closed the rows. Nineteen hours old, uncounted by
nobody: `queueDepth` counted them, so an idle service reported a growing backlog to
`/status`, to the board and to a ticket condition. **I should have read the rows before
answering.** Reasoning from code I had just read produced a confident wrong answer about
live data, which is the exact thing this service exists to prevent in other people.

**Then he refused the gate itself** (D-98): *"there may be no situation where a job waits
for the session in opencode."* The semaphore was real protection with real evidence
behind it — twelve concurrent calls killed four reviews in 2.5 minutes — but what it
produced daily was a round in `queued` with a clock running and nothing able to say
whether it was waiting or wedged. The bound moved to admission: refuse at 128 open
reviews, launch everything else immediately. Concurrent calls are now bounded by
`LORE_CONCURRENCY` alone, which is *the same twelve*. Recorded as a deliberate trade, not
an oversight: waiting is invisible, a provider refusing is loud and names itself.

**The gate caught me four times.** t1 found that D-94's probe stamp was erased by the very
refusal that discovered it — the interval was void on every deployed tier with all tests
green. t2 found that my fix to a stale drift guard had NARROWED it, dropping
`REVIEW_PROMPT_TEXT` while my comment claimed it had only moved. t2 found `board()` stamps
`at` on every call, so the stream's change-detection never matched and it pushed every two
seconds while the docblock above it promised an idle board transfers nothing. And it found
`review_inbox`'s 50-row cap could bury the parked review the D-95 filter exists to surface.
**Four for four, all real.** Best argument for the gate I have had.

**Three mistakes I made repeatedly.** A backtick in a comment inside `board-page.ts` ends
the template literal the whole page lives in — three times, until I made it a test, which
caught the fourth within a minute and named the cause instead of a missing comma thirty
lines away. A NUL byte in a composite key made `grep` treat the file as binary; I hit the
silence, failed to recognise it, and `one-definition.test.ts` told me what it was. And I
mis-ordered a `review_submit` twice: the `lore-ok` for a finding fixed elsewhere belongs in
the SAME submit, not the next one.

**A client hit a structural hole.** A resumed session cannot answer a review that has taken
a submit: the review's tree is the pinned one plus applied patches, it exists only inside
lore, so no later session can diff against it or match its hash. The only exit is a restart
that re-pays the cheap tiers and discards every ratified justification. The numbers say
what that costs — **16 passed out of 128 reviews**, one branch reviewed thirteen times. The
message now tells the truth; the fix needs a way to submit a tree both sides can name, and
that is a contract change waiting on Vany.

---

## 2026-08-11 — session 52: the gate caught my own gate, and the inbox was blind

Vany: *"let's deploy everything and restart, noone use us now."* Deployed `dfc04ec`, drain
cleared, and the **eight rigid reviews that had been stuck since 21:13 the night before**
went straight to running. The drain flag was mine: a `make deploy` that timed out on
2026-08-10 set it and never cleared it, so the service answered `ok: true` for thirteen
hours while claiming no work. `make up` clears the flag on start, which is exactly why
that path exists — I just never got to it.

**Three defects, and I found none of them by looking for them.**

*The suite went red overnight with nobody touching it.* A fixture pinned Z.ai's literal
answer — `2026-08-10 18:19:09` — against a round that reads the real clock. In the future
when written, in the past by morning, at which point `retryAt`'s floor clamp correctly
returned now+60s and the assertion silently began comparing something else. It announced
itself only because I happened to run the suite on the far side of midnight. Same class as
a review that did not run.

*My own t1 found a real bug in D-94, the commit I was pushing.* The probe stamps the mark
before it calls; the primary refuses; the fallback's catch rewrites the mark with five
arguments and no stamp. `shouldProbe` then reads *never probed*, so the next review probes
immediately — the once-per-review cost D-94 exists to bound, restored in full, with every
test passing. Fixed in the store (a write that does not name a `probedAt` keeps the stored
one) and NOT at the two call sites, because one of them is reached by the cool-off's own
synthetic `Exhausted` where no provider was asked at all; stamping `now` there would push
the probe forward for a call that never happened and D-94 would never probe under load.
The same failure wearing the opposite mask.

*`review_inbox` could not see the review its own documentation is about* (D-95). Filter was
*has undelivered findings, or is needs\_human*. So a session that polls, starts fixing, and
ends leaves a review parked in `findings_ready` with its deltas consumed — and the next
session, making the one call whose stated purpose is *what is waiting for me*, is told
nothing is. Found from the operator side: `/status` listed `rev_uFMG9` in `findings_ready`
for two days while `review_inbox` returned `{"reviews":[]}` to the same principal. Two
views of one database disagreeing about whether anything was waiting.

**A drift guard that defended its own stale copy.** `docs.test.ts` checked that the docs
name only registered tools — against ten names typed into the test file. The server
registers twelve. So the first doc to tell a client about `review_cancel`, a tool that has
existed for weeks, was failed for naming something that does not exist. The check now runs
against a live `tools/list`, in `http.test.ts` where a server already exists. **A guard
holding its own copy of the truth eventually defends the copy** — and the failure direction
is the worst available, because it blocks the fix and blesses the stale text.

**What I got wrong on the way.** I wrote a second assertion — *every registered tool is
mentioned in some doc* — and it failed on four tools. It was not a rule this codebase
holds: every tool ships its own description and the client learns the name from the
protocol. Replaced with the version that is actually load-bearing: every registered tool
arrives with a description long enough to use.

**And I mis-ordered the submit.** `will_not_settle` warned that the finding names code the
diff had not moved, because the cause was fixed in the store; the `lore-ok` belonged in the
*same* submit, not the next one. A round was already reading by then, so the answer waits
for the round to end and the finding will be re-raised once for nothing.

**`rev_uFMG9` could not be cancelled.** D-78 binds every call to the token that STARTED the
review, and that token was from an earlier session. Same principal, so the inbox will list
it once D-95 ships; `review_cancel` still answers NOT FOUND. Documented behaviour, not a
defect — but D-95 makes previously invisible unactionable rows visible, and this is the
first one. It self-resolves when the sweep takes it.

---

## 2026-08-09 — session 50: I argued the ladder was a panel, and lost

Vany: *"quota on t1 must allow to skip it and start t2. passing of t2 must make t1 not
needed."* I disagreed, argued it, was overruled, and built it (D-88).

**The argument, for the record.** `spec/review-ladder.md` §1 says the ladder is ordered
by VENDOR, not capability — intercepts 51/57/59, and K3 is kept at 3× the price of
GPT-5.6 Terra for two fewer points *because it buys a third vendor*. Under a capability
reading, t2 has no reason to exist. And our findings table does not look like a subset
relation: t2 has raised 111 findings with 3 high+, t1 **95 with 13** — the largest source
of high-severity model findings we have.

**Why neither settles it, which is why I could argue but not win.** The ladder is a gate,
so t1 goes first and its findings are fixed before t2 ever sees that code. The numbers
refute *"t1 is obviously redundant"*; they cannot show *"t1 is necessary"*. There is no
experiment in our data that separates *found it* from *found it first*.

**The part I got right and kept.** One label for every skip was wrong under either model:
"the cheap first pass did not run" and "nobody ran the adversarial tier" printed
identically. Now they do not.

**The trap I nearly built.** The obvious implementation forgives every skip at or below
the cursor. But `runRound` promotes a dead tier by calling `step` with nothing raised — so
a tier that FAILED arrives at the decision looking exactly like one that came back clean,
except for its `unavailable` entry. With the cursor as the pivot, a t3 that hung would
have been forgiven and the review called `passed` with nothing having read it at that
level: INV-1 inverted, inside the change that relaxes the rule. The pivot is
`highestThatRan`, and there is a test that fails without it.

**What did not move.** Every skipped tier is still disclosed on a `passed` —
`checks_skipped`, the operator view, and an attestation that names only the tiers that
read the signed tree. D-49's sole-vendor rule is untouched: t1 skipped with only t3 left
is still `passed_partial`.

**Also corrected.** My cancel reason said *"re-run once the screen honours
skip_if_quota"*, which framed a cost problem as a validity problem — the same conflation
Vany was pointing at. That review needs re-running because it never reached any tier, not
because t1 was missing.

---

## 2026-08-09 — session 49: three more holes of the same shape

Kept pulling the same thread — *what does the system claim, and what could make that
claim false without anything noticing* — and it kept paying.

**"A tier is working" was a label, not a fact.** `STATE_STYLE.running` prints that
sentence for every running review, and it is what I read for forty-five minutes while
`rev_NYiv0xfO` was stuck in the screen with no tier asked at all. I then reported a hung
tier to Vany on the strength of it. The operator view is where a stall gets diagnosed, so
a confident wrong sentence there does not merely fail to help — it aims the search. The
evidence needed no new column: a tier that is working has an OPEN `tier_run` row.

**The enqueue had no failure path at all.** `review_start` writes the row, answers
`state: "queued"`, and enqueues afterwards in a bare `void promise.then(...)`. A throw
anywhere in there was an unhandled rejection — a dead process, by Node's default — on the
way to a review with no job, and nothing reconciles that: `reclaimOrphanedJobs` frees jobs
stuck `running`, not reviews that never got one. It would have waited two days for the
sweep to call it `expired`, which means *nobody came back*.

**The pattern is the closure.** Both this and yesterday's missing reviewer lived inside a
lambda built in `serve()`, where no test can reach them. So `enqueueOrFail` is a file now,
with four tests including the broken-store case. That is the actual lesson from two days:
*an untestable closure is where this codebase hides its holes*, and the fix is to stop
writing them rather than to test harder.

**What I checked and found sound**, recorded because a sweep that only lists hits reads as
if everything else was examined and nothing was:

- the ladder cannot reach `passed_partial` with no tier having read the code — both
  promotion paths refuse when nothing is left, and `step()` only decides it from a tier
  that came back clean;
- INV-9 is enforced at the filesystem, not by prompt: the repos bind into opencode `:ro`;
- `Alerter.send` never throws, so `mayStart` could only reject on a database fault;
- `getReview` matches the principal exactly, so `attest`'s `?? ""` fallback cannot widen
  scope — it fails closed;
- `anyTierRan` is correct at both call sites but **named wrong** — it means *could still
  run*, not *did run*. Left alone this round; it is one bad reading away from mattering.

Also: `spec/mcp-api.md` said "Ten", listed eleven, and omitted `review_cancel` entirely.
Now checked mechanically against `registerTool`.

---

## 2026-08-09 — session 48: the request flow, and four ways a cancel was a lie

**A review that never reached a tier at all.** `rev_NYiv0xfO` sat "running, round 0" for
45 minutes on t1, and I assumed it was the tier. It was not: the database had **no t1
`tier_run` row**, only t0. The hang was in the *knowledge screen*, which
`review.ts:339` binds to the cheapest model tier — t1 — and which runs inside
`ingestDocs`, before `openTierRun` exists. `skip_if_quota`, built the day before for
exactly this provider, governs the ladder's retry and had never heard of the screen.

Six documents had changed. The screen is one call per document and fails open, so it was
about to buy the same dead answer six times at 45 minutes each: **four and a half hours
before any tier was asked anything**. Two of the six were already spent when I looked.

**Reading the flow, not the code, is what found the other three.** I only got there by
following one request end to end — `/status`, then `tier_run`, then opencode's session
list, then the message timestamps. Each layer agreed with the layer above and all of them
were wrong about the same thing.

- opencode's sessions: mine created 22:31:31, **completed 23:16:31**, zero tokens, no
  error. Forty-five minutes to the millisecond of the deadline, and a new session opened
  in the same millisecond. That is what told me the loop was per-document.
- `review_cancel` answered `stopped_in_flight: false` while that session was open. Not a
  handler bug — `startHttp` was built with `store`, `worktreeFor`, `enqueue` and `attest`
  and **no reviewer**, so `deps.reviewer?.cancel?.()` was `undefined ?? false` on every
  cancel the service has ever served. The comment above that line already said a cancel
  that only marks a row is worse than none. It was describing what shipped.
- Aborting all three sessions through opencode returned 200, and ninety seconds later
  `/status` still read `inFlight: 2` with no active review. Telling the server to stop
  does nothing to our own open HTTP request. `session.prompt` had no `AbortSignal`.

**What made the wiring bug invisible was the test suite agreeing with it.** Every test
builds `startHttp` the same way production did — without a reviewer — so the broken path
was the only path under test, and the correct-looking handler passed. The new test drives
`serve()` instead, and I checked it fails without the fix rather than assuming: `expected
null to be false`.

**`false` and `null` are different claims and I had been rounding one to the other.**
`stopped_in_flight` is now three-valued: stopped, nothing running, *could not look*. INV-1
applies to a cancel exactly as to a review, and I had not noticed because the field is a
boolean and booleans invite exactly that collapse.

**The spec table said "Ten" and listed eleven, with `review_cancel` missing.** Found by
accident while documenting it. Now checked mechanically against `registerTool` — including
the count in words, because a hand-written count rots on its own. My first version of that
check swept up the new three-valued table's `true`/`false`/`null` rows and reported them
as undocumented tools; a check that fails for an unrelated reason gets disabled, not fixed,
so it is scoped to §2's own table.

**What I got wrong on the way.** I said "the call in flight isn't the one `skip_if_quota`
guards" only after measuring; before measuring I had told Vany the review was t1's tier run
hanging, which was the obvious reading and the wrong one. The database was one query away
the whole time.

**Left for Vany** (changes which model is called): nothing holds Z.ai's reset time, which
we have — `2026-08-10 18:19:09`, measured. A per-tier `unavailable_until` would skip the
call outright, no credentials, no probe. `TODO.md` carries it.

---

## 2026-08-09 — session 47: a subscription at its limit answers nothing

**Z.ai ran out of quota and said so by saying nothing.** No 429, no error, no refusal —
the request is accepted and never answered. Both its models, while `kimi-for-coding/k3`
and `openai/gpt-5.6-terra` replied to the identical one-line prompt in 4s and 3s through
the same harness. So it was the account, not a model, and not opencode or the network.

**That breaks the assumption quota detection rests on.** `Reviewer.review` classifies
exhaustion from `429`/`402` or a message matching `rate.?limit|quota|insufficient`. An
exhausted subscription produced none of them, so the one signal lore has for "this tier
could not be paid for" is absent in exactly the case it was written for — and the
condition arrives as a hang, indistinguishable at the call site from a broken provider.

**Two things built yesterday turned out to be load-bearing rather than defensive.** The
hang deadline: until 2026-08-08 it could not fire at all, so an exhausted subscription
just consumed the review — a t2 ran 2h46m. And D-48 widened to promote a hung tier's work
upward, which is the only reason reviews still finish with t1 dead.

**Surprised me: I proved it wrong twice before proving it right.** My first probe failed
identically on all three providers, which meant my request shape was wrong and the result
said nothing — I nearly reported "the provider is broken" from it. The second control
collapsed its shell arguments and "answered in 0s" with empty text. Only the third, using
lore's own SDK path and its own `longFetch` with the model passed by environment, produced
a result worth trusting. Three attempts to ask one question honestly.

**Then I asked Z.ai directly and the first conclusion was wrong.** It is not that an
exhausted subscription answers nothing — Z.ai answers immediately and completely: `HTTP
429, code 1310, "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-10
18:19:09"`. **opencode** is what answers nothing: the assistant message it leaves carries
no error, no retry part, no finish. It swallows the 429 whole. So the root cause of a
customer's failed reviews, and of a t2 round that ran 2h46m, is our proxy — not the
provider, which was being perfectly clear.

D-84 is corrected in place rather than left standing. Writing the wrong cause into a spec
and then measuring properly is this week's whole pattern; at least this time the
correction went into the same document.

**Built on the back of it: `skip_if_quota`, and a failed call's tokens.** The flag is an
optional per-tier boolean on t1 — one attempt, then skip, because an exhausted plan names
its reset time and does not become available by asking again. And `usage` rows are now
written for failed calls, read back from the session, because two 45-minute attempts had
left the trailing-5h reading ZERO while the provider counted every token.

**Surprised me: fixing that introduced a worse inconsistency.** The failure path sums every
assistant message — the session. The success path reads the ONE message a prompt reply
carries — a single turn. In a real 73-turn session the per-message cache reads summed to
17.9M, so identical work now records a far larger row when it fails than when it succeeds.
Written into SPEC and TODO rather than left for whoever first sums the column.

**What is recorded and not built.** D-84 carries the measurement and the cost: with t1 on
an exhausted provider, every review now spends two dead attempts before promoting — 90
minutes of wall-clock, per review, to re-learn what the service already knew. A
service-wide cool-off with a re-probe after the window is the answer; it changes which
model is called, so it is Vany's. `/status` is blind to it, which is the stale-mirror
failure of yesterday in a different organ.

---

## 2026-08-08 — session 46: subscriptions, and getting the cause wrong twice before measuring

**Subscriptions work, and the reason they never did for me was two nested keys.**
`client.listen()` takes a `SubscriptionFilter`; the `subscribe` field I had just added
hands out the raw JSON-RPC frame, which nests the same thing under `notifications`. Over
the wire the wrapped shape is acknowledged with an EMPTY honoured filter and delivers
nothing — an open, healthy, useless stream. Unwrapped: honoured, and the wake arrives.
Measured on the round boundary at +377s, after an evening of believing the feature was
broken.

**I got the cause wrong twice before measuring it, in opposite directions.** First I wrote
the shape up as the cause in three files before checking. Then the in-process test honoured
BOTH shapes, so I reversed and recorded "cause unknown" — also in three files. Only the
wire settled it, and the wire agreed with the first guess. The lesson is not "trust your
instinct": it is that both write-ups happened before the measurement that could decide.

**The test cannot tell the two shapes apart, and that is now written in it.** In-process
something normalises the wrapped form, so `subscribe.test.ts` passes either way — a test
named for a property it does not test, which is the shape this repository bans. What does
discriminate is the assertion that the two handed-out fields agree with each other; the
`listen()` call is live confirmation, not a guard. Saying so is better than deleting it or
letting the next reader assume it protects them.

**Three other things the reviewer was right about**, all of them my own claims being
false: I recorded that the SQL ratchet "became a real invariant" and no such assertion
existed — only its failure message, pasted onto an unrelated guard. `lastWriteAt` claimed
to cover every timestamp column and missed `delivered_at`, the one `markDelivered` writes
on every poll. And the shell twin of that query still named five columns while the store's
read fifteen, so the monitor a person runs *in an incident* was the blind one.

**The tally, because it is the point.** Twenty-two findings across five rounds; eight were
my own comments, commit messages or specs asserting a property the code did not have. The
ladder caught every one. The rate says to write the claim after the check exists, not in
the same breath — and I broke that rule again on the subscription while writing this up.

---

## 2026-08-08 — session 45: a customer's false negative, and ten findings against my own day

**A report arrived from `rigid-monorepo`: semgrep flagged the SAFE one of two identical
XSS sinks and missed the unsafe one.** It named two candidate causes and could not
separate them — semgrep emitting one match, or lore collapsing them by fingerprint. lore's
half is answerable by reading: the fingerprint is `sha256(claim, file, symbol)`, so two
different FILES cannot collapse. Their miss was not ours.

**But the same defect one step further in WAS ours, and it is a false negative.** A pattern
engine reports no symbol, so two matches of one rule in ONE file hash identically and the
store's `ON CONFLICT DO NOTHING` dropped the second — silently. Proved it in three lines
before fixing it. Both engines now emit one finding naming every site, in the claim as well
as the evidence, because the model tier's T0 summary is one line per finding and a count
living anywhere else is a count it never sees. Grouped rather than keyed by line: that
would trade a false negative for permanent churn, since every edit above a match would
retire one finding and raise an identical one below it.

**And a second one, found by accident.** My reproduction fixture had a bad identifier.
semgrep answered `results: [], errors: [PartialParsing]` and exited zero — and lore read
only `results`. So a file semgrep could not parse was scanned, skipped, and reported as
carrying nothing. INV-1 inside the deterministic tier, which is the worst place for it,
because T0 is what a model tier is told it need not re-derive. It goes in `checks_skipped`
now, like any engine that could not run.

**The generalisable half of the customer's lesson is theirs and it is right:** a scanner's
silence on a sink class is not coverage.

**Then the ladder read my own day's work and found ten things**, one high. `review_inbox`
consumed deltas exactly as `review_poll` does — while its own documentation AND
`smoke.mjs` both said it consumed nothing. So `make smoke`, a read-only health check I ran
tonight, emptied the delta queue of every review it listed. It is repo-scoped, so no
colleague's findings were taken; the claim was false anyway, in a comment, above the code
doing the damage.

**Two of the ten were my corruption fix being wrong in the way it was proudest of.** The
integrity check was written third under a comment saying FIRST — and `replicaState` calls
`lastWriteAt`, which throws on a malformed database, so mid-run corruption made
`checkHealth` reject before reaching the one check that names the cause. The existing test
passed because it damages pages the live handle has CACHED. And `CONDITIONS.databaseUnreadable`
was only ever sent from the startup path, so a database that went bad while running paged
nobody. A test with a stub that throws on everything except `integrityFault` asserts the
order now, which no arrangement of bytes could.

**Surprised me: the appeal parser accepted `rule 1234`.** Four hex characters is also a
number, so *"rule 1234 of the style guide covers this"* — an ordinary justification — was
read as an appeal to a rule nobody wrote, and the tier was told to judge its central claim
unsupported. `cite_as` hands back exactly eight characters, so there was never a reason to
accept fewer.

---

## 2026-08-08 — session 44: the database moves off the bind, and I deployed the wrong file

**The corruption is diagnosed and fixed at the cause.** `lore.db` was on a Docker Desktop
macOS bind mount — virtiofs, which the container reports as `fakeowner` over
`/run/host_mark` — with lore and litestream both holding it open. SQLite's own
`howtocorrupt.html` §2.1 names exactly that: unreliable locking primitives plus two or
more processes. Three corruptions in three days, the damaged b-tree `knowledge` every
time, which is the table a review bulk-writes during ingest. It now lives in a named
volume: ext4 inside the VM, where two processes sharing a SQLite file is the arrangement
it has always been.

**Everything else stays on the bind, and that is not a compromise.** The T0 sandbox asks
the host daemon to bind a worktree into a sibling container by absolute path, resolved on
the HOST — a volume there would mount an empty directory and report a clean suite for code
it never saw. Two mounts because there are two requirements pointing opposite ways.

**I DEPLOYED THE WRONG FILE FOR AN HOUR.** `deploy/` is tracked; `lore/` is the gitignored
deployment; they are two copies. I edited the tracked one and ran `make up` in the other,
and the volume change appeared to do nothing at all — compose was reading a file I had not
touched. The service came up on a fresh empty database in the container's writable layer
and answered `ok: true` about it.

**The near-miss is worse than the hour.** The copies had drifted in BOTH directions: `make
knowledge` and `make smoke` existed only in the deployment, and so did the replica-state
fix that reads the database's own write log rather than file mtimes. Porting my change
onto the stale copy — which is exactly what I was about to do — would have silently
reverted that fix, in the monitor that exists to stop the wolf-crying. `make up` now
refuses when the two differ, and I proved the refusal fires before believing it.

**Surprised me: the CLI would have made a second database rather than complain.** Once the
file moved, every stale `--db` pointed at a directory where SQLite happily creates a new,
empty, perfectly valid database — so `make tokens` would answer "no tokens" and
`lore knowledge` "no rules", and both read as facts about the workgroup rather than about
the path. Reading commands refuse a database that does not exist now. Only `lore new` and
`lore review` create one, because bringing one into existence is their job.

**A fourth copy of "where is the database", found by `make status` dying.** I split
`LORE_DATA_DIR` into a data directory and a database directory and updated three of the
four readers; `ops/status.ts` still looked for `lore.db` under the data directory and died
with `unable to open database file` beside a perfectly healthy service. The other four
readers also disagreed about the FALLBACK — the service defaulted to `/var/lib/lore`, the
CLI to `~/.lore` — and nobody had noticed because the container always sets the variable.
`core/paths.ts` is the one definition now, and `one-definition.test.ts` fails if anything
else reads either variable or spells the filename. First version of that guard fired on
three files that only DISCUSS the path in prose; a guard that fires on comments is one
somebody silences, so it matches the two code forms instead.

**What I did not build, and told Vany why.** He chose "also stop the CLI opening the live
DB". On ext4 that buys no corruption safety — multi-process SQLite is the normal supported
configuration, and the danger was the filesystem, not the second process. What was real in
that ask was the SECOND COPY of "where does state live", which had already been wrong
today, so the Makefile now passes no `--db` at all and one env variable decides. The RPC
layer is not built and the reason is on the table rather than in a note.

---

## 2026-08-08 — session 43: a check can be switched off, and it says so every time

**D-83 built.** A project can write down what it has decided NOT to enforce, and a client
answers a finding with `lore-ok[<fp>]: rule <id> — <why it covers this code>`. The tier
gets the rule's full text and rules on it; lore never closes a finding because a rule was
pointed at it, because the author never closes its own finding (D-10) and a rule the
author also wrote would otherwise be exactly that route.

**The design question was what an accepted appeal SETTLES**, and Vany answered it: the
class, for that path. That is the whole value. Settling by fingerprint is what the ladder
already did, and it is why one semgrep rule was argued sixty-three times — the next edit
to the file makes a new fingerprint and the identical argument starts again.

**Two things I only found by writing the messages first.** The `checks_skipped` notice I
wrote says *"retire the rule to switch it back on"*, and there was no way to retire a rule
— a sentence naming an action nothing could perform. So `knowledge_retire` and `lore rule`
exist. Then the CLI's reply says *"every check it silenced reports again"*, and that was
half true: the class hole closes by a JOIN, but the individual verdict the appeal earned
kept being carried forward as settled (D-51), so the one place it had actually been argued
stayed silent for ever. `revokedSuppressions` closes that. Writing the promise before the
mechanism is how both were caught — worth repeating deliberately.

**A NUL byte was hiding a file from every grep.** `enrich.ts` held `k.path ?? "\0"` where
a space was meant. Behaviourally identical, so nothing failed — but `file` reported it as
data and `grep` reported NOTHING for it, silently. Above it sat a doc comment claiming
policies were filtered out of reviewer prompts, over code that did not filter them; I had
written the comment and believed it, and could not find the function by name to check.
Caught by a test asserting the prompt did not contain the rule text. This repository
enforces several invariants by grepping its own sources, so a file that greps as empty
passes all of them: `one-definition.test.ts` now refuses a NUL in any source.

**The engine rule class is read off the head of a claim**, `<rule id>: <message>`, because
`Finding` is the wire contract with the models and a field meaningless to them does not
belong in their prompt. Four engines had independently written that shape; `ruleClaim` is
now the one definition and `engineRuleClass` its inverse, with the ROUND TRIP tested rather
than either half. A claim that is a sentence yields no class, which is what stops anything
appealing its way past a red suite.

**Surprised me: three of the four tests that matter are refusals.** Rule does not resolve,
model raised it, no rule class, tier disagreed — each a different line, each the difference
between "argue your case" and "write a rule, cite it, switch the check off". The feature is
mostly the things it declines to do.

**THE DATABASE CORRUPTED AGAIN, MID-REVIEW — the third time in three days.** The damaged
tree was `knowledge`, which is the table a review bulk-writes during doc ingest, and the
restore from the litestream replica was clean and current (it even had the review I had
started four minutes earlier). Nothing was lost. `data/corrupt-0808-0119` holds the file.

**What is new is the diagnosis.** The database lives on a Docker Desktop macOS bind mount
— the container reports it as `fakeowner` over `/run/host_mark/Users`, i.e. virtiofs — and
TWO containers hold it open, lore and litestream. SQLite's own `howtocorrupt.html` §2.1
names exactly this: a filesystem whose locking primitives are buggy, plus two or more
processes, equals corruption. That is not a hypothesis about our code; it is the documented
failure mode of the deployment shape. The fix is to move the live database off the bind
mount and onto a Docker named volume — ext4 inside the VM, real kernel locking — keeping
the replica folder on the host so the outer script still reaches it. Vany's call: it is a
data move on his machine.

**What was mine, and is fixed: lore died where it should have spoken.** The first statement
after startup threw, `main()` exited 70, Docker restarted, and that loop would have run for
ever with `/status` refusing connections — indistinguishable from the machine being off. I
had added an integrity check to the heartbeat the day before, for this exact fault. It was
no use, and the reason generalises past this bug: **a check only runs while the service is
healthy enough to run it.** So the check moved to startup and a failure now serves a
refusal — 503 everywhere, `/status` naming the fault and the remedy in the same `problems`
key the healthy path uses, no worker, no heartbeat, no sweep. It does not retry and says so.

**The reviewer caught a real defect in the D-83 work, and a subtle one.** I gated the
carry-forward on whether the finding's engine rule class and path matched a REVOKED
suppression — and wrote a comment saying "only findings an appeal settled". Those are
different statements: an ordinary `lore-ok`, citing nothing, on a finding that merely
shared a class and a file with somebody else's appeal, was blocked from carrying forward
and had to be re-argued for a rule it never invoked. The fix is a column — `verdict.via_rule`
— so the verdict says what it rests on instead of the code inferring it. NULL for an
ordinary justification, which is the whole distinction. The regression test was checked
against the broken behaviour first: it fails there and passes here.

---

## 2026-08-08 — session 42: fix it now, and the day that argued for it

**Vany: "we fix bugs in this project immediately."** Written down as D-82, and the
evidence is a day rather than a preference.

**What deferral actually cost, in order.** The replica monitor was recorded at 19:00 as
*"cries wolf again, recorded not fixed"* — a careful, correct diagnosis. Thirty minutes
later the database was unreadable and `/status` was answering `ok: false` **for that
wrong reason**, pointing at a healthy replicator during the twenty minutes the product
was dying. Not "the note failed to help": the defect it described did the harm while the
note sat there. That is the whole argument.

Beside it: *"lore's whole footprint is under 5 GB"* written into a comment as settled
fact, in the act of deleting the check that measured it — 6.8 GB two days later, unseen.
And twenty-eight SQL sites behind a reasonable *"not in code with no ladder verdict"*,
during which `review.token_hash` was added one join from a resource clients read.

**Surprised me: the corruption was the second, not the first.** `data/corrupt-1416` is
dated 08-06. I had been treating today's as an incident; it is a pattern, and I only saw
it because I went looking at the directory for something else.

**What got fixed once the default flipped.** SQL past the store 28 → 0 — and the ratchet
did NOT become the invariant it was named for, which I recorded here as if it had. Caught
on 2026-08-08 by a reviewer reading this very sentence against the suite: no such test was
ever written, and what survived was the ratchet's failure message pasted onto the
comment-attribution guard, where it read as nonsense about SQL while scanning for
`raised by t3`. The work was real; nothing was holding it. It exists now, and I watched it
fail before believing it. `why` coverage 5 of 66 → 30 of 58. The screen's
three mechanical misses. Screened-out rows no longer stacking per edit. The sandbox
cache collected AND watched against a budget lore sets for itself. `[lore:log]` at 60%
noise. `LORE_TIERS` pinned so a swap cannot rebind an open review's cursor. D-78. The
settle preview. `lore knowledge` and `make smoke`, both of which existed as gaps only
because nobody had asked the question that exposes them.

**And what did NOT get built, which matters as much.** D-39 said measure the conflicts
before automating them. There is one, ever; it would have auto-resolved; and it is the
one already recorded as a false positive. So the feature that was asked for is not built
and the number is written down instead — refusing on evidence is not deferral, and D-82
says so explicitly so the two never get confused.

**I got the cost backwards and Vany corrected it.** I wrote that fixing everything makes
the diff larger and larger diffs cost more rounds — citing "fourteen commits needed three
reviews" as the price. That number is the *saving*. The ladder reads a TREE: a round costs
a t0 sweep, an ingest and one model call (t1 441s, t2 766s, t3 245s measured today), and
almost none of it scales with commit count. Fourteen commits reviewed singly would be
fourteen reviews, not three — four to five times the model time.

And weaker, because findings interact: t3's last pass produced a CHAIN — an ingest race,
a session the cancel could not reach, the gate window one layer earlier, then the worker
overwriting the `cancelled` the third fix had just made reachable. Each is invisible with
the others absent.

The real limit on a big diff is the context window, and that now degrades instead of
failing (`TooLargeForTier`, D-48). So batching is the default, not a compromise.

**Half of today's real defects came from asking the running system a question** — "what
is reviewing now?", "why does our client know about refreshing mirror?" — rather than
from reading the code. That is not a coincidence and it is worth remembering the next
time I am tempted to audit by reading.

---

## 2026-08-07 — session 41: a model vetoes the memory, and the gate read its own work

**Vany: "model screen."** The screen from session 40's measurement is built and has run
against a real provider. And the day's other half was the D-77 gate turned on fourteen
commits of my own work, which produced **17 findings and not one false positive**.

**The screen works, and better than the numbers predicted.** Three deterministic
narrowings had all plateaued at about a fifth of survivors not being rules, so the
cheapest tier is now asked, once per document, *which of these are NOT rules*. First real
run on this repository: **52 kept, 15 refused, and every refusal correct on inspection**
— including the three I had marked "marginal" and one from prose I had written an hour
earlier. Junk share 20% → 6%. It only removes; a refusal is written as a knowledge row
born retired carrying the model's reason, so *"why is that rule absent"* is answerable;
and when it cannot run every candidate is kept and stamped so the next ingest retries.

**Surprised me: the refusal rate is a drift metric on our own writing.** Per document,
`CLAUDE.md` and `PROG.md` were refused **0 of 13**. Every refusal came from the
explanatory specs, and the worst three were the three I had edited most that day.
`CLAUDE.md` says specs describe the system as it stands and change-narrative belongs in
here — so the screen is mechanically detecting where I broke that rule. Not what it was
built for, and more useful than what it was built for.

**The gate found things reading would not have.** Four of the seventeen were false claims
in client-facing text: `check_back_after_ms` pooled across every repository while the note
said "measured on this repository"; `Pace.runs` reporting the full sample while the median
came from a shrinking subset, growing more confident-looking as the evidence thinned;
`review_cancel` inheriting a fallback that would hand back an unrelated round's transport
error as a person's stated reason. And twice it caught **my own fix left half done** — the
elapsed stamp moved, but `roundStartedAt` still answered with any open run; and the screen
versioned, but the sentence explaining it describing the measurement as it was before.

**What I got wrong about the loop, for three reviews.** I fixed findings and expected
silence to settle them. It does not: D-56 requires the code the finding NAMED to have
moved, and a fix that correctly lands in a collaborator leaves that line untouched. The
author's move is a justification at the site, and I did not reach for one until the third
review. Every miss cost a full t2 round. The mechanism was there the whole time and the
finding's own `asks` line says it — *"Fix this, or tell me why it is not a problem"*.

**Measured, because the flow question deserves numbers: 8 t2 calls, 112 minutes of deep
tier, 9 rounds, 17 findings.** The cost is dominated by round-trips, not round length. So
the two things worth building are the ones that remove a round-trip — submit-time settle
feedback, which lore can compute for free the instant a patch applies, and a bound that
counts rounds which settled NOTHING rather than rounds. Both are in `TODO.md` with the
evidence; the second changes quota and is Vany's.

**The bound killed two converging reviews.** 13 findings settling 11, then 6 settling 5,
per-round counts falling to one — and any single fresh finding in a fourth t2 round ends
it. `core/ladder.ts` already learned this lesson once, for clean rounds, and the comment
recording it is three lines above the counter that has not learned it yet.

**The screen's cost, measured 2026-08-07 once `usage` finally recorded it**: 12 calls,
**24s average and 99s worst**, 70,800 fresh input tokens against 132,096 cached (a 65%
hit, so the repeated prompt is doing its job), 14,948 out, $0 under the subscription.
Against the same day's review tiers — t2 156 minutes, t1 38, t3 27 — the screen is about
**five minutes of 221, near enough 2%**. That is the half of D-81's `[OPEN]` about cost;
the other half, whether it removes the right fifth, came out 15 refusals of 15 correct
with three mechanical misses left. `SPEC.md` still says the screen is unmeasured and is
now stale in our favour — to be closed with the next change that fires a review.

**Ended `passed`, and the attestation is the interesting part**: *"2 tiers (t0, t3) — 2
earlier tier(s) read an earlier tree and did not re-read this one, so this is PARTIAL,
4 findings, 4 fixed"*. Under the revised D-6 a closed tier stays closed, so t1 and t2
cleared an earlier tree and never saw the final one. The attestation distinguishes tiers
that RAN from tiers that read the SIGNED tree, and signs only the second. Nobody had to
decide that today; the machinery said it.

**Also today**: tokens for `koray` and `max` on `rigid-monorepo`, and `LORE_BIND` moved to
`0.0.0.0` on Vany's call — so the tokens are the perimeter now, and D-78 stopped being
hypothetical. `rigid-monorepo` reached **117 verdicts** against the zero that `TODO.md`
still called "the whole story", and `epic/RIGID-4-m1-managed` — five identical failures
across two days — reached `passed`.

---

## 2026-08-07 — session 40: the product was full of quotations

**Vany, after I answered a hygiene question twice: "meditate over all of the code, i
believe you can see opportunity for significant improvement."** He was right and I had
been looking in the wrong place.

**423 live knowledge rows. Nine written as rules.** The other 414 were sentences copied
out of prose composed for a different reader — `extractRules` lifting them from spec
paragraphs, and accepted `lore-ok` reasons filed verbatim as facts about the codebase.
92% had no `why`, while `TOOL_DOCS.teach` tells every client that a rule without one gets
deleted by the next reader.

And up to sixty of them entered every review prompt, every round, under *"treat these as
this team's decisions"*. 218 of 399 came from lore's own docs. So three frontier models
were being handed fragments of lore's incident diary — *"It has to be, because the secret
is shown once"* — and told they were binding.

**The measurement that located it:** 97% of SPEC.md's extracted rules came from
paragraphs, not bullets. SPEC.md is 1,700 lines of decision *narrative*, and every
incident story is full of "must", "never", "always" describing what went wrong. PROG.md
was the counter-example — a real rule list — and every one of its ten reads like a rule.

**What changed.** Bullets and single-sentence paragraphs only; dangling referents and
mid-sentence starts refused; accepted justifications no longer filed as rules. 218 → 66
for this repository, 111 → 15 for SPEC.md, PROG.md's ten untouched.

**The durable half is the extractor stamp.** `source_blob` enforced *a rule must not
outlive its text*. Nothing enforced *nor the reader that produced it* — so narrowing the
extractor would have left all 399 fragments live, because re-ingestion triggers on the
document and no document had changed. That is the identical trap MEMO records from
session 32, where a fixed ingester left every row written by the broken one. Now the
version is stamped and an older stamp retires the row; `ingestDocs` runs on every review,
so the store heals on the next one with no manual migration.

**Two things I got wrong on the way, both caught by measurement rather than by care.**
The first attempt kept paragraphs under a rule-ish heading and changed nothing — SPEC.md's
`## 5. Decisions` spans 1,800 lines, so the whole narrative was under a decision heading.
And the `.db` check I wrote an hour earlier reported seven leak sites where there are
twenty-eight: it matched `.db.prepare` on ONE LINE, and the formatter puts `store.db` and
`.prepare(` on separate ones. That check was written, and its invariant claimed, one file
away from a query it could not see.

**Why nobody had seen the real thing.** Eleven folders of models read `src/` in the
propose sweep and not one opened the database, because I pointed them at the code. I
measured the machine and never looked at what it produces. `refactor.md` is a document
about a program; the program's product is a table.

---

## 2026-08-07 — session 39: measured before refactoring, and the refactor mostly evaporated

**Vany: "analyze our code, repay technical debts and plan amazing refactoring… state of
the art."** Almost word for word what he asked in session 34, where I measured, argued
against a large refactor, and he agreed. So the question was whether the answer still
holds after tonight, which added `propose`, subscriptions, `pace`, and schema 9.

**It holds, and here are today's numbers.** 15,437 source lines across 56 files, 9,417
test lines across 40, 745 tests. **Zero `as any`, zero `@ts-ignore`, zero
`eslint-disable`** — the four the grep found are the phrase "as any" in prose. Zero
unresolved TODO/FIXME markers in code. **Zero dead exports**, checked by scanning every
exported function for a second reference.

**The one measured debt was real, and far smaller than it was sold as.** `refactor.md`'s
biggest proposal was *make `Store.db` private*, and it named 26 files. That count
included tests. In production it was **seven `.db.prepare` calls across five files**, and
every one was a small missing Store method. All seven are now behind named methods and
the count is zero.

**Two of the seven were worse than a style problem.** `lore://review/{id}` built its
audit trail with `SELECT *` on `verdict` and `tier_run`, so the client-facing shape of
that resource was a function of the schema: every column a future migration adds would
have shipped to every client, silently, without anyone deciding to publish it. The
columns are named now, which makes adding one an act rather than a consequence.

**And `store.ts` is not the god object it looks like.** 1,474 lines, of which **582 are
comments** — 40%. About 890 lines of code across 104 methods: roughly eight lines each.
That is a wide, thin data-access layer with dense documentation, which is exactly what
`PROG.md` asks for. Splitting it would move a hundred small methods and every incident
comment bound to them, to make two files that are each still a data-access layer.

**A mechanical check now holds the line**, in `one-definition.test.ts`, because this
codebase's own argument is that reading for a shape does not work — seven of these grew
one at a time and nobody noticed. Tests are deliberately exempt: a test asserting a row
exists is asking about the database on purpose, and forcing those through an API would
mean inventing methods only tests call, which the same file already fails you for.

**What I did NOT do, and this is the position.** Nineteen seam proposals remain
unappraised in `refactor.md` — extract a health snapshot, a knowledge compiler, port
`ProposeDeps` off `Store`. None fixes anything currently wrong. Every one moves code
whose guards are comments bound to positions in that code, and this project's defect
history is entirely false statements about behaviour rather than wrong algorithms. A
refactor is how this repository would forget its own bugs. They keep their measurements
and wait for a reason beyond tidiness.

**The real debt is not in the code.** Ten commits have reached `origin/main` without a
ladder verdict, in a project whose entire thesis is that reviews gate code. That is the
thing to repay, and it is a review run rather than a refactor.

---

## 2026-08-07 — session 38: appraising the 32, and what eight of them were worth

**Vany: "implement all useful."** So the appraisal that TODO said had never been done.
Of 32 proposals, **eight were real defects and are now fixed**; the rest were refactors
whose value is unmeasured, and this project's own history says a large refactor severs
guards from the incidents that justify them.

**The five the critic killed by itself** — *"Do not build this"*, *"points at the wrong
seam"*, *"prescribes an unnecessarily expensive cure"* — are the cross-vendor critic
earning its cost. A proposer wrote them; a different vendor read the code and refused to
endorse them. That is the design working, and it is worth more than the eight fixes: a
tool that only agreed with itself would have shipped all five.

**What was actually wrong, in order of how badly it lied:**

- **OSV answers were zipped to questions by POSITION.** A short batch response left the
  trailing components with no result and they were reported CLEAN — in a security
  review, for packages nobody looked at. INV-1 inside the scanner. It now refuses the
  batch and says how many answers it got for how many questions.
- **A crashed round left its `tier_run` open for ever.** `finished_at IS NULL` is the
  signal for *a tier is working*, and the reclaim fixed the queue while leaving that row
  lying, so the operator view showed a tier still running weeks later.
- **And left its review `running` for ever.** Nothing would claim that job again, so the
  review sat until the 48h sweep called it `expired` — which says nobody came back, and
  that is false: the ladder died. Now `failed`, with a reason naming the host.
- **Worker loops died silently.** `isDraining()` and `claimJob()` sat outside the
  per-job guard, and `void Promise.allSettled(loops)` discarded the rejection — so a
  store fault took the service's capacity from N to N-1 to zero while `/healthz`
  answered ok. A service that has stopped working and says it is fine. It survives the
  fault now, and an ending pages.
- **`review_submit` refused a patch it had already applied**, telling the client
  *"Nothing was reviewed"* — true of the review, false of the worktree — so the re-send
  it asked for landed on a base that had silently moved. `restoreTree` puts it back,
  and deliberately not with `reset --hard`, which would throw away every earlier
  accepted round with the failed one.
- **Document ingestion retired the old rules and inserted the new ones outside a
  transaction.** Between them the repository believes the document says nothing, and it
  does not heal: re-ingestion triggers on the blob changing, and the blob is already
  recorded as seen.
- **The T0 install lock covered the writer and not the readers.** `tsc` and `eslint` ran
  outside it against the shared `node_modules` the next review was free to rewrite — the
  race the lock exists to prevent, moved one step later. Cost of extending it: T0 runs
  5–11s here and the lock is per lockfile hash.
- **`upsertRepo` was check-then-act with no constraint.** Two provisions of one
  repository both insert, and then tokens, reviews and knowledge split across two rows.
  A unique index makes it impossible rather than unlikely.

**What I did not take, and why.** Ten proposals were seam work — make `Store.db`
private, extract a health snapshot, a knowledge compiler, port `ProposeDeps` off
`Store`. Several are probably right. None of them fixes anything that is currently
wrong, all of them move code that carries its incidents in comments bound to position,
and the measurement each one offers is about structure rather than behaviour. They stay
in `refactor.md`, which is the correct place for an idea nobody has needed yet.

**The honest score for `propose`: 8 defects and 5 self-rejections out of 32 for 88
sessions.** That is worth the quota — but the number that matters is that four of the
eight were INV-1 shaped, in a codebase whose whole discipline is INV-1, found by models
reading it cold.

---

## 2026-08-07 — session 37: propose ran, and the first thing it found was itself

**88 sessions across the eleven folders of `src/`**, four lenses each, every proposal
challenged by a critic from another vendor. 32 survived to `Appraise these`. Vany's call
on the spend — I argued for one folder first and he reaffirmed all eleven.

**The tool's first useful act was to fault its own code.** Reading `src/propose`, it
found the filename collision I had fixed by hand an hour earlier — independently — and
then went further than I had: `spec/propose.md` §1 promised `YYYY-MM-DD-<n>.md` while
the code shipped `<sha>`. I wrote both the spec and the code that night and did not see
it.

It also found a real defect: the budget guard checked `sessionsSpent`, which is
incremented only AFTER a successful `ask`. A session that opens, sends a prompt, burns
tokens and then throws never incremented it — so a run where every call failed never
tripped the ceiling and attempted every lens anyway. The operator's stated budget did
not exist on the failure path. That is a guard whose silence is ambiguous, which is the
shape PROG.md already names, in a guard written to enforce a spend limit.

**Two faults in the tool, both measured rather than imagined:**

- **Four proposals named files that do not exist** — `src/knowledge/compiler.ts`,
  `src/ops/health.ts`, `src/mcp/submit.ts` and its test. The scope rule passed them
  because one named path WAS real and inside the folder, so an invented sibling rides in
  on a genuine one. `touches` is now checked against the worktree that was read: every
  path imaginary is a drop, some imaginary is an annotation, and the reader is told
  which. A path in a proposal was a claim until something checked it.
- **The knowledge screen called almost everything a decision-against.** The classifier
  matched `do not` and `don't` — and nearly every rule in a codebase is a prohibition
  ("reviewers do not write to the repo"), so the whole knowledge base read as decisions
  this project had made against things. Any idea sharing words with one was reported as
  already rejected. That is the expensive direction of that filter: a false match hides
  a new idea behind an old decision and the reader never learns what they were not shown.
  Both the classifier and `restates` are tightened, with the real cases as tests — a
  four-term statement can no longer identify anything, because "The prompts do not ask
  for that, and the output shows it" reduces to four terms and three of them turned up
  in an unrelated paragraph about a budget guard.

**What has NOT been measured, and it is the whole question:** whether the 32 ideas are
any good. `spec/propose.md` §9 says the failure mode of this tool is its reader. The
cheap test is in TODO: take each `Settled by` line and run it, and count how many die in
ten minutes.

---

## 2026-08-07 — what went to `origin/main` without a passing ladder

**Stated because D-77 says a skipped review is stated, never silent.** Seven commits
were pushed on Vany's call:

- `87bce25` (D-80, subscriptions) — reviewed hard: two reviews, 13 findings, every one
  answered. It ended `failed` on the per-tier bound, not `passed`. The commit's tree is
  byte-identical to `9b80270f`, the last tree the ladder actually read, so what went out
  is what was reviewed — it simply never got a verdict.
- The six after it — the D-6 revision, the two D-79 prompt changes, `lore propose`, and
  the comment sweep — **no ladder has read at all.**

Why the review ran out of road rather than finding something: the per-tier bound stopped
it at round 12 with `t1×6, t2×5, t3×1`, and five of those t1 rounds were the D-6 reset
re-checking fixes — the very thing the commits behind it delete. Under the new rules the
same work is three rounds.

**So the honest next action is one fresh review of the pushed tree**, not a fourth
attempt at the old one. It is the first real test of both changes at once: closed tiers
staying closed, and a re-read being told it is a re-read.

---

## 2026-08-07 — session 36: the client cannot be woken, so make leaving cheap

**Measured what session 35 assumed.** Claude Code parses lore's `resources.subscribe:
true`, records it, and gives the model **no verb that can send `subscriptions/listen`**.
The negotiated protocol revision is moot: there is nothing to reach the method with on
either era.

The evidence had been in my hands the whole previous session. `subscribe.test.ts` is
driven by a hand-built SDK client *because my own harness offers no other way to open
that stream* — I wrote that test, noticed nothing, and then wrote `research/…` §5 saying
"establish what the client does by pointing one at it, not by reasoning". Then reasoned
about it for six hours. Same failure as the `.mcp.json` that could never be pasted,
committed inside the warning about it.

**And the deeper reason it stays true: an agent client is not a process.** It exists
inside a turn; between turns there is no recipient for a notification. Even with the
verb, a harness would have to convert a notification into a new turn — machinery lore
cannot reach. So the job is not "wake the client". It is **make leaving cheap, and make
"when to come back" a measured answer.**

**Three changes follow, and the first is the one that was actually costing money.**

- **The backoff loop is gone.** Seven strings said *"poll again in 10s, backing off to
  60s"*. Measured medians on this deployment: t1 **323s** (n=106), t2 **820s** (n=38).
  So the shipped instruction was seven to fifteen calls that could not possibly return
  anything, each one a turn for an agent. `src/mcp/docs.test.ts` now fails the suite if
  any document names a fixed interval again.
- **`check_back_after_ms`, from `usage.latency_ms`.** The median completed round of the
  tier the ladder is on, returned by `review_start` and `review_poll` while waiting is
  the right move — never in `findings_ready`, where an interval would read as permission
  to sleep on findings that are already the client's problem. This is NOT the progress
  estimate SPEC refuses: "how far along" stays unanswerable; "nothing can have happened
  before this tier's median" is a fact about the tier. It **refuses** below 20 runs or a
  p90/p10 spread over 6 — t3 is the live example at n=12 across 126s–1691s, two
  populations pooled — and excludes failed runs, which measure how fast a tier can die.
- **`review_inbox` is step 0 of every loop.** The real async surface, and it was already
  built. A session ends and takes its subscription with it; the review does not end with
  it. D-70 measured abandonment as the dominant cause of wasted reviews, and no
  notification can reach a client that has gone — so the only thing that closes the loop
  is the next session asking what is waiting. A mechanical test asserts both loop
  documents name it before `review_start`.

**Rejected: long-poll `review_poll(wait_ms)`.** Suggested, and it does not survive the
arithmetic. An agent blocked in a 45s tool call is idle, not free, and 45s against t2's
820s median is eighteen calls instead of fifteen. It only wins if the wait can approach
the real latency, and the client timeout forbids that.

**Also rejected: a `lore watch <id>` CLI** that blocks and exits on a state change, run
as a background task so the harness's own wake fires. It would work — for a client that
shares a host with lore. That is exactly the assumption D-65 was written to destroy.

**Measured, and it changes a documentation obligation.** `ListMcpResourcesTool` against
lore returns the five `lore://docs/*` and **neither template**. `resources/templates/list`
is a separate call this client never makes, so `lore://review/{review_id}` — the resource
the whole subscription design points at — is readable if you construct the URI and
invisible if you list. Every text expecting a client to read it must spell the URI out.

**And then Vany retired D-6.** *"If a level is closed, it is closed finally, you will
return there only in the next review… it is submitted, it is reviewed by the model ASAP
and you can go next."* He is right, and the argument is stronger than the cost one he
gave: `settle()` runs on whichever tier the round is on, so **after a reset the cheapest
model ruled on justifications for findings the dearest had raised** — four times in this
evening's own review, t1 coming back "clean" and closing t2's questions. D-10 says the
reviewer rules on the answer; the reset had been quietly handing that to a model which
never asked.

The cost side is real too: every deep finding bought two rounds, five findings cost nine
rounds, and two reviews died on the per-tier bound that way.

**What it costs, and this is the part that needed building rather than deciding.** The
tiers below no longer read the last diff, so `passed` is a narrower claim than it was.
T0 still runs every round — `tsc`, `semgrep`, the tests see every fix — but a weaker
model's second opinion on the final tree is gone. That makes the attestation's "3 tiers"
a lie the day it ships, because it counts every tier that ever ran. So `tier_run` now
records the tree each run actually read, and the signed line names the tiers that read
the tree being signed, with the earlier ones called out rather than silently dropped.
Schema 9.

**What it does NOT fix**, and I said so before writing it: the bound is per tier, so a
prose loop still stops at the same place, just sooner in round count. Cheaper, same wall.

**And t3 gave D-79 its first measurement, by failing its own bar.** Vany asked the
right question — *"was the finding from t3 useful?"* — and the answer is no, with a
number attached. t3 asked the thing only the ticket makes possible, read the diff's own
paragraph saying half the ask was deliberately unbuilt, cited that paragraph as its
evidence, and raised it as `medium`. Nothing changed; the reset it triggered ate the
last three rounds of the global budget; without it the review passed at round 10 and
with it it stops at 13.

So: the *question* is worth paying for — an undisclosed gap would have been the finding
of the night, and a reviewer must look because it cannot know in advance which kind it
is. The *finding* was not: the check ran and the model ignored its own answer. A third
test now says so in `BAR`, and a disclosure that is itself false stays a finding.

My first draft of that paragraph told the model to put the observation under a `notes`
field. There is no `notes` field. I invented output surface inside the fix for
inventing-things drift, in the same hour I fixed five instances of it elsewhere.

**Then Vany asked to rethink the prompts, and classifying the evidence found the real
one.** Eighteen findings across two reviews of one commit: the FIRST pass over new code
produced 8 findings, all 8 real defects — an authorization hole, a one-way door latent
for weeks, a publish-before-write, a sweep that woke nobody, two racy tests. The passes
over my fixes produced 10: one real defect, eight documentation drift, one non-finding.

So the prompts were not broken; something changed between round 1 and round 11. It was
this: **`position()` keyed on the tier alone, so every round was described as a first
look.** Round 11's t1 was told *"You are the FIRST model to see this change"* having
cleared that tree four times. Told it is first, a model re-audits — and a tree whose only
new material is my comments offers comments. Five such re-reads: 245s, 439s, 252s, 263s,
491s. 28 minutes, 37% of the review, zero findings.

Fixed by passing `round` and `tierRounds` and giving a re-read its own instruction: judge
the AUTHOR'S ANSWER, not the tree you already cleared. Carefully not a licence to skim —
the racy-revocation-test finding came from exactly such a re-read and was real.

Second change: the prompt now states the composition of the diff when ≥75% of added
lines are prose. Not to suppress documentation findings, which catch our most common real
defect, but because a reviewer cannot otherwise tell "the author rewrote a comment" from
"the author changed the system", and in that shape of diff it must name a reader who acts
wrongly.

**Then `lore propose` got built, because "improve code" needed somewhere to live.**
Vany: *"let's add new functionality, review, analyze, suggest refactor, significantly
magically improve, beautify piece of code."* Asked to choose the shape, he took the
conservative option on every axis — *"output is idea, that will be implemented by the
caller"*, *"but keep the overall functionality"* — which is D-75 as already specced,
plus `--folder`, `--commit` (head of `master`) and `--mode`.

Two decisions I would not have got right without stating them first:

- **The folder is the SUBJECT, not the boundary.** A proposer reads outward — callers,
  dependants, the specs that govern the code — because a proposal about a folder made
  without reading its callers is a proposal about code nobody uses. But the change must
  land inside or the idea is dropped with its reason. Without that rule, a folder-scoped
  run silently becomes another whole-repo run costing the same and answering a question
  nobody asked, which is exactly what a model does unprompted.
- **`preserves` is what makes it a refactor tool.** Every proposal states what must keep
  working identically and how a person would check. A model asked to improve something
  will, given room, improve what it is FOR, and an idea that quietly changes behaviour is
  not a better version of this code — it is different code wearing its name.

**The one piece of real surgery: `conductSession` now takes its extractor.** It baked in
the FINDING extractor along with the retry-carrying-what-was-wrong, the both-replies-
logged-on-double-failure, and the abort-so-a-failure-stops-the-spend. Every one of those
was fixed here one incident at a time, and a second hand-written copy for proposals would
have regrown all of them. Generalised instead, with `extractFindings` kept as a thin
adapter so the whole ladder still reads `findings`.

**Argued against, and not built: a suggestion channel.** Vany's goal was "find errors and
improve code, if we can", and the temptation is to add advice to findings. A finding's
whole value is that it demands an answer; a suggestion demands nothing, gets skimmed, and
teaches people to skim findings too. I had proved that an hour earlier by inventing
`notes`. "Improve code" belongs in `lore propose` (D-75) — specced, unbuilt, on demand —
and it is gated on quota because it calls the largest models by design.

**The subscription surface stays exactly as built.** Correct, tested, free to keep, ready
the day a harness wires notifications to turns. What it no longer does is open a
permanently-resident tool description with an instruction the only real client cannot
execute.

---

## 2026-08-06 — session 35: the server can wake the client, and mostly won't be asked to

**Built the subscription half of D-80.** `subscriptions/listen` on
`lore://review/{review_id}`, woken by every state change and by nothing else. Eight
tests in `src/service/subscribe.test.ts` drive it with a real MCP client end to end.

**The design decision that made it small: publish from the store, not from the callers.**
`updateReview` has ten call sites and `recordFinding` two. A hand-maintained list of
places to publish from is the shape that has produced a missing case here every single
time, so `Store.events` is a late-bound field and the two mutations publish. The worker
publishes nothing and knows nothing about MCP.

**What surprised me, and it reshapes the decision: the era is opt-in on the client.**
`subscriptions/listen` exists only on a 2026-07-28 connection, and
`@modelcontextprotocol/client` defaults to `versionNegotiation: 'legacy'`. My first test
run connected with the defaults and `listen()` threw *"requires a 2026-07-28-era
connection (negotiated: 2025-11-25)"* — while the server was advertising
`resources.subscribe` and serving the modern era perfectly well. So the feature works and
almost no client will reach it. Polling is not the fallback for stragglers; it is what
every unconfigured client does. `research/mcp-subscriptions.md` §4.

Two smaller traps in the same area, both of which fail *silently*:

- **`registerResource` advertises `listChanged`, never `subscribe`.** Without the
  explicit capability the listen router accepts the subscription, acknowledges it with
  an empty filter, and never delivers anything. Accepted and silent forever — the exact
  failure this project is named after. The test asserts the honoured filter, not just
  that `listen()` resolved.
- **`LATEST_PROTOCOL_VERSION` is `2025-11-25`.** The modern revision is a separate
  constant. Reading that name as "newest thing the SDK speaks" is wrong.

**One handler for the process, servers still per request.** The listen router lives in
the handler, so a handler per request would kill the stream with the exchange that opened
it. `createMcpHandler`'s factory closes over the principal from `req.auth`, so the D-23
guarantee is untouched: an instance is still built for exactly one principal. `token: ""`
in that `AuthInfo` is deliberate — the field is required, nothing downstream needs the
secret, and a credential copied into a pass-through struct is a credential in every stack
trace that struct appears in.

**Retired a sentence that had been load-bearing in three files.** *"MCP servers cannot
initiate requests"* justified polling in `SPEC.md` §2, D-41/42 and `worker.ts`. It is true
about *requests* and was carrying an argument about *notifications*. D-41's two-channel
split survives on its own merit — waking a client is not the same as declaring something
urgent — but it is now a decision rather than a constraint.

**Did not start the conversation half of D-80.** Two `[OPEN]` questions still gate it:
whether a long conversation beats repeated cold rounds on cost (measured, not argued),
and how the deep tiers enter a conversation the cheap tier has been having. D-55 stands
until then.

**Then D-77 ran on it, and this is the part worth reading.** Nine rounds, t1×5 t2×4,
eight findings raised and settled. What the ladder found in my own subscription code:

- **The listen router authorizes NOTHING.** t2 read my own comment about the capability
  bit and drew the conclusion I had not: `resources.subscribe` is declared once for the
  server, so any authenticated client could subscribe to somebody else's review id and
  be woken by it — an existence-and-activity oracle for exactly the thing `mine()`
  answers NOT FOUND to (D-23). And a stream outlived the revocation of the token that
  opened it, making `make revoke` a false statement. Fixed with a `ScopedEventBus`
  filtering per event on owner and token liveness; the identity reaches it through an
  `AsyncLocalStorage`, because the SDK hands the bus a bare callback.
- **My own negative test was a race**, in a file whose header says negative tests must
  not be races. And when I rewrote it I got it wrong again: I used the OTHER client's
  arrival as the ordering barrier, which orders nothing across two sockets — it passed
  against the unfixed code, which is how I caught it.
- **`updateReview` published BEFORE the write**, under a comment saying it published
  after. The defect class this repository is worst at, inside the feature meant to keep
  clients informed.
- **The expiry sweep wrote `state` with its own SQL**, so the one state change a
  waiting client most needs woke nobody. My own comment predicting exactly this sat in
  a file I never opened.
- **A wake per finding, and a wake per no-op write.** Both fixed by narrowing the rule
  to one sentence: a wake means the review's STATE changed. Findings arrive in a burst
  and the client cannot act on one mid-round anyway (D-55); a round boundary rewrites
  `running` over `running` twice per tier.
- **`knowledge_escalate` was a one-way door.** `resolveConflict` matched only `open`, so
  the state a person is called to settle was the one state nothing could settle. Latent
  for weeks; my new resume gate turned it into a review that could never resume.

**And the review itself failed, correctly and uselessly.** Round nine hit the per-tier
bound, which is a real terminal answer — and `failed_because` said *"no reason was
recorded, which is itself a defect"*, because `failureReason` read only `job.last_error`
and a ladder-stopped review leaves every job `done`. The cause was known exactly and
thrown away. Now recorded on the review, with the instruction that actually ends it:
answer minimally.

**The loop that got me there is the one MEMO already recorded once**: every fix to a
prose finding writes new prose for the next round to fault. Five rounds of it last
session, nine this time. The per-tier bound is what stops it, and it is doing its job —
what is missing is not a bigger bound but shorter answers.

**Dogfooding note.** The subscription was watched live against the deployed service
throughout, with a pinned 2026-07-28 client. It works; it also woke three times in one
millisecond at every round boundary, which is what led to the two narrowing findings.

---

## 2026-08-06 — session 34: the refactor I argued against, and the debt underneath it

**Vany asked me to plan a huge refactoring toward "state of the art". I argued
against it and he agreed, then asked for the debt instead.** The measurement is what
settled it: 11,560 lines, 47 modules, ~250 lines a file, four runtime dependencies,
**zero `as any`, zero `@ts-ignore`, zero `eslint-disable`**, strict TS with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. There was no debt of the
kind a refactor pays off.

**The argument that mattered was about the comments.** 2,015 comment lines, and
PROG.md's rule is that each guard carries the incident it guards against. That
knowledge is bound to *positions in the code*, and moving code is the most effective
way to sever a guard from its incident — after which "a guard without a reason gets
deleted by the next reader". A large refactor is how this project would forget its own
bugs. Set against a defect history where every entry was a false statement about a
failure rather than a wrong algorithm, the trade is bad.

**What the sweep actually found, and the shape is the same one every time: something
claimed and not true.**

- **Three of nine devops alerts had no caller** — the replica, provider auth, ageing
  `needs_human` — while `spec/operations.md` §2.1 listed two of them under *page,
  someone should look now*. The service could not even SEE the replica: only
  litestream mounted that folder. So the page was unbuildable, not merely unbuilt.
- **`/status` reported `ok: true` unconditionally**, including on the beat that paged
  for a critical disk. The comment three lines below it complains that this endpoint
  "said ok: true" while the deployment ran 21 commits behind — that fix added the
  build stamp and left the constant.
- **`queryCommit` had no caller.** Written for Phase 5, tested, never invoked, while
  PLAN names it "needed for submodules" and D-36 says submodules are how we ship. The
  security review enumerated the lockfile and reported clean about a vendored tree it
  never queried. `isStale` from session 19, in the review type whose entire output is
  a claim about what was checked.
- **A token could not be revoked at all.** `revokeToken` wanted the secret, which is
  shown once and never stored — so the operator revoking a leaked or departed
  teammate's token could not supply the one argument it had. `make tokens` printed a
  `revoked_at` column nothing on earth could set.

**Learned — a mechanical check inherits the shape of the question it asks.**
`one-definition.test.ts` exists precisely to catch declared-but-unreachable things,
and it passed for the whole life of three dead alerts, because it asks whether the
exported CONTAINER has a reader and `CONDITIONS` has three. A routing table is where
this hides: the table being wired reads as the routes being wired. It checks members
now, and I planted a dead one to watch it fail before believing it.

**Learned — `isClean` is the best single example of the one-definition rule.** Its
docstring says it is "the only predicate any caller should use... so there is one
place to be wrong", and every caller wrote `state === "passed"` by hand instead. Four
of them, including both `clean` fields the MCP surface hands a client — the single
value a client decides to merge on. The one place to be wrong was five. And
`passed_partial` has already been omitted from a hand-written state list three times
in this codebase; in that field it would read as clean.

**The sweep also condemned something innocent, which is worth recording.** My probe
flagged `SECURITY`, `loadOrCreateKey` and `mintToken` as dead. They are not — they are
used inside their own files, and `SECURITY` is reachable through the type registry. I
checked before deleting. The real finding underneath was that the second review type
had **no test at all**: nothing asserted that `type: "security"` resolves, selects
sbom/osv rather than tsc, or refuses an unknown id instead of falling through to the
default. `type` has been in the MCP surface since day one (D-43) with nothing pinning
what it selects.

**Method note.** Ten minutes of `wc -l`, a 20-line export-reachability script and one
SQLite query found more than reading the code would have. The same lesson as sessions
19, 20 and 27 in a new place — but the version worth keeping is narrower: **I cannot
find "declared and unreachable" by reading, and I have now failed at it four times.**

**Then the four open TODO items, and two of them were monitors that could not see the
thing they guard.**

- **The provider got its own bound.** `LORE_CONCURRENCY` governed both halves of a
  round — a remote call that merely waits, and a local sandbox that is CPU-bound — so
  it was always set for T0 and the provider inherited whatever fell out. At 12 that
  killed four reviews in 2.5 minutes while the host was fine.
  `LORE_MODEL_CONCURRENCY` defaults to 4, and work above it **queues rather than
  failing**, which is backpressure's argument. Two details I would have got wrong
  without thinking: the gate wraps the SESSION, because what loads a provider is the
  agentic exploration between prompt and reply — gating HTTP calls would bound
  nothing; and one `Reviewer` is shared by every worker loop, or each gets its own
  gate and the limit multiplies by the worker count, reading as 4 and behaving as 48.
- **`backup-check` never asked whether the database was readable.** It compared
  timestamps, so through the whole corruption it reported healthy. A replica perfectly
  level with an unreadable file is a faithful copy of nothing.
- **The stale-review refusal** named an id worth continuing, gave a condition
  (`if the branch was rebased`) that did not apply, and left `restart: true` looking
  unavailable — on a review twenty hours and twenty-five commits old.
- **A client could not submit.** `git apply --recount` fixes the dropped trailing
  whitespace line, and every failure message now names the fault rather than a
  position in a string the client composed and cannot open.

**Learned — my own test fixture was wrong in exactly the way the bug was about.** The
file's last line is a single space, so its diff context line needs TWO — one marker,
one of content. I wrote one, the patch legitimately did not apply, and for a moment I
thought the fix was broken. The bug and my reproduction of it had the same root, which
is the most persuasive evidence I have that the fix is aimed at the right thing.

**Learned — being lenient is safe when something downstream is strict.** `--recount`
guesses at hunk arithmetic, which would normally be exactly the sort of quiet
approximation this project refuses. It is fine here *only* because `review_submit`
hashes the resulting tree against the client's `tree_hash` (D-40), so a wrong guess
fails loudly one step later. There is a test pinning that the recounted tree equals
the well-formed one, because that argument is the whole licence.

**Did NOT do, deliberately: the retry asymmetry.** `socket hang up` is still not
retried while an unparseable reply gets one, which is backwards. Left alone because a
retry spends another call — a quota decision, and Vany's — and because the gate should
remove most transport drops at source. Changing two things at once would leave neither
measured.

---

## 2026-08-06 — session 33: the loop closed, and then ate itself

**The good half, and it is real.** A review of `rigid-monorepo` reached round 2 with
all five findings settled — three fixed, two justified — and the deep tier ran on that
repo for the first time. Two of its catches were cross-file contradictions between code
and committed prose governing a GDPR position: the class no linter, type checker or
test can reach. The client's own report says it *"found what nothing else did"*.

**The uncomfortable half.** Almost nothing today was found by lore reviewing itself. The
client found four defects by using it; I found the rest by reading. For a tool whose
whole thesis is that review catches what CI cannot, that is worth sitting with.

**The livelock, and why it is the most instructive bug so far.** We tell clients to
write `lore-ok` AT THE SITE. The scope deciding whether a justification survives was the
hunk around that same line. So the reason lived inside the code it depended on staying
stable, and writing it down was itself a change to that code. One semgrep false
positive — in a file the branch never touched — was justified and expired four times
across nine rounds, cost 109 minutes of model time, ended on a bound, and re-derived
the same rule every cycle: **21 of that repo's 27 derived rules were one sentence about
one false positive.** The product ate itself.

`spec/knowledge.md` already said *"a justification's scope is taken from the code it
defends, never from wherever the reason is written"*. The rule was right and nothing
made it true. **A rule stated in a spec and not enforced anywhere is a rule that is
false.**

**I built deploy keys and then deleted them the same evening.** A stale mirror was the
top failure cause, so I gave lore its own credential to fetch with. Vany's correction:
this host already authenticates to the forge, so a key for lore is a second secret for
a fetch that is already possible. **What was broken was never the credential — it was
that refreshing had been made a person''s job.** A host timer does it now. The lesson is
that I reached for the mechanism before finishing the diagnosis.

**Learned — a heuristic that escalates to a human must fail quiet, not loud.** The first
`needs_human` in production was wrong: two ADR sentences restating one constraint,
recorded as a contradiction because `polarity()` cancelled negations across a whole
sentence. It stopped a review whose findings were all settled. A missed conflict leaves
a rule to be caught later; a false one demands a person.

**Learned — derivation without a verdict runs backwards.** Recurrence was counted with
no reference to how the finding was answered, so a pattern the team ruled out 73 times
derived *"check for it explicitly"* into every future prompt. Seven such rules existed;
not one was backed by a single `fixed`. The client named it exactly: *correct reasoning,
wrong conclusion — what recurs is the false positive.*

**Learned — I cannot find "defined twice" by reading.** I introduced `TERMINAL_SQL` to
fix three copies of the terminal-state list, declared it done, and found two more the
next day, then a sixth the moment a grep-shaped test ran. That is now
`one-definition.test.ts`, along with a check for exported constants nothing reads.

**Taught lore five of these shapes.** It had ONE taught fact in its entire history —
the mechanism the product exists for, essentially unused, while `knowledge_teach` sat
there.

**My own failures today, both the same shape.** I committed a broken build: unescaped
backticks in a template literal took out three test files by parse failure, 487 tests
reading as 388, and I missed it because piping `vitest` into `tail` masks the exit code
so `&&` saw *tail* succeed. Then the same character bit the commit message, where
backticks inside a double-quoted shell string get command-substituted. Gate on
`tsc --noEmit`; write commit bodies from a heredoc.

**Kimi arrived, and the ladder finally has one vendor per tier.** T1 Z.ai, T2
Moonshot `k3`, T3 OpenAI. Until today T1 and T2 were both Z.ai — nothing reported
falsely, since D-49's check fires only when EVERY tier shares a vendor, but two thirds
of the ladder shared a blind spot while the table said "three vendors".

**Learned — read model ids from the provider, never from the name.** `k3` carries 1M
tokens of context and `k3-256k` carries 262k: the suffix names the SMALLER variant. Our
largest review has sent 204,609 tokens, which is 78% of the smaller window. Picking on
the name would have picked the one that runs out, and I nearly did.

**Being a client for an hour taught more than reading the code.** I drove a real review
through MCP and hit two failures no test covers: a diff whose LAST line is whitespace
comes back as `corrupt patch at line 66` — a line number in a string the client itself
composed, which is the least debuggable thing to be told — and sending three of five
changed files got a `tree hash mismatch`, which was the guard working perfectly and the
message being excellent. One message was the best in the system and the other the worst,
in the same session, ten minutes apart.

It also found three more defects in my own work, all the same shape: README explaining
that tests run in the sandbox two paragraphs below the table I had corrected, a spec
section ending in a colon pointing at a list I deleted, and a docstring describing a
regex it was not. **Prose asserting what the code stopped doing is this repository's
most common defect, and I produce it faster than I catch it.**

**Open.** Model calls need a concurrency cap separate from the workers — raising
`LORE_CONCURRENCY` to 12 killed four reviews in 2.5 minutes, and the provider was the
binding constraint rather than the memory or the cache I had worried about.
Reachability-aware severity is still unbuilt and still the client''s best remaining
complaint.

---

## 2026-08-05 — session 32: the first day a client drove it, and everything it broke

**The day in one line.** The loop closed for the first time — a review of
`rigid-monorepo` reached round 2, all five findings settled, first verdicts and first
earned rules on that repo — and almost every defect found today was found *because* a
real client hit it, not because we reasoned about it.

**Measured before changing anything.** 30 reviews, 2 ever `passed`, 11 abandoned in
`findings_ready`, 18 findings never collected, and **zero verdicts on the customer's
repo**. That last number was the whole story: reviews were being run all day and
nothing was being learned. Caching confirmed at 97–99%; INV-1 held in all 15 failures.

**D-65 twice, because I built the wrong thing first.** A stale mirror caused more
failures than every model and transport fault combined, and its instruction — run
`make mirror` on the host — is unfollowable by an agent on another machine. I built
per-repo deploy keys so lore could fetch. Vany's correction was right and simpler:
this host already authenticates to the forge, so a credential for lore is a second
secret for a fetch that is already possible. Reverted it the same evening; a host
timer refreshes the mirrors now. **What was actually broken was never the credential
— it was that refreshing had been made a person's job.**

**Found while deciding where a key could safely live:** `opencode` runs third-party
models as the *same uid* as `lore` and mounted the whole data directory. Verified
readable from inside it: the attestation signing key, `lore.db`, and a leftover key
from D-62. It mounts `data/repos` only now. That fix outlived the deploy keys that
prompted it.

**The spec promised ADRs and we never opened one.** `discoverable()` returned six root
files; `RULE_DIRS` sat beside it *looking* used, consumed only to scope a rule that
could never be found. `rigid-monorepo` carries 37 ADRs and had **eight** rules. Now
128. This is the single largest improvement to the product today, and it was a
constant nobody branched on.

**And it immediately caused the first `needs_human` in production, wrongly.** Two ADR
sentences restating one constraint were recorded as a contradiction, because
`polarity()` cancelled negations across a whole statement: *"holds no balance and
never calls the ledger"* — two independent negative clauses — came out positive. It
stopped a review whose findings were all settled. Cancellation is per clause now, and
a statement whose clauses disagree is *undecidable* rather than guessed.

**Learned: a heuristic feeding a human escalation must fail quiet, not loud.** A
missed conflict leaves a rule to be caught later. A false one stops a review and
demands a person — and the first time this path ever ran, it was wrong.

**The client's four, all real.** A token scoped per *principal* while tokens are
minted per *repository* — and a workgroup provisions every repo to the same human, so
the check was doing nothing; `needs_human` that named no question, in the inbox, where
a client looks first; pattern findings from files the branch never touched
outranking real spec contradictions. The test named *"binds each token to its own
repo"* asserted the token rows differ and never checked that anything was scoped by
them. **A test named for a property it does not test is worse than no test.**

**Reclamation.** 16 finished reviews still held worktrees because the window was seven
days; the sweep would have leaked git's own records had it ever run, since it deleted
directories with `rm` rather than `git worktree remove`. Setting the window to zero
would have started that leak on the next pass, which is how it was found. Twelve stale
records from a data directory that moved months of reviews ago were collected by a
`git worktree prune` nothing had ever called.

**Two latent bugs, same shape, found by reading:** the terminal states written out by
hand with `passed_partial` left off — so `expireStale` would overwrite a legitimate
partial pass with `expired` after 48h, destroying a verdict, and the sweep would hold
its worktree for ever. There is one `TERMINAL` set now and the SQL derives from it.
**Every time a set of states is spelled out twice in this codebase, the copies have
disagreed.**

**Decided (D-66, D-67).** A rejected finding loses its own line, not the batch — the
argument for all-or-nothing turned on the word *silently*, and discarding everything
drops the same defect plus every valid finding beside it. And severity stays with the
engine: demoting on familiarity would make the second sighting of a real defect report
as less serious than the first.

**My own worst moment.** I committed a broken build — unescaped backticks inside a
template literal took out three test files by parse failure, 487 tests reading as 388
— because I piped `vitest` into `tail`, so `&&` saw *tail* succeed. Sixth time those
backticks have bitten this project. `tsc --noEmit` catches it; that is what to gate on,
and never a pipeline whose last command is a formatter.

**Open.** Reachability-aware severity: the client's argument that a CWE-319 behind
`msw` on a reserved TLD is not a `high` is about *reachability*, which is real and
which semgrep cannot see. Distinct from D-67 and harder; named rather than half-done.

---

## 2026-08-04 — session 31: lore stopped holding keys, and the docs caught up with the code

**Did.** Finished D-63 and wrote it into the specs. lore neither clones nor fetches:
`make mirror` runs on the host under the operator's own agent and lands bare clones
in `data/repos`, which was already mounted. Nothing outside the project is visible to
the container. `ensureBare` now only checks — present, and fetched within
`MAX_MIRROR_AGE_MS` — and refuses loudly with the command that fixes it. Provisioning
issues a token and nothing else. Issued one for `rigid-monorepo`, and a replacement
for `lore` itself.

**D-62 lasted one day.** It made the deploy key actually authenticate; D-63 deleted
the fetch it authenticated. Marked superseded in SPEC rather than removed, because
the finding outlives the fix: it is the clearest case here of a **documented
workflow that had never once run end to end** — `make new`, install the key, review
a private repo. Two repos worked (a public https url and a local path), neither of
which authenticates with anything, so nobody noticed the other two had zero objects.

**Learned — the paste-able config could never have been pasted.** Nine lines whose
entire purpose is to be copied without thought, wrong in three independent and
individually fatal ways since the day they were written: `mcp` for `mcpServers`,
`"type": "remote"` for `"http"`, `{env:LORE_TOKEN}` for `${LORE_TOKEN}`. Nothing
compared it against a config known to work — and one had been sitting in this
repository the whole time, in `.mcp.json`, being used daily.

That is the session-30 lesson again in a new place: not a wrong algorithm, a
confident false statement. It survived because the check nobody runs is the check
against reality, and prose feels exempt from that.

**Two things about verifying it that are worth keeping.**

*Verify the platform, don't recall it.* Rather than trusting that `${VAR}` expands in
`.mcp.json`, I pointed a client at a stub server that logged the header it received:
`Bearer expanded_ok`. `claude mcp get` had shown the header **unexpanded**, which
would have been the wrong conclusion drawn from a real observation.

*Check the probe before believing the probe.* Reintroducing each of the three defects
to confirm the test bites, the third reported *slipped through* — and the test was
fine. My shell loop had a literal backslash in the search string, so the substitution
never applied and I was testing unmodified code. A green "the defect got through" is
as much a false statement about a failure as anything the reviews found; the fix was
to make the substitution assert it changed something.

**Also.** lore's own `.mcp.json` was doubly broken — a token whose repo row the
consolidation had deleted, and a host (`c`) that does not resolve here. Both fixed.
The docs sweep found the tool table in `spec/mcp-api.md` listed **six** tools with
dotted names when ten are registered with underscores, and that `spec/deployment.md`
still demanded an off-device replication target that D-59 had already replaced.

**Retracted mid-session.** I said nothing in the code raised severity on a rejected
justification. It does — `prompts.ts:134` instructs the reviewer to. My grep matched
the docs' wording and not the prompt's, and I stated the conclusion before checking
the one file where the behaviour actually lives.

---

## 2026-08-04 — session 30: the ladder reached the deep tier, and every bug was a lie about a failure

**Did.** Drove lore's own review to the first `t2` run in the project's life, and
fixed what the climb exposed. D-52 (the per-tier cap only bounds rounds that raise
something fresh), the double `closeTierRun`, `cwe: null`, the vitest exclusion's
coupling to one deployment's data path, and the extraction diagnostic.

**Measured.** t1 glm-4.7: 187–591s, 17–37 turns. t2 glm-5.2 at medium: 779s and
1193s, 48 and 68 turns — well inside the 30-minute timeout that high effort blew,
so lowering it was right. Both subscriptions bill $0 through opencode. t3
`openai/gpt-5.6-terra` answers in 2s to a probe but has still never run a review.

**D-51 fired live.** `lore-ok d6d9cd72 (carried) … from an earlier review of this
repo` — a justification ratified in one review inherited by the next, without being
re-argued. That is the product's thesis, observed rather than reasoned.

**Learned — every defect this session was a false statement about a failure.**
Not one was a wrong algorithm. The per-tier cap called a clean, paid-for round
`stopped`. `closeTierRun` overwrote what the tier did with what the ladder decided,
so `make status` painted an answered, clean t1 red. `describeReply` said "malformed
JSON" about JSON that parsed perfectly — the claim was 25 characters over a cap.
And `make status` itself turned a SQLite `disk I/O error` into "not reachable" while
the service was up and answering 401. Four instances of substituting a guess for an
error, in a codebase whose one rule is about exactly that.

**And I did it too, which is the part worth keeping.** I verified a config change
with `npx vitest run … | tail -3 && git commit`. The pipe swallowed the exit status,
`&&` committed anyway, vitest printed nothing because the config no longer parsed,
and I read nothing as nothing-wrong. I shipped a broken suite and a commit message
claiming 261 tests. t2 caught it within minutes — then lore binned the finding over
the claim-length cap. A verification whose result I cannot see has not verified
anything; `2>&1 | tail` is not a check.

**Operational, cost an hour.** Do not run `sqlite3` on the HOST against
`lore/data/lore.db` while the container has it open. It is WAL mode over a Docker
Desktop bind mount, the `-shm` coordination does not cross the VM boundary, and the
container starts getting `SQLITE_IOERR_SHORT_READ` (522). `integrity_check` came
back `ok` and it cleared on its own, but read through `make status` or
`docker compose exec`, not from the host.

**Measured — the deep tier has a diff-size ceiling, and we crossed it.** glm-5.2 at
medium effort reviewed 21–30 KB diffs in 685s, 779s, 935s and 1193s. At **69 KB it
timed out at 1802s**, against the 1800s `longFetch` budget. Nothing was wrong with
the model or the deployment: the review base stayed at `cccc7b2` while 21 commits
accumulated behind it, because I kept reviewing without ever merging. A branch in
real use is reviewed against its merge base and lands. The number worth keeping is
that **t2 at medium is good for roughly 30 KB and dies around 70 KB** — so review
scope, not tier config, is the thing to control.

**t1 replaced mid-session (D-54).** glm-4.7 began answering HTTP 200 with an empty
body — three times, tokens counted, `output: 1` — while glm-5.2 and glm-5-turbo kept
working on the same subscription. `describeReply`, taught hours earlier to separate
empty from prose from rejected, named it correctly on the first try. glm-5-turbo is
faster and cheaper than glm-4.7 was: 271s/13 turns and 162s/11 turns against 500–600s
and 30+ turns, and it found a real defect in the attestation fixtures on its first run.

**A finding in a comment-less file cannot be justified.** `lore-ok` is a comment
marker and JSON has none; the tier schema is `.strict()`, so a smuggled key is a
parse error. c618aec7 was raised against `deploy/tiers.zai-openai.json` and has
nowhere to put its reason, so it can never settle. In TODO with options.

**The ladder converges on code and oscillates on prose, and that is the finding.**
A PR-sized review (31.8 KB, `b819017..main`) ran ten rounds and hit the per-tier cap
with `tierRounds: {t1: 5, t2: 4, t3: 1}`. Rounds 1–5 found real defects: a TOCTOU in
the D-55 guard I had written an hour earlier, a `lore-ok` written in a JSDoc block
that `parseLoreOk` could never read, a blank ` *` line that swallowed the following
paragraph into a justification, an error naming a tool that does not exist, and a
wait condition — `fast_clean` — that never arrives.

Rounds 6–10 were prose about prose. Every fix to a documentation finding *writes new
documentation*, which the next tier reads and faults, and this codebase is
deliberately comment-dense (PROG.md). The bound stopped it, which is exactly what
D-52 left it able to do: the cap now fires only on rounds that raise something
fresh, and t2 raising fresh findings four rounds running IS the unproductive
iteration the cap is for. The system was right and I was the one looping.

The lesson is about scope, not tiers: **prose and code should not be in the same
review round forever.** A comment is a claim and deserves review — that was worth
five real defects tonight — but a ladder that re-reads its own freshly-written
explanations will always find something to say about them.

**`passed`, reached — and then the attestation showed two more defects.**

```
lore: reviewed tree bc1432841a5d3911e88f5e5866bf8c0d03ecee7a against this repo's
rules and lore's own — 4 tiers, 5 findings, 0 fixed, 2 justified.
[ed25519:+IS6r19+xlkqZDBnkYKk/rVyiT+Za9GksLAzSim7No1X9dZR4BF99KuoVgk8YoFUAJNFRWkQlGumKjue0DldAw==]
```

The tree equals `HEAD^{tree}` exactly. Two vendors, three model tiers plus T0, all
agreeing on one tree, on subscriptions, at `$0`.

**What made it reachable was scope, not tiers.** A 5.8 KB review cleared t1 in 137s
where a 31.8 KB one had needed ten rounds and a 69 KB one blew the deep tier's
timeout. Small diffs, a ticket naming every commit in the range, and — the tactic
that actually broke the prose oscillation — **justify rather than rewrite** unless a
finding is behavioural. A settled finding does not reset the ladder; a rewrite adds
fresh surface for the next tier to fault.

**The first attestation was wrong in two ways, and only producing it could show
that.** It read `reviewed tree unknown ... 1 findings, 0 fixed, 3 justified` for a
review with one finding. `review_submit` was the sole writer of `review.tree_hash`,
so a review needing no fixes passed having never recorded one; and `tally` counted
verdict ROWS, while D-51 carries a justification forward once per round. Then t3
found the sharper half: `?? "unknown"` meant a missing hash still got SIGNED — an
artefact asserting nothing checkable while carrying a real ed25519 signature over
it, which looks verified. `attest` refuses now. Then it found that the quota path
returns early and skipped the recording, so `passed_partial` would have been
refused an attestation by the guard I had just added.

Four defects in the product's central artefact, none reachable except by making it
once.

**D-56 and D-57, and what reviewing them proved.** The design work answered the
three symptoms that shared a root — the loop had no way to record that a finding was
*answered*. `fixed` is now settled by qualified silence over code that moved, and
`.lore-ok.md` gives a reason somewhere to live when the file it defends has no
comment syntax.

The review of that work found **six defects in it**, every one mine, and five of
them would have been silent:

- the ladder never learned about `fixed`, so a re-raise livelocked the client on
  `findings_ready` with an empty list;
- a ledger justification recorded a hunk of markdown, which `expireStaleVerdicts`
  then looked for in the JSON it defends — expiring every ledger reason the round
  after it was accepted, the exact loop D-57 exists to end;
- `SCHEMA_VERSION` stayed at 2 while two columns were added, so the number
  `assertNotDowngrade` compares stopped describing the schema;
- a re-raise refreshed neither scope nor origin, so a stale hunk could fake a fix and
  a stale origin let a weaker tier close a stronger tier's finding;
- an unreadable file fell through to `fixed`, reading an I/O failure as evidence the
  code had moved.

The first `fixed` verdict this system has ever written was observed live:
`cadd3821 → fixed by t1, "not re-raised by t1 and the code it named has changed"`.

The review then hit the per-tier bound at `{t1: 5, t2: 3, t3: 1}` — t1 raising fresh
findings on five rounds is the ping-pong the cap is for, and every one of those five
was a real defect in a design written the same afternoon. The bound stopping it is
not the design failing; it is the design being reviewed harder than it was written.

**The restore drill passes, and taking the snapshot is where the danger was.**
Replicate → destroy the source → restore → `integrity_check` ok and every row back:
`knowledge=440 finding=45 verdict=58 review=14`, identical either side. Litestream's
mechanism is sound and is now `make backup-drill` rather than something I once did
by hand.

The finding was in my own first attempt. The container has no `sqlite3`, so a
`.backup` fell through to plain `cp lore.db` — which copies the main file and **not
the WAL**, and silently produced a snapshot missing **86 knowledge rows and a schema
version** (354 vs 440, version 2 vs 3). It looked like it worked. A backup that is
quietly missing the newest thing you did is the same species as everything else this
session: a failure that reports success. `VACUUM INTO` is what the drill uses, and
the reason is written into the target.

`make status` now says, in red, when there is no backup at all. The operator view
that caught several of this session's defects was silent about the single largest
risk to the thing the product IS.

**And then the architecture changed, which unblocked it entirely.** Off-device S3
was the wrong split: it made replication need credentials, credentials made it
opt-in, and an opt-in backup is one that is off — 440 rows on a laptop with no
second copy. Vany's design is simpler and better. Litestream writes into a folder
beside the deployment and an **outer script** carries it away; lore does the half it
can be responsible for, properly and without configuration, and knows nothing about
the rest. No credentials means nothing to gate, so it is a first-class service now
rather than a profile.

Restoring from the LIVE replica: `integrity: ok`, schema v4, all 440 rows. The
tooling is careful not to overclaim — `backup-check` says it sees the local half
only, and `make status` warns on replica staleness rather than on a missing
credential, because staleness is the failure that actually happens.

**T0's sandbox ran for the first time, adversarially, and held.** A package whose
`npm test` is a hostile script, through the real `runTests` path with the deployed
`DEFAULT_SANDBOX` — not a relaxed copy:

```
read the knowledge base                    blocked
read the attestation signing key           blocked
list the deploy keys                       blocked
read any host root                         blocked
reach the network (dns)                    blocked
reach the network (tcp)                    blocked
write to the read-only sources             blocked
read the docker socket                     blocked
gain new privileges                        blocked
capabilities  0000000000000000   pids 512   memory 2 GiB
its own sources                            reachable  (as it must be)
```

The hard timeout holds too: a `sleep 600` suite is killed at the limit, and the
whole chain is honest about which failure it was — `timedOut: true` produces *"the
test suite did not finish within the time limit"*, not *"the test suite fails"*.
Those are different claims and the code already knew it.

**The one thing I do not like: the suite runs as uid 0.** With every capability
dropped and `no-new-privileges` set, root buys an attacker very little — but it is
still root, and a kernel or runtime escape is worth more from uid 0 than from
nobody. `--user` is not set, which is defence in depth left on the table rather than
a hole. In TODO.

**Open.** One bad finding still discards a whole reply;
that is the right default and the wrong outcome. `passed`, t3 and a real
`review_attest` remain unreached. glm-5.2 exceeded the 300-character claim cap on
three of four claims, which is a number to revisit with a cost argument, not
quietly.

---

## 2026-08-03 — session 29: the memory was per-review

**Did.** Fixed the defect that undercut the whole product, found by watching the loop
rather than by reading it (D-51).

**An accepted justification did not survive its own review.** A fingerprint belongs to
the review that raised it, so a reason ratified last week matched nothing this week.
Every new review re-raised every settled finding, and the author re-submitted the same
`lore-ok` forever. SPEC has said since day one that *"an accepted justification becomes
durable knowledge"*; the code wrote it into a drawer nobody opened again.

Seen, not deduced: `lore-ok[d6d9cd72]` was accepted in one review of this repo and
ignored by the first round of the next. `collectJustifications` runs BEFORE findings
are recorded — it must, because the model tier's silence is what ratifies a pending
reason — so on round 1 the finding table is empty and every pre-existing marker is
skipped. The ordering is right; what was missing was the inheritance.

A raised fingerprint now inherits the last `justified-accepted` verdict from any
earlier review of the same repo, with two guards: not if the MODEL raised it this
round (a model that reads the reason and complains anyway is disagreeing with the
lore, and that is worth more than closing the finding), and not if the code moved
(the same staleness rule `expireStaleVerdicts` uses within a review, across them).

**Learned: the defect lives between reviews, and every test built one.** Same shape as
`resolveShort` throwing earlier today. A suite that constructs one review and asks
about its own findings cannot see either bug — not because the tests are weak, but
because they only ask questions I already had. Three rounds of adversarial agents did
not find this. Running the loop twice did.

**Also this session, from a twelve-agent sweep.** Two fixes landed, four still on
disk. The lesson from the sweep is about prose, not code: across two rounds the code
converged under adversarial review and the COMMENTS did not, because a comment is a
claim nobody runs. Reviewers disproved six of them by execution — "every failure names
its own layer" (not true of `ask`'s catch), "the session total is this review's total"
(false when the reviewer delegates via `task`), a diagnostic asserting one cause among
three it cannot distinguish, a 5.2 MB/179 ms figure measured on a laptop rather than
the arm64 SBC it describes, "sorting again costs nothing" (unmeasured), and
`compareFindings` "mirrors" the SQL (it approximates; JS UTF-16 vs SQLite BINARY
disagree above the BMP). On a project whose one rule is that an unverified claim is
the enemy, five of six agents wrote comments their code does not honour — twice.

**Closed a finding GLM raised on code written an hour earlier**, which an agent AND
its adversarial verifier had both passed: `schema.ts` "lacks version tracking". Its
stated mechanism was wrong — column-sniffing is deliberate and is better than a
version row for going forward — but the instinct found two real things underneath.
`SCHEMA_VERSION` was **written on every open and read by nothing**: a number that
looked like protection and was decoration, this codebase's characteristic bug one
layer down. And `MIGRATIONS` can only express ADD COLUMN, with nothing stopping
someone writing a `CREATE INDEX` into it — which would run on every single open,
silently for an `IF NOT EXISTS` index and as a startup crash for anything else,
neither pointing back at the list.

So the list now refuses anything that is not an ADD COLUMN, and the version number
earns its place by refusing a DOWNGRADE. That is the one case column-sniffing cannot
catch: every column an older build wants already exists, so it skips every migration,
looks healthy, and writes into a schema it does not understand — losing whatever the
newer build recorded in columns it cannot see. It only ever refuses, never approves,
so a version row that disagrees with the real columns still cannot skip a migration.

**And closed the second finding on today's code**, `worker.ts` "job claiming race".
The stated mechanism was wrong again — `claimJob` runs inside `BEGIN IMMEDIATE` on a
synchronous single-threaded connection, so the claim itself does not race — but the
finding was pointing at something real one step over. `claimJob` sets `running` and
`finishJob` clears it; a process that dies in between leaves the row `running` FOR
EVER. Nothing reclaimed it, and `queueDepth` counts only `queued`, so the operator
view showed an idle service with work stranded inside it. INV-1 wearing the
scheduler's clothes: a round that did not run, reported as nothing to do. `attempts`
was incremented on every claim and read by nothing — the same decoration
`SCHEMA_VERSION` was, in the same file I had just fixed it in.

I expected wreckage on the deployment, having restarted that container a dozen times
today mid-review. **There was none** — every restart happened to land between jobs.
Lucky, not safe, and worth writing down as luck rather than as evidence.

Reclaim happens at STARTUP specifically, so no staleness threshold has to be guessed.
Mid-flight it would need one longer than the longest legitimate round — T1 measured
at 1006s, `longFetch` allows 30 minutes — and guessing low requeues a job that is
still running, so the review runs twice and is paid for twice. At startup this
process holds nothing, so `running` unambiguously means orphaned. A job that has
burnt its attempts fails instead of requeueing, because a round that reliably kills
the worker would otherwise crash-loop on every restart.

**Surprised me.** GLM read my `lore-ok` for the semgrep false positive and raised the
same concern independently, in its own words, as a separate finding. I argued the
loopback bind makes plaintext irrelevant; an independent model disagreed. That is the
ratification mechanism working exactly as designed, against me.

---

## 2026-08-03 — session 28: the cap I did not ship

**Did.** Closed the first of session 27's two open items and deliberately did not
close the second the way it was written.

**`createSession` never looked at the status.** Fixed, and both halves of it verified
against a real opencode 1.18.9 rather than against a fake: a password-protected
server answers `POST /session` with a **bare 401 and an empty body**, so `data` is
undefined, `error` is `{}`, and the status is the only thing in the reply that names
the fault. The old message blamed the missing id — *"is a server running?"* — while
the server was up and answering, which is where two debugging sessions went. The
opposite case turned out to be missing too: an unreachable server **rejects** instead
of returning (`connect ECONNREFUSED` through `longFetch`), and that reached the
worker as a bare error naming neither the tier nor the address. That is the one case
where "is a server running there?" is the right sentence, and it never printed it.
`doctor.ts` had both cases right already; the reviewer boundary did not.

**The turn cap: not shipped, and that is the change.** Round 1 of this fix wrote one,
defaulting to 80 turns. The local opencode store still holds the predecessor's two
real review sessions of `rigid-monorepo`, round 181, both on the read-only agent, and
they settle it:

| session | turns | session cache reads | cost |
|---|---|---|---|
| `review_glm_r181` | **82** | 8.85M | $0.85 |
| `review_sol_r181` | **27** | 11.87M | $35.20 |

**A cap of 80 would have failed a healthy GLM review at turn 81**, after $0.85 of it
had been paid for. And the run that read the *most* tokens took a *third* as many
turns as the one that read the fewest — turns are not tokens, and one global step
limit does not mean the same thing to two models. I argued for measuring first before
I found these; the numbers are what turn that from a preference into a decision.

Round 1's cap had two enforcement halves and I can now show both were inert.

- The *audit* counted `step-start` parts in the prompt reply. A reply is ONE
  assistant message, and an assistant message holds at most one `step-start` — 1415
  of them across 1455 messages in the local opencode store; of the 40 without one, 31
  are `patch`-only bookkeeping and 9 have no parts at all. So it read 1 for a runaway
  and 1 for a one-shot answer.
  The tests passed because the fake handed back a reply with nine step parts in it,
  which real opencode never sends. *Fakes must not be kinder than production*, and
  this one invented a shape production does not have.
- The *live watch* subscribed to the event stream. A reviewer ran it against a dead
  port: 0 steps, no trip, nothing printed — the SDK's SSE client swallows connection
  errors into an optional callback nobody passed. And when it did fire, the abort
  surfaced as `500: MessageAbortedError`, which is precisely the misdiagnosis the
  other half of this session was fixing.

So D-50 is now *count first*. `usage.steps`, from `GET /session/:id/message`, one
session per tier run. **NULL, never 0**, when it cannot be taken — a zero is a claim
that the tier explored nothing, and it would bias the very distribution the future
threshold gets read from, downwards, exactly on the runs where the measurement broke.

**Learned: the number lives in the session, not in the reply.** opencode appends one
assistant message per turn and `session.prompt` hands back only one of them. Run
against a real server on a copy of the local data directory, the shipping code
counted **82** turns for a session the database says has 82 `step-start` parts.

**Learned: an old database does not get new columns.** `CREATE TABLE IF NOT EXISTS`
is a no-op on a table that exists, so `usage.steps` would have been present in every
test and absent on the deployed file, and the first insert naming it would have taken
a review that had already paid for a model. There is now a `MIGRATIONS` list and a
test that opens a hand-built version-1 database — the second open is the one that
matters, because `ADD COLUMN` twice is an error.

**Surprised me, twice.**

The first draft of the step counter's own failure message printed *"opencode answered
200"* for a server that was not there — I only saw it because I pointed the real code
at a dead port and read the output. A diagnostic that invents a status is the same
defect as the one this session set out to fix, written by the fix.

And `usage`'s token columns are read from that same single assistant message, so what
lore records as a review's tokens is one turn of it. In a real 73-turn session the
per-message cache reads were 100k–450k each and **summed to 17.9M**. That makes the
spend ceiling blinder than session 27 thought (`cost_usd` is $0 on a subscription
*and* it is one turn's cost), and it means a step count cannot be converted into
tokens until it is fixed. `GET /session/:id` hands back the session's real totals in
**713 bytes** — `{cost, tokens:{input, output, reasoning, cache:{read, write}}}`,
matching my per-message sums exactly — so the fix is small. Not done here: it changes
what the ceiling sees, which is a money decision and Vany's.

**Cost of the new call, measured rather than assumed:** the message list for that
86-turn session is **5.2 MB over 179 ms**. Once per completed review that is fine on
the SBC; it is the reason to keep an eye on `session.messages` if reviews get much
longer, and the reason the cheap `GET /session/:id` above is worth knowing about.

**Also worth keeping:** `session.abort` reported failure by return value too, and was
being swallowed whole — an abort that 404s means the model keeps exploring and keeps
spending, which is the exact thing the abort exists to stop. It still cannot throw
(that would replace the error that caused it), so it now says so on `[lore:log]`.

---

## 2026-08-03 — session 27: lore reviewed lore, and was right

**Did.** Ran the first whole-repo review through MCP: `main` against the first
commit `d3ebb0c`, 85 files, 480,689 characters of diff, ticket = the original ask.
T1 (GLM-4.7) took **521s**, spent **161,792 cached** tokens against 2,990 fresh
(98% cache hit again), and returned **four findings**. Three were real.

**What it found, and why it matters:**

- `deploy/tiers.zai-coding-plan.json` — T2 and T3 are both `glm-5.2`. **A config I
  wrote, violating a rule I documented.** It cited D-7 and D-47, so it had read
  SPEC.md; the knowledge premise is not theoretical.
- `src/core/ladder.ts` — the single-vendor check *warns and continues*. That is why
  the config above sailed through the guard written to catch it.
- `deploy/sync-opencode.sh` — the INV-8 agent check also only warns. **I had lived
  this exact failure four hours earlier**; GLM found it by reading the script cold.
- One false positive: a semgrep React rule on `http://127.0.0.1` in a test. Closed
  with the first real `lore-ok` in this codebase.

**The thesis it handed me:** *a check that only prints is a comment.* Three
instances, one review, in a project whose stated rule is that every ambiguity
resolves toward saying so loudly.

**Three bugs to get there, and each fix exposed the next.** Staged config was 0700
and the container runs as uid 10001 → agent lookup 500 in **0.015s** (that number is
the tell; nothing that fast reached a model). `chmod 755` → opencode could now *read*
its config, saw `plugin: [superpowers, oh-my-openagent]`, tried to install into a
`:ro` mount → every `POST /session` 500. Config mount made writable → works.

The first bug was **masking** the second: while the directory was unreadable,
opencode silently ran with defaults and no plugins. I did not create the second bug
by fixing the first; I revealed one that shipped with the compose file.

**Observed live, worth keeping:** the probe I ran *without* an agent ran as `build`
— the write-capable default. INV-8's trap, on real hardware. Only the per-request
`tools: {write:false,…}` denial stood between a reviewer and a writable checkout.
`sync-opencode.sh` now **refuses to stage** without a readable `readonly.md`.

**D-49.** Kimi is waitlist-only, so a second vendor cannot be bought. Enforcing
independence therefore cannot mean "fix the ladder" — it means a single-vendor
ladder reaches `passed_partial`, never `passed`, and the attestation names the
vendor next to the tier count it would otherwise inflate. Vany chose this over
spending on OpenRouter. The honest answer to *"we cannot afford independence"* is to
say so in the output, not to quietly redefine `passed`.

**The MCP loop works end to end.** `review_start` → poll → findings with
fingerprints, CWEs, evidence and `justify_with` → `review_submit` with a diff, and
the tree hash **verified** — lore reproduced `6c0ad6ed` in its own worktree.

**And then round 2 died, on the worst bug of the project so far.**

```
review round failed — no finding matches lore-ok[a1b2c3d4] in this review
```

`a1b2c3d4` is the example fingerprint in lore's **own documentation** — `docs.ts`
shows it as the format. But the doc example is only how it surfaced. The real defect:

`store.resolveShort` threw when a `lore-ok` matched no finding **in this review**.
A fingerprint belongs to the review that raised it, so a justification accepted last
week matches nothing this week. That is not an error, it is *what every mature repo
looks like* — and it meant **the second review of any repo using lore-ok would fail.**
The core feature broke the core loop, on the second use.

The cruellest part is `review.ts:322`:

```ts
const fp = store.resolveShort(reviewId, mark.short);
const finding = byFingerprint.get(fp);
if (finding === undefined) continue; // already settled in an earlier round
```

I *anticipated* this exact case and wrote the skip. The line above throws before it
can ever run. The intent was right and unreachable — which is the same shape as
`isStale` in session 19 (written, unit-tested, zero call sites).

`resolveShort` now returns `undefined`, the caller skips and **logs the file and
line** so a typo'd fingerprint is still findable. Ambiguity still throws — picking a
winner would close a defect nobody examined.

**No unit test would have found this.** Every test builds one review and asks about
its own findings. The bug lives in the relationship *between* reviews, and only
running the loop twice poses that question. That is the third time this project has
learned the same thing: contact with the real system finds what local tests cannot,
because tests only ask the questions I already thought of.

**Surprised me.** I expected the cheapest tier to produce forty variations of
"consider adding error handling". It produced one argument with three pieces of
evidence. The finding I'd have called the least likely — a shell script warning —
was the one I had personally been burned by that afternoon.

**Still open:** `createSession` reports a 500 as *"is a server running?"* (it never
checks status — same class as the SDK bug in session 20, a failure reported by
return value rather than status). No turn cap on agentic exploration. The spend
ceiling sums `cost_usd`, which is `$0` on a subscription, so it guards nothing. T0
inherits semgrep severity verbatim, which is why a test-file FP arrived `high`.

---

## 2026-08-03 — session 20: first contact with a live model

**Did.** Ran the CLI against a real opencode server and a real provider. It did not
complete a review — the OpenRouter account has no credits — but it found **two real
bugs in ten minutes** that no amount of local testing would have surfaced.

**Bug 1: the opencode server uses HTTP basic auth, and the Reviewer could not speak
it.** `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` are set in Vany's
environment; the server answers a bare 401 with no hint. Now read from the same
variables opencode itself reads, so a protected server works with no extra config.

**Bug 2, and this is the valuable one: opencode answers HTTP 200 and nests the
PROVIDER's failure in the message body.**

```
HTTP 200
  data.info.error = { statusCode: 402, message: "Insufficient credits" }
```

I had already fixed the transport-level status check in session 18 — but the
transport said 200. The provider failure arrived as an empty assistant message,
failed to parse, got retried, failed again, and was reported as *"the model did not
return findings"* (exit 70). Someone would have gone to debug the prompt when the
real answer was an unpaid bill.

Now exit **75**, with the provider's own message. Also: a provider failure no longer
consumes the parse retry, because retrying an unpaid bill wastes a call and reports
the wrong cause.

**The lesson, which is the same one twice at different layers:** *a successful
exchange with a middleman says nothing about whether the work happened.* I fixed
that for the SDK and did not think to ask whether opencode did the same thing to
me. Two layers, two verdicts, and only one of them is in the status code.

**Method note.** Ten minutes of running found more than the last several hours of
reading. Local tests proved the code does what I wrote; only contact with the real
system showed what I had failed to write at all.

**Blocked on:** OpenRouter credits. Everything up to the model call now works —
session created, auth accepted, prompt delivered, response understood.

---

## 2026-08-03 — sessions 20–26: first contact, then a live deployment

**The system is deployed and answering.** `http://c:7777/mcp`, two arm64 containers
on the Orange Pi, `doctor` green, ten tools reachable over the LAN. Getting there
found **eleven bugs in one evening**, none of which any local test could have caught.

### The two that cost real money

**Abandoning a call does not stop the model.** Vany noticed opencode had eaten 5M
tokens. Three T2 calls had failed client-side with `fetch failed` — and then went on
to consume ~3.7M cached-read tokens between them, because the agent kept exploring
the repository after lore had stopped listening. Six sessions were still live when I
checked.

A timeout that only frees the caller is **not a budget**. It is worse than no
timeout: the operator sees a failed review and has no reason to suspect it is still
running and still billing. `review()` now aborts the session on every failure path.

**And the 5M were cache reads, not fresh input.** An agentic reviewer re-sends its
accumulated context on every tool call, so a long exploration multiplies the read
count even though each read is cheap. D-29 assumed caching is a saving — per token
it is, but against a subscription *quota* the count is what matters, not the price.
**Agentic exploration is the cost driver, not model choice.** Still uncapped; that is
the next thing to build.

### The pattern, now unmistakable

Every one of the eleven lived at a seam, and most were **invisible defaults nobody
chose**:

- Node's `fetch` is undici, whose `headersTimeout` is **300 s**. T1 took 254 s. A
  deep tier crosses that line and dies as a bare `fetch failed` — no status, no
  message, nothing pointing at a timeout.
- opencode reports `tokens.cache` as an **object**, so `Number()` gave `NaN`, and NaN
  into a NOT NULL column killed a review that had already been paid for.
- `node:*-alpine` ships **no git**: 10 of our own 180 tests failed, and a suite that
  fails for reasons unrelated to the change becomes high-severity findings.
- The container ran as uid 10001 against a host directory owned by 1000 →
  *"attempt to write a readonly database"*.
- `auth.json` at 0600 was unreadable to the container → *"not authenticated"*.

**The last two are the instructive ones: both messages were accurate and still
misleading.** SQLite really did see a read-only database; opencode really did observe
no credentials. Neither could point at ownership, because from where they sat
ownership was not visible. **The diagnosis has to come from somewhere other than the
symptom.**

### Facts worth keeping

- **Cost is $0** on the coding plan, confirming `zai-coding-plan` (the
  `/api/coding/` endpoint) rather than `zai` (per-token). Same key, different bill —
  the provider id is what decides.
- **T1 took 254 s** on a 5,900-line repo. At 30 PRs/day, **wall-clock is the binding
  constraint, not money or CPU** — which makes the two-stage split (D-34)
  load-bearing rather than a nicety.
- **arm64 is fine**: `npm ci` 9 s, full suite 7 s, typecheck 2 s. The D-37 estimate
  of ~5 CPU-hours/day was an order of magnitude too pessimistic; the real figure is
  ~25 minutes.
- `zai-coding-plan` provides GLM only, so the ladder is **single-vendor** — usable,
  and warned about on every load, but closer to one opinion asked three times than
  to three independent reviews.

### Still not done

A full ladder through T2 and T3 has **never completed**. The CLI inside the container
cannot do it — `/app` is not a git repo, only `src/` ships — so the real test is the
MCP path, where the worker clones into `/var/lib/lore/repos` itself. That is the next
move, and it wants a branch with a genuine planted defect so we learn whether lore
*finds* things, not merely whether it runs.

Also open: the exploration turn cap, and the spend ceiling sums `cost_usd` which is
$0 on a subscription — so it currently guards nothing.

---

## 2026-08-03 — session 19: wiring the code that was written but never called

**Did.** Audited for specced behaviour that exists but is never invoked. Found two,
and fixing the first uncovered a third. 178 tests.

**`isStale` had zero call sites.** The guard against rubber-stamping — the failure I
had twice written down as the one I would most expect in six months — was written,
tested in isolation, and **never wired**. Justifications never expired. Reasons would
have accumulated, code would have moved out from under them, and nothing would ever
have been re-examined.

Now `runRound` expires stale justifications *before* the model tier runs, and records
the expiry as a new verdict rather than mutating the old one — *why* something was
re-opened is exactly the kind of thing that gets re-argued if it is not written down.

`hunkStillPresent` slides the window across the file rather than comparing blobs: a
verdict must survive an edit *elsewhere* in its file, or every justification in a busy
file expires on every commit and people learn to ignore the findings that reappear.

**Fixing that uncovered a worse one.** `settledFingerprints` matched *any* historical
verdict, and verdicts are append-only — so a justification accepted and later
**rejected stayed settled forever**. Expiry would have written its rejection into the
table and changed nothing. Only the latest verdict per finding counts now.

Two bugs, one of them silently defeating the other. Worth remembering: **writing the
guard is not the same as installing it**, and a unit test on a pure function proves
only that the function works — not that anything calls it. Both of these passed their
own tests the whole time.

**`renderEnrichment` had zero call sites too.** The knowledge layer's review-time
payoff (D-9) never reached the output. Findings now carry their history in both the
CLI and `review_poll`: *"seen 4× before in this repo — this is a pattern, not an
incident"*, which is what tells a reader whether to fix the line or fix the habit.

**Method note for the next audit:** grepping for call sites of every exported function
took one command and found three real defects. Cheaper than any amount of re-reading.

---

## 2026-08-03 — session 18: turning "typechecks" into "runs"

**Did.** Integration tests for the three boundaries I had flagged as unverified.
153 tests. **Found one real bug**, which is why the session was worth spending.

**THE BUG: the opencode SDK does not throw on a non-2xx.** It returns
`{data, error, response}`. So a **429 fell through to the findings parser**, came
back unparseable, and was reported as *"did not return findings"* — exit 70 —
instead of *"out of quota"* — exit 75. That would have lost the quota alert and the
spend-ceiling behaviour with it, and it would have looked like a flaky model rather
than an exhausted plan. The fix inspects `res.response.status` explicitly.

Worth generalising: **an SDK that reports failure by return value rather than by
throwing will be mishandled by any `try/catch` written on the assumption that it
throws.** I wrote that assumption without checking it, and only a test against a
real HTTP server exposed it.

**Two failures were my test harness lying, not the code:**
- The fake opencode server routed on `req.url`, which carries `?directory=…`, so
  `.endsWith("/message")` never matched and *every prompt got the session-create
  reply*. A harness bug that made the SDK look broken when it was fine.
- Assertions on documentation text used phrases that wrap across lines in the
  source, plus `Only` where the doc says `ONLY`. Failing for formatting rather than
  content.

Both are cheap lessons about integration tests: the harness is code too, and it is
the code nobody reviews.

**What now actually runs, rather than merely typechecking:**
- `round.test.ts` — a real git repo, real worktree diffing, real doc ingestion, the
  real store and ladder, and real `lore-ok` reconciliation. Only the model is faked.
  The independent-auditor property is proven end to end: a justification the
  reviewer declines to re-raise is accepted and becomes lore; one it raises anyway
  is rejected and settles nothing.
- `opencode.test.ts` — the real SDK against a real HTTP server. Proves the request
  denies write tools **in the body**, that both reply shapes parse, that an
  unparseable reply retries once and then fails loudly, and that `[]` means clean
  while unparseable means failed.
- `http.test.ts` — the service binds, refuses unauthenticated and revoked tokens
  with `WWW-Authenticate`, and serves tools, prompts and resources over real SSE.

**Refactor that made it possible:** `ReviewerLike`, an interface rather than the
class. The loop is the part most likely to be wrong and the hardest to debug against
a live model; separating them is what made it testable at all.

**Still unproven:** any actual model call, any container launch, and arm64 anything.
But the boundaries around them are no longer guesses.

---

## 2026-08-03 — session 17: Phase 5, the security review type

**Did.** `security/{sbom,osv,vex}`, wired as T0 engines, with reachability guidance
in the tier prompts. 118 tests, typecheck clean. Every phase in `PLAN.md` now has
code.

**VEX really is the justification ledger.** Building it confirmed what the research
suggested: a VEX statement is a status plus a justification attached to a specific
vulnerability, ratified by a reviewer — structurally identical to `lore-ok`. So
`buildVex` is a *mapping*, not a translation layer, and the security type emits real
CycloneDX rather than something bespoke.

**The line I care most about in this phase:** an unexamined vulnerability is
`in_triage`, never `not_affected`. Silence is not a clearance. A VEX document that
quietly marks unlooked-at vulnerabilities as harmless is worse than no document — it
is a signed claim that nobody checked. There is a test pinning it.

**Deleted a function I had just written.** `cvssScore` always returned `undefined` —
dead code pretending to compute something, because OSV carries CVSS as a vector
string and I had started implementing the scoring algorithm before realising the
database already publishes a qualitative rating. Shipping it would have been exactly
the kind of thing a reviewer should catch. Replaced with `severityOf`, and the
reasoning is in the docstring.

**Two honest defaults, both biased toward being looked at:**
- An unrated vulnerability is `medium`, not `low`. Unrated is unrated, not harmless,
  and defaulting downward is how things stop being examined.
- No SBOM produced is a *finding*, not an empty result. You cannot security-review
  dependencies you were unable to enumerate, and reporting that as "no
  vulnerabilities" would be the worst possible reading of INV-1.

**A test that was wrong and taught me the domain.** I asserted that "defaultsDeep is
never called" maps to `code_not_present`. It does not: VEX separates *not shipped at
all* from *shipped but never executed*, and "never called" is the latter
(`code_not_reachable`). The implementation was right and my expectation was wrong.
Fixed the test and wrote the distinction into it, because the next reader will make
the same mistake.

**The security prompt tells the model not to do the scanners' job.** Its contribution
is reachability, and it is told explicitly that "unexamined" is an honest answer
while "probably fine" is not — a review that marks everything exploitable is as
useless as one that marks everything safe.

---

## 2026-08-03 — session 16: Phase 2, the knowledge layer

**Did.** `knowledge/` — ingest, derive, conflict, enrich, bootstrap — wired into the
review round. 98 tests, typecheck clean.

**Wrote the product hypothesis as a test.** `memory.test.ts` asserts that what one
review learns, the next one knows: an accepted justification from review 1 appears in
review 2's context, a repeated finding carries its history, and a defect seen three
times becomes a rule. If D-14 is wrong, that file fails — which is the point of
writing it as a test rather than a belief.

**A correction the wiring forced: bootstrap cannot run at provisioning.** `make new`
generates the deploy key, but a *human* has to add it to the repository before we can
clone anything. So there is nothing to read at provisioning time. Bootstrap now runs
lazily on the first review, which is the first moment the code is actually readable.
Obvious in hindsight; invisible until the call was written.

**Ingestion is deterministic on purpose.** A model would extract better rules, but
this runs on every document change, must be free, and must give the same answer
twice. It takes bulleted and modal-carrying sentences, skips fences and headings —
a rule inside a code block is an *example* of a rule, not one — and splits
"X because Y" into statement and reason, because the *why* is the part that survives
disagreement.

**Two things the tests caught that I would not have:**
- Trailing punctuation was not stripped, so the same rule written with and without a
  full stop was two rules. Since documents are re-ingested on every change, an editor
  adding a period would have quietly doubled an entry.
- My polarity test asserted that "must not be absent" reads positive. It does not,
  and *should* not: it contradicts "must be absent", which is exactly what conflict
  detection needs to see. I had written a test for a nicety instead of for the
  behaviour. Fixed the test, not the code.

**Conflict detection is a heuristic and says so.** Token overlap plus opposite
polarity. It will miss contradictions phrased without an explicit negation
("amounts are integers" vs "amounts are floats") — written into the module docstring
rather than left for someone to discover by trusting it. Threshold tuned to be noisy
rather than silent: a false candidate costs a reviewer one sentence; a missed
contradiction costs every future session a wrong belief.

**Recurrence clusters on two axes.** CWE catches the same weakness class described in
different words — which is precisely what the exact fingerprint cannot do
(§3.1.1) and why D-44 exists. Normalised claim catches repeats with no CWE at all,
which is most findings. Threshold is three, not two: two occurrences of anything is a
coincidence often enough that promoting at two would fill the base with noise, and a
knowledge base nobody trusts is one nobody reads.

**Knowledge is selected against the changed files, not dumped.** Everything a repo
knows would crowd the diff out of the context window, and a reviewer that cannot see
the change reviews nothing. Repo-wide rules always apply; path-scoped ones only when
the change touches their path.

---

## 2026-08-03 — session 15: all of it, written

**Did.** Phases 1, 3 and 4 in one go, on "write all the code, we will test on
deploy". 72 tests, typecheck clean throughout, CLI and provisioning smoke-tested.

**What exists now:** `git/` (bare clone + worktree per review, `--submodule=diff`),
`t0/` (the target's own tsc/eslint/ast-grep/semgrep, plus a sandbox that runs tests
in a container holding no secrets), `reviewer/` (opencode with tools denied in the
request body, tier prompts by position, structured output with one retry),
`store/` (SQLite, principal-scoped), `mcp/` (7 tools, 5 doc resources, the `review`
prompt), `service/` (worker, HTTP, attestation, provisioning), `ops/` (alerts,
heartbeat deadman, spend ceiling), `deploy/` (arm64 Dockerfile, compose, litestream).

**The best thing I found while writing it: ratifying a justification needs no
protocol.** A `lore-ok` comment is a proposal; the reviewer ratifies by *not*
re-raising the finding and rejects by raising it again. Silence is assent, a
re-raise is a reasoned refusal, and the author still never closes its own finding.
I had been sketching an extra output field for accept/reject and it was unnecessary
— the mechanism was already implied by the ladder. An accepted justification is then
written into the knowledge base as a derived rule, which is exactly what the name
promised.

**A second one from the SDK.** `session.prompt` takes `tools: {[key]: boolean}` per
request, so reviewers are denied write/edit/patch **in the request body** rather
than only via `--agent`. That flag silently falls back to the write-capable default
when the agent is missing (INV-8); an explicit per-request denial has nothing to
fall back to. The predecessor's worst trap is now structurally impossible rather
than merely checked for.

**Judgement calls worth remembering:**
- `extractFindings` returns `undefined` for unparseable and `[]` for clean, and one
  malformed finding invalidates the whole reply. Keeping the valid ones would
  silently drop a defect the model actually found.
- The sandbox has network during install (a registry needs it) and **none** during
  the test run. No secret is present in either phase, so a malicious lifecycle
  script has nothing to take and nowhere to reach.
- Tokens are stored as sha256 only and compared in constant time. A database backup
  should not be a set of live credentials.
- The compose file mounts the docker socket so T0 launches *sibling* containers.
  That is root-equivalent control of the daemon and it is called out as the largest
  privilege in the file — acceptable only because the box does one job on a private
  tailnet.

**Said once and then dropped:** untested code reviewing other people's code is the
place "test on deploy" bites hardest, given this tool's whole value is a verdict you
can trust. So the pure logic keeps its unit tests (they run in ~130ms and cost
nothing) and "test on deploy" covers the boundaries that genuinely need the device,
real repos and real models.

**Unverified and honestly so:** every model call, every container launch, the MCP
transport wiring, and arm64 anything. `tsc` proved the shapes; nothing has proved the
behaviour.

---

## 2026-08-03 — session 14: P0.1, and a hole in the convergence argument

**Did.** `src/core/finding.ts` and `src/core/fingerprint.ts` with 24 tests.
Typecheck clean. zod 4.4.3 added.

**Implementing the fingerprint exposed a real weakness in the spec.** SPEC listed
"fingerprint dedup" as termination bound 1 — *a settled finding cannot re-trigger
work*. That is only true for **identical** claims. If T2 raises in different words
what T1 already settled, the hash differs and the loop sees new work.

So what actually holds the line is the **ledger in the prompt** (a *prompt* defence,
which will sometimes fail) plus bounds 2–4, which are mechanical. Corrected in
`spec/review-ladder.md` §3.1.1 rather than left as a comfortable assumption.

I deliberately did **not** build a mitigation. Two candidates exist — a coarse
`file ‖ symbol ‖ cwe` similarity key, or an explicit dedup pass — but whether
paraphrase-churn actually happens is a Phase 1 measurement. Building machinery for
an unmeasured problem is how specs grow features nobody needed.

**Design decisions made while writing it:**

- **Strict schema.** An unknown key from a model is an error, not a dropped field.
  It means our prompt and the schema have parted ways, and silently dropping it
  would hide the drift for as long as it took someone to notice findings had got
  worse. The reviewer gets its one retry, then the review fails loudly.
- **`claim` capped at 300 chars.** Enforces "one sentence", which is what makes
  findings comparable — and output is ~77% of the top tier's cost once input is
  cached, so a reviewer that writes essays costs several times more forever.
- **Length-prefixed hash input.** With a plain separator, `("ab","c")` and
  `("a","bc")` collide, and `claim` is free text so it can contain whatever
  separator we picked. Cheap to prevent, invisible if it ever happened.
- **Severity excluded from identity**, so a finding returning at raised severity
  after a rejected justification is the same finding. There is a test pinning this,
  because it encodes a spec requirement rather than an implementation detail.
- **camelCase over the spec's `failure_scenario`.** One shape for both the wire
  contract and the TypeScript, because a second internal representation would drift
  from the one the models were actually asked for. Spec updated to match rather than
  left to disagree.

**Short-id ambiguity is now a stated requirement.** `lore-ok[8 hex]` is ~1% chance
of a shared prefix at ~10k findings, which is fine *only* if lookup treats ambiguity
as an error instead of picking a winner — git's rule. Written into §3.1.2 so the
store layer cannot forget it.

---

## 2026-08-03 — session 13: named `lore`

**The project is `lore`** (D-45). Renamed throughout; typecheck clean, tests green,
CLI now exits 70 saying *"lore is not implemented yet"*.

**Why this name rather than a review-flavoured one.** The candidates split into two
families: the *judgment* (assay, crucible, quorum, argus) and the *memory* (lore,
engram). Memory won because it names the **product** rather than the commodity —
everyone has a reviewer; nobody has the memory (D-14).

**The name then earned something I did not anticipate.** The justification marker
becomes `// lore-ok[fp]: reason`, which reads as *proposing a piece of lore* that the
reviewer ratifies or rejects. That collapses two systems into one: an accepted
justification is not merely a closed finding, it is **how the codebase acquires a new
fact about itself**. Every argument won with a reviewer becomes something the next
session already knows. `spec/review-ladder.md` §4 now says so explicitly.

Worth remembering as a general point: a name that describes the *product* rather
than the *mechanism* tends to expose whether the mechanisms are actually one thing.
Here it did.

**Practical bonus:** the old working name shadowed `rev(1)`, a real coreutils command
— a small permanent irritation avoided.

**Two mechanical lessons from the rename**, both of which cost a wasted run:
- **zsh does not word-split unquoted parameter expansions.** `for f in $FILES` ran
  once with the entire list as one filename.
- **BSD `sed` does not support `\b`.** Every word-boundary pattern silently
  no-opped, which looked like a partial rename rather than a failed one. On macOS
  use `[[:<:]]`/`[[:>:]]`, or literal strings chosen to be unambiguous.

**Not renamed: the directory.** Still `~/l/rev`, because moving it mid-session would
invalidate the working directory. Vany's call whether to `mv` it to `~/l/lore`.

---

## 2026-08-03 — session 12: the plan, and what CVE actually answers

**Did.** `PLAN.md`, `research/security-review.md`, D-43 (review types), D-44 (CWE as
finding vocabulary). Rewrote `TODO.md` around the phases.

**The plan is ordered by risk retirement, not by layer**, and writing the risks down
first is what made the order obvious. The top three — *the ladder never converges*,
*the findings are noise*, *the knowledge layer does not help* — are all reachable on
a laptop with a CLI and no service at all. So the walking skeleton is not a
preference, it is where the expensive mistakes are cheapest to make. Risks 5 and 6
(T0 CPU on ARM, arm64 dependency compatibility) need the device; they are planned in
§4.1 and run when it exists.

**Answering "is there a published database, like a set of CVEs?" properly.** There is
no published database of code *review* findings. What exists is a stack, and the
usual mistake is conflating its layers:

- **CVE** — a specific vulnerability in a specific released version. Matched against
  *dependencies*, never against your code.
- **CWE** — the taxonomy of *weakness kinds*, derived from analysing 31,770 CVE
  records. **This is what the question was reaching for.**
- **OSV** — CVEs made machine-queryable per package+version, with an API. Notably it
  can also query **by commit hash**, which is what vendored code and submodules
  (D-36) need since they have no package version.
- **Semgrep / CodeQL** — executable rules that detect weaknesses, carrying CWE
  metadata.

**Architectural consequence worth keeping: executable rule corpora belong in T0.**
Semgrep's registry spans 40+ languages with CWE/OWASP metadata and JSON/SARIF output.
Paying a model to re-detect CWE-89 is paying for the wrong thing. Rules find known
shapes; models find what no rule anticipated.

**The nicest finding: VEX is our justification ledger, already standardised.** For the
security review a scanner says "a vulnerable package is present" and only reading the
code says whether it is reachable. That judgement has an existing format — VEX, in
CycloneDX — recording whether a product is actually affected, with justifications like
*vulnerable code not in execute path*. That is structurally identical to `lore-ok`: a
reason attached to a finding, accepted or rejected by a reviewer, stale when the code
changes. We arrived at the same shape independently, so the security type should emit
**real VEX** rather than a bespoke format — free interoperability with tools we did not
write.

**Review types (D-43).** Default `code-arch`; `security` next. The `type` parameter
goes into the MCP surface from day one even while only one type exists, because adding
a required argument later breaks every client. Phase 0 gets a pipeline abstraction for
the same reason — nearly free now, painful to retrofit.

**Deployment shape:** a folder in `$HOME` with a `docker-compose.yml`, matching the
existing convention. arm64 assumed working, verified before trusted.

---

## 2026-08-03 — session 11: two audiences, and the deadman

**Vany's split:** developer alarms are the *client's* job — we just provide the
information. `lore` alerts **devops** when something happens to the service itself.
D-41, D-42, `spec/operations.md`.

**It turns out the protocol already forced half of this.** MCP servers cannot
initiate requests, so there was never a push channel to a developer. What looked
like a product decision is also the only implementable one — which means our real
obligation is narrower and sharper: make urgency **machine-classifiable** so a
client never has to infer it from prose. Explicit `severity`, `needs_human` as its
own state, and `fast_clean`/`failed`/`expired` never blended into "not passed".

**The important thing I added: a heartbeat deadman.** Alerting devops by pushing
alerts cannot detect its own death — if the alerter breaks, "no alerts" and
"everything is fine" become the same observation. That is **INV-1 at the operations
layer**, and this project exists because four reviews once failed silently in one
day. So the service emits a heartbeat and devops alerts on its *absence*: a dead
service, a dead network, a dead alerter and a full disk then all produce the same
*visible* symptom instead of the same invisible one.

Worth generalising: every time this design has a "how do we know X happened"
question, the answer has been to make the failure visible by inverting the signal
rather than by adding another notification.

**Also added a daily spend ceiling that stops starting reviews** rather than
continuing quietly. At $500–2,600/month a cheap tier looping on a pathological
branch runs up a bill nobody sees until the invoice. A review not started is honest;
a review that runs and cannot be paid for is not.

**Alert routing has three tiers, deliberately:** page (backups stale, heartbeat
missed, disk >90%, provider auth dead, spend ceiling, reviews failing as a class),
ticket (elevated failure rate, spend anomaly, disk >75%, `needs_human` findings
ageing), log only (individual review failures). An alarm that fires constantly gets
muted, and a muted alarm is worse than none.

Transport is a generic outbound webhook — Slack, Alertmanager, Plane or a shell
script, without `lore` knowing which.

---

## 2026-08-03 — session 10: the ticket, and the one place we stop

**Did.** Asked the four questions I had left. D-38…D-40; build order deferred until
the arm64 check lands, which is the right call — a negative result reshapes T0 and
would change what "walking skeleton" even means.

**The ticket is required, and it buys a whole review axis I did not have.** Vany:
*"let's require task ticket text. most of the merges is task based."* Without it a
reviewer can only ask *"is this code correct?"*. With it, it can ask *"is this the
**right** code?"* — and see a change that does less than was asked, something else
entirely, or **more than was asked**.

Scope creep is the one worth naming. An AI told to fix one thing will cheerfully
refactor three others, rename a module, and improve error handling nobody mentioned.
Every unrequested change is code no one decided to write and no ticket justifies. In
a vibecoding workflow it is probably the most common defect, and it is completely
invisible without a ticket. I had not identified it as a category at all before this
answer.

A corollary that went straight into the agent docs: the client must **paste** the
ticket, not summarise it and not substitute its own account of what it built. An
agent describing its own work describes what it made, not what was asked — which
destroys the only independent statement of intent the reviewers get.

**Knowledge conflicts became the one place the system stops and asks for a person
(D-39).** Vany's framing: newer is better, *but* reason about it, make it a problem
in code that must be solved, and tell the client to call a human if it cannot be
solved at the AI level.

So a conflict is a **finding**, not a store-level resolution. Newer *leans* correct —
a prior, not a verdict — because a carelessly written recent rule must not silently
overwrite a reasoned older one. And if the agent cannot decide, `needs_human` blocks
`passed`, blocks attestation, and **cannot be closed with `lore-ok`**. That last part
matters: a justification is a claim about code, but this is a question about which of
two beliefs is true. An agent that could not decide must not be able to write its way
past it. Added to the docs as a named failure mode, because agents are built to be
helpful and stopping feels like failing.

**Reviews are snapshot-pinned (D-40).** Explicit start, never per commit; commits
pushed mid-review are invisible; a new review starts at the tip. This keeps a review
converging on something that stops moving. The consequence worth remembering: **the
attestation covers a tree hash, not a branch name.** If the branch moved, the
signature does not describe what is there now — which is exactly why the tree hash is
in the signed line.

---

## 2026-08-03 — session 9: the host inverts the bottleneck

**Did.** Asked the questions I still had. Four answers, five decisions (D-33…D-37),
`spec/deployment.md`.

**The host is an arm64 Orange Pi (32 GB, 4 TB) on Tailscale, reachable to prod.**
Both halves of "arm64 SBC" constrain the design, and the second half more than I
expected.

**The bottleneck inverted.** I had been treating model calls as the expensive part.
On this host they are remote and cost the machine nothing — **T0 is local,
CPU-bound, and runs on modest ARM cores.** The *free* tier is the one that costs
wall-clock: naively, ~5 CPU-hours/day for one developer, because "reset to T1 after
every fix" (D-6) multiplies the local work by the round count. Hence D-37:
`node_modules` cache keyed by lockfile hash, `tsc --incremental`, and **diff-scoped
checking from round 2**. Disk is plentiful and CPU is scarce here, so spending disk
to save CPU is always the right trade on this box.

**Tailscale deletes a category of work.** No public TLS, no domain, no certificate
renewal, no abuse surface — WireGuard is the transport security. Tokens survive, but
for per-repo scoping rather than network defence. Unverified: whether MCP clients
accept a plain `http://` remote endpoint on a private network; `tailscale cert` is
the fallback.

**Raised a genuine blocker (T0.5).** If any target repo's dependency tree ships
x86-only prebuilt binaries, it will not install or test on arm64 — and **D-24 (T0
executes tests) is undeliverable on this host**. That is cheap to check now
(`npm ci && npm test` in an `arm64v8/node` container) and expensive to discover after
building the sandbox around the assumption. It is now the first task in TODO, ahead
of the model measurement.

**Two-stage review confirmed (D-34):** T0+T1 inline, T2+T3 async. That forced a new
tool — `review.inbox`, returning deep findings across *all* the caller's reviews. At
30 PRs/day a developer with 30 open reviews would otherwise poll 30 ids or lose
findings; both are failures. And a new invariant restatement: **`fast_clean` is not
`passed`.** INV-1 wearing a new disguise — "the cheap tiers found nothing" must never
read as "the branch is clean".

**Submodules, not monorepos (D-36) — simpler in one way, a trap in another.** One
package per repo makes T0 straightforward. But a submodule pointer bump is *two
lines of diff carrying thousands*, and a reviewer shown only the outer diff would
confidently call it low-risk having never seen it. That is exactly the
confident-but-blind finding this project exists to prevent. Gitlinks are expanded,
and never counted as a one-line diff for size or truncation decisions.

---

## 2026-08-03 — session 8: real volume, and T3 stays

**Volume was wrong twice.** I invented "100 reviews/month", then corrected to ~220
from his weekend figure. The real number: **~30 PRs on a working day**, solo, plus a
workgroup — **740–3,700 reviews/month**, a **$500–2,600/month** tool.

Lesson worth keeping: I twice built cost arguments on a volume I made up, and the
recommendation flipped once real numbers arrived. Volume is an *input*, and inputs
get asked for, not assumed.

**Cost and latency are now first-order.** At 30 PRs/day reviews cannot queue behind
one another, which independently kills any quota-metered plan: a burst of 30 PRs is
exactly when a rolling window empties. The Z.ai answer stays no, but the deciding
argument moved from price to throughput.

**Honest error bar.** The $0.70/review assumes ~55k input per pass — a substantial
diff. 30 PRs/day implies *small* PRs, so real cost could be $0.30–0.50, halving
everything. It could also be worse if the agentic reviewer explores widely. Written
down in the research file, because nothing should be bought on my estimates.

**T3 always runs (D-32), Vany's call:** *"run it always but at final, not bother it
with stupid mistakes, code must be almost fixed."* I had floated conditional or
sampled T3 as the biggest remaining cost lever (44% of the bill). He bought certainty
instead, and I think he is right: the attestation keeps its strongest meaning —
**every tier agreed** — rather than degrading to "the tiers we chose to run agreed".
For a tool whose only output is a claim about quality, that is the correct thing to
spend money on.

**His framing produced a design insight I had missed (D-31).** *"Don't bother it with
stupid mistakes"* is not just about ordering — it means **the expensive tier's job is
to find what two independent reviewers missed, not to find everything.** A tier's
position is information, and the same prompt at every tier makes T3 spend its budget
re-deriving what T1 already established. So T3 is now told plainly: two independent
reviewers from different vendors found nothing left; you are the last line; do not
re-report anything a typechecker would catch.

**One thing that stays worth measuring even though T3 is no longer optional:** what
T3 catches that T2 missed. Not to justify cutting it — to detect the opposite
problem. A near-zero number would mean T2 and T3 share a blind spot, which is two
tiers being paid for as one.

---

## 2026-08-03 — session 7: load is not cost, and caching is the real lever

**Question.** Buy the Z.ai plan for GLM, since T1 is first and takes most of the
load? **Answer: no — and precisely *because* it is first.**

**Load and cost are different distributions.** Per converged review T1 is **62% of
calls but 9% of cost**; T2 and T3 are 38% of calls and 91% of cost. The cheap tier
is cheap, so subsidising it optimises the smallest line on the bill. Worth keeping
as a general instinct: in a tiered system, call volume says nothing about spend
until you multiply it by unit price.

**The quota shape is a worse problem than the price.** GLM Coding Plan Lite is
$18/month (verified) against ~$6/month of T1 tokens — already 3× — but the real
objection is that it meters on a **5-hour rolling window**. T1 is the gate *every*
review must clear before reaching T2 or T3. Exhaust it and every review in the
system stalls for up to five hours, including ones that would have passed. Putting
the highest-throughput, most latency-critical tier on the most quota-constrained
billing model is backwards.

**Found the actual cost lever: prompt caching** (D-29). Cache reads are **10×**
cheaper on Kimi K3 and Sol Pro, 5.4× on GLM. Every loop round re-reads the same repo
context with only the diff changing — the exact case caching exists for. A converged
review goes from ~$1.20 to ~$0.70. This is not an optimisation to add later; it is
most of the cost model, and it should be in the design from the first opencode call.

**Consequence I did not expect: with input cached, 77% of T3's cost is output.** So
the structured-findings rule is a *cost control*, not only a design preference — a
reviewer that writes essays instead of records costs several times more, at every
tier, forever. Nice when a correctness rule turns out to pay for itself.

**Found a trap: the 272k cliff** (D-30). `gpt-5.6-sol-pro` doubles its rate above
272k prompt tokens ($10/M in, $45/M out) while advertising 1.05M context. Nothing
stops a wide agentic review from crossing it and silently doubling the dearest tier.
Cap it, and log the crossing rather than discovering it on an invoice.

**Unverified:** whether Z.ai's terms permit backend or shared use. Their docs are
silent, and the existence of a separate Team Plan implies the individual one is not
meant for it.

---

## 2026-08-03 — session 6: I dropped GLM on the wrong metric

**Did.** Answered "what do we subscribe to" with **nothing — one OpenRouter key** —
and retracted D-7 in the process.

**The mistake, kept visible.** In session 2 I dropped GLM-5.2 because Artificial
Analysis showed it at $0.69/task against Gemini 3.6 Flash's $0.56. But *cost per
task* is **tokens consumed × price on their eval suite**, not a price. Pulling
OpenRouter's actual `/api/v1/models` figures: GLM-5.2 is **$0.28/M in, $0.89/M
out** versus Gemini's **$1.50 / $7.50** — 5.3× and 8.4× cheaper, at one point
*higher* intelligence. The conclusion was exactly backwards, and Vany's original
instinct to buy GLM was right.

`research/ai-code-review-landscape.md` §2.1 is struck through rather than deleted,
with §2.1a replacing it. A quietly-corrected file teaches nobody why the error
happened.

**What actually went wrong, so it does not repeat:** I compared a *spend* to a
*price* without noticing they were different units. The tell was available — a
model at $0.28/M input reaching $0.69/task must be emitting an enormous number of
tokens — and I did not follow it.

**The caveat that survives:** cheap tokens × many tokens can still add up. GLM is
plainly a heavy reasoner. Whether that eats its advantage on *our* workload is
unknown, so T1 now measures **tokens spent per review**, not just defects found.
Our shape differs from theirs, which helps GLM: reviewing is input-heavy (a diff
plus explored files in, a small findings record out), whereas SciCode is
generation, which is output-heavy.

**Vendor diversity became a priced decision.** GPT-5.6 Terra beats Kimi K3 on value
(55 int at $1/$6 vs 57 at $3/$15, and 4× faster). But Terra and Sol Pro are the same
family, so that ladder is two opinions wearing three hats. Kimi K3 buys a **third
distinct vendor**, which is the entire premise of D-1. Paying 3× for independence is
the right call here, and it should be re-examined if the price gap widens.

**Why no subscription.** Seat licences authenticate a human and bind to one
rate-limit bucket — the wrong shape for a parallel backend, which was the very
reason he wanted one. And the arithmetic kills it: ~$1.20 per converged review,
~$120/month at 100 reviews, against $200/month for a single ChatGPT Pro seat that
would cover one tier, one user, no parallelism. **The usage is cheaper than the
subscription.** Estimates are labelled as estimates; usage logging replaces them
with facts.

---

## 2026-08-03 — session 5: the docs are the interface

**Did.** Specced the agent-facing documentation surface (`spec/agent-docs.md`),
with draft text for every tool description and the `review` prompt. D-27, D-28.

**The framing that made this design work: the client is an agent, so the docs
*are* the interface.** There is no support channel and no README a confused caller
will go and read. Whatever the tool descriptions fail to say, the agent guesses.
So I wrote the **failure modes first** (§2) and derived every sentence from one —
a sentence that prevents nothing gets deleted. The worst failure is an agent that
polls once, sees `running`, concludes the branch is clean, and ships unreviewed
code. INV-1 now has to survive across a protocol boundary where we cannot enforce
it, only state it plainly enough that an agent does not talk itself out of it.

**Learned — MCP prompts are user-controlled and surface as slash commands.** So
Vany's "maybe even a prompt for review" becomes `/lore:review <branch> <into>`,
returning messages that drive the whole multi-step loop. That is exactly the right
primitive: an agent handed only tools will improvise a stateful loop, and §2 lists
how that goes.

**Learned — resources carry annotations** (`audience: ["user"|"assistant"]`,
`priority` 0.0–1.0, `lastModified`) and support RFC 6570 templates. So docs can be
marked assistant-facing with a priority, and `lore://review/{id}` gives the full
audit trail while `review.poll` stays cheap deltas.

**Design rule worth keeping: tool descriptions are a context budget.** They sit in
the window every session whether called or not. A 400-word tool description is not
thorough, it is a tax on every turn — so descriptions carry only the must-know and
everything else moves to a resource that costs nothing until read.

**How this gets validated:** point a fresh Claude Code session at the server with
no other instructions and watch where it goes wrong. Every failure it invents
becomes a sentence. Docs written for an agent have to be tested against one; I
cannot reason my way to the gaps.

---

## 2026-08-03 — session 4: implementation research

**Did.** Researched the modern way to build this: MCP SDK v2, the security
requirements that apply to our specific design, test-execution isolation, and build
order. Five decisions (D-22…D-26). `research/implementation-approach.md`.

**Learned — the MCP SDK was renamed.** It is `@modelcontextprotocol/server`
**2.0.0**, not `@modelcontextprotocol/sdk`, with intentionally thin runtime adapters
(`/node`, `/hono`, `/express`, `/fastify`, all 2.0.0). Tools are declared with
Standard Schema — Zod v4 (4.4.3) — so schemas validate at runtime and generate the
types, and there is no hand-written parsing at the boundary. Exactly the kind of
thing I would have got wrong from memory.

**Learned — our `review_id` has a named attack against it.** MCP security guidance
describes "state handle hijacking": MCP is stateless, so servers mint handles and
receive them back as ordinary tool arguments. *"MCP servers MUST NOT treat
possession of a state handle as authentication."* `review_id` is precisely that
handle. It must be CSPRNG-generated, never sequential, and bound server-side to its
principal so another tenant's valid id fails like a forged one. Cheap now; the
moment a sequential id exists, every log line containing one is a credential.

**The important call this session: the test container must not be the service
container.** Vany approved running the target's tests, which is arbitrary code
execution — `npm test` runs whatever the dependency tree says, including lifecycle
scripts. The threat is not the teammate, it is the dependency tree. And the service
container holds **every registered repo's deploy key plus the knowledge database**,
so a single malicious `postinstall` in there reads all of it at once. Tests now run
in a separate ephemeral container with no secrets, no network, read-only root,
resource limits and a hard timeout. He said "in the review container" and this is
still that — I just made explicit which container, because the ambiguity was the
whole risk.

**Recommended a walking skeleton (D-25), and it is unconfirmed.** Core → git →
opencode → T0 → a CLI that performs one real review → then MCP, Docker,
provisioning. Reasoning: the uncertainty here is whether a three-tier ladder
converges on real branches, not whether MCP servers and job queues work. Build the
risky part where it is cheapest to change. The honest counter-argument — it defers
the service's own integration risk — is written down in the research file rather
than hidden.

**Noted but untested:** whether `node:sqlite` under WAL survives the write
concurrency of parallel reviews plus parallel `knowledge.*` calls, or whether writes
need funnelling through a single writer. Also that plain containers are a namespace
boundary, not a virtualisation one — proportionate for a workgroup reviewing its own
code, but it should stay a conscious trade rather than an assumption.

---

## 2026-08-03 — session 3: it became a service, and the product changed

**Did.** Rewrote the spec from a local CLI into a workgroup MCP service. Split
`SPEC.md` into a product spec plus `spec/mcp-api.md`, `spec/knowledge.md`,
`spec/review-ladder.md`. Nine new decisions (D-13…D-21). Still nothing
implemented.

**The product is not the reviewer.** Vany: *"the main idea is to share knowledge
about the code between sessions."* Every Claude session starts amnesiac and
rediscovers the same conventions. Reviews are how the knowledge gets **made**;
sharing it across sessions and teammates is what it is **for**. D-9 was a feature
in session 2 and is the centre of the product in session 3. `spec/knowledge.md`
now leads with that sentence so the next reader does not mistake it for a cache.

**The sharpest risk moved with it.** A knowledge base that only accumulates will
eventually describe code that no longer exists — and unlike a stale comment, it is
injected into every future session automatically. Rot here propagates. So every
item carries provenance, a verification date and a `scope` hash, and ingested doc
rules are **re-derived rather than retained** when their source file changes. Vany
picked doc ingestion knowing the hazard was flagged; the mitigation is therefore
mandatory, not optional.

**Learned — the MCP spec forbids the planned auth.** *"Access tokens MUST NOT be
included in the URI query string"*; credentials belong in an `Authorization` header
sent on every request. The plan was a key embedded in the MCP URL. D-21 revises it.
The client side is already proven to work — his own `plane` MCP entry passes
`x-api-key` via `headers`.

**Learned — poll-not-push is not a workaround.** *"Servers do not initiate JSON-RPC
requests."* There is no way to notify a client that a long review finished, so
returning an id and polling is the only correct shape. Vany's instinct here was
right for a reason he had not stated.

**Pushed back on three things, two accepted so far.** That a multi-tenant service
on personal seat subscriptions is a licence problem (mitigated: it is his own
workgroup). That parallelism plus flat-rate is a *collision*, not a saving — one
account, one rate-limit bucket. And that *"we are perfect now"* is a claim we
cannot make: our models stopping is not the absence of defects, and the first bug
shipped behind that badge discredits everything. He settled on one honest line —
tested against our rules and the user's rules — which is both truthful and a
stronger claim than perfection.

**Found a correctness hole in the diff flow.** Applying diffs to a server-side
worktree without committing means the reviewed tree exists nowhere — not in git,
not on the client's disk. A partial apply would be reviewed confidently. Fixed with
a client-supplied `tree_hash` verified after apply; mismatch is terminal.

**My call, not his:** D-17, OpenRouter API keys for now, revisit subscriptions once
usage logs exist. He answered the billing question by redirecting to the knowledge
idea, so this is unconfirmed and cheap to overturn.

---

## 2026-08-03 — session 2: requirements and the landscape

**Did.** Researched how CodeRabbit and Greptile actually work, benchmarked the
model field, rewrote `SPEC.md` around what came back. Six new decisions (D-7…D-12).
Nothing implemented yet — still deliberate.

**The architecture changed at the root: Claude Code owns the loop, not `lore`.**
`lore` is a stateless single-shot reviewer that Claude Code calls repeatedly until it
exits 0. Everything that must survive between invocations — ladder position, every
finding, every verdict, the learnings — moves to disk. A reviewer that forgot
between calls would restart at the bottom tier every time and re-raise everything it
had already settled; the loop would never terminate. The exit code is now the API.

**Learned — the cheapest tier should not be a model at all.** CodeRabbit runs 50+
analyzers alongside its LLM. My first spec had a model doing work `tsc` does for
free, deterministically, in a second. T0 is now the *target repo's own* toolchain —
its `tsc`, its ESLint config, its tests. Using the target's config rather than ours
matters: our config against someone else's repo manufactures findings their team
already rejected.

**Learned — agentic beats diff-in-a-prompt, measurably.** Greptile's v3 rewrite
reports **70.5% higher comment acceptance** after going agentic. `~/c/review` pastes
a diff into prose, and I had inherited that without questioning it. Reviewers now
get the worktree and tools.

**Learned — GLM-5.2 is dominated from both sides.** At 51 intelligence / $0.69 it
loses to Gemini 3.6 Flash (50 int, $0.56, and 43% faster) on cost and to Kimi K3
(57) on quality for 25% more. Vany's instinct that he was not confident about it was
right. Dropped. Also worth remembering: **the effort knob is a bigger lever than the
model** — GPT-5.6 Sol gives 95% of its capability at 41% of the cost by dropping
max→high.

**Validated from outside.** Greptile published *"Software Needs An Independent
Auditor"*, arguing generation and review must be separate parties. That is D-1,
reached independently by a company with 700K PRs/month. Worth the cost it imposes:
D-1 excludes Claude Opus 5, the strongest model on the board.

**Vany's answers resolved two open questions.** Justifications become `lore-ok`
comments **in the source**, and the *reviewer* rules on whether the reason holds —
which preserves the independent-auditor property. If the reviewed party could close
its own findings, the loop would end when Claude got persuasive rather than when the
code got correct. And specs are reviewed **as code**, with drift a defect in both
directions.

**Assumed, flag if wrong.** His exec-layer answer added the learnings database
without picking an option, and I read "also" as yes-and: full deterministic T0
*plus* the learnings store. If he meant the database *instead of* the tooling layer,
D-8 needs revisiting.

**Surprised me.** `opencode models` lists 360 models including **free
code-specialised ones** (`north-mini-code-free`, poolside `laguna-s-2.1-free`).
Given the requirement is a lot of runs, a zero-cost gate below T1 has real upside
and no downside beyond measuring it.

---

## 2026-08-03 — session 1: scaffold

**Did.** Audited the baseline, grounded opencode's provider/server story, wrote
`SPEC.md`, `PROG.md`, `CLAUDE.md`, `TODO.md`, `research/`, and the TypeScript
project skeleton. No implementation yet — by intent: `SPEC.md` §7 still carries
three `[OPEN]` decisions, and settling those after code exists costs more.

**Learned — `~/c/review` is not garbage.** Vany called it that, and the bash is
indeed disposable, but its header comment is an incident log: nine invariants, each
bought with real debugging time. That knowledge is the asset, and it transfers
verbatim as INV-1…9 (`SPEC.md` §6, detail in `research/prior-art-c-review.md`).
Rewriting without reading it would have re-bought every one of those incidents.

**Learned — subscriptions invert the cost model.** The plan is flat-rate GLM (Z.AI
coding plan) plus flat-rate OpenAI. So the cheap→expensive ladder does *not* save
dollars per token; it saves **rate-limit quota and wall-clock**. Still worth it —
burning T2's quota on something T0 would have caught is what makes the next review
queue — but it changes what the tool optimises, and it makes quota exhaustion a
first-class loud failure rather than a reason to skip a tier.

**Designed — the ledger is the load-bearing part, not the ladder.** Cheap→dear is
the easy half. The half that makes it work is recording *why* each finding was
dismissed, so tier T+1 does not re-raise everything tier T already settled; without
it the loop cannot converge. Corollary worth keeping in view: a justification is
about specific code, so it must go **stale** when that code changes (SPEC §4.4) —
otherwise the design rots into rubber-stamping, which is the failure I would most
expect in six months.

**Surprised me.** Reviewer independence turns out to be a *hard* constraint, not a
cost preference. Claude writes the code here, so an Anthropic reviewer would be
grading its own homework. That rules out the strongest available model for the top
tier, on purpose (D-1).

**Verified toolchain** (TODO T3 done): node 26.5.1, bun 1.3.14, deno, npm 11.17.0,
pnpm, jq, git 2.55.0, gh, tsc 7.0.2. Latest packages pinned as caret ranges:
`@opencode-ai/sdk` 1.18.11 (CLI on disk is 1.18.9 — same release train),
typescript 7.0.2, vitest 4.1.10, `@types/node` 26.1.2. `npm install` is clean, 0
vulnerabilities.

**Chose no build step.** Node ≥24 strips types and runs `.ts` directly, so the
source *is* the binary and `bin` points at `src/index.ts`. The cost is
`erasableSyntaxOnly` — no enums, namespaces or parameter properties — which is a
constraint `PROG.md` wanted anyway (plain data, pure core). `tsc --noEmit` remains
the typechecker. Verified end to end: typecheck clean, test green, CLI exits **70**
with a message rather than exiting 0 with a fake verdict.

**Could not verify:**
- `momus`'s actual prompt. `~/.config/opencode/agents/` holds only `readonly.md`,
  so `momus` is defined inside the `oh-my-openagent` plugin rather than as a local
  file, and a filename search inside the package found nothing. TODO T4.
- `WebSearch` failed all session with a harness error (`effort 'max'` while
  thinking is disabled); `WebFetch` worked and is what grounded `research/`.

**Open, in priority order:** SPEC §9. The one with money attached is §9.4 — verify
that both subscriptions actually expose the needed models through opencode *before*
buying, since the provider docs contradict themselves on exactly that point.
