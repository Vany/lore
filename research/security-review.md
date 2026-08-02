# Security review: the published databases, and what they are each for

**Verified 2026-08-03** from osv.dev, cwe.mitre.org, docs.semgrep.dev and
cyclonedx.org. Written to answer: *"maybe someone published a database, like a set
of CVEs?"*

---

## 1. There is no published database of code-review findings

Nothing plays the role of "CVE, but for review quality". What exists is a layered
stack, and confusing the layers is the usual mistake:

| layer | what it enumerates | example | use for `lore` |
|---|---|---|---|
| **CVE** | a specific vulnerability in a specific released version | `CVE-2024-1234` in `lodash@4.17.20` | matched against dependencies, not code |
| **OSV** | CVEs made machine-queryable per package+version | osv.dev API | the security review's engine |
| **CWE** | the **taxonomy of weakness kinds** | `CWE-89` SQL injection | **the shared vocabulary for findings** |
| **OWASP Top 10** | web risk categories | A03 Injection | coarse; CWE is more precise |
| **Semgrep / CodeQL** | **executable rules** that detect weaknesses | `p/security-audit` | a T0 engine |

**CWE is the closest thing to what the question was reaching for.** It is
community-maintained, derived from analysing **31,770 CVE records** for the 2024 Top
25, and it enumerates *root causes in code* rather than incidents in products.

## 2. CWE as our finding vocabulary (D-44)

Findings get an optional `cwe` field.

Three things this buys, none of which need a model:

1. **Comparability across tiers.** T1 and T3 describing the same defect in different
   prose become the same finding when both carry `CWE-362`.
2. **Interoperability with scanners.** Semgrep rules carry CWE metadata natively, so
   deterministic T0 findings and model findings land in one namespace.
3. **Knowledge clustering that means something.** *"This repo has produced eleven
   CWE-89 findings"* is a far stronger signal than eleven differently-worded
   complaints — and it is exactly the "recurring mistake → missing rule" promotion
   the knowledge layer is built on (`spec/knowledge.md` §3).

It is optional because most review findings are not security weaknesses. Forcing a
CWE onto "this test would pass without its fix" would be taxonomy theatre.

## 3. Executable rule corpora belong in T0, not in a model

**Semgrep** publishes a registry of rules across **40+ languages**, written in YAML
with pattern/`pattern-either`/metavariable operators, carrying severity and
CWE/OWASP metadata, and emitting **JSON or SARIF**.

This is deterministic, free, and covers a large slice of what an LLM would otherwise
be paid to notice. Per D-8 it is a **T0 engine**, alongside `tsc`, ESLint and
`ast-grep`.

Distinction worth preserving: rules find *known shapes*. Models find the thing no
rule anticipated — a lifecycle claim no test exercises, a decline path that leaves a
hold active. Paying a model to re-detect `CWE-89` is paying for the wrong thing.

**Not installed locally**: `semgrep`, `osv-scanner`, `syft`, `grype`, `trivy`. All
need adding to the image, and all have arm64 builds (to be confirmed on the device).

## 4. The security review type

### 4.1 Pipeline

```
  lockfile ──► SBOM (CycloneDX)  ──┐
                                   ├──► OSV query ──► candidate vulns
  lockfile ──────────────────────┘
                                        │
  source ──► semgrep security rules ──► candidate weaknesses (CWE-tagged)
                                        │
                                        ▼
                          model tiers assess REACHABILITY
                                        │
                                        ▼
                              VEX-shaped output
```

**SBOM**: CycloneDX (OWASP + Ecma), which carries components, services,
dependencies, vulnerabilities and metadata in one document. `@cyclonedx/cdxgen` is
on npm at **12.8.2**; `syft` is the other common generator.

**Vulnerability matching**: OSV. `POST /v1/query` by package+version,
`POST /v1/querybatch` for bulk, `GET /v1/vulns/{id}` by ID, and query **by commit
hash** — that last one matters for vendored code and submodules (D-36), where there
is no package version to match on. `osv-scanner` is the first-party CLI.

### 4.2 The model's job is reachability, and VEX is already its output format

A scanner says *"`CVE-2024-1234` affects a package in your tree."* It cannot say
whether your code ever reaches the vulnerable path. That judgement is the model's
contribution, and it is where the noise lives — most transitive CVEs are not
exploitable in a given application.

**This already has a standard: VEX** (Vulnerability Exploitability eXchange),
supported by CycloneDX. A VEX statement records whether a product is actually
affected, with a justification such as *vulnerable code not in execute path*.

**That is structurally identical to our `lore-ok` ledger.** A justification with a
reason, attached to a specific finding, that a reviewer accepts or rejects, and that
goes stale when the code changes. We designed the same shape for code review before
knowing the security world had standardised it — which is reassuring, and means the
security type should **emit real VEX** rather than a bespoke format. It costs nothing
extra and makes the output consumable by tools we did not write.

### 4.3 Why this is a separate review type

The default review answers *"is this change correct and well-made?"*. Security
answers *"what known-vulnerable things are we shipping, and can they be reached?"*.

Different inputs (lockfile and SBOM, not just the diff), different scope (the whole
dependency tree, not the change), different cadence (a dependency becomes vulnerable
without anyone touching the repo), and a different output format (VEX).

Running it on every merge would be waste and noise. Hence review types (D-43), with
`code-arch` the default.

## 5. Open items

1. Whether OSV can be mirrored locally for offline/bulk use — the docs did not say,
   and the Pi is behind Tailscale. Per-request API calls are simplest but couple
   reviews to osv.dev's availability.
2. Which semgrep rulesets to enable by default. The registry is large, and enabling
   everything is precisely the noise problem both CodeRabbit and Greptile spend
   engineering effort suppressing.
3. CWE Top 25 list itself — the 2024 page 404'd on the direct URL. Not blocking; the
   taxonomy is what matters, not the ranking.
4. Whether to run security review on a schedule as well as on request, since a
   dependency becomes vulnerable with no commit to trigger a review.
