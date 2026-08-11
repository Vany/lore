# Where t2's tokens go, and what would actually reduce them

**Measured 2026-08-11** against this deployment's own `usage` and `tier_run` tables — 128
completed t2 rounds, 155 t2 tier runs, 205 t2 findings. Nothing here is estimated from
pricing pages; it is what we were charged.

Re-check anything older than a few weeks: the ladder, the models and the traffic all move.

## The headline

**Caching is not the problem. Exploration is.**

t2's cache hit rate is already **91.1%** — 124.4M cached reads against 12.2M fresh input
across 128 rounds. There is no large win left there. What varies by a factor of seven is
how long the agent explores, and that is uncorrelated with how much code it was given.

| | rounds | findings/round | high found | $/round | $/high |
|---|---:|---:|---:|---:|---:|
| **under 25 steps** | 50 | **2.12** | **5** | **$0.19** | **$1.85** |
| 25–39 steps | 45 | 1.53 | 4 | $0.81 | $9.13 |
| 40+ steps | 33 | 0.97 | 1 | $1.31 | $43.14 |

**Longer rounds find less, in absolute terms.** Thirty-three rounds of 40+ steps produced
ONE high-severity finding between them, at $43.14. Fifty short rounds produced five, at
$1.85 each. Cost per finding differs by 15×; cost per *high* finding by 23×.

## Why length is not about diff size

| diff | rounds | avg steps | fresh | cached | $/round |
|---|---:|---:|---:|---:|---:|
| under 20 KB | 6 | 25.0 | 115,037 | 1,071,275 | $0.91 |
| 20–80 KB | 24 | 35.6 | 170,964 | 1,718,620 | **$1.33** |
| 80–300 KB | 46 | 30.2 | 79,189 | 658,301 | $0.50 |
| 300 KB+ | 35 | 26.2 | 105,065 | 1,270,059 | $0.80 |

A **7 KB diff cost $0.95**. An **803 KB diff cost less**, in eight steps. The change under
review does not predict the bill; the agent's appetite does. The most expensive band is
20–80 KB — big enough to look worth investigating, small enough not to fill the budget.

The mechanism is D-50's: an agent re-sends its accumulated context every turn, so cached
reads grow with the SQUARE of exploration. 972K cached tokens per round is roughly ten
re-reads of a context that keeps growing.

## What to do, in order of evidence

### 1. Cap exploration. ~$60 of $89 (67%).

D-50 is still `[OPEN]` in SPEC for want of exactly this data. Capping t2 at ~25 steps, and
charging the capped rounds at the observed short-round rate, gives **$19.50 against
$79.68** for the 78 rounds that ran longer.

Two readings of the correlation, and **both argue for the cap**:

- long exploration is unproductive → capping saves money and loses nothing;
- the agent explores long *because* it is finding nothing → capping stops a fruitless
  search that was going to end empty anyway.

The only reading that argues against is "it would have found it on step 45", and 33 such
rounds yielding one high finding is the measurement of how often that happens.

**A cap must be reported, not silent.** A round that stopped early did not finish, and
`clean` would be INV-1 exactly inverted — it belongs in `checks_skipped` with the step
count, so a `passed` built on it is weighed accordingly.

### 2. Reorder the prompt for the cache prefix. Small, free, permanent.

Caching matches on an exact PREFIX, so the first varying token invalidates everything
after it. `reviewPrompt` currently puts `position(i)` — tier and round — about twelve lines
in, ahead of roughly sixty lines of invariant instruction: the bar, the type guidance, the
reporting rules. The worktree path, unique per review, follows immediately.

So the whole instruction block is re-sent fresh on every round of every review. Moving
every round-invariant line ahead of every variable one costs nothing and makes the
preamble a shared prefix across the whole fleet.

**Honest size: 1–2K tokens against 95K fresh per round, so about 2%.** Worth doing because
it is free and never needs revisiting; not worth confusing with the first item.

### 3. A cheaper twin for t2. Separate decision, already flagged.

`kimi-k2.6` reads cache at roughly a third of K3's rate. On this volume that is a large
number, and it is not measurable from here: nothing tells us whether K2.6 reviews as well.
It needs a trial, not an argument.

## What this does not say

The correlation is not proof of causation, and this note does not claim it is. What it
establishes is that **the expensive rounds are not the productive ones**, which is enough
to justify the cap and not enough to predict exactly what the cap will save.

The finding counts are matched on `(review_id, origin, round)` — exact — while steps come
from the nearest `usage` row by timestamp, which is a join lore does not currently make
directly. A `round` column on `usage` would remove that fuzziness and is cheap.

---

## The session is thrown away between rounds

**Measured 2026-08-11, prompted by Vany:** *"the diff is applied to the worktree and the
process is restarted — but the diff must be applied to the worktree and delivered to the
model when the model becomes free. So it is a discussion, maybe at the moment when the
model finds the next problem."*

He is right about the mechanism. `Reviewer.review()` calls `createSession()` on entry and
drops the session on exit, so **every round is a cold start**: a new session, the full
prompt rebuilt, and the model re-orienting itself in a worktree it examined minutes ago.

### How often that happens

Since the ladder became monotonic (2026-08-08), of **218 model rounds**:

| | runs of 2+ | repeat rounds | longest run |
|---|---:|---:|---:|
| t1 | 6 | 9 | 3 |
| t2 | 18 | **36** | 4 |
| t3 | 10 | 18 | 5 |

**63 rounds — 29% of all model rounds — were a tier re-orienting on a review it had
already read.** At t2's $0.69 a round, its 36 repeats are about $25 of the $97 t2 has ever
cost.

`settledBlock` in the prompt is the workaround for this and names the problem out loud: it
exists to re-tell a fresh session what the previous one already decided.

### Whether a conversation is actually cheaper is NOT settled

SPEC D-80 §6 marks this `[OPEN]` and asks for measurement rather than argument. The
measurement now available cuts both ways.

A cold round costs 31.6 steps against an average context of ~31K tokens — 972K cached
reads, 95K fresh. A continued session skips the re-orientation but **carries its context
forever**, and every turn re-sends all of it.

Break-even, from our own numbers: a continued round beats a cold one only if it needs
**fewer than about 6 turns** once the conversation's context reaches ~150K. That is
plausible for *"here is the fix, is it right?"* — and it gets worse every round, because
the context only grows. By the fifth round the budget is 2–3 turns, and eventually the
window itself is the limit.

So the shape is: **conversation wins early and loses late**, where cold rounds are flat.
Nothing here justifies replacing one with the other; it justifies a trial.

### The stronger argument is not cost

D-10 says the tier that raised a finding should judge the answer, and the ladder already
enforces it (D-6 revised). A conversation makes that literal — the same session, with the
reasoning that produced the finding still in context — instead of a new session
reconstructing its own past opinion from a prompt block. That is better review, and it is
the argument that does not depend on which way the token arithmetic falls.

### What would settle it

One tier, one repository, conversation mode behind a flag, measured against the cold
baseline recorded here: $/round, rounds-to-verdict, and findings per round. Everything
needed to compare is already in `usage` and `tier_run`.

Two things to decide before building, both from D-80 §6 and neither answerable from data:

- **When does the conversation end?** Context growth makes "never" wrong. A threshold, a
  round count, or falling back to cold when the window fills.
- **How does the next tier enter?** It cannot inherit another model's conversation, so an
  escalation is a cold start by construction — which is fine, and means this only ever
  helps *within* a tier's run.

---

## The design Vany specified, 2026-08-11

> *"The main idea is to stop restarting it and continue the session in opencode. And manage
> it, so each model will be started and initialised only once per review."*
> *"Let's compact if the session is 2/3 of context."*
> *"A tier enters from an empty prompt but on a fixed tree."*

**One session per (review, tier), initialised once, alive for the whole review.**

- t1 opens a session when it first runs and keeps it for every round it holds.
- Reaching t2 opens a NEW session, empty of t1's reasoning, on the tree as it now stands.
- Each session is **compacted at 2/3 of that tier's window**, never restarted.
- A cold start remains the fallback, so the floor is today's behaviour.

### Why compaction rather than restart, in Vany's correction

I proposed dropping the session and starting cold on the current tree, on the argument that
"the worktree is the memory". **That is wrong in the part that matters**: the worktree
remembers the CODE, not the REASONING — why the model looked where it looked, what it ruled
out, what it was suspicious of and decided to let go. `settledBlock` exists to reconstruct a
fraction of that for a fresh session, badly. Compaction keeps it, compressed.

### It is supported

`client.session.summarize({ id, body: { providerID, modelID } })`, and `CompactionPart`
carries `auto: boolean` — opencode already compacts on its own, so the 2/3 rule is choosing
a threshold deliberately rather than inheriting one.

### What it changes about the arithmetic

The objection recorded above — *conversation wins early and loses late* — was against an
UNBOUNDED conversation. A 2/3 ceiling removes it. What is left is the saving that matters:

| | turns per round | context | reads per round |
|---|---:|---:|---:|
| cold (today) | 31.6 | ~31K avg | ~972K |
| continued | ~6 (est.) | bounded by compaction | far less |

The saving is in TURNS, and turns are what the evidence above shows to be both the cost
driver and *inversely* related to findings. Compaction costs one model call against the
thirty turns of re-orientation it removes.

### Three things to get right, none of them blockers

- **Sessions must be released when a review ends.** They currently die with each round; kept
  alive they accumulate — 128 admitted reviews × 3 tiers is 384 live sessions if nothing
  closes them.
- **A lore restart loses the map.** `sessions` is in memory, so a requeued round finds no
  session and must fall back to a cold start rather than failing. That is today's path, so
  the fallback is already proven.
- **The one review-quality risk worth measuring:** a long-lived session might defend its
  earlier findings rather than re-read the code. Independence in this ladder is ACROSS
  tiers — D-1, D-49 — and D-10 explicitly wants the tier that raised a finding to judge the
  answer, so the design is consistent. But "fresh eyes each round" is a property being given
  up, and whether it mattered is measurable: findings per round, and how often a finding is
  withdrawn after a fix.

### Not built

It changes how much quota burns, so it is the operator's call. Everything needed to compare
against the cold baseline is already recorded in `usage` and `tier_run`.
