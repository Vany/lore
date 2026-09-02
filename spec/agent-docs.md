# Documentation for agents

**The client is an agent, so the docs *are* the interface.** There is no support
channel, no README a confused caller will go and read. Whatever the tool
descriptions fail to say, the agent will guess — and it will guess wrong in
predictable ways (§2).

Protocol facts: `research/mcp-service-design.md` and the MCP spec revision
`2026-07-28`.

---

## 1. Three layers, with different costs

| layer | when read | cost | carries |
|---|---|---|---|
| **standing instructions** | at connect, before any tool is chosen | **permanent context** | what a session must know before it decides anything |
| **tool descriptions** | always, every session | **permanent context** | what an agent must not get wrong |
| **resources** | on demand | free until read | reference detail, audit trails |
| **prompts** | user invokes | free until invoked | whole workflows, as slash commands |

The split follows the cost. A tool description is in the context window for the
entire session whether or not the tool is called, so it carries only the
**must-know**; everything else moves to a resource. A 400-word tool description is
not thorough, it is a tax on every turn.

**The top layer is new (D-141), and what separates it from the row below is SALIENCE,
not reach.** The table above is right: a tool description is in context for the whole
session whether or not the tool is called. What it is not is a standing instruction —
it is consulted while CHOOSING a tool, so a rule inside one arrives as a reason to call
that tool rather than as something to check before deciding what to do at all. The
sessions that abandoned reviews on 2026-09-02 had `review_inbox`'s "THE FIRST CALL OF
EVERY SESSION" and `review_start`'s "FINISH WHAT YOU START" in context throughout, a
paragraph deep in two of a dozen descriptions, and stopped mid-loop anyway. That leaves
two expensive readers unserved in practice: the session that never asks what an earlier
session left open, and the session that submits a fix and treats the acceptance as the
ruling. `InitializeResult.instructions` is the only string that
arrives before a tool is chosen, so it holds exactly the facts that cannot be looked
up by a reader who does not know they are missing — ask the inbox first, a submit
starts a round rather than answering one, and `review_cancel` is the honest exit for a
session that cannot stay. It is `SERVER_INSTRUCTIONS` in `src/mcp/docs.ts`, part of
`everyClientDocument()` so that every drift guard reads it too, and its delivery is
asserted against a real `initialize` in `src/service/http.test.ts` — a standing
instruction the server does not send breaks nothing visible, which is why the wire is
what gets tested rather than the constant.

---

## 2. The failure modes the docs exist to prevent

<!-- lore-ok[663b9332]: fixed elsewhere, not on this header line — item 10 below,
     added the same round this was raised. -->

Written first, because each one is why a specific sentence exists.

1. **Polls once, sees `running`, concludes the review is clean.** The single most
   likely failure, and it silently ships unreviewed code.
2. **Treats `failed` or `expired` as "nothing found".** INV-1, now exposed across a
   protocol boundary where we cannot enforce it — only state it.
3. **Re-fixes findings it already fixed**, because it did not register that polls
   return deltas.
4. **Sprays `lore-ok` comments** to make inconvenient findings disappear.
5. **Never queries knowledge**, so the memory that justifies the whole service goes
   unread.
6. **Gives up after two rounds**, treating repeated findings as failure rather than
   as the process working.
7. **Reads `fast_clean` as `passed`** — failure mode 1 wearing the two-stage
   review's clothing.
8. **Answers a `needs_human` question itself**, because agents are built to be
   helpful and stopping feels like failing.
9. **Summarises the ticket instead of pasting it**, or substitutes its own account
   of what it built — which destroys the only independent statement of intent the
   reviewers have.
10. **Treats `passed`/`passed_partial` as the end of its whole task and stops
    there**, not just the end of this one review — the exact opposite of what a
    clean or partial verdict should prompt.
11. **Treats `review_submit` as the answer rather than as the start of another
    round** — sends the fix, reports it as reviewed, and never returns for the
    ruling. Measured 2026-09-02: of the reviews left abandoned on the deployment,
    most had been driven correctly for three to six rounds and then stopped
    mid-loop, three of them within three minutes of each other — one session
    ending, not three clients giving up — and three more were started and never
    collected at all. The sentences that would have told them were in context the
    whole time, one paragraph deep in two of a dozen tool descriptions; being in
    context is not being read as a rule (§1).

---

## 3. Tool descriptions

Draft text. These are the deliverable, not a summary of it.

### `review_start`

> Begin an independent multi-model review of `branch` against `into`.
>
> <!-- lore-ok[45d7c573]: fixed here, same round it was raised — the folder-mode
>      paragraph immediately below. Verified directly against the current file. -->
> **Folder mode is the alternative to a diff (D-130).** Pass `mode: "folder"` and
> `path` instead of `into` to review what is AT a path — no base, every file in it
> read as it stands rather than as a change. `into` and `path` are mutually
> exclusive. `path` is required when `mode` is `"folder"` and has no default to the
> repository root — pass `"."` to mean the whole tree explicitly.
>
> **`ticket` is required** — the text of the task this change implements. Without it
> the reviewers can only ask whether the code is correct, never whether it is the
> code that was asked for. Paste the ticket body; do not summarise it, and do not
> substitute your own description of what you built.
>
> Returns a `review_id` **immediately**. The review takes minutes — this does not
> mean it finished. Call `review_poll` until it reaches a terminal state.
>
> The review is pinned to the branch as it stands now. Commits you push afterwards
> are **not** included; start a new review for those.
>
> **Push first.** lore reads its own mirror of the remote, kept current by a process
> on its host, so a commit that exists only on your disk is not in the review. You are
> asked to refresh nothing.
>
> **One review per branch.** A branch that already has an open review is refused, and
> the refusal names the one to continue — `review_submit` advances it. Restarting
> discards every ratified justification and re-pays the cheap tiers, which is why the
> deep tiers were so rarely reached. `restart: true` is the deliberate way through
> after a rebase.
>
> Expect several rounds of findings. That is the process working, not failing.

### `review_poll`

> Fetch findings discovered since your last poll.
>
> Returns **only new** findings. A finding you have already seen will not appear
> again — do not re-fix anything absent from the response.
>
> States: `queued`, `running`, `findings_ready`, `awaiting_diff`, `fast_clean`,
> `needs_human`, `passed`, `passed_partial`, `failed`, `expired`.
>
> `passed_partial` means every tier that *could* run agreed, but one or more could
> not be paid for. Real evidence, weaker evidence — report it as what it is, and the
> attestation names the tiers that were skipped.
>
> `needs_human` carries **`open_questions`** — the question itself: two statements
> this repository holds that cannot both be true, in full, with their sources. Take
> them to a person; do not answer them yourself, and do not close one with `lore-ok`.
>
> A finding marked **`preexisting`** is in a file your branch does not touch, and the
> pattern was already there — every other branch gets it too. Real, worth a ticket,
> not yours to answer here. These sort last on purpose; do not re-sort by severity.
>
> **Only `passed` means the branch is clean.** Reaching it, or `passed_partial`,
> closes THIS review, not your task — attest it, then carry on with whatever else
> you were asked to do.
>
> `failed` and `expired` mean the review did not complete; they are not "nothing
> found". Never merge on them. `failed_because` carries the reason — repeat it
> verbatim rather than inferring a cause from the word `failed`. Most reasons are
> operational and name their own fix.
>
> `fast_clean` means only the cheap tiers have finished. The deep tiers are still
> running. It is **not** a pass.
>
> `needs_human` means a question was found that you must not answer yourself —
> currently, two recorded rules about this code contradict each other. Ask a person.
> Do not guess, and do not close it with `lore-ok`: a justification is a claim about
> code, and this is a question about which belief is true.
>
> While `queued` or `running`, wait and poll again — start at 10s, back off to 60s.
> An absence of findings so far is not a clean result.
>
> Every finding carries `fingerprint`, `file`, `line`, `symbol`, `severity`, `claim`,
> `evidence` and `failure_scenario`; `cwe` and `history` when they apply. Then exactly
> one of three shapes, which *is* the instruction:
>
> * `justify_with` alone — open, unargued. Fix it or answer with that line.
> * `justify_with` **and** `justification_rejected` — open, and a reason was already
>   refused. Fix the code or give one that holds; repeating the refused one is the
>   single move guaranteed to fail.
> * `settled` and `settled_because`, with **no** `justify_with` — closed. Nothing to
>   do. It is shown because it is new to you, usually a justification this repository
>   ratified earlier and carried forward. Writing a `lore-ok` duplicates the marker
>   already in the file.
>
> `open_count` is the whole review, not this poll.
>
> `checks_skipped` lists deterministic engines that did **not** run, with
> `checks_skipped_note` beside it in prose; both are absent when they all did. Not a finding and not a failure — it narrows what the review is
> evidence of. Typecheck and lint disappear silently when a target's dependencies do
> not install, so this is the only place their absence is stated.

The three shapes are the reason this is a doc and not a schema comment. A client that
sees only `claim` and `severity` will treat a closed finding as work and re-justify
something already justified — which costs a round and adds surface for the next tier
to review.

### `review_submit`

> Submit your fixes as a unified diff, with the git tree hash of your working tree
> after applying them.
>
> Applied to the review's private worktree. Nothing is committed or pushed — your
> history stays yours. The `tree_hash` is verified after applying; a mismatch fails
> loudly rather than reviewing code that exists nowhere.
>
> Send a pushed `commit` instead of a `diff` if you cannot build one — inherited a
> review, or a rebase made a diff hopeless. Exactly one of the two, never both; lore
> syncs with origin and works out the delta itself (D-124).
>
<!-- lore-ok[bc8401a9]: true because the cause was fixed at the other site the finding names, src/mcp/server.ts — refresh now runs between a failed resolve and the refusal, not after it, so a just-pushed commit is retried against a fresh mirror before being refused. -->
>
> For a finding you believe is **wrong**, do not skip it silently. Write at the
> site:
>
> `// lore-ok[<fingerprint>]: <why this code is correct>`
>
> The reviewer decides whether your reasoning holds. Accepted, the finding closes
> and becomes a project rule. Rejected, it returns at **higher severity** — a wrong
> justification is worse than a bug.

### `review_inbox`

> Deep findings across **all** your open reviews, since you last collected. Use this
> rather than polling each review individually once you have several in flight.
>
> **Surface `needs_human` and high-severity findings to your user through whatever
> alerting you have.** Do not merely log them. `lore` cannot notify anyone — it
> returns information and you decide what deserves attention. A finding nobody sees
> is a finding nobody found.

### `review_attest`

> Available once state is `passed` **or** `passed_partial` — the partial case is
> the one that most needs a record: the line names which tiers were skipped and
> how many distinct vendors actually read the code. Refusing to attest a partial
> would leave no account of it at all, which is worse than an honest incomplete
> one. Returns one signed line recording what was done: tiers run, findings
> raised, fixed and justified, at a tree hash.
>
> It asserts what was checked. It does not assert the code is correct.

### `knowledge_query`

> Ask what is already known about this codebase — conventions, invariants, past
> mistakes, and why past decisions were made.
>
> Call this **before** writing code in an unfamiliar area, not only after a review
> complains. This is the accumulated memory of every prior session on this repo.

### `knowledge_resolve` / `knowledge_escalate`

> Settle a contradiction between two recorded rules, or say that it needs a person.
>
> A review cannot pass while a conflict is open. Read both rules, their provenance,
> and the code as it stands, and decide — a later rule is *usually* truer because
> code evolves, but that is a prior, not a verdict.
>
> The losing rule is retired **with the reason**, not deleted: *"we used to believe
> X, until Y"* is exactly what a codebase forgets and then re-argues.
>
> `escalate` when you have genuinely tried and cannot. It still blocks the review,
> which is the point.

### `review_vex`

> The CycloneDX VEX document for a security review: which known vulnerabilities are
> reachable here, and why not, in a format other tools consume.
>
> `in_triage` means nobody has ruled on it. It is **not** a clearance.

### `knowledge_teach`

> Record something durable about this codebase, with its reason.
>
> Taught rules outrank rules inferred from reviews. Record the *why*: a rule
> without one gets deleted by the next reader who disagrees with it.
>
> `kind: "policy"` is a **development rule** — a decision about what this project does and
> does not enforce. Reviewers are never shown one; they are told how many exist. The reply
> carries `cite_as`, which is how a finding is appealed to it.

### `knowledge_retire`

> Withdraw a development rule that no longer holds, with the reason — which is kept.
>
> The other half of an appeal (D-83): an accepted appeal stops an engine's rule being
> reported for a path, and it holds for exactly as long as the rule behind it does.
> Refused on an ambiguous id, because retiring the wrong rule switches checks back on
> somewhere nobody is looking.

---

## 4. Resources

Custom scheme `lore://`, annotated `audience: ["assistant"]`. Static docs carry
`priority` so a host doing automatic context inclusion picks the right ones.

| uri | priority | contents |
|---|---|---|
| `lore://docs/workflow` | 1.0 | the loop, end to end |
| `lore://docs/lore-ok` | 0.9 | justification format, when it is legitimate |
| `lore://docs/findings` | 0.8 | finding schema, severities, fingerprints |
| `lore://docs/states` | 0.8 | every state, and which ones are terminal |
| `lore://docs/ladder` | 0.5 | the tiers and why escalation exists |

Templates (RFC 6570), for live data rather than documentation:

| template | contents |
|---|---|
| `lore://review/{review_id}` | full audit trail: every tier run, finding, verdict |
| `lore://knowledge/{+path}` | what is known about a path |

Both are implemented as RFC 6570 templates via the SDK's `ResourceTemplate`.

`lore://review/{id}` is deliberately richer than `review_poll`. Poll gives deltas so
the loop stays cheap; the resource gives the whole history for when an agent — or a
human — needs to understand how a review reached its conclusion.

---

## 5. The `review` prompt

MCP prompts are **user-controlled** and surface as slash commands, so this appears
as `/lore:review <branch> <into>`. It exists because the loop is multi-step and
stateful: an agent handed only tools will improvise it, and §2 lists how that goes.

Arguments: `branch` (required); `into` (required unless `mode` is `"folder"`);
`mode` (default `"diff"`; D-130's folder mode, mirroring `review_start` §2.3.3);
`path` (required when `mode` is `"folder"`, refused otherwise).

Draft returned message (branches on `mode` — shown here for `mode: "diff"`; a
folder-mode call opens differently, naming `path` instead of `into`, per
`REVIEW_PROMPT_TEXT`'s own source):

> You are shepherding `<branch>` through an independent review before it merges
> into `<into>`.
>
> The reviewers are models that did **not** write this code. You are not being
> second-guessed by a peer; you are being audited. Treat findings as evidence to
> investigate, not as opinions to argue with.
>
> **The loop**
> 0. `review_inbox()` — FIRST. A review from an earlier session is still open and
>    still yours, and nothing but this call will tell you.
> 1. `review_start(branch, into, ticket)` → `review_id`
> 2. `review_poll(review_id)` — ONE call, then leave and do something else. Come
>    back when `check_back_note` says.
> 3. For each finding: fix it, or justify it with `// lore-ok[fp]: <reason>`
> 4. `review_submit(review_id, diff | commit, tree_hash)` — any time once findings
>    exist, in ANY state including `fast_clean`. A submit while a reviewer is
>    mid-read is HELD, not refused, and handed to it at its next emission.
>    Exception: a `commit` is REFUSED, not held, while an unconsumed `diff` hold
>    is outstanding — send `diff` instead, or wait for that hold to clear.
> 5. Return to 2. Repeat until the state is TERMINAL — `passed`, `passed_partial`,
>    `needs_human`, `failed`, `expired` or `cancelled`. Only `passed` and
>    `passed_partial` are worth attesting, and only `passed` is clean.
>
> **Rules**
> - Polls return only new findings. Never re-fix what is not in the response.
> - `failed`, `expired` and `fast_clean` are not `passed`. Do not merge on them.
> - `passed_partial` is TERMINAL: it will never become `passed`, so looping for
>   that never ends. Attest it, and tell your user the evidence is weaker than a
>   pass, so the decision to merge is theirs.
> - Expect several rounds. A fix does NOT send the review back down the ladder:
>   the tier that raised a finding judges your answer to it.
> - Do not use `lore-ok` to make an inconvenient finding go away. The reviewer
>   rules on it, and a rejected justification returns worse than it left.
> - Before fixing in unfamiliar code, `knowledge_query` it — someone may have
>   already decided this, for a reason.
> - When you learn something durable, `knowledge_teach` it.
> - If the state is `needs_human`, STOP and ask a person. Do not answer it
>   yourself.
>
> When the state is `passed` — or `passed_partial` — call `review_attest` and
> give the user that line. On a partial one, say which tiers were skipped and
> that the evidence is weaker than a pass; the decision to merge on it is theirs,
> not yours. Either way, attesting and merging closes THIS review — carry on
> with whatever else your task needs.

### 5.1 Other prompts

- `explain-finding` — expand one finding with full context and the relevant
  knowledge, for when an agent or human disputes it.
- `catch-up` — summarise what is known about a repo. A new session's first move.

---

## 6. Rules for writing these

- **Say the consequence, not just the rule.** "Only `passed` means clean" is
  ignorable; "`failed` is not 'nothing found' — never merge on it" is not.
- **Write for the agent that will get it wrong.** Every sentence in §3 traces to a
  failure mode in §2. A sentence that prevents nothing is deleted.
- **Never describe unimplemented behaviour.** A tool description is a promise an
  agent will act on; a stale one causes confident, wrong calls.
- **Tool descriptions are a context budget.** Detail belongs in resources.
