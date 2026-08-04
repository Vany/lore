/**
 * The attestation is the one output the whole service exists to produce, so every
 * number in it has to be true and every refusal has to hold.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { attest, render, verifyAttestation } from "./attest.ts";

let store: Store;
let dir: string;
let keyPath: string;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-attest-"));
  keyPath = join(dir, "key.pem");
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function review(state: string): void {
  store.createReview({
    id: "r1", repoId, principal: "p", branch: "feat/x", intoRef: "main",
    ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    treeHash: "4f2a9c1",
  });
  store.db.prepare("UPDATE review SET state = ? WHERE id = 'r1'").run(state);
}

describe("attest", () => {
  it("refuses anything that has not passed", async () => {
    for (const state of ["running", "fast_clean", "needs_human", "failed", "expired", "findings_ready"]) {
      review(state);
      // An attestation for an incomplete review would be a false claim, and the
      // whole product is that this claim can be trusted.
      await expect(attest(store, "r1", "p", keyPath)).rejects.toThrow(/not 'passed'/);
      store.db.prepare("DELETE FROM review WHERE id = 'r1'").run();
    }
  });

  it("refuses a review belonging to someone else", async () => {
    review("passed");
    await expect(attest(store, "r1", "mallory", keyPath)).rejects.toThrow();
  });

  // Outcomes here are the ones a TIER writes — clean, findings, failed, unpayable —
  // and never a ladder decision kind. The fixture used to say `fastClean`,
  // `escalate` and `passed`, which was accurate while `runRound` closed the row a
  // second time with `stepped.decision.kind`, and became fiction the moment that
  // stopped. Nothing caught it: `countTiers` reads DISTINCT tier and ignores the
  // outcome entirely, so the attestation — the one artefact this product exists to
  // produce — was being proved against a database state that can no longer occur.
  // Raised by t1 against this branch (d17c92f8).
  it("counts the tiers that actually ran", async () => {
    review("passed");
    store.recordTierRun("r1", "t0", 1, "clean", "2026-08-03T00:00:00.000Z");
    store.recordTierRun("r1", "t1", 1, "clean", "2026-08-03T00:00:00.000Z");
    store.recordTierRun("r1", "t2", 2, "findings", "2026-08-03T00:00:00.000Z");
    store.recordTierRun("r1", "t3", 3, "clean", "2026-08-03T00:00:00.000Z");
    // Repeats of the same tier are one tier, not four.
    store.recordTierRun("r1", "t1", 4, "clean", "2026-08-03T00:00:00.000Z");

    const a = await attest(store, "r1", "p", keyPath);
    expect(a.line).toContain("4 tiers");
  });

  it("counts findings, fixes and justifications truthfully", async () => {
    review("passed");
    for (const fp of ["aaaa1111", "bbbb2222", "cccc3333"]) {
      store.recordFinding("r1", {
        fingerprint: fp, file: "a.ts", severity: "low", claim: `c ${fp}`,
        evidence: "e", failureScenario: "s", origin: "t1", round: 1,
        firstSeen: "2026-08-03T00:00:00.000Z",
      });
    }
    store.recordVerdict("r1", { fingerprint: "aaaa1111", verdict: "fixed", rationale: undefined, scope: undefined, tier: "t1", round: 1 });
    store.recordVerdict("r1", { fingerprint: "bbbb2222", verdict: "fixed", rationale: undefined, scope: undefined, tier: "t1", round: 1 });
    store.recordVerdict("r1", { fingerprint: "cccc3333", verdict: "justified-accepted", rationale: "bounded upstream", scope: undefined, tier: "t2", round: 2 });

    const a = await attest(store, "r1", "p", keyPath);
    expect(a.line).toContain("3 findings");
    expect(a.line).toContain("2 fixed");
    expect(a.line).toContain("1 justified");
  });

  // It says what was checked. It does not say the code is correct — "our models
  // stopped finding things" does not imply "no defects remain".
  it("claims what was done, never that the code is correct", async () => {
    review("passed");
    const a = await attest(store, "r1", "p", keyPath);
    expect(a.line).toContain("reviewed tree 4f2a9c1");
    expect(a.line).not.toMatch(/correct|safe|perfect|no bugs|flawless/i);
  });

  it("signs a tree hash, so a moved branch is detectable", async () => {
    review("passed");
    const a = await attest(store, "r1", "p", keyPath);
    expect(a.line).toContain("4f2a9c1");
    expect(verifyAttestation(a)).toBe(true);
  });

  it("does not verify if the line is altered", async () => {
    review("passed");
    const a = await attest(store, "r1", "p", keyPath);
    expect(verifyAttestation({ ...a, line: `${a.line} and the code is perfect` })).toBe(false);
  });

  it("reuses the key across calls, so old attestations keep verifying", async () => {
    review("passed");
    const first = await attest(store, "r1", "p", keyPath);
    const second = await attest(store, "r1", "p", keyPath);
    expect(second.publicKey).toBe(first.publicKey);
    expect(verifyAttestation(first)).toBe(true);
  });

  it("renders with the signature attached", async () => {
    review("passed");
    expect(render(await attest(store, "r1", "p", keyPath))).toMatch(/\[ed25519:[A-Za-z0-9+/=]+\]$/);
  });
});

// Both defects the FIRST attestation ever produced showed on sight. It read
// "reviewed tree unknown ... 1 findings, 0 fixed, 3 justified" for a review with
// one finding: the tree column was only ever written by review_submit, and the
// tally counted verdict ROWS while D-51 carries a justification forward once per
// round.
describe("the artefact has to describe the review", () => {
  it("counts each finding once, by its latest verdict", async () => {
    review("passed");
    store.recordFinding("r1", {
      fingerprint: "aaaa1111", file: "a.ts", severity: "low", claim: "c",
      evidence: "e", failureScenario: "s", origin: "t1", round: 1,
      firstSeen: "2026-08-03T00:00:00.000Z",
    });
    // Carried three times, exactly as a three-round review does.
    for (const round of [1, 2, 3]) {
      store.recordVerdict("r1", {
        fingerprint: "aaaa1111", verdict: "justified-accepted",
        rationale: "carried", scope: undefined, tier: "carried", round,
      });
    }

    const a = await attest(store, "r1", "p", keyPath);
    expect(a.line).toContain("1 findings");
    expect(a.line).toContain("1 justified");
  });

  it("counts a finding under its latest verdict only, never both", async () => {
    review("passed");
    store.recordFinding("r1", {
      fingerprint: "bbbb2222", file: "b.ts", severity: "low", claim: "c",
      evidence: "e", failureScenario: "s", origin: "t1", round: 1,
      firstSeen: "2026-08-03T00:00:00.000Z",
    });
    store.recordVerdict("r1", { fingerprint: "bbbb2222", verdict: "justified-accepted", rationale: "r", scope: undefined, tier: "t1", round: 1 });
    store.recordVerdict("r1", { fingerprint: "bbbb2222", verdict: "fixed", rationale: undefined, scope: undefined, tier: "t1", round: 2 });

    const a = await attest(store, "r1", "p", keyPath);
    expect(a.line).toContain("1 fixed");
    expect(a.line).toContain("0 justified");
  });
});

// The `?? "unknown"` that produced the first attestation's worst line. A signed
// artefact that cannot name its subject is worse than none: it looks verified.
it("refuses to sign a passed review that recorded no tree", async () => {
  store.createReview({
    id: "r2", repoId, principal: "p", branch: "b", intoRef: "origin/main",
    ticket: "t", type: "code-arch", state: "passed", ladder: initialState(),
  });
  await expect(attest(store, "r2", "p", keyPath)).rejects.toThrow(/no tree hash/);
});
