# `lore propose` — the idea generator

**Not a review.** It gates nothing, produces no findings, and cannot reach an
attestation. It asks the dearest models what they would change about this codebase,
spends real quota doing it, and hands a person suggestions to appraise. SPEC: D-75.

Run it rarely — when there is appetite for a large change and time to evaluate one,
not on a merge and not on a schedule.

---

## 1. The shape

```
lore propose --repo <name> --budget 8
             [--folder src/store] [--commit <ref>] [--mode code-arch]
             [--lens seams,failure,data,greenfield] [--json]
```

| flag | meaning | default |
|---|---|---|
| `--repo` | which registered repository to think about | required |
| `--budget N` | how many **model sessions** to spend, proposers and critics together. Required: the cost is the point, so it is stated rather than discovered | required |
| `--folder` | the directory the proposals must be ABOUT | the repository root |
| `--commit` | what to think about, cut from lore's mirror | the head of `master` |
| `--mode` | which question to ask, from the review-type vocabulary | `code-arch` |
| `--lens a,b,c` | which vantages to run | all four |
| `--json` | the document as data, for a script | off |

Writes `proposals/YYYY-MM-DD-<sha>-<folder>.md` and prints the path. The SHA and the
folder are both in the name because a per-folder sweep shares one commit and one date —
without the folder, eleven runs write eleven times to one path and ten documents are
lost after being paid for. Exit `0` when it produced a
document, `70` when it did not — *did not run* is never *found nothing*, here as
everywhere.

### 1.1 The folder is the subject, not the boundary

**Read outward, propose inward.** A proposer is told to read whatever it needs — callers
of this code, the modules it depends on, the specs that govern it, anywhere the code
links to — because a proposal about a folder made without reading its callers is a
proposal about a folder nobody uses. But the *subject* is the folder: an idea whose
change lands outside it is out of scope and is dropped with its reason, not silently.

This is the difference between "improve `src/store`" and "improve the codebase, starting
from `src/store`". The second is what a model does unprompted, and it is how a
folder-scoped run becomes another whole-repo run that costs the same and answers a
question nobody asked.

`--folder` defaulting to the root makes the whole-repo run the explicit case rather than
the accidental one.

### 1.2 A commit, from the mirror

`--commit` is cut from lore's own mirror into a throwaway worktree, exactly as a review
is (D-65) — not read from whatever is in the operator's working directory. Two reasons,
and the second is the one that matters: it works for any registered repository rather
than only the one you happen to be standing in, and a proposal that names a file and a
line means something only if the tree it named is reconstructable afterwards. The
document records the resolved SHA, never the ref.

The default is the head of `master` because that is the state the next change starts
from. A refactor proposed against a feature branch is a refactor of work in progress.

A stale mirror **refuses** the run and says so, on the same rule as a review: thinking
hard about a tree from three hours ago is worse than not thinking, because the output
looks equally confident.

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
        proposals/<date>-<sha>-<folder>.md
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
| `greenfield` | *"you have six months and no compatibility constraint. What would you build instead — doing the same job?"* |

`greenfield` is the one most likely to waste the budget and the only one that can
produce a genuinely structural idea. It stays, with the functionality clause attached:
the constraint it drops is compatibility, not purpose.

`--mode` selects the question every lens is asked in service of, from the same
vocabulary as reviews. `code-arch` asks what would make this code better to own;
`security` asks the lenses to attack exposure and blast radius instead. The lenses do
not change — the thing they are aimed at does.

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
  "settledBy": "ONE measurement that would decide it",
  "preserves": "what this must keep doing identically, and how you would know it still does"
}
```

**`preserves` is why this is a refactor tool and not a redesign tool.** The instruction
is to improve the code while KEEPING WHAT IT DOES. A model asked to improve something
will, given room, improve what it is for — and an idea that quietly changes behaviour is
not a better version of this code, it is different code wearing its name.

So each proposal states what must remain true and how a person would check. "The public
exports of this folder are unchanged"; "every existing test passes without being
edited"; "the same wire bytes for the same input". A proposal that cannot name what it
preserves is treated exactly like one that cannot name `settledBy` — kept, ranked last,
marked `unappraisable`.

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

- A proposal whose change lands **outside `--folder`** is dropped, with its reason
  recorded — the subject was the folder (§1.1), and an idea about somewhere else is an
  answer to a question nobody asked. Dropped rather than ranked last, because unlike the
  cases below it is not an idea the reader might still want here.
- A proposal restating something the repository has **decided against** is annotated
  with that decision and its date, and ranked last.
- A proposal contradicting a **taught** rule is annotated with it. Not dropped —
  taught rules can be wrong, and a model arguing against one is worth reading — but
  the reader is told they are arguing with a decision rather than with nothing.

Without this, `propose` re-suggests splitting `store.ts` every quarter and costs the
same hour of appraisal each time.

## 6. What comes back, and what is written down

The document opens with **what was thought about**: the repository, the resolved commit
SHA, the folder, the mode, the lenses run, and the budget spent against the budget
allowed. A proposal document that does not say which tree it read is unappraisable in
the same way a finding without a file is — and this one is read weeks later, by which
time nobody remembers.

Then three sections, in this order:

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
- Its calls are counted like a review's, and — since D-98 — **not throttled**: nothing
  stops it bursting past the provider ceiling that killed four reviews in 2.5 minutes.
  `--budget` is what bounds it, and is required for that reason.
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
  Confirmed 2026-08-07 when the tool was built: *"output is an idea, that will be
  implemented by the caller"*. The temptation is to have it write the patch, and the
  argument against is §9 — three frontier models writing persuasively about improvements
  is a machine for plausible-but-wrong refactors, and a patch is far more persuasive
  than a paragraph.
- **No behaviour changes.** *"But keep the overall functionality."* Every proposal
  carries `preserves` (§4); an idea that changes what the code does is a different
  product decision, and this tool has no standing to make one.

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
