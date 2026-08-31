# Refactor suggestions — an MCP tool that asks what is worth restructuring

**Not a review.** `refactor_start`/`refactor_poll` gate nothing, produce no findings,
and cannot reach an attestation. They ask several models what in a folder, at a commit,
is worth restructuring, and hand back a merged list — spending real quota to do it,
the same as `propose` (`spec/propose.md`, D-75), and answering a genuinely different
question than review does. SPEC: D-136.

Started explicitly, by a customer, on purpose — never triggered by a review, never
blocking one, never run on a schedule.

## 1. Relationship to `propose`

Both ask a model what it would change about a folder's code rather than what is wrong
with it, both are separate from the review ladder, and both spend real quota doing it.
The similarity ends at the question. `propose` runs ONE tier (whichever is configured
deepest) through four adversarial LENSES in sequence — data, failure, seams, greenfield
— each idea optionally checked by a cross-vendor critic that can reject it outright, and
writes a markdown document for a **person** to read later (`spec/propose.md` §2, §6).
This tool runs a FIXED set of named tiers **concurrently**, with no lens and no critic,
and a third, smaller tier merges what came back into one list, returned over MCP to
whatever asked — an **agent client**, not necessarily a person, structured rather than
prose, and stored rather than written to a file.

Deliberately not folded into `propose`'s own proposer/critic loop: the orchestration
shape is different (sequential-single-tier-per-lens vs. parallel-named-tiers-plus-merge)
and so is the consumption model (CLI document for a person vs. MCP tool for an agent).
Bending one to answer both would have made neither shape honest. What IS reused: the
same git-cut-a-commit-into-a-worktree machinery (`worktreeFor`, `src/git/repo.ts` —
`propose` already calls this with an arbitrary `--commit`, not only a branch tip, so
"a commit and a folder" needed no new plumbing) and the same "ask a tier for something
that is not findings" seam (`ReviewerLike.askFor`, `src/reviewer/opencode.ts`) both
tools call through.

## 2. What runs

```
tiers marked "refactor": true, each independently:
  read the folder at the commit, cold  ──►  a set of suggestions

                    │  (however many succeeded — one tier failing
                    │   does not sink another's paid-for answer)
                    ▼

      t1  ──►  merges every set into one, deduplicated

                    │
                    ▼

         stored, returned on refactor_poll
```

Every tier marked `"refactor": true` in the active `LORE_TIERS` config runs
**concurrently**, each reading the folder independently — none sees another's answer
before writing its own, the same "consensus is a smell" reasoning `propose`'s lenses
are forced apart for (`spec/propose.md` §3), applied here by running the fan-out members
blind to each other rather than by forcing distinct vantages onto one tier. `t1` is not
itself a fan-out member — its role is fixed by id, not by the `refactor` flag — and
never re-reads the folder: it is handed the raw sets and asked to reconcile them, not to
generate its own third opinion (Vany's own call: the combiner's job is merging
viewpoints, not deriving a third one, and reading the tree again on every call would be
a third full-context read for a task that does not need one).

**One tier failing is reported, not fatal.** Every fan-out call is caught independently
(`src/refactor/run.ts`); a failed tier's reason travels on its own `sources` entry, the
same "a tier that could not run is reported, never silently absent" reasoning INV-1
states for review's `checks_skipped`. Only every tier failing refuses the whole run.

**The merge can fail too, and falls back rather than discards.** If `t1` is not
configured, fails, or replies with nothing from a non-empty input, the run still
completes — `combined: false`, `combiner_note` says why, and `suggestions` carries the
raw, un-deduplicated union of what the fan-out tiers produced. A paid-for answer is
never thrown away because the cheapest step of the three happened to be the one that
misbehaved.

## 3. What a suggestion carries

Deliberately smaller than `propose`'s `Proposal` (`spec/propose.md` §4) — no
`settledBy`, `preserves`, `contradictedBy`, `trueIf`, `costIfWrong`: this is not an
adversarially-appraised idea with a stated falsifying measurement, it is a shorter,
looser opinion meant to be read as a list, merged and deduplicated across two or more
answers rather than defended by one.

```jsonc
{
  "title": "one line, plain enough to sort a list by",
  "area": ["src/store/store.ts", "src/store/schema.ts"],
  "rationale": "why this is worth doing",
  "roughSize": "small | medium | large, or omitted"
}
```

`area` is folder-scoped, never line-anchored — a refactor suggestion is about a file or
a directory's shape, not a specific line the way a finding is. Required: a suggestion
that cannot be placed cannot be acted on, and (`src/refactor/suggestion.ts`) is refused
at parse time rather than kept with an empty scope.

## 4. Persistence — stored and queryable, unlike `propose`

`propose` is fire-and-forget: it writes a markdown document and has no way to later
learn what became of a surviving idea (`spec/propose.md` §6). This tool's suggestions
are written to their own tables (`refactor_run`, `refactor_suggestion`,
`src/store/schema.ts`, D-136) — Vany's explicit call, on this project's own stated
purpose: the shared memory is the product, and a suggestion generated and then
forgotten is exactly the kind of thing this service exists to keep.

**Deliberately not folded into `knowledge`.** A suggestion is an opinion about what
would be better to own, not a settled fact the way a `fixed` finding's derived lesson
is (`spec/knowledge.md`), and `knowledge_query` answering with a mix of "this codebase
is known to X" and "a model once thought Y might be worth restructuring" would blur a
distinction this project has drawn carefully elsewhere (`src/propose/run.ts`'s own
`knowledgeBlock`, which already separates taught fact from a model's unverified first
reading for the same reason).

**No recurrence tracking in this version.** A suggestion repeated across several runs
would read as more urgent — the same argument `history` makes for a recurring finding
— but matching one run's suggestions against another's needs its own design (what makes
two suggestions "the same" when neither is keyed by a stable fingerprint the way a
finding is) and is not required to make the first version useful. Left for later,
named rather than silently missing.

## 5. Why this has an MCP surface, and `propose` does not

`propose` stayed CLI-only on the argument that its output was unvalidated by a person
(D-16, `spec/propose.md` §8: *"MCP is one wrapper away once it has earned it"*). This
tool has one from the start — Vany's explicit request, "add a new tool" — because the
consumer here is an agent client working a repository, the same audience every other
tool in `spec/mcp-api.md` answers, and a suggestion queued, polled and read back
structured is exactly the shape that audience already expects from `review_start`/
`review_poll`. Wire shape: `spec/mcp-api.md` §8.

Authenticated and scoped exactly like every other tool — a bearer token bound to one
repository (`src/mcp/auth.ts`). `refactor_poll` carries no token-binding half the way
`review_poll` does (D-78): nothing here is marked delivered or consumed, so there is no
colleague-loses-their-findings accident to guard against, and repository scope alone is
enough.

## 6. Bounds

**Cost, stated plainly — money is discussed before it ships.** Each call spends
`(tiers marked "refactor": true) + 1` model sessions: three with today's t2+t3 marked.
Comparable to one lens of `propose` (proposer + critic = two sessions) or to a deep
review round — a whole folder is read, not a diff, so the prompt is comparably sized.
No `--budget`-style ceiling: the shape is fixed rather than an open loop over lenses,
so there is nothing for a budget to bound that isn't already bounded by which tiers are
marked. Same subscriptions, same fallback chains (D-93), same quota accounting as
review and `propose` — nothing new is introduced on the money side, only a new caller
of machinery that already exists.

**Its own dispatcher, its own queue, sharing the process.** `job`/`claimJob`
(`src/store/schema.ts`) are review-round-shaped — a `review_id` foreign key, fast/deep
stage escalation — and a refactor run has neither a round nor an escalation to make.
`RefactorWorker` (`src/service/refactor-worker.ts`) claims from `refactor_run` directly
and runs beside `Worker`'s own dispatch loop in the same process, sharing the one
`Reviewer` gate every model call in this service already shares.

## 7. What is deliberately absent

- **No findings, no fingerprints, no verdicts, no attestation.** Nothing here can
  settle, reopen, or appear in a review — the same line `propose` draws (§8 there).
- **No automatic implementation.** A suggestion is read and acted on by whoever asked;
  nothing here writes code. The same reasoning `propose` states for itself applies with
  identical force: a suggestion applied without review would be this project's own
  defining failure, self-inflicted.
- **No lens, no critic, no knowledge screen.** `propose`'s adversarial machinery exists
  to protect a person about to spend real effort on one large, persuasively-argued idea.
  This tool returns a shorter, looser list explicitly meant to be skimmed and judged by
  its reader — different output, different protection needed, and none of `propose`'s
  is assumed to transfer.
- **No behaviour change, ever.** A refactor changes structure, never what the code
  does — asked for explicitly in the prompt each fan-out tier is sent
  (`src/refactor/prompt.ts`), the same "keep the functionality" clause `propose`
  states for its own proposals.
