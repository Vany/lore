# Prior art: `~/c/review`

**Verified 2026-08-03** by reading the script directly (`/Users/vany/c/review`,
14935 bytes, bash, last modified 2026-08-02).

Vany's description: *"garbage on the background of what I want to create."* The
bash is disposable. The **header comment is not** — it is an incident log, and
every entry in it cost real debugging time. This file preserves that knowledge
independently of the script, because the script will be replaced.

Each incident maps to an invariant in `SPEC.md` §6.

---

## What the script does today

Two reviewers in parallel, one per model, each on its own opencode server:

| | model | port |
|---|---|---|
| GLM | `openrouter/z-ai/glm-5.2` | 4096 |
| SOL | `openrouter/openai/gpt-5.6-sol-pro` | 4097 |

Both use a read-only opencode agent (`readonly`), both get the same prose prompt
containing the working-tree diff, and both outputs are printed for the caller to
read. Called just before a commit. Exits non-zero if either reviewer fails.

**Note:** both go through **OpenRouter** — pay-per-token. Moving to the Z.AI and
OpenAI subscriptions is the change Vany is buying (`SPEC.md` D-5).

---

## The incidents → INV-1…9

### INV-1 — a review that did not run is not a review that found nothing
**Four reviews failed silently in one day** before anyone noticed. The script now
states this three times in one file and shouts on every failure path — including
an audible cue (`boo.mp3` via `~/c/notify`), on the reasoning that *a broken
reviewer that is merely logged gets skipped*, and that a sound is the part that
cannot be scrolled past.

This is the most important thing in the whole script. It is the first invariant
here and the top rule in `CLAUDE.md`.

### INV-2 — base is `origin/main`, never stale local `main`
A stale local `main` **turned a one-file branch into a 496-file, 3.0 M-char diff**,
which was then truncated to the prompt cap — so both models reviewed mostly other
people's already-merged work, and reported on it confidently.

`git fetch` alone does *not* move local `main`; it only moves `origin/main`. Local
`main` once sat **57 commits and two days behind** while every session was fetching
constantly. Resolution order is now `origin/main` → `main` → `origin/master` →
`master`.

### INV-3 — the diff is the working tree, not `BASE...BRANCH`
This is a *pre-commit* review. A committed-only diff lets uncommitted work pass
unreviewed — which is precisely the work most in need of review.

### INV-4 — untracked files are not in the diff
They are invisible to `git diff` entirely. The script lists them by name and says
their contents are not shown.

### INV-5 — no global lock
The old version held a `flock` for the whole run. Two distinct failures came out of
it:
1. `exec 9>lock` **leaked the fd into the spawned server**, so a *daemon* held the
   review lock for its entire life.
2. The blocking wait had **no timeout**, so runs queued behind an orphan for **7
   and 10 hours, in silence**.

Contention belongs where it actually is — the session — not around whole reviews.

### INV-6 — opencode sessions are single-flight
A second concurrent prompt to a BUSY session is rejected (`"Session ... is busy"`).
The script keeps a session pool: find sessions whose title carries a known prefix,
try them in turn, create a fresh one only when every one is busy. Pool size is
capped (`MAX_POOL=6`).

### INV-7 — a truncated diff is announced
Cap is 600 000 chars. On truncation the script says so, appends a marker telling
the reviewer to read the rest from the worktree, and warns that an unexpectedly
large diff usually means the *base* is wrong (see INV-2).

### INV-8 — `--agent` silently falls back to the write-capable default
If the named agent does not exist, opencode does **not** error — it quietly uses
the default agent, which **can write**. So a missing `readonly.md` turns a
read-only reviewer into a write-capable one, silently. The script therefore checks
`opencode agent` output for the name and warns loudly.

This one is a genuine security-shaped trap and must survive the rewrite.

### INV-9 — reviewers are read-only
The `readonly` agent sets `write/edit/patch: false`, keeps `bash: true` for
inspection, and forbids `git add`, `commit`, `checkout`, `reset`, `stash` in prose.

---

## Two more hard-won details

**`curl -w '%{http_code}'` already prints `000` on connection failure.** The old
`|| echo 000` fallback concatenated to `"000000"`, which `!= "000"` — so a **dead
server was reported as alive**. Any status at all, 401 included, means something is
listening.

**No `$(cat <<EOF)` under bash 3.2** — the only bash on this machine. It cannot
scan for the closing paren across a heredoc whose body contains unbalanced parens,
and prose prompts always do. It failed at **runtime**, long after the parts that
looked risky had already succeeded. `read -r -d ''` needs no subshell.

This is the single best argument for `SPEC.md` D-3 (leave bash): the failure was
invisible until production, and an entire class of it disappears with a typed
language and a real SDK.

---

## What the rewrite must *not* inherit

- **Prose output.** Free-text reviews cannot be deduped, tracked or adjudicated,
  so there is no way to build the ledger (`SPEC.md` §4.3) on top of them. This is
  the central limitation.
- **Fan-out instead of escalation.** Both models run on every review, always. That
  is exactly the quota burn the ladder is meant to avoid.
- **No memory between runs.** Nothing records that a finding was already
  considered and dismissed, so every run re-litigates the same points.
