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
import { join } from "node:path";
import { DidNotRun } from "../core/errors.ts";
import { git, gitMaybe } from "./exec.ts";

export interface RepoPaths {
  /** Bare clone, shared by every review of this repo. */
  readonly bare: string;
  /** Per-review worktrees. */
  readonly worktrees: string;
}

/**
 * The short name `make mirror REPO=` matches on, derived from the url.
 *
 * The instruction has to be COMPLETE. `make mirror` alone refuses and lists the
 * registered repositories, because fetching every remote because one was asked for
 * reaches repositories nobody named — and on a shared host that is someone else's
 * repository touched because you wanted yours refreshed. The daemon refreshes all of
 * them, which is not the same thing: that is what was asked for, once, at install.
 */
function repoHint(gitUrl: string): string {
  const m = /([^/:]+?)(?:\.git)?$/.exec(gitUrl.trim());
  return m?.[1] ?? gitUrl;
}

export function repoPaths(root: string, repoId: string): RepoPaths {
  return { bare: join(root, repoId, "bare.git"), worktrees: join(root, repoId, "wt") };
}

/**
 * Three states, deliberately not two.
 *
 * This returned `Date | undefined` and `undefined` meant BOTH "no remote, so it
 * cannot be behind" and "has a remote and has never been fetched" — and `ensureBare`
 * accepted both. The second is the dangerous one, and the refresher produces it: it
 * runs `git clone --bare && … && git fetch`, so a clone that succeeds
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
async function mirrorFreshness(localPath: string): Promise<MirrorFreshness> {
  const hasRemote = await gitMaybe(localPath, ["config", "--get", "remote.origin.url"]);
  if (hasRemote === undefined) return { kind: "no-remote" };
  for (const candidate of [join(localPath, ".git", "FETCH_HEAD"), join(localPath, "FETCH_HEAD")]) {
    const s = await stat(candidate).catch(() => undefined);
    if (s !== undefined) return { kind: "fetched", at: s.mtime };
  }
  return { kind: "never-fetched" };
}

/**
 * How stale a mirror may be before lore refuses to review from it.
 *
 * lore holds no credentials for any remote and must not: a service holding a key
 * holds everything that key opens. The host already authenticates to the forge as a
 * person allowed to read these repositories, so `mirror-refresh.sh` runs out there on
 * a timer and keeps every mirror current (D-65).
 *
 * **So a mirror past this age no longer means a person forgot — it means the
 * refresher is not running.** That is a different fault with a different fix, and it
 * is why the messages below point at the daemon rather than at a command the reader
 * is expected to remember. Reviewing anyway would describe a tree that is not the one
 * being merged: INV-2's failure, where a base 57 commits behind turned a one-file
 * branch into a 496-file diff, with an attestation over it.
 *
 * Thirty minutes against a five-minute refresh is six missed passes before anything
 * is refused — comfortable slack for a slow fetch, and still short enough that
 * "nobody fetched this today" cannot pass.
 */
export const MAX_MIRROR_AGE_MS = 30 * 60_000;

/**
 * The clone must be here already, and recent. lore never fetches it (D-65).
 *
 * The refresher clones and fetches on the HOST, where the operator's credentials
 * live. That is the only thing that talks to a remote — which is why lore needs no
 * key, no agent, and no sight of any directory outside its own data.
 *
 * So this does not clone and does not fetch. It checks, and refuses loudly. **Every
 * message here is read by an agent that cannot fix any of it**: the client has no
 * shell on this host, so the useful thing to tell it is what to report, not what to
 * run. `make status` shows each mirror's age for whoever can act.
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
    throw new DidNotRun(
      `no clone of ${gitUrl} at ${paths.bare}. lore does not clone — it holds no credentials for any ` +
        `remote, by design. The host refresher populates this; it has not, so either it is not installed ` +
        `or it has never succeeded for this repository. REPORT THIS — you cannot fix it from here. On the ` +
        `lore host: \`make mirror REPO=${repoHint(gitUrl)}\` once, and \`make mirror-daemon\` so it stays current.`,
    );
  }
  if (!requireFresh) return;

  const freshness = await mirrorFreshness(paths.bare);
  if (freshness.kind === "no-remote") return; // nothing can be behind nothing

  // A clone whose fetch never landed. `origin/<branch>` does not exist yet, so
  // `addWorktree` would silently review the clone-time commit instead.
  if (freshness.kind === "never-fetched") {
    throw new DidNotRun(
      `the clone of ${gitUrl} at ${paths.bare} has a remote but has never been fetched — no FETCH_HEAD. ` +
        `A clone that succeeded with a failed fetch looks exactly like this, and it is the dangerous shape: ` +
        `refs/remotes/origin/* does not exist either, so reviewing it would review the commit it was cloned ` +
        `at rather than the branch you are merging. REPORT THIS — on the lore host, ` +
        `\`make mirror REPO=${repoHint(gitUrl)}\` and \`make mirror-daemon-log\` say why it is failing.`,
    );
  }

  const age = Date.now() - freshness.at.getTime();
  if (age > MAX_MIRROR_AGE_MS) {
    throw new DidNotRun(
      `the clone of ${gitUrl} was last fetched ${Math.round(age / 60_000)} minutes ago, and lore holds no ` +
        `credentials to fetch it itself. The host refresher should keep this under ` +
        `${Math.round(MAX_MIRROR_AGE_MS / 60_000)} minutes, so it is not running or cannot reach the remote. ` +
        `REPORT THIS — you cannot fix it from here. On the lore host: \`make status\` shows every mirror's age, ` +
        `\`make mirror-daemon-log\` says what the refresher last did. Reviewing this as it stands would ` +
        `describe a tree that is not what you are merging.`,
    );
  }
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

/**
 * Drop git's record of every worktree whose directory has gone.
 *
 * `removeWorktree` asks git first and only then deletes, which is right — but it
 * cannot help a record git can no longer reach. Found on the deployment: twelve
 * records naming `/var/lib/lore/...`, left from before the data directory moved, that
 * `git worktree remove` refuses because the path does not exist. Nothing had ever
 * collected them, because nothing ever called this.
 *
 * A crash between creating a worktree and recording it, an operator clearing space by
 * hand, or a moved data directory all produce the same litter, so this is a
 * per-repository sweep rather than a per-review one — it collects whatever the
 * careful path could not.
 */
export async function pruneWorktrees(paths: RepoPaths): Promise<void> {
  await git(paths.bare, ["worktree", "prune"]);
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

/** A submodule pointer: the path it sits at, and the commit it points to. */
export interface Gitlink {
  readonly path: string;
  readonly commit: string;
}

/**
 * Every submodule pointer in the tree.
 *
 * This workgroup uses submodules rather than monorepos (D-36), so vendored code
 * arrives as a gitlink with **no package and no version** — which is precisely what
 * an SBOM cannot describe and what OSV's commit query exists for. Without this the
 * security review enumerates `package-lock.json` and reports clean about a dependency
 * tree it never enumerated.
 *
 * Mode `160000` is git's gitlink mode; `ls-tree -r` does not descend into one, so each
 * submodule yields exactly one row whatever it contains.
 */
export async function gitlinks(worktree: string): Promise<readonly Gitlink[]> {
  const { stdout } = await git(worktree, ["ls-tree", "-r", "HEAD"]);
  const out: Gitlink[] = [];
  for (const line of stdout.split("\n")) {
    // <mode> SP <type> SP <sha> TAB <path>
    const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out.push({ commit: m[1], path: m[2] });
  }
  return out;
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
      // `--recount`: recompute each hunk's line counts from its content instead of
      // trusting the `@@` header.
      //
      // A diff whose LAST line is a whitespace-only context line loses it in transit —
      // an agent composes the diff as a tool-call argument and the trailing blank is
      // stripped somewhere between there and here — which leaves a hunk one line
      // shorter than its header claims. git rejects that as `corrupt patch at line 66`,
      // a line number in a string the client itself composed, which is the least
      // debuggable thing it could be told. Reproduced and verified: plain `apply` fails,
      // `--recount` applies it correctly.
      //
      // Being lenient here cannot produce a silently wrong tree. `review_submit` hashes
      // the result and compares it against the client's `tree_hash` (D-40), so a recount
      // that guessed wrong fails loudly at that check instead of being reviewed.
      ["apply", "--recount", "--whitespace=nowarn", "-"],
      {
        cwd: worktree,
        maxBuffer: 64 * 1024 * 1024,
        // The same ceiling every other invocation gets (D-61): a patch must never be
        // applied to a repository above the worktree it was meant for.
        env: { ...process.env, GIT_CEILING_DIRECTORIES: worktree },
      },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new DidNotRun(describeApplyFailure(String(stderr)), err));
          return;
        }
        resolve();
      },
    );
    child.stdin?.end(patch);
  });
}

/**
 * Say WHAT is malformed, not where.
 *
 * git's own message points at a line number in the patch — a string the client
 * composed in memory and cannot open, so "line 66" is unusable to the one party that
 * could fix it. Hit while driving a real review as a client: the message named a
 * location in my own payload and told me nothing about what was wrong with it.
 *
 * Every branch here names the fault and what to do, and says plainly that NOTHING was
 * applied — otherwise a client cannot tell whether to resend the whole diff or the
 * remainder, and a half-applied tree is the state this whole path exists to refuse.
 */
function describeApplyFailure(stderr: string): string {
  const detail = stderr.trim().slice(0, 500);
  const nothing = "Nothing was applied; the worktree is unchanged, so resend the whole diff.";

  if (/corrupt patch/i.test(detail)) {
    return (
      "the diff is malformed: a hunk's line count does not match its content, so git could not read it. " +
      "The usual cause is a context line lost in transit — most often a trailing whitespace-only line at " +
      "the very end of the diff. Send the diff exactly as `git diff` produced it, without trimming " +
      `trailing whitespace or blank lines. ${nothing} (git: ${detail})`
    );
  }
  if (/does not (apply|exist)|No such file/i.test(detail)) {
    return (
      "the diff does not apply to the tree under review. It was probably generated against a different " +
      "base — the review is pinned to the tree it started with plus what you have already submitted " +
      `(D-40), not to your branch as it stands now. ${nothing} (git: ${detail})`
    );
  }
  return `the diff could not be applied. ${nothing} (git: ${detail})`;
}
