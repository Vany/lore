/**
 * Where lore's state lives. The ONE definition, because there have been four.
 *
 * Two directories, and they are not the same one:
 *
 *   * **`dataDir`** — worktrees, git mirrors, the sandbox npm cache, the signing key.
 *     Must be a HOST BIND at an identical path on both sides: the T0 sandbox asks the
 *     host daemon to bind a worktree into a sibling container by absolute path, and the
 *     daemon resolves it on the host. A named volume there mounts an empty directory and
 *     the suite reports clean for code it never saw.
 *
 *   * **`dbDir`** — `lore.db` alone. Must NOT be a host bind. On Docker Desktop for
 *     macOS that is virtiofs, and SQLite's own `howtocorrupt.html` §2.1 names a
 *     filesystem with unreliable locking primitives, plus two or more processes sharing
 *     the file, as a cause of corruption. lore and litestream are those two processes,
 *     and this database was corrupted three times in three days.
 *
 * They were one variable until 2026-08-08, so splitting them created a second copy of
 * "where is the database" in every reader — and there were four: the service, the CLI,
 * `ops/status.ts`, and the Makefile. Three were updated. `make status` then died with
 * `unable to open database file`, having looked in a directory that no longer holds one.
 *
 * That is this repository's most reliable defect and it does not need a fifth instance:
 * one function, and `one-definition.test.ts` fails if anything else reads the variables.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** A variable set to nothing is not set — `.env` spells "unconfigured" as `X=`. */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * Worktrees, mirrors, caches — everything except the database.
 *
 * `~/.lore` last, and only for a laptop: a container has no home worth writing to, and
 * `lore new` inside one died on `EACCES: mkdir '/.lore'` having ignored the data
 * directory mounted beside it.
 */
export function dataDir(): string {
  return env("LORE_DATA_DIR") ?? join(homedir(), ".lore");
}

/**
 * The directory holding `lore.db`.
 *
 * Falls back to `dataDir()`, so a deployment that has not been split — and every local
 * CLI run — behaves exactly as it did.
 */
export function dbDir(): string {
  return env("LORE_DB_DIR") ?? dataDir();
}

/** The one place the file is named. */
const DB_FILE = "lore.db";

/**
 * The database inside a directory the caller already decided on.
 *
 * For `serve()`, which takes its directories from a config a test can inject and so
 * cannot read the environment itself. It still must not spell the filename again: that
 * is the half of the decision every copy DID agree on, right up until one of them looked
 * under the data directory for it.
 */
export function dbFileIn(dir: string): string {
  return join(dir, DB_FILE);
}

/** The database itself. Every reader goes through here. */
export function dbPath(): string {
  return dbFileIn(dbDir());
}
