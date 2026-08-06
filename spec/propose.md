# `lore propose` — the idea generator

**Not a review.** It gates nothing, produces no findings, and cannot reach an
attestation. It asks the dearest models what they would change about this codebase,
spends real quota doing it, and hands a person suggestions to appraise. SPEC: D-75.

Run it rarely — when there is appetite for a large change and time to evaluate one,
not on a merge and not on a schedule.

---

## 1. The shape

```
lore propose --target . --budget 8 [--lens seams,failure,data,greenfield] [--json]
```

| flag | meaning |
|---|---|
| `--budget N` | how many **model sessions** to spend, proposers and critics together. Required: the cost is the point, so it is stated rather than discovered |
| `--lens a,b,c` | which vantages to run. Defaults to all four |
| `--target` | repository to think about (default: cwd) |
| `--json` | the document as data, for a script |

Writes `proposals/YYYY-MM-DD-<n>.md` and prints the path. Exit `0` when it produced a
document, `70` when it did not — *did not run* is never *found nothing*, here as
everywhere.

## 2. What runs

```
 for each lens:  proposer  ──►  one idea, with its kill criteria
                    │
                    ▼
              critic (DIFFERENT VENDOR) ──► what it costs, what contradicts it
                    │
                    ▼
              knowledge screen ──► already decided? annotate and rank last
                    │
                    ▼
              proposals/<date>.md
```

**One idea per proposer, never a list.** Asked for thirty a model pads to fill the
count and the padding is generic; asked for the one change it would make if it could
make only one, it answers with what it believes.

**The critic is a different vendor from the proposer** (D-1, applied to ideas). A model
grading its own suggestion confirms the design it already had in mind, which is the
same argument that keeps Claude out of the review ladder.

## 3. The lenses

Forced apart on purpose. The same open question sent to three models returns three
versions of the safe answer, and **consensus here is a smell** — agreement means the
question was too easy, and the ideas worth having are the ones only one lens saw.

| lens | what it is told to attack |
|---|---|
| `data` | the schema, the store, what is denormalised, what a transaction spans |
| `failure` | what breaks under partial failure, restart, concurrency, a dead upstream |
| `seams` | module boundaries: what knows too much about what, what cannot be tested alone |
| `greenfield` | *"you have six months and no compatibility constraint. What would you build instead?"* |

`greenfield` is the one most likely to waste the budget and the only one that can
produce a genuinely structural idea. It stays.

## 4. What a proposal must carry

Deliberately **not** the finding schema. `evidence` and `failureScenario` make a model
defensible, and a defensible model is a boring one — which is the opposite of this
tool's purpose (D-75).

```jsonc
{
  "lens": "seams",
  "idea": "one paragraph, in the model's own words",
  "trueIf": "what would have to be true for this to be worth doing",
  "costIfWrong": "what it costs to find out this was a mistake",
  "contradictedBy": "what in the repo or its rules argues against it",
  "settledBy": "ONE measurement that would decide it"
}
```

**`settledBy` is the load-bearing field and is printed first.** A proposal that cannot
name its own falsifying measurement is one nobody can appraise, and that is exactly the
kind that costs a fortnight.

The motivating case is the session this was designed in: a large refactor was proposed,
`wc -l` and a twenty-line export-reachability script killed it in ten minutes, and the
measurement *was* the appraisal. The danger is never a bad idea — a bad idea dies in
five seconds. It is a plausible one.

A proposal missing `settledBy` is **kept and ranked last**, never dropped: this is a
generator, and silently discarding its output would be the failure D-66 already
settled for findings. It is marked `unappraisable` and says so.

## 5. The knowledge screen

Every proposal is matched against the repository's own knowledge before a person reads
it. This is the only filter that removes ideas without blunting them, because it
removes only the ones already had.

- A proposal restating something the repository has **decided against** is annotated
  with that decision and its date, and ranked last.
- A proposal contradicting a **taught** rule is annotated with it. Not dropped —
  taught rules can be wrong, and a model arguing against one is worth reading — but
  the reader is told they are arguing with a decision rather than with nothing.

Without this, `propose` re-suggests splitting `store.ts` every quarter and costs the
same hour of appraisal each time.

## 6. What comes back, and what is written down

The document has three sections, in this order:

1. **Appraise these** — proposals that survived their critic and are not already
   decided. `settledBy` first, then the idea, then the cost.
2. **Already decided** — with the decision and its date. Usually the longest section
   after the first run, and that is the tool working.
3. **Unappraisable** — no falsifying measurement offered. Kept, ranked last, marked.

**Whatever is rejected is written back to the knowledge base** as *considered X,
rejected because Y*, with `knowledge_teach`'s provenance. That is what makes the second
run cheaper than the first, and it is the half of this idea worth most: a codebase that
records why it did **not** do things stops re-arguing them.

## 7. Bounds

**It must never starve the gate.** Measured: the largest t2 review sent 203,904 cached
tokens and hit the 30-minute ceiling, and a whole-repo question has no diff to anchor
exploration — so a proposer run costs at least that. A `--budget 8` run is eight deep
sessions, which is enough to empty a rolling subscription window; D-7's argument about
T1 applies unchanged, since exhausting the window stalls **every review in the system**.

So:

- `propose` **refuses to start while any review is queued or running**, and says which.
  Reviews are the product; this is inspiration.
- `--budget` is required and counted in sessions, so the spend is chosen rather than
  discovered.
- It runs through the same model gate as reviews (`LORE_MODEL_CONCURRENCY`), so it
  cannot burst past the provider ceiling that killed four reviews in 2.5 minutes.
- Usage is recorded per session like any other model call, so what it cost is
  answerable afterwards rather than estimated.

## 8. What is deliberately absent

- **No findings, no fingerprints, no verdicts.** Nothing here can settle, reopen, or
  appear in a review.
- **No MCP surface.** The CLI is the development surface (D-16); this is run by the
  maintainer and read by a person, so it needs no tool description and no client
  contract.
- **No automatic implementation.** The tool proposes; a person decides; the change goes
  through the normal review ladder like any other. A refactor suggested by a model and
  merged without review would be the exact inversion of this project.

## 9. The honest risk

**The failure mode of this tool is its reader.** Three frontier models writing
persuasively about improvements is a machine for producing plausible-but-wrong
refactors, and the maintainer of this repository nearly committed to one with no model
helping at all. Everything above — the kill criteria, the cross-vendor critic, the
knowledge screen, `settledBy` printed first — exists to protect against enthusiasm
rather than against the models.

Whether these models produce *good* architectural ideas is **entirely unmeasured**.
This is the output most likely to be plausible and useless, which makes it the best
first customer for a measurement harness, not a reason to skip one.
