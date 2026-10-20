/**
 * The contest ledger's one function, against each member state the old sets each missed.
 */

import { describe, expect, it } from "vitest";
import { ContestLedger, rule } from "./contest-ledger.ts";

const RANK: Record<string, number> = { t1: 1, t2: 2, t3: 3 };
const rankOf = (m: string) => RANK[m] ?? -1;

describe("rule", () => {
  // Gap 3: each catch-up pass kept its own clock.
  it("keeps a re-raise made after a LATER fix standing, whatever an earlier pass said before an earlier fix", () => {
    const l = new ContestLedger();
    l.record({ kind: "emit", member: "t2", fingerprint: "A", route: "k3" }); // pass 1, before fix 1
    l.record({ kind: "saw-fix", member: "t2" }); // fix 1
    l.record({ kind: "ended", member: "t2", how: "done" });
    l.record({ kind: "saw-fix", member: "t2" }); // catch-up opener: fix 2
    l.record({ kind: "emit", member: "t2", fingerprint: "A", route: "k3" }); // raised again
    l.record({ kind: "ended", member: "t2", how: "done" });
    expect(rule(l.events, ["t2"], rankOf).standing.has("A")).toBe(true);
  });

  it("releases a finding whose every raise was followed by its member seeing a fix", () => {
    const l = new ContestLedger();
    l.record({ kind: "emit", member: "t2", fingerprint: "A", route: undefined });
    l.record({ kind: "saw-fix", member: "t2" });
    l.record({ kind: "ended", member: "t2", how: "done" });
    const r = rule(l.events, ["t2"], rankOf);
    expect(r.contested.has("A"), "it was raised, so a justification of it is refused").toBe(true);
    expect(r.standing.has("A"), "but the member saw the fix and fell silent").toBe(false);
  });

  // A fix shown to ANOTHER member is not this member's silence.
  it("does not release on a fix only a sibling was shown", () => {
    const l = new ContestLedger();
    l.record({ kind: "emit", member: "t2", fingerprint: "A", route: undefined });
    l.record({ kind: "saw-fix", member: "t3" });
    expect(rule(l.events, ["t2", "t3"], rankOf).standing.has("A")).toBe(true);
  });

  // Gap 2: the strongest member that COMPLETED carried acceptance.
  it("calls a weaker member's silence UNKNOWN when the stronger one died", () => {
    const l = new ContestLedger();
    l.record({ kind: "ended", member: "t2", how: "done" });
    l.record({ kind: "ended", member: "t3", how: "skipped" });
    const a = rule(l.events, ["t2", "t3"], rankOf).acceptance(rankOf("t3"));
    expect(a.kind).toBe("unknown");
    if (a.kind !== "unknown") return;
    expect(a.reask).toStrictEqual(["t3"]);
    expect(a.why).toMatch(/t3 did not finish/);
    expect(a.why).toMatch(/t2 finished, but a weaker tier's silence/);
  });

  it("accepts on the strongest finisher at or above the raising tier", () => {
    const l = new ContestLedger();
    l.record({ kind: "ended", member: "t2", how: "done" });
    l.record({ kind: "ended", member: "t3", how: "skipped" });
    expect(rule(l.events, ["t2", "t3"], rankOf).acceptance(rankOf("t2"))).toStrictEqual({ kind: "accepted", by: "t2" });
  });

  it("is unknown when no member at that rank was in the round at all", () => {
    const l = new ContestLedger();
    l.record({ kind: "ended", member: "t1", how: "done" });
    const a = rule(l.events, ["t1"], rankOf).acceptance(rankOf("t3"));
    expect(a).toMatchObject({ kind: "unknown", reask: [] });
  });

  // Gap 1: a rung whose members all died still ruled on nothing.
  it("counts a dead member's raise as a contest, and lets nobody accept", () => {
    const l = new ContestLedger();
    l.record({ kind: "emit", member: "t3", fingerprint: "A", route: "gpt" });
    l.record({ kind: "ended", member: "t3", how: "skipped" });
    l.record({ kind: "ended", member: "t2", how: "skipped" });
    const r = rule(l.events, ["t2", "t3"], rankOf);
    expect(r.contested.has("A")).toBe(true);
    expect(r.lastRaise("A")).toMatchObject({ member: "t3", route: "gpt" });
    expect(r.acceptance(rankOf("t2")).kind).toBe("unknown");
  });

  it("keeps a member that finished once as finished when a later catch-up gives up", () => {
    const l = new ContestLedger();
    l.record({ kind: "ended", member: "t3", how: "done" });
    l.record({ kind: "ended", member: "t3", how: "gave-up" });
    expect(rule(l.events, ["t3"], rankOf).acceptance(rankOf("t3"))).toStrictEqual({ kind: "accepted", by: "t3" });
  });

  it("quotes the latest raise at the highest rank", () => {
    const l = new ContestLedger();
    l.record({ kind: "emit", member: "t3", fingerprint: "A", route: "r1" });
    l.record({ kind: "emit", member: "t2", fingerprint: "A", route: "r2" });
    l.record({ kind: "emit", member: "t3", fingerprint: "A", route: "r3" });
    expect(rule(l.events, ["t2", "t3"], rankOf).lastRaise("A")).toMatchObject({ member: "t3", route: "r3" });
  });

  it("hands every event to its sink, numbered on one clock", () => {
    const seen: number[] = [];
    const l = new ContestLedger((e) => seen.push(e.seq));
    l.record({ kind: "saw-fix", member: "t2" });
    l.record({ kind: "ended", member: "t3", how: "done" });
    expect(seen).toStrictEqual([0, 1]);
  });
});
