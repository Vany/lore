# The knowledge layer

**This is the product.** Reviews are how knowledge gets made; sharing it across
sessions is what it is for (D-14).

Every Claude session starts amnesiac. Without this, each one rediscovers the same
conventions, re-raises the same settled findings, and repeats the same mistakes.
The ladder catches defects; the knowledge layer stops them being written twice.

---

## 1. Scope

**Per repo. No cross-repo layer** (D-19). Sessions working on the same repo share
knowledge freely, both reading and writing (D-18).

## 2. Sources, and their precedence

| rank | source | how it arrives |
|---|---|---|
| 1 | **taught** | `knowledge_teach` — a human or session states a rule outright |
| 2 | **ingested** | parsed from the repo's own root rule docs **and every decision record** |
| 3 | **derived** | inferred from accepted `lore-ok` justifications and recurring **fixed** findings |

Higher rank wins on conflict, and a conflict is **recorded, not silently
resolved** — two sources disagreeing about a rule is itself worth surfacing.

### 2.0 What is actually read

Root files — `CLAUDE.md`, `AGENTS.md`, `PROG.md`, `SPEC.md`, `CONTRIBUTING.md`,
`.cursorrules` — **and every `.md` under `docs/adr`, `docs/decisions`, `spec` and
`adr`**, recursively, because decision records get filed into subdirectories once
there are enough of them. Capped at 400 documents per repository, and the cap
announces itself in the log rather than truncating silently.

The directories were the point and were missing. A repository with 37 ADRs had
**eight** rules, all from two root files, while its entire decision record — the
reasoning a reviewer most needs and can least infer from the code — was never opened.
Reading it took that repository to 128 rules.

### 2.1 Ingested docs are a known hazard

A stale document becomes a confidently wrong rule, applied to every future review
and every future session. This is the sharpest risk in the whole design, and it was
accepted knowingly.

Mitigation is mandatory, not optional:

- Every ingested rule stores the **source file and its blob sha**.
- When the file changes, rules derived from it are **re-derived, not retained**.
- A rule never outlives the text that justified it.
- **Nor the reader that produced it.** Every ingested rule also stores the extractor
  version, and a rule carrying an older stamp is retired on the next ingest exactly as
  a rule whose document changed is. Without this half, improving the extractor changes
  nothing already stored: re-ingestion triggers on the source document, and narrowing
  the reader does not change any document. 399 fragments survived that way.

### 2.1.1 Only rule-SHAPED content is a rule

The extractor takes **bullets**, and **paragraphs that are a single sentence**. It does
not mine multi-sentence prose, whatever heading it sits under.

Measured on this repository: `SPEC.md` produced **111 rules, 108 of them from
paragraphs** — from a document that is 1,700 lines of decision *narrative*, where every
incident story is full of "must", "never" and "always" describing what went wrong. They
arrived decontextualised — *"It has to be, because the secret is shown once"*, *"A
required field is therefore free money"* — with their subjects in sentences that were
never captured, and were then shown to every model under *"treat these as this team's
decisions"*. Under the narrowed reader the same document gave **15** and the whole
repository **66 instead of 218** — measured 2026-08-06, and a measurement rather than a
standing figure. `SPEC.md` is edited most sessions, so its yield moves without the
extractor changing; four places once carried that number and three of them disagreed.

A rule is **one statement**. A narrative paragraph sets something up, says what
happened, and draws a conclusion — and it is the middle sentences, lifted out alone,
that arrive with nothing to attach to. A document that states its rules one to a line
still works, which is the common shape for a `CLAUDE.md`.

Two further refusals, both measured against what was live in the store:

- A statement beginning with a **dangling referent** — *it, this, that, they, therefore*
  — has its subject somewhere that was not captured.
- A statement **starting mid-sentence** is a clause whose beginning is gone.

The two are asked of **different text**, and that is not an implementation detail. A
dangling referent is about meaning, so it is judged on the markup-stripped statement:
`**It** has to be` is the same fault as `It has to be`. A mid-sentence start is about how
the author wrote it, so it is judged on the text **as written**. Judging it after
stripping cost real rules — `` `fast_clean`, `failed` and `expired` are distinct states,
never blended into "not passed" `` is a bulleted rule with a modal that became a
lowercase `f` and was refused as a lifted clause, and it had been in the store under the
previous reader. Backticks are an author saying a statement starts here; emphasis is not,
so leading `*` and `_` come off first or an italicised clause walks straight through.

A heading cannot rescue a paragraph, and the first attempt at this tried: taking
paragraphs under a rule-ish heading changed nothing, because `SPEC.md`'s
`## 5. Decisions` spans 1,800 lines. The known loss is an ADR's `## Decision` paragraph,
which really is the rule; `knowledge_teach` states one in a single call.

### 2.1.2 A model vetoes what the reader mined (D-81)

The shape test took this repository from 423 live ingested rules to 61, and about a
fifth of the survivors are still not rules. Two further deterministic narrowings moved
that to 18% and stopped: what remains differs from a rule by **what the words mean**, and
every rule sharp enough to separate *"Cost. A conversation re-sends its accumulated
context every turn"* from *"Handles are CSPRNG-generated, never sequential"* also refused
real rules.

So the cheapest model tier is asked, once per document: **which of these are not rules?**

- **It only removes.** Extraction stays a pure function of the document — free,
  deterministic, the same answer twice. The model picks a subset of what came out.
- **It is asked for the FAILURES, never the survivors.** A model listing what to keep
  drops items it did not get to, and each omission silently deletes a rule; listing what
  fails means an omission keeps one. The prompt says the errors are not symmetrical and
  says why, because a model told merely to be careful balances them.
- **A refusal is recorded.** Each rejected candidate is written as a knowledge row that
  is born retired, carrying the model's reason (`retired_reason: screened out: …`). It is
  never live and no reviewer sees it, but *"why is that rule not in the base"* has an
  answer — which is the whole objection to filtering, since a rule that never arrives is
  otherwise invisible for ever.
- **It fails open, and says so.** Unreachable, out of quota or unparseable, every
  candidate is kept and the rows are stamped `<version>-unscreened` — never as though a
  screen had passed them, because a broken classifier must not read as an approving one.
  The next ingest retires that stamp and re-screens. The knowledge base is the product
  and is never emptied to protect a filter; the stamp is what stops *kept for now*
  becoming *kept for ever*.

**The reader of a row is BOTH halves, and the stamp names both.** `knowledge.extractor`
carries `<extract>.<screen>`. Versioning only the extractor recreated the trap the stamp
was built to close, one layer up: the prompt, the contract or the tier could change and
nothing already stored would move, so an unchanged document kept an old screen's vetoes
for ever and a wrongly-refused rule stayed invisible — exactly what the decontextualised
fragments did before any stamp existed. The next planned change here is *measure the
screen, then improve the prompt*, which walks straight into it.

**Cost.** One call per document, and only for a document whose text or reader changed —
`ingestDocs` asks that first, because it runs on every review and almost always finds
nothing changed.

**One fault ends the pass.** A tier that could not answer is not asked again for the
remaining documents; they are stamped `unscreened` without a call, and the next ingest
retries them. Failing open per document was the right answer to the wrong question: it
kept the memory intact and made the *cost* of a dead provider proportional to how many
documents happened to change. On 2026-08-08 t1's plan was exhausted, six documents had
changed, and a review sat in the screen for the full hang deadline on each of them —
four and a half hours before any tier was asked anything. The answer was known after the
first call and re-bought five more times.

The split is between the TIER and the DOCUMENT. `TooLargeForTier` is about this
document's prompt — the next may be a tenth the size and screen perfectly — so it does
not condemn the pass. An exhausted plan, a rejected key, an unreachable opencode or a
hang are properties of the tier, and none becomes untrue by asking about a different
file. Erring toward stopping is the cheap direction: stopping wrongly costs one ingest's
screening, recovered on the next review; continuing wrongly costs the hang deadline per
remaining document, before the review has started.

**IT RUNS IN THE BACKGROUND, AND NO REVIEW WAITS FOR IT (D-89).** The screen used to run
inside `runRound`, before the tier. That put a model call which only decides *what the
prompt looks like* on the critical path of every review that touched a document — and let
a dead cheap tier wedge a review before any tier had been asked anything, at the full hang
deadline per changed document.

The review never needed it, and the deployment had already proved so: candidates the
screen has not judged are kept, stamped, and **live**, and 27 of 181 live rules were in
exactly that state on a service that had been reviewing for a week. Waiting decided only
*when* the fragments left the prompt.

So the round now extracts and stamps, and an hourly pass judges the backlog. It reads the
**rows**, not the repository — the screen's whole input is a document path and a list of
statements, both of which the rows carry — so it needs no worktree, no mirror and no
opinion about which branch is current, and it judges exactly what a reviewer would be
handed. It queues at the same provider gate as a review, so it cannot starve one.

**Unscreened is therefore a queue, not a fault**, and the operator view says so in yellow
rather than red: it is the ordinary state after any document edit. What no check inside
the service can see is a count that stops falling — that is a stopped screen, and it looks
identical hour to hour from in here.

**A screen session started by a review belongs to it, and can be cancelled with it.**
Historically the first thing to spend a model inside `runRound` that was not the tier, so
`review_cancel` had to be able to reach it — still true of the provisioning screen, and of
any future inline caller. The BACKGROUND pass has no review and so is not cancellable,
exactly as `propose` is not; it stops with the process. The requirement was: without the review id the session is never registered, and a
client cancelling mid-screen is told nothing is in flight — truthfully, by the
bookkeeping — while the screen goes on spending. Registering it was necessary and was
not sufficient: the deployed service passed no reviewer to `startHttp` at all, so no
cancel could reach any session, screen or tier. See `spec/mcp-api.md` on
`stopped_in_flight`. The round also re-reads the review's
state after the ingest, because that check used to be the only one and everything after
it used to be free; without it a cancelled review would still have its tier asked, paid
for, and its state overwritten by a ladder result.

**And the provider gate is a third window, with no session in it at all.** A call can
wait a long time for a slot, and it holds nothing while it waits — so a cancel finds
nothing to abort, says so correctly, and then the slot frees and the queued call spends
anyway. The question is therefore asked at the moment a slot is won and before anything
is created, for the screen **and** the tier: they queue at the same gate and the window
is the gate, not the caller.

**And it is recorded**, under `screen:<tier>` in `usage`, from both callers — the round
and the bootstrap. These were the only model calls in the system with no usage row, so
this section's own cost claim could not be checked against anything, `ops/spend`
under-reported by a whole class of call, and a cheap-tier screen that decided to go
exploring the worktree would have burned minutes of quota leaving no trace. The `screen:`
prefix keeps them out of the per-tier latency distribution `check_back_after_ms` reads: a
screen session is not a review round, and pooling them would promise a waiting client a
four-second answer from a tier that takes ten minutes.

**A failed screen never overwrites a successful one**, which is the concurrent form of
the same rule. Two reviews of one repository can ingest the same changed document
together: if one screens cleanly and the other's provider call fails, the failing pass
finds no unscreened row, retires nothing of the good pass's work — its rows carry the
current blob and reader — and would insert every candidate live and unscreened,
reinstating the very statements the model rejected into every later prompt. There is no
uniqueness constraint on `knowledge` to catch that and no ordering between the reviews to
rely on, so the question is asked once more inside the transaction, while the write lock
is held. A degraded reader may not undo a good one.

**And while it stays down, nothing is rewritten.** The retry is right — one attempt per
document per review is the only thing that heals the base when a provider comes back —
but the pass that follows a failed retry would otherwise retire every unscreened row
(they cannot carry the current stamp, by construction) with the reason *"extracted by an
older reader"*, which is false because the reader never changed, and re-insert the
identical set. One full dead copy of the rule base per review, for the length of an
outage, in the path whose entire purpose is to survive one. So a pass that would write
exactly what is already there writes nothing, and still reports the document as
unscreened.

**A refusal counts as having read the document**, and that is what gives the cost a
floor. The question is *did this reader process this text*, so it is asked of the live
rules **and** the screen's own born-retired rows. Asked of live rules alone, a document
whose every candidate was legitimately refused left nothing behind and looked unread on
every later review: a model call each time, each one writing another identical set of
dead rows — unbounded, in exactly the case where the screen had the most to say.

**Unmeasured.** Whether the model removes the right fifth, and what it wrongly takes with
it, is not yet known. The born-retired rows are what makes that answerable: read them and
count how many should have lived.

### 2.3 A development rule can be appealed to (D-83)

A client answers a finding it disagrees with by writing a `lore-ok` at the site, and the
reviewer ratifies it by not re-raising. That works, and it makes the same argument from
scratch every time — 63 accepted justifications of one semgrep rule on this workgroup's
repositories, each one a fresh act of persuasion about a question already settled.

**An appeal is a different claim.** A `lore-ok` says *trust my judgement about this
line*. An appeal says *you are enforcing a standard this project decided not to enforce*
— a claim about the REVIEWER, not about the code, and one a rule can carry.

**The tier decides.** The cited rule and the appeal go into the next round's prompt; the
model closes the finding by not re-raising it, or rejects the appeal by raising it again.
lore never closes a finding because a rule was pointed at it. The author never closes its
own finding (D-10), and a rule the author also wrote would otherwise be exactly that
route — write the rule, cite the rule, silence the check, with an audit trail that reads
like due process.

**Accepted, it settles the class for that path**, not the single finding: *this engine's
rule is not reported in `src/http.ts`, because `<the rule>`*, carrying the reason the team
gave. Not a demotion — D-67 stands, a true finding keeps its severity. This is about a
check being wrong for a place, said once rather than sixty-three times.

The path is the FILE the appeal was argued about, never a directory prefix. A wider
suppression than the one that was argued is a check switched off in files no tier looked
at, which is the failure this whole mechanism is built to avoid rather than commit.

**A suppression is only as alive as its rule.** The read joins to live knowledge, so
retiring the rule switches every check it bought back on at the next review, with nothing
to sweep — the same shape D-20 gives an ingested rule whose paragraph was deleted. That
covers the individual verdict too: the finding the appeal was actually argued about stops
being carried forward as settled, or `lore rule --retire` would report that every check
now reports again while the one place it mattered stayed silent. The suppression ROWS are
kept when the rule dies; they are the record of what earlier reviews did not cover.

**The verdict records what it rests on**, in `verdict.via_rule` — the rule for an appeal,
NULL for an ordinary justification. That distinction is load-bearing rather than
bookkeeping: an ordinary reason was argued on its own words with no rule beneath it, so
nothing can be withdrawn from under it and it carries forward for ever (D-51). Recorded
rather than inferred, because inferring it from the finding's rule class and path also
caught ordinary justifications that merely shared a class and a file with somebody else's
appeal, and re-opened them for a rule they never cited.

**Only a T0 finding, and only one that names a rule.** A model tier's finding has no
engine rule at the head of its claim, and re-raising it is judgement rather than a pattern
re-firing — silencing a class of those would be silencing a kind of thought. Neither does
a claim that is a sentence: `\`npm test\` fails on this branch` yields no class, so nothing
appeals its way past a red suite.

**Consulted before T0 reports, and never silently.** The engines run and their findings
are filtered before anything is recorded — which is where the saving is, since a suppressed
finding never resets settling, never costs a round, and is never re-argued. Every one lands
in `checks_skipped` naming the engine rule, the path, the development rule and the date,
so a reader of a later `passed` can see what it does not cover and go and argue with the
rule instead of with the review.

**INDICATED IN THE PROMPT, NOT RECITED.** Every other kind of rule is injected under
*"treat these as this team's decisions"* — up to sixty of them, and a fifth were
fragments before D-81. Development rules would double that to say something no reviewer
needs until somebody cites one.

So the prompt carries their EXISTENCE and their STANDING: this project has N development
rules, and a `lore-ok` citing one is team policy rather than an opinion. **The text
arrives with the appeal**, in full, because that is the only moment it is relevant and
the tier must rule on what was actually written.

**Any token holder may add one**, recorded with who and when — the trust
`knowledge_teach` already extends. It is safe because a rule silences nothing by itself;
it can only be argued. `knowledge_retire` withdraws one, and the reason is kept: it is
what a later reader gets when they ask why a check came back. An operator with no token
reaches the same two doors through `lore rule`, which lists every rule beside the checks
it is currently silencing — separately those two mislead in opposite directions, a rule
list reading as harmless prose and a suppression list as unexplained holes.

**How a client cites one:** `lore-ok[<fingerprint>]: rule <id> — <why it covers this
code>`, in any of the three comment forms the parser already reads, including the
markdown ledger. No new tool: the docs are the interface, and a fourth call an agent must
learn costs more than a fourth shape in a parser that has three.

**Still open:** whether a model can originate the opposite claim — *this rule is wrong*.
Today a tier can say nothing but findings, which is the same gap that leaves the
escalation path unwired, and it is worth solving once for both.

### 2.2 A recurrence is only a lesson once the repository has answered it

### 2.2.0 An accepted justification is a verdict, not a rule

It used to be written as both. A `lore-ok` reason is addressed to one reviewer about one
finding — *"correct, this was NOT in the ticket, which asked for four other fixes"* — and
as a knowledge row it loses the finding, leaving a sentence with no subject presented as
a team decision.

Nothing is lost by not storing it. The reason is already in every prompt **with its
finding** through the settled block, and it already outlives its review (D-51) because
carrying reads the **verdict** table across the repo's reviews by fingerprint, never
knowledge. What the loop genuinely learns is the *pattern*, and that is §2.2.

A cluster becomes a `mistake` rule only from findings the repository **fixed**. Not
from findings it justified away, and not from findings nobody has answered.

Ignoring the verdict inverts the lesson. A semgrep pattern on a mock URL behind `msw`
was raised and justified away dozens of times, and this derived *"This codebase
repeatedly produces CWE-319 findings. Check for it explicitly"* — which then entered
every future reviewer's prompt, telling the model to hunt harder for exactly what the
team had already ruled out, with confidence rising each round. Noise manufactured and
then amplified. Every derived rule in the deployment on 2026-08-06 was of this kind:
seven rules, not one backed by a single `fixed` verdict.

An unanswered finding is not evidence either way, and guessing is what produced the
backwards rule. A `justified-rejected` finding is a real defect that stands, but it is
not one the team has acted on, so it does not teach a rule yet either — deliberately
conservative, because a wrong rule here is injected into every future session.

### 2.3 A fact is learned once, however often it is re-derived

`promoteRecurring` (§3, `derive.ts`) runs after every review, over every review this
repository has ever had — so the SAME cluster crossing the promotion threshold is
recomputed on every single run, not just the review that first reached it. What stops
that from writing a duplicate `mistake` row each time is a provenance key
(`recurrence:<cwe-or-claim>:<key>`, one per cluster) checked for existence, not
re-derived from scratch: a cluster this repository has already promoted is a fact
already on record, and promoting it again would not teach anything the first row
did not.

**"Already on record" means the provenance was ever used, live or retired — not
merely live right now.** A `mistake` row's one real retirement path is a person or
model resolving a conflict against it (§7): a deliberate decision that the derived
lesson was wrong. Checking liveness instead of existence made that decision
self-undoing — the very next review's `promoteRecurring` saw no LIVE row for that
provenance, concluded the cluster had never been promoted, and silently re-inserted
the identical statement, undoing the resolution it had just lost.

## 3. What is stored

- **rules** — conventions and constraints. *"Amounts are integers in minor units,
  never JS numbers."*
- **code facts** — what a module does, its invariants, its seams.
- **mistakes** — recurring fingerprint clusters. The fourth occurrence of a defect
  is not four bugs; it is one missing rule, and that promotion should be automatic.
- **history** — what was raised, fixed, justified, and how often it recurred first.

Every item carries: source, provenance, verification date, confidence. The schema
also has `scope` columns (file blob sha + hunk hash, the same shape `finding` and
`verdict` use for theirs) — unused by anything for `knowledge` specifically, not a
built path yet (see §4).

## 4. Staleness

**Built, for a document-sourced item: when the TEXT that justified a rule changes,
the rule is re-derived, never retained** (D-20, §2.1) — `source_blob` on the row,
checked on every ingest. This is the whole of what exists today.

**Not built: invalidation when the CODE an item describes changes**, as opposed to
the document that stated a rule ABOUT code. A `bootstrap`-written fact ("the sweeper
releases holds after 7 days", confidence 0.5, no source document at all) or a taught
rule with no `path` scope to a document has nothing that retires it when the code it
was true of stops being true — the `scope` columns named above exist for exactly
this and are not yet populated or checked by anything. Decided, not built: a
knowledge base that only accumulates will eventually confidently describe code that
no longer exists, and unlike a stale comment it is injected into every future
session automatically — rot here is worse than in any other component, because it
propagates. Flagged rather than silently assumed solved, found by lore's own
review: this section used to describe the mechanism as standing behaviour, which
it is not.

A separate, narrower guard exists for the moment a `fact` is *written*, not for its
staleness afterward: `bootstrap` reads whichever branch happens to be a repo's first
review, so its facts are a model's own, unconfirmed reading of ONE branch — and the
prompt says so. `knowledgeBlock` (`reviewer/prompts.ts`) renders `kind: "fact"` under
an explicit "unverified, not a team decision" caveat, never folded into "treat these
as this team's decisions" the way a `rule` is (found by lore's own review, 70b88761).
Neither guard makes the other unnecessary: the caveat says a fact was never
confirmed; staleness (above) is about a fact that WAS true and stopped being.

## 5. Use

**At review time** — findings are enriched with their history, and **the history has to
ask for something** (D-79).

It used to say only *"seen 23× before in this repo — this is a pattern, not an
incident"*. True, and an adjective: it named a pattern and requested nothing, so a
client answered the single line in front of it and met the same finding next review.
Measured across this deployment: one semgrep rule raised **63 times and justified away
63 times**, never once escalated to a person. The count was never the useful part.

So the prior **verdicts** decide the question, because the two histories want opposite
answers and only one is fixable by editing the line:

| what happened before | what to ask now |
|---|---|
| mostly `fixed` | fix this instance, then ask what keeps producing it — a rule, a lint or a helper, because an Nth manual fix is not the answer |
| mostly `justified-accepted` | the **check** may be wrong here. Answer it as usual, then tell the user it keeps misfiring: only a person can decide to stop it |
| unsettled | a pattern rather than an incident — worth asking why it recurs, not only fixing it here |

A finding with history is far more actionable than the same finding raised cold, but
only if it says what to do differently.

**At any time** — `knowledge_query` (D-18). A session asks what is known about a
path, a module or a pattern before writing code.

## 6. Concurrency

Parallel sessions on one repo write concurrently. Writes are append-only with
conflict detection; two sessions asserting contradictory rules produces a recorded
conflict, never a silent last-write-wins. A knowledge base that quietly loses
writes is worse than one that has none, because nobody knows what it forgot.

## 7. Conflicts are problems to be solved (D-39)

A contradiction between two rules is **not** resolved by the store. It becomes a
**finding**, of kind `knowledge-conflict`, raised in the next review that touches
the affected code.

**Newer leans correct, but only leans.** Code evolves, so a later rule is usually
the truer one — that is a prior, not a verdict. A recent rule written carelessly
must not silently overwrite an older one that was reasoned through.

**Detection is a heuristic and is tuned to stay quiet where it cannot tell.** Two
rules conflict when they share a subject (token overlap) and have opposite polarity.
Polarity counts negations, and double negation cancels **within one clause only** — a
statement whose clauses pull different ways is reported as *undecidable* and compared
with nothing.

That last rule is not fastidiousness. Cancelling across a whole sentence made a
compound assertion come out as its own opposite: *"the seam holds no balance and never
calls the ledger"* read as positive, its own restatement in another ADR read as
negative, and the two were recorded as a contradiction. It stopped a real review whose
findings were all settled, and demanded a person for a question that did not exist.

The trade is deliberate: a missed conflict leaves two rules to be caught later, while
a false one stops a review and calls for a human. It will also miss contradictions
phrased without an explicit negation — *"amounts are integers"* against *"amounts are
floats"* — and those need a model or a person to spot.

### 7.1 Resolution

The reviewing agent must actually resolve it: read both rules, read their
provenance, read the code as it now stands, and decide — recording *why*. A resolved
conflict retires the losing rule with its reason preserved, so the decision is
reconstructable later.

### 7.2 Escalation to a human — only when the two cannot be ordered (D-39, revised)

**Decided, not built.** Today *every* detected contradiction calls a person. What
follows is the rule that replaces that, and the tense matters: the columns it needs
exist, the logic does not, and the work is open in `TODO.md`. Written in the present
tense first, which a reviewer caught immediately — an unbuilt rule described as
behaviour is this repository's most common defect and it does not stop being one
because the decision is sound.

**A person will be called only when neither rule can be shown to supersede the other.**
Two orderings the store already records, neither yet consulted for this:

1. **Source rank** — `taught` > `ingested` > `derived` (§2). Different ranks settle it.
2. **Recency** — `verified_at`. Same rank, later wins.

Only when both tie — same rank, no usable difference in time, which is what two rules
re-ingested from one document revision look like — is there genuinely no way to tell
which is current, and only then is a person asked.

This narrows an earlier rule that stopped on *every* detected contradiction. The
production record is one escalation, and it was wrong: two ADR sentences restating one
constraint, halting a review whose findings were all settled. The errors are not
symmetric — a wrong escalation stops a review and spends a person, while a wrong
auto-resolution retires a rule **with its reason preserved** (§7.1) and can be read
back. With a heuristic at one for one, stopping is the more expensive mistake.

**And the agent is not the one deciding this today.** `needs_human` is set from
`openConflicts` alone; the reviewing model is shown the contradiction, told to resolve
it or say it cannot, and its answer is not parsed and changes nothing — there is no
field in the findings contract for it and reviewers hold no lore MCP. Stated here
because this section previously described agent agency that does not exist, which is
the defect this project is most often guilty of. What to do about it is open in
`TODO.md`.

While any `needs_human` finding is open:

- the review **cannot reach `passed`**, and
- it **cannot be attested**, and
- it **cannot be closed with `lore-ok`** — a justification is a claim about code, and
  this is a question about which of two rules is true. Nothing may write its way past
  it.

**This is still the only place the system stops and asks for a person** — that has not
changed, and it is why the block is absolute. What changed is *when* it fires: not on
every contradiction, only on one that cannot be ordered. Two contradictory beliefs
about the same code are the failure mode most likely to poison every future session
(§4), and guessing is what would poison it — but so is stopping on a pair a timestamp
could have separated.

### 7.3 Stopping must have an exit

A block with no way to clear it is a trap, not a safeguard. So `knowledge_resolve`
settles a conflict — retiring the losing rule **with its reason**, never deleting it
— and `knowledge_escalate` records that a person is required, which deliberately does
not unblock.

**`knowledge_resolve` re-queues the reviews that were waiting**, and reports how many
in `resumed_reviews`. That had to be built for this section to be true. It used to say
the ladder "recomputes `needsHuman` from currently-open conflicts on every round rather
than latching it forever" — correct, and unreachable, because nothing scheduled the
round that would do the recomputing. A client that resolved the conflict and waited,
exactly as instructed, waited for something never enqueued; `needs_human` is not a
terminal state, so the staleness sweep turned the review into `expired` two days later.
An exit sign over a wall, and the review of the commit claiming otherwise is what found
it.

**It re-queues them only when the LAST open conflict is settled**, and says how many
remain in `conflicts_still_open`. The recomputation above is repo-wide — a parked review
is blocked by every open conflict in the repository, not by one it could name — so
resuming while another is unsettled buys each review one paid round and parks it again
at the end of it, while `resumed_reviews` reports movement that is not happening. The
same review, one round later, found the second wall behind the first.

**`knowledge_escalate` is not a one-way door**, though it was one until that same round.
`resolveConflict` matched only `open`, so the state a person is called to settle was the
one state nothing could settle — and once the gate above counted escalated conflicts as
blocking, the reviews behind one could never resume and the reply told the client to do
something the API refused. The exit is what this section always said it was: a person
decides, the client calls `knowledge_resolve`.

**A SECOND exit exists, found by lore's own review (de741489): a conflict does not
only close through `knowledge_resolve`.** An ordinary document re-ingest can retire
either side of it — the D-20 re-derive path, ready to fire on any change to the
document that stated the rule, and unaware a conflict was recorded against it at all.
Before this fix, `resumeNeedsHuman` was called from exactly one place —
`knowledge_resolve`'s own `decide()` — so a review parked on a conflict closed this
second way had nothing that would ever re-queue it: `review_poll` correctly reported
`open_questions: []`, and its own text told the client to call `review_submit` with
"an empty diff", which the tool's schema refuses outright. Stuck until the 48h
staleness sweep expired it, having concluded nothing, while every text said nothing
was blocking it. `review_poll` now performs the SAME check `knowledge_resolve` does —
is this review's repository free of every open conflict — and calls `resumeNeedsHuman`
itself when it is, so a review closed this way resumes on its very next poll rather
than waiting for an action that was never coming.

**`keep`/`retire` resolve a SHORT id or a full one, and the two may be mixed —
found by lore's own review (b1a9841c).** `resolveConflict` matched them with exact
equality while every other id-comparison path this project has (`knowledge_retire`,
an appeal's `lore-ok[...]: rule <id>` citation) resolves a prefix, refusing only
genuine ambiguity. A client naturally ends up holding one rule in two lengths — a
full id from `open_questions`, an 8-char `cite_as` from `knowledge_teach` — and
mixing them is the obvious thing to do with two names for one rule. The exact match
failed silently on exactly that mix: "no open conflict between X and Y", on a
`needs_human` review a person had just decided, with nothing naming the length
mismatch as the cause. Both ids now resolve through the same prefix lookup
`knowledge_retire` uses before the conflict is looked up, so a full id (a prefix of
itself) and a short one behave identically either way round.

**`review_inbox` performs the same check too, found by lore's own review (c8d63c13):
the poll fix alone still left one route to the trap.** The inbox is where a client
looks FIRST each session, ahead of polling any one review by id, and it kept its own
copy of the old, now-impossible instruction — "call `review_submit` on it (an empty
diff is fine)" — for exactly the state `review_poll` had just been taught to resume
on its own. A client that only ever calls the inbox, never polling the parked review
directly, had no route to the earlier fix at all: told to submit an empty diff, told
the truth about nothing being open, and refused by the tool it was told to call.
`review_inbox` now resumes before building its response, the same as `review_poll` —
so by the time either surface answers, a review this repository has stopped blocking
is never still reported as `needs_human`.

