/**
 * OSV: known vulnerabilities, per package and version.
 *
 * The machine-queryable form of CVE. Note the commit-hash query — that is what
 * vendored code and **submodules** need, since a gitlink has no package version to
 * match on (D-36).
 *
 * This layer only says *"a vulnerable package is present"*. Whether the vulnerable
 * path is reachable from this application is the model's job, and it is where both
 * the noise and the value are: most transitive CVEs are not exploitable in a given
 * app, and a tool that reports all of them trains people to ignore it.
 *
 * SPEC: research/security-review.md §4
 */

import { CLAIM_MAX } from "../core/finding.ts";
import { DidNotRun } from "../core/errors.ts";
import type { Finding, Severity } from "../core/finding.ts";
import type { Component } from "./sbom.ts";

const OSV_API = "https://api.osv.dev/v1";

/** OSV documents batching at 1000; kept well under to bound request size. */
const BATCH = 500;

export interface OsvVuln {
  readonly id: string;
  readonly summary?: string;
  readonly details?: string;
  readonly aliases?: readonly string[];
  readonly severity?: readonly { type?: string; score?: string }[];
  readonly database_specific?: { severity?: string; cwe_ids?: readonly string[] };
  readonly affected?: readonly {
    /**
     * Which package this ENTRY is about — confirmed against OSV's own schema
     * docs: one record can name several `affected` entries, each with its own
     * `package`, when one advisory covers multiple packages. `fixedVersion`
     * (below) matches on this; without it, the first `fixed` event found by
     * walking the whole record in document order can belong to an entirely
     * different package than the component being reported on.
     */
    package?: { name?: string; ecosystem?: string };
    ranges?: readonly { events?: readonly { fixed?: string }[] }[];
  }[];
}

export interface Vulnerable {
  readonly component: Component;
  readonly vulns: readonly OsvVuln[];
}

/**
 * Query OSV for a set of components.
 *
 * A failed query throws. An empty result and an unreachable database must never
 * look alike: one means "nothing known", the other means "we did not look", and
 * only one of them is safe to ship on.
 *
 * lore-ok[bfa2e44b]: HYDRATED, NOT TRUSTED BARE. Confirmed against OSV's own
 * current API docs, not assumed: `/v1/querybatch` "returns vulnerability ids
 * and modified field only" — every OTHER field this module reads
 * (`severityOf`'s `database_specific.severity`, `fixedVersion`'s `affected`,
 * `aliases`, `cweOf`'s `database_specific.cwe_ids`) comes back `undefined` on
 * every real call, so every finding this module has ever produced defaulted
 * to medium severity and "no fixed version published" regardless of the
 * database's real answer — confident, wrong, in the direction that gets a
 * vulnerability ignored. `/v1/vulns/{id}` (confirmed separately: a full
 * record) is queried once per DISTINCT vulnerability id found, after
 * batching — bounded by how many vulnerabilities actually matched, usually
 * far fewer than the components queried, not by the dependency tree's size.
 * A hydration failure for any one id throws, same as a failed query: partial
 * hydration is the identical partial-trust shape the batch-mismatch check
 * below already refuses.
 */
export async function queryComponents(
  components: readonly Component[],
  fetchImpl: typeof fetch = fetch,
): Promise<readonly Vulnerable[]> {
  const out: Vulnerable[] = [];

  for (let i = 0; i < components.length; i += BATCH) {
    const chunk = components.slice(i, i + BATCH);
    const body = {
      queries: chunk.map((c) => ({
        package: { name: c.name, ecosystem: c.ecosystem },
        version: c.version,
      })),
    };

    const res = await fetchImpl(`${OSV_API}/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).catch((e: unknown) => {
      throw new DidNotRun(`OSV query failed — the vulnerability check DID NOT RUN: ${String(e)}`, e);
    });

    if (!res.ok) {
      throw new DidNotRun(`OSV returned ${res.status} — the vulnerability check DID NOT RUN`);
    }

    const parsed = (await res.json()) as { results?: { vulns?: OsvVuln[]; next_page_token?: string }[] };
    const results = parsed.results ?? [];

    // THE ANSWERS ARE MATCHED TO THE QUESTIONS BY POSITION AND NOTHING ELSE. OSV's
    // batch API returns one result per query, in order, and this zips them against the
    // chunk that was sent — so a response that is SHORT leaves the last components with
    // no result at all, and they were reported as clean. Not "we could not check" —
    // clean, in a security review, for a package nobody looked at. That is INV-1 inside
    // the scanner, and it is the failure this whole project is named for.
    //
    // Refused rather than partially trusted: a vulnerability check that examined some
    // unknown subset of the dependencies is not a vulnerability check.
    if (results.length !== chunk.length) {
      throw new DidNotRun(
        `OSV answered ${String(results.length)} result(s) for ${String(chunk.length)} component(s) — the ` +
          "answers are matched to the queries BY POSITION, so a mismatched batch would attribute one " +
          "package's vulnerabilities to another and report the remainder as clean. The vulnerability check " +
          "DID NOT RUN.",
      );
    }

    for (const [j, result] of results.entries()) {
      const component = chunk[j];
      if (component === undefined) continue;
      // lore-ok[bfa2e44b]: TRUNCATION REFUSED, NOT SILENT. OSV's own docs: a
      // `next_page_token` on a result means over 1000 known vulnerabilities
      // exist for that one query and this page did not carry all of them —
      // the same silent-partial-result shape the batch-length check above
      // already refuses, one level in: THIS component would otherwise be
      // reported with an incomplete vulnerability list read as a complete one.
      if (result.next_page_token !== undefined) {
        throw new DidNotRun(
          `OSV truncated the vulnerability list for ${component.name}@${component.version} (over 1000 known ` +
            "vulnerabilities, next_page_token present) — the vulnerability check DID NOT RUN",
        );
      }
      const vulns = result.vulns ?? [];
      if (vulns.length > 0) out.push({ component, vulns });
    }
  }

  const ids = new Set<string>();
  for (const { vulns } of out) for (const v of vulns) ids.add(v.id);
  const hydrated = await hydrateVulns(ids, fetchImpl);
  return out.map(({ component, vulns }) => ({ component, vulns: vulns.map((v) => hydrated.get(v.id) ?? v) }));
}

/** `/v1/vulns/{id}` is the one OSV endpoint that returns a full record — see `queryComponents`' own doc comment for why this exists. */
async function hydrateVulns(ids: ReadonlySet<string>, fetchImpl: typeof fetch): Promise<ReadonlyMap<string, OsvVuln>> {
  const out = new Map<string, OsvVuln>();
  await Promise.all(
    [...ids].map(async (id) => {
      const res = await fetchImpl(`${OSV_API}/vulns/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(60_000),
      }).catch((e: unknown) => {
        throw new DidNotRun(`OSV vulnerability lookup failed for ${id} — the vulnerability check DID NOT RUN: ${String(e)}`, e);
      });
      if (!res.ok) {
        throw new DidNotRun(`OSV returned ${String(res.status)} looking up ${id} — the vulnerability check DID NOT RUN`);
      }
      out.set(id, (await res.json()) as OsvVuln);
    }),
  );
  return out;
}

/**
 * Query by commit hash — for submodules and vendored code, which have no version.
 *
 * A gitlink bump is two lines of diff that can move a dependency across a published
 * vulnerability, and nothing about the outer diff would show it.
 *
 * **This had no caller until 2026-08-06.** It was written, tested and never invoked,
 * while `PLAN.md` Phase 5 named it "needed for submodules" and D-36 records that this
 * workgroup ships submodules rather than monorepos. So the security review enumerated
 * `package-lock.json`, found nothing in the vendored tree, and the absence read as a
 * clean result — the `isStale` shape from session 19, in the review type whose whole
 * output is a claim about what was checked. `engines.ts` calls it now, via `gitlinks`.
 */
export async function queryCommit(commit: string, fetchImpl: typeof fetch = fetch): Promise<readonly OsvVuln[]> {
  const res = await fetchImpl(`${OSV_API}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commit }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e: unknown) => {
    throw new DidNotRun(`OSV commit query failed — the check DID NOT RUN: ${String(e)}`, e);
  });
  if (!res.ok) throw new DidNotRun(`OSV returned ${res.status} for commit ${commit}`);
  return ((await res.json()) as { vulns?: OsvVuln[] }).vulns ?? [];
}

/**
 * Severity, from the database's own qualitative rating.
 *
 * OSV carries CVSS as a *vector string*, not a number. Implementing the scoring
 * algorithm to recover a score would be a lot of arithmetic to arrive at a number
 * the database already summarised — and getting it subtly wrong would be worse than
 * not having it, because a confident wrong severity is what decides whether anyone
 * looks.
 */
export function severityOf(v: OsvVuln): Severity {
  const qualitative = (v.database_specific?.severity ?? "").toUpperCase();
  if (qualitative === "CRITICAL" || qualitative === "HIGH") return "high";
  if (qualitative === "MODERATE" || qualitative === "MEDIUM") return "medium";
  if (qualitative === "LOW") return "low";
  // Unknown severity is treated as medium, not low: an unrated vulnerability is
  // unrated, not harmless, and defaulting downward is how things get ignored.
  return "medium";
}

/**
 * lore-ok[47df1c30]: Every distinct "fixed in" version OSV records for THIS
 * component specifically — not the first one found anywhere in the record.
 *
 * Confirmed against OSV's own schema docs, not assumed: one record can carry
 * several `affected` entries (a multi-package advisory — a fix version from the
 * wrong package can name a version that does not exist for this component at
 * all), and one entry's own `ranges[]` can carry several ranges (a package
 * vulnerable in `[1.0.0, 1.0.2)` AND, separately, `[3.0.0, 3.2.5)` — introduced,
 * fixed, reintroduced, fixed again). Matched on `affected[].package` first, so a
 * fix from a different package is excluded entirely; entries silent about which
 * package they name (no `package` field at all) are kept rather than dropped,
 * since excluding everything on a record OSV itself did not bother to disambiguate
 * would be worse than the ambiguity it is trying to avoid. Deliberately not
 * collapsed to one range's own fix within the matched package: without a real,
 * per-ecosystem version comparator to decide which range the component's
 * installed version actually falls into, picking one silently would be exactly
 * the confident-guess this rewrite exists to stop making — every candidate is
 * returned instead, and the reader is told there is more than one when there is.
 */
export function fixedVersion(v: OsvVuln, component: Component): readonly string[] {
  const fixed = new Set<string>();
  for (const a of v.affected ?? []) {
    if (a.package !== undefined && (a.package.name !== component.name || a.package.ecosystem !== component.ecosystem)) {
      continue;
    }
    for (const r of a.ranges ?? []) {
      for (const e of r.events ?? []) {
        if (e.fixed !== undefined) fixed.add(e.fixed);
      }
    }
  }
  return [...fixed];
}

function cweOf(v: OsvVuln): string | undefined {
  const id = v.database_specific?.cwe_ids?.[0];
  return id !== undefined && /^CWE-\d+$/.test(id) ? id : undefined;
}

/**
 * Where the decision to ship this version actually lives, per ecosystem — a best
 * effort, not a fact this reader has checked (see sbom.ts's Component.transitive
 * doc comment for the finding this answers: a hardcoded `"package-lock.json"`
 * default used to point every non-npm finding — PyPI, Go, Rust, Maven, Ruby
 * components `cdxgen` genuinely enumerated — at a file that never mentions
 * them). This module never opens the worktree, so for ecosystems with more than
 * one common manifest shape (PyPI especially) the name is a typical one, named
 * as such, not a confirmed path.
 *
 * lore-ok[324ff769]: A REAL PATH, one per ecosystem — `Finding.file` is
 * documented and consumed as "repo-relative path" (core/finding.ts, `buildVex`'s
 * `affects[].ref`), not free text, so PyPI's own disambiguation ("could also be
 * poetry.lock/Pipfile.lock") moved to `evidence` (below, `MANIFEST_CAVEAT`)
 * instead of living inside the path field as a sentence no path-consumer could
 * ever resolve.
 */
const TYPICAL_MANIFEST: Record<Component["ecosystem"], string> = {
  npm: "package-lock.json",
  PyPI: "requirements.txt",
  Go: "go.sum",
  "crates.io": "Cargo.lock",
  Maven: "pom.xml",
  RubyGems: "Gemfile.lock",
};

/**
 * Where `TYPICAL_MANIFEST`'s guess is one of several equally common names.
 *
 * lore-ok[59c1cbc2]: `npm` ADDED. OSV's own npm ecosystem covers whatever
 * lockfile actually installed the package, not only npm's own —
 * package-lock.json presented as fact on a yarn/pnpm/bun repo is the exact
 * same nonexistent-path shape b03d0b1e (engines.ts) already fixed once for
 * the cannot-enumerate finding, one field deeper: cdxgen enumerates a
 * yarn.lock repo's npm-ecosystem components fine, and this caveat was the
 * one place that disclosure was already wired to reach the reader — PyPI
 * had it, npm (which has just as many common lockfile shapes) did not.
 */
const MANIFEST_CAVEAT: Partial<Record<Component["ecosystem"], string>> = {
  npm: "manifest name is a typical guess: could also be yarn.lock, pnpm-lock.yaml, or bun.lock, not itself checked",
  PyPI: "manifest name is a typical guess: could also be poetry.lock or Pipfile.lock, not itself checked",
};

/** Turn vulnerable components into findings. */
export function toFindings(vulnerable: readonly Vulnerable[]): readonly Finding[] {
  const out: Finding[] = [];

  for (const { component, vulns } of vulnerable) {
    for (const v of vulns) {
      const fixed = fixedVersion(v, component);
      const cwe = cweOf(v);
      const aliases = (v.aliases ?? []).filter((a) => a.startsWith("CVE-"));
      const label = aliases[0] ?? v.id;

      out.push({
        file: TYPICAL_MANIFEST[component.ecosystem],
        severity: severityOf(v),
        claim: cap(
          `${component.name}@${component.version} is affected by ${label}${v.summary === undefined ? "" : `: ${v.summary}`}`,
          CLAIM_MAX,
        ),
        evidence: cap(
          [
            `OSV ${v.id}${aliases.length > 0 ? ` (${aliases.join(", ")})` : ""}`,
            `${component.ecosystem} package ${component.name}@${component.version}`,
            component.transitive === undefined
              ? "direct vs. transitive not determined for this component"
              : component.transitive
                ? "reached transitively, not a direct dependency"
                : "a direct dependency",
            fixed.length === 0
              ? "no fixed version published"
              : fixed.length === 1
                ? `fixed in ${fixed[0] ?? ""}`
                : `fixed in one of: ${fixed.join(", ")} — depending on which range applies to the installed version`,
            ...(MANIFEST_CAVEAT[component.ecosystem] !== undefined ? [MANIFEST_CAVEAT[component.ecosystem]!] : []),
          ].join("\n"),
          2000,
        ),
        failureScenario: cap(
          v.details ?? v.summary ?? "see the OSV record for exploitation details",
          2000,
        ),
        ...(cwe !== undefined ? { cwe } : {}),
      });
    }
  }
  return out;
}

/**
 * Findings for a submodule pointer, whose `file` is the gitlink path.
 *
 * Separate from `toFindings` because the two disagree about what a reader must go and
 * look at. A package vulnerability points at the lockfile, where the decision to ship
 * a version lives and where a fix is applied. A gitlink has no lockfile entry: the
 * decision is the pointer itself, and the fix is moving it — so pointing at
 * `package-lock.json` would send a reader to a file that does not mention it.
 */
export function commitToFindings(path: string, commit: string, vulns: readonly OsvVuln[]): readonly Finding[] {
  return vulns.map((v) => {
    const aliases = (v.aliases ?? []).filter((a) => a.startsWith("CVE-"));
    const label = aliases[0] ?? v.id;
    const cwe = cweOf(v);
    return {
      file: path,
      severity: severityOf(v),
      claim: cap(
        `submodule ${path} is pinned at a commit affected by ${label}` +
          `${v.summary === undefined ? "" : `: ${v.summary}`}`,
        CLAIM_MAX,
      ),
      evidence: cap(
        [
          `OSV ${v.id}${aliases.length > 0 ? ` (${aliases.join(", ")})` : ""}`,
          `gitlink ${path} → ${commit}`,
          "matched by commit, because a submodule has no package version to match on",
        ].join("\n"),
        2000,
      ),
      failureScenario: cap(v.details ?? v.summary ?? "see the OSV record for exploitation details", 2000),
      ...(cwe !== undefined ? { cwe } : {}),
    };
  });
}

function cap(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
