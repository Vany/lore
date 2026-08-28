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

import { REVIEW_STATES } from "../core/review-state.ts";

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
 * 10. Reads `passed`/`passed_partial` as the end of its whole task and stops
 *     there, not just the end of this one review.
 */

export const TOOL_DOCS = {
  // lore-ok[170690b5]: correct for this round, and expected — this project's own D-77
  // working agreement (CLAUDE.md) submits fixes through review_submit for the whole
  // review and amends the local commit ONCE, with exactly what was submitted, only
  // after the review reaches a terminal verdict. A submitted fix living ahead of HEAD
  // mid-review is that workflow working as designed; the amend-before-push step is
  // what makes them match before anything is pushed.
  start: `
Begin an independent multi-model review of \`branch\` against \`into\`.

\`ticket\` is REQUIRED — the text of the task this change implements. Without it the
reviewers can only ask whether the code is correct, never whether it is the code that
was asked for. Paste the ticket body. Do not summarise it, and do not substitute your
own description of what you built: an agent describing its own work describes what it
made, not what was asked, which destroys the only independent statement of intent the
reviewers get.

FOLDER MODE IS THE ALTERNATIVE TO A DIFF. Pass \`mode: "folder"\` and \`path\` instead of
\`into\` to review what is AT a path — no base, no diff, every file in it read as it
stands rather than as a change. Use it for a rewrite with no clean incremental diff, or
a module you want a fresh, independent look at regardless of its git history. \`into\`
and \`path\` are mutually exclusive: folder mode has no base for \`into\` to name.

\`path\` is REQUIRED when \`mode\` is \`"folder"\` — there is no default to the repository
root. Pass \`"."\` if you genuinely mean the whole tree; otherwise name the subdirectory.
An unscoped whole-repository review usually exceeds the diff size ceiling (\`spec/review-
ladder.md\` §6) and spends real quota reading a mostly-truncated prompt, so naming a path
is not bureaucracy — it is the difference between a review that reads what you meant and
one that reads a prefix of it.

Everything below — polling, review_submit, pull_fresh, findings, lore-ok, attestation —
works the same way in folder mode, with three differences. \`pull_fresh\` must repeat the
same \`path\` to find the SAME open folder review, exactly as it already has to repeat
the same \`branch\`. The signed attestation line names its scope: \`reviewed tree
<hash> (scoped to <path>)\` rather than a bare tree hash, because the tree hash alone is
the whole worktree's — hashed the same way for every review — while a folder review's
tiers read only \`path\`. And ONE REVIEW PER BRANCH (below) is really one review per
\`(branch, path)\`: a folder review of \`src/legacy\` and a diff review of the same branch,
or folder reviews of two different paths, are different work and run concurrently —
only a second review naming the SAME branch and the SAME path is refused as a duplicate.

PASS \`pull_request\` IF THIS BRANCH HAS ONE. The URL of the PR, MR or change this branch
is proposed in — an http(s) link, whatever your forge calls it.

It is optional because a missing link must never fail a review, and because some branches
genuinely have no pull request. But it is asked for every time, and the reason is not
bookkeeping: the people watching this service see a BRANCH NAME, which is not clickable
and does not say which repository or forge it lives on. With the link, the operator board
takes a person from "what is this review doing" to the change itself in one click; without
it, they go and search for it by hand, or do not look at all.

You almost certainly know it. You are usually the agent that opened the PR, or you were
handed its URL in the task. If you genuinely do not have one, leave it out — do not
invent, guess or construct a URL from a pattern, because a link that goes to the wrong
change is worse than no link.

Returns a review_id IMMEDIATELY. The review takes minutes — this does not mean it
finished.

POLL IT, ONE CALL AT A TIME, AT THE INTERVAL THE REPLY GIVES YOU.

Every reply carries \`check_back_note\`, and USUALLY \`check_back_after_ms\` too — measured
from this repository's own completed rounds, and never more than two minutes, so coming
back when it says costs you one call and finds the review either finished or genuinely
still working. The first 20 rounds of a tier's history — every freshly provisioned
repository starts here — have no honest median yet, so the field is OMITTED rather than
guessed; \`check_back_note\` still gives you a full instruction on every reply, with or
without the number.

DO NOT SLEEP-POLL. One call, then go and do something else, then one more call. A tight
retry loop is the most expensive thing a client can do here: each attempt is an LLM turn
spent learning nothing, and the round takes as long as it takes either way.

RE-READ THE INTERVAL EVERY TIME. NEVER REUSE THE LAST ONE. It answers "how much longer
FROM HERE" — but READ \`check_back_note\` WITH IT rather than inferring from the number,
because there are two cases and they look identical. Below the two-minute cap it shrinks as
a round ages: one that has outlived the typical round is not another typical one away from
finishing, it is nearly done. AT the cap — which is where a long-running tier sits for
several calls — it does not move at all, and the note says so. A constant there is the
bound, not a stalled review and not a stale field.

PUSH YOUR BRANCH FIRST. The one requirement is that your code has reached ORIGIN:
lore reviews what origin has, never your working copy, so a commit that exists only
on your disk is not in the review. How lore stays current with origin is lore's own
business — nothing about it is asked of you, ever.

If lore cannot confirm origin's current state, a review is REFUSED rather than run
against an old tree. You cannot fix that from where you are: report the message to
your user verbatim — it names what a person must check on the lore host.

The review pins the branch when its first round begins, which is shortly after this
returns — not at the instant it returns. A commit pushed in that window may or may
not be included, and nothing will tell you which. Push first, then start; for
anything after that, start a new review. Once pinned, a later push cannot move the
ground under findings already reported.

FINISH WHAT YOU START. A review left in \`findings_ready\` never ends by itself: it
holds its pinned copy of your branch until it is expired as abandoned, and the branch stays
unreviewed. Either answer its findings with review_submit, or leave it knowing the
result is \`expired\` — which means NOTHING was concluded about the code, not that it
was clean.

ONE REVIEW PER BRANCH — per \`(branch, path)\` once folder mode is in play, see above.
Start it once; then answer its findings with review_submit, which applies your fixes to
the SAME review and advances the ladder. Do NOT start a second review naming the same
branch and the same path (bare diff mode counts as no path) as one that is already open
— it is refused, and it names the one to continue.

That matters more than it looks. The ladder only reaches its deeper, independent
tiers by ADVANCING: findings carry forward, justifications you ratified stay ratified,
and severity escalates where an answer did not hold.

THREE WAYS TO CONTINUE, IN ORDER:
1. review_submit — you fixed things; send the diff. The same tier judges your answers.
2. pull_fresh: true on review_start — you pushed more commits; the SAME review re-pins
   to origin's new tip with everything carried. No diff to compose, nothing reset.
   ONLY WORKS ON YOUR OWN REVIEW, same as restart below: it is refused outright on a
   colleague's, nothing touched, because re-pinning recuts the worktree and would
   discard any fix they had submitted but not yet committed.
3. restart: true — a person decided to discard this review's history. Everything is
   abandoned and the cheap tiers run again from round 1. This is almost never the
   right call, and reaching for it because a diff feels like work is how a branch gets
   reviewed all day and produces no verdict at all — which is exactly what happened
   before the one-review rule was enforced. ONLY WORKS ON YOUR OWN REVIEW: the open
   review this refusal names may belong to a colleague on the same repo — you are
   told about it so you do not duplicate their work, not so you can end it. restart:
   true on a review that is not yours is refused outright, nothing started, nothing
   touched; ask them to continue or cancel it.

Expect several rounds of findings. That is the process working, not failing.
`.trim(),

  poll: `
Fetch findings discovered since your last poll.

Returns ONLY NEW findings. Anything you have already been shown will not appear again
— do not re-fix something absent from the response.

IF YOU HAVE LOST FINDINGS YOU WERE ALREADY GIVEN, DO NOT POLL AGAIN — read the resource
\`lore://review/{review_id}\`. It returns every finding on the review in full, and it
consumes nothing and settles nothing. USE EACH FINDING'S \`short\` FIELD IN \`lore-ok\`
— the resource's own \`fingerprint\` field is the full 64-hex form, kept for
cross-referencing verdicts, and \`lore-ok[...]\` accepts only 8 hex. Polling cannot
recover lost findings by construction: the ids you are missing are precisely the ones
this call will never show you twice. Do not restart the review to see them again
either — that discards every justification already ratified.

THIS CALL CONSUMES WHAT IT RETURNS, so it answers only for the token that started the
review. A review you did not start is NOT FOUND here, even on a repository you hold a
token for, because polling it would take findings its owner has never seen and nothing
anywhere would say so. review_inbox is how you find what is yours.

USE THIS TO READ AND TO WAIT — one call at a time. \`check_back_after_ms\` says how long
before anything can plausibly have changed, measured from this repository's completed
rounds and never more than two minutes. RE-READ IT EVERY TIME: it answers "how much longer
FROM HERE". On a tier whose rounds run long it sits AT the two-minute cap for several calls
before it starts falling, so read \`check_back_note\` rather than inferring from the number
— the note says which of the two you are being handed.

A tight retry loop is the most expensive thing a client can do here — every attempt is an
LLM turn that learns nothing, and the round finishes when it finishes.

States: ${REVIEW_STATES.join(", ")}.

ONLY \`passed\` means the branch is clean.

- \`passed_partial\` means every tier that COULD run agreed, but the evidence is
  weaker than a pass, for either or both of two reasons:
    * a tier could not ANSWER — it was unavailable to lore, or it never replied on
      either attempt — so its work passed to the next tier up and one fewer independent
      vendor read this code ("we did everything we can"). checks_skipped names which.
      WHY a tier was unavailable is lore's business and not yours: it is being dealt
      with, it needs nothing from you, and what matters here is only that one fewer
      vendor read your code;
    * FEWER VENDORS READ YOUR CODE THAN TIERS RAN, so some of them share blind spots.
      Three tiers from one model family is one opinion asked three times, not three
      independent reviews — and two tiers from one family plus a third is two opinions,
      not three. Any repeat lands here, not only a total collapse: when a subscription
      runs out, the stand-in that covers it is often another plan from a vendor already
      in the ladder, which is exactly when this is easiest to miss.
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
  tier to take in, which nothing in the message said. The client did everything
  right and the instruction was wrong.

  So after ONE failed retry, report to your user: the branch name, \`failed_because\`
  verbatim, and that lore could not review it. That is a true and useful thing to say.
  Diagnosing lore is not your job and you do not have the information to do it — say
  what happened, not why you think it happened.
- \`fast_clean\` means only the cheap tiers have finished; the deep tiers are still
  running. It is NOT a pass. The deep reviewers read the same tree TOGETHER, so
  successive polls may bring findings from more than one of them, interleaved — answer
  them as they arrive, exactly as you would one reviewer's.
- \`needs_human\` means a question was found that you must not answer yourself.
  **\`open_questions\` is the question** — both statements, in full, and where each
  came from; \`needs_human_because\` says why a review cannot settle it. Take them to
  a person verbatim. This is not a finding about code: it is two things this
  repository believes that cannot both be true, and the answer decides what every
  future session is told. Do not guess, do not close it with lore-ok. When the person
  has decided, call knowledge_resolve with the id to keep — or knowledge_escalate if
  they cannot decide either.

\`human_decision\` MEANS SOMEBODY ALREADY ANSWERED, AND YOU MUST NOT ASK AGAIN. A person
can settle the contradiction directly, on lore's operator board, without going through
you — and then every review it blocked resumes. From here that looks exactly like an
ordinary requeue, so this field is how you tell the difference. It names what was
decided and who by.

When you see it: do NOT take the question to your user. It has an answer, and asking a
second time invites a second, different one — which is how a repository ends up believing
two things again. Say what was decided if it is relevant, and carry on from where the
review stopped. The field stays on every later poll, deliberately: whichever session is
alive when the review next moves needs the same fact, and a thing delivered once is a
thing the next session does not have.

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
    or answer it with the lore-ok line given. \`fixed_elsewhere\` rides along with it and
    is the case people get wrong: repairing the CAUSE in other code is often the right
    repair, and it leaves the named line untouched — which the next round reads as a
    finding nobody answered, so it cannot settle however it goes. Fixing elsewhere is
    fine; fixing elsewhere WITHOUT the lore-ok comment at the named line costs you a
    whole round.

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

\`checks_skipped\` is where the review tells you what it did that you would not otherwise
see. MOST of it narrows what the review is evidence of; one entry does not, and the
difference is stated on each line rather than left for you to guess:

  * a deterministic engine did NOT run — no installed dependencies, no test script, a
    suite disabled for the deployment;
  * a tier produced a finding the schema refused, so this review does not contain it.
    The line says which tier and what was wrong with it. The tier looked at the code
    and saw something; you are not being shown it;
  * **a tier could not hold your whole diff and was given part of it.** Your branch is
    larger than that reviewer can take in at once, so the diff was cut to fit and the
    tier was told so. It reviewed what it was given and may have read the rest from the
    branch itself — but it did not read all of it as a diff. **A \`passed\` on a
    compacted review covers the part that was shown.** The fix is a smaller review: in
    diff mode, a narrower commit range or merging in stages; in a folder review (D-130),
    review_cancel this one, then review_start again with a narrower \`path\` — there is
    no commit range to narrow because there is no base, and \`restart: true\` will NOT do
    it: restart only cancels a review at the exact same \`(branch, path)\` it is called
    with, so passing a narrower path finds nothing open to cancel and silently leaves
    this wide review running. Say this to your user; they are the only one who can
    change the scope.
  * **a tier was not asked at all** — it was out of capacity, and the line names the
    tier and when it comes back. That tier read nothing, so the review is evidence from
    one fewer independent vendor — but it is not broken, and retrying will not help
    until the time passes.
  * **a tier was answered by a stand-in** — "was answered by an equivalent…". This one
    is NOT a narrowing: the tier RAN and its opinion counts in full. It is listed as a
    fact about the review worth passing on, not a gap in it.

It is never a finding and never a failure. Every line but the last narrows what the
review is evidence OF; the last one narrows nothing and reports a cost. Typecheck and
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

  // lore-ok[f910deea]: fixed here, same round it was raised — the pull_fresh
  // recipe below used to show only the branch/into form, which a folder-mode
  // client cannot use (into is refused for mode: "folder"). The FOR A FOLDER
  // REVIEW paragraph a few lines down now shows the mode/path form beside it.
  // Verified directly against the current string.
  submit: `
Submit your fixes as a unified diff, with the git tree hash of your working tree
after applying them.

THIS IS HOW A REVIEW CONTINUES. It is the same review, one round further on: your
answers are checked, findings you settled stay settled, and the ladder escalates to a
deeper tier when it should. This — not review_start — is the loop. Starting a new
review instead abandons every justification already ratified and re-runs the cheap
tiers from the beginning.

SEND YOUR WORK, NOT ONLY YOUR ANSWERS. A review is INCREMENTAL: the reviewer keeps one
conversation per tier for the whole review and is given only what CHANGED since it last
looked, so it is not re-reading your repository each time. That makes an update cheap,
and it means you should not save them up.

So send a new feature, a refactor, a half-finished direction you want looked at — not
just fixes for findings. You do not need to wait for a round to finish, and you do not
need a reason. The reviewer sees the sequence of your changes rather than a single
snapshot, which is how it catches what no snapshot can: a fix that was wrong and then
patched, a decision made and reversed, a workaround that outlived the thing it worked
around.

Two consequences worth expecting. Findings will arrive about work you are still in the
middle of — that is the point, not a mistake, and answering "this is unfinished, here is
where it is going" in a lore-ok is a real answer. And a verdict is always about a TREE:
a pass means the tiers read the tree you had at that moment, so if you keep sending work
after it, the pass describes what it read and not what you sent next.

Applied to the review's private copy of your branch. Nothing is committed or pushed — your
history stays yours. For a \`diff\`, the tree_hash is verified after applying; a mismatch
fails loudly rather than reviewing code that exists nowhere. For a \`commit\`, lore already
knows what tree it names — no apply needed to find out — so a wrong tree_hash is refused
immediately, before anything is applied or even held, naming the tree the commit actually
has.

SEND A PUSHED \`commit\` INSTEAD OF A \`diff\` IF YOU CANNOT BUILD ONE. Exactly one of the
two, never both. This exists for the case that used to be a dead end: a review's tree is
its pinned base PLUS every patch already applied, and that tree lives only inside lore — so
a session that did not make the earlier submissions cannot check it out, cannot diff
against it, and cannot compute a matching hash. If you have inherited a review, or you
rebased and a diff is hopeless by construction, push your work and name the commit. lore
syncs with origin, works out the delta itself, and carries on with the SAME review: same
findings, same ratified justifications, same ladder position.

Do NOT reach for \`restart\` when a diff will not apply. It discards every justification
this review has ratified and re-runs the cheap tiers from the beginning; the commit form
costs nothing and keeps all of it.

SUBMIT WHENEVER YOU ARE READY, including while a reviewer is still reading. A submit
that lands mid-round is HELD — accepted, kept, and handed to EVERY reviewer that is
reading (the deep phase runs two together), each at its own next emission, with rulings
arriving as ordinary findings on your next polls. You never wait for an idle moment and
never resubmit the same diff. Two consequences to expect: findings a reviewer reports
before seeing your fix may already be answered by it (do not double-fix — the next
emission settles them), and if the held diff cannot be verified when it is applied, the
review lands in awaiting_diff with the reason, which means: diff against the tree as it
stands and send again.

ONE EXCEPTION: if a \`diff\` you already sent is still HELD and unconsumed, a \`commit\`
sent next is REFUSED rather than held — that hold's claimed tree is your own local git
write-tree, never pushed anywhere lore can see, so lore cannot yet compute a delta
against it. Poll until the hold clears (the review leaves 'held'), or keep sending
\`diff\` for the follow-up too — a second \`diff\` always chains fine, and a second
\`commit\` chains fine once nothing raw is outstanding.

PREFER PUSHING TO SENDING A DIFF, IF YOU CAN PUSH AT ALL.

A diff is whitespace-significant — a context line for a blank source line is a single
space — and many harnesses strip trailing whitespace from a tool argument. When that
happens, the diff you send is NOT the diff you built, you cannot tell, and lore can only
report that the patch did not apply. This is the most common way an otherwise correct fix
fails to reach a review, and it is measured rather than theoretical.

So when your fixes are committed and pushable:

    git push                                  (your branch, as usual)
    review_start(branch, into, ticket, pull_fresh: true)

That re-pins the SAME review to origin's new tip — findings, ratified justifications and
the ladder all carry, and the same review_id comes back. Nothing whitespace-significant
crosses the wire, the tree hash comes from git rather than from a claim you have to get
exactly right, and there is no diff to compose at all. Same loop, one less way to fail.

FOR A FOLDER REVIEW (D-130), repeat mode and path instead of into — pull_fresh finds the
open review by branch AND path, exactly as an ordinary pull_fresh finds it by branch alone:

    review_start(branch, mode: "folder", path, ticket, pull_fresh: true)

Use review_submit when you genuinely cannot push: no remote, no credentials, or work you
do not want in history yet. It is fully supported, and everything below applies to it.

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
stops raising something it never saw move has changed its mind, not been satisfied.

FIXING THE CAUSE ELSEWHERE IS OFTEN RIGHT, AND IT COSTS NOTHING EXTRA IF YOU SAY SO IN
THE SAME DIFF. Put the lore-ok in with the fix — one submit, one round, ruled on
together. You do not have to fix, submit, read \`will_not_settle\`, then submit a second
time: that is a whole deep-tier round bought to learn something you already knew when you
chose where to fix it. \`will_not_settle\` exists to catch what you MISSED, not to make
you take two turns over what you meant.

If the named line no longer exists — you deleted the code, or the fix removed the very
lines the finding pointed at — there is nowhere to write the marker, so put it in
\`.lore-ok.md\` at the repo root in the markdown form. That file is read on every round
exactly like a source comment.

For a finding you believe is WRONG, do not skip it silently. Write at the site:

    // lore-ok[<fingerprint>]: <why this code is correct>
     * lore-ok[<fingerprint>]: <reason>          (inside a /** */ block)
    <!-- lore-ok[<fingerprint>]: <reason> -->    (for markdown)

Those three forms are the whole list; anything else is never read. \`.lore-ok.md\` at the
repo root is read on every round as well, in the markdown form, and it is the right home
for two cases: a file that has no comment syntax at all — JSON, a lockfile, generated
output — and a finding whose named line your fix DELETED, where there is no site left to
write at.

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
better one than walking away: a review nobody answers holds its pinned copy of your branch until it
is swept as \`expired\` two days later, and \`expired\` is indistinguishable from
"nobody was ever going to come back".

WHAT IT DOES, all of it:

  * the review becomes \`cancelled\` — TERMINAL, and its own state rather than
    \`expired\`, because the two mean opposite things about you: expired is nobody
    came back, cancelled is somebody decided;
  * the ladder stops. No further round is claimed, and a round claimed in the same
    instant finds the review terminal and stops before spending anything;
  * a reviewer mid-read is STOPPED, not merely abandoned — a reviewer left running
    would keep reading and keep spending long after anyone stopped listening, so the
    cancel reaches the model itself;
  * \`stopped_in_flight\` has THREE values and they are three different claims.
    \`true\`: a call was running and has been stopped. \`false\`: nothing was running.
    \`null\`: THIS SERVER COULD NOT LOOK — it was built without a reviewer, so if a call
    was in flight it is still exploring and still spending. Treat \`null\` as "tell an
    operator", never as "nothing was running". A deployed lore never answers \`null\`;
    the CLI and tests can;
  * every finding it had already produced is returned, delivered or not. They are
    real: the tiers that ran did read the code;
  * everything it learned about your repository is KEPT. Knowledge outlives the review
    that made it, and cancelling costs you none of it.

WHAT IT IS NOT: a pass, and not evidence the branch is clean. The tiers that had not
run never looked, and what they would have found is unknown. Never merge on a
\`cancelled\` review — report the findings you were given and say the review was
stopped before it finished.

Already terminal is refused rather than silently accepted: there is nothing to cancel,
and the findings are still available from \`lore://review/{review_id}\` — NOT
\`review_poll\`, which returns only what it has not already handed you, and cancelling
hands you everything at once. A poll after that legitimately returns nothing new.
`.trim(),

  attest: `
Available once state is \`passed\` — or \`passed_partial\`, which is the case that
most needs a record: the line names which tiers were skipped, and how many distinct
vendors actually read the code against how many tiers ran. Refusing to attest a partial review would leave the operator with no
account of it at all, which is worse than an honest incomplete one.

Returns one signed line recording what was done:
tiers run, findings raised, fixed and justified, at a tree hash.

It asserts what was checked. It does NOT assert the code is correct, and you should
not represent it as doing so.

The signature covers a TREE HASH, not a branch name. If the branch has moved since,
the attestation does not describe what is there now.

FOR A FOLDER REVIEW (D-130), the line adds "scoped to" and the path, rather than a
bare tree hash. The hash is still the whole worktree's, hashed the same way for
every review — but the tiers behind a folder review read only \`path\`, so when
relaying the line to your user, quote the scope with it. Dropping it turns an
honest partial claim into an unscoped one.
`.trim(),

  inbox: `
THE FIRST CALL OF EVERY SESSION. EVERY review of yours that is still open, plus any
deep findings waiting since you last collected.

A review outlives the session that started it. You end; nothing you leave behind is
watching for you; the review does not — it sits in findings_ready holding your branch's pinned copy, dims to
findings_stale after 48h, and is abandoned a week later, having concluded NOTHING about the code. That is the dominant
cause of wasted reviews here, measured: nothing obliges a client to come back, and no
notification can reach one that has gone.

So the thing that actually closes the loop is the next session asking what is waiting.
That is this call. Make it before you start a new review — not instead of polling one
you are already driving.

READ \`waiting_on\` FIRST. It is "you" or "lore", and it is the whole triage:

  * "you" — nothing will happen until you act. Either findings are queued for you
    (\`new_findings\` > 0, collect them with review_poll), or the review is stopped at
    findings_ready / findings_stale / awaiting_diff / needs_human with everything already
    handed over,
    which means it is waiting on a review_submit or on a person. THIS IS THE STATE THAT
    ROTS. It listed nothing to collect and so used to be omitted here entirely — the
    common way to reach it is to poll, start fixing, and end the session.
  * "lore" — queued, running, or fast_clean with the deep tiers still going. Nothing to
    do. review_start naming the same branch AND the same scope (a folder review's
    \`path\`, or bare diff mode) as this open review is REFUSED, not destructive — it
    errors and names this review rather than touching it. Only \`restart: true\` on that
    same call discards every ratified justification and reruns the cheap tiers from
    round 1; reaching for it because nothing seems to be happening is how a review that
    only needed time gets thrown away instead. A folder review of a different path, or a
    diff review of the same branch, is different work and unaffected either way.

\`expires_at\` is when the sweep will take it, and \`expired\` never means "found
nothing". An unanswered review does not die at 48h — it DIMS: \`findings_ready\` becomes
\`findings_stale\` after 48h, still fully answerable, and only about a week after that is
it swept as \`expired\`. Read the field rather than counting from when you last touched
it. It is absent on a review that has already ended. If a deadline is close and you
cannot answer the findings now, review_cancel says "somebody decided" instead, which is
the honest ending and the one that frees everything the review was holding — including
its slot, immediately, which waiting out the sweep would not do for another nine days.

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

\`path\` FINDS WHAT APPLIES TO IT, spelling aside — "src/payments", "src/payments/",
"./src/payments" all name the same place, and any of them ALSO finds a rule taught
at a containing directory, "src" say (a rule's scope covers what is under it, not
only what it was taught at exactly). Pass a path relative to the repository root; an
absolute one or one starting with ".." is refused outright, the same way
\`knowledge_teach\` refuses one, rather than silently returning \`count: 0\` for a
spelling that could never match anything.
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

Zero vulnerability statements is not automatically clean either: it is the same shape
as "the check that would have found one never ran" — cdxgen absent with no lockfile
to fall back to, OSV unreachable, this review's most recent round not finished yet, or
this being a code-arch review, which never runs the dependency scan at all. \`summary\`
says so explicitly when it applies ("does not mean the tree is clean", not "matched");
read the plain sentence rather than inferring from an empty \`document.vulnerabilities\`
array alone.
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

\`keep\`/\`retire\` TAKE EITHER LENGTH — the full id \`open_questions\` renders, or an
8-char short form like \`cite_as\`, and you may mix them: one full, one short. Refused
as ambiguous if a short form matches more than one rule, never guessed.

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

\`left\`/\`right\` take either length, exactly as \`resolve\`'s \`keep\`/\`retire\` do — the
full id \`open_questions\` renders, or an 8-char short form like \`cite_as\`, and you may
mix them.

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

Takes the id — the short \`cite_as\` form, or the full id \`knowledge_teach\` returned,
either resolves the same rule — and the reason, which is KEPT, and is what a later
reader finds when they ask why a check came back.

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
   nobody is going to tell you. A session ends and nothing outlives it to finish the
   job, so asking is the only thing that survives you.
1. review_start(branch, into, ticket, pull_request) → review_id
   — or, for a folder review (D-130): review_start(branch, mode: "folder", path, ticket)
   — a full read of \`path\`, no base, no diff. \`into\` and \`mode\`/\`path\` are mutually
   exclusive.
2. review_poll(review_id) — ONE call, then leave. Come back when \`check_back_note\`
   says: it is measured from this repository's completed rounds and is never more than
   two minutes.
   RE-READ IT ON EVERY REPLY and never reuse the last number; read \`check_back_note\`
   with it. Below the cap the number shrinks as the round ages and caching it doubles your
   wait; AT the cap it stays put for several calls and the note says so.
   Each poll returns only what is NEW. A tight retry loop is the most expensive thing
   you can do here: every attempt is a turn that learns nothing.
3. For each finding: fix it, or justify it with // lore-ok[fp]: <reason>
4. review_submit(review_id, diff | commit, tree_hash) — any time once findings exist, in ANY
   state including fast_clean. If reviewers are mid-read your diff is HELD and handed
   to each of them at its own next emission; you never wait for a state and never
   resubmit. Exception: a \`commit\` is REFUSED, not held, while an unconsumed \`diff\`
   hold is outstanding — send \`diff\` instead, or wait for that hold to clear.
5. Return to 2. Repeat until the state is TERMINAL — \`passed\`, \`passed_partial\`,
   \`needs_human\`, \`failed\`, \`expired\` or \`cancelled\`.

Rules that decide whether this works:
- Polls return only new findings. Never re-fix what is not in the response.
- LOST YOUR NOTES? READ \`lore://review/{review_id}\`. A poll consumes what it returns,
  so a session that compacted, crashed or simply forgot cannot get its open findings
  back by polling again — the ids it needs are exactly the ones it will never be shown
  a second time. That resource returns EVERY finding on the review in full, and reading
  it consumes nothing and settles nothing. USE EACH FINDING'S \`short\` FIELD IN
  \`lore-ok\`, not \`fingerprint\` — the resource's \`fingerprint\` is the store's full
  64-hex form (kept for cross-referencing verdicts), and \`lore-ok[...]\` accepts only
  the 8-hex form, the same one \`review_poll\` already called \`fingerprint\`. Read it
  instead of guessing, and never restart a review to see them again: a restart throws
  away every justification already ratified.
- \`failed\` and \`expired\` are not \`passed\`. Report and stop; do not merge.
- \`fast_clean\` is not \`passed\` either — the deep tiers have not run.
- \`passed_partial\` is terminal and will NEVER become \`passed\`, so waiting for that
  never returns. Attest it, and say plainly that the evidence is weaker than a pass.
- Reaching \`passed\`/\`passed_partial\` closes THIS review, not your task. Attest it
  either way; merge on a full pass, but a partial one is your user's call, not yours
  (the bullet above). Once that is settled, carry on with whatever else you were
  asked to do — lore has no opinion on when your session ends, only on whether this
  branch was reviewed.
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
running         the round is working — that is the deterministic sweep, reading your
                repository's documents, or a model tier. Not necessarily a tier yet
findings_ready  new findings are waiting for you
findings_stale  the same, gray: unanswered for 48h, at most a week left before it is abandoned
awaiting_diff   waiting for your fixes
fast_clean      cheap tiers clean, deep tiers still running — NOT a pass
needs_human     a question you must not answer yourself — NOT a pass
passed          every tier agrees. The only clean state.
passed_partial  every tier that COULD run agreed, and something above them did not.
                A tier ABOVE the one that passed never ran, or fewer vendors read the
                code than tiers ran — any repeat, not only a total collapse.
                Real evidence, weaker evidence. NOT a pass.
                A tier skipped BELOW one that passed does not land here: the ladder is
                a gate, so the tier above re-read everything it would have (D-88).
                checks_skipped names every tier that did not run, either way
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
T0  the repo's own tsc, eslint, cargo check/clippy, ast-grep and semgrep. Deterministic and free.
    lore READS your tests — coverage, and whether one asserts what its name claims —
    and never RUNS them. A failing suite is yours to find; CI already tells you.
T1  a cheap, fast model — the gate.
T2  a stronger model, different vendor.
T3  the strongest, different vendor again. The last line.

Each stage only sees code the previous one passed, so the expensive models are never
spent on defects a typechecker would have caught. The two deep reviewers read the SAME
tree together, as peers — each hears what the other found and hunts elsewhere, your
fixes reach both, and their findings interleave on your polls. Three vendors, because
two tiers from one model family are not two independent opinions.

Every reviewer is a model that did NOT write the code. That is a hard constraint: a
model reviewing its own output confirms the design it already had in mind.
`.trim(),
  },
};

/**
 * D-130, found by lore's own review of D-130: `mode`/`path` landed at `review_start`
 * and its docs, but not at this loop template — an agent reaching for the documented
 * way to drive the loop (`registerPrompt`'s own description: "an agent handed only
 * tools will improvise... this is what stops that") had no way to discover or
 * express folder mode from it. The opening line and the step 1 call both branch on
 * `mode`, rather than rendering an `into` folder mode never supplied.
 */
export const REVIEW_PROMPT_TEXT = (
  target: {
    readonly branch: string;
    readonly into?: string | undefined;
    readonly mode?: "diff" | "folder" | undefined;
    readonly path?: string | undefined;
  },
  ticket: string,
): string => {
  const folderMode = target.mode === "folder";
  const opening = folderMode
    ? `You are shepherding an independent review of \`${target.path}\` on \`${target.branch}\` — no base, every ` +
      "file in it read as it stands rather than as a change."
    : `You are shepherding \`${target.branch}\` through an independent review before it merges into \`${target.into}\`.`;
  const startCall = folderMode
    ? `review_start(branch: "${target.branch}", mode: "folder", path: "${target.path}", ticket: <paste the ticket, do not summarise>)`
    : `review_start(branch: "${target.branch}", into: "${target.into}", ticket: <paste the ticket, do not summarise>)`;
  return `
${opening}

The reviewers are models that did NOT write this code. You are not being second-guessed
by a peer; you are being audited. Treat findings as evidence to investigate, not as
opinions to argue with.

The loop:
0. review_inbox() — FIRST. A review from an earlier session is still open and still
   yours, and nothing but this call will tell you.
1. ${startCall}
2. review_poll(review_id) — ONE call, then leave and do something else. Come back when
   \`check_back_note\` says: measured from this repository's own completed rounds, and
   never more than two minutes.
   RE-READ IT ON EVERY REPLY — never reuse the last number — and read \`check_back_note\`
   with it. Below the cap the number shrinks as the round ages and caching it doubles your
   wait; AT the cap it stays put for several calls and the note says so.
   Each poll returns only what is NEW. A tight retry loop is the most expensive thing
   you can do here: every attempt is a turn that learns nothing.
3. For each finding: fix it, or justify it with // lore-ok[fp]: <reason>
4. review_submit(review_id, diff | commit, tree_hash) — any time once findings exist, in ANY
   state including fast_clean. If reviewers are mid-read your diff is HELD and handed
   to each of them at its own next emission; you never wait for a state and never
   resubmit. Exception: a \`commit\` is REFUSED, not held, while an unconsumed \`diff\`
   hold is outstanding — send \`diff\` instead, or wait for that hold to clear.
5. Return to 2. Repeat until the state is TERMINAL — \`passed\`, \`passed_partial\`,
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
is weaker than a pass; the decision to merge on it is theirs, not yours. Either way,
attesting and merging closes THIS review — carry on with whatever else your task needs.
`.trim();
};

/**
 * EVERY STRING A CLIENT IS EVER SHOWN, named once so no document can be quietly left out.
 *
 * It exists because a document WAS quietly left out. The "docs may only name tools that
 * exist" guard was moved to where a live `tools/list` could feed it — a real improvement
 * — and in the move its corpus narrowed from all three surfaces to `TOOL_DOCS` alone.
 * `REVIEW_PROMPT_TEXT`, which drives the entire review loop and names seven tools, went
 * unchecked, while the comment left behind said the guard had merely moved. Two test
 * files each assembling "all the docs" is how that happens; there is one list now, and it
 * lives beside the documents rather than beside a test.
 *
 * The prompt is a function of the review it describes, so it is sampled with placeholder
 * arguments — once per `mode` (D-130), because the opening line and the `review_start`
 * call are mode-conditional and NEITHER rendering is a subset of the other: a folder-mode-
 * only sentence that regressed (a hard-coded interval, a tool the server does not
 * register) would pass every guard here if only the diff-mode sample were taken, exactly
 * the silent-narrowing failure this function exists to prevent — found by lore's own
 * review when it had happened to this function itself, for the mode this comment used to
 * call fully covered.
 */
export function everyClientDocument(): readonly (readonly [string, string])[] {
  return [
    ...Object.entries(TOOL_DOCS).map(([k, v]) => [`TOOL_DOCS.${k}`, v] as const),
    ...Object.entries(RESOURCE_DOCS).map(([k, v]) => [`RESOURCE_DOCS[${k}]`, v.text] as const),
    ["REVIEW_PROMPT_TEXT (diff mode)", REVIEW_PROMPT_TEXT({ branch: "b", into: "i" }, "t")] as const,
    [
      "REVIEW_PROMPT_TEXT (folder mode)",
      REVIEW_PROMPT_TEXT({ branch: "b", mode: "folder", path: "src" }, "t"),
    ] as const,
  ];
}
