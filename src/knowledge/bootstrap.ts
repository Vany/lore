/**
 * Bootstrap: give a repo a memory before its first review.
 *
 * On day one the knowledge base is empty, so the first reviews are the dumbest this
 * repo will ever get — and at 30 PRs a day, "the first few weeks" is a lot of
 * reviews to spend learning what `PROG.md` already says out loud.
 *
 * Two passes with different costs. Document ingestion is deterministic and free, so
 * it runs at provisioning and again whenever a document changes. The architecture
 * pass costs a model call and runs **once**, at provisioning only.
 *
 * SPEC: D-35, spec/knowledge.md §2
 */

import { CLAIM_MAX } from "../core/finding.ts";
import { DEFAULT_TIERS, type Tier } from "../core/ladder.ts";
import type { ReviewerLike } from "../reviewer/opencode.ts";
import type { Store } from "../store/store.ts";
import { detectAndRecord } from "./conflict.ts";
import { ingestDocs } from "./ingest.ts";
import { screenFor } from "./screen.ts";

export interface BootstrapResult {
  readonly documents: number;
  readonly rulesFromDocs: number;
  readonly factsFromCode: number;
  readonly conflicts: number;
}

const ARCHITECTURE_PROMPT = `
You are recording what a new engineer would need to know about this codebase before
changing it. You are NOT reviewing it — do not report defects, and do not suggest
improvements.

Read the repository: its entry points, its module boundaries, its data model, and the
invariants its code relies on but does not state.

Record only what is (a) true, (b) non-obvious from a single file, and (c) still true
next month. Skip anything a reader would learn from the directory listing.

Reply with ONE fenced json block and nothing else:

\`\`\`json
{"findings": [
  {
    "file": "src/pay/hold.ts",
    "severity": "low",
    "claim": "the fact, in one sentence, max ${CLAIM_MAX} characters",
    "evidence": "where in the code this is visible",
    "failureScenario": "what breaks if someone changes code without knowing this"
  }
]}
\`\`\`

Use "findings" for the list even though these are facts, not defects — it is the
schema this tool speaks. Twenty good facts are worth more than a hundred shallow
ones.
`.trim();

export async function bootstrap(opts: {
  store: Store;
  repoId: string;
  worktree: string;
  /** Omit to ingest documents only — no model call, no cost. */
  reviewer?: ReviewerLike;
  tier?: Tier;
}): Promise<BootstrapResult> {
  // The cheap tier. This is a survey, not a judgement — paying the top tier to
  // describe a directory structure would be the same mistake as paying a model
  // to run a typechecker. Resolved before the ingest because the screen wants it too.
  const tier = opts.tier ?? DEFAULT_TIERS.find((t) => t.kind === "model") ?? DEFAULT_TIERS[1];
  const ask = opts.reviewer?.askFor?.bind(opts.reviewer);

  // Screened HERE too, rather than left for the next review to redo. This is the first
  // review of a repository, so it is the ingest that writes the whole base — leaving it
  // unscreened would mean the first review, the one with no other memory to fall back
  // on, is the one that reads the fragments. Without a reviewer it ingests unscreened
  // and stamped, which is the documented no-model path (D-81).
  const docs = await ingestDocs(opts.store, opts.repoId, opts.worktree, {
    ...(ask === undefined || tier === undefined ? {} : { screen: screenFor(ask, tier, opts.worktree) }),
  });

  let factsFromCode = 0;
  if (opts.reviewer !== undefined) {
    if (tier !== undefined) {
      const result = await opts.reviewer.review(tier, ARCHITECTURE_PROMPT, opts.worktree);
      for (const f of result.findings) {
        opts.store.addKnowledge({
          repoId: opts.repoId,
          kind: "fact",
          source: "derived",
          statement: f.claim,
          why: f.failureScenario,
          path: f.file,
          ...(f.cwe !== undefined ? { cwe: f.cwe } : { cwe: undefined }),
          provenance: `bootstrap:${f.file}`,
          sourceBlob: undefined,
          // Lowest confidence in the store: one model's reading of a codebase it
          // met a minute ago, unconfirmed by anything. Real reviews will correct it.
          confidence: 0.5,
        });
        factsFromCode++;
      }
    }
  }

  const conflicts = detectAndRecord(opts.store, opts.repoId);

  return {
    documents: docs.documents,
    rulesFromDocs: docs.added,
    factsFromCode,
    conflicts: conflicts.recorded,
  };
}
