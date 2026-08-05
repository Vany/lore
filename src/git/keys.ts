/**
 * The per-repository deploy key lore fetches with (D-65).
 *
 * **This reverses D-63, and the reason is that D-63's premise stopped being true.**
 * D-63 removed key generation with a sound argument: lore does not fetch, so a key
 * would be "a live credential written to disk that nothing ever reads". Correct —
 * given that `make mirror` on the host was how mirrors got refreshed.
 *
 * That only works when the operator is sitting at the host. lore is a service: the
 * client may be on another machine, under another user, with no shell there and no
 * way to run a Makefile. Told "the mirror is stale, run `make mirror`", such a client
 * can do exactly nothing — which is what happened all afternoon on 2026-08-05, where
 * a stale mirror caused more review failures than every model and transport fault
 * combined, and the last one refused a review against a mirror 192 minutes old.
 * Refreshing the mirror is the service's job, so the service needs the credential.
 *
 * What survives from D-63 is the part that was actually about danger, and it is
 * enforced here rather than restated:
 *
 *   * **Per repository, never personal.** A GitHub deploy key opens exactly one
 *     repository. A personal key opens everything its human can reach, and would also
 *     let a reviewer sign as them. One is never asked for and never accepted.
 *   * **Read-only.** Nothing here pushes. The operator is told to leave "allow write
 *     access" unticked, and D-2 (lore never writes to a user's repo) is unaffected.
 *   * **Marginal, not new, exposure.** The key grants read access to a repository
 *     whose complete contents lore already holds in its mirror. It buys the ability
 *     to re-read what is already on this disk.
 *
 * The private half must not be readable by the reviewer models. That is not a
 * property of this file — it is the container boundary, and it was broken when this
 * was written: `opencode` ran as the same uid as `lore` and mounted the whole data
 * directory, so it could read the attestation signing key, the knowledge database and
 * a leftover D-62 deploy key. `deploy/docker-compose.yml` now mounts only
 * `<data>/repos` there. Keys living under `<data>/keys` are outside that mount, so
 * re-widening it would have to be deliberate.
 *
 * SPEC: SPEC.md D-65
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DidNotRun } from "../core/errors.ts";

const run = promisify(execFile);

export interface DeployKey {
  /** Private half. Mode 0600, and ssh refuses to use it otherwise. */
  readonly privatePath: string;
  /** The single line pasted into the repository's deploy-key settings. */
  readonly publicKey: string;
  /** True when this call created it, so the caller can say "authorize this". */
  readonly created: boolean;
}

export function keyPathFor(keysDir: string, repoId: string): string {
  return join(keysDir, `${repoId}_ed25519`);
}

/**
 * A url git reaches through the filesystem rather than the network.
 *
 * This classifier existed under D-62, was deleted by D-63 as "a question a reader
 * must answer for nothing" once nothing branched on it, and is back because D-65
 * gives it a caller again. It decides whether a credential is needed at all: ssh
 * never runs for a local path, so generating a deploy key for one would be precisely
 * the secret-created-for-no-reason that both earlier decisions objected to.
 *
 * Deliberately conservative — anything not obviously local is treated as remote.
 * Guessing "local" wrongly means attempting an authenticated fetch with no
 * credential, which fails clearly; guessing "remote" wrongly costs one unused
 * keypair. The scp-like form `git@host:path` has no leading slash and is the shape
 * that matters most to get right.
 */
export function isLocalPath(gitUrl: string): boolean {
  const u = gitUrl.trim();
  return u.startsWith("/") || u.startsWith(".") || u.startsWith("file://");
}

/**
 * The key for a repository, generated once and reused.
 *
 * ed25519 because it is small, fast, and accepted by every forge that matters; RSA
 * would work and buys nothing. The comment carries the repository name so a human
 * reading a forge's deploy-key list can tell what it is — a key labelled with a bare
 * uuid is one nobody dares revoke.
 *
 * Idempotent on purpose. Regenerating would silently invalidate a key the operator
 * has already authorized, and the failure would arrive later, as a fetch that stopped
 * working for no visible reason.
 */
export async function ensureDeployKey(keysDir: string, repoId: string, repoName: string): Promise<DeployKey> {
  await mkdir(keysDir, { recursive: true });
  // 0700: the directory is the second lock. A key file that is briefly 0644 between
  // creation and chmod is still unreachable if nothing may list the directory.
  await chmod(keysDir, 0o700).catch(() => undefined);

  const privatePath = keyPathFor(keysDir, repoId);
  const publicPath = `${privatePath}.pub`;

  if (existsSync(privatePath) && existsSync(publicPath)) {
    return { privatePath, publicKey: (await readFile(publicPath, "utf8")).trim(), created: false };
  }

  // A private half with no public half, refused rather than resolved.
  //
  // Found by its own test, and it was a hang rather than a wrong answer:
  // `ssh-keygen -f` onto an existing file asks "Overwrite (y/n)?" and waits on stdin,
  // which in this process never closes. So a review would sit for ever, the queue
  // would look busy, and nothing would say why — healthy and doing nothing, which is
  // the failure this project exists to refuse.
  //
  // Regenerating would be wrong even if it terminated: the existing private half may
  // be authorized on the forge already, and overwriting it breaks fetching with no
  // visible cause. The public half is recoverable by hand (`ssh-keygen -y -f`), so
  // the message says so rather than leaving a dead end.
  if (existsSync(privatePath)) {
    throw new DidNotRun(
      `${privatePath} exists without ${publicPath}. lore will not overwrite a private key that may already be ` +
        `authorized on the forge. Recover the public half with \`ssh-keygen -y -f ${privatePath} > ${publicPath}\`, ` +
        `or delete both and let a new pair be generated and re-authorized.`,
    );
  }

  try {
    await run("ssh-keygen", [
      "-t", "ed25519",
      "-N", "",                       // no passphrase: nothing is here to type one
      "-C", `lore:${repoName}`,
      "-f", privatePath,
      "-q",
    ], {
      // Belt to the guard's braces. The guard above removes the one prompt this can
      // reach; the timeout means that if a future ssh-keygen finds another, a review
      // fails in thirty seconds instead of hanging until someone notices the queue
      // is not moving. (`execFile` cannot close stdin — it always pipes — so this is
      // the backstop available, not the one I first reached for.)
      timeout: 30_000,
    });
  } catch (e) {
    throw new DidNotRun(`could not generate a deploy key for ${repoName} in ${keysDir}: ${String(e)}`, e);
  }
  await chmod(privatePath, 0o600);

  return { privatePath, publicKey: (await readFile(publicPath, "utf8")).trim(), created: true };
}

/**
 * What `GIT_SSH_COMMAND` must be for git to use this key and only this key.
 *
 * `IdentitiesOnly=yes` is the load-bearing option. Without it ssh offers every
 * identity it can find — including anything an agent has loaded — and a forge accepts
 * the first that works. The fetch would then succeed using a credential nobody
 * intended, most likely the operator's personal key, and lore's per-repo scoping
 * would be a fiction that happened to hold in testing.
 *
 * `BatchMode=yes` turns "ask the human for a password" into an error. There is no
 * human at this end, so the alternative is a fetch that hangs until the timeout.
 *
 * Host keys are pinned to a `known_hosts` inside the keys directory, accepted on
 * first use. Strict checking with no known_hosts refuses every host and makes the
 * service unusable; `no` accepts any host key at any time, which is the one that
 * actually matters — it would let a redirected DNS answer serve a different tree.
 * `accept-new` trusts the first answer and refuses a CHANGE, which is the property
 * worth having here.
 */
export function sshCommandFor(privatePath: string, keysDir: string): string {
  const knownHosts = join(keysDir, "known_hosts");
  return [
    "ssh",
    "-i", quote(privatePath),
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${quote(knownHosts)}`,
    "-o", "ConnectTimeout=20",
  ].join(" ");
}

/**
 * GIT_SSH_COMMAND is parsed by a shell, so a path with a space in it becomes two
 * arguments. Data directories are configurable and `/Users/…/My Data/` is a path a
 * person really does have.
 */
function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * The environment a git command needs to authenticate as this repository's key.
 *
 * Returned as a map rather than set globally: `git()` takes `extraEnv`, and a
 * process-wide `GIT_SSH_COMMAND` would apply to every repository's fetch, which is
 * precisely the cross-repo leak the per-repo key exists to prevent.
 */
export function fetchEnv(key: DeployKey, keysDir: string): Record<string, string> {
  return { GIT_SSH_COMMAND: sshCommandFor(key.privatePath, keysDir) };
}

/**
 * What to tell a human when a fetch fails on authentication.
 *
 * The public key goes in the message. A fetch failing because the key is not
 * authorized yet is the ONE failure that is certain to happen for every new
 * repository — it is the normal first state, not an anomaly — so the message must
 * carry everything needed to fix it rather than sending the reader looking.
 */
export function authorizeInstructions(gitUrl: string, key: DeployKey): string {
  return [
    `lore's deploy key for ${gitUrl} is not authorized yet (or no longer is).`,
    "",
    "Add it as a READ-ONLY deploy key on that repository — for GitHub:",
    "Settings → Deploy keys → Add deploy key. Leave 'Allow write access' UNTICKED;",
    "lore never pushes, and a write key would breach D-2.",
    "",
    key.publicKey,
    "",
    "Until then the mirror can only be refreshed from a host that already has",
    "credentials, with `make mirror REPO=…`.",
  ].join("\n");
}
