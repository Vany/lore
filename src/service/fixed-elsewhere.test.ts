/**
 * D-133's `fixed_elsewhere` field on `review_submit`: a claim that a finding was answered
 * somewhere other than the line it was raised on. Checked over real HTTP against a real
 * worktree, for the same reason `submit-gate.test.ts` and `submit-commit.test.ts` are —
 * the file-in-diff check reads the ACTUALLY APPLIED patch, not a fixture's idea of it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { grantToken } from "../mcp/auth.ts";
import { DEFAULT_HEARTBEAT } from "../ops/heartbeat.ts";
import { consumeHeldDiffs } from "../reviewer/review.ts";
import { Store, type RecordedFinding } from "../store/store.ts";
import { startHttp } from "./http.ts";

let store: Store;
let close: () => void;
let base: string;
let root: string;
let worktree: string;
let token: string;
let portSeq = 43_711;

const g = (...a: string[]) => execFileSync("git", a, { cwd: worktree, stdio: "pipe" }).toString().trim();

const treeNow = () => {
  g("add", "-A");
  return g("write-tree");
};

/**
 * A thrown `Error` from a tool handler surfaces as `isError: true` with the message as
 * plain prose in `content[0].text` — not as JSON — so callers must branch on `isError`
 * before parsing, exactly as `submit-commit.test.ts`'s own helper does.
 */
async function callTool(name: string, args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; isError: boolean }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.includes("data:") ? (raw.split("data:").pop() ?? "") : raw;
  const parsed = JSON.parse(line.trim()) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (parsed.error !== undefined) return { body: { error: parsed.error.message ?? "tool error" }, isError: true };
  const text = parsed.result?.content?.[0]?.text ?? "{}";
  const isError = parsed.result?.isError === true;
  if (isError) return { body: { error: text }, isError: true };
  return { body: JSON.parse(text) as Record<string, unknown>, isError };
}

const FP = "cafe1111";

const OPEN_FINDING: RecordedFinding = {
  fingerprint: FP,
  file: "src/pay/hold.ts",
  line: 12,
  symbol: "capture",
  severity: "high",
  claim: "double release",
  evidence: "ev",
  failureScenario: "scenario",
  origin: "t1",
  round: 1,
  firstSeen: "2026-08-03T00:00:00.000Z",
};

const DIFF =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+b\n" +
  "diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-x\n+y\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-fixed-elsewhere-"));
  worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: worktree, stdio: "pipe" });
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
  writeFileSync(join(worktree, "f.txt"), "a\n");
  writeFileSync(join(worktree, "other.ts"), "x\n");
  g("add", "-A");
  g("commit", "-qm", "base");

  store = new Store(":memory:");
  const repo = store.upsertRepo("demo", "git@x:demo.git");
  token = grantToken(store, repo.id, "alice");
  store.createReview({
    id: "revFix",
    repoId: repo.id,
    principal: "alice",
    branch: "feat/x",
    intoRef: "main",
    ticket: "t",
    type: "code-arch",
    // Parked, so the submit takes the synchronous apply path (submit-gate.test.ts's
    // own reasoning) — fixed_elsewhere is validated the same way on the held path, but
    // these tests need `will_not_settle`, which is only computed once applied.
    state: "findings_ready",
    ladder: { ...initialState(), round: 5 },
  });
  store.recordFinding("revFix", OPEN_FINDING);

  const port = ++portSeq;
  base = `http://127.0.0.1:${port}`;
  ({ close } = startHttp(
    store,
    { store, worktreeFor: async () => worktree, enqueue: () => undefined, attest: async () => "lore: attested" },
    { port, host: "127.0.0.1", heartbeat: { ...DEFAULT_HEARTBEAT, dataDir: "/tmp" }, allowMetered: false },
  ));
});

afterEach(() => {
  close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * The tree hash for `DIFF` applied — lore applies the patch itself, so the worktree must
 * stand at the PRE-patch state when the submit arrives (`submit-gate.test.ts`'s dance).
 */
const afterApplyTreeHash = (): string => {
  writeFileSync(join(worktree, "f.txt"), "b\n");
  writeFileSync(join(worktree, "other.ts"), "y\n");
  const after = treeNow();
  writeFileSync(join(worktree, "f.txt"), "a\n");
  writeFileSync(join(worktree, "other.ts"), "x\n");
  g("add", "-A");
  return after;
};

describe("review_submit fixed_elsewhere (D-133)", () => {
  it("records a valid claim and omits it from will_not_settle", async () => {
    const after = afterApplyTreeHash();

    const { body, isError } = await callTool("review_submit", {
      review_id: "revFix",
      diff: DIFF,
      tree_hash: after,
      fixed_elsewhere: [{ fingerprint: FP, file: "other.ts", reason: "moved the release call here" }],
    });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body["fixed_elsewhere_skipped"]).toBeUndefined();
    // THE REGRESSION THIS GUARDS: OPEN_FINDING has no `scope`, so `codeMoved` alone
    // never excludes it, and nothing writes a `lore-ok` marker in this test — without
    // reading this call's own `fixed_elsewhere` set, the preview would list a finding
    // the client just answered as "will not settle", the exact fires-on-the-correct-
    // answer nag `alreadyAnswered`'s own doc comment warns trains clients to skip it.
    const willNotSettle = (body["will_not_settle"] as { fingerprint: string }[] | undefined) ?? [];
    expect(willNotSettle.map((f) => f.fingerprint)).not.toContain(FP.slice(0, 8));

    expect(store.fixedElsewhereFor("revFix")).toStrictEqual([
      { fingerprint: FP, file: "other.ts", line: undefined, reason: "moved the release call here" },
    ]);
  });

  it("refuses the whole call when the fingerprint was never raised", async () => {
    const after = afterApplyTreeHash();

    const { body, isError } = await callTool("review_submit", {
      review_id: "revFix",
      diff: DIFF,
      tree_hash: after,
      fixed_elsewhere: [{ fingerprint: "deadbeef", file: "other.ts", reason: "nope" }],
    });

    expect(isError, JSON.stringify(body)).toBe(true);
    expect(String(body["error"])).toMatch(/has never raised/);
    expect(store.fixedElsewhereFor("revFix")).toStrictEqual([]);
  });

  it("refuses the whole call when the named file is not part of this submission", async () => {
    const after = afterApplyTreeHash();

    const { body, isError } = await callTool("review_submit", {
      review_id: "revFix",
      diff: DIFF,
      tree_hash: after,
      fixed_elsewhere: [{ fingerprint: FP, file: "nowhere.ts", reason: "nope" }],
    });

    expect(isError, JSON.stringify(body)).toBe(true);
    expect(String(body["error"])).toMatch(/not part of this/);
    expect(store.fixedElsewhereFor("revFix")).toStrictEqual([]);
  });

  it("skips, but reports, a claim naming a finding an earlier round already settled", async () => {
    store.recordVerdict("revFix", {
      fingerprint: FP,
      verdict: "fixed",
      rationale: undefined,
      scope: undefined,
      tier: undefined,
      round: 4,
    });
    const after = afterApplyTreeHash();

    const { body, isError } = await callTool("review_submit", {
      review_id: "revFix",
      diff: DIFF,
      tree_hash: after,
      fixed_elsewhere: [{ fingerprint: FP, file: "other.ts", reason: "already handled" }],
    });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body["fixed_elsewhere_skipped"]).toStrictEqual([FP]);
    expect(store.fixedElsewhereFor("revFix")).toStrictEqual([]);
  });

  // Regression for fingerprint cf48ccb1: `resolveShort` has a THIRD outcome besides
  // "resolves" and "does not resolve" — it throws when the short prefix matches more
  // than one finding (spec/review-ladder.md §3.1.2). Left uncaught, that exception
  // still refuses the call (any throw in the handler becomes isError:true), but with
  // no D-133 framing and no mention that the diff itself may already have applied.
  it("names the ambiguity clearly when the fingerprint prefix matches two findings", async () => {
    store.recordFinding("revFix", { ...OPEN_FINDING, fingerprint: "beef22221", file: "src/a.ts" });
    store.recordFinding("revFix", { ...OPEN_FINDING, fingerprint: "beef22222", file: "src/b.ts" });
    const after = afterApplyTreeHash();

    const { body, isError } = await callTool("review_submit", {
      review_id: "revFix",
      diff: DIFF,
      tree_hash: after,
      fixed_elsewhere: [{ fingerprint: "beef2222", file: "other.ts", reason: "which one?" }],
    });

    expect(isError, JSON.stringify(body)).toBe(true);
    // NOT JUST /ambiguous/i: the raw, uncaught AmbiguousFingerprint already says that
    // ("fingerprint 'X' is ambiguous — N findings share it: ..."), so that alone would
    // pass whether or not the catch below exists. What the fix actually adds is the
    // D-133 framing — naming the field — which the raw message never does.
    expect(String(body["error"])).toMatch(/ambiguous/i);
    expect(String(body["error"])).toMatch(/fixed_elsewhere/i);
    expect(store.fixedElsewhereFor("revFix")).toStrictEqual([]);
  });

  // Regression for fingerprint d2c5ca38: a claim recorded immediately, regardless of
  // whether its diff is applied or held, survives a held diff that later fails to
  // verify — a claim with nothing behind it, exactly what the file-in-diff check
  // exists to refuse. The fix defers persistence: the claim rides with the held_diff
  // row and is promoted only once consumeHeldDiffs confirms THAT diff actually landed.
  it("does not promote a fixed_elsewhere claim carried by a held diff that fails to verify at consume time", async () => {
    store.enqueue("revFix", "fast"); // hasPendingRound("revFix") -> true

    const { body, isError } = await callTool("review_submit", {
      review_id: "revFix",
      diff: DIFF,
      // Deliberately wrong: the raw-diff form is not verified against tree_hash until
      // consume time (D-107), so this reaches consumeHeldDiffs unexamined.
      tree_hash: "0".repeat(40),
      fixed_elsewhere: [{ fingerprint: FP, file: "other.ts", reason: "moved it" }],
    });
    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body["status"]).toBe("held");

    // Carried, not yet promoted.
    expect(store.fixedElsewhereFor("revFix")).toStrictEqual([]);
    const held = store.heldDiffs("revFix");
    expect(held).toHaveLength(1);
    expect(held[0]?.fixedElsewhere).toStrictEqual([{ fingerprint: FP, file: "other.ts", line: undefined, reason: "moved it" }]);

    const result = await consumeHeldDiffs(store, "revFix", worktree);
    expect(result.mismatch, "the claimed tree_hash cannot match what DIFF actually produces").toBeDefined();

    // THE FIX: the claim is discarded along with the diff it rode in on, not silently
    // promoted against evidence that never actually landed in the tree.
    expect(store.fixedElsewhereFor("revFix")).toStrictEqual([]);
    expect(store.heldDiffs("revFix")).toStrictEqual([]);
  });
});
