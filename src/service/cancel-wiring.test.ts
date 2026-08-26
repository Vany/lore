/**
 * `review_cancel` must be able to reach the model call it is cancelling.
 *
 * On 2026-08-08 it could not, in the only build that matters. `startHttp` was given
 * `store`, `worktreeFor`, `enqueue` and `attest` — and no reviewer — so the handler's
 * `deps.reviewer?.cancel?.(id)` evaluated to `undefined ?? false` on every cancel the
 * service had ever served. The reply then rendered that `false` as **"No model call was
 * in flight"** while an opencode session opened forty-five seconds earlier went on
 * running and lore's own gate went on holding its provider slot.
 *
 * `Reviewer.cancel`'s comment already says a cancel that only marks a row is worse than
 * no cancel at all, because the operator sees a stopped review and has no reason to
 * suspect it is still billing. That is exactly what shipped, and nothing caught it,
 * because every existing test builds the server the same way production did — without a
 * reviewer — so the broken path was the only path under test.
 *
 * So this file tests the WIRING, through `serve()`, which is the thing that was wrong.
 * A unit test of the handler cannot see this defect: the handler was correct.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { grantToken } from "../mcp/auth.ts";
import { Store } from "../store/store.ts";
import { serve } from "./main.ts";

let dir: string;
let stop: (() => void) | undefined;
let token: string;
const PORT = 17_791;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-cancel-"));
  // Seeded before the service opens the file, so `serve` finds a repo, a token and a
  // review already there. Closed again: two writers on one SQLite file is the fault
  // that cost this project three databases.
  const store = new Store(join(dir, "lore.db"));
  const repo = store.upsertRepo("demo", "git@x:demo.git");
  token = grantToken(store, repo.id, "alice");
  store.createReview({
    id: "rev_cancel_me",
    repoId: repo.id,
    principal: "alice",
    branch: "feat/x",
    intoRef: "main",
    ticket: "do the thing",
    type: "code-arch",
    state: "running",
    ladder: initialState(),
  });
  store.close();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  rmSync(dir, { recursive: true, force: true });
});

// lore-ok[8f44300f]: rule de7fb2b3 — this is the test's own server, bound to 127.0.0.1
// on a fixed port moments earlier and spoken to from the same process. There is no
// transport to encrypt, and no real review, branch or finding exists inside it.
const cancel = async (): Promise<Record<string, unknown>> => {
  const res = await fetch(`http://127.0.0.1:${String(PORT)}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "review_cancel", arguments: { review_id: "rev_cancel_me", reason: "testing the wiring" } },
    }),
  });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data:"));
  const rpc = JSON.parse((line ?? "").slice("data:".length)) as { result?: { content?: { text?: string }[] } };
  return JSON.parse(rpc.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
};

describe("the deployed service's review_cancel", () => {
  /**
   * `null` is the state this test exists to forbid, and `false` is the state it wants.
   *
   * The two are not the same claim and the distinction is the whole point: `false` means
   * *I looked and nothing was running*, `null` means *I could not look*. With no reviewer
   * wired the handler can only honestly say the second, and a client acting on the first
   * would believe a cancelled review had stopped spending.
   *
   * There is genuinely nothing in flight here — no worker has claimed this review — so a
   * correctly wired service answers `false`.
   */
  it("can reach a session to abort, so it answers false rather than 'I could not look'", async () => {
    stop = await serve({
      dataDir: dir,
      port: PORT,
      host: "127.0.0.1",
      allowMetered: false,
    });

    const out = await cancel();

    expect(out["state"]).toBe("cancelled");
    expect(out["stopped_in_flight"], "null means no reviewer was wired — the 2026-08-08 defect").toBe(false);
    // The unwired sentence, in its own words. Not a bare /UNKNOWN/: the ordinary note
    // already says what the remaining tiers would have found is UNKNOWN, and matching
    // that would have passed against the very build this test exists to fail.
    expect(String(out["note"])).not.toMatch(/WHETHER A MODEL CALL IS STILL RUNNING IS UNKNOWN/);
    expect(String(out["note"])).toContain("No model call was in flight");
  });
});

/**
 * "I could not look" must never be reported as "everything is present".
 *
 * `missingModels` collapsed an unreachable opencode, an unexpected response shape, and a
 * fully-verified ladder into the same empty list — and the caller announced the fallback
 * READY on all three. That is INV-1 in the one line an operator reads to believe a plan
 * they will not think about again until a subscription runs out.
 */
describe("verifying the quota fallback at startup", () => {
  it("says UNKNOWN when opencode does not answer with a provider list", async () => {
    // A port nothing is listening on, so the provider fetch cannot succeed.
    const { Reviewer } = await import("../reviewer/opencode.ts");
    const r = new Reviewer({ baseUrl: "http://127.0.0.1:1", agent: "readonly", timeoutMs: 500});

    const answer = await r.missingModels(["openrouter/z-ai/glm-5-turbo"]);

    expect(answer, "undefined is 'could not verify', never 'none missing'").toBeUndefined();
    r.close();
  });

  // dad4747c, found by lore's own review: the fallback-check IIFE's own comment says
  // "NOT FATAL", but it was `void`-discarded with nothing catching the rejection
  // `loadTiers()` produces on a bad LORE_TIERS path — an unhandled rejection, which
  // by Node's default crashes the WHOLE PROCESS, on the very first boot-time reader
  // of a ladder file an operator just edited. Same shape as 8fe4d3ee
  // (heartbeat.test.ts), same verification technique: capture
  // `unhandledRejection` rather than let one actually crash the test runner.
  it("does not let a broken LORE_TIERS escape the boot-time fallback check as an unhandled rejection", async () => {
    const saved = process.env["LORE_TIERS"];
    process.env["LORE_TIERS"] = "/definitely/does/not/exist/tiers.json";

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      stop = await serve({
        dataDir: dir,
        port: PORT,
        host: "127.0.0.1",
        allowMetered: false,
      });
      // The fallback-check IIFE runs fire-and-forget from inside `serve`; give its
      // rejection (if unhandled) time to actually surface as an event.
      await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setImmediate(r));
      expect(rejections, "a broken LORE_TIERS must not crash the process").toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      if (saved === undefined) delete process.env["LORE_TIERS"];
      else process.env["LORE_TIERS"] = saved;
    }
  });
});
