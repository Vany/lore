/**
 * The document a person reads, weeks later.
 *
 * Two things decide its shape, both from `spec/propose.md` §6.
 *
 * **What was thought about comes first** — repository, resolved SHA, folder, mode,
 * lenses, budget spent against budget allowed. A proposal document that does not say
 * which tree it read is unappraisable in the same way a finding without a file is, and
 * this one is read long after everyone has forgotten. The SHA, never the ref: `master`
 * means something different next week.
 *
 * **`settledBy` is printed before the idea.** It is the load-bearing field: a proposal
 * that cannot name its own falsifying measurement is one nobody can appraise, and that
 * is exactly the kind that costs a fortnight. Printing it first means a reader decides
 * how to check before being persuaded, which is the whole defence against §9's real
 * failure mode — three frontier models writing plausibly.
 *
 * SPEC: spec/propose.md §6
 */

import type { Screened } from "./proposal.ts";

export interface RunHeader {
  readonly repo: string;
  /** The resolved SHA. Never the ref it came from. */
  readonly commit: string;
  readonly folder: string;
  readonly mode: string;
  readonly lenses: readonly string[];
  readonly budget: number;
  /**
   * Sessions ATTEMPTED against `--budget`, not merely succeeded — found by lore's own
   * review, fingerprint 7429b981: a run with real, paid failures (a failed call is
   * still a paid one, b1030112) used to report a success count here, a fraction of
   * what it actually spent against the number the operator chose it for.
   */
  readonly sessionsSpent: number;
  /** ISO instant, passed in rather than taken here so the document is reproducible. */
  readonly at: string;
}

function one(s: Screened, n: number): string {
  const p = s.proposal;
  const out = [`### ${String(n)}. ${p.lens} — ${p.touches.join(", ") || "no files named"}`, ""];

  // Measurement first, then what it keeps, then the idea. A reader who stops after two
  // lines has still learned the two things that decide whether to spend an hour on it.
  out.push(`**Settled by:** ${p.settledBy ?? "_nothing offered — this cannot be appraised as stated_"}`, "");
  out.push(`**Preserves:** ${p.preserves ?? "_not stated — it may not keep the behaviour_"}`, "");
  out.push(p.idea, "");
  out.push(`- **True if:** ${p.trueIf}`);
  out.push(`- **Costs, if wrong:** ${p.costIfWrong}`);
  out.push(`- **Argued against by:** ${p.contradictedBy}`);

  for (const [i, d] of s.demotions.entries()) out.push(`- **${d}:** ${s.because[i] ?? ""}`);
  out.push("");
  return out.join("\n");
}

export function renderProposals(
  header: RunHeader,
  screened: readonly Screened[],
  /** Lenses that produced nothing, and why. Printed, never omitted — see below. */
  silent: readonly string[] = [],
): string {
  const survived = screened.filter((s) => s.demotions.length === 0);
  const dropped = screened.filter((s) => s.demotions.includes("out-of-scope"));
  // Found missing by lore's own review, fingerprint 287fffa0/67a0c784: without its own
  // section, a critic-rejected proposal fell into "decided" below (misleadingly framed
  // as arguing with a PAST decision) or, before that fix existed at all, straight into
  // "Appraise these" — the exact failure the structured `rejects` field was built to
  // avoid, one layer down from where it was first found, fingerprint b551376e.
  const rejectedByCritic = screened.filter((s) => !s.demotions.includes("out-of-scope") && s.demotions.includes("critic-rejects"));
  const weak = (s: Screened) => s.demotions.includes("unappraisable") || s.demotions.includes("invented-paths");
  const notPlaced = (s: Screened) => s.demotions.includes("out-of-scope") || s.demotions.includes("critic-rejects");
  const unappraisable = screened.filter((s) => !notPlaced(s) && weak(s));
  const decided = screened.filter((s) => s.demotions.length > 0 && !notPlaced(s) && !weak(s));

  const lines: string[] = [
    `# Proposals for ${header.repo}${header.folder === "" || header.folder === "." ? "" : ` — ${header.folder}`}`,
    "",
    "**These are ideas, not findings.** Nothing here gates anything, nothing here has been implemented, and",
    "nothing here has been reviewed. A person decides; if one is taken, it goes through the ladder like any",
    "other change (`spec/propose.md` §8).",
    "",
    "| | |",
    "|---|---|",
    `| repository | ${header.repo} |`,
    `| commit | \`${header.commit}\` |`,
    `| folder | ${header.folder === "" || header.folder === "." ? "the whole repository" : `\`${header.folder}\``} |`,
    `| mode | ${header.mode} |`,
    `| lenses | ${header.lenses.join(", ")} |`,
    `| model sessions | ${String(header.sessionsSpent)} of ${String(header.budget)} allowed |`,
    `| run at | ${header.at} |`,
    "",
  ];

  const section = (title: string, note: string, items: readonly Screened[], from: number): number => {
    lines.push(`## ${title}`, "");
    if (items.length === 0) {
      lines.push("_Nothing._", "");
      return from;
    }
    lines.push(note, "");
    items.forEach((s, i) => lines.push(one(s, from + i)));
    return from + items.length;
  };

  let n = 1;
  n = section(
    "Appraise these",
    // NOT a blanket "survived a critic" — found by lore's own review, fingerprint
    // 1efe9c5f: an uncriticised proposal (no second vendor configured, or the
    // budget ran out first) has no demotion of its own and lands here too, marked
    // only on ITS OWN entry's "Argued against by" line, not in this note. The old
    // wording asserted cross-vendor challenge for every item in the section a
    // reader is most likely to skim and trust.
    "In scope and not already decided. Most survived a critic from a different vendor — check each " +
      "entry's own \"Argued against by\" line for a NOT CRITICISED marker before trusting that one did.",
    survived,
    n,
  );
  n = section(
    "Already decided, or arguing with a decision",
    "Kept, because a decision can be wrong and a model arguing with one is worth reading — you are only being told that you are arguing with something rather than with nothing.",
    decided,
    n,
  );
  n = section(
    "Unappraisable",
    "No falsifying measurement, no statement of what it keeps working, or a file named that is not in the tree. Kept and ranked last rather than dropped: silently discarding a generator's output is worse than printing a weak idea.",
    unappraisable,
    n,
  );
  n = section(
    "Out of scope, dropped",
    "The change lands outside the folder this run was about. Recorded so the run is auditable, not for appraisal.",
    dropped,
    n,
  );
  section(
    "Rejected by its critic",
    "The cross-vendor critic's own verdict was that this should not be pursued at all — not merely a " +
      "disagreement with part of it. Also written back to the knowledge base. Recorded so the run is " +
      "auditable, not for appraisal.",
    rejectedByCritic,
    n,
  );

  // A LENS THAT DID NOT LOOK IS NOT A LENS THAT SAW NOTHING (INV-1). A vantage absent
  // from this document reads as one that had no ideas, and a reader deciding whether
  // the codebase was thought about properly has no other way to tell the difference —
  // the failure this whole project is named for, in a document nobody would check.
  lines.push("## What did not produce an idea", "");
  lines.push(
    silent.length === 0
      ? "_Every lens ran and returned something._"
      : "A lens that could not run is not a lens that found nothing worth changing:",
    "",
  );
  for (const s of silent) lines.push(`- ${s}`);

  return `${lines.join("\n").trimEnd()}\n`;
}
