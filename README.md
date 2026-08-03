# lore

An MCP service that reviews a branch before it merges — and remembers the codebase
between sessions.

Every AI coding session starts amnesiac. It rediscovers the same conventions,
re-raises the same settled questions, and repeats the same mistakes. `lore` is the
memory: a shared, per-repo body of knowledge, built by reviewing the code and
readable by every session and every teammate.

Reviews are the mechanism. The memory is the product.

## How a review works

Deterministic tooling runs first — a model should never be paid to decide what a
typechecker decides for free. Then the cheapest model, then dearer ones, each tier
seeing only code the previous one passed. Every finding is either fixed or
justified, and a justification is a comment:

```ts
// lore-ok[a1b2c3d4]: bounded by the caller's schema check at api/route.ts:31,
// so a negative amount cannot reach here.
```

Writing that is **proposing a piece of lore**. The reviewer ratifies it — and the
reason becomes a fact the next session already knows — or rejects it, and the
finding returns at higher severity, because a wrong justification is worse than a
bug. The author never closes its own findings.

When every tier agrees there is nothing left, you get one signed line recording what
was checked. It never claims the code is correct.

**Reviewers are always models that did not write the code.** Independence is a hard
constraint, not a cost preference — it rules out the strongest available model on
purpose, because a model reviewing its own output confirms the design it already had
in mind.

## Status

**Implemented, undeployed.** ~5,500 lines across 40 modules, 174 tests. The review
loop, the knowledge layer, the MCP service, operations and the security review type
all have code, and the boundaries around models and containers are exercised against
real HTTP servers and real git repositories.

What no test has proven: an actual model call, a container launch, and arm64. Those
need the device, and `PLAN.md` §4.1 has the plan for them.

## Documents

| file | what it holds |
|------|---------------|
| `SPEC.md` | purpose, workflow, architecture, and every decision `D-1`…`D-45` |
| `PLAN.md` | build order, phases, what each one retires |
| `spec/knowledge.md` | the knowledge layer — the product |
| `spec/review-ladder.md` | tiers, findings, verdicts, invariants |
| `spec/mcp-api.md` | MCP surface, provisioning, review state machine |
| `spec/agent-docs.md` | tool descriptions and prompts, written for an agent |
| `spec/deployment.md` | host constraints and the throughput budget |
| `spec/operations.md` | alerting, the heartbeat deadman, spend control |
| `PROG.md` | how code is written here |
| `MEMO.md` | development memory, newest first — including the mistakes |
| `TODO.md` | the working checklist |
| `research/` | verified external facts, each carrying the date it was checked |

## The one rule

**A review that did not run is not a review that found nothing.**

Every ambiguity in this codebase resolves toward saying so loudly. Four reviews
failing silently in a single day is why this project has the shape it has.

## License

MIT.
