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
