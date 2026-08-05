/**
 * Repository handling: a bare clone per repo, a worktree per review.
 *
 * Worktrees are what let reviews run in parallel against one repo without a lock.
 * The predecessor held a global flock for a whole run; a leaked fd once let a
 * daemon hold it for its entire life, and runs queued behind an orphan for ten
 * hours in silence (INV-5).
 */

import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DidNotRun } from "../core/errors.ts";
import { git, gitMaybe } from "./exec.ts";
import { type DeployKey, authorizeInstructions, ensureDeployKey, fetchEnv, isLocalPath } from "./keys.ts";

export interface RepoPaths {
  /** Bare clone, shared by every review of this repo. */
  readonly bare: string;
  /** Per-review worktrees. */
  readonly worktrees: string;
  /**
   * Where this repo's deploy key lives (D-65). Carried in the struct rather than
   * passed alongside it because every consumer that has a mirror path now also needs
   * the credential for it, and two arguments that must agree eventually disagree.
   */
  readonly keysDir: string;
  /** The id, so a fetch can name its own key without re-deriving the path. */
  readonly repoId: string;
}

/**
 * The short name a repository is known by, derived from the url.
 *
 * Used for `make mirror REPO=` — which is now the operator's fallback rather than the
 * only way a mirror gets populated (D-65) — and to label the deploy key, so a human
 * reading a forge's deploy-key list sees `lore:rigid-monorepo` rather than a uuid.
 */
export function repoHint(gitUrl: string): string {
  const m = /([^/:]+?)(?:\.git)?$/.exec(gitUrl.trim());
  return m?.[1] ?? gitUrl;
}

export function repoPaths(root: string, repoId: string, keysDir: string): RepoPaths {
  return {
    bare: join(root, repoId, "bare.git"),
    worktrees: join(root, repoId, "wt"),
    keysDir,
    repoId,
  };
}

/**
 * Three states, deliberately not two (D-63).
 *
 * This returned `Date | undefined` and `undefined` meant BOTH "no remote, so it
 * cannot be behind" and "has a remote and has never been fetched" — and `ensureBare`
 * accepted both. The second is the dangerous one, and `make mirror` produces it: its
 * clone branch runs `git clone --bare && … && git fetch`, so a clone that succeeds
 * followed by a fetch that fails leaves objects and a `remote.origin.url` with no
 * `FETCH_HEAD` and no `refs/remotes/origin/*`. `addWorktree` then falls back from the
 * missing `origin/<branch>` to the LOCAL branch, frozen at the clone-time commit, and
 * the review describes a tree nobody is merging — INV-2, with an attestation over it.
 *
 * Raised by t2 against the commit that introduced the check, with the reproduction
 * that confirmed it: after `clone --bare`, `origin/master` does not resolve while
 * `master` resolves to the clone SHA. Verified before fixing.
 */
export type MirrorFreshness =
  | { readonly kind: "no-remote" }
  | { readonly kind: "never-fetched" }
  | { readonly kind: "fetched"; readonly at: Date };

/**
 * When the mirror was last fetched from its remote.
 *
 * Read from `FETCH_HEAD`'s mtime, which git rewrites on every fetch — including the
 * one inside `git pull`, so an operator working normally in the checkout keeps it
 * current without doing anything special. Git writes it even when the fetch brought
 * nothing new, which is what makes its ABSENCE mean "never fetched" rather than
 * "nothing changed".
 */
export async function mirrorFreshness(localPath: string): Promise<MirrorFreshness> {
  const hasRemote = await gitMaybe(localPath, ["config", "--get", "remote.origin.url"]);
  if (hasRemote === undefined) return { kind: "no-remote" };
  for (const candidate of [join(localPath, ".git", "FETCH_HEAD"), join(localPath, "FETCH_HEAD")]) {
    const s = await stat(candidate).catch(() => undefined);
    if (s !== undefined) return { kind: "fetched", at: s.mtime };
  }
  return { kind: "never-fetched" };
}

/**
 * How stale a mirror may be before it is refreshed (D-65) — no longer before lore
 * refuses.
 *
 * This used to be the deadline on a human: lore held no credentials, so a mirror
 * older than this failed the review with an instruction to run `make mirror` on the
 * host. That instruction is unfollowable by the only party that ever reads it. The
 * client is an agent inside a repository, frequently on a different machine and under
 * a different user, with no shell on the deployment host — so a service that can only
 * say "ask someone to fetch for you" cannot refresh, and on 2026-08-05 that single
 * cause produced more review failures than every model and transport fault combined.
 *
 * Now it is the deadline on lore itself: past this age the mirror is fetched before
 * the base is cut. Thirty minutes still, and the number means something different but
 * lands in the same place — long enough that a queued review does not re-fetch for
 * nothing, short enough that no review is ever cut from a tree half an hour behind.
 */
export const MAX_MIRROR_AGE_MS = 30 * 60_000;

/**
 * The mirror is here and current by the time this returns, or the review does not
 * run (D-65).
 *
 * This used to only *check*, and refuse with an instruction to run `make mirror` on
 * the host. Refusing is still what happens when the mirror cannot be made current —
 * INV-1 is untouched, and a tree nobody fetched is never reviewed. What changed is
 * that lore now tries first, with the repository's own read-only deploy key, because
 * the party reading the refusal is an agent that has no shell on this host.
 *
 * Three states, and each now has an action rather than only a complaint:
 *
 *   * **Missing** — clone it. There is something to clone with now.
 *   * **Never fetched** — a clone that landed with a failed fetch. Fetch it.
 *   * **Stale** — fetch it.
 *
 * A failure at any of those still throws, and still names the repository, because the
 * common case for a NEW repo is a key the operator has not authorized yet. That
 * message carries the public key rather than sending the reader looking for it.
 */
export async function ensureBare(
  paths: RepoPaths,
  gitUrl: string,
  /**
   * Whether staleness is disqualifying, which it is **only when the base is being
   * chosen** — the first round, before a worktree exists.
   *
   * A review is pinned to a snapshot (D-40): once its worktree is cut it sees that
   * tree and whatever arrives by `review_submit`, and never reads the mirror again.
   * So on later rounds the mirror's age cannot affect what is reviewed, and refusing
   * on it destroys work rather than protecting it.
   *
   * It did exactly that. Reviewing this change, round 3 was refused with "last
   * fetched 35 minutes ago" after t2 alone had spent 16 minutes — three rounds and
   * eight answered findings thrown away by a guard that had nothing left to guard.
   * Any review slower than MAX_MIRROR_AGE_MS killed itself, and the deep tiers are
   * all slower than that.
   */
  requireFresh = true,
): Promise<void> {
  const isRepo = await gitMaybe(paths.bare, ["rev-parse", "--resolve-git-dir", "."]);
  if (isRepo === undefined) {
    await cloneMirror(paths, gitUrl);
    return; // a fresh clone is as current as a fetch can make it
  }
  if (!requireFresh) return;

  const freshness = await mirrorFreshness(paths.bare);
  if (freshness.kind === "no-remote") return; // nothing can be behind nothing

  // A clone whose fetch never landed. `origin/<branch>` does not exist yet, so
  // `addWorktree` would silently review the clone-time commit instead.
  if (freshness.kind === "never-fetched") {
    await fetchMirror(paths, gitUrl);
    return;
  }

  if (Date.now() - freshness.at.getTime() > MAX_MIRROR_AGE_MS) await fetchMirror(paths, gitUrl);
}

/**
 * Refresh one mirror, with that repository's key and no other.
 *
 * Exported because `make mirror` is no longer the only caller that matters and the
 * operator's manual path should run the same code the service does — two
 * implementations of "fetch this mirror" is how one of them ends up subtly wrong.
 */
export async function fetchMirror(paths: RepoPaths, gitUrl: string): Promise<void> {
  const key = await credentialFor(paths, gitUrl);
  try {
    // --prune so a branch deleted upstream stops resolving here. Without it a review
    // of a merged-and-deleted branch quietly succeeds against the last ref we saw.
    await git(paths.bare, ["fetch", "--prune", "--tags", "origin"], 300_000, envFor(key, paths.keysDir));
  } catch (e) {
    throw new DidNotRun(fetchFailure(gitUrl, key, e), e);
  }
}

async function cloneMirror(paths: RepoPaths, gitUrl: string): Promise<void> {
  const key = await credentialFor(paths, gitUrl);
  const parent = dirname(paths.bare);
  await mkdir(parent, { recursive: true });
  try {
    // cwd is the PARENT: the target does not exist yet, and D-61's ceiling is set to
    // cwd, so aiming git at a directory that is not there would otherwise let it
    // discover whatever encloses it. `--` so a url starting with a dash is never
    // read as an option.
    await git(parent, ["clone", "--bare", "--", gitUrl, paths.bare], 600_000, envFor(key, paths.keysDir));
    // A bare clone fetches into refs/heads/*, not refs/remotes/origin/*, so without
    // this the first `fetch` writes nowhere useful and `origin/<branch>` never
    // resolves — the "never-fetched" trap, arriving one step later.
    await git(paths.bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await git(paths.bare, ["fetch", "--prune", "--tags", "origin"], 300_000, envFor(key, paths.keysDir));
  } catch (e) {
    // A half-made clone is worse than none: it satisfies `rev-parse` next time, so
    // the next review would take the never-fetched path against an empty object
    // store instead of cloning properly.
    await rm(paths.bare, { recursive: true, force: true }).catch(() => undefined);
    throw new DidNotRun(fetchFailure(gitUrl, key, e), e);
  }
}

/** A key for a remote, and deliberately none for a local path (see `isLocalPath`). */
async function credentialFor(paths: RepoPaths, gitUrl: string): Promise<DeployKey | undefined> {
  if (isLocalPath(gitUrl)) return undefined;
  return ensureDeployKey(paths.keysDir, paths.repoId, repoHint(gitUrl));
}

function envFor(key: DeployKey | undefined, keysDir: string): Record<string, string> {
  return key === undefined ? {} : fetchEnv(key, keysDir);
}

/**
 * Why a fetch failed, in the terms the reader can act on.
 *
 * For a repository lore has never successfully fetched, "permission denied" means one
 * specific thing — the deploy key is not authorized yet — and that is the normal
 * first state of every new repository rather than an anomaly. Guessing wrong in the
 * other direction is cheap: the raw git error is always included underneath.
 */
function fetchFailure(gitUrl: string, key: DeployKey | undefined, e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  const denied = /permission denied|publickey|authentication failed|repository not found|access rights/i.test(detail);
  const head =
    denied && key !== undefined
      ? authorizeInstructions(gitUrl, key)
      : `lore could not fetch ${gitUrl}. The mirror is unchanged, so nothing was reviewed against a half-updated tree.`;
  return `${head}\n\ngit said:\n${detail}`;
}

export async function addWorktree(
  paths: RepoPaths,
  reviewId: string,
  branch: string,
  /** Named in the failure, because "which repository" is the usual answer. */
  gitUrl = "",
): Promise<string> {
  const dir = join(paths.worktrees, reviewId);
  await mkdir(paths.worktrees, { recursive: true });
  const ref = (await gitMaybe(paths.bare, ["rev-parse", "--verify", "--quiet", `origin/${branch}^{commit}`]))
    ?? (await gitMaybe(paths.bare, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]));
  if (ref === undefined) {
    // Naming the repository, because the message that omitted it sent someone
    // hunting for a missing branch when the branch existed and the TOKEN was scoped
    // to a different repository. Tokens are per-repo, so a client holding two can
    // start a review of one repo's branch against the other and be told, truthfully
    // and uselessly, that the branch does not exist.
    //
    // Recent branches rather than all of them: this list is read by a model, and a
    // monorepo has hundreds. Five is enough to show whether the mirror has anything
    // resembling what was asked for.
    const known = (await gitMaybe(paths.bare, [
      "for-each-ref", "--sort=-committerdate", "--count=5",
      "--format=%(refname:strip=3)", "refs/remotes/origin",
    ])) ?? "";
    const nearby = known.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    throw new DidNotRun(
      `branch '${branch}' is not in the mirror of ${gitUrl || paths.bare}. ` +
        `Your token is scoped to that repository — if the branch belongs to a different one, ` +
        `you are holding the wrong token, and the branch existing elsewhere will not help. ` +
        `Otherwise push it and run \`make mirror REPO=${repoHint(gitUrl)}\` on the host.` +
        (nearby.length > 0 ? ` Most recent branches there: ${nearby.join(", ")}.` : " The mirror has no branches at all."),
    );
  }
  await git(paths.bare, ["worktree", "add", "--detach", dir, ref], 300_000);
  await git(dir, ["submodule", "update", "--init", "--recursive"], 600_000).catch(() => {
    // Submodules that cannot be initialised are announced by the diff layer rather
    // than failing the review — but they are never silently treated as absent.
  });
  return dir;
}

/**
 * The one way to get a review's worktree. Cutting a base checks freshness; reusing
 * one does not.
 *
 * Both callers used to do this themselves and they disagreed, which is the bug this
 * exists to make unrepresentable. The worker called `ensureBare` and then decided
 * from `existsSync` whether the review was already pinned; `worktreeFor` in the MCP
 * layer called `addWorktree` directly, with no freshness check at all. So
 * `review_submit` — which needs a worktree to apply a diff and hash the tree — could
 * cut a base from a stale or never-fetched mirror before the first round ran, and the
 * worker would then see the directory, conclude the review was pinned, and skip the
 * check. A review, and an attestation, against a base nobody fetched.
 *
 * Raised by **t3** at high severity, naming both call sites and the exact order that
 * reaches it. It is the first finding t3 has produced since D-63, and it found a hole
 * in the fix for the previous round's finding.
 *
 * The rule it enforces: **freshness is a question about choosing a base, not about
 * running a round.** Whoever cuts the worktree asks it, once, here.
 */
export async function worktreeFor(
  paths: RepoPaths,
  reviewId: string,
  branch: string,
  gitUrl: string,
): Promise<string> {
  const existing = join(paths.worktrees, reviewId);

  // Re-checked AFTER the await, not before it. `ensureBare` yields, and both the
  // worker and `review_submit` reach this function — so a snapshot taken beforehand
  // can be stale by the time it is used, and the caller that loses the race would
  // call `addWorktree` on a path that now exists. The worker treats a throw here as
  // a failed round, so losing that race failed the review outright.
  if (existsSync(existing)) {
    await ensureBare(paths, gitUrl, false);
    return existing;
  }
  await ensureBare(paths, gitUrl, true);

  try {
    return await addWorktree(paths, reviewId, branch, gitUrl);
  } catch (e) {
    // Narrow on purpose: ONLY when the directory now exists, which means a
    // concurrent caller created the same review's worktree from the same pinned
    // base while this one was working. Every other failure — `branch not found`,
    // a broken bare repo — leaves no directory behind and propagates, because a
    // catch that cannot tell those apart is how a round once continued against a
    // path that had never been created.
    if (existsSync(existing)) return existing;
    throw e;
  }
}

export async function removeWorktree(paths: RepoPaths, reviewId: string): Promise<void> {
  const dir = join(paths.worktrees, reviewId);
  await git(paths.bare, ["worktree", "remove", "--force", dir]).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}

/**
 * A content hash of the worktree as it stands, including uncommitted and untracked
 * work.
 *
 * The client sends its own hash with each submitted diff and this must match
 * (D-40). Without it, a partial or fuzzy apply leaves us reviewing a tree that
 * exists nowhere — not in git, not on the client's disk — and reporting on it with
 * full confidence.
 *
 * Mutates the worktree's index, which is safe because the index belongs to this
 * review alone.
 */
export async function treeHash(worktree: string): Promise<string> {
  await git(worktree, ["add", "-A"]);
  const { stdout } = await git(worktree, ["write-tree"]);
  return stdout.trim();
}

/**
 * Apply a unified diff without committing. The client keeps its own history.
 *
 * Spawned here rather than through `git()` because the patch goes in on stdin, which
 * that wrapper has no way to pass — so this is the one call site the ceiling in D-61
 * did not reach, while SPEC said it applied to "every git invocation". Raised as
 * a88aa1e2 against the commit that introduced the claim. The env is set explicitly
 * below; a reviewer had to find it, which is the argument for the wrapper, not
 * against it.
 */
export async function applyPatch(worktree: string, patch: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "git",
      ["apply", "--whitespace=nowarn", "-"],
      {
        cwd: worktree,
        maxBuffer: 64 * 1024 * 1024,
        // The same ceiling every other invocation gets (D-61): a patch must never be
        // applied to a repository above the worktree it was meant for.
        env: { ...process.env, GIT_CEILING_DIRECTORIES: worktree },
      },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new DidNotRun(`patch did not apply cleanly: ${String(stderr).trim().slice(0, 500)}`, err));
          return;
        }
        resolve();
      },
    );
    child.stdin?.end(patch);
  });
}
