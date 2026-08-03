<div align="center">

# lore

**An independent code reviewer that remembers your codebase between sessions.**

[![ci](https://github.com/Vany/lore/actions/workflows/ci.yml/badge.svg)](https://github.com/Vany/lore/actions/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-180%20passing-brightgreen)](src)
[![node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=node.js&logoColor=white)](package.json)
[![typescript](https://img.shields.io/badge/typescript-strict%2C%20no%20build%20step-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![mcp](https://img.shields.io/badge/MCP-2026--07--28-000000)](spec/mcp-api.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

Every AI coding session starts amnesiac. It rediscovers the same conventions,
re-raises the same settled questions, and repeats the same mistakes you corrected
last week.

`lore` is the memory. It reviews a branch before it merges — and everything it
learns doing so becomes a fact the next session already knows.

> **Reviews are the mechanism. The memory is the product.**

---

## The idea that makes it work

When a reviewer raises something you believe is wrong, you don't argue in a
comment thread. You write the reason **in the code**:

```ts
// lore-ok[a1b2c3d4]: bounded by the caller's schema check at api/route.ts:31,
// so a negative amount cannot reach here.
export function capture(amount: number) { … }
```

That is *proposing a piece of lore*. The reviewer ratifies it — and your reason
becomes something the codebase knows about itself — or rejects it, and the finding
returns at **higher severity**, because a wrong justification is worse than a bug.

**The author never closes its own finding.** That single rule is what keeps the
loop honest: it terminates when the code is correct, not when the author gets
persuasive.

And a justification **expires**. It was a claim about specific code; when that code
changes, the reason may no longer hold, so the finding comes back. Without that,
this design rots into rubber-stamping within months.

---

## The ladder

Deterministic tooling first — *a model should never be paid to decide what a
typechecker decides for free*. Then progressively dearer models, each seeing only
code the previous tier already passed.

| tier | engine | vendor | $/M in | $/M out |
|:--|:--|:--|--:|--:|
| **T0** | the repo's own `tsc` · `eslint` · `ast-grep` · `semgrep` · tests | — | free | free |
| **T1** | GLM-5.2 | Z.ai | 0.28 | 0.89 |
| **T2** | Kimi K3 | Moonshot | 3.00 | 15.00 |
| **T3** | GPT-5.6 Sol Pro | OpenAI | 5.00 | 30.00 |

Three tiers, **three vendors** — two tiers from one model family share blind spots
and are not two independent opinions.

**Every reviewer is a model that did not write the code.** That rules out the
strongest model on the board on purpose: a model reviewing its own output confirms
the design it already had in mind. It is enforced by *absence* — no Anthropic
credential is ever deployed to the reviewer.

```
  ┌──────────────────────────────────────────────┐
  ▼                                              │
 T0 → T1 ──new findings?──yes──► fix, or lore-ok ┘   (reset to the cheapest tier —
  │                                                   a fix is unreviewed code)
  no
  ▼
 T2 → T3 ──all agree──► passed ──► one signed line saying what was checked
```

---

## Quick start

```bash
# review a branch locally — no service, no containers
npm ci
node ./src/index.ts review \
  --branch feat/holds --into main \
  --ticket "Release the hold when a capture declines"
```

Exit codes are the API, because the caller is usually a program:

| code | meaning |
|:--|:--|
| `0` | **passed** — every tier agrees. The only success. |
| `1` | findings — fix or justify, then run again |
| `70` | **did not run** — never confuse with "found nothing" |
| `75` | quota exhausted — also not a pass |

### As a service

```bash
cd deploy
cp .env.example .env          # one OpenRouter key; no subscriptions needed
make sync-opencode            # stage local config, minus the Anthropic credential
make up
make new NAME=you GIT=git@github.com:you/repo.git
```

Then point any MCP client at it. `lore` ships its own documentation — tool
descriptions, `lore://docs/*` resources, and a `/lore:review` prompt that drives
the whole loop — because **the client is an agent, so the docs are the interface**.

---

## Architecture

```
 MCP client ──► lore  ──► opencode ──► GLM-5.2 · Kimi K3 · GPT-5.6 Sol
                 │                     (three vendors, none of them the author)
                 ├── scheduler        per-provider concurrency, spend ceiling
                 ├── repo cache       bare clone + a worktree per review
                 ├── T0 sandbox       tests in a container holding NO secrets
                 └── SQLite + Litestream ──► off-device backup
```

Tests run in a throwaway copy, mounted read-only from the reviewed tree — a suite
that writes snapshots or coverage would otherwise mutate the code under review and
appear in the next round as findings about work nobody did.

---

## The rules it is built on

> **A review that did not run is not a review that found nothing.**

Every ambiguity resolves toward saying so loudly. Four reviews failing silently in
a single day is why this project has the shape it has.

- `failed`, `expired` and `fast_clean` are distinct states. None of them is a pass.
- An unparseable reply is a *failed* review — one retry, then loud failure.
- Quota exhaustion never falls through to another tier.
- The attestation says **what was checked**, never that the code is correct.
- A knowledge conflict stops the review and asks a person — and that block has an
  exit, because a stop with no way to clear it is a trap, not a safeguard.

---

## Status

**Implemented, undeployed.** ~5,900 lines, 42 modules, 180 tests. Every phase in
[`PLAN.md`](PLAN.md) has code, and the boundaries around models, containers and
git are exercised against real HTTP servers and real repositories.

What no test has proven: an actual model call, a container launch, and arm64.
Those need the device.

> Fourteen bugs have been found so far. Every one lived at a seam — an SDK that
> reports failure by return value, a container path the daemon resolves elsewhere,
> a guard that was written but never called. The ladder logic, the fingerprinting
> and the VEX mapping all worked first time. [`MEMO.md`](MEMO.md) has every one of
> them, including the retractions.

## Documents

| file | what it holds |
|:--|:--|
| [`SPEC.md`](SPEC.md) | purpose, workflow, and every decision `D-1`…`D-47` |
| [`PLAN.md`](PLAN.md) | build order, and what each phase de-risked |
| [`spec/knowledge.md`](spec/knowledge.md) | the knowledge layer — the product |
| [`spec/review-ladder.md`](spec/review-ladder.md) | tiers, findings, verdicts, invariants |
| [`spec/mcp-api.md`](spec/mcp-api.md) | MCP surface, provisioning, state machine |
| [`spec/agent-docs.md`](spec/agent-docs.md) | docs written for an agent, not a human |
| [`spec/deployment.md`](spec/deployment.md) | host constraints, throughput budget |
| [`spec/operations.md`](spec/operations.md) | alerting, the heartbeat deadman, spend |
| [`MEMO.md`](MEMO.md) | development diary — the mistakes included |
| [`research/`](research) | verified external facts, each dated |

## License

MIT © Vany Serezhkin
