# TODO — `lore`

Phases, rationale and done-criteria live in **`PLAN.md`**. This is the working
checklist. One task at a time; finished work moves to `MEMO.md` with what was
learned, then gets struck here.

**Rewritten 2026-08-04**, because it had drifted badly: it still listed the SQLite
store, the git boundary and the whole MCP service as unstarted while all of them
were deployed in Docker and had carried two reviews to `passed`. A stale checklist
is the same defect this tool exists to catch — a claim nobody checks — and it was
sitting in our own repo while we fixed five of them in the code.

A phase is ticked when its code is **running and observed**, never when it is
merely written. Where a phase shipped with a part that has never been exercised,
that part is pulled out into its own open item rather than hidden inside a tick.

---

## Now — nothing here is about writing more features

- [ ] **Turn on backups, and perform a restore.** `make backup-on`, then
      `make backup-check`, then actually restore into a scratch directory and open
      the database. Litestream has no credentials today and the container is not
      running, so the knowledge base — **440 rows**, the thing the product IS — has
      exactly one copy, on a laptop. `SPEC.md` §3 says a knowledge base without
      backups is one you will lose, and `make backup-check`'s own text says untested
      backups are beliefs. This is the only open item whose downside is losing
      everything the tool has learned.

- [ ] **Run T0's test sandbox once, adversarially.** `tests` is already a declared
      T0 engine for `code-arch`, but `LORE_RUN_TESTS=0` in the deployment, so it has
      never executed. The whole D-24 design — ephemeral container per review, no
      secrets, no network, read-only root, hard timeout — has never run, and
      `spec/review-ladder.md` §1.1.1 is explicit that **an untested sandbox is not a
      sandbox**. Done when a deliberately hostile test file has tried to read a
      deploy key and the database from inside it and failed at both, with the
      transcript in `MEMO.md`.

- [ ] **Set the exploration cap from data** (D-50). The distribution now exists —
      54 completed tier runs with a step count, 2026-08-04:

      | tier | n  | steps min/med/max | seconds min/med/max |
      |------|----|-------------------|---------------------|
      | t1   | 31 | 5 / 19 / 59       | 135 / 320 / 590     |
      | t2   | 16 | 31 / 46 / 68      | 464 / 933 / 1191    |
      | t3   | 7  | 6 / 9 / 16        | 99 / 133 / 1691     |

      The shape is the finding: **t3 explores least and t2 most**, so one global cap
      is wrong for both and the cap has to be per tier. Note that the 80 I nearly
      shipped by guesswork would have held here — by luck, not by reasoning, which is
      the whole argument for measuring first.

- [ ] **Announce a diff too big for the tier instead of timing out on it.** Measured
      2026-08-04: glm-5.2 at medium handled 21–30 KB in 685–1193s and blew the full
      1800s budget at 69 KB. Costing a 30-minute budget to learn nothing is honest
      (INV-1) but far too late and far too expensive. INV-7 already announces
      truncation; there is no equivalent for "this is beyond what this tier has ever
      completed". The latency column above is the input; the warning belongs at
      `review_start` and `review_submit`, before the money is spent.

## Later

- [ ] **Exercise the three paths that have never happened.** `passed_partial`
      (D-48/49), `needs_human` (D-39 — zero conflicts recorded, ever), and a real
      quota exhaustion. All three have code and tests; none has occurred in
      production, and a path whose first real execution is during an incident is a
      path nobody has reviewed.

- [ ] **The spend ceiling guards nothing today.** Zero of 54 usage rows have
      `cost_usd > 0`, because both providers are subscriptions, and `ops/spend.ts`
      sums exactly that column. Not wrong — inert. It needs either a metered provider
      to be meaningful, or an honest statement that it cannot fire under a
      subscription, so nobody reads its silence as headroom.

- [ ] **One bad finding still discards a whole reply.** `extractFindings` returns a
      failure if any finding in the batch fails the schema. That is the right default
      — keeping the valid ones silently drops a defect the model actually found — and
      it has been the wrong outcome three times (`cwe: ""`, `cwe: null`, a
      325-character claim). Now that the retry names the exact rule broken, the
      question is whether a second retry, or partial acceptance with a loud record of
      what was dropped, is better. Wants a decision, not a patch.

- [ ] **Prove Phase 3's actual done-criterion.** A fresh Claude Code session, given
      no instructions beyond the MCP tool descriptions, drives a review to `passed`.
      Every review so far has been driven by hand with shell scripts, so what is
      proven is the service, not the documentation — and `spec/agent-docs.md` §1 says
      the docs *are* the interface.

- [ ] **The Orange Pi.** The deployment is arm64 and running, but on a MacBook via
      Docker Desktop. `spec/deployment.md` and `PLAN.md` §4.1 target the device, and
      D-37's T0 throughput budget was measured for it, not for this.

---

## Done

Ticked because it is **running and observed**, not because it was written.

- [x] **P0 — the pure core.** Findings + Zod schema with optional `cwe` (D-44) and
      the fingerprint `sha256(normalized_claim ‖ file ‖ enclosing_symbol)`; the
      SQLite store behind a repository interface (8 tables, WAL, migrations that can
      only add columns); verdict staleness via `scope`, watched expiring a real
      justification in production; the `lore-ok` parser, now **three** forms — `//`,
      ` * ` in a block, and `<!-- -->` (D-57); the escalation state machine,
      property-tested to terminate from any starting point; and review types as
      named pipelines (D-43).
- [x] **P1 — one real review.** Git boundary (bare clone, worktree per review,
      fresh `into` fetch), T0's deterministic engines, the agentic opencode reviewer
      with one retry then loud failure and caching from the first call (D-29 —
      observed at 100k+ cached tokens per call), tier prompts by position (D-31),
      doc ingestion (433 ingested rules), and the CLI with exit codes as its API.
      **Except the test sandbox, which is open above.**
- [x] **Phase 2 — knowledge.** 440 rows, 7 of them derived. Its done-criterion is
      met and was watched happening: D-51 carried an accepted justification into a
      later review of the same repo — `lore-ok d6d9cd72 (carried)` — with a test
      covering the cross-review path.
- [x] **Phase 3 — the service.** MCP surface with `type` from day one, resources,
      the review prompt, provisioning, scheduler, two-stage, inbox, attestation.
      Two reviews reached `passed` and both attested. **Except the fresh-session
      criterion, which is open above.**
- [x] **Phase 4 — deployment and operations.** arm64 images, docker compose,
      heartbeat deadman, spend ceiling, and the coloured operator view (`make
      status`) which is what caught several of this session's defects.
      **Except backups and the device, both open above.**
- [x] **Phase 5 — review types and security.** `security/{sbom,osv,vex}` wired as
      T0 engines, reachability guidance in the tier prompts, real CycloneDX VEX.
- [x] **The four measurement questions P1.7 asked** are answered for the deployed
      ladder, in `MEMO.md`: latency and turns per tier (table above), parse-failure
      modes and their causes, the diff-size ceiling, and cost — `$0`, because both
      tiers are subscriptions (D-54). What is *not* answered is the original form of
      the question: candidate models compared over branches with known defects from
      `~/c`. That comparison was overtaken by the subscriptions being bought.
- [x] **Toolchain, landscape, MCP and security research.** `research/*`, each dated.
- [x] **Plan.** `PLAN.md`.
