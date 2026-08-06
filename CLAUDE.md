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
