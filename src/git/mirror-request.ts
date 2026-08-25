/**
 * Asking the host to fetch, and waiting for it — because lore cannot fetch itself.
 *
 * Vany: *"branch missing → refresh mirror. Mirror refreshed and no branch → error."* The
 * rule is right and lore cannot carry it out alone: the container has no ssh key, no agent
 * socket and no business having either (D-65). The host already authenticates to the forge
 * as a person allowed to read these repositories, and `mirror-refresh.sh` is where that
 * credential is used.
 *
 * **The channel is the shared data directory**, which is bind-mounted at the SAME absolute
 * path on both sides — the only thing container and host already agree on. No port to
 * open, no secret to distribute, no docker socket. lore drops a request, the host's loop
 * fetches, and the request is deleted to say it is done.
 *
 * **The heartbeat is what makes the failure honest.** A request nobody consumes is
 * indistinguishable from a fetch in progress, and waiting a minute for a daemon that is not
 * running would turn a one-second refusal into a slow one. So the loop stamps a heartbeat
 * every pass, and lore reads it first: no recent heartbeat means nobody is listening, said
 * immediately and naming the fix, rather than waited out.
 *
 * SPEC: SPEC.md D-100, D-65
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the two sides meet. Both names live here so they cannot drift apart. */
export const REQUEST_FILE = "mirror-request";
export const HEARTBEAT_FILE = "mirror-heartbeat";
/**
 * The request MID-FETCH: the host renames the request here before it fetches, and
 * removes it after (`mirror-refresh.sh`). The rename exists so a request arriving DURING
 * a fetch gets its own pass; this constant exists because lore read only the original
 * name and treated the rename as completion — reproduced live on 2026-08-14: a
 * just-pushed branch failed its review with "lore asked the host to fetch … not a timing
 * problem" while the fetch was mid-flight, and the branch was in the mirror seconds
 * later. Raised by lore's own t2 against the rename fix, and it was right.
 */
export const SERVING_FILE = `${REQUEST_FILE}.serving`;

/**
 * How stale a heartbeat may be before we call the watcher dead.
 *
 * Generous against `mirror-refresh.sh`'s own per-repo fetch timeout (`FETCH_TIMEOUT`,
 * default 240s, `LORE_MIRROR_TIMEOUT` to change it on the host), not against the loop's
 * outer period — found by lore's own review: this used to be 90s with that same "generous
 * against the loop's own period" reasoning, but the loop's `beat` used to run only BETWEEN
 * full passes, and one pass is every registered repo's fetch, sequentially, each up to
 * `FETCH_TIMEOUT` — so a legitimate mid-pass gap with two or more repos already exceeded
 * 90s, and grew without bound as more repos were registered. `mirror-refresh.sh` now beats
 * after every repo, not only between passes, which bounds the real gap at one repo's
 * timeout regardless of how many are registered — but this constant assumes the DEFAULT
 * `FETCH_TIMEOUT`; a deployment that raises `LORE_MIRROR_TIMEOUT` needs this raised to
 * match, since nothing here can see that host-side env var.
 */
export const HEARTBEAT_STALE_MS = 300_000;

/**
 * How long to wait for the host to consume the request before giving up on it.
 *
 * Found by lore's own review, the same underlying gap as `HEARTBEAT_STALE_MS` above:
 * `serve_requests` answers ANY on-demand request by running a full `one_pass` — every
 * registered repo, sequentially, each up to `FETCH_TIMEOUT` (default 240s) — not a
 * targeted fetch of the one repo the caller actually needs. This is `addWorktree`'s
 * SYNCHRONOUS path (a client that just pushed and immediately asked for a review, the
 * exact D-100 shape this whole mechanism exists to answer), so timing out here throws
 * `DidNotRun` and fails the review round even though the daemon is alive and
 * correctly working.
 *
 * lore-ok[dcaac29b]: was 90_000, raised to match `HEARTBEAT_STALE_MS` — found wrong by
 * lore's own review, against my own reasoning in this same comment: the previous
 * version claimed 90s "closes the common case (one slow repo, comfortably under it)",
 * which its own first paragraph already contradicts — a SINGLE legitimate fetch can
 * take up to `FETCH_TIMEOUT` (240s default), and 90 is not comfortably under 240, it
 * is under it by less than half. The reason given for staying smaller than
 * `HEARTBEAT_STALE_MS` — "a client's own MCP transport may time out a single call
 * well before 300s" — was never verified against an actual number anywhere in this
 * codebase or its docs, while the failure this shortness causes is real and
 * reproduced: a healthy daemon, mid-fetch, reported as unreachable, failing a review
 * round that per this repo's own CLAUDE.md blocks a push. An unverified risk of a
 * slower call loses to a confirmed one of a wrong, unrecoverable-by-retry answer, so
 * this now shares `HEARTBEAT_STALE_MS`'s margin against the same `FETCH_TIMEOUT`
 * ceiling rather than guessing a smaller number under it. Kept as a separate constant
 * from `HEARTBEAT_STALE_MS` regardless, because they answer different questions (is
 * anyone listening, at all, vs. how long this one call personally waits) even though
 * today they share a value.
 *
 * Still bounded by the SAME per-repo-granularity gap TODO.md already tracks ("A
 * COMPLETED SYNC PASS IS NOT A PER-REPO GUARANTEE") and deliberately defers as its own
 * change: on a deployment with several repos all needing a fetch in the same pass,
 * this can still fire before `one_pass` returns, no matter how generous. That case is
 * unchanged by this fix and not what this fix claims to close — only the single-repo
 * case is.
 */
export const REFRESH_TIMEOUT_MS = 300_000;

export interface RefreshOutcome {
  /** Did a fetch actually happen while we waited? */
  readonly fetched: boolean;
  /** What to tell the client when it did not — never a bare false. */
  readonly why?: string;
}

/**
 * Ask the host to refresh its mirrors, and wait until it has.
 *
 * Never throws: the caller is about to produce a much better error than this could — it
 * knows the branch, the repository and what the client should do — so a failure here is a
 * SENTENCE, not an exception.
 */
export async function requestMirrorRefresh(
  dataDir: string,
  now: () => number = Date.now,
  timeoutMs = REFRESH_TIMEOUT_MS,
): Promise<RefreshOutcome> {
  const request = join(dataDir, REQUEST_FILE);
  const heartbeat = join(dataDir, HEARTBEAT_FILE);

  const beat = await stat(heartbeat).then(
    (s) => s.mtimeMs,
    () => undefined,
  );
  if (beat === undefined) {
    return {
      fetched: false,
      why:
        "lore asked its host to sync with origin and found no sync process running at all " +
        "(no heartbeat). On the lore host: `make mirror-daemon`.",
    };
  }
  const age = now() - beat;
  if (age > HEARTBEAT_STALE_MS) {
    return {
      fetched: false,
      why:
        `lore asked its host to sync with origin, but the sync process last reported ` +
        `${Math.round(age / 1000)}s ago and is not answering. On the lore host: check ` +
        "`mirror.log`, then `make mirror-daemon`.",
    };
  }

  try {
    await mkdir(dataDir, { recursive: true });
    // The timestamp is for a person reading the file, not for the protocol: the host
    // deletes it to say "done", and the deletion is the whole signal.
    await writeFile(request, `${new Date(now()).toISOString()}\n`, "utf8");
  } catch (e) {
    return { fetched: false, why: `lore could not write a sync request: ${String(e)}` };
  }

  const serving = join(dataDir, SERVING_FILE);
  const deadline = now() + timeoutMs;
  for (;;) {
    // COMPLETION IS BOTH FILES GONE, not one. The request disappearing is only PICKUP —
    // the host renames it aside before fetching — and returning on pickup is how lore
    // re-resolved the branch while the fetch was still running and called the result
    // "not a timing problem".
    const requestGone = await stat(request).then(
      () => false,
      () => true,
    );
    const servingGone = await stat(serving).then(
      () => false,
      () => true,
    );
    if (requestGone && servingGone) return { fetched: true };
    if (now() >= deadline) {
      return {
        fetched: false,
        why:
          `lore asked its host to sync with origin and it had not finished after ` +
          `${Math.round(timeoutMs / 1000)}s. The fetch may still be running; try again shortly.`,
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
