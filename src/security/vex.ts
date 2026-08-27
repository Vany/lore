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

/**
 * lore-ok[1c67ff0d]: MATCHES WHAT `buildVex` ACTUALLY EMITS, below — this
 * exported type described a flat `{state, affects: string}` shape nothing in
 * this module ever produced (the real emission nests `state` under
 * `analysis` and `affects` is an array of refs), and was read by nothing —
 * not even this module's own `renderVex`, which cast to a THIRD, separately
 * inline-typed shape instead of using this one. A reader (or an editor of
 * `buildVex`) trusting this type would write code that compiles and is wrong
 * against every real document — the exported-type-nobody-checks-against
 * defect this repo already named once for RULE_DIRS. Now the type `buildVex`
 * and `renderVex` actually share, so the compiler catches the two drifting
 * apart again.
 */
export interface VexStatement {
  readonly id: string;
  readonly source: { readonly name: string; readonly url: string };
  readonly analysis: {
    readonly state: VexState;
    readonly justification?: VexJustification;
    readonly detail: string;
    readonly response: readonly string[];
  };
  readonly affects: readonly { readonly ref: string }[];
  readonly cwes?: readonly number[];
}

/**
 * Map a review verdict onto a VEX state.
 *
 * The important line is the last one: an **open** finding is `in_triage`, never
 * `not_affected`. Silence is not a clearance, and a VEX document that quietly
 * marks unexamined vulnerabilities as harmless is worse than no document — it is a
 * signed claim that nobody checked.
 *
 * lore-ok[494b2281]: `tier` ADDED. `expireStaleVerdicts` (reviewer/review.ts)
 * writes verdict `"justified-rejected"` with `tier: "expiry"` when the code an
 * ACCEPTED justification was about has since moved — a claim that the reason
 * needs RE-EXAMINING, not that a reviewer looked and rejected it. Both used to
 * map to `"exploitable"`, a specific, confident claim nobody actually made;
 * meanwhile the same finding stays `openFindings` (SETTLING_VERDICTS excludes
 * `justified-rejected` either way) and so is ALSO counted in `untriaged` —
 * the same `review_vex` response asserting "confirmed exploitable" and "still
 * needs triage" about the identical finding.
 */
export function stateFor(verdict: VerdictKind | undefined, tier?: string): VexState {
  switch (verdict) {
    case "fixed":
      return "resolved";
    case "justified-accepted":
      return "not_affected";
    case "justified-rejected":
      return tier === "expiry" ? "in_triage" : "exploitable";
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

/**
 * lore-ok[f7cbff4c]: A REAL COMPONENT ENTRY per statement, `affects[].ref`'s
 * required target — confirmed against CycloneDX's own JSON schema:
 * `affects[].ref` is documented as "the bom-ref identifiers of the components
 * or services... affected", a cross-reference INTO this same document's own
 * `components[]`, not an arbitrary string. This document had no `components`
 * at all, so every `ref` — a bare file path — pointed at nothing any
 * spec-conformant consumer could resolve, in the one field whose entire job
 * is naming the subject of the statement.
 */
export interface VexComponent {
  readonly "bom-ref": string;
  readonly type: "library";
  readonly name: string;
}

export interface VexDocument {
  readonly bomFormat: "CycloneDX";
  readonly specVersion: "1.6";
  readonly version: 1;
  readonly metadata: { readonly timestamp: string; readonly component: { readonly name: string; readonly version: string } };
  readonly components: readonly VexComponent[];
  readonly vulnerabilities: readonly VexStatement[];
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

  const components: VexComponent[] = [];
  const vulnerabilities: VexStatement[] = [];

  for (const row of findings) {
    if (String(row["origin"] ?? "") !== "t0") continue;
    const id = vulnIdOf(String(row["evidence"] ?? ""));
    if (id === undefined) continue;

    const fingerprint = String(row["fingerprint"] ?? "");
    const verdict = store.latestVerdict(reviewId, fingerprint);
    const state = stateFor(verdict?.verdict, verdict?.tier);
    const detail = verdict?.rationale ?? "not yet examined";

    // One synthetic component per statement, keyed by fingerprint — the
    // original Component (sbom.ts) this finding was raised from does not
    // survive into the stored row, only `claim`/`evidence`/`file` do.
    const bomRef = `component-${fingerprint}`;
    components.push({
      "bom-ref": bomRef,
      type: "library",
      name: componentNameFrom(String(row["claim"] ?? ""), String(row["file"] ?? "")),
    });

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
      affects: [{ ref: bomRef }],
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
    components,
    vulnerabilities,
  };
}

/**
 * `toFindings` (osv.ts) always writes a claim starting `${name}@${version} is
 * affected by...`; `commitToFindings`' submodule claims do not (`submodule
 * ${path} is pinned at...`), so this falls back to the finding's own `file` —
 * still real, still resolvable, just less specific than a package coordinate.
 */
function componentNameFrom(claim: string, file: string): string {
  return /^(\S+@\S+) is affected by\b/.exec(claim)?.[1] ?? file;
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
 *
 * lore-ok[f6b7d999]: `MAL` ADDED — confirmed against OSV's own schema docs:
 * OSV federates the OpenSSF malicious-packages database under this prefix,
 * a distinct id scheme from CVE/GHSA/PYSEC/RUSTSEC/GO. `osv.ts` writes
 * whatever id OSV itself returns with no scheme filtering, so a MAL finding
 * already existed and was already silently invisible to every VEX-subject
 * check in this file — the one class this review type exists to surface,
 * absent from its own output.
 */
export function vulnIdOf(evidence: string): string | undefined {
  return /^OSV ((?:CVE|GHSA|OSV|PYSEC|RUSTSEC|GO|MAL)-[A-Za-z0-9-]+)\b/.exec(evidence)?.[1];
}

/**
 * Why `renderVex`'s clean-sounding zero-statement sentence might not mean what
 * it looks like — `undefined` when there is no such reason, i.e. the tree was
 * genuinely, currently checked.
 *
 * lore-ok[9b09e7c5,a9c12b7e]: the round-3 fix (d7af16cf) keyed this entirely
 * on `checksSkippedFor`, which has two gaps of its own: it unions every round
 * of the review's WHOLE LIFETIME (so a transient round-1 OSV outage poisons
 * the summary forever, past rounds that ran fine), and it is silent — not
 * "clean", silent — for a review whose t0 has not completed a single round
 * yet, or whose TYPE never runs sbom/osv at all (`CODE_ARCH.t0` omits both;
 * only `SECURITY.t0` has them, review-type.ts). Both silences read as "clean"
 * to a caller reading only `checksSkippedFor`'s absence of a line. `reviewType`
 * and `store.latestT0Unavailable` (the CURRENT round only) are checked instead.
 *
 * lore-ok[287b1a76,12255b33]: `store.latestT0Unavailable` had the SAME silent-
 * as-clean shape one round-boundary deeper — an in-flight round's own row
 * (`unavailable` still NULL, written at round START) read exactly like a
 * closed round that found nothing unavailable. Fixed at the query itself
 * (store.ts, `finished_at IS NOT NULL`), not here: this function only
 * consumes what that method returns and has no round-open/closed state of
 * its own to filter on.
 */
export function vexGap(store: Store, reviewId: string, reviewType: string): string | undefined {
  if (reviewType !== "security") return "this review does not check dependencies (not a security review)";

  const unavailable = store.latestT0Unavailable(reviewId);
  if (unavailable === undefined) return "no round has completed yet";

  // lore-ok[4ca2c2a4]: `"t0:"` ADDED — review.ts's own catch block around
  // `runT0` writes a whole-phase failure under that prefix (a throw before
  // any engine even ran), which means osv/sbom did not run either, every bit
  // as much as either naming itself individually would.
  const relevant = unavailable.filter((l) => l.startsWith("osv:") || l.startsWith("sbom:") || l.startsWith("t0:"));
  return relevant.length > 0 ? relevant.join("; ") : undefined;
}

/**
 * Human-facing summary. The machine form is the document above.
 *
 * lore-ok[a9c12b7e]: this function's own body used to compute the caveat
 * directly from `checksSkippedFor` (round 3, d7af16cf) — the round/review-type
 * blindness a9c12b7e named was IN that computation, which has since moved out
 * entirely into `vexGap`, above. This function just prints whatever reason
 * `vexGap` hands it now; see `vexGap`'s own doc comment for the actual fix.
 */
export function renderVex(doc: VexDocument, gap?: string): string {
  const rows = doc.vulnerabilities;

  if (rows.length === 0) {
    return gap === undefined
      ? "No known vulnerabilities matched in this tree."
      : `No vulnerability statements — but ${gap}. This does not mean the tree is clean.`;
  }

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
  if (gap !== undefined) {
    lines.push("", `Incomplete: ${gap} — this document does not cover everything.`);
  }
  return lines.join("\n");
}

export function findingsNeedingTriage(store: Store, reviewId: string): readonly RecordedFinding[] {
  return store.openFindings(reviewId).filter((f) => f.origin === "t0" && vulnIdOf(f.evidence) !== undefined);
}
