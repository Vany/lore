/**
 * The run: proposer, then a critic from a different vendor, then the screen.
 *
 * This is the only file here that spends money, so it is the one carrying the bounds —
 * revised 2026-08-13, and this comment used to describe the ORIGINAL design rather than
 * this one, found stale by lore's own review, fingerprint dc35ec0e: it kept claiming a
 * refusal and a throttle this file no longer has, 130 lines above the code saying so.
 * From `spec/propose.md` §7:
 *
 *   * **It does NOT refuse while a review is queued or running**, and did until Vany —
 *     waiting on exactly that refusal — overruled it. The original fear was real: the
 *     largest t2 review sent 203,904 cached tokens, and eight such sessions could empty
 *     a rolling subscription window, stalling every review in the system. What changed
 *     under it: a tier's quota is now a POOL of subscriptions with a fallback chain
 *     (D-93), so a burst here degrades a review to its next route rather than to
 *     nothing, and D-98 removed every other queue of this kind on the same argument —
 *     backpressure belongs at the door, not as an invisible wait that could leave this
 *     never running on a busy day.
 *   * **`--budget` is counted in sessions and is required**, and is now the ONLY bound
 *     on this path. The spend is chosen rather than discovered, and proposers and
 *     critics both count: a critic is a paid session and pretending otherwise would
 *     double the real cost of a stated budget.
 *   * **It is NOT throttled — since D-98, nothing stops it bursting** past the provider
 *     ceiling that killed four reviews in 2.5 minutes. `--budget` is what bounds it now,
 *     which is why it is required rather than defaulted.
 *   * **Usage is recorded per session**, so what it cost is answerable afterwards
 *     rather than estimated.
 *
 * SPEC: spec/propose.md §2, §7
 */

import type { Tier } from "../core/ladder.ts";
import { concreteRoute, loadPools, noRouteBecause, routesFor, type ModelPools } from "../core/ladder.ts";
import { DidNotRun } from "../core/errors.ts";
import { vendorOf } from "../core/ladder.ts";
import type { Listed, SessionResult } from "../reviewer/opencode.ts";
import { extractList } from "../reviewer/opencode.ts";
import type { KnowledgeItem, Store } from "../store/store.ts";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { criticPrompt, PROPOSAL_CONTRACT, proposerPrompt, type LensInput } from "./lens.ts";
import { parseProposal, type Lens, type Proposal, type Screened } from "./proposal.ts";
import { screen } from "./screen.ts";

/** Proposals in the shape a session returns them. */
const proposalsOf = (text: string): Listed<Proposal> =>
  extractList<Proposal>(text, "proposals", (raw) => {
    const r = parseProposal(raw);
    return "rejected" in r ? r : r;
  });

export interface ProposeDeps {
  readonly store: Store;
  readonly repoId: string;
  /** Same gate, same retry, same abort — `Reviewer.askFor`. */
  readonly ask: <T>(
    tier: Tier,
    prompt: string,
    worktree: string,
    extract: (text: string) => Listed<T>,
    contract: string,
  ) => Promise<SessionResult<T>>;
}

export interface ProposeInput {
  readonly lenses: readonly Lens[];
  readonly folder: string;
  /** The resolved SHA, never the ref — the document has to be reconstructable. */
  readonly commit: string;
  readonly worktree: string;
  readonly question: string;
  /** Model tiers available, cheapest first. Proposer and critic must differ by VENDOR. */
  readonly tiers: readonly Tier[];
  readonly budget: number;
  readonly knowledge: readonly KnowledgeItem[];
}

export interface ProposeResult {
  readonly screened: readonly Screened[];
  /** Sessions that SUCCEEDED — what `proposeCli`'s "nothing was thought about" check needs. */
  readonly sessionsSpent: number;
  /**
   * Sessions ATTEMPTED — successes and failures together, which is the true spend
   * against `--budget` (a failed call is still a paid one, fingerprint b1030112) and
   * what the document's own header reports. Kept separate from `sessionsSpent`
   * because that field answers a different question — did ANYTHING succeed — and a
   * run where every attempt failed must still report zero there.
   */
  readonly sessionsAttempted: number;
  /** Lenses that produced nothing, and why — never silently absent from the document. */
  readonly silent: readonly string[];
}

/**
 * What this repository already knows, so an idea it has had is not offered as new.
 *
 * lore-ok[77edbad4]: found real by lore's own review — this is a SECOND, independent
 * copy of `reviewer/prompts.ts`'s `knowledgeBlock`, and it carried the same bug
 * 70b88761/652bb58d fixed there: a bootstrap-derived `kind: "fact"` row (a model's own
 * unconfirmed reading of one branch's code) was rendered under the same "already
 * knows about itself" framing as a taught rule, with no caveat. For propose
 * specifically, an unverified planted claim can suppress or bias exactly the ideas
 * this feature exists to generate. Split the same way: facts get their own,
 * explicitly unverified block.
 */
function knowledgeBlock(items: readonly KnowledgeItem[]): string {
  if (items.length === 0) return "";
  const line = (k: KnowledgeItem): string => `  [${k.source}] ${k.statement}${k.why === undefined ? "" : ` — because ${k.why}`}`;
  const facts = items.filter((k) => k.kind === "fact");
  const rest = items.filter((k) => k.kind !== "fact");

  const parts: string[] = [];
  if (rest.length > 0) {
    parts.push(
      "",
      "WHAT THIS CODEBASE ALREADY KNOWS ABOUT ITSELF",
      "An idea it has already had is not a new idea. Read these before you decide what to say.",
      ...rest.slice(0, 60).map(line),
    );
  }
  if (facts.length > 0) {
    parts.push(
      "",
      "UNVERIFIED, FROM ONE BRANCH'S FIRST READING",
      "A model's own reading of this repository, taken once, on whichever branch got reviewed first — not" +
        " confirmed by anything since. Weigh it accordingly.",
      ...facts.slice(0, 60).map(line),
    );
  }
  return parts.join("\n");
}

/**
 * Every tier that could stand as critic — a different VENDOR than the proposer, not
 * merely a different tier (D-1, applied to ideas). Two tiers from one model family is
 * one opinion asked twice, which is the same argument that keeps Claude out of the
 * review ladder. In LADDER ORDER, ranked cheapest first exactly as `tiers` is passed.
 *
 * Empty when no other vendor is configured at all — and then the proposal runs
 * UNCRITICISED and says so, rather than being graded by a sibling and presented as
 * though it had been challenged. A NON-EMPTY list is not a promise a critic will run:
 * the caller (`propose`, below) still has to find one with a usable ROUTE, and used to
 * stop at the first name regardless — fixed for fingerprint b56c6982, see the caller.
 */
export function criticFor(tiers: readonly Tier[], proposer: Tier, pools: ModelPools = {}): readonly Tier[] {
  // THROUGH THE POOLS, because `vendorOf` on a nickname compares the nickname itself —
  // "GLM5.2" is not in the alias table, so a pooled t1 would count as its own vendor and
  // could be handed a critic from the same company. Any route of a pool carries the
  // pool's vendor: the config refuses a pool that mixes models.
  const vend = (t: Tier): string => vendorOf(routesFor(t, pools)[0] ?? t.model ?? "");
  const mine = vend(proposer);
  return tiers.filter((t) => t.kind === "model" && t.model !== undefined && vend(t) !== mine);
}

/**
 * A failed call is still a paid one — record what it burned before it died.
 *
 * `Reviewer.askFor` recovers spend from a session that fails mid-exploration and
 * attaches it to the thrown error as `.spent` (never `this` — a shared instance field
 * would cross-attribute concurrent rounds' spend); `reviewer/review.ts` already reads
 * it back this same way.
 *
 * lore-ok[b1030112]: found missing here by lore's own review — this file's own header
 * claims "usage is recorded per session, so what it cost is answerable afterwards" as
 * one of propose's stated money bounds, and it was false on exactly the path where the
 * spend is real and highest — measured 2026-08-09, two 45-minute failed attempts
 * against an exhausted plan that the trailing-usage read as zero. This function is the
 * fix; both call sites are below, in the proposer's and the critic's catch blocks.
 */
function recordFailedUsage(store: Store, repoId: string, tier: string, model: string | undefined, e: unknown): void {
  const spent = (e as { spent?: { input: number; cached: number; output: number; cost: number } }).spent;
  if (spent === undefined) return;
  store.recordUsage({
    repoId,
    tier,
    ...(model === undefined ? {} : { model }),
    inputTokens: spent.input,
    cachedTokens: spent.cached,
    outputTokens: spent.output,
    costUsd: spent.cost,
    // The row says the call did NOT succeed, so a reader cannot mistake recovered
    // spend for a completed proposal or critique.
    outcome: "failed",
  });
}

/**
 * Matches `knowledgeFor`'s own segment-boundary comparison (store.ts) and
 * `scopesOverlap`'s (knowledge/conflict.ts) — both require an EXACT, `/`-clean path,
 * the same normalization `knowledge_teach` applies to a taught one (`mcp/server.ts`'s
 * `normalizeReviewPath`, not imported here since propose has no business depending on
 * the MCP surface for a two-line stdlib call). A model names `touches` in whatever
 * form it likes — `./src/store/store.ts`, `src/store/`, or a leading `/` — and any of
 * those, stored verbatim, creates a row no path-scoped consumer can ever find. Found
 * by lore's own review, fingerprint 790271a9.
 */
export function normalizedTouchPath(p: string): string | undefined {
  const n = posix.normalize(p).replace(/^\/+/, "").replace(/\/+$/, "");
  return n === "" || n === "." ? undefined : n;
}

/**
 * The narrowest path that covers every touch — found by lore's own review,
 * fingerprint 50a98db3: 0318670f fixed the READ side (screen.ts now respects a row's
 * own `k.path`), but the WRITE side only ever set one for the single-touch case,
 * falling back to repo-wide (`undefined`) for two or more — the MODAL case, since an
 * idea that moves a seam necessarily touches both sides of it (§1.1) — reproducing the
 * exact cross-folder leakage 0318670f fixed, for the common shape rather than the rare
 * one. A shared ancestor directory is still a real, useful scope: it cannot match a
 * future proposal that lands entirely outside it, which is the property that matters.
 * Single-touch behaviour is unchanged — this is a strict generalisation of it.
 */
export function commonScope(touches: readonly string[]): string | undefined {
  const normalized = touches.map(normalizedTouchPath).filter((p): p is string => p !== undefined);
  const first = normalized[0];
  if (first === undefined) return undefined;
  const segLists = normalized.map((p) => p.split("/"));
  const firstSegs = first.split("/");
  let i = 0;
  while (i < firstSegs.length && segLists.every((s) => s[i] === firstSegs[i])) i++;
  return i === 0 ? undefined : firstSegs.slice(0, i).join("/");
}

/**
 * Whatever `propose` itself is certain enough to reject is written back so the next
 * sweep does not pay to have the same idea again (spec/propose.md §6). Two triggers,
 * both decided by `propose` within its own run, needing no person's later verdict on a
 * SURVIVING idea — which this tool has no way to learn, being fire-and-forget:
 *
 *   * the screen's own `out-of-scope` demotion (screen.ts) — dropped outright, never
 *     shown for appraisal. A fact about where the change lands, not a judgment call.
 *   * the critic's own structured `rejects` (proposal.ts) — never prose alone. `idea`
 *     can already say "this is wrong" in passing without meaning it as a verdict, and
 *     this file has no business parsing tone to find out which.
 *
 * Idempotent by provenance, the same guard `promoteRecurring` (knowledge/derive.ts)
 * uses for the same reason: re-running this must not re-arm a lesson a person later
 * resolved away (`hasKnowledgeFrom`'s own docs, store.ts, explain why checking LIVE
 * rows only would silently undo that). Keyed by folder+commit+lens rather than the
 * idea's own text — model prose is not stable across runs, so a text key would not
 * catch the case this actually guards: `propose` invoked twice over the same tree. A
 * later sweep on a different commit legitimately writes its own row even if the idea
 * reads the same; `screen`'s own `restates` match (screen.ts) is what keeps THAT from
 * costing the reader anything, by demoting it `already-decided` in the document rather
 * than by suppressing the write.
 *
 * `statement`'s prefix is not just wording — found by lore's own review, fingerprint
 * a90601f4. `knowledge/conflict.ts`'s `detectAndRecord` runs at the start of every
 * review round over EVERY live row, this repo's included, and pairs opposite-polarity,
 * high-overlap statements as a candidate contradiction. `"considered: <idea>"` carries
 * the IDEA'S OWN polarity — a proposer arguing to split something the codebase was
 * TAUGHT never to split writes a `+1`-polarity row beside a `-1`-polarity taught rule
 * that agrees with the rejection, and the heuristic reads two rows that AGREE as a
 * contradiction, parking the next review at `needs_human` over nothing. Verified
 * directly against `polarity()`: "considered and reject: <idea>" scores 0 (undecidable
 * — the prefix alone splits into a `+1` clause and a `-1` clause on `and`, before the
 * idea's own words are even read) for every idea tried, including ones that are
 * themselves all-negation. `findConflicts` skips polarity-0 rows entirely, which is
 * this file's own documented bias: "a missed conflict leaves two rules to be caught
 * later, while a false one stops a review and demands a person."
 */
function writeBackRejections(store: Store, repoId: string, folder: string, commit: string, screened: readonly Screened[]): void {
  for (const s of screened) {
    const outOfScope = s.demotions.includes("out-of-scope");
    const criticRejects = s.proposal.rejects === true;
    if (!outOfScope && !criticRejects) continue;

    const provenance = `propose:${folder}:${commit}:${s.proposal.lens}`;
    if (store.hasKnowledgeFrom(repoId, provenance)) continue;

    const reasons = [
      outOfScope
        ? (s.because[s.demotions.indexOf("out-of-scope")] ?? "it landed outside the folder asked about")
        : undefined,
      criticRejects ? "the critic judged it simply wrong" : undefined,
    ].filter((r): r is string => r !== undefined);

    store.addKnowledge({
      repoId,
      kind: "mistake",
      source: "derived",
      statement: `considered and reject: ${s.proposal.idea}`,
      why: reasons.join("; "),
      path: commonScope(s.proposal.touches),
      cwe: undefined,
      provenance,
      sourceBlob: undefined,
      // Machine-checked scope is a fact; a critic's verdict is a judgment call, and
      // this codebase already reserves 1 for what a person typed (knowledge_teach).
      confidence: outOfScope ? 1 : 0.7,
    });
  }
}

/**
 * The proposer's own idea, annotated for the reader — never carrying a critic verdict
 * it cannot have earned. `rejects` is the critic's field alone (proposal.ts); every
 * path that lands here pushes the PROPOSER's own object because no critic verdict
 * exists to prefer, and spreading it through unstripped let a proposer's own
 * `rejects: true` — nothing stops one from setting it, PROPOSAL_CONTRACT shows the
 * field on every call it sends, proposer and critic alike — get written back to the
 * knowledge base attributed to a critic that never ran. Found by lore's own review,
 * fingerprint 9c49fc0a. `exactOptionalPropertyTypes` is why this destructures `rejects`
 * out rather than spreading `{ ...idea, rejects: undefined }`: the field is declared
 * `boolean | undefined`-that-must-be-OMITTED, not one that accepts an explicit
 * `undefined`.
 */
function uncriticised(idea: Proposal, why: string): Proposal {
  const { rejects: _proposerRejects, ...rest } = idea;
  return { ...rest, contradictedBy: `${idea.contradictedBy} — ${why}` };
}

export async function propose(deps: ProposeDeps, input: ProposeInput): Promise<ProposeResult> {
  // lore-ok[9b633abb]: found by lore's own review, fixed here rather than left as a
  // guaranteed-waste run — nothing checked `--folder` existed in the tree at all. A
  // typo (`src/stroe` for `src/store`) does not fail loud on its own: `inScope`
  // demotes EVERY proposal out-of-scope, since nothing genuinely lands inside a folder
  // that is not there, and the whole budget burns on lenses that produce ideas nobody
  // will ever see. Worse since `writeBackRejections` (below) started existing:
  // out-of-scope is one of its two triggers, so the typo would also write one
  // confidence-1 `mistake` row per lens, each falsely marking a genuinely good idea
  // "considered and rejected" forever — the SAME failure the stale-mirror refusal
  // (spec/propose.md §1.2) already exists to prevent one axis over (the commit, not
  // the folder). `""`/`"."` mean the repository root (inScope's own convention) and
  // need no check.
  if (input.folder !== "" && input.folder !== ".") {
    const folderPath = join(input.worktree, input.folder);
    // lore-ok[48d3e092]: found by lore's own review — the ORIGINAL guard only checked
    // SOMETHING existed at `folderPath`, and `--folder ../lib` (or `--folder ..`)
    // resolves to the worktree's OWN PARENT, which always exists on a real checkout —
    // passing straight through to reproduce the exact guaranteed-waste-plus-poisoning
    // run this guard exists to refuse, since `inScope` can never match a repo-relative
    // `touches` entry against a path outside the tree either. `relative` is how Node
    // itself answers "is B inside A" — a leading `..` (or an absolute result, the
    // cross-device case `relative` returns instead) means it escaped.
    const rel = relative(input.worktree, folderPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new DidNotRun(`--folder ${input.folder} is outside the tree at commit ${input.commit} — it must name a directory inside the repository, not above it.`);
    }
    if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
      throw new DidNotRun(
        `--folder ${input.folder} does not exist at commit ${input.commit} — check the spelling. A typo here ` +
          "would not fail loud on its own: every proposal would land outside it, the whole budget would be " +
          "spent on ideas nobody sees, and each one would be written back as a false permanent rejection.",
      );
    }
  }

  // THIS USED TO REFUSE WHILE ANY REVIEW WAS IN FLIGHT, and does not since 2026-08-13 —
  // Vany's call, made while waiting on exactly that refusal. The rule was written when
  // one exhausted window stalled every review in the system; since then a tier's quota
  // is a POOL of subscriptions with a fallback chain behind it (D-93), so a burst here
  // degrades a review to its next route rather than to nothing — and D-98 already
  // removed every other queue of this kind on the same argument: backpressure belongs
  // at the door, not in an invisible wait. What bounds this run is `--budget`, which is
  // required so the spend is chosen rather than discovered.
  const models = input.tiers.filter((t) => t.kind === "model" && t.model !== undefined);
  const namedProposer = models[models.length - 1];
  if (namedProposer === undefined) throw new DidNotRun("no model tier is configured, so there is nothing to ask");
  // Resolved for the same reason the screen resolves: a pool name is not a model id, and
  // this path fails LOUD when nothing can pay — a proposal is somebody waiting at a CLI.
  //
  // lore-ok[5b72aabd]: found by lore's own review — `() => undefined` used to throw
  // away the store's own learned route-unavailability state (`store.routeUnavailable`,
  // the same signal `review.ts`'s `withQuota` calls read throughout), so this could
  // pick a route a REVIEW parked as exhausted minutes ago, wasting a proposer session
  // on a call already known dead before this run even started.
  //
  // lore-ok[77431767]: found by lore's own review, against the fix just above — this
  // comment used to also claim a route THIS run watches fail is "not immediately
  // retried against the next lens," which does not hold: this line resolves the
  // proposer's route ONCE, before the lens loop (below), and reuses it for every lens
  // regardless of a mid-run failure; `propose` never calls `markRouteUnavailable`
  // itself, only reads what a REVIEW already wrote. Deliberately not closed: writing
  // to that key from here risks propose misclassifying a transient failure and wrongly
  // parking a route the shared review system could still use, and the existing
  // `--budget` ceiling already bounds the cost of a dead route being retried — wasted
  // attempts, not a runaway.
  const known = (m: string) => deps.store.routeUnavailable(m);
  const proposerRoute = concreteRoute(namedProposer, loadPools(), known);
  if (proposerRoute === undefined) {
    // The same sentence the screen uses, from the same place: a person at a CLI told
    // "out of quota" when a toggle is the constraint waits for the wrong thing.
    throw new DidNotRun(`${noRouteBecause(namedProposer, loadPools(), known) ?? "no route"} — nothing can propose`);
  }
  const proposer = { ...namedProposer, model: proposerRoute };

  const screenedAll: Proposal[] = [];
  const silent: string[] = [];
  let sessionsSpent = 0;
  /**
   * Sessions ATTEMPTED, which is what the ceiling is about — and, since fingerprint
   * 7429b981, what the document's own header reports as spent against `--budget` too.
   *
   * `sessionsSpent` counts successes only and answers a DIFFERENT question — did
   * anything succeed at all, which `proposeCli`'s "nothing was thought about" refusal
   * needs unchanged. Enforcing the budget with `sessionsSpent` was a guard whose
   * silence was ambiguous: a session that creates an opencode session, sends a prompt,
   * burns tokens and then throws never incremented it — so a run where every call
   * failed never tripped the ceiling and attempted every lens anyway. The operator's
   * stated budget did not exist on the failure path.
   *
   * Found by `propose` reading its own folder on its first real run. The document
   * header used `sessionsSpent` for the same reason and inherited the same gap: a run
   * with real, paid failures reported a FRACTION of what it actually spent against the
   * budget the operator chose it for — found by lore's own review, fingerprint
   * 7429b981, fixed by reporting THIS count instead (`sessionsAttempted`, ProposeResult).
   */
  let attempted = 0;

  for (const lens of input.lenses) {
    // Budget is in SESSIONS and a critic is a session. Checked before each, so a run
    // stops between lenses rather than half-way through one.
    if (attempted + 1 > input.budget) {
      silent.push(`${lens}: not run — the budget of ${String(input.budget)} session(s) was already spent`);
      continue;
    }

    const base: LensInput = {
      lens,
      folder: input.folder,
      commit: input.commit,
      worktree: input.worktree,
      question: input.question,
      knowledge: knowledgeBlock(input.knowledge),
    };

    let idea: Proposal | undefined;
    let rejected: readonly string[] = [];
    try {
      attempted++;
      const r = await deps.ask(proposer, proposerPrompt(base), input.worktree, proposalsOf, PROPOSAL_CONTRACT);
      sessionsSpent++;
      deps.store.recordUsage({
        repoId: deps.repoId,
        tier: `propose:${lens}`,
        ...(proposer.model === undefined ? {} : { model: proposer.model }),
        inputTokens: r.inputTokens,
        cachedTokens: r.cachedTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
        latencyMs: r.latencyMs,
        ...(r.steps === undefined ? {} : { steps: r.steps }),
        outcome: r.items.length > 0 ? "findings" : "clean",
      });
      idea = r.items[0];
      rejected = r.rejected;
    } catch (e) {
      recordFailedUsage(deps.store, deps.repoId, `propose:${lens}`, proposer.model, e);
      // A lens that could not run is NEVER simply absent from the document. That is
      // INV-1's shape: a vantage that did not look must not read as a vantage that saw
      // nothing worth changing.
      silent.push(`${lens}: did not run — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (idea === undefined) {
      // lore-ok[e1a18243]: found by lore's own review — a reply whose proposals were
      // ALL schema-refused (parseProposal, proposal.ts) used to read exactly like a
      // proposer that genuinely looked and had nothing to say, even though
      // PROPOSAL_CONTRACT's blessing of `"proposals": []` covers only the second case.
      // `SessionResult.rejected` (reviewer/opencode.ts) is how reviewer/review.ts
      // already tells these apart for findings (`agg.discarded`, surfaced via
      // `checks_skipped`); this is the same distinction, applied here.
      silent.push(
        rejected.length > 0
          ? `${lens}: replied, but nothing parsed — ${rejected.join("; ")}`
          : `${lens}: looked and would change nothing here`,
      );
      continue;
    }

    const criticCandidates = criticFor(models, namedProposer, loadPools());
    // TRIES EVERY CROSS-VENDOR TIER, not just the ladder-cheapest one — found by lore's
    // own review, fingerprint b56c6982: the cheapest tier being parked on quota backoff
    // is this deployment's ROUTINE state (D-93's own pool-and-fallback design exists
    // because of exactly that), and stopping at the first name meant every proposal ran
    // uncriticised whenever it happened, even with a second, healthy vendor configured
    // and unused. Resolved exactly as the proposer was — a pool name is not a model id,
    // and the same store-backed `known` (fingerprint 5b72aabd, above — see 77431767's
    // correction there too: this reads what a REVIEW already marked, not anything this
    // run's own failures teach it, since `propose` never writes that key itself).
    let critic: (Tier & { model: string }) | undefined;
    const criticRefusals: string[] = [];
    for (const candidate of criticCandidates) {
      const route = concreteRoute(candidate, loadPools(), known);
      if (route !== undefined) {
        critic = { ...candidate, model: route };
        break;
      }
      criticRefusals.push(noRouteBecause(candidate, loadPools(), known) ?? `${candidate.id}: its routes are unusable`);
    }
    if (critic === undefined || attempted + 1 > input.budget) {
      // UNCRITICISED, and it says so on the proposal rather than in a footnote. A
      // reader who believes a second vendor challenged this when none did is exactly
      // who §9 is about.
      //
      // WHY it is uncriticised, though, must not be guessed: "no second vendor is
      // configured" is false when one IS configured and the metered gate refused it, and
      // it sends the reader to edit a tiers file when the remedy is a toggle. The same
      // wrong-reason class as the proposer path above, one branch over.
      screenedAll.push(
        uncriticised(
          idea,
          `NOT CRITICISED: ${
            critic === undefined
              ? criticCandidates.length === 0
                ? "no second vendor is configured, so this is one model's unchallenged opinion"
                : `${criticRefusals.join("; ")}, so this is one model's unchallenged opinion`
              : "the budget ran out before a critic could read it"
          }`,
        ),
      );
      continue;
    }

    try {
      attempted++;
      const c = await deps.ask(
        critic,
        criticPrompt(base, JSON.stringify(idea, null, 2)),
        input.worktree,
        proposalsOf,
        PROPOSAL_CONTRACT,
      );
      sessionsSpent++;
      deps.store.recordUsage({
        repoId: deps.repoId,
        tier: `propose-critic:${lens}`,
        ...(critic.model === undefined ? {} : { model: critic.model }),
        inputTokens: c.inputTokens,
        cachedTokens: c.cachedTokens,
        outputTokens: c.outputTokens,
        costUsd: c.costUsd,
        latencyMs: c.latencyMs,
        ...(c.steps === undefined ? {} : { steps: c.steps }),
        outcome: c.items.length > 0 ? "findings" : "clean",
      });
      // The CRITIC'S version is what the document carries: it read the code with the
      // idea in hand, which the proposer could not. A critic that returned nothing is
      // a critic that declined to endorse, and the proposer's own words go through
      // with that said.
      //
      // lore-ok[84cf95be,006cfc04]: found by lore's own review — e1a18243's fix
      // covered the proposer's own `idea === undefined` branch and not this one, which
      // said "returned nothing" even when the critic replied and parsing refused every
      // item (`c.rejected`, same field, same reason it is not an endorsement either
      // way — but the STATED reason was false).
      screenedAll.push(
        c.items[0] ??
          uncriticised(
            idea,
            c.rejected.length > 0
              ? `the critic (${critic.id}) replied, but nothing parsed — ${c.rejected.join("; ")} — which is not an endorsement`
              : `the critic (${critic.id}) read this and returned nothing, which is not an endorsement`,
          ),
      );
    } catch (e) {
      recordFailedUsage(deps.store, deps.repoId, `propose-critic:${lens}`, critic.model, e);
      screenedAll.push(
        uncriticised(idea, `NOT CRITICISED: the critic (${critic.id}) failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  // Checked against the worktree that was actually read, not against the repository as
  // it stands now — the proposals describe that tree and nothing else.
  //
  // lore-ok[85623b0c]: the claim that a leading slash makes `join` discard `worktree`
  // (behaving like `resolve`) does not hold — verified directly: `join("/wt",
  // "/src/store/store.ts")` returns `/wt/src/store/store.ts`, not `/src/store/store.ts`.
  // `path.join` concatenates every argument and normalises the result; only
  // `path.resolve` treats a later absolute segment as replacing what came before it.
  // A leading `/` on a named path is therefore inert here — `p` and `/${p}` resolve to
  // the same file inside `worktree` either way — so there is no host-filesystem escape
  // and no mismatch with `inScope`'s own leading-slash stripping (proposal.ts), which
  // exists for a different reason (matching a path against `folder` as plain text, not
  // resolving anything).
  // A glob (`src/store/*.ts`) reads as "does not exist" under a literal `existsSync` —
  // lore-ok[bdd42529]: found by lore's own review — the screen then drops it
  // out-of-scope with the false reason "names only files that do not exist", and
  // writeBackRejections (above) turns that false fact into a confidence-1 permanent
  // knowledge row. Globbing the tree to check properly is more machinery than this
  // sanity check is worth; treating a glob-shaped name as present is the same bias the
  // rest of this screen already has — a missed "invented path" costs a reader nothing,
  // a false one costs the idea itself (proposal.ts's own `invented-paths` docs).
  const looksLikeGlob = (p: string): boolean => /[*?[\]{}]/.test(p);
  const exists = (p: string): boolean => looksLikeGlob(p) || existsSync(join(input.worktree, p));
  const screened = screen(screenedAll, input.folder, input.knowledge, exists);
  writeBackRejections(deps.store, deps.repoId, input.folder, input.commit, screened);
  return { screened, sessionsSpent, sessionsAttempted: attempted, silent };
}
