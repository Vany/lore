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
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  readonly sessionsSpent: number;
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
 * The critic must be a different VENDOR, not merely a different tier (D-1, applied to
 * ideas). Two tiers from one model family is one opinion asked twice, which is the same
 * argument that keeps Claude out of the review ladder.
 *
 * `undefined` when no other vendor is configured — and then the proposal runs UNCRITICISED
 * and says so, rather than being graded by a sibling and presented as though it had been
 * challenged.
 */
export function criticFor(tiers: readonly Tier[], proposer: Tier, pools: ModelPools = {}): Tier | undefined {
  // THROUGH THE POOLS, because `vendorOf` on a nickname compares the nickname itself —
  // "GLM5.2" is not in the alias table, so a pooled t1 would count as its own vendor and
  // could be handed a critic from the same company. Any route of a pool carries the
  // pool's vendor: the config refuses a pool that mixes models.
  const vend = (t: Tier): string => vendorOf(routesFor(t, pools)[0] ?? t.model ?? "");
  const mine = vend(proposer);
  return tiers.find((t) => t.kind === "model" && t.model !== undefined && vend(t) !== mine);
}

/**
 * A failed call is still a paid one — record what it burned before it died.
 *
 * `Reviewer.askFor` recovers spend from a session that fails mid-exploration and
 * attaches it to the thrown error as `.spent` (never `this` — a shared instance field
 * would cross-attribute concurrent rounds' spend); `reviewer/review.ts` already reads
 * it back this same way. Found missing here by lore's own review, fingerprint
 * b1030112: this file's own header claims "usage is recorded per session, so what it
 * cost is answerable afterwards" as one of propose's stated money bounds, and it was
 * false on exactly the path where the spend is real and highest — measured
 * 2026-08-09, two 45-minute failed attempts against an exhausted plan that the
 * trailing-usage read as zero.
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
      statement: `considered: ${s.proposal.idea}`,
      why: reasons.join("; "),
      path: s.proposal.touches.length === 1 ? s.proposal.touches[0] : undefined,
      cwe: undefined,
      provenance,
      sourceBlob: undefined,
      // Machine-checked scope is a fact; a critic's verdict is a judgment call, and
      // this codebase already reserves 1 for what a person typed (knowledge_teach).
      confidence: outOfScope ? 1 : 0.7,
    });
  }
}

export async function propose(deps: ProposeDeps, input: ProposeInput): Promise<ProposeResult> {
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
  const proposerRoute = concreteRoute(namedProposer, loadPools(), () => undefined);
  if (proposerRoute === undefined) {
    // The same sentence the screen uses, from the same place: a person at a CLI told
    // "out of quota" when a toggle is the constraint waits for the wrong thing.
    throw new DidNotRun(`${noRouteBecause(namedProposer, loadPools(), () => undefined) ?? "no route"} — nothing can propose`);
  }
  const proposer = { ...namedProposer, model: proposerRoute };

  const screenedAll: Proposal[] = [];
  const silent: string[] = [];
  let sessionsSpent = 0;
  /**
   * Sessions ATTEMPTED, which is what the ceiling is about.
   *
   * `sessionsSpent` counts successes and is what the document reports. Enforcing the
   * budget with it was a guard whose silence was ambiguous: a session that creates an
   * opencode session, sends a prompt, burns tokens and then throws never incremented
   * it — so a run where every call failed never tripped the ceiling and attempted every
   * lens anyway. The operator's stated budget did not exist on the failure path.
   *
   * Found by `propose` reading its own folder on its first real run.
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
    } catch (e) {
      recordFailedUsage(deps.store, deps.repoId, `propose:${lens}`, proposer.model, e);
      // A lens that could not run is NEVER simply absent from the document. That is
      // INV-1's shape: a vantage that did not look must not read as a vantage that saw
      // nothing worth changing.
      silent.push(`${lens}: did not run — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (idea === undefined) {
      silent.push(`${lens}: looked and would change nothing here`);
      continue;
    }

    const namedCritic = criticFor(models, namedProposer, loadPools());
    // Resolved exactly as the proposer was — a pool name is not a model id.
    const criticRoute = namedCritic === undefined ? undefined : concreteRoute(namedCritic, loadPools(), () => undefined);
    const critic = namedCritic === undefined || criticRoute === undefined ? undefined : { ...namedCritic, model: criticRoute };
    if (critic === undefined || attempted + 1 > input.budget) {
      // UNCRITICISED, and it says so on the proposal rather than in a footnote. A
      // reader who believes a second vendor challenged this when none did is exactly
      // who §9 is about.
      //
      // WHY it is uncriticised, though, must not be guessed: "no second vendor is
      // configured" is false when one IS configured and the metered gate refused it, and
      // it sends the reader to edit a tiers file when the remedy is a toggle. The same
      // wrong-reason class as the proposer path above, one branch over.
      screenedAll.push({
        ...idea,
        contradictedBy: `${idea.contradictedBy} — NOT CRITICISED: ${
          critic === undefined
            ? namedCritic === undefined
              ? "no second vendor is configured, so this is one model's unchallenged opinion"
              : `${noRouteBecause(namedCritic, loadPools(), () => undefined) ?? "its routes are unusable"}, so this is one model's unchallenged opinion`
            : "the budget ran out before a critic could read it"
        }`,
      });
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
      screenedAll.push(
        c.items[0] ?? {
          ...idea,
          contradictedBy: `${idea.contradictedBy} — the critic (${critic.id}) read this and returned nothing, which is not an endorsement`,
        },
      );
    } catch (e) {
      recordFailedUsage(deps.store, deps.repoId, `propose-critic:${lens}`, critic.model, e);
      screenedAll.push({
        ...idea,
        contradictedBy: `${idea.contradictedBy} — NOT CRITICISED: the critic (${critic.id}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
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
  const exists = (p: string): boolean => existsSync(join(input.worktree, p));
  const screened = screen(screenedAll, input.folder, input.knowledge, exists);
  writeBackRejections(deps.store, deps.repoId, input.folder, input.commit, screened);
  return { screened, sessionsSpent, silent };
}
