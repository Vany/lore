/**
 * What the operator sees when they ask what this project has decided not to enforce.
 *
 * The one assertion that matters is the SILENCING line. A rule list on its own reads as
 * harmless prose — it is only when a rule is shown with the checks it has actually
 * switched off that anyone can tell an agreed decision from a hole nobody meant.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { addRule, renderRules, ruleReport } from "./rules.ts";

const setup = (): { store: Store; repoId: string } => {
  const store = new Store(":memory:");
  return { store, repoId: store.upsertRepo("demo", "git@example.com:demo.git").id };
};

describe("the operator's view of development rules", () => {
  it("says plainly when there are none, and how to add one", () => {
    const { store, repoId } = setup();
    try {
      expect(renderRules(ruleReport(store, repoId))).toContain("no development rules");
    } finally {
      store.close();
    }
  });

  it("distinguishes a rule that has silenced nothing from one that has", () => {
    const { store, repoId } = setup();
    try {
      const quiet = addRule(store, repoId, { statement: "prefer named exports", why: "greppable", by: "vany" });
      const loud = addRule(store, repoId, { statement: "services bind 0.0.0.0", why: "overlay", by: "vany" });
      store.recordSuppression({
        repoId,
        ruleClass: "avoid-bind-all",
        path: "src/http.ts",
        policyShort: loud.id.slice(0, 8),
        reviewId: "r1",
        tier: "t1",
      });

      const out = renderRules(ruleReport(store, repoId));
      expect(out).toContain("SILENCING: avoid-bind-all in src/http.ts");
      expect(out).toContain("silencing nothing yet");
      // Each rule carries its own consequence, never the other's.
      const lines = out.split("\n");
      const quietAt = lines.findIndex((l) => l.includes(quiet.id.slice(0, 8)));
      const loudAt = lines.findIndex((l) => l.includes(loud.id.slice(0, 8)));
      expect(lines.slice(quietAt, loudAt).join("\n")).toContain("silencing nothing yet");
      expect(lines.slice(quietAt, loudAt).join("\n")).not.toContain("SILENCING:");
    } finally {
      store.close();
    }
  });

  // Retiring is what makes a suppression reversible, and the row is deliberately kept:
  // it is the record of what earlier reviews did not cover.
  it("drops a retired rule from the list while keeping its suppression on file", () => {
    const { store, repoId } = setup();
    try {
      const rule = addRule(store, repoId, { statement: "services bind 0.0.0.0", why: "overlay", by: "vany" });
      store.recordSuppression({
        repoId, ruleClass: "avoid-bind-all", path: "src/http.ts",
        policyShort: rule.id.slice(0, 8), reviewId: "r1", tier: "t1",
      });

      expect(store.isLivePolicy(repoId, rule.id.slice(0, 8))).toBe(true);
      expect(store.retirePolicy(repoId, rule.id.slice(0, 8), "moved off the overlay")).toBe("retired");
      expect(ruleReport(store, repoId).rules).toStrictEqual([]);
      expect(store.liveSuppressions(repoId)).toStrictEqual([]);
      expect(store.isLivePolicy(repoId, rule.id.slice(0, 8))).toBe(false);
      // The row survives the rule on purpose: it is the record of what earlier reviews
      // did not cover, and deleting it would erase the only evidence of the gap.
      expect((store.db.prepare("SELECT COUNT(*) c FROM suppression").get() as { c: number }).c).toBe(1);
    } finally {
      store.close();
    }
  });

  // Re-accepting the same appeal must refresh the row, not stack another one — otherwise
  // the operator's view fills with the same line dated differently.
  it("keeps one row per rule class and path however often it is re-accepted", () => {
    const { store, repoId } = setup();
    try {
      const rule = addRule(store, repoId, { statement: "services bind 0.0.0.0", why: "overlay", by: "vany" });
      for (const tier of ["t1", "t2", "t3"]) {
        store.recordSuppression({
          repoId, ruleClass: "avoid-bind-all", path: "src/http.ts",
          policyShort: rule.id.slice(0, 8), reviewId: "r1", tier,
        });
      }
      expect(store.liveSuppressions(repoId).map((s) => s.tier)).toStrictEqual(["t3"]);
    } finally {
      store.close();
    }
  });

  // a6a4b832/c7235bcb, found by lore's own review: `short` reached `id LIKE
  // '${short}%'` with no character gate, so `%`/`_` are SQL wildcards, not literal
  // text. With exactly one live rule, "%%%%" (4 chars, passes the schema's min(4))
  // matched it and would have retired a rule nobody identified. `cite_as` — the
  // only value this parameter is documented to hold — is always hex, so a hex-only
  // gate costs nothing legitimate.
  it("refuses a wildcard pattern rather than silently matching every live rule", () => {
    const { store, repoId } = setup();
    try {
      addRule(store, repoId, { statement: "services bind 0.0.0.0", why: "overlay", by: "vany" });

      expect(store.retirePolicy(repoId, "%%%%", "not a real id")).toBe("not-found");
      expect(store.retirePolicy(repoId, "____", "not a real id")).toBe("not-found");
      expect(ruleReport(store, repoId).rules, "the real rule must survive untouched").toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
