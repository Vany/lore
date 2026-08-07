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

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DidNotRun, UsageError } from "../core/errors.ts";
import { reviewType } from "../core/review-type.ts";
import { removeWorktree, repoPaths, worktreeFor } from "../git/repo.ts";
import type { Reviewer } from "../reviewer/opencode.ts";
import type { Store } from "../store/store.ts";
import { isLens, LENSES, type Lens } from "./proposal.ts";
import { renderProposals } from "./render.ts";
import { propose } from "./run.ts";

const run = promisify(execFile);

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
  return names as Lens[];
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

export async function proposeCli(i: ProposeCliInput): Promise<string> {
  const repo = i.store.db
    .prepare("SELECT id, name, git_url FROM repo WHERE name = ? OR id = ?")
    .get(i.repo, i.repo) as Record<string, string> | undefined;
  if (repo === undefined) {
    const known = (i.store.db.prepare("SELECT name FROM repo ORDER BY name").all() as Record<string, string>[])
      .map((r) => r["name"] ?? "")
      .join(", ");
    throw new UsageError(`no repository '${i.repo}' — known: ${known || "none; run `lore new` first"}`);
  }
  const repoId = repo["id"] ?? "";
  const paths = repoPaths(i.reposRoot, repoId);

  // The same cut a review takes (D-65), so a stale mirror refuses here too: thinking
  // hard about a tree from three hours ago is worse than not thinking, because the
  // output looks exactly as confident.
  // The FOLDER is in the id, not just the clock. Eleven folders started in the same
  // second would otherwise collide on one worktree, and the collision is silent: git
  // hands the second caller the first caller's checkout.
  const slug = (i.folder || "root").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const id = `propose_${slug}_${i.now.toISOString().replace(/[^0-9]/g, "")}`;
  const worktree = await worktreeFor(paths, id, i.commit, repo["git_url"] ?? "");
  try {
    // The RESOLVED SHA. `master` means something different next week, and this document
    // is read weeks later by someone reconstructing what was actually looked at.
    const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();

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
        knowledge: i.store.knowledgeFor(repoId),
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
    const path = join(i.outDir, `${i.now.toISOString().slice(0, 10)}-${sha.slice(0, 7)}-${slug}.md`);
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
