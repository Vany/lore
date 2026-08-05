# CLAUDE.md — `lore`

Project-local rules. Second part of the general rules in `~/.claude/CLAUDE.md`;
that file wins on anything not covered here.

## Read before working

1. `SPEC.md` — what this is and why. Decisions live here, marked `D-n`.
2. `spec/` — `knowledge.md` (the product), `mcp-api.md`, `review-ladder.md`.
3. `PROG.md` — how code is written here.
4. `MEMO.md` — what I learned last time.
5. `TODO.md` — what to do next, in order.
6. `research/` — grounded external facts, each with a verification date.

## What this project is

A workgroup MCP service that **remembers a codebase between sessions**. Every
Claude session starts amnesiac; `lore` is the shared memory.

Reviews are how the knowledge gets made — an escalating ladder of **non-Anthropic**
models, gating a branch before it merges. But the reviewing is the mechanism, not
the point. If a change makes the reviews better and the memory worse, it is the
wrong change.

## The one rule that outranks the others

**A review that did not run is not a review that found nothing.**

Every ambiguity in this codebase resolves toward *saying so loudly*. If I cannot
tell whether a reviewer actually ran, the answer is failure, not success. Four
silent failures in one day are the reason this project exists in this shape.

## Working agreement

- SPEC is ground truth. If reality disagrees with SPEC, I update SPEC in the same
  change — I do not let code and spec drift apart quietly.
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
- I verify current versions, APIs and model names before relying on memory. Notes
  in `research/` carry the date they were checked; anything older than a few weeks
  gets re-checked, not trusted.
- I do not add unrequested features. This tool has one job.
- Money is involved (two subscriptions). Anything that changes *which* model is
  called, or how much quota it burns, is discussed before it ships.

## Boundaries

- No autonomous `git commit`, `push`, or `merge` from the tool itself.
- Reviewer agents are read-only, always (INV-9).
- Nothing writes to a user's repo without explicit opt-in (D-2).
