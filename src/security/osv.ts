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

export const OSV_API = "https://api.osv.dev/v1";

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

    const parsed = (await res.json()) as { results?: { vulns?: OsvVuln[] }[] };
    for (const [j, result] of (parsed.results ?? []).entries()) {
      const component = chunk[j];
      if (component === undefined) continue;
      const vulns = result.vulns ?? [];
      if (vulns.length > 0) out.push({ component, vulns });
    }
  }
  return out;
}

/**
 * Query by commit hash — for submodules and vendored code, which have no version.
 *
 * A gitlink bump is two lines of diff that can move a dependency across a published
 * vulnerability, and nothing about the outer diff would show it.
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

export function fixedVersion(v: OsvVuln): string | undefined {
  for (const a of v.affected ?? []) {
    for (const r of a.ranges ?? []) {
      for (const e of r.events ?? []) {
        if (e.fixed !== undefined) return e.fixed;
      }
    }
  }
  return undefined;
}

export function cweOf(v: OsvVuln): string | undefined {
  const id = v.database_specific?.cwe_ids?.[0];
  return id !== undefined && /^CWE-\d+$/.test(id) ? id : undefined;
}

/**
 * Turn vulnerable components into findings.
 *
 * The lockfile is the `file`, because that is where the decision to ship this
 * version actually lives — and it is where a fix would be applied.
 */
export function toFindings(vulnerable: readonly Vulnerable[], lockfile = "package-lock.json"): readonly Finding[] {
  const out: Finding[] = [];

  for (const { component, vulns } of vulnerable) {
    for (const v of vulns) {
      const fixed = fixedVersion(v);
      const cwe = cweOf(v);
      const aliases = (v.aliases ?? []).filter((a) => a.startsWith("CVE-"));
      const label = aliases[0] ?? v.id;

      out.push({
        file: lockfile,
        severity: severityOf(v),
        claim: cap(
          `${component.name}@${component.version} is affected by ${label}${v.summary === undefined ? "" : `: ${v.summary}`}`,
          CLAIM_MAX,
        ),
        evidence: cap(
          [
            `OSV ${v.id}${aliases.length > 0 ? ` (${aliases.join(", ")})` : ""}`,
            `${component.ecosystem} package ${component.name}@${component.version}`,
            component.transitive ? "reached transitively, not a direct dependency" : "a direct dependency",
            fixed === undefined ? "no fixed version published" : `fixed in ${fixed}`,
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

function cap(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
