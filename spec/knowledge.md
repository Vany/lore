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
decisions"*. The same document now yields 15, and the whole repository 66 instead of 218.

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

### 2.3 A fact is learned once, however often it is argued

An accepted justification adds its reason to the knowledge base — and only if that
statement is not already held. Ratifying the same reason in a later round, or a later
review, is the same fact about the codebase, not a new one.

Nothing checked this until 2026-08-06, and a justification livelock wrote the same
sentence on every cycle: 21 of one repository's 27 derived rules were one reason about
one false positive, each copy then entering the next reviewer's prompt. Matched on the
statement itself, since the statement is the fact; a differently-worded reason for the
same finding is a different claim and is kept.

## 3. What is stored

- **rules** — conventions and constraints. *"Amounts are integers in minor units,
  never JS numbers."*
- **code facts** — what a module does, its invariants, its seams.
- **mistakes** — recurring fingerprint clusters. The fourth occurrence of a defect
  is not four bugs; it is one missing rule, and that promotion should be automatic.
- **history** — what was raised, fixed, justified, and how often it recurred first.

Every item carries: source, provenance, verification date, confidence, and `scope`
(file blob sha + hunk hash) for invalidation.

## 4. Staleness

Same rule as verdicts: **when the code an item describes changes, the item is
invalidated.**

A knowledge base that only accumulates will eventually confidently describe code
that no longer exists — and unlike a stale comment, it is injected into every
future session automatically. Rot here is worse than in any other component,
because it propagates.

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

