/**
 * Repository handling: a bare clone per repo, a worktree per review.
 *
 * Worktrees are what let reviews run in parallel against one repo without a lock.
 * The predecessor held a global flock for a whole run; a leaked fd once let a
 * daemon hold it for its entire life, and runs queued behind an orphan for ten
 * hours in silence (INV-5).
 */

import { existsSync } from "node:fs";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DidNotRun } from "../core/errors.ts";
import { dataDir } from "../core/paths.ts";
import { unquoteGitPath } from "./diff.ts";
import { requestMirrorRefresh, type RefreshOutcome } from "./mirror-request.ts";
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
 * The reproduction: after `clone --bare`, `origin/master` does not resolve while
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
  // THE PINNED TREES MUST OUTLIVE A REVIEW BY CONTRACT, NOT BY LUCK (D-107, obligation
  // five). Every submit writes its state as a tree object via write-tree, and no ref
  // points at those trees — so git's gc would prune them after its default two-week
  // grace, while a review now lives ~nine days (48h bright, 7 gray). Inside the window,
  // but by two defaults nobody chose. Set explicitly, idempotent and cheap.
  await gitMaybe(paths.bare, ["config", "gc.pruneExpire", "45.days.ago"]);

  const isRepo = await gitMaybe(paths.bare, ["rev-parse", "--resolve-git-dir", "."]);
  if (isRepo === undefined) {
    throw new DidNotRun(
      `lore has no copy of ${gitUrl} yet — its host-side sync has never populated one, so either that ` +
        `sync is not installed or it has never succeeded for this repository. lore itself holds no ` +
        `credentials for any remote, by design. REPORT THIS — you cannot fix it from here. On the ` +
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
      `lore's copy of ${gitUrl} has never completed a sync from origin, so reviewing it would review ` +
        `the commit it was first copied at rather than the branch you are merging. REPORT THIS — on the ` +
        `lore host, \`make mirror REPO=${repoHint(gitUrl)}\` and \`make mirror-daemon-log\` say why it is failing.`,
    );
  }

  const age = Date.now() - freshness.at.getTime();
  if (age > MAX_MIRROR_AGE_MS) {
    throw new DidNotRun(
      `lore last synced ${gitUrl} from origin ${Math.round(age / 60_000)} minutes ago, and it holds no ` +
        `credentials to sync it itself. The host-side sync should keep this under ` +
        `${Math.round(MAX_MIRROR_AGE_MS / 60_000)} minutes, so it is not running or cannot reach the remote. ` +
        `REPORT THIS — you cannot fix it from here. On the lore host: \`make status\` shows every repository's ` +
        `sync age, \`make mirror-daemon-log\` says what the sync last did. Reviewing this as it stands would ` +
        `describe a tree that is not what you are merging.`,
    );
  }
}

/**
 * How long `git worktree add` (below) may run before its own timeout kills it.
 *
 * Reused by `worktreeAddInProgress` below as more than a duration: nothing this
 * codebase starts runs past it, so a lock still standing when this much time has
 * passed cannot be a legitimate in-progress checkout FROM HERE, only one orphaned by
 * a kill that did not let git clean up after itself.
 */
const WORKTREE_ADD_TIMEOUT_MS = 300_000;

export async function addWorktree(
  paths: RepoPaths,
  reviewId: string,
  branch: string,
  /** Named in the failure, because "which repository" is the usual answer. */
  gitUrl = "",
): Promise<string> {
  const dir = join(paths.worktrees, reviewId);
  await mkdir(paths.worktrees, { recursive: true });
  const resolve = async (): Promise<string | undefined> =>
    (await gitMaybe(paths.bare, ["rev-parse", "--verify", "--quiet", `origin/${branch}^{commit}`]))
    ?? (await gitMaybe(paths.bare, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]));

  let ref = await resolve();

  // BRANCH MISSING → REFRESH THE MIRROR. MISSING AFTER THAT → error (D-100).
  //
  // A client that pushes and immediately asks for a review is doing exactly what the
  // docs tell it to, and it used to lose: the host refresher runs on a timer, so a branch
  // pushed 77 seconds before `review_start` was not in the mirror yet and the review died
  // as `failed` — which by INV-1 means the ladder did not read the code, and blocks the
  // merge. Measured, on a real client's branch, on 2026-08-11.
  //
  // lore cannot fetch (D-65: no key, no agent, and deliberately no business having one),
  // so it ASKS the host, whose credentials these are, and waits. Only a branch that is
  // still absent after a real fetch is an error — and then it is a true one.
  let refreshed: RefreshOutcome | undefined;
  if (ref === undefined) {
    refreshed = await requestMirrorRefresh(dataDir());
    if (refreshed.fetched) ref = await resolve();
  }

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
      // ORIGIN IS THE ONLY WORD THE CLIENT GETS (D-65 revised, 2026-08-14). Vany: *"code
      // must be in the origin — it is the only requirement."* The mirror is lore's
      // mechanism, and every earlier version of this message leaked it as the client's
      // problem to reason about. What the client can act on: the branch name, the push,
      // the token's repository. Nothing else.
      `branch '${branch}' has not reached ${gitUrl || "origin"}, as far as lore can see. ` +
        `Your token is scoped to that repository — if the branch belongs to a different one, ` +
        `you are holding the wrong token, and the branch existing elsewhere will not help. ` +
        (refreshed?.fetched === true
          // NOT "CONFIRMED ABSENT" — a completed pass is not a per-repo guarantee. Softened
          // 2026-08-20, alongside the identical claim in `review_submit`'s commit form:
          // `mirror-refresh.sh` discards `one_pass`'s per-repo failure count and deletes the
          // request once the pass RETURNS, whatever it returned, so `fetched: true` here
          // means "a pass completed", not "this repository's fetch succeeded" (TODO.md).
          ? " lore's mirror daemon completed a sync pass since asking, and the branch is still not there. Most " +
            "likely: check the name, check you pushed to this repository, and check the push reached the remote. " +
            "But a single repository's fetch CAN fail inside a completed pass without lore seeing it (the daemon " +
            "does not yet report per-repo results) — if you are confident this was pushed here, `mirror.log` on " +
            "the lore host is where that would show."
          : ` lore could not confirm a fresh sync first (${refreshed?.why ?? "no sync was attempted"}), so its view of origin may be behind — report that rather than assuming the branch is wrong.`) +
        (nearby.length > 0 ? ` Most recent branches lore can see there: ${nearby.join(", ")}.` : " lore can see no branches there at all."),
    );
  }
  await git(paths.bare, ["worktree", "add", "--detach", dir, ref], WORKTREE_ADD_TIMEOUT_MS);
  // FAILING TO INITIALISE A SUBMODULE DOES NOT FAIL THE REVIEW — most commonly a
  // private remote lore's container has no credentials for (D-65), which is expected
  // and not this worktree's fault. lore-ok[6238936e]: fixed at the READER, not here —
  // this comment used to claim the loss was "announced by the diff layer", which
  // nothing did. `diff.ts`'s `submodulesThatFailedToExpand` now detects git's own
  // "(diff failed)" marker in the patch (verified directly: that is exactly what
  // `--submodule=diff` prints here, since the objects this swallowed failure would
  // have fetched are the ones the expansion needs) and `appendTail` turns it into an
  // explicit warning naming the submodule, so the claim below is true now rather than
  // aspirational.
  await git(dir, ["submodule", "update", "--init", "--recursive"], 600_000).catch(() => {});
  return dir;
}

/**
 * Ground truth for "is there really a worktree at this path" — git's own
 * registration (`worktree list`), not the filesystem. `pruneWorktrees` below already
 * distrusts a raw path one direction (a registration with no directory behind it);
 * this is the same distrust the other way.
 *
 * lore-ok[a386ebff,9f189b25,dd6f1801,d7a82471]: `worktreeFor` used to ask
 * `existsSync` alone, found wrong by lore's own review and reproduced directly —
 * `git worktree add` killed by its own 300s timeout (`addWorktree` above, real
 * SIGTERM via node's `execFile`) leaves a populated, `.git`-bearing directory that
 * `existsSync` cannot tell apart from a finished one, and `git worktree list
 * --porcelain` never names. Compares REALPATHs on both sides, not raw strings — git
 * records a worktree's path resolved (confirmed directly: a path reached through a
 * symlinked prefix, `/tmp` on this machine, comes back from `worktree list` as
 * `/private/tmp/...`), so comparing `dir` as constructed against that verbatim would
 * report every such worktree unregistered and rebuild it on every call.
 */
async function isRegisteredWorktree(paths: RepoPaths, dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const real = await realpath(dir);
  const { stdout } = await git(paths.bare, ["worktree", "list", "--porcelain"]);
  return stdout.split("\n").some((line) => line === `worktree ${real}`);
}

/**
 * Is a `git worktree add` for this exact path GENUINELY running right now — as
 * opposed to merely having left a directory behind?
 *
 * Exists because the fix above is not by itself enough: a directory that exists but
 * is not yet registered is exactly what a peer's checkout looks like WHILE it is
 * still running, not only after it has died. Deleting on that observation alone
 * (verified: `worktreeAddInProgress` is what stands between `worktreeFor` and doing
 * that) would trade one review over a tree that exists nowhere for another —
 * corrupting a *concurrent, live* checkout instead of reusing a dead one.
 *
 * `git worktree add` holds `<bare>/worktrees/<name>/index.lock` for the operation's
 * full duration — verified directly, present within the first tick of a real
 * checkout and still there at the last one — and removes it however the process
 * ends, INCLUDING a SIGTERM kill: verified directly that `execFile`'s own timeout
 * kill, the only kill this codebase's `git()` wrapper ever sends, leaves neither the
 * lock nor its directory behind. So an ordinary timeout can never orphan this lock.
 *
 * A harder kill this codebase does not control (OOM, a deploy's SIGKILL after its
 * stop grace period, `kill -9` by hand) still can, so age matters too:
 * `WORKTREE_ADD_TIMEOUT_MS` is how long anything started here is ever allowed to
 * hold this lock, so a lock older than that cannot be a live checkout from this
 * codebase — only a leftover from one that did not exit cleanly, safe to treat as
 * dead. The margin is generous on purpose: mistaking a live checkout for dead and
 * deleting it is the failure this function exists to prevent, and the cost of the
 * opposite mistake is only a slower self-heal.
 */
async function worktreeAddInProgress(paths: RepoPaths, dir: string): Promise<boolean> {
  const lock = join(paths.bare, "worktrees", basename(dir), "index.lock");
  const st = await stat(lock).catch(() => undefined);
  return st !== undefined && Date.now() - st.mtimeMs < WORKTREE_ADD_TIMEOUT_MS + 60_000;
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
  const busy = (): never => {
    throw new DidNotRun(
      `another call is already creating this review's worktree — try again in a few seconds.`,
    );
  };

  // Re-checked AFTER the await, not before it. `ensureBare` yields, and both the
  // worker and `review_submit` reach this function — so a snapshot taken beforehand
  // can be stale by the time it is used, and the caller that loses the race would
  // call `addWorktree` on a path that now exists. The worker treats a throw here as
  // a failed round, so losing that race failed the review outright.
  if (await isRegisteredWorktree(paths, existing)) {
    await ensureBare(paths, gitUrl, false);
    return existing;
  }
  if (await worktreeAddInProgress(paths, existing)) return busy();
  // Only past both checks above is a directory here known dead rather than
  // in-progress — this call's own attempt from a prior round, or a peer's that did
  // not survive (see `isRegisteredWorktree`, `worktreeAddInProgress`). Clearing it is
  // what lets the ordinary "no worktree yet" path below self-heal in the same round
  // instead of failing forever on a path `addWorktree` refuses to check out into a
  // second time.
  if (existsSync(existing)) await rm(existing, { recursive: true, force: true });
  await ensureBare(paths, gitUrl, true);

  try {
    return await addWorktree(paths, reviewId, branch, gitUrl);
  } catch (e) {
    // Narrow on purpose: ONLY when the directory is now REGISTERED, which means a
    // concurrent caller finished creating the same review's worktree from the same
    // pinned base while this one was working — `isRegisteredWorktree`, not
    // `existsSync`, because this call's OWN `addWorktree` can be the one that left a
    // directory behind without finishing it (the timeout above), and treating that
    // as a peer's success is how a round once reviewed a tree that existed nowhere.
    if (await isRegisteredWorktree(paths, existing)) return existing;
    // Second narrow case: a PEER is still actively creating it — this call lost the
    // race inside `addWorktree` itself (git's own lock is why it threw). Neither
    // reusable yet nor safe to delete out from under a live checkout, so this waits
    // exactly as the up-front check above does.
    if (await worktreeAddInProgress(paths, existing)) return busy();
    // Every other failure — `branch not found`, a broken bare repo, a partial
    // directory neither peer nor this call completed — propagates and clears
    // whatever partial directory it left, because a catch that cannot tell those
    // apart is how a round once continued against a path that had never been
    // created.
    await rm(existing, { recursive: true, force: true }).catch(() => {});
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

/** A hex object id, in EITHER format git actually has: SHA-1 (40) or SHA-256 (64). Nothing in between is real. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A COMMIT-ISH THE CALLER NAMED, AS A SHA — or `undefined` if it is not one.
 *
 * The one gate between a client's string and git's argv. Git reads any argument starting
 * with `-` as an OPTION, so an unvalidated ref is an option-injection surface: `--output=`
 * alone turns a read into an arbitrary file write, and this service hands that argv slot to
 * anyone holding a token. `^{commit}` also refuses a tree or a blob, so what comes back is
 * always a commit and always pure hex — a shape that cannot be an option however the
 * caller wrote it, whichever length git gave it.
 *
 * lore-ok[a1f2bbd6]: was `{40}` only — found by lore's own review, verified directly
 * against a real `git init --object-format=sha256` repository: a genuine, existing
 * commit there is 64 hex characters, and the old regex refused it, so `review_submit`'s
 * commit form would tell a client holding a real, resolvable sha that it "was not
 * pushed to this repository" — false, and unfixable by anything the client could do.
 * `OBJECT_ID` accepts exactly the two lengths git's object formats actually produce,
 * not an open-ended one: the security property this gate exists for is "pure hex, no
 * leading `-`", which either length satisfies identically.
 *
 * `--quiet` because a ref that does not exist is an ordinary answer here, not a fault.
 */
export async function revParse(worktree: string, ref: string): Promise<string | undefined> {
  const out = await gitMaybe(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = out?.trim();
  return sha !== undefined && OBJECT_ID.test(sha) ? sha : undefined;
}

/**
 * What changed between two pinned trees, as a unified diff (D-108).
 *
 * Both arguments are write-tree objects the submits and re-pins recorded, so this is
 * computable long after the fact — it is how a kept session is told "the author has
 * answered" with exactly the delta it has not seen, whether the tree moved by a
 * submitted diff, a held one, or a pull_fresh re-pin. The gc pin (45 days) is what
 * keeps both ends resolvable for the life of a review.
 */
export async function treeDelta(worktree: string, fromTree: string, toTree: string): Promise<string> {
  const { stdout } = await git(worktree, ["diff", fromTree, toTree], 120_000);
  return stdout;
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
 * Mutates the worktree's index AND, for a submodule the loop below actually
 * touches, that submodule's own checkout — both safe because the whole worktree
 * belongs to this review alone.
 *
 * lore-ok[ad43ea6d]: found by lore's own review, and it is real — `git add -A` does
 * not merely leave a submodule's gitlink alone, it REWRITES it to whatever commit the
 * submodule's own working directory has checked out, discarding whatever
 * `applyPatch`'s `--index` fix (`lore-ok[40f980fe]`) had just staged. Verified
 * directly: right after `applyPatch`, the index correctly names the bumped commit;
 * right after THIS function's own `add -A`, `gitlinks` reads the pre-bump commit
 * again, unconditionally, every time. Restoring the INDEX entry (below) is enough to
 * make THIS submit's own tree-hash check pass — but not enough on its own, which
 * `d6f934ac` found: a gitlink's WORKTREE side, for git's own diffing, is whatever the
 * submodule directory has ACTUALLY CHECKED OUT, never the index. So a bump that only
 * ever touches the index is invisible to the very NEXT round — `computeDiff`'s
 * `git diff <mergeBase>` reads the submodule's real HEAD, sees it still at the OLD
 * commit exactly like `mergeBase` does, and renders zero bytes of patch for a file
 * `--name-only` still lists as changed. Accepted-but-unreadable: the submit verifies,
 * every later disk read — the tiers, T0, `codeMoved` — still sees the old bytes, and
 * the finding the bump was meant to answer can never settle. `git submodule update`
 * closes it the same way `addWorktree` already trusts it to: reads the INDEX entry
 * just written (not HEAD, verified directly — this runs with HEAD unmoved) and checks
 * the submodule out to match. Swallowed on failure for the same reason `addWorktree`'s
 * own call is (D-65: most commonly a private remote lore has no credentials for, not
 * this submit's fault) — and largely still visible when it matters: objects missing
 * is the common way this fails, and that is what leaves the NEXT round's
 * `--submodule=diff` unable to expand the pair, which `submodulesThatFailedToExpand`
 * (`diff.ts`) already turns into an explicit warning rather than silence.
 */
export async function treeHash(worktree: string): Promise<string> {
  const before = await gitlinks(worktree);
  await git(worktree, ["add", "-A"]);
  for (const link of before) {
    await git(worktree, ["update-index", "--cacheinfo", `160000,${link.commit},${link.path}`]);
    await git(worktree, ["submodule", "update", "--", link.path]).catch(() => {});
  }
  const { stdout } = await git(worktree, ["write-tree"]);
  return stdout.trim();
}

/** A submodule pointer: the path it sits at, and the commit it points to. */
export interface Gitlink {
  readonly path: string;
  readonly commit: string;
}

/**
 * Every submodule pointer in the tree — the WORKTREE, meaning the INDEX, not `HEAD`.
 *
 * This workgroup uses submodules rather than monorepos (D-36), so vendored code
 * arrives as a gitlink with **no package and no version** — which is precisely what
 * an SBOM cannot describe and what OSV's commit query exists for. Without this the
 * security review enumerates `package-lock.json` and reports clean about a dependency
 * tree it never enumerated.
 *
 * lore-ok[23ac90bf]: was `ls-tree -r HEAD`, which is correct only when HEAD and the
 * index agree — found by lore's own review, and the review's own OTHER finding
 * (`lore-ok[40f980fe]`'s sibling, applyPatch's `--index` fix) is what makes this one
 * reachable rather than moot: before `--index`, a submitted gitlink bump silently
 * failed to apply at all (D-40's tree-hash check caught it, refusing the submission),
 * so HEAD and the index could never actually disagree about a gitlink. Verified
 * directly with the real `applyPatch`, before and after that fix — after it, a bumped
 * submodule sits correctly in `ls-files -s` while `ls-tree -r HEAD` still shows the
 * ORIGINAL commit, because `--index` writes the index and nothing here ever moves
 * HEAD (T0 runs on the pinned worktree mid-review, same as `computeDiff`/INV-3). OSV's
 * whole purpose is querying what a review is ACTUALLY attesting over; enumerating from
 * HEAD after a review has advanced past it queries a commit nobody is reviewing.
 *
 * Mode `160000` is git's gitlink mode; `ls-files -s` lists one line per index entry
 * with no recursion into it, so each submodule yields exactly one row.
 */
export async function gitlinks(worktree: string): Promise<readonly Gitlink[]> {
  // lore-ok[fa429ab3,059ab094]: `-c core.quotePath=false` + `unquoteGitPath`, same
  // fix `diff.ts` carries on every `ls-files`/`diff --name-only` call site (each with
  // its own lore-ok recording the incident) — found missing HERE by lore's own
  // review, on the rewrite that fixed this line's SHA-256 gap (`a1f2bbd6`) without
  // porting the quoting fix alongside it. `unquoteGitPath` is exported from
  // `diff.ts` rather than copied, so this stays one implementation rather than a
  // second one to independently forget.
  const { stdout } = await git(worktree, ["-c", "core.quotePath=false", "ls-files", "-s"]);
  const out: Gitlink[] = [];
  for (const line of stdout.split("\n")) {
    // <mode> SP <sha> SP <stage> TAB <path>. lore-ok[a1f2bbd6]: same fix as revParse
    // above, same file — a SHA-256 repository's gitlink is 64 hex characters, not 40.
    const m = /^160000 ([0-9a-f]{40}|[0-9a-f]{64}) \d\t(.+)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out.push({ commit: m[1], path: unquoteGitPath(m[2]) });
  }
  return out;
}

/**
 * Apply a unified diff without committing. The client keeps its own history.
 *
 * Spawned here rather than through `git()` because the patch goes in on stdin, which
 * that wrapper has no way to pass — so this is the one call site the ceiling in D-61
 * did not reach, while SPEC said it applied to "every git invocation". The env is set
 * explicitly below; nothing mechanical would have caught the gap, which is the
 * argument for the wrapper rather than against it.
 */
/**
 * Put a worktree back to a tree it was at, discarding everything since.
 *
 * For the one caller that needs it: `review_submit` applies a patch, hashes the result,
 * and refuses the submit when the hash is not what the client said. That refusal used to
 * leave the patch APPLIED — the review row still naming the old tree, the worktree
 * holding a partial apply nobody has seen — while telling the client *"Nothing was
 * reviewed. Re-send the full diff for the tree you actually have."* The client then
 * re-sends against a base that has silently moved, and the second apply lands on top of
 * the first one's wreckage.
 *
 * `read-tree` then `checkout-index -af` rather than `reset --hard`: the worktree carries
 * the review's accepted diffs as uncommitted changes, and a hard reset would throw away
 * every earlier round with the failed one. `clean -fd` removes files the patch created,
 * which `checkout-index` would leave behind.
 */
export async function restoreTree(worktree: string, tree: string): Promise<void> {
  await git(worktree, ["read-tree", tree]);
  await git(worktree, ["checkout-index", "-a", "-f"]);
  await git(worktree, ["clean", "-fd"]);
}

// lore-ok[40f980fe]: fixed inside — the `execFile` options below now carry `timeout:
// 120_000`, the same bound every other git call in this module gets, and the reject
// path names a timeout kill honestly rather than inheriting `describeApplyFailure`'s
// "worktree is unchanged" claim, which is not verified for a killed mid-write.
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
      //
      // `--index`: WITHOUT IT, A SUBMODULE BUMP IS SILENTLY LOST — found by lore's own
      // review, verified directly against real git and this exact function. A gitlink
      // (mode 160000) has no working-tree bytes to rewrite — a plain `git apply` (no
      // flags) can only write to files on disk, so a gitlink-only hunk applies to
      // NOTHING, `treeHash`'s later `git add -A` finds nothing changed to stage either,
      // and the whole submission then fails D-40's tree-hash check with "nothing was
      // applied, resend the whole diff" — advice that cannot ever help, since resending
      // hits the identical gap. `git apply --index` writes the new gitlink straight into
      // the index, which is where a gitlink lives; verified this does not disturb the
      // ordinary regular-file case apply.test.ts already covers.
      ["apply", "--index", "--recount", "--whitespace=nowarn", "-"],
      {
        cwd: worktree,
        maxBuffer: 64 * 1024 * 1024,
        // The same ceiling every other invocation gets (D-61): a patch must never be
        // applied to a repository above the worktree it was meant for.
        env: { ...process.env, GIT_CEILING_DIRECTORIES: worktree },
        // THE SAME BOUND EVERY OTHER GIT CALL GETS (`exec.ts`'s `git()` default,
        // `diff.ts`'s `mergeCheck`) — found by lore's own review: this is the one raw
        // `execFile` in the module (needed for stdin piping, which the `git()` wrapper
        // does not support) and it had no timeout at all. Both direct callers
        // (`mcp/server.ts`'s `review_submit` handler, `reviewer/review.ts`'s
        // `consumeHeldDiffs`, itself inside a round job) `await` this with no outer
        // bound of their own, so a stall here — a bind-mount hiccup, pathological
        // `--recount` work on a huge patch — used to hang the MCP call, or the round
        // job, forever: no failure, no DidNotRun, nothing for the abandonment sweep to
        // find because the row never stops being `running`.
        timeout: 120_000,
      },
      (err, _stdout, stderr) => {
        if (err) {
          // ON A TIMEOUT KILL, stderr IS EMPTY (verified: node kills with SIGTERM before
          // git writes anything) — `describeApplyFailure`'s fallback message claims
          // "Nothing was applied; the worktree is unchanged", which is not a guarantee
          // this codebase has verified for a `git apply` interrupted mid-write across a
          // multi-file patch. Named honestly instead of inheriting that claim.
          const err2 = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
          reject(
            err2.killed === true
              ? new DidNotRun(
                  "git apply did not finish within 120s and was stopped. Whether it applied none, some or all " +
                    "of the patch before being stopped is not known — do not assume the worktree is unchanged. " +
                    "Report this rather than resending the same diff.",
                  err,
                )
              : new DidNotRun(describeApplyFailure(String(stderr)), err),
          );
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
      "the diff does not apply to the tree under review. The review's tree is the one it started with " +
      "plus every patch already submitted to it (D-40) — not your branch as it stands now.\n\n" +
      "IF AN EARLIER SESSION SUBMITTED TO THIS REVIEW, RESENDING CANNOT HELP AND YOU HAVE NOT DONE " +
      "ANYTHING WRONG. That tree exists only inside lore: you cannot check it out, so you cannot build a " +
      "diff against it, and the tree hash you compute from your own branch will not match it either. The " +
      "recovery is `review_start` with `restart: true`, which costs the cheap tiers again and every " +
      "justification this review has ratified — say that to your user rather than retrying, because the " +
      "retry loop is what turns one review of a branch into thirteen.\n\n" +
      "If YOUR session made the last submit, diff from the `tree_hash` that call returned, not from your " +
      `latest commit. ${nothing} (git: ${detail})`
    );
  }
  return `the diff could not be applied. ${nothing} (git: ${detail})`;
}
