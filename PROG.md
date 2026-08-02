# PROG.md — programming rules for `lore`

Extends the global rules in `~/.claude/CLAUDE.md`. Where this file is silent, the
global rules apply.

---

## Language and toolchain

- **TypeScript**, strict. `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. No implicit `any`; no `as` to silence the compiler
  — if a cast is genuinely needed it carries a `// why:` comment.
- Model transport is **`@opencode-ai/sdk`**, generated from opencode's OpenAPI
  spec. Hand-rolled HTTP against opencode is a last resort and must say why.
- The language server must be running. If it is missing I say so and stop, rather
  than writing TypeScript blind.

## Failure

This tool's entire value is that its verdict can be trusted. The failure rules are
therefore stricter than normal.

- **Fail loud, exit non-zero.** No path may log a problem and carry on.
- **Never let an error read as a clean result.** A crashed reviewer, an unparseable
  response, an exhausted quota and a timeout are all *"did not run"* — never *"found
  nothing"*. Distinct exit codes, distinct messages.
- **No silent fallback.** Falling back to another model, provider, or billing mode
  is a decision with consequences: it is announced, or it does not happen.
- Scaffolded and unimplemented paths `throw`. They never return a plausible
  default.

## Structure

- One file, one piece of functionality, documented at the top with *why it exists*.
- **Pure core, effectful edges.** Diff parsing, fingerprinting, dedup, ledger
  reconciliation and the escalation state machine are pure functions over plain
  data — they are the parts that must be testable without a model, a network, or a
  repo.
- I/O (git, opencode, filesystem) lives at the boundary, behind narrow interfaces.
- Configuration is data. Tiers, models and budgets are config, never `if` chains.

## Comments

Per the global rules: comments carry *why*, code carries *what*.

This repo has a specific obligation. Every non-obvious defensive line exists
because something broke — `~/c/review` is the proof of how much that knowledge is
worth. When I write a guard I write what it guards against, in enough detail to
reconstruct the incident. A guard without a reason gets deleted by the next reader.

## Tests

- The escalation state machine, fingerprinting, ledger staleness and dedup are
  tested without touching a model. They are the logic; models are merely the input.
- Fakes must not be kinder than production. A fake reviewer that always returns
  well-formed JSON tests nothing — the interesting inputs are malformed, empty,
  truncated, and busy.
- A test that would pass without its fix is worse than no test.
- `toStrictEqual` when asserting absence; `toEqual` ignores `undefined`-valued
  properties and will happily agree with a bug.

## Dependencies

- Search for an existing library before writing anything large and well-known
  (diff parsing, JSON-schema validation, CLI parsing).
- Few, boring, maintained. Each dependency is justified in `MEMO.md` when added.

## Git

Per `/gitmode`, default **history**: commit on the current branch to record
decisions, no feature branches. Commit messages explain the *why*, since that is
the part not recoverable from the diff.
