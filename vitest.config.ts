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
 * `configDefaults.exclude` is spread rather than replaced, so node_modules and dist
 * stay excluded; dropping them is the usual way this file goes wrong.
 */

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
