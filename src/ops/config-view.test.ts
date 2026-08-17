/**
 * The deployment describing itself (D-118).
 *
 * The failure this guards is not a crash: it is a page that says "0" where the ladder
 * behaves as "1", or that shows a nickname where a metered route is what actually gets
 * called. Both would make the window worse than not having one, because an operator who
 * checked and was misled stops checking.
 */

import { describe, expect, it } from "vitest";
import { configView } from "./config-view.ts";

/** The suite's own ladder is set in vitest.config.ts; these name their env explicitly. */
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, ...over });

describe("the deployment's own shape", () => {
  it("says whether a value was chosen or defaulted", () => {
    const set = configView(env({ LORE_ALLOW_METERED: "1" })).entries.find((e) => e.name === "LORE_ALLOW_METERED");
    expect(set?.value).toBe("1");
    expect(set?.source, "somebody decided this").toBe("set here");

    const unset = configView(env({ LORE_ALLOW_METERED: "" })).entries.find((e) => e.name === "LORE_ALLOW_METERED");
    expect(unset?.value).toBe("0");
    // THE DISTINCTION THE POST-MORTEM NEEDED. "0" alone cannot answer whether anybody
    // chose the behaviour that produced a $101.36 morning.
    expect(unset?.source).toBe("built-in default");
  });

  // A ROW WITH NO ANSWER TO "CAN I CHANGE THIS" invites the reader to assume the page will
  // let them. Nothing here writes, so every row has to say so.
  it("tells the reader how to change every single row", () => {
    for (const e of configView(env()).entries) {
      expect(e.change.length, `${e.name} says nothing about changing it`).toBeGreaterThan(0);
      expect(e.what.length, `${e.name} does not say what it does`).toBeGreaterThan(0);
    }
  });

  /**
   * THE ROUTES, NOT THE NICKNAME. A nickname in a tiers file is not a model id, and the
   * difference is where two of this month's incidents lived — a metered pool member became
   * the primary, and `concreteRoute` handed one to the hourly screen. Showing the
   * configured text alone would reproduce exactly the blindness this window exists to end.
   */
  it("resolves a pooled tier to the routes that will actually be called", () => {
    const tiers = JSON.stringify({
      models: { GLM: ["zai-coding-plan/glm-5.2", "openrouter/z-ai/glm-5.2"] },
      tiers: [
        { id: "t0", kind: "deterministic", stage: "fast" },
        { id: "t1", kind: "model", model: "GLM", stage: "fast" },
      ],
    });
    const v = configView(env({ LORE_TIERS: tiers }));
    const t1 = v.ladder.find((l) => l.tier === "t1");

    expect(t1?.configured, "what the file says").toBe("GLM");
    expect(t1?.routes, "what will be called").toStrictEqual(["zai-coding-plan/glm-5.2", "openrouter/z-ai/glm-5.2"]);
    expect(t1?.metered, "and that one of them charges").toBe(true);
  });

  /**
   * THE SENTENCE AN OPERATOR ACTUALLY WANTS, and it must not be able to drift from the
   * rows above it — so it is derived rather than written.
   */
  it("says whether an outage will cost money or coverage", () => {
    const subs = JSON.stringify([
      { id: "t0", kind: "deterministic", stage: "fast" },
      { id: "t1", kind: "model", model: "zai-coding-plan/glm-5.3", stage: "fast" },
    ]);
    expect(configView(env({ LORE_TIERS: subs, LORE_ALLOW_METERED: "0" })).summary).toMatch(/never money/);

    const paid = JSON.stringify([
      { id: "t0", kind: "deterministic", stage: "fast" },
      { id: "t1", kind: "model", model: "openrouter/z-ai/glm-5.2", stage: "fast" },
    ]);
    expect(configView(env({ LORE_TIERS: paid, LORE_ALLOW_METERED: "1" })).summary).toMatch(/costs money/);
    expect(configView(env({ LORE_TIERS: paid, LORE_ALLOW_METERED: "0" })).summary).toMatch(/REFUSED/);
  });

  // A CREDENTIAL IS NEVER RENDERED, however convenient it would be to confirm it.
  it("says the webhook is set without showing it", () => {
    const e = configView(env({ LORE_WEBHOOK_URL: "https://hooks.example/secret-token" })).entries.find(
      (x) => x.name === "LORE_WEBHOOK_URL",
    );
    expect(e?.value).toBe("(set)");
    expect(JSON.stringify(configView(env({ LORE_WEBHOOK_URL: "https://hooks.example/secret-token" })))).not.toContain(
      "secret-token",
    );
  });
});
