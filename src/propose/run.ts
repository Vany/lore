/**
 * The run: proposer, then a critic from a different vendor, then the screen.
 *
 * This is the only file here that spends money, so it is the one carrying the bounds.
 * From `spec/propose.md` §7, and none of them are precautionary — each has an incident
 * behind it:
 *
 *   * **It refuses to start while any review is queued or running.** A whole-repo
 *     question has no diff to anchor exploration, so a proposer session costs at least
 *     what the largest t2 review did — 203,904 cached tokens against a 30-minute
 *     ceiling. Eight of those empties a rolling subscription window, and an exhausted
 *     window stalls *every review in the system*. Reviews are the product; this is
 *     inspiration.
 *   * **`--budget` is counted in sessions and is required**, so the spend is chosen
 *     rather than discovered. Proposers and critics both count: a critic is a paid
 *     session and pretending otherwise would double the real cost of a stated budget.
 *   * **It runs through the same model gate as reviews**, so it cannot burst past the
 *     provider ceiling that killed four reviews in 2.5 minutes.
 *   * **Usage is recorded per session**, so what it cost is answerable afterwards
 *     rather than estimated.
 *
 * SPEC: spec/propose.md §2, §7
 */

import type { Tier } from "../core/ladder.ts";
import { concreteRoute, loadPools, routesFor, type ModelPools } from "../core/ladder.ts";
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

/** What this repository already knows, so an idea it has had is not offered as new. */
function knowledgeBlock(items: readonly KnowledgeItem[]): string {
  if (items.length === 0) return "";
  return [
    "",
    "WHAT THIS CODEBASE ALREADY KNOWS ABOUT ITSELF",
    "An idea it has already had is not a new idea. Read these before you decide what to say.",
    ...items.slice(0, 60).map((k) => `  [${k.source}] ${k.statement}${k.why === undefined ? "" : ` — because ${k.why}`}`),
  ].join("\n");
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

export async function propose(deps: ProposeDeps, input: ProposeInput): Promise<ProposeResult> {
  // BEFORE ANYTHING IS SPENT. A review already queued is work someone is waiting on;
  // this is not.
  const busy = deps.store.reviewsInFlight();
  if (busy.length > 0) {
    throw new DidNotRun(
      `refusing to start: ${String(busy.length)} review(s) are still running — ` +
        `${busy.map((r) => `${r.id} (${r.branch})`).join(", ")}. ` +
        "Reviews are the product and this is inspiration; a proposer session costs what a deep review costs " +
        "and would compete for the same provider window. Wait for them, then run this again.",
    );
  }

  const models = input.tiers.filter((t) => t.kind === "model" && t.model !== undefined);
  const namedProposer = models[models.length - 1];
  if (namedProposer === undefined) throw new DidNotRun("no model tier is configured, so there is nothing to ask");
  // Resolved for the same reason the screen resolves: a pool name is not a model id, and
  // this path fails LOUD when nothing can pay — a proposal is somebody waiting at a CLI.
  const proposerRoute = concreteRoute(namedProposer, loadPools(), () => undefined);
  if (proposerRoute === undefined) {
    throw new DidNotRun(`every route to ${namedProposer.model ?? "?"} is out of quota — nothing can propose`);
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
      screenedAll.push({
        ...idea,
        contradictedBy: `${idea.contradictedBy} — NOT CRITICISED: ${
          critic === undefined
            ? "no second vendor is configured, so this is one model's unchallenged opinion"
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
  const exists = (p: string): boolean => existsSync(join(input.worktree, p));
  return { screened: screen(screenedAll, input.folder, input.knowledge, exists), sessionsSpent, silent };
}
