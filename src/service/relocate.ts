/**
 * A repository moved: same repository, new url.
 *
 * This needs its own operation because the obvious route is wrong in a way that is
 * hard to see. `make new` with the new url calls `upsertRepo`, which matches on
 * `git_url` — so it creates a SECOND row. The repo's reviews, findings, verdicts,
 * usage and knowledge stay attached to the old row while every new review attaches
 * to the new one, and the memory silently splits in half. That happened here once
 * already, with one repository registered under both https and ssh, and undoing it
 * cost a transaction across nine tables.
 *
 * Relocating instead keeps the id. Tokens are scoped by `repo_id`, so they keep
 * working; nothing has to be reissued and nothing is orphaned.
 *
 * **The dangerous mistake is relocating to a DIFFERENT repository.** Knowledge is
 * per-repo (D-19) and is the product (D-14): pointing one repository's accumulated
 * memory at another's code would teach every future session facts about a codebase
 * it is not reading, with full confidence and no way to notice. So identity is
 * checked rather than assumed, by the caller, before this is allowed to run — see
 * `make relocate`, which proves the new remote carries a commit the old mirror
 * already has.
 */

import type { Store } from "./../store/store.ts";

export interface Relocation {
  readonly repoId: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

export class RelocateError extends Error {}

/**
 * Repoint a repository at a new url, keeping everything attached to it.
 *
 * Refuses rather than guesses in all three ways this can be wrong: an unknown
 * repository, a url that already belongs to a different one, and a no-op.
 */
export function relocate(store: Store, nameOrUrl: string, to: string): Relocation {
  const rows = store.repos();
  const matches = rows.filter((r) => r.id === nameOrUrl || r.name === nameOrUrl || r.gitUrl === nameOrUrl);
  if (matches.length === 0) {
    throw new RelocateError(
      `no repository matches ${JSON.stringify(nameOrUrl)}. Registered: ${rows.map((r) => r.name).join(", ") || "(none)"}`,
    );
  }
  // Ambiguity is refused, not resolved. Picking one would move the wrong repository's
  // entire history, and the loser would look untouched.
  if (matches.length > 1) {
    throw new RelocateError(
      `${JSON.stringify(nameOrUrl)} matches ${matches.length} repositories (${matches
        .map((r) => `${r.name} ${r.gitUrl}`)
        .join("; ")}). Name it by id.`,
    );
  }

  const repo = matches[0];
  if (repo === undefined) throw new RelocateError("unreachable: match without a row");

  if (repo.gitUrl === to) {
    throw new RelocateError(`${repo.name} is already at ${to} — nothing to do.`);
  }

  // The collision that would recreate the split this exists to prevent.
  const taken = rows.find((r) => r.gitUrl === to && r.id !== repo.id);
  if (taken !== undefined) {
    throw new RelocateError(
      `${to} is already registered as ${taken.name} (${taken.id}). Two rows for one url is the ` +
        `state that splits a repository's memory; merge them deliberately rather than relocating onto it.`,
    );
  }

  store.relocateRepo(repo.id, to);
  return { repoId: repo.id, name: repo.name, from: repo.gitUrl, to };
}

export function renderRelocation(r: Relocation): string {
  return [
    "",
    `Relocated ${r.name}.`,
    "",
    `  from  ${r.from}`,
    `  to    ${r.to}`,
    `  id    ${r.repoId}  (unchanged — reviews, findings, knowledge and tokens stay attached)`,
    "",
    "The mirror's `origin` must point at the new url too, or the next fetch still talks",
    "to the old one. `make relocate` does that; if you called this directly, run:",
    "",
    `  git -C <data>/repos/${r.repoId}/bare.git remote set-url origin ${r.to}`,
    "",
  ].join("\n");
}
