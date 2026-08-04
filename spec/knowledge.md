# The knowledge layer

**This is the product.** Reviews are how knowledge gets made; sharing it across
sessions is what it is for (D-14).

Every Claude session starts amnesiac. Without this, each one rediscovers the same
conventions, re-raises the same settled findings, and repeats the same mistakes.
The ladder catches defects; the knowledge layer stops them being written twice.

---

## 1. Scope

**Per repo. No cross-repo layer** (D-19). Sessions working on the same repo share
knowledge freely, both reading and writing (D-18).

## 2. Sources, and their precedence

| rank | source | how it arrives |
|---|---|---|
| 1 | **taught** | `knowledge_teach` — a human or session states a rule outright |
| 2 | **ingested** | parsed from the repo's own `CLAUDE.md`, `PROG.md`, `SPEC.md`, ADRs |
| 3 | **derived** | inferred from accepted `lore-ok` justifications and recurring findings |

Higher rank wins on conflict, and a conflict is **recorded, not silently
resolved** — two sources disagreeing about a rule is itself worth surfacing.

### 2.1 Ingested docs are a known hazard

A stale document becomes a confidently wrong rule, applied to every future review
and every future session. This is the sharpest risk in the whole design, and it was
accepted knowingly.

Mitigation is mandatory, not optional:

- Every ingested rule stores the **source file and its blob sha**.
- When the file changes, rules derived from it are **re-derived, not retained**.
- A rule never outlives the text that justified it.

## 3. What is stored

- **rules** — conventions and constraints. *"Amounts are integers in minor units,
  never JS numbers."*
- **code facts** — what a module does, its invariants, its seams.
- **mistakes** — recurring fingerprint clusters. The fourth occurrence of a defect
  is not four bugs; it is one missing rule, and that promotion should be automatic.
- **history** — what was raised, fixed, justified, and how often it recurred first.

Every item carries: source, provenance, verification date, confidence, and `scope`
(file blob sha + hunk hash) for invalidation.

## 4. Staleness

Same rule as verdicts: **when the code an item describes changes, the item is
invalidated.**

A knowledge base that only accumulates will eventually confidently describe code
that no longer exists — and unlike a stale comment, it is injected into every
future session automatically. Rot here is worse than in any other component,
because it propagates.

## 5. Use

**At review time** — findings are enriched: *"seen 4× on this branch; the rule
from 2026-07-11 says X."* A finding with history is far more actionable than the
same finding raised cold.

**At any time** — `knowledge_query` (D-18). A session asks what is known about a
path, a module or a pattern before writing code.

## 6. Concurrency

Parallel sessions on one repo write concurrently. Writes are append-only with
conflict detection; two sessions asserting contradictory rules produces a recorded
conflict, never a silent last-write-wins. A knowledge base that quietly loses
writes is worse than one that has none, because nobody knows what it forgot.

## 7. Conflicts are problems to be solved (D-39)

A contradiction between two rules is **not** resolved by the store. It becomes a
**finding**, of kind `knowledge-conflict`, raised in the next review that touches
the affected code.

**Newer leans correct, but only leans.** Code evolves, so a later rule is usually
the truer one — that is a prior, not a verdict. A recent rule written carelessly
must not silently overwrite an older one that was reasoned through.

### 7.1 Resolution

The reviewing agent must actually resolve it: read both rules, read their
provenance, read the code as it now stands, and decide — recording *why*. A resolved
conflict retires the losing rule with its reason preserved, so the decision is
reconstructable later.

### 7.2 Escalation to a human

**If the agent cannot resolve it, it must say so rather than pick.** The finding is
marked `needs_human` and the client is told plainly to ask a person.

While any `needs_human` finding is open:

- the review **cannot reach `passed`**, and
- it **cannot be attested**, and
- it **cannot be closed with `lore-ok`** — a justification is a claim about code, and
  this is a question about which of two rules is true. The agent that could not
  decide it must not be allowed to write its way past it.

This is the one place the system deliberately stops and asks for a person. Two
contradictory beliefs about the same code are the failure mode most likely to
poison every future session (§4), and guessing is what would poison it.

### 7.3 Stopping must have an exit

A block with no way to clear it is a trap, not a safeguard. So `knowledge_resolve`
settles a conflict — retiring the losing rule **with its reason**, never deleting it
— and `knowledge_escalate` records that a person is required. Both are visible to
the ladder, which recomputes `needsHuman` from currently-open conflicts on every
round rather than latching it forever.

