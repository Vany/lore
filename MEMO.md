# MEMO — development memory for `lore`

Newest first. Updated at the end of each task: what changed, what I learned, what
surprised me.

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

**Still blocked on a bucket.** Replication is off-device by design — a copy on the
same disk is not a backup — so turning it on needs S3-compatible credentials. The
mechanism, the restore and the verification are all proven; what is missing is
somewhere to put it.

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
