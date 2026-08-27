/**
 * VEX: whether a known vulnerability actually affects this application.
 *
 * The nicest thing found in the research. A scanner says *"a vulnerable package is
 * present"*; only reading the code says whether the vulnerable path is reachable.
 * That judgement already has a standard — VEX, in CycloneDX — recording a status
 * and a justification such as *vulnerable code not in execute path*.
 *
 * **That is structurally identical to the `lore-ok` ledger**: a reason attached to a
 * specific finding, ratified or rejected by a reviewer, going stale when the code
 * changes. We arrived at the same shape independently for code review, so the
 * security type emits **real VEX** rather than a bespoke format — it costs nothing
 * extra and makes the output consumable by tools we did not write.
 *
 * SPEC: research/security-review.md §4.2
 */

import type { RecordedFinding, Store, VerdictKind } from "../store/store.ts";

/** CycloneDX vulnerability analysis states. */
export type VexState = "resolved" | "exploitable" | "in_triage" | "false_positive" | "not_affected";

/** CycloneDX justifications for a not-affected claim. */
export type VexJustification =
  | "code_not_present"
  | "code_not_reachable"
  | "requires_configuration"
  | "requires_dependency"
  | "requires_environment"
  | "protected_by_compiler"
  | "protected_at_runtime"
  | "protected_by_perimeter"
  | "protected_by_mitigating_control";

export interface VexStatement {
  readonly id: string;
  readonly state: VexState;
  readonly justification?: VexJustification;
  readonly detail: string;
  readonly affects: string;
}

/**
 * Map a review verdict onto a VEX state.
 *
 * The important line is the last one: an **open** finding is `in_triage`, never
 * `not_affected`. Silence is not a clearance, and a VEX document that quietly
 * marks unexamined vulnerabilities as harmless is worse than no document — it is a
 * signed claim that nobody checked.
 */
export function stateFor(verdict: VerdictKind | undefined): VexState {
  switch (verdict) {
    case "fixed":
      return "resolved";
    case "justified-accepted":
      return "not_affected";
    case "justified-rejected":
      return "exploitable";
    default:
      return "in_triage";
  }
}

/**
 * Infer a justification from the reviewer-accepted reason.
 *
 * Keyword matching, and deliberately conservative: anything it cannot place falls
 * back to `code_not_reachable`, which is the claim the reason was almost certainly
 * making. The prose reason is carried verbatim in `detail` regardless, so nothing
 * is lost to a bad guess — the enum is a hint for tooling, the detail is the truth.
 */
export function justificationFor(reason: string): VexJustification {
  const r = reason.toLowerCase();
  if (/\bnot (present|installed|bundled|shipped)\b|\bdead code\b|\bnever imported\b/.test(r)) {
    return "code_not_present";
  }
  if (/\bconfig(uration)?\b|\bflag\b|\bfeature toggle\b|\bdisabled\b/.test(r)) return "requires_configuration";
  if (/\benv(ironment)?\b|\bonly on windows\b|\bonly in dev\b/.test(r)) return "requires_environment";
  if (/\bwaf\b|\bgateway\b|\bproxy\b|\bfirewall\b|\bperimeter\b|\bnot exposed\b/.test(r)) {
    return "protected_by_perimeter";
  }
  if (/\bvalidat\w+\b|\bsanitis\w+\b|\bsanitiz\w+\b|\bschema check\b|\bbounded\b|\bguard\b/.test(r)) {
    return "protected_by_mitigating_control";
  }
  if (/\brequires\b.*\bdependency\b|\boptional peer\b/.test(r)) return "requires_dependency";
  return "code_not_reachable";
}

export interface VexDocument {
  readonly bomFormat: "CycloneDX";
  readonly specVersion: "1.6";
  readonly version: 1;
  readonly metadata: { readonly timestamp: string; readonly component: { readonly name: string; readonly version: string } };
  readonly vulnerabilities: readonly unknown[];
}

/**
 * Build a CycloneDX VEX document for a review.
 *
 * Only findings that name a vulnerability get a statement. A code-review finding is
 * not a VEX subject, and inventing an identifier for one would put fiction into a
 * document other tools are meant to trust.
 *
 * lore-ok[8a8ec642]: `origin === "t0"` is checked FIRST, before `vulnIdOf` ever
 * looks at the evidence text. A model tier's commentary can mention a CVE id in
 * passing ("this looks related to CVE-2021-44228") without that finding being
 * about a scanned, present vulnerability at all — `vulnIdOf` alone could not tell
 * the difference, and a signed VEX statement built from that would assert a
 * scanner-verified state (`in_triage`, `not_affected`, ...) for something no
 * scanner ever looked at. `origin` only discriminates t0-vs-tier, not which t0
 * ENGINE (`review.ts` writes the literal `"t0"` for every one of them — sbom,
 * semgrep, osv alike — never a per-engine value, despite this field's own name),
 * so `vulnIdOf`'s anchor to osv.ts's own `"OSV <id>"` evidence prefix (below)
 * still carries the rest of the precision this filter cannot.
 */
export function buildVex(
  store: Store,
  reviewId: string,
  project: { name: string; version: string },
  timestamp: string,
): VexDocument {
  // Worst first, like every other list of findings this service emits: the statements
  // are read in order, and a VEX consumer that stops early should stop on the least
  // important one.
  const findings = store.findingRowsForReview(reviewId);

  const vulnerabilities: unknown[] = [];

  for (const row of findings) {
    if (String(row["origin"] ?? "") !== "t0") continue;
    const id = vulnIdOf(String(row["evidence"] ?? ""));
    if (id === undefined) continue;

    const fingerprint = String(row["fingerprint"] ?? "");
    const verdict = store.latestVerdict(reviewId, fingerprint);
    const state = stateFor(verdict?.verdict);
    const detail = verdict?.rationale ?? "not yet examined";

    vulnerabilities.push({
      id,
      source: { name: "OSV", url: `https://osv.dev/vulnerability/${id}` },
      analysis: {
        state,
        ...(state === "not_affected" ? { justification: justificationFor(detail) } : {}),
        detail,
        // A VEX statement is about a specific tree, exactly as an attestation is
        // about a tree hash rather than a branch name.
        response: state === "resolved" ? ["update"] : [],
      },
      affects: [{ ref: String(row["file"] ?? "") }],
      ...(row["cwe"] !== null && row["cwe"] !== undefined
        ? { cwes: [Number(String(row["cwe"]).replace("CWE-", ""))] }
        : {}),
    });
  }

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { timestamp, component: { name: project.name, version: project.version } },
    vulnerabilities,
  };
}

/**
 * OSV and CVE identifiers, as written into a finding's evidence by osv.ts.
 *
 * Anchored to the exact `"OSV <id>"` prefix `toFindings`/`commitToFindings`
 * (osv.ts) always write as evidence's first line, not just a bare id-shaped
 * substring found anywhere in the text. `origin` (buildVex, above) already
 * excludes model-tier findings, but cannot tell osv apart from sbom/semgrep/etc
 * within t0 — a defect finding whose prose happens to cite a CVE by way of
 * explanation must not read as a scanner-verified vulnerability statement.
 */
export function vulnIdOf(evidence: string): string | undefined {
  return /^OSV ((?:CVE|GHSA|OSV|PYSEC|RUSTSEC|GO)-[A-Za-z0-9-]+)\b/.exec(evidence)?.[1];
}

/** Human-facing summary. The machine form is the document above. */
export function renderVex(doc: VexDocument): string {
  const rows = doc.vulnerabilities as { id: string; analysis: { state: string; detail: string } }[];
  if (rows.length === 0) return "No known vulnerabilities matched in this tree.";

  const byState = new Map<string, number>();
  for (const r of rows) byState.set(r.analysis.state, (byState.get(r.analysis.state) ?? 0) + 1);

  const lines = [`${rows.length} vulnerability statement(s):`];
  for (const [state, count] of byState) lines.push(`  ${state}: ${count}`);
  const triage = byState.get("in_triage") ?? 0;
  if (triage > 0) {
    lines.push(
      "",
      `${triage} are still in triage — nobody has judged whether they are reachable. Do not read that as safe.`,
    );
  }
  return lines.join("\n");
}

export function findingsNeedingTriage(store: Store, reviewId: string): readonly RecordedFinding[] {
  return store.openFindings(reviewId).filter((f) => f.origin === "t0" && vulnIdOf(f.evidence) !== undefined);
}
