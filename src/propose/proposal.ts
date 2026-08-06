/**
 * What a proposal is, and what disqualifies one.
 *
 * Deliberately NOT the finding schema. `evidence` and `failureScenario` make a model
 * defensible, and a defensible model is a boring one — which is the opposite of what
 * this tool is for (D-75). What replaces them are the two fields that make an idea
 * appraisable rather than merely persuasive:
 *
 *   * `settledBy` — the ONE measurement that would decide it. The motivating case: a
 *     large refactor was proposed here, `wc -l` and a twenty-line reachability script
 *     killed it in ten minutes, and the measurement *was* the appraisal. The danger is
 *     never a bad idea — a bad idea dies in five seconds — it is a plausible one.
 *   * `preserves` — what must keep working identically. *"But keep the overall
 *     functionality."* A model asked to improve something will, given room, improve
 *     what it is FOR, and an idea that quietly changes behaviour is not a better
 *     version of this code — it is different code wearing its name.
 *
 * Nothing is dropped for being badly formed. A proposal missing either field is kept,
 * marked `unappraisable`, and ranked last: this is a generator, and silently discarding
 * its output is the failure D-66 already settled for findings.
 *
 * SPEC: spec/propose.md §4, §5
 */

/** The vantages a proposer is sent from. Forced apart on purpose — consensus is a smell. */
export const LENSES = ["data", "failure", "seams", "greenfield"] as const;
export type Lens = (typeof LENSES)[number];

export function isLens(s: string): s is Lens {
  return (LENSES as readonly string[]).includes(s);
}

export interface Proposal {
  readonly lens: Lens;
  /** One paragraph, in the model's own words. */
  readonly idea: string;
  /** Which files the change lands in — how §1.1's scope rule is applied. */
  readonly touches: readonly string[];
  readonly trueIf: string;
  readonly costIfWrong: string;
  readonly contradictedBy: string;
  /** The ONE measurement that would decide it, or absent. */
  readonly settledBy?: string;
  /** What must keep working identically, and how you would know, or absent. */
  readonly preserves?: string;
}

/**
 * Why a proposal is not in the "appraise these" section.
 *
 * `out-of-scope` is the only one that DROPS a proposal, and the asymmetry is deliberate:
 * an idea about somewhere else is an answer to a question nobody asked, while the others
 * are ideas the reader might still want, weakly stated or already had.
 */
export type Demotion = "out-of-scope" | "unappraisable" | "already-decided" | "contradicts-taught";

export interface Screened {
  readonly proposal: Proposal;
  /** Empty means it survived: appraise this one. */
  readonly demotions: readonly Demotion[];
  /** Why, in the reader's words — one line per demotion, same order. */
  readonly because: readonly string[];
}

/** Anything not an object is not a proposal; say which field failed, never "malformed". */
function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Parse one proposal, or say precisely what was wrong with it.
 *
 * The distinction matters for the same reason it does in the reviewer: "malformed JSON"
 * was once said about perfectly valid JSON that the schema declined, and it sent an
 * hour of debugging in the wrong direction.
 */
export function parseProposal(input: unknown): Proposal | { readonly rejected: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { rejected: `not an object: ${JSON.stringify(input)?.slice(0, 120) ?? "undefined"}` };
  }
  const o = input as Record<string, unknown>;

  const lens = str(o, "lens");
  if (lens === undefined || !isLens(lens)) {
    return { rejected: `lens must be one of ${LENSES.join(", ")}, got ${JSON.stringify(o["lens"])}` };
  }
  for (const required of ["idea", "trueIf", "costIfWrong", "contradictedBy"] as const) {
    if (str(o, required) === undefined) return { rejected: `${lens}: '${required}' is required and was empty` };
  }

  // `touches` is how §1.1's scope rule is applied, so an absent one is not a formatting
  // slip — it is a proposal that cannot be placed. Empty rather than rejected, because
  // the screen below then demotes it as out-of-scope with a reason a reader can act on.
  const touches = Array.isArray(o["touches"])
    ? o["touches"].filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim())
    : [];

  return {
    lens,
    idea: str(o, "idea") ?? "",
    touches,
    trueIf: str(o, "trueIf") ?? "",
    costIfWrong: str(o, "costIfWrong") ?? "",
    contradictedBy: str(o, "contradictedBy") ?? "",
    ...(str(o, "settledBy") === undefined ? {} : { settledBy: str(o, "settledBy") as string }),
    ...(str(o, "preserves") === undefined ? {} : { preserves: str(o, "preserves") as string }),
  };
}

/**
 * Is this change ABOUT the folder we were asked about?
 *
 * "Read outward, propose inward" (§1.1). A proposer is told to read callers, dependants
 * and specs wherever the code links — a proposal about a folder made without reading
 * its callers is a proposal about a folder nobody uses — but the SUBJECT is the folder.
 *
 * One file inside it is enough. A proposal that moves a seam necessarily touches both
 * sides, and requiring every path to be inside would reject exactly the structural ideas
 * this tool exists to get.
 *
 * `folder` empty (the default, the repository root) means everything is in scope.
 */
export function inScope(folder: string, touches: readonly string[]): boolean {
  const root = folder.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (root === "" || root === ".") return true;
  return touches.some((p) => {
    const path = p.replace(/^\.?\/+/, "");
    return path === root || path.startsWith(`${root}/`);
  });
}
