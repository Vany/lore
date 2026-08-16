# BUGS — the review process, from the client's side

Everything here was hit while DRIVING lore as a client over MCP, not while reading its
code. That is the whole value of the list: these are things a review agent cannot work
around and a code reader would not think to look for. Dated, with what it actually cost.

Not a duplicate of `TODO.md`. TODO holds work on the service; this holds friction in the
LOOP — the thing D-77 says we must be able to complete before anything reaches
`origin/main`. Where a bug here has an owner in TODO, it says so.

---

## 1. A `git diff` cannot survive a tool-call parameter, and nothing warns you

**ADDRESSED 2026-08-15 (D-111.1) — by removing the need to send one.** `TOOL_DOCS.submit`
now leads with push-then-`pull_fresh`, which re-pins the same review to origin's new tip
with everything carried and no diff on the wire at all. `review_submit` stays for clients
that genuinely cannot push. The mechanism already existed; what was missing was saying so.


**2026-08-14. Cost: one refused submit, two full re-transcriptions, ~40 minutes.**

A unified diff is whitespace-significant: a context line for a blank source line is a
single space. A tool-call argument strips it — verified directly, writing `"a\n \nb\n"`
produced `a\n\nb\n`. So an agent that composes a diff into `review_submit` sends a
corrupted one, every time, with no way to notice.

`applyPatch` already uses `git apply --recount` for exactly this, and it works — the
first refusal I hit was actually a *different* transcription error, and the blank-context
loss would have been forgiven. But that is luck, not design: recount rescues line counts,
not content.

**The deeper problem is that the diff must be retyped at all.** ~40 KB, by hand, with no
opportunity to verify before sending. I caught my own corruption only by writing the
diff to a file and `cmp`-ing it against git's output — a step no client can perform,
because the file it would compare against is on the machine the client is not on.

**Shapes worth weighing:** a `tree_hash`-only submit where lore diffs the pushed branch
itself (the client pushes, lore fetches — no diff on the wire at all); or an
idempotency/echo field so a client can verify what arrived before it counts.
`pull_fresh` is already close to the first shape and could probably subsume submit.

---

## 2. `will_not_settle` tells you to write a marker and withholds the id you need

**FIXED 2026-08-15 (D-111.2).** It now carries `fingerprint` and a ready-to-paste
`justify_with`.


**2026-08-14. Cost: ~7 findings blocked, worked around only with direct database access.**

The reply is explicit and correct: *"say so AT THE NAMED LINE with a
`lore-ok[<fingerprint>]: <why>` comment and submit again"*. It lists `file`, `line` and
`claim` — and no fingerprint. The marker cannot be written without one.

I recovered them with a SQL query inside the container. **A real client has no such
escape.** It would have to re-poll and hope, and a poll returns only NEW findings, so the
ids it needs are precisely the ones it will never be shown again (see 3).

**Fix:** put `fingerprint` in every `will_not_settle` entry. One field.

---

## 3. Poll returns deltas only, so a client that loses its notes cannot recover them

**ADDRESSED 2026-08-16 — the capability already existed and nothing said so.**
`lore://review/{id}` returns every finding in full, owner-checked through `mine()`, and
consumes nothing. Verified by reading it as a client over MCP, not by reading the code:
six findings came back complete with claim, evidence, failure scenario and fingerprint.

So the entry below is wrong where it says the client channel cannot reach it — the
channel was there and no text mentioned it, which for an agent is the same thing. Fixed
in `TOOL_DOCS.poll`, the workflow resource and the resource's own title. **The general
lesson is the one worth keeping: a capability an agent is not TOLD about does not exist.
There is no README to find it in.**


**2026-08-14, several times.**

`review_poll` consumes what it returns. Correct for the delivery model, and it means a
session that crashes, compacts, or simply forgets has no way to re-read its own open
findings. There is no "show me everything still open" call.

`review_inbox` reports COUNTS, not the findings. The information exists — the operator
board renders it — but the client channel cannot reach it.

**Fix:** a read-only listing that does not consume. `lore://review/{id}` may already be
the right home for it.

---

## 4. The same defect arrives twice under two fingerprints, and each needs its own marker

**2026-08-14. Cost: two extra `lore-ok` blocks for one defect, twice.**

`49451a88` and `d9ec8874` are the same finding on the same line; the second's own text
says *"the same finding, reported twice"*. `07e83abc`/`e5ca0c9a` likewise. Because the
fingerprint is `sha256(claim ‖ file ‖ symbol)` and the claims were reworded between
rounds, they are different findings to the system and identical to a reader.

Answering both is pure ceremony, and it is the ceremony that makes a client stop reading
carefully. SPEC §3.1.1 already names paraphrase-churn as the known weakness of the
fingerprint and defers a similarity key for want of evidence. **This is the evidence.**

---

## 5. "Fixed one layer in" costs a round every time

**ADDRESSED 2026-08-16 — and it was never a round, it was a sentence.** The marker can
ride in the SAME diff as the fix: the round applies the submit and then reads both the
code change and the justification, so one submit settles it. `TOOL_DOCS.submit` said
*"say so at the named line with a lore-ok and submit again"*, and that word is where the
extra round came from — a client that follows it fixes, submits, reads `will_not_settle`,
and submits a second time for something it knew when it chose where to fix. The text now
says to put the marker in with the fix, and points at `.lore-ok.md` for the case the
entry below never names: a finding whose line the fix DELETED, where there is no site
left to write at.

**Two of the five bugs in this list turned out to be capabilities that existed and were
not said** (this and §3). That is the pattern worth carrying: when the loop feels
expensive, check whether the engine already does it before designing a protocol addition.
For an agent there is no README to stumble across — the tool text is the entire world,
so an unsaid capability and an absent one are the same thing.



**2026-08-14/15, at least six times, and four rounds on one seam.**

D-56 settles a finding only when the code AT THE NAMED LINE moved. But the right fix is
routinely somewhere else — a caller, a writer that never existed, a shared predicate. The
protocol's answer is to write a `lore-ok` at the original line explaining where the fix
went, which works, and costs a full deep round each time.

The `pull_fresh` seam took FOUR rounds this way: wrong tree compared → fix was dead code
→ fix destroyed the worktree before deciding → fix read the wrong ref namespace. Each was
a genuine defect and the reviewer was right every time; the cost is that "I fixed it over
there" is not sayable in a submit, only in a source comment.

**Worth considering:** a `fixed_elsewhere` field on submit naming the finding and the
commit range, ruled on like any justification.

---

## 6. A review that dies at the top tier throws away the tiers that passed

**2026-08-14/15. Cost: 13 reviews, most of a day, across three clients.**

Thirteen consecutive reviews reached t3 and died on `Token refresh failed: 401`. Each had
already paid t0, t1 and t2 in full — several with clean verdicts from two independent
vendors — and all of it was discarded. `failed` is correct per INV-1: the top tier never
read the code. But a client is left with nothing, when what actually existed was
*"two vendors agreed and the third could not be reached"*, which is `passed_partial`'s
exact meaning.

The credential fault is fixed (auth is now a route fault and walks the chain). **The
structural question stands:** should a tier that cannot be reached at all — as opposed to
one that ran and failed — be an `unavailable` skip rather than a review-killer? D-48
already says yes for quota. This is the same fact wearing a different error class.

---

## 7. A crashed round used to report no reason at all

**2026-08-15. FIXED in `73ae6d9`, recorded because the shape recurs.**

`worker.round`'s catch wrote to `job.last_error` — a column no client can read — and set
`failed` without touching `failed_because`. Every LADDER stop was explained; every CRASH
was silent. Backwards, since a crash is the one a client cannot guess at.

Vany found it by asking me why a review failed, and the only answer available was a SQL
query. **The lesson generalises: whenever a new failure path is added, ask which channel
the CLIENT reads.** It is never the log.

---

## 8. Timing guidance is per-tier, and a client wants the review's total

**Ongoing, minor.**

`check_back_after_ms` is well-built — measured from this repository's own completed
rounds, and it shrinks as a round ages. But it answers *"how long until this TIER
answers"*, and an agent deciding whether to wait or go and do something else wants
*"how long until this REVIEW ends"*. Nothing exposes that, and rounds multiply: a
five-round review is five of those numbers, none of which sum to anything.

---

## 9. My own worst habit, recorded because it cost more than any bug here

**2026-08-15.**

I twice reported a fault that did not exist, from a stale read: once computing "t1 has
been running 415 minutes" from a `started_at` I had cached several turns earlier without
re-checking whether it had finished (it had, long before), and once reporting a review as
still running when it had passed eighteen minutes earlier.

Both times the DATA was one query away and I used a remembered value instead. In a system
whose entire premise is that a claim must be checked rather than assumed, reporting a
seven-hour hang that never happened is the same defect the service exists to prevent,
committed by the person operating it. **Re-read before reporting. Every time.**
