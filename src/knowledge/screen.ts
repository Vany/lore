/**
 * A model's veto over what the extractor mined.
 *
 * **This is the one place a model is paid for what a rule could not decide**, and the
 * module beside it says extraction is deterministic on purpose. That still holds for
 * EXTRACTION: what is mined out of a document is a pure function of the document, runs
 * free on every change, and gives the same answer twice. What is added here is a
 * refusal, and only a refusal.
 *
 * The reason it had to be a model is measured rather than argued. Three successive
 * deterministic narrowings — bullets-and-single-sentences, dangling-referent and
 * mid-sentence guards, then lead-in and label rejections — each cut the count hard and
 * each landed at the same place: **about a fifth of what survives is not a rule.**
 *
 *   | reader                                   | rules | not rules |
 *   | ---------------------------------------- | ----: | --------: |
 *   | every declarative sentence (the original)|   423 |      ~90% |
 *   | shape test (`2`)                          |    61 |      ~20% |
 *   | + lead-in, label and gerund refusals      |    51 |      ~18% |
 *
 * The residue is not a pattern a regex can name. *"Cost. A conversation re-sends its
 * accumulated context every turn"* and *"Handles are CSPRNG-generated, never
 * sequential"* differ by what the words MEAN, and every rule that could separate them
 * also refused real rules — the strictest variant tried dropped `CLAUDE.md` entirely,
 * because its bullets lead with an unmodalised summary. Twenty per cent matters because
 * of where it lands: up to sixty of these go into every review prompt under *"treat
 * these as this team's decisions"*, so a fragment is not noise in a file, it is a
 * confident instruction to a reviewer reading someone's branch.
 *
 * **Three properties keep the non-determinism bounded**, and each answers an objection
 * the deterministic rule was right to make:
 *
 *   * **It only ever removes.** It never rewrites a statement, never invents one, and
 *     never reorders. The knowledge base is still a function of the documents; the
 *     model chooses a subset of it.
 *   * **A refusal is recorded, not silent.** Every rejected candidate is written as a
 *     knowledge row that is born retired, carrying the model's reason. *"Why is this
 *     rule not in the base"* stays answerable, which is the whole objection to a
 *     filter: a rule that never arrives is invisible to everyone for ever.
 *   * **It fails open and says so.** A screen that cannot run keeps every candidate and
 *     stamps the rows unscreened, so the next ingest retires and re-screens them. It
 *     never blocks a review on a classifier, and it never silently keeps the junk
 *     for ever either — which are the two ways this could have gone wrong quietly.
 *
 * SPEC: spec/knowledge.md §2.1.2
 */

import type { Tier } from "../core/ladder.ts";
import { extractList, type Listed, type SessionResult } from "../reviewer/opencode.ts";
import type { Candidate, Screen, Screened } from "./ingest.ts";

/**
 * Ask for the ones to THROW AWAY, never the ones to keep.
 *
 * A model asked to list what survives drops items it simply did not get to, and every
 * such omission silently deletes a rule. Asked to list what fails, an omission keeps
 * one — the error the module can afford. The asymmetry is the same one `screen.ts` in
 * `propose/` makes for the same reason, and it is the reason this can be a single
 * batched call at all.
 */
const KEY = "not_rules";

const CONTRACT = `Reply with ONE fenced JSON block and nothing that must be read outside it:

\`\`\`json
{"${KEY}": [{"n": 4, "because": "refers to 'that formula', which is not in the statement"}]}
\`\`\`

\`n\` is the number as printed below. \`because\` is one short clause naming what is
missing — it is stored and read by a person asking why a rule is absent.
An empty array is a valid and common answer. List ONLY the ones that fail.`;

/**
 * The statements are numbered, and the numbering is the whole protocol.
 *
 * Sent as text rather than JSON: these are prose statements full of quotes, backticks
 * and em-dashes, and a model asked to echo them back has a hundred chances to alter one.
 * It echoes an integer instead.
 */
export function screenPrompt(doc: string, candidates: readonly Candidate[]): string {
  const numbered = candidates.map((c, i) => `${String(i + 1)}. ${c.statement}`).join("\n");
  return `A deterministic extractor pulled the statements below out of \`${doc}\` in this repository.

Each one will be shown to a code reviewer ALONE, with no surrounding text and no link
back to the document, under the heading:

    WHAT THIS CODEBASE ALREADY KNOWS ABOUT ITSELF — treat these as this team's decisions

Say which of them are NOT rules when read that way. A statement fails when:

  * it points at something that is not in it — "that formula", "The distinction", "An
    empty one", "it" with no antecedent. The reader will bind it to whatever they happen
    to be looking at.
  * it is a topic label or a lead-in to a list that did not come with it — "Cost.",
    "Two tests gate reporting at all, and both must pass".
  * it recounts what happened once instead of saying what to do — "A reviewer ran it
    against a dead port — 0 steps seen, cap never tripped".
  * it is text quoted from somewhere else that the document was describing rather than
    asserting — a prompt, another tool's output, a rejected alternative.

A statement does NOT fail for being terse, for opening on a code span or a flag, for
naming a decision id like D-71, or for stating something you disagree with. Those are
how this team writes rules.

KEEP ANYTHING YOU ARE UNSURE ABOUT. A rule wrongly dropped is invisible to everyone for
ever and cannot be recovered by reading the document again. A fragment that survives is
legible as noise and costs one line. The errors are not symmetrical, so do not balance them.

${numbered}

${CONTRACT}`;
}

/** One refusal as the model stated it, before it is matched back to a candidate. */
interface Refused {
  readonly n: number;
  readonly because: string;
}

function refusedOf(raw: unknown, _index: number, _total: number): Refused | { readonly rejected: string } {
  const r = raw as Record<string, unknown> | null;
  const n = r?.["n"];
  const because = r?.["because"];
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    return { rejected: `\`n\` must be the printed integer, got ${JSON.stringify(n)}` };
  }
  return { n, because: typeof because === "string" && because.trim() !== "" ? because.trim() : "not a rule read alone" };
}

/**
 * What `screenFor` needs of a reviewer: `askFor`, narrowed to this one item type.
 *
 * Narrowed rather than taking the whole `ReviewerLike`, so a test can be a two-line
 * function and nothing here can quietly start using `review()` to spend a round.
 */
export type Ask = (
  tier: Tier,
  prompt: string,
  worktree: string,
  extract: (text: string) => Listed<Refused>,
  contract: string,
) => Promise<SessionResult<Refused>>;

/**
 * Where a screen session's cost is recorded.
 *
 * These were the only model calls in the system with no `usage` row. The type here used
 * to be narrowed to `{items}` — tidy, and it discarded the tokens and the latency, so
 * D-81's own cost claim ("one t1 call per document") could not be checked against
 * anything, `ops/spend` under-reported by a whole class of call, and a cheap-tier screen
 * that decided to go exploring the worktree would burn minutes of quota leaving no trace.
 * A tier is billed the same whoever asked it.
 */
export interface ScreenUsage {
  readonly tier: string;
  readonly model: string | undefined;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly steps: number | undefined;
  readonly refused: number;
}

/**
 * A screen session as the `usage` table wants it.
 *
 * Written here, once, rather than at each of the two call sites — the round and the
 * bootstrap both screen, and two hand-written copies of a field mapping is the shape
 * `PROG.md` names outright: one thing defined twice always disagrees eventually.
 *
 * The tier is prefixed `screen:` so these rows count against SPEND but stay out of the
 * per-tier latency distribution `check_back_after_ms` reads. A screen session is not a
 * review round and pooling them would tell a waiting client to expect a four-second
 * answer from a tier that takes ten minutes.
 */
export function screenUsage(u: ScreenUsage, repoId: string, reviewId?: string): {
  readonly repoId: string;
  readonly reviewId?: string;
  readonly tier: string;
  readonly model?: string;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly steps?: number;
  readonly outcome: string;
} {
  return {
    repoId,
    ...(reviewId === undefined ? {} : { reviewId }),
    tier: u.tier,
    ...(u.model === undefined ? {} : { model: u.model }),
    inputTokens: u.inputTokens,
    cachedTokens: u.cachedTokens,
    outputTokens: u.outputTokens,
    costUsd: u.costUsd,
    latencyMs: u.latencyMs,
    ...(u.steps === undefined ? {} : { steps: u.steps }),
    outcome: u.refused > 0 ? "findings" : "clean",
  };
}

/**
 * Bind a screen to a tier and a worktree.
 *
 * The CHEAPEST model tier, deliberately. This is a classification with the evidence
 * already in the prompt — no repository to explore, no code to reason about — and
 * spending a deep tier on it would take quota from the thing that actually reads
 * branches. It runs once per document per re-ingest, which for this repository is
 * eleven calls after a reader change and one after an edit.
 *
 * `spent` is handed every completed session's cost. It is a callback rather than a Store
 * because this module has no business knowing about one, and because the caller is the
 * only thing that knows which repository is being ingested.
 */
export function screenFor(ask: Ask, tier: Tier, worktree: string, spent?: (u: ScreenUsage) => void): Screen {
  return async (doc, candidates) => {
    if (candidates.length === 0) return { kept: [], refused: [], ran: true };

    try {
      const result = await ask(
        tier,
        screenPrompt(doc, candidates),
        worktree,
        (text) => extractList<Refused>(text, KEY, refusedOf),
        CONTRACT,
      );
      const out = partition(candidates, result.items);
      // Recorded on the way past, before anything can throw on the result. A session
      // that completed cost what it cost whatever we then decide about its answer.
      spent?.({
        tier: `screen:${tier.id}`,
        model: tier.model,
        inputTokens: result.inputTokens,
        cachedTokens: result.cachedTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        steps: result.steps,
        refused: out.refused.length,
      });
      return out;
    } catch (e) {
      // FAILS OPEN, AND THE CALLER STAMPS THE ROWS SO IT HEALS. A quota refusal, a dead
      // provider or an unparseable reply must not empty a repository's memory — the
      // knowledge base is the product, and a review running without it is worth less
      // than a review running with a fifth of its rules being fragments. `ran: false`
      // is what makes this recoverable rather than a silent downgrade.
      console.error(`[lore:log] knowledge screen did not run for ${doc}: ${e instanceof Error ? e.message : String(e)}`);
      return { kept: candidates, refused: [], ran: false };
    }
  };
}

/**
 * Split the candidates on what came back.
 *
 * An index outside the printed range is DISCARDED rather than clamped: a model that
 * answered about item 40 of a 12-item list was not answering about this list, and
 * guessing which one it meant would drop a real rule on the strength of a typo.
 */
export function partition(candidates: readonly Candidate[], refusals: readonly Refused[]): Screened {
  const because = new Map<number, string>();
  for (const r of refusals) {
    if (r.n > candidates.length) continue;
    because.set(r.n - 1, r.because);
  }
  const kept: Candidate[] = [];
  const refused: { statement: string; because: string }[] = [];
  for (const [i, c] of candidates.entries()) {
    const why = because.get(i);
    if (why === undefined) kept.push(c);
    else refused.push({ statement: c.statement, because: why });
  }
  return { kept, refused, ran: true };
}
