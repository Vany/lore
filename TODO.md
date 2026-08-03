# TODO — `lore`

Phases, rationale and done-criteria live in **`PLAN.md`**. This is the working
checklist. One task at a time; finished work moves to `MEMO.md` with what was
learned, then gets struck here.

---

## Now — Phase 2: knowledge (the product)

- [x] **P0.1 — Finding record + Zod schema**, with optional `cwe` (D-44), and the
      fingerprint `sha256(normalized_claim ‖ file ‖ enclosing_symbol)`. Everything
      else in Phase 0 hangs off this shape, so it is worth getting wrong cheaply
      first.
- [ ] **P0.2 — SQLite store** behind a repository interface: `repo`, `review`,
      `tier_run`, `finding`, `verdict`, `knowledge`, `usage`, `job`.
- [ ] **P0.3 — Verdict staleness** via `scope` (blob sha + hunk hash).
- [ ] **P0.4 — `lore-ok` parser**, `//` and `<!-- -->` forms.
- [ ] **P0.5 — Escalation state machine**, property-tested to terminate under every
      combination of the four bounds.
- [ ] **P0.6 — Review pipeline abstraction.** A review type is a named pipeline of
      stages (D-43). Nearly free now; painful to retrofit.

**Phase 0 done when:** tests green, no network anywhere in this layer.

## Next — Phase 1: one real review, on a laptop

- [ ] **P1.1 — Git boundary.** Bare clone, worktree per review, fresh `into` fetch
      (INV-2), working-tree diff (INV-3), untracked (INV-4), truncation (INV-7),
      submodule expansion (D-36).
- [ ] **P1.2 — T0 deterministic layer.** The *target's* own `tsc`, ESLint,
      `ast-grep`, `semgrep`; say plainly when a target has none. Then its tests in a
      sandboxed container (D-24) — verified by trying to read a deploy key from
      inside it. An untested sandbox is not a sandbox.
- [ ] **P1.3 — opencode boundary.** Read-only agent check (INV-8), session pooling
      (INV-5/6), agentic reviewer with worktree tools, structured output with one
      retry then loud failure, **caching from the first call** (D-29), usage per
      call.
- [ ] **P1.4 — Tier prompts by position** (D-31).
- [ ] **P1.5 — Doc ingestion, read-only.** The reviewer gets the repo's own rules.
      Deriving and teaching wait for Phase 2.
- [ ] **P1.6 — CLI**, exit codes as the API.
- [ ] **P1.7 — Measurement.** Candidate models over branches with known defects from
      `~/c` history. Record defects found, false positives, latency, **tokens**, and
      parse-failure rate per vendor. Replaces every estimate in
      `research/ai-code-review-landscape.md` §3.1 and settles D-7 and D-17.

**Phase 1 done when:** it converges to `passed` repeatedly on real branches, the
findings are worth the money, and the numbers are measured rather than guessed.

## Then

- [ ] **Phase 2 — Knowledge.** Derive, query, teach, conflicts + `needs_human`,
      enrichment, bootstrap. Done when a second review demonstrably uses what the
      first learned — written as a test, not a vibe.
- [ ] **Phase 3 — Service.** MCP surface with `type` present from day one, resources,
      the `review` prompt, provisioning, scheduler, two-stage, inbox, attestation.
      Done when a fresh Claude Code session with no instructions drives a review to
      `passed`.
- [ ] **Phase 4 — Deployment and operations.** `docker-compose.yml` in a folder in
      `$HOME`, arm64 images, T0 tuned for the host (D-37), Litestream off-device with
      a **restore actually performed**, heartbeat deadman, spend ceiling, operator
      view. Includes the **arm64 test plan** (`PLAN.md` §4.1), run when the device is
      in hand.
- [x] **Phase 5 — Review types and security.** Done. `security/{sbom,osv,vex}`,
      wired as T0 engines, with reachability guidance in the tier prompts and real
      CycloneDX VEX output.

---

## Done

- [x] **Toolchain verified.** 2026-08-03. node 26.5.1, bun 1.3.14, tsc 7.0.2, git
      2.55.0, jq, gh, `ast-grep`; `@opencode-ai/sdk` 1.18.11 clean; `node:sqlite`
      works. No build step.
- [x] **Landscape research.** `research/ai-code-review-landscape.md` — CodeRabbit and
      Greptile architecture, model pricing, the lineup, the GLM retraction.
- [x] **MCP constraints.** `research/mcp-service-design.md`,
      `research/implementation-approach.md` — auth in headers, poll-not-push, SDK v2,
      state-handle hijacking, test sandboxing.
- [x] **Security landscape.** `research/security-review.md` — CWE vs CVE vs OSV,
      Semgrep as a T0 engine, SBOM/VEX.
- [x] **Plan.** `PLAN.md`.
