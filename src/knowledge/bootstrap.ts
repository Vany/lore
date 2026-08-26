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
import { concreteRoute, loadHelper, loadPools } from "../core/ladder.ts";
import { DEFAULT_TIERS, type Tier } from "../core/ladder.ts";
import { resolveInto } from "../git/diff.ts";
import type { ReviewerLike } from "../reviewer/opencode.ts";
import type { Store } from "../store/store.ts";
import { detectAndRecord } from "./conflict.ts";
import { ingestDocs, type IngestResult } from "./ingest.ts";
import { screenFor, screenUsage } from "./screen.ts";

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
  /**
   * The FIRST review's own `into`, when it has one (D-130 folder mode does not).
   *
   * lore-ok[c5df90ef,65528bcd]: found real by lore's own review — bootstrap runs from
   * the worktree of the repo's first review, exactly the shape `53969ab8` closed for
   * every ordinary round, and this call site kept reading the branch under review
   * regardless. Resolved and passed to `ingestDocs` as `ref` the same three-way split
   * `review.ts`'s diff-mode round uses: OMITTED reads the worktree (no base exists to
   * defend against — D-130 folder mode's first review); PRESENT AND RESOLVABLE reads
   * at that ref; PRESENT AND UNRESOLVABLE skips document ingestion for this call
   * rather than falling back to the worktree, which is the fallback this fix exists
   * to refuse. The second and third cases look identical from the caller's side —
   * both start from a defined `intoRef` — which is exactly why they were folded
   * together by mistake the first time this was written.
   */
  intoRef?: string | undefined;
}): Promise<BootstrapResult> {
  // The cheap tier. This is a survey, not a judgement — paying the top tier to
  // describe a directory structure would be the same mistake as paying a model
  // to run a typechecker. Resolved before the ingest because the screen wants it too.
  // THE HELPER MODEL, when the deployment names one. Surveying a repository is not
  // reviewing it, and borrowing the first model TIER put this work in front of the gate
  // tier's own subscription — the seat every review's first round runs on. Absent, this
  // borrows t1 exactly as it always did.
  const helper = loadHelper();
  const named = opts.tier
    ?? (helper === undefined ? undefined : { id: "helper", kind: "model" as const, model: helper, stage: "fast" as const })
    ?? DEFAULT_TIERS.find((t) => t.kind === "model") ?? DEFAULT_TIERS[1];
  // A nickname resolved to a route that can pay, for the same reason the screen does it:
  // `tier.model` may name a pool, and opencode refuses a pool name as a model id. An
  // unresolvable tier bootstraps without a model — survey skipped, ingest still runs —
  // which is the behaviour a missing tier always had here.
  //
  // lore-ok[8d47c789]: `known` is `store.routeUnavailable`, was `() => undefined` —
  // found by lore's own review, against `screening.ts`'s identical call a few lines
  // away in spirit, which already passes the real check. `() => undefined` told
  // `concreteRoute` nothing is ever parked, so a quota-parked route in a multi-route
  // pool could be picked here exactly as readily as a working one; the survey then
  // throws on it, `worker.ts`'s catch swallows the throw, and because ingest already
  // ran and left the knowledge base non-empty, the ONE-SHOT retry guard
  // (`knowledgeFor(...).length === 0`) never fires again — a resolvable tier, killed
  // by which of its routes got picked, permanently.
  const route = named === undefined ? undefined : concreteRoute(named, loadPools(), (m) => opts.store.routeUnavailable(m));
  const tier = named === undefined || route === undefined ? undefined : { ...named, model: route };
  const ask = opts.reviewer?.askFor?.bind(opts.reviewer);

  // Screened HERE too, rather than left for the next review to redo. This is the first
  // review of a repository, so it is the ingest that writes the whole base — leaving it
  // unscreened would mean the first review, the one with no other memory to fall back
  // on, is the one that reads the fragments. Without a reviewer it ingests unscreened
  // and stamped, which is the documented no-model path (D-81).
  const screenOpt = ask === undefined || tier === undefined
    ? {}
    : {
        // No `reviewId`: provisioning has no review, so there is nothing for a cancel
        // to reach and nothing to attribute the spend to beyond the repository. It is
        // recorded all the same — bootstrap screens every document a repo has, which is
        // the largest single burst of screen calls the system ever makes.
        screen: screenFor(ask, tier, opts.worktree, {
          spent: (u) => opts.store.recordUsage(screenUsage(u, opts.repoId)),
        }),
      };

  // lore-ok[65528bcd]: found real by lore's own review, on the tree carrying the
  // c5df90ef fix this replaces — that version resolved `intoRef` and then folded
  // "genuinely absent" and "present but unresolvable" into the SAME branch (no `ref`
  // passed either way), which reads the worktree for both. My own comment claimed
  // "not silently", which was false: nothing distinguished the two, and nothing
  // logged the fallback. review.ts's diff-mode round draws this same three-way split
  // and its comment says exactly why the unresolvable case must not fall back to the
  // worktree read — that fallback IS the hole `53969ab8`/`c5df90ef` closed, reopened
  // by an unrelated resolution failure on the one call this repo only ever gets once.
  let docs: IngestResult = { documents: 0, added: 0, retired: 0, screenedOut: 0, unscreened: 0 };
  if (opts.intoRef === undefined) {
    docs = await ingestDocs(opts.store, opts.repoId, opts.worktree, { ...screenOpt });
  } else {
    const into = await resolveInto(opts.worktree, opts.intoRef);
    if (into !== undefined) docs = await ingestDocs(opts.store, opts.repoId, opts.worktree, { ...screenOpt, ref: into });
  }

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
