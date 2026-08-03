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
finished. Call review.poll until it reaches a terminal state.

The review is pinned to the branch as it stands now. Commits you push afterwards are
NOT included; start a new review for those.

Expect several rounds of findings. That is the process working, not failing.
`.trim(),

  poll: `
Fetch findings discovered since your last poll.

Returns ONLY NEW findings. Anything you have already been shown will not appear again
— do not re-fix something absent from the response.

States: queued, running, findings_ready, awaiting_diff, fast_clean, needs_human,
passed, failed, expired.

ONLY \`passed\` means the branch is clean.

- \`failed\` and \`expired\` mean the review did not complete. They are NOT "nothing
  found". Never merge on them.
- \`fast_clean\` means only the cheap tiers have finished; the deep tiers are still
  running. It is NOT a pass.
- \`needs_human\` means a question was found that you must not answer yourself.
  Ask a person. Do not guess, and do not close it with lore-ok.

While queued or running, wait and poll again — start at 10s, back off to 60s. An
absence of findings so far is not a clean result.
`.trim(),

  submit: `
Submit your fixes as a unified diff, with the git tree hash of your working tree
after applying them.

Applied to the review's private worktree. Nothing is committed or pushed — your
history stays yours. The tree_hash is verified after applying; a mismatch fails
loudly rather than reviewing code that exists nowhere.

For a finding you believe is WRONG, do not skip it silently. Write at the site:

    // lore-ok[<fingerprint>]: <why this code is correct>
    <!-- lore-ok[<fingerprint>]: <reason> -->   (for markdown)

Writing that PROPOSES a piece of lore. The reviewer decides whether your reasoning
holds. Accepted, the finding closes and your reason becomes a fact this codebase
knows about itself. Rejected, the finding returns at HIGHER severity — a wrong
justification is worse than a bug, because it was trusted.
`.trim(),

  attest: `
Available once state is \`passed\`. Returns one signed line recording what was done:
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
1. review.start(branch, into, ticket) → review_id
2. review.poll(review_id) until findings arrive or the state is terminal
3. For each finding: fix it, or justify it with // lore-ok[fp]: <reason>
4. review.submit(review_id, diff, tree_hash)
5. Return to 2. Repeat until the state is \`passed\`.

Rules that decide whether this works:
- Polls return only new findings. Never re-fix what is not in the response.
- \`failed\` and \`expired\` are not \`passed\`. Report and stop; do not merge.
- \`fast_clean\` is not \`passed\` either — the deep tiers have not run.
- Expect several rounds. Every fix resets the ladder to the cheapest tier, because a
  fix is unreviewed code.
- Do not use lore-ok to make an inconvenient finding go away. The reviewer rules on
  it, and a rejected justification returns worse than it left.
- Before fixing in unfamiliar code, knowledge.query it — someone may already have
  decided this, for a reason.
- When you learn something durable, knowledge.teach it.
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
failed          did not complete — NOT "found nothing"
expired         abandoned or timed out — NOT "found nothing"

Only \`passed\` supports an attestation.
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
1. review.start(branch: "${branch}", into: "${into}", ticket: <paste the ticket, do not summarise>)
2. review.poll(review_id) until findings arrive or the state is terminal
3. For each finding: fix it, or justify it with // lore-ok[fp]: <reason>
4. review.submit(review_id, diff, tree_hash)
5. Return to 2. Repeat until the state is \`passed\`.

Rules:
- Polls return only new findings. Never re-fix what is not in the response.
- \`failed\`, \`expired\` and \`fast_clean\` are not \`passed\`. Do not merge on them.
- Expect several rounds. Every fix resets the ladder to the cheapest tier.
- Do not use lore-ok to make an inconvenient finding go away.
- Before fixing in unfamiliar code, knowledge.query it.
- When you learn something durable, knowledge.teach it.
- If the state is needs_human, STOP and ask a person. Do not answer it yourself.

The ticket for this change:
${ticket.trim()}

When the state is \`passed\`, call review.attest and give the user that line.
`.trim();
