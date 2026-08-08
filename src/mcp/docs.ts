/**
 * The documentation an agent reads.
 *
 * The client is an agent, so **the docs are the interface** — there is no support
 * channel and no README a confused caller will go and find. Whatever these fail to
 * say, the agent guesses, and it guesses wrong in predictable ways.
 *
 * Every sentence here traces to a failure mode below. One that prevents nothing
 * gets deleted.
 *
 * SPEC: spec/agent-docs.md
 */

/**
 * The failure modes these texts exist to prevent, kept beside them so neither
 * drifts:
 *
 *  1. Polls once, sees `running`, concludes the branch is clean. The worst one —
 *     it silently ships unreviewed code.
 *  2. Treats `failed`/`expired` as "nothing found".
 *  3. Re-fixes findings it already fixed, not registering that polls are deltas.
 *  4. Sprays `lore-ok` comments to make inconvenient findings disappear.
 *  5. Never queries knowledge, so the memory the service exists for goes unread.
 *  6. Gives up after two rounds, reading repeated findings as failure.
 *  7. Reads `fast_clean` as `passed`.
 *  8. Answers a `needs_human` question itself, because stopping feels like failing.
 *  9. Summarises the ticket instead of pasting it.
 */

export const TOOL_DOCS = {
  start: `
Begin an independent multi-model review of \`branch\` against \`into\`.

\`ticket\` is REQUIRED — the text of the task this change implements. Without it the
reviewers can only ask whether the code is correct, never whether it is the code that
was asked for. Paste the ticket body. Do not summarise it, and do not substitute your
own description of what you built: an agent describing its own work describes what it
made, not what was asked, which destroys the only independent statement of intent the
reviewers get.

Returns a review_id IMMEDIATELY. The review takes minutes — this does not mean it
finished.

DO NOT SIT IN A POLLING LOOP. Subscribe instead, and go and do something else.

THE REPLY CARRIES THE CALL, in a \`subscribe\` field, with this review's id already in it
— send that rather than assembling one from this description. It is repeated on every
poll that is still waiting, and it is absent once the next move is yours.

TWO SHAPES, AND THE WRONG ONE FAILS SILENTLY. \`subscribe\` is the raw JSON-RPC frame;
\`subscribe_filter\` is the same thing unwrapped, and an SDK's listen() helper takes THAT.
Measured against this service: give listen() the raw params and the acknowledgement comes
back with an empty honoured filter and no event ever arrives — an open, healthy, useless
stream. Give it \`subscribe_filter\` and the wake arrives.

You will be woken by \`notifications/resources/updated\` whenever the review's STATE
changes — and only then. That is the moment there is something for you to do; findings
being recorded mid-round is not, because you cannot submit until the round ends. Read
\`lore://review/<review_id>\` to see what changed; it carries the whole audit trail.
The notification tells you WHEN, that resource tells you WHAT.

THEN POLL ONCE, IMMEDIATELY. A subscription delivers what happens NEXT; there is no
replay of what already happened. If findings landed in the moment before your stream
opened — or you subscribed to a review you found in review_inbox, which is already
sitting in findings_ready — nothing further will ever happen, because the next move is
yours. Subscribe, poll once, then wait.

If subscriptions/listen is unavailable or errors, THAT IS NORMAL AND NOT A FAULT IN
LORE: the method needs a 2026-07-28 connection, and SDK clients default to the 2025 one.
Two failures here look like lore being broken and are not, and both cost real time on
this repository's own reviews:

  * *"not supported by the negotiated protocol version"* — you have to OPT IN to the
    newer era, and can usually just do it. On the TypeScript SDK that is
    \`versionNegotiation: { mode: 'auto' }\` in the client options.
  * *"request timed out"* a minute or two after a SUCCESSFUL acknowledgement — you sent it
    as an ordinary request, so your own client's request timeout applies to the whole
    stream and then cancels the subscription you just opened. Raising the timeout only
    moves the moment. Use your SDK's subscription call, which resolves on the
    acknowledgement and holds the stream: on the TypeScript SDK that is
    \`client.listen(subscribe_filter)\` — the UNWRAPPED shape, see below — and it hands
    back a handle whose \`closed\`
    promise tells you WHY a stream ended — \`remote\` means re-listen.

If neither helps, use review_poll — but do not report it as a fault.
Use review_poll instead — but ONE call at a time, at the interval its own
\`check_back_note\` gives you. That interval is measured from this repository's actual
round times; a tight retry loop is the most expensive thing a client can do here.

RE-READ THE INTERVAL EVERY TIME. NEVER REUSE THE LAST ONE. It answers "how much longer
FROM HERE", so it shrinks as a round ages — a round that has already outlived the
typical one is not another typical one away from finishing, it is nearly done. Caching
the first number is how a client waits twice as long as it needed to.

Check the acknowledgement, do not assume. The ack echoes the subscriptions the server
agreed to serve; if yours is not in it, you are not subscribed and nothing will ever
arrive on that stream.

READ THE NOTIFICATION, not your SDK's handle. notifications/subscriptions/acknowledged
carries the filter the server agreed to. The TypeScript SDK's McpSubscription.honoredFilter
can be empty on a subscription that is working perfectly, so a client that checked the
handle would fall back to polling for no reason at all.

Subscribe only to review ids YOU started. A subscription to somebody else's is
accepted and then silent forever — deliberately, because refusing would confirm the id
is real (D-23). If a stream you expected events on stays quiet, check the id is one of
yours before concluding anything about lore.

PUSH YOUR BRANCH FIRST. lore reads its own mirror of the remote, not your working
copy, so a commit that exists only on your disk is not in the review.

You do not have to refresh anything. A process on the lore host keeps every mirror
current, and nothing is asked of you — an earlier version told clients to run
\`make mirror\` on the deployment host, which is not somewhere a client can reach.

If that process has stopped, a review is REFUSED rather than run against a stale tree.
You cannot fix that from where you are: report the message to your user verbatim. It
names what a person must check on the lore host.

The review pins the branch when its first round begins, which is shortly after this
returns — not at the instant it returns. A commit pushed in that window may or may
not be included, and nothing will tell you which. Push first, then start; for
anything after that, start a new review. Once a review is pinned the mirror is never
re-read, so a later push cannot move the ground under findings already reported.

FINISH WHAT YOU START. A review left in \`findings_ready\` never ends by itself: it
holds a pinned worktree until it is expired as abandoned, and the branch stays
unreviewed. Either answer its findings with review_submit, or leave it knowing the
result is \`expired\` — which means NOTHING was concluded about the code, not that it
was clean.

ONE REVIEW PER BRANCH. Start it once; then answer its findings with review_submit,
which applies your fixes to the SAME review and advances the ladder. Do NOT start a
second review of a branch that already has one open — it is refused, and it names the
one to continue.

That matters more than it looks. The ladder only reaches its deeper, independent
tiers by ADVANCING: findings carry forward, justifications you ratified stay ratified,
and severity escalates where an answer did not hold. A restart throws all of that away
and re-runs the cheap tiers from round 1, so a branch reviewed all day can produce no
verdict at all — which is exactly what happened before this was refused.

Expect several rounds of findings. That is the process working, not failing.
`.trim(),

  poll: `
Fetch findings discovered since your last poll.

Returns ONLY NEW findings. Anything you have already been shown will not appear again
— do not re-fix something absent from the response.

THIS CALL CONSUMES WHAT IT RETURNS, so it answers only for the token that started the
review. A review you did not start is NOT FOUND here, even on a repository you hold a
token for, because polling it would take findings its owner has never seen and nothing
anywhere would say so. review_inbox is how you find what is yours.

USE THIS TO READ, NOT TO WAIT. Subscribe to \`lore://review/<review_id>\` with
subscriptions/listen and you will be woken when something changes; then call this to
collect it. CALL IT ONCE RIGHT AFTER SUBSCRIBING TOO — a subscription carries no
history, so anything that happened before your stream opened is waiting here and
nothing will announce it. The notification says WHEN, this says WHAT. Calling it in a sleep loop is
the fallback for a host that cannot subscribe — it works, and it spends your turn
waiting for something that could have woken you. A host that cannot subscribe is
common, not broken: the method needs a 2026-07-28 connection.

States: queued, running, findings_ready, awaiting_diff, fast_clean, needs_human,
passed, passed_partial, failed, expired.

ONLY \`passed\` means the branch is clean.

- \`passed_partial\` means every tier that COULD run agreed, but the evidence is
  weaker than a pass, for either or both of two reasons:
    * a tier could not be paid for — the cheap tiers found nothing, the dearer ones
      never looked ("we did everything we can");
    * every tier that ran came from ONE vendor, so they share blind spots. Three
      tiers from one model family is one opinion asked three times, not three
      independent reviews.
  Both are real evidence and both are weaker evidence. Say so to your user rather
  than reporting it as a pass; the attestation names which tiers were skipped and
  which vendor, if only one, actually looked at the code.

- \`failed\` and \`expired\` mean the review did not complete. They are NOT "nothing
  found". Never merge on them. **\`failed_because\` says why** — read it and repeat it
  to your user verbatim. Do NOT infer a cause from the word \`failed\`: a guess here is
  worse than silence, because it is confident and it is yours.

  **RETRY AT MOST ONCE, AND ONLY IF NOTHING CHANGED IN THE MEANTIME.** If the second
  attempt fails the same way, STOP. It will fail the third time too. This advice used
  to say "an identical retry frequently succeeds" with no limit, and a client followed
  it exactly: five attempts on one branch across two days, then a report to its user
  that lore's reviewing tier was broken. It was not — the branch was too large for that
  tier's context window, which nothing in the message said. The client did everything
  right and the instruction was wrong.

  So after ONE failed retry, report to your user: the branch name, \`failed_because\`
  verbatim, and that lore could not review it. That is a true and useful thing to say.
  Diagnosing lore is not your job and you do not have the information to do it — say
  what happened, not why you think it happened.
- \`fast_clean\` means only the cheap tiers have finished; the deep tiers are still
  running. It is NOT a pass.
- \`needs_human\` means a question was found that you must not answer yourself.
  **\`open_questions\` is the question** — both statements, in full, and where each
  came from; \`needs_human_because\` says why a review cannot settle it. Take them to
  a person verbatim. This is not a finding about code: it is two things this
  repository believes that cannot both be true, and the answer decides what every
  future session is told. Do not guess, do not close it with lore-ok. When the person
  has decided, call knowledge_resolve with the id to keep — or knowledge_escalate if
  they cannot decide either.

While queued or running, wait and poll again ONCE at the interval \`check_back_note\`
gives. It is not a constant and it is not the tier's average: it answers HOW MUCH LONGER
FROM HERE, measured across this repository's completed rounds, so it SHRINKS every time
you come back and find the round still going.

So re-read it on every reply and never reuse the last one. Cache it, and a round that
runs slightly long costs you a second full wait for an answer that was already written —
on the deep tier that is over ten minutes of nothing.

If it tells you the round has outlasted every recorded run of its tier, that is not a
failure and not a reason to retry or report anything: deep rounds have a long tail, and
there is simply no measurement left to offer you. An absence of findings so far is not a
clean result.

WHAT EACH FINDING CARRIES.

\`fingerprint\` (use it in the lore-ok), \`file\`, \`line\`, \`symbol\`, \`severity\`,
\`claim\`, \`evidence\`, \`failure_scenario\`, sometimes \`cwe\`, and \`history\` — what this
codebase already knows about this defect, which tells you whether to fix the line or
fix the habit.

\`preexisting: true\` means the finding is in a file YOUR BRANCH DOES NOT TOUCH and the
pattern was already there — every other branch gets it too. Real, worth a ticket, not
yours to answer in this merge. **The list is already ordered with these last**, so do
not re-sort by severity alone: an inherited \`high\` is not more urgent than a \`medium\`
in code you actually wrote. \`history\` never changes \`severity\`: a defect seen six times is not
less serious for being familiar, and a rule engine that fires every round is still
telling the truth about the line it fired on. Weigh it; do not discount it.

**WHAT TO DO WITH "seen N× in this repo".** It is not a louder version of the finding
and it does not change what you owe this one. It tells you which of two problems you
have, and they have different answers:

  * **The code keeps doing this.** Fix this instance — and say to your user that it has
    happened N times, because the answer is probably a rule, a lint or a helper, not an
    Nth manual fix. That sentence is the whole value of the number; nobody else is
    going to say it.
  * **This check keeps being wrong here.** Look at how the earlier ones were answered.
    If they were justified and accepted every time, you are about to write the same
    justification again — write it, because that is still the contract, and TELL YOUR
    USER the check is misfiring on this repository. lore cannot yet suppress a rule for
    a path, so a person deciding to is the only way this stops.

Answering the line and saying nothing is the one response that guarantees you see it
again next time. Measured here: one semgrep rule raised 63 times across this
deployment, accepted as justified every time, and never once escalated to a person.

A FINDING IS A QUESTION, NOT A VERDICT. An open one carries \`asks\`: *fix this, or tell
me why it is not a problem*. Both are real answers and the reviewer may be wrong — it
did not write this code and does not know what you know. Disagreeing well is worth more
to this codebase than complying: an accepted justification becomes a durable fact about
why the code is the way it is, and the next session starts already knowing it. What is
not an answer is silence — an unanswered finding stops the review advancing, for ever.

Then ONE of three shapes, and they are the whole instruction:

  * \`justify_with\` present, nothing else — open, nobody has argued about it. Fix it,
    or answer it with the lore-ok line given.

  * \`justify_with\` AND \`justification_rejected\` — open, and you already tried. A
    reviewer read your reason and refused it, so this is worse than a finding nobody
    argued about: the code is still wrong AND an argument for it was believed long
    enough to be checked. \`justification_rejected\` is why it was refused. Fix the
    code, or give a reason that holds. Repeating the rejected one is the one move
    guaranteed not to work.

  * \`settled\` and \`settled_because\`, with NO \`justify_with\` — closed. Nothing to do.
    It appears only because it is new to YOU: often a justification this repository
    ratified in an earlier review, carried forward and accepted without anyone
    re-arguing it. \`settled_because\` names the original reason and when it was first
    decided. Do not write a lore-ok for one of these; the file already has one, and a
    duplicate is fresh surface for the next tier to review.

\`checks_skipped\` appears when something the review would have covered did not reach
you. Three causes, one meaning:

  * a deterministic engine did NOT run — no installed dependencies, no test script, a
    suite disabled for the deployment;
  * a tier produced a finding the schema refused, so this review does not contain it.
    The line says which tier and what was wrong with it. The tier looked at the code
    and saw something; you are not being shown it;
  * **a tier could not hold your whole diff and was given part of it.** Your branch is
    larger than that model's context window, so the diff was cut to fit and the tier
    was told so. It reviewed what it was given and may have read the rest from the
    worktree — but it did not read all of it as a diff. **A \`passed\` on a compacted
    review covers the part that was shown.** The fix is a smaller review: review a
    narrower commit range, or merge in stages. Say this to your user; they are the only
    one who can change the scope.

It is not a finding and not a failure; it narrows what the review is evidence OF. Typecheck and
lint go missing quietly, so this is the only place their absence is stated. Report it
to your user alongside the result: a \`passed\` where the suite never ran means the
tiers that DID run agree, not that the tests do. \`checks_skipped_note\` accompanies it
and says the same thing in a sentence you can pass straight on.

\`behind_by\` appears when the base has moved on: the number of commits it has that
this branch does not. It is not a finding — no edit fixes it — but it BOUNDS what
this review proves. Everything above was checked against the fork point, so a
\`passed\` on a branch that is far behind does not mean it merges cleanly or still
works against the base as it now stands. Report it with the result, and prefer a
rebase and a fresh review before landing.

\`open_count\` is how many findings are still open across the whole review, not just
this poll. It agrees with the per-finding shapes by construction — if the two ever
disagree, trust neither and say so, because that is a bug in lore rather than a
fact about your branch.
`.trim(),

  submit: `
Submit your fixes as a unified diff, with the git tree hash of your working tree
after applying them.

THIS IS HOW A REVIEW CONTINUES. It is the same review, one round further on: your
answers are checked, findings you settled stay settled, and the ladder escalates to a
deeper tier when it should. This — not review_start — is the loop. Starting a new
review instead abandons every justification already ratified and re-runs the cheap
tiers from the beginning.

Applied to the review's private worktree. Nothing is committed or pushed — your
history stays yours. The tree_hash is verified after applying; a mismatch fails
loudly rather than reviewing code that exists nowhere.

SEND THE DIFF EXACTLY AS \`git diff\` PRODUCED IT. Do not trim trailing whitespace,
drop blank lines, or reformat it — a unified diff is whitespace-significant, and a
context line for a blank source line is a space followed by that line's own content.
Losing the last one leaves a hunk shorter than its header claims. Both failures here
name the fault rather than a position, because a line number would point into a string
you composed in memory and cannot open, and both state plainly that NOTHING was
applied — so resend the whole diff, never the remainder.

Send EVERY file you changed. The tree hash covers the whole tree, so a diff missing
one file is refused even though the diff itself applied cleanly.

DIFF FROM THE TREE HASH THIS CALL RETURNS, not from your latest commit. A review is
pinned to the tree it began with plus whatever you have already submitted, so once you
have submitted anything, your branch and the review's tree have diverged. The reply's
tree_hash is what the next diff must be built against.

READ \`will_not_settle\` IN THE REPLY. It lists open findings that name code this diff
did not change. Those CANNOT be settled by the next round however it goes — a tier that
stops raising something it never saw move has changed its mind, not been satisfied — so
if you fixed the cause elsewhere, which is often the right place, say so at the named
line with a lore-ok and submit again. Ignoring it costs a full deep-tier round to learn
the same thing.

For a finding you believe is WRONG, do not skip it silently. Write at the site:

    // lore-ok[<fingerprint>]: <why this code is correct>
     * lore-ok[<fingerprint>]: <reason>          (inside a /** */ block)
    <!-- lore-ok[<fingerprint>]: <reason> -->    (for markdown)

Those three forms are the whole list; anything else is never read. If the file has
no comment syntax at all — JSON, a lockfile, generated output — put it in
.lore-ok.md at the repo root, using the markdown form.

APPEAL TO A DEVELOPMENT RULE when the finding enforces something this project decided
NOT to enforce. That is a different claim from "this line is fine", and it is answerable
by pointing at what the team wrote down instead of arguing again:

    // lore-ok[<fingerprint>]: rule <rule-id> — why it covers this code

Record a rule with knowledge_teach at kind "policy"; the reply gives you the id to cite.
Reviewers are NOT shown your rules — they are told this project has some — so the rule's
full text is quoted to the tier alongside your appeal, and the tier rules on it. lore
never closes a finding because a rule was cited at it: the author does not close its own
findings, and a rule the author also wrote would otherwise be a way to do exactly that.

Writing that PROPOSES a piece of lore. The reviewer decides whether your reasoning
holds. Accepted, the finding closes and your reason becomes a fact this codebase
knows about itself. Rejected, the finding returns at HIGHER severity — a wrong
justification is worse than a bug, because it was trusted.

ANSWER MINIMALLY. Every word you submit is reviewed by the next tier, so a fix is
new surface and a long explanation is a lot of new surface. Measured on this tool's
own repository: ten rounds where each documentation fix wrote more documentation to
fault, against three rounds once the answers got terse.

  * A finding about BEHAVIOUR: change the code.
  * A finding you believe is WRONG: a lore-ok, with the reason that makes it wrong.
  * A finding about WORDING: fix the wording, briefly, or lore-ok it if the wording
    is right and the reader was not.
  * Say the reason once. Do not restate the finding, and do not explain the fix at
    length in a comment — the diff already shows it.

CHOOSE ON WHETHER THE FINDING IS TRUE, NEVER ON WHICH ANSWER IS CHEAPER. It is true
that a settled finding does not restart the ladder while changed code does, and this
text used to tell you to prefer the lore-ok for that reason. That was advice to
optimise for the review ending rather than for the code being right, which is not what
you are here for. A justification for a finding you privately agree with is the one
answer that costs more than either honest option: the next tier reads it, and a
justification a reviewer refuses comes back at HIGHER severity.

Your lore-ok is safe to write at the site. The marker is not part of the code it
defends — adding or removing it does not expire the reason — so putting it where the
reader will see it costs you nothing.
`.trim(),

  cancel: `
Stop a review you started, and take what it has already found.

Use it when the branch has changed under you, the work is abandoned, or you simply do
not want to spend more on it. Stopping deliberately is a legitimate ending and a much
better one than walking away: a review nobody answers holds a pinned worktree until it
is swept as \`expired\` two days later, and \`expired\` is indistinguishable from
"nobody was ever going to come back".

WHAT IT DOES, all of it:

  * the review becomes \`cancelled\` — TERMINAL, and its own state rather than
    \`expired\`, because the two mean opposite things about you: expired is nobody
    came back, cancelled is somebody decided;
  * the ladder stops. No further round is claimed, and a round claimed in the same
    instant finds the review terminal and stops before spending anything;
  * a model call in flight is ABORTED. \`stopped_in_flight\` says whether there was
    one. Abandoning a call does not stop a model — an agent kept reading a repository
    for millions of tokens after lore stopped listening once — so this is the
    difference between cancelling and pretending to;
  * every finding it had already produced is returned, delivered or not. They are
    real: the tiers that ran did read the code;
  * everything it learned about your repository is KEPT. Knowledge outlives the review
    that made it, and cancelling costs you none of it.

WHAT IT IS NOT: a pass, and not evidence the branch is clean. The tiers that had not
run never looked, and what they would have found is unknown. Never merge on a
\`cancelled\` review — report the findings you were given and say the review was
stopped before it finished.

Already terminal is refused rather than silently accepted: there is nothing to cancel,
and the findings are still available from review_poll.
`.trim(),

  attest: `
Available once state is \`passed\` — or \`passed_partial\`, which is the case that
most needs a record: the line names which tiers were skipped and, if only one vendor
looked, which. Refusing to attest a partial review would leave the operator with no
account of it at all, which is worse than an honest incomplete one.

Returns one signed line recording what was done:
tiers run, findings raised, fixed and justified, at a tree hash.

It asserts what was checked. It does NOT assert the code is correct, and you should
not represent it as doing so.

The signature covers a TREE HASH, not a branch name. If the branch has moved since,
the attestation does not describe what is there now.
`.trim(),

  inbox: `
THE FIRST CALL OF EVERY SESSION. Deep findings across ALL your open reviews, since you
last collected.

A review outlives the session that started it. You end; your subscription ends with
you; the review does not — it sits in findings_ready holding a worktree until it is
abandoned after 48h, having concluded NOTHING about the code. That is the dominant
cause of wasted reviews here, measured: nothing obliges a client to come back, and no
notification can reach one that has gone.

So the thing that actually closes the loop is the next session asking what is waiting.
That is this call. Make it before you start a new review — not instead of polling one
you are already driving.

Surface \`needs_human\` and high-severity findings to your user through whatever
alerting you have. Do not merely log them. lore cannot notify anyone — it returns
information and you decide what deserves attention. A finding nobody sees is a
finding nobody found.

IT CONSUMES NOTHING. Counts and a preview, not a handover: the findings stay queued and
you still collect them with review_poll, which is the only call that takes deltas off the
queue. So it is safe to call at the start of every session, and safe for a health check
to call — it used to consume exactly as review_poll does, while saying it did not, which
quietly emptied the queue of every review it listed.

THIS IS THE ONE CALL ABOUT YOU RATHER THAN ABOUT ONE REVIEW. It lists reviews for YOUR
PRINCIPAL on this repository. Note the difference from every other call, which is bound
to the token that STARTED the review (D-78): two tokens issued to the same person on the
same repository share an inbox, and each will see the other's reviews here — but a
review_poll on one of those ids still answers NOT FOUND. Different people never share an
inbox. If you know an id that is not in this list, leave it alone.
`.trim(),

  query: `
Ask what is already known about this codebase — conventions, invariants, past
mistakes, and why past decisions were made.

Call this BEFORE writing code in an unfamiliar area, not only after a review
complains. This is the accumulated memory of every prior session on this repo, and it
is the reason this service exists.

\`count: 0\` DOES NOT mean this service is empty or unconfigured. A repository's
memory is built from its own docs during its FIRST REVIEW, so a repo that has not
been reviewed yet has none — the \`note\` field says which case you are in, and it is
the only thing that can tell you. Read it before reporting anything about lore's
state.
`.trim(),

  vex: `
The CycloneDX VEX document for a security review.

A scanner says a vulnerable package is present; only reading the code says whether the
vulnerable path can be reached. This records that judgement in the standard format, so
tools we did not write can consume it.

Statuses: not_affected (with a justification), exploitable, resolved, in_triage.

\`in_triage\` means nobody has ruled on it yet. It is NOT a clearance — a VEX document
that marks unexamined vulnerabilities as harmless is a signed claim that nobody
checked. The untriaged count is returned alongside for exactly that reason.
`.trim(),

  resolve: `
Settle a contradiction between two recorded rules.

This codebase holds two beliefs that cannot both be true, and a review cannot pass
while one is open. Read both rules, read their provenance, read the code as it stands
now, and decide.

A later rule is USUALLY the truer one, because code evolves — but that is a prior, not
a verdict. A careless recent rule must not overwrite an older one that was reasoned
through.

The losing rule is retired with your reason, not deleted: "we used to believe X, until
Y" is exactly what a codebase forgets and then re-argues.

RESOLVING THE LAST OPEN CONFLICT RESUMES EVERY REVIEW THAT WAS BLOCKED. The reply
carries \`resumed_reviews\` — how many were parked and have now been re-queued. Poll
them; they carry on from where they stopped, they do not start again.

A parked review is blocked by EVERY open conflict in the repository, not by one it
could name, so nothing resumes while any remain. \`conflicts_still_open\` says how
many, and \`resumed_reviews\` is 0 while it is non-zero — that is not a failure and
not something to retry: settle the rest, and the reviews resume with the last one.

Until this existed, resolving settled the rule and scheduled nothing: a client that
resolved and waited for the ladder to continue waited for a round that was never
enqueued, and the review was swept to \`expired\` two days later.

If you cannot decide, use knowledge_escalate instead. Do not guess.
`.trim(),

  escalate: `
Say that a contradiction needs a person.

Use this when you have genuinely tried to settle a conflict and cannot — not as the
first move. Record what you tried and what a person needs to decide.

This still blocks the review from passing, which is the point: an unresolved
contradiction poisons every future session that reads the wrong rule. Tell your user
plainly that a human decision is required; do not answer it yourself and do not close
it with lore-ok.
`.trim(),

  teach: `
Record something durable about this codebase, with its reason.

Taught rules outrank rules inferred from reviews. Record the WHY: a rule without one
gets deleted by the next reader who disagrees with it.

kind "policy" is different from the rest, and is the one to use for A DECISION ABOUT
WHAT THIS PROJECT ENFORCES — "we do not treat loopback binds in tests as a finding".
Reviewers are NOT shown policies; they are told how many exist and that a lore-ok
citing one is team policy rather than an opinion. The text travels with the appeal
that cites it, which is the only moment it is relevant. The reply gives you the id.

Anyone holding a token for this repository may add one, and who added it is recorded.
That is safe because a rule silences nothing by itself: it can only be argued to a
reviewing tier, which accepts it by not raising the finding again, or rejects it.
`.trim(),

  retire: `
Withdraw a development rule that no longer holds.

Takes the short id, and the reason — which is KEPT, and is what a later reader finds
when they ask why a check came back.

This is the other half of an appeal. An accepted appeal stops an engine's rule being
reported for a path, and it holds for exactly as long as the development rule behind
it does: retire the rule and every check it silenced reports again at the next review,
with nothing to sweep. The suppression records themselves are kept deliberately — they
are the evidence of what earlier reviews did not cover.

Refused when the id matches more than one rule. Retiring the wrong one switches checks
back on somewhere nobody is looking, and lore cannot tell which you meant.
`.trim(),
} as const;

export const RESOURCE_DOCS: Readonly<Record<string, { title: string; priority: number; text: string }>> = {
  "lore://docs/workflow": {
    title: "The review loop, end to end",
    priority: 1.0,
    text: `
0. review_inbox() — FIRST, before starting anything. A review you started in an
   earlier session is still open and still yours; nothing else will finish it, and
   nobody is going to tell you. A session ends and takes its subscription with it, so
   asking is the only thing that survives you.
1. review_start(branch, into, ticket) → review_id
2. If your host can subscribe, do:
   subscriptions/listen { notifications: { resourceSubscriptions: ["lore://review/<id>"] } }
   ^ the RAW JSON-RPC frame. An SDK's listen() helper takes subscribe_filter instead —
     the same thing unwrapped. Passing it these params yields an empty honoured filter
     and a stream that never delivers.
   You are woken by notifications/resources/updated when the review's STATE changes —
   that is the moment there is something to do, and nothing else wakes you. Check the
   ack: if your URI is not in the filter the server echoes back, you are NOT subscribed.
   Most hosts cannot subscribe — the method needs a 2026-07-28 connection — and that is
   normal, not a fault to report. Without it, step 3 is the whole loop.
3. review_poll(review_id) ONCE, straight after subscribing — a subscription has no
   replay, so whatever happened before the stream opened arrives no other way. Then on
   each wake, review_poll again; it returns only what is new.
   Not subscribed? Then step 3 is the whole loop: leave, come back when
   \`check_back_note\` says, and RE-READ IT on every reply — never reuse the last
   number. It shrinks as the round ages, and caching it doubles your wait.
4. For each finding: fix it, or justify it with // lore-ok[fp]: <reason>
5. review_submit(review_id, diff, tree_hash) — ONLY while the state is findings_ready
   or awaiting_diff. fast_clean is NOT one of them: the deep round is already queued
   against that worktree, and a submit is refused while a tier is reading it.
6. Return to 3. Repeat until the state is TERMINAL — \`passed\`, \`passed_partial\`,
   \`needs_human\`, \`failed\`, \`expired\` or \`cancelled\`.

Rules that decide whether this works:
- Polls return only new findings. Never re-fix what is not in the response.
- \`failed\` and \`expired\` are not \`passed\`. Report and stop; do not merge.
- \`fast_clean\` is not \`passed\` either — the deep tiers have not run.
- \`passed_partial\` is terminal and will NEVER become \`passed\`, so waiting for that
  never returns. Attest it, and say plainly that the evidence is weaker than a pass.
- Expect several rounds. A fix does NOT send the review back down the ladder: the tier
  that raised a finding is the one that judges your answer, and a tier already satisfied
  stays satisfied for the rest of this review.
- Do not use lore-ok to make an inconvenient finding go away. The reviewer rules on
  it, and a rejected justification returns worse than it left.
- Before fixing in unfamiliar code, knowledge_query it — someone may already have
  decided this, for a reason.
- When you learn something durable, knowledge_teach it.
`.trim(),
  },

  "lore://docs/lore-ok": {
    title: "Justification format",
    priority: 0.9,
    text: `
    // lore-ok[a1b2c3d4]: bounded by the caller's schema check at api/route.ts:31,
    // so a negative amount cannot reach here.

    <!-- lore-ok[a1b2c3d4]: the spec is deliberately silent here -->

The bracketed value is the short fingerprint lore printed with the finding. It links
comment to finding exactly; an id matching two findings is an error, not a guess.

Consecutive comment lines continue the reason. A marker with no reason is ignored —
it is not a justification, and an empty comment must not close a finding.

Legitimate use: you have evidence the finding is wrong. Illegitimate use: the finding
is inconvenient. The reviewer can tell the difference more often than you would like,
and a rejected justification comes back at higher severity.
`.trim(),
  },

  "lore://docs/findings": {
    title: "Finding schema and severities",
    priority: 0.8,
    text: `
A finding has: file, optional line, optional symbol, severity (high|medium|low),
claim (one sentence), evidence, failureScenario, and an optional cwe.

Identity is sha256(normalised claim ‖ file ‖ enclosing symbol) — deliberately NOT the
line number, so a finding that moves does not look new. Severity is excluded too, so a
finding returning at raised severity is recognised as the same finding.

The short form printed for you is the leading 8 hex characters.

Findings arrive worst first: high, then medium, then low, then by file and line. If
you show your user only part of a response, take it from the top.

A severity outside high/medium/low is a bug in whatever wrote it, and sorts ABOVE
high rather than below low — so an unrecognised value is the first thing you see
instead of the thing you never scroll to.
`.trim(),
  },

  "lore://docs/states": {
    title: "Every state, and which are terminal",
    priority: 0.8,
    text: `
queued          accepted, not started
running         a tier is working
findings_ready  new findings are waiting for you
awaiting_diff   waiting for your fixes
fast_clean      cheap tiers clean, deep tiers still running — NOT a pass
needs_human     a question you must not answer yourself — NOT a pass
passed          every tier agrees. The only clean state.
passed_partial  every tier that COULD run agreed — a tier went unpaid, or all of
                them came from one vendor. Real evidence, weaker evidence. NOT a pass
failed          did not complete — NOT "found nothing"
expired         abandoned or timed out — NOT "found nothing"
cancelled       YOU stopped it — terminal, and NOT "found nothing". The findings it
                had already produced are real and are yours; what the remaining tiers
                would have found is unknown

\`passed\` and \`passed_partial\` both support an attestation. The partial one is the
case that most needs the record, because the line names what was skipped.

\`expired\` and \`cancelled\` are deliberately not the same state, though both are
terminal and neither is a pass: expired is nobody came back, cancelled is somebody
decided. Only one of those says anything about a person.
`.trim(),
  },

  "lore://docs/ladder": {
    title: "Why escalation exists",
    priority: 0.5,
    text: `
T0  the repo's own tsc, eslint, ast-grep and semgrep. Deterministic and free.
    lore READS your tests — coverage, and whether one asserts what its name claims —
    and never RUNS them. A failing suite is yours to find; CI already tells you.
T1  a cheap, fast model — the gate.
T2  a stronger model, different vendor.
T3  the strongest, different vendor again. The last line.

Each tier only sees code the previous one passed, so the expensive ones are never
spent on defects a typechecker would have caught. Three vendors, because two tiers
from one model family are not two independent opinions.

Every reviewer is a model that did NOT write the code. That is a hard constraint: a
model reviewing its own output confirms the design it already had in mind.
`.trim(),
  },
};

export const REVIEW_PROMPT_TEXT = (branch: string, into: string, ticket: string): string =>
  `
You are shepherding \`${branch}\` through an independent review before it merges into \`${into}\`.

The reviewers are models that did NOT write this code. You are not being second-guessed
by a peer; you are being audited. Treat findings as evidence to investigate, not as
opinions to argue with.

The loop:
0. review_inbox() — FIRST. A review from an earlier session is still open and still
   yours, and nothing but this call will tell you.
1. review_start(branch: "${branch}", into: "${into}", ticket: <paste the ticket, do not summarise>)
2. If your host can subscribe, do:
   subscriptions/listen { notifications: { resourceSubscriptions: ["lore://review/<id>"] } }
   ^ the RAW JSON-RPC frame. An SDK's listen() helper takes subscribe_filter instead —
     the same thing unwrapped. Passing it these params yields an empty honoured filter
     and a stream that never delivers.
   You are woken by notifications/resources/updated when the review's STATE changes —
   that is the moment there is something to do, and nothing else wakes you. Check the
   ack: if your URI is not in the filter the server echoes back, you are NOT subscribed.
   Most hosts cannot subscribe — the method needs a 2026-07-28 connection — and that is
   normal, not a fault to report. Without it, step 3 is the whole loop.
3. review_poll(review_id) ONCE, straight after subscribing — a subscription has no
   replay, so whatever happened before the stream opened arrives no other way. Then on
   each wake, review_poll again; it returns only what is new.
   Not subscribed? Then step 3 is the whole loop: leave, come back when
   \`check_back_note\` says, and RE-READ IT on every reply — never reuse the last
   number. It shrinks as the round ages, and caching it doubles your wait.
4. For each finding: fix it, or justify it with // lore-ok[fp]: <reason>
5. review_submit(review_id, diff, tree_hash) — ONLY while the state is findings_ready
   or awaiting_diff. fast_clean is NOT one of them: the deep round is already queued
   against that worktree, and a submit is refused while a tier is reading it.
6. Return to 3. Repeat until the state is TERMINAL — \`passed\`, \`passed_partial\`,
   \`needs_human\`, \`failed\`, \`expired\` or \`cancelled\`.
   Only \`passed\` and \`passed_partial\` are worth attesting, and only \`passed\` is clean.

Rules:
- Polls return only new findings. Never re-fix what is not in the response.
- \`failed\`, \`expired\` and \`fast_clean\` are not \`passed\`. Do not merge on them.
- \`passed_partial\` is TERMINAL: it will never become \`passed\`, so looping for that
  never ends. Attest it — the line names which tiers were skipped and which vendor
  looked — and tell your user the evidence is weaker than a pass, so the decision to
  merge is theirs.
- Expect several rounds. A fix does NOT send the review back down the ladder — the tier
  that raised a finding judges your answer to it.
- Do not use lore-ok to make an inconvenient finding go away.
- Before fixing in unfamiliar code, knowledge_query it.
- When you learn something durable, knowledge_teach it.
- If the state is needs_human, STOP and ask a person. Do not answer it yourself.

The ticket for this change:
${ticket.trim()}

When the state is \`passed\` — or \`passed_partial\` — call review_attest and give the
user that line. On a partial one, say which tiers were skipped and that the evidence
is weaker than a pass; the decision to merge on it is theirs, not yours.
`.trim();
