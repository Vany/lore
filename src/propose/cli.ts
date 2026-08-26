/**
 * `lore propose` — the CLI surface, and the only place this tool touches the world.
 *
 * The CLI and not MCP, per `spec/propose.md` §8: the output is a document a person
 * appraises, and writing a client contract for output nobody has judged yet is
 * premature. MCP is one wrapper away once it has earned it.
 *
 * Everything money-related is in `run.ts`; everything here is resolving what to think
 * about and writing down what came back. The two jobs are separate because the second
 * is what makes a run auditable weeks later, and it must not be able to fail quietly.
 *
 * SPEC: spec/propose.md §1, §6
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DidNotRun, UsageError } from "../core/errors.ts";
import { reviewType } from "../core/review-type.ts";
import { git } from "../git/exec.ts";
import { removeWorktree, repoPaths, worktreeFor } from "../git/repo.ts";
import type { Reviewer } from "../reviewer/opencode.ts";
import { NO_LIMIT, type Store } from "../store/store.ts";
import { isLens, LENSES, type Lens } from "./proposal.ts";
import { renderProposals } from "./render.ts";
import { propose } from "./run.ts";

export interface ProposeCliInput {
  readonly store: Store;
  readonly reviewer: Pick<Reviewer, "askFor">;
  readonly reposRoot: string;
  readonly repo: string;
  readonly budget: number;
  readonly folder: string;
  readonly commit: string;
  readonly mode: string;
  readonly lenses: readonly Lens[];
  readonly outDir: string;
  /** Passed in so a run is reproducible against its own document. */
  readonly now: Date;
}

/** `--lens a,b,c`, or every lens. An unknown name is a usage error, never ignored. */
export function parseLenses(raw: string | undefined): readonly Lens[] {
  if (raw === undefined) return LENSES;
  const names = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const bad = names.filter((n) => !isLens(n));
  if (bad.length > 0) {
    throw new UsageError(`unknown lens(es): ${bad.join(", ")} — known: ${LENSES.join(", ")}`);
  }
  // Deduplicated — found by lore's own review, fingerprint 268bd330: `--lens
  // seams,seams` ran the identical prompt twice, paying for a proposer and a critic on
  // one vantage while an unknown name (an equally-plausible typo) was already refused.
  return [...new Set(names)] as Lens[];
}

/** `--budget` in model sessions. Required, so the spend is chosen rather than discovered. */
export function parseBudget(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < 1) {
    throw new UsageError(
      "--budget <n> is required and must be a whole number of MODEL SESSIONS (proposers and critics both " +
        "count). It is required rather than defaulted because a run of this can empty a rolling subscription " +
        "window, and an exhausted window stalls every review in the system.",
    );
  }
  return n;
}

/**
 * The first name in `dir` starting with `base` that nothing already occupies.
 *
 * Found missing by lore's own review, fingerprint 41c8217a: the document's name is
 * date+sha+folder only, so two runs sharing all three — different `--mode`, a
 * different `--lens` subset, or just a second look — collided on one path, and the
 * second `writeFile` silently destroyed the first, exactly the loss the folder-in-name
 * fix (above, on `slug`) was written to prevent one axis over. Rather than growing the
 * name to encode every parameter that could ever distinguish two runs — a list with no
 * natural end — this refuses to overwrite ANYTHING, for ANY reason: the sessions are
 * already paid for by the time this runs, so the document must always land somewhere,
 * never be silently replaced, and never be refused outright either (a hard refusal
 * here would lose paid-for work just as surely as an overwrite does).
 */
export async function freePath(dir: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? `${base}.md` : `${base}-${String(n)}.md`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
}

export async function proposeCli(i: ProposeCliInput): Promise<string> {
  const repo = i.store.repoByNameOrId(i.repo);
  if (repo === undefined) {
    const known = i.store.repos().map((r) => r.name).join(", ");
    throw new UsageError(`no repository '${i.repo}' — known: ${known || "none; run `lore new` first"}`);
  }
  const repoId = repo.id;
  const paths = repoPaths(i.reposRoot, repoId);

  // The same cut a review takes (D-65), so a stale mirror refuses here too: thinking
  // hard about a tree from three hours ago is worse than not thinking, because the
  // output looks exactly as confident.
  // The FOLDER is in the id, not just the clock. Eleven folders started in the same
  // second would otherwise collide on one worktree, and the collision is silent: git
  // hands the second caller the first caller's checkout.
  const slug = (i.folder || "root").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const id = `propose_${slug}_${i.now.toISOString().replace(/[^0-9]/g, "")}`;
  const worktree = await worktreeFor(paths, id, i.commit, repo.gitUrl);
  try {
    // The RESOLVED SHA. `master` means something different next week, and this document
    // is read weeks later by someone reconstructing what was actually looked at.
    const sha = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();

    const type = reviewType(i.mode);
    const result = await propose(
      { store: i.store, repoId, ask: i.reviewer.askFor.bind(i.reviewer) },
      {
        lenses: i.lenses,
        folder: i.folder,
        commit: sha,
        worktree,
        question: type.question,
        tiers: type.tiers,
        budget: i.budget,
        // NO_LIMIT, not the ordinary 200-row cap — found by lore's own review,
        // fingerprint 499b6cb8/f0592391. The screen's whole job is matching against
        // EVERY decided-against row (screen.ts's `rejected` filter); a capped, newest-
        // first read silently drops the OLDEST ones on a repo past the cap, and an
        // early "considered and rejected" row falls out of the screen's memory exactly
        // like `conflict detection` needed NO_LIMIT for (store.ts, lore-ok aa57c0f2) —
        // both need every row to be correct, not merely representative.
        knowledge: i.store.knowledgeFor(repoId, undefined, NO_LIMIT),
      },
    );

    const doc = renderProposals(
      {
        repo: repo["name"] ?? i.repo,
        commit: sha,
        folder: i.folder,
        mode: type.id,
        lenses: i.lenses,
        budget: i.budget,
        sessionsSpent: result.sessionsSpent,
        at: i.now.toISOString(),
      },
      result.screened,
      result.silent,
    );

    // WRITTEN BEFORE ANYTHING ELSE CAN FAIL. The sessions are already paid for by this
    // point, and a run that spent eight deep sessions and then died formatting a path
    // would have burned a subscription window for nothing.
    await mkdir(i.outDir, { recursive: true });
    // The folder belongs in the NAME. A per-folder sweep shares one commit and one
    // date, so without it every run overwrites the last and ten of eleven documents
    // are lost — after they were paid for.
    //
    // lore-ok[9c6f2a60]: found by lore's own review — this function trusts `i.outDir`
    // as given rather than anchoring it itself, and that is correct: `ProposeCliInput`
    // (above) declares it required, with no local default to get wrong. The default
    // this finding is really about — a CWD-relative path when nothing was passed —
    // is resolved by the caller, `src/cli.ts`'s own argv wiring (`outDir: flagOf(argv,
    // "out") ?? join(dataDir(), "proposals")`), outside this folder's review scope.
    //
    // NEVER OVERWRITTEN — see `freePath`'s own docs (fingerprint 41c8217a) for why a
    // second run sharing this exact date+sha+folder gets a `-2` suffix instead of
    // destroying the first run's paid-for document.
    const path = await freePath(i.outDir, `${i.now.toISOString().slice(0, 10)}-${sha.slice(0, 7)}-${slug}`);
    await writeFile(path, doc, "utf8");

    if (result.sessionsSpent === 0) {
      // Exit 70, not 0: nothing ran, and a document saying "nothing to change" would be
      // indistinguishable from one produced by a tool that never asked (INV-1).
      throw new DidNotRun(
        `no model session ran, so nothing was thought about. ${result.silent.join("; ") || "no lens was selected"}. ` +
          `The (empty) document is at ${path}.`,
      );
    }
    return path;
  } finally {
    // The worktree is a throwaway. Left behind, a folder-scoped run per week fills the
    // disk with trees nothing will ever look at again — and unlike a review's, nothing
    // sweeps these, because no review row exists to age out.
    await removeWorktree(paths, id).catch(() => undefined);
  }
}
