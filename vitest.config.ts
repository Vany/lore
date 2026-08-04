/**
 * Test discovery.
 *
 * This file exists for one reason: vitest's default `include` walks the whole tree,
 * and agent worktrees live at `.claude/worktrees/<id>/` INSIDE this repository. Each
 * is a full checkout, so a run picked up six more copies of every test — and the HTTP
 * tests bind a fixed port, so the copies fought each other and the suite went red
 * while nothing was actually broken.
 *
 * A green suite that went red because of where a sibling checkout sits is the same
 * class of problem as a review that did not run reporting nothing found: the signal
 * stopped being about the code. `.gitignore` does not help — vitest has its own
 * discovery and never consults git.
 *
 * The SECOND instance of the same bug is `lore/data/**`: the local deployment clones
 * the repo under review into its own data directory, so a review of THIS repo puts a
 * full copy of this suite inside it. Same symptom, same cause, and the same reason
 * `.gitignore` does not help. A pattern that recurs is a missing rule, not two bugs.
 *
 * `configDefaults.exclude` is spread rather than replaced, so node_modules and dist
 * stay excluded; dropping them is the usual way this file goes wrong.
 *
 * Two patterns cover the review worktrees, and the second is the durable one.
 *
 * `**\/lore\/data\/**` names where THIS deployment happens to keep its data, which
 * is wherever `LORE_HOST_DATA` in `lore/.env` points. Move that setting and the
 * pattern stops matching — and it stops matching SILENTLY, with the suite going red
 * for a reason that has nothing to do with the code. A reviewer raised exactly that
 * coupling (03aa0769).
 *
 * `**\/repos\/*\/wt\/*\/**` is derived from the layout instead: `git/repo.ts` puts
 * every review worktree at `{reposRoot}/{repoId}/wt/{reviewId}/`. That shape comes
 * from the code, so it holds wherever the data directory is pointed, and it is
 * narrow enough to leave `src/git/repo.test.ts` alone.
 *
 * lore-ok[03aa0769]: the coupling is real and is now fixed above, but the finding's
 * actual claim — that the exclusion "is inert", so the copies are discovered — is
 * false, and was false when it was written. Measured, not argued: there are 68
 * `*.test.ts` files under the review worktrees, and `vitest list` reports 261 tests
 * with none of them from that tree.
 *
 * The reasoning behind it swapped two paths that are both real. `cfg.dataDir` is
 * `/var/lib/lore` INSIDE the container, which is where the finding's evidence comes
 * from; on this host that same directory is the bind-mount source named by
 * `LORE_HOST_DATA`, `/Users/vany/l/rev/lore/data`. Vitest runs on the host, against
 * the host path, and that path does contain `lore/data/`. Nothing runs the suite
 * from inside the container, which is the only place the finding's path exists.
 */

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/lore/data/**", "**/repos/*/wt/*/**"],
  },
});
