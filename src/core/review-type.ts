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
import { loadTiers, type Tier } from "./ladder.ts";

/** A deterministic engine run at T0. Names are resolved by the T0 runner. */
/**
 * A deterministic engine run at T0.
 *
 * `tests` is not one, and was (D-71). lore READS a test suite — whether the change is
 * covered, whether a test asserts what its name claims — and never runs it. A suite
 * that fails belongs to whoever owns the repository; discovering that is CI's job, and
 * running it here means executing an arbitrary dependency tree on the review host for
 * a result its owner already has.
 */
export type T0Engine = "tsc" | "eslint" | "ast-grep" | "semgrep" | "sbom" | "osv";

export interface ReviewType {
  readonly id: string;
  readonly description: string;
  readonly t0: readonly T0Engine[];
  /**
   * LAZY — a getter, not a plain field. Found by lore's own review, fingerprint
   * 61df6e72: `CODE_ARCH`/`SECURITY` are module-level `const`s, so a plain
   * `tiers: loadTiers()` field ran at IMPORT TIME — before `serve()`'s own body,
   * before `configFromEnv()`, before any of the graceful-degradation fixes this
   * same investigation added (board.ts, status.ts's `tierDownLines`, the two
   * `service/main.ts` timers) ever got a chance to run. A bad LORE_TIERS crashed
   * the whole process the moment ANYTHING imported this module — which for a real
   * service is immediately, pre-empting every later fix. A getter defers the read
   * to first ACTUAL use: the process can now reach `serve()`'s own body, `/status`
   * and the board can still answer (they never read `ReviewType.tiers` at all),
   * and only a genuine attempt to run a review — which cannot proceed without a
   * valid ladder regardless — hits the error, inside a context that already
   * catches it (an MCP tool call, a round) rather than an uncatchable module load.
   * Every existing reader (`type.tiers`, `rt.tiers`) needed no change: a getter is
   * indistinguishable from a plain property to the code reading it.
   */
  readonly tiers: readonly Tier[];
  /** What the model tiers are being asked to judge. Shapes the prompts. */
  readonly question: string;
}

export const CODE_ARCH: ReviewType = {
  id: "code-arch",
  description: "Correctness and design of a prepared merge, judged against its ticket and specs.",
  t0: ["tsc", "eslint", "ast-grep", "semgrep"],
  get tiers() {
    return loadTiers();
  },
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
  get tiers() {
    return loadTiers();
  },
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
