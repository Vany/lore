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
import { NO_LIMIT, type Store } from "../store/store.ts";
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
   * lore-ok[c5df90ef,65528bcd,4f4c52a5]: found real by lore's own review — bootstrap
   * runs from the worktree of the repo's first review, exactly the shape `53969ab8`
   * closed for every ordinary round, and this call site kept reading the branch under
   * review regardless. Resolved and passed to `ingestDocs` as `ref` the same
   * three-way split `review.ts`'s diff-mode round uses: OMITTED reads the worktree
   * (no base exists to defend against — D-130 folder mode's first review); PRESENT
   * AND RESOLVABLE reads at that ref; PRESENT AND UNRESOLVABLE defers the WHOLE
   * bootstrap — document ingest AND the architecture survey — rather than falling
   * back to the worktree read (the fallback this fix exists to refuse) or letting the
   * survey alone satisfy worker.ts's one-shot retry guard, which asks only "is there
   * any knowledge yet" and cannot tell a clean bootstrap from a half one. A repo this
   * happens to gets retried whole on its next review, at no extra cost — bootstrap
   * only ever spends anything once regardless.
   */
  intoRef?: string | undefined;
  /**
   * The FIRST review's own id, and whether it is still wanted — so its screen and
   * survey sessions are registered and `review_cancel` can actually reach them.
   *
   * lore-ok[96ce9a48]: found real by lore's own review, against spec/knowledge.md
   * §2.2's own words: "still true of the provisioning screen, and of any future
   * inline caller" — bootstrap was never updated to say so. Without `reviewId`, a
   * screen session is never registered, so a client cancelling mid-bootstrap is told
   * truthfully that nothing is in flight while the screen and survey go on spending
   * — the exact failure §2.2 names and the exact fix `review.ts`'s round already
   * applies to its own tier call, mirrored here for both of bootstrap's model calls.
   */
  reviewId?: string;
  stillWanted?: () => boolean;
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
        // lore-ok[96ce9a48]: `reviewId`/`stillWanted` WERE omitted — found by lore's
        // own review against spec/knowledge.md §2.2's explicit requirement ("still
        // true of the provisioning screen"). Bootstrap DOES run inside a review (the
        // repo's first one — `worker.ts` has the id in hand), so there is exactly as
        // much for a cancel to reach here as there is for the round's own tier call;
        // omitting them meant a client cancelling mid-bootstrap was told truthfully
        // that nothing was in flight while the screen — "the largest single burst of
        // screen calls the system ever makes" — went on spending regardless.
        screen: screenFor(ask, tier, opts.worktree, {
          reviewId: opts.reviewId,
          stillWanted: opts.stillWanted,
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
  let deferred = false;
  if (opts.intoRef === undefined) {
    docs = await ingestDocs(opts.store, opts.repoId, opts.worktree, { ...screenOpt });
  } else {
    const into = await resolveInto(opts.worktree, opts.intoRef);
    if (into !== undefined) docs = await ingestDocs(opts.store, opts.repoId, opts.worktree, { ...screenOpt, ref: into });
    else deferred = true;
  }

  // lore-ok[4f4c52a5]: found real by lore's own review, on the tree carrying the
  // 65528bcd fix — that version skipped only the DOCUMENT half on an unresolvable
  // ref, but the architecture survey below has no such gate and would still write
  // `fact` rows. worker.ts's one-shot retry guard is "is this repo's knowledge
  // empty", not "did bootstrap's document ingest succeed" — one fact row satisfies
  // it just as well as ten document rules do, so a transient resolution failure
  // (mirror mid-refresh, the one case `resolveInto` actually fails on) would have
  // let the survey run, made the guard permanently false, and left this repo's
  // CLAUDE.md/PROG.md/ADRs un-ingested by bootstrap for the rest of its life — a
  // partial, inconsistent seed is worse than retrying the whole thing next review,
  // which costs nothing since bootstrap only spends anything once anyway.
  if (deferred) {
    return { documents: 0, rulesFromDocs: 0, factsFromCode: 0, conflicts: 0 };
  }

  let factsFromCode = 0;
  if (opts.reviewer !== undefined) {
    if (tier !== undefined) {
      // lore-ok[70b88761]: DELIBERATELY reads `opts.worktree` (the branch under
      // review), not `into` — found by lore's own review, which is right that a
      // branch could plant a plausible-but-false architecture comment here for the
      // survey to launder into a trusted `fact`. Not fixed the way `ingestDocs` was:
      // Vany's call was to keep the survey reading the branch (checking out `into`
      // separately is a real new operational cost; skipping the survey whenever
      // `into` exists would silently disable it for the common diff-mode case) and
      // instead stop the resulting facts from being presented as settled — see
      // `knowledgeBlock` in reviewer/prompts.ts, which now renders `kind: "fact"`
      // under an explicit "unverified, not a team decision" caveat rather than
      // folding it into "treat these as this team's decisions."
      // lore-ok[96ce9a48]: `reviewId`/`stillWanted` WERE omitted here too — same
      // finding and fix as the screen a few lines up: spec/knowledge.md §2.2 requires
      // a cancel to reach a screen session started by a review, and the survey is the
      // OTHER model call bootstrap makes inside that same review.
      const result = await opts.reviewer.review(tier, ARCHITECTURE_PROMPT, opts.worktree, opts.reviewId, opts.stillWanted);
      // lore-ok[4bbccb96,0b9f6b3a]: found real by lore's own review, TWICE — this loop
      // had no idempotence guard at all, unlike `ingestDocs`' rule-writes a few lines
      // above (`store.hasKnowledgeBlob` re-checked INSIDE a transaction). worker.ts's
      // one-shot check ("is this repo's knowledge empty") is check-then-act, and the
      // dispatcher starts every claimed round at once (D-101, no pool) — so two
      // reviews submitted for one fresh repo within the same few minutes (this
      // deployment's own target is 30/day) can BOTH pass that check before either
      // commits, both run the survey, and both write every fact with a fresh id.
      // Facts have no retirement path (spec/knowledge.md §4), so a doubled write is
      // permanent, not a one-round blip.
      //
      // The FIRST fix re-checked "is this repo's knowledge empty" — the same question
      // worker.ts asks — which was wrong for a reason obvious only once named: THIS
      // SAME bootstrap call's own `ingestDocs`, a few lines above, already wrote live
      // `rule` rows for any repo with rule documents at all — the ordinary case, not
      // an edge one. So the re-check saw non-empty knowledge from ITS OWN prior write
      // and silently discarded every survey fact, on every repo whose documents
      // yielded a rule, after the model call was already paid for. Scoped to
      // `kind === "fact"` now — the only question that distinguishes "a concurrent
      // bootstrap already wrote facts" from "my own ingest just wrote rules", which is
      // the one this guard actually needs answered. `NO_LIMIT` because this is exactly
      // the kind of check aa57c0f2 named: correctness needs to see every row, not a
      // capped, recency-ordered sample that could miss a fact for an unrelated reason.
      //
      // Re-asked INSIDE the transaction, same shape as `ingestDocs`: the MODEL CALL
      // above this line can still double-spend under a genuine race (recomputing it
      // inside a transaction is not possible — it is an async network call), but the
      // WRITE — the part that compounds forever — is guarded, matching the risk this
      // codebase already accepts for the screen call one function above.
      opts.store.tx(() => {
        if (opts.store.knowledgeFor(opts.repoId, undefined, NO_LIMIT).some((k) => k.kind === "fact")) return;
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
      });
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
