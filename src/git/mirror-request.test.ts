/**
 * Asking the host to fetch, and knowing when nobody is listening.
 *
 * The rule is Vany's: *branch missing → refresh the mirror; refreshed and still no branch
 * → error.* lore cannot fetch (D-65), so it asks the host and waits — and the interesting
 * cases are all about telling "fetching" apart from "nobody is there", because getting
 * that wrong turns a one-second refusal into a forty-five-second one, or worse, reports a
 * missing branch that was seconds from arriving.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS, REQUEST_FILE, requestMirrorRefresh, SERVING_FILE } from "./mirror-request.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-mirror-req-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const beat = (agoMs = 0) => {
  const p = join(dir, HEARTBEAT_FILE);
  writeFileSync(p, "");
  if (agoMs > 0) {
    const at = new Date(Date.now() - agoMs);
    utimesSync(p, at, at);
  }
};

describe("asking the host to fetch", () => {
  /** Stand in for the host loop: notice the request, then answer by deleting it. */
  const hostAnswers = (afterMs: number) =>
    setTimeout(() => rmSync(join(dir, REQUEST_FILE), { force: true }), afterMs);

  /**
   * PICKUP IS NOT COMPLETION — raised by lore's own t2 and reproduced live 2026-08-14. The host renames
   * the request aside BEFORE it fetches; lore watched only the original name, returned
   * "fetched" at the rename, re-resolved the branch mid-fetch, and failed a freshly
   * pushed branch with "not a timing problem" — the branch was in the mirror seconds
   * later. Completion is BOTH files gone.
   */
  it("keeps waiting while the request is being served", async () => {
    beat();
    // The host's real sequence: rename aside, fetch (300ms of it), then remove.
    const pickedUp = setTimeout(() => {
      renameSync(join(dir, REQUEST_FILE), join(dir, SERVING_FILE));
    }, 80);
    const finished = setTimeout(() => rmSync(join(dir, SERVING_FILE), { force: true }), 380);

    const before = Date.now();
    const out = await requestMirrorRefresh(dir);
    clearTimeout(pickedUp);
    clearTimeout(finished);

    expect(out.fetched).toBe(true);
    expect(Date.now() - before, "returned at completion, not at pickup").toBeGreaterThanOrEqual(350);
  });

  it("does not claim a fetch whose serving never ends", async () => {
    beat();
    const pickedUp = setTimeout(() => {
      renameSync(join(dir, REQUEST_FILE), join(dir, SERVING_FILE));
    }, 50);
    const out = await requestMirrorRefresh(dir, Date.now, 400);
    clearTimeout(pickedUp);

    expect(out.fetched).toBe(false);
    expect(String(out.why)).toContain("had not finished");
    rmSync(join(dir, SERVING_FILE), { force: true });
  });

  it("waits for the fetch and reports that it happened", async () => {
    beat();
    const t = hostAnswers(120);
    const out = await requestMirrorRefresh(dir);
    clearTimeout(t);

    expect(out.fetched).toBe(true);
    expect(out.why).toBeUndefined();
  });

  /**
   * THE DELETION IS THE WHOLE PROTOCOL, and it is a deletion rather than a status file
   * because a deletion cannot be half-written. Until it happens, we are still waiting.
   */
  it("does not claim a fetch that never finished", async () => {
    beat();
    const out = await requestMirrorRefresh(dir, Date.now, 300);

    expect(out.fetched).toBe(false);
    expect(out.why).toMatch(/had not finished/);
    // Left in place: the host may still be mid-fetch, and deleting it here would cancel
    // a request that is about to be served.
    expect(existsSync(join(dir, REQUEST_FILE)), "the request stands").toBe(true);
  });

  /**
   * NOBODY LISTENING IS NOT THE SAME AS SLOW, and the difference has to be immediate.
   * Without the heartbeat a review would wait its entire timeout for a daemon that is
   * not running — turning a fast, correct refusal into a slow one, on every review.
   */
  it("refuses at once when no refresher has ever run", async () => {
    const started = Date.now();
    const out = await requestMirrorRefresh(dir, Date.now, 10_000);

    expect(out.fetched).toBe(false);
    expect(out.why).toMatch(/no sync process running at all/);
    expect(out.why, "and names the fix, since the client cannot apply it").toMatch(/make mirror-daemon/);
    expect(Date.now() - started, "immediately, not after the timeout").toBeLessThan(1_000);
  });

  it("refuses at once when the refresher has stopped reporting", async () => {
    beat(HEARTBEAT_STALE_MS + 60_000);
    const out = await requestMirrorRefresh(dir, Date.now, 10_000);

    expect(out.fetched).toBe(false);
    expect(out.why).toMatch(/not answering/);
    // The AGE, because "not answering" without a number is a claim nobody can check.
    expect(out.why).toMatch(/\d+s ago/);
  });

  /**
   * A pass that is mid-fetch on a large repository writes no heartbeat for as long as
   * that fetch takes. Calling it dead then would refuse a review because the host was
   * busy doing the very thing it was asked to do.
   */
  it("still asks while the heartbeat is merely old, not stale", async () => {
    beat(HEARTBEAT_STALE_MS - 30_000);
    const t = hostAnswers(120);
    const out = await requestMirrorRefresh(dir);
    clearTimeout(t);

    expect(out.fetched).toBe(true);
  });
});
