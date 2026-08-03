/**
 * Review types: a review is a named pipeline, not a hardcoded sequence.
 *
 * `code-arch` is the default — *is this change correct and well-made?* `security`
 * asks a different question over different inputs (the lockfile and dependency
 * tree, not the diff), on a different cadence, with a different output format
 * (VEX). Running it on every merge would be waste and noise.
 *
 * The seam exists now, while it is nearly free. Retrofitting it into a monolithic
 * review later would be painful, and the `type` argument is in the MCP surface
 * from day one because adding a required argument afterwards breaks every client.
 *
 * SPEC: D-43, research/security-review.md §4
 */

import { UsageError } from "./errors.ts";
import { DEFAULT_TIERS, type Tier } from "./ladder.ts";

/** A deterministic engine run at T0. Names are resolved by the T0 runner. */
export type T0Engine = "tsc" | "eslint" | "ast-grep" | "semgrep" | "tests" | "sbom" | "osv";

export interface ReviewType {
  readonly id: string;
  readonly description: string;
  readonly t0: readonly T0Engine[];
  readonly tiers: readonly Tier[];
  /** What the model tiers are being asked to judge. Shapes the prompts. */
  readonly question: string;
}

export const CODE_ARCH: ReviewType = {
  id: "code-arch",
  description: "Correctness and design of a prepared merge, judged against its ticket and specs.",
  t0: ["tsc", "eslint", "ast-grep", "semgrep", "tests"],
  tiers: DEFAULT_TIERS,
  question:
    "Is this change correct, well-made, and the change that was actually asked for?",
};

/**
 * SBOM → OSV → semgrep, then the model tiers judge **reachability**.
 *
 * The scanners do the detection; a scanner cannot say whether your code ever
 * reaches the vulnerable path, and that judgement is where both the noise and the
 * value live. Output is real CycloneDX VEX (`security/vex.ts`), because the
 * justification ledger and a VEX statement turned out to be the same object.
 */
export const SECURITY: ReviewType = {
  id: "security",
  description: "Known-vulnerable dependencies and weaknesses, and whether they are reachable.",
  t0: ["sbom", "osv", "semgrep"],
  tiers: DEFAULT_TIERS,
  question:
    "What known-vulnerable code are we shipping, and can it actually be reached from this application?",
};

const REGISTRY: ReadonlyMap<string, ReviewType> = new Map([
  [CODE_ARCH.id, CODE_ARCH],
  [SECURITY.id, SECURITY],
]);

export const DEFAULT_TYPE = CODE_ARCH.id;

export function reviewType(id: string = DEFAULT_TYPE): ReviewType {
  const found = REGISTRY.get(id);
  if (found === undefined) {
    throw new UsageError(`unknown review type '${id}' — known: ${[...REGISTRY.keys()].join(", ")}`);
  }
  return found;
}

export function reviewTypeIds(): readonly string[] {
  return [...REGISTRY.keys()];
}
