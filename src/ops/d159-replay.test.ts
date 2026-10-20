/**
 * The D-159 replay: where the ledger's acceptance rule would have decided differently on
 * stored verdicts. Report-only — nothing is written.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { replayAcceptances } from "./d159-replay.ts";

let store: Store;
let repoId: string;
const TIERS = "t0:deterministic:-:fast:r-,t1:a/m:medium:fast:r-,t2:b/m:high:deep:r2,t3:c/m:high:deep:r2";

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
  store.createReview({
    id: "r1", repoId, principal: "p", branch: "feat/x", intoRef: "main",
    ticket: "t", type: "code-arch", state: "passed", ladder: initialState(),
  });
  store.db.prepare("UPDATE review SET tiers = ? WHERE id = 'r1'").run(TIERS);
  const finding = (fp: string, origin: string) =>
    store.recordFinding("r1", {
      fingerprint: fp, file: "a.ts", severity: "high", claim: `c ${fp}`, evidence: "e",
      failureScenario: "s", origin, round: 1, firstSeen: "2026-10-01T00:00:00.000Z",
    });
  finding("aaaa1111", "t3");
  finding("bbbb2222", "t2");
  // A t3 question accepted on t2's silence: the gap.
  store.recordVerdict("r1", { fingerprint: "aaaa1111", verdict: "justified-accepted", rationale: "fine", scope: undefined, tier: "t2", round: 2 });
  // A t2 question accepted by t2: what the rule allows.
  store.recordVerdict("r1", { fingerprint: "bbbb2222", verdict: "justified-accepted", rationale: "fine", scope: undefined, tier: "t2", round: 2 });
});

afterEach(() => store.close());

describe("replayAcceptances", () => {
  it("names an acceptance a weaker tier carried for a stronger tier's finding", () => {
    const r = replayAcceptances(store);
    expect(r.differ.map((d) => [d.fingerprint.slice(0, 8), d.acceptedBy, d.raisedBy])).toStrictEqual([["aaaa1111", "t2", "t3"]]);
    expect(r.checked).toBe(2);
  });

  it("writes nothing", () => {
    const before = store.db.prepare("SELECT COUNT(*) c FROM verdict").get() as { c: number };
    replayAcceptances(store);
    expect(store.db.prepare("SELECT COUNT(*) c FROM verdict").get()).toStrictEqual(before);
  });
});
