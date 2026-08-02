# research/

External facts this project depends on, written down so they can be re-checked
instead of re-remembered.

## Rules

- **Every file carries the date it was verified**, and *how* (fetched a doc page,
  ran a command, read source). A fact without a provenance line is a rumour.
- **Uncertainty is written as uncertainty.** If a doc contradicts itself, both
  readings go in, labelled. Guessing and moving on is how a wrong fact becomes
  load-bearing six weeks later.
- Facts older than a few weeks are re-checked before anything expensive is built
  on them — model names, pricing, plan limits and SDK shapes all drift.
- `SPEC.md` cites these files; these files never restate design decisions. Facts
  here, decisions there.

## Index

| file | subject | verified |
|------|---------|----------|
| `prior-art-c-review.md` | `~/c/review` — the incidents behind INV-1…9 | 2026-08-03 |
| `opencode-integration.md` | opencode providers, subscriptions, server API, SDK | 2026-08-03 |
| `ai-code-review-landscape.md` | CodeRabbit/Greptile architecture, model benchmarks, chosen lineup | 2026-08-03 |
| `mcp-service-design.md` | MCP auth, transports, async constraints on the service | 2026-08-03 |
| `implementation-approach.md` | MCP SDK v2, handle security, test sandboxing, build order | 2026-08-03 |
| `security-review.md` | CWE vs CVE vs OSV, Semgrep as a T0 engine, SBOM and VEX | 2026-08-03 |
