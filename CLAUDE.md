# CLAUDE.md — `lore`

A workgroup MCP service that **remembers a codebase between sessions**. Reviews are
the mechanism; the shared memory is the product. If a change makes the reviews
better and the memory worse, it is the wrong change.

Ground truth is `SPEC.md`, where decisions are marked `D-n`. Beside it, `spec/`
holds the surface in detail — `knowledge.md` (the product), `review-ladder.md`,
`mcp-api.md`, `agent-docs.md`, `deployment.md`, `operations.md`.

## The one rule that outranks the others

**A review that did not run is not a review that found nothing.**

Every ambiguity in this codebase resolves toward *saying so loudly*. If I cannot
tell whether a reviewer actually ran, the answer is failure, not success. Four
silent failures in one day are the reason this project exists in this shape.

## Working agreement

- **Commit, review in BATCHES, amend, push** (D-77, revised 2026-08-15). lore gates other people's
  branches; it gates its own the same way. After committing I drive a full review over
  MCP — as a client, not through the CLI (D-76) — answering findings with
  `review_submit` so the ladder re-reads the corrected tree, until it reaches `passed`
  or `passed_partial`. Then I amend the commit with exactly what was submitted, and
  only then push. `needs_human` is a blocker, not an ending: get a person, resolve it,
  carry on.
  **Code or specs fire a review; tests, `TODO.md` and `MEMO.md` do not** — with one
  exception, because adding a test cannot weaken anything but REMOVING one changes what
  the gate catches, invisibly to the suite. A test-only diff that deletes tests or cuts
  assertions is reviewed like code. A skipped review is stated in the commit, never
  silent.
  A commit may reach `origin/main` unreviewed; a BATCH may not go unreviewed
  indefinitely, and every override says so in its own commit. Nothing reaches a VERDICT
  that a ladder has not read — `main`, not `origin`,
  because a review is cut from the mirror, so getting an unpushed commit reviewed needs
  a scratch `refs/heads/review/<sha>` branch that is by definition unreviewed when it
  lands — a BRANCH under `refs/heads/*`, spelled out in full here because the shorter
  "`review/<sha>` ref" once read as a top-level ref of its own, sent a fix at the mirror
  for a bug the mirror never had, and cost a review round catching it. Push and
  delete it in one command; nothing sweeps `refs/heads/review/*`. SPEC D-77 has the
  shape and the open questions, including what this costs in quota.
  **A batch needs TWO refs: `refs/heads/review-base/<sha>` at the commit before the
  batch, and `refs/heads/review/<sha>` at its tip, reviewed base-ref into tip.**
  `into: main` cannot name
  "before this batch" once any of the batch is on `main` — and under this gate some of it
  always is. The merge-base then slides forward and the ladder silently reviews a
  fraction of the work, then none of it (D-113).
- **A `failed` review blocks the push exactly as findings do, and the response is to
  fix lore.** `failed` means the ladder did not read the code — INV-1 in its original
  words — so pushing past it ships unreviewed work while believing otherwise. Fixing
  the reviewer comes ahead of whatever the commit was for; a gate that cannot run makes
  every claim behind it worthless. Quota is the exception the ladder already handles
  (D-48), and a provider that is down means wait, not push.
- If reality disagrees with `SPEC.md`, I update SPEC in the same change. Drift is a
  defect whichever side moved (D-11), and it is this repository's most common one.
- **The MCP texts move with the behaviour, in the same change.** `TOOL_DOCS`,
  `RESOURCE_DOCS` and `REVIEW_PROMPT_TEXT` in `src/mcp/docs.ts` — and
  `src/reviewer/prompts.ts` when a *model* is what learns differently. The client is
  an agent, so these strings are the entire interface: there is no other way for it
  to find out what changed. A behaviour change that does not reach them leaves a
  client acting confidently on the old contract, which is this project's defining
  failure in its most avoidable form. Where a mechanical check is possible, write one
  — `src/mcp/docs.test.ts` and the field test in `src/service/http.test.ts` exist so
  drift fails the suite instead of waiting to be noticed.
- Specs and docs describe the system **as it stands**. The reasoning that makes a
  decision right belongs there; the sequence of changes that produced it belongs in
  `MEMO.md` and the git history. Code comments are the deliberate exception — per
  `PROG.md`, a guard carries the incident it guards against, in enough detail to
  reconstruct it.
- `[OPEN]` in SPEC means *I decided this alone because it blocked me*. I flag it
  when it becomes load-bearing, rather than letting it harden by default.
- Notes in `research/` carry the date they were checked; anything older than a few
  weeks gets re-checked, not trusted. **Model ids are read from opencode's
  `/config/providers`, never from memory or from what the name implies** — `k3`
  carries 1M tokens of context and `k3-256k` carries 262k.
- Money is involved (three subscriptions). Anything that changes *which* model is
  called, or how much quota it burns, is discussed before it ships.
