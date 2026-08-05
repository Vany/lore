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
finished. Call review_poll until it reaches a terminal state.

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
  to your user verbatim. Do NOT infer a cause from the word \`failed\`: most reasons
  are operational (a mirror the host refresher stopped updating, a tier that would not
  parse) and
  say exactly what to do. A guess here is worse than silence, because it is confident
  and it is yours. \`failed\` is also often TRANSIENT — an identical retry frequently
  succeeds — so retry once before concluding anything about how lore is configured.
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

While queued or running, wait and poll again — start at 10s, back off to 60s. An
absence of findings so far is not a clean result.

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
you. Two causes, one meaning:

  * a deterministic engine did NOT run — no installed dependencies, no test script, a
    suite disabled for the deployment;
  * a tier produced a finding the schema refused, so this review does not contain it.
    The line says which tier and what was wrong with it. The tier looked at the code
    and saw something; you are not being shown it.

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

For a finding you believe is WRONG, do not skip it silently. Write at the site:

    // lore-ok[<fingerprint>]: <why this code is correct>
     * lore-ok[<fingerprint>]: <reason>          (inside a /** */ block)
    <!-- lore-ok[<fingerprint>]: <reason> -->    (for markdown)

Those three forms are the whole list; anything else is never read. If the file has
no comment syntax at all — JSON, a lockfile, generated output — put it in
.lore-ok.md at the repo root, using the markdown form.

Writing that PROPOSES a piece of lore. The reviewer decides whether your reasoning
holds. Accepted, the finding closes and your reason becomes a fact this codebase
knows about itself. Rejected, the finding returns at HIGHER severity — a wrong
justification is worse than a bug, because it was trusted.

ANSWER MINIMALLY. Every word you submit is reviewed by the next tier, so a fix is
new surface and a long explanation is a lot of new surface. Measured on this tool's
own repository: ten rounds where each documentation fix wrote more documentation to
fault, against three rounds once the answers got terse.

  * A finding about BEHAVIOUR: change the code.
  * A finding about WORDING, or one you disagree with: prefer a lore-ok to a
    rewrite. A settled finding does not restart the ladder; rewritten prose does.
  * Say the reason once. Do not restate the finding, and do not explain the fix at
    length in a comment — the diff already shows it.
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
Deep findings across ALL your open reviews, since you last collected. Use this rather
than polling each review individually once you have several in flight.

Surface \`needs_human\` and high-severity findings to your user through whatever
alerting you have. Do not merely log them. lore cannot notify anyone — it returns
information and you decide what deserves attention. A finding nobody sees is a
finding nobody found.
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
`.trim(),
} as const;

export const RESOURCE_DOCS: Readonly<Record<string, { title: string; priority: number; text: string }>> = {
  "lore://docs/workflow": {
    title: "The review loop, end to end",
    priority: 1.0,
    text: `
1. review_start(branch, into, ticket) → review_id
2. review_poll(review_id) until findings arrive or the state is terminal
3. For each finding: fix it, or justify it with // lore-ok[fp]: <reason>
4. review_submit(review_id, diff, tree_hash)
5. Return to 2. Repeat until the state is TERMINAL — \`passed\`, \`passed_partial\`,
   \`needs_human\`, \`failed\` or \`expired\`.

Rules that decide whether this works:
- Polls return only new findings. Never re-fix what is not in the response.
- \`failed\` and \`expired\` are not \`passed\`. Report and stop; do not merge.
- \`fast_clean\` is not \`passed\` either — the deep tiers have not run.
- \`passed_partial\` is terminal and will NEVER become \`passed\`, so waiting for that
  never returns. Attest it, and say plainly that the evidence is weaker than a pass.
- Expect several rounds. Every fix resets the ladder to the cheapest tier, because a
  fix is unreviewed code.
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

\`passed\` and \`passed_partial\` both support an attestation. The partial one is the
case that most needs the record, because the line names what was skipped.
`.trim(),
  },

  "lore://docs/ladder": {
    title: "Why escalation exists",
    priority: 0.5,
    text: `
T0  the repo's own tsc, eslint, ast-grep, semgrep and tests. Deterministic and free.
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
1. review_start(branch: "${branch}", into: "${into}", ticket: <paste the ticket, do not summarise>)
2. review_poll(review_id) until findings arrive or the state is terminal
3. For each finding: fix it, or justify it with // lore-ok[fp]: <reason>
4. review_submit(review_id, diff, tree_hash)
5. Return to 2. Repeat until the state is TERMINAL — \`passed\`, \`passed_partial\`,
   \`needs_human\`, \`failed\` or \`expired\`. Only \`passed\` and \`passed_partial\` are
   worth attesting, and only \`passed\` is clean.

Rules:
- Polls return only new findings. Never re-fix what is not in the response.
- \`failed\`, \`expired\` and \`fast_clean\` are not \`passed\`. Do not merge on them.
- \`passed_partial\` is TERMINAL: it will never become \`passed\`, so looping for that
  never ends. Attest it — the line names which tiers were skipped and which vendor
  looked — and tell your user the evidence is weaker than a pass, so the decision to
  merge is theirs.
- Expect several rounds. Every fix resets the ladder to the cheapest tier.
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
