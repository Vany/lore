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

  it("counts the tiers that actually ran", async () => {
    review("passed");
    store.recordTierRun("r1", "t0", 1, "clean", "2026-08-03T00:00:00.000Z");
    store.recordTierRun("r1", "t1", 1, "fastClean", "2026-08-03T00:00:00.000Z");
    store.recordTierRun("r1", "t2", 2, "escalate", "2026-08-03T00:00:00.000Z");
    store.recordTierRun("r1", "t3", 3, "passed", "2026-08-03T00:00:00.000Z");
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
