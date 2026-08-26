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

    // A tier POOLED onto a metered route: gated by the flag, and NOT outage-shaped
    // (fingerprint ec572ac6) — it can be picked on any ordinary round, not only when something
    // has failed, so the summary must not say "on an outage" for this shape.
    const pooled = JSON.stringify({
      models: { GLM: ["openrouter/z-ai/glm-5.2"] },
      tiers: [
        { id: "t0", kind: "deterministic", stage: "fast" },
        { id: "t1", kind: "model", model: "GLM", stage: "fast" },
      ],
    });
    const allowed = configView(env({ LORE_TIERS: pooled, LORE_ALLOW_METERED: "1" })).summary;
    expect(allowed, "must not claim the cost is outage-conditioned").not.toMatch(/on an outage/);
    expect(allowed).toMatch(/ANY round/);
    const refused = configView(env({ LORE_TIERS: pooled, LORE_ALLOW_METERED: "0" })).summary;
    expect(refused, "must not claim the tier is simply REFUSED — it has no other route").toMatch(
      /keeps a paid route out of its pool/,
    );
  });

  /**
   * 60dcf7a5, found by lore's own review: a LITERAL model id (not a pool nickname) on
   * an operator-written ladder is exempt from LORE_ALLOW_METERED entirely
   * (`exemptLiteral`, D-117 — "configuring openrouter/x IS the operator switching it
   * on"). The summary used to say "REFUSED" for this exact shape under
   * ALLOW_METERED=0, while the tier ran and billed every round regardless — the one
   * page built to answer "will this cost me money" giving the opposite answer.
   */
  it("says a literal paid model pays regardless of the flag, not that it is refused", () => {
    const paid = JSON.stringify([
      { id: "t0", kind: "deterministic", stage: "fast" },
      { id: "t1", kind: "model", model: "openrouter/z-ai/glm-5.2", stage: "fast" },
    ]);
    const view = configView(env({ LORE_TIERS: paid, LORE_ALLOW_METERED: "0" }));
    expect(view.summary, "must not claim the route is refused when it is exempt").not.toMatch(/REFUSED/);
    expect(view.summary).toMatch(/regardless of LORE_ALLOW_METERED/);
    expect(view.ladder.find((l) => l.tier === "t1")?.exempt).toBe(true);
  });

  /**
   * 60dcf7a5, found by lore's own review: a tier's `routes` came only from its
   * PRIMARY model — a free pooled primary with a metered FALLBACK read `metered:
   * false`, so the summary said "costs coverage, never money" for the exact
   * deployed shape (board.test.ts) that bills on every quota outage under
   * LORE_ALLOW_METERED=1 (D-109 walks the fallback chain whenever it is set).
   */
  it("counts a metered FALLBACK even when the primary is free", () => {
    const tiers = JSON.stringify([
      { id: "t0", kind: "deterministic", stage: "fast" },
      {
        id: "t1", kind: "model", model: "zai-coding-plan/glm-5.3",
        fallback: ["openrouter/z-ai/glm-5.2"], stage: "fast",
      },
    ]);
    const view = configView(env({ LORE_TIERS: tiers, LORE_ALLOW_METERED: "1" }));
    const t1 = view.ladder.find((l) => l.tier === "t1");
    expect(t1?.routes.some((r) => r.startsWith("openrouter/")), "the primary itself is free").toBe(false);
    expect(t1?.fallbackRoutes).toStrictEqual(["openrouter/z-ai/glm-5.2"]);
    expect(t1?.metered, "metered via the fallback, not the primary").toBe(true);
    expect(view.summary, "must not claim this ladder cannot reach a paid route").toMatch(/costs money/);
    // Unlike a pooled-metered primary (fingerprint ec572ac6), a fallback-only route genuinely IS
    // conditional on the primary failing first — "on an outage" is accurate here.
    expect(view.summary, "a fallback-only route really is outage-conditioned").toMatch(/on an outage/);
  });

  /**
   * Self-caught while fixing 60dcf7a5: the first draft of the fix checked
   * `l.metered && l.exempt` as though exemption applied to whichever route made
   * the tier metered — wrong, since `runRound`'s own comment says the exemption is
   * a property of the PRIMARY alone ("A fallback is CONDITIONAL... only one of
   * them can surprise somebody") — a fallback is always gated by
   * LORE_ALLOW_METERED, never exempt, regardless of the primary. A tier can
   * genuinely be BOTH at once: bills unconditionally on its exempt literal
   * primary, AND separately gated on a metered fallback.
   */
  it("distinguishes an exempt-paying primary from a separately-gated fallback on the same tier", () => {
    const tiers = JSON.stringify([
      { id: "t0", kind: "deterministic", stage: "fast" },
      {
        id: "t1", kind: "model", model: "openrouter/z-ai/glm-5.2",
        fallback: ["openrouter/moonshotai/kimi-k3"], stage: "fast",
      },
    ]);
    const view = configView(env({ LORE_TIERS: tiers, LORE_ALLOW_METERED: "0" }));
    const t1 = view.ladder.find((l) => l.tier === "t1");
    expect(t1?.exempt, "a literal primary on an operator-written ladder is exempt").toBe(true);
    expect(t1?.routes.some((r) => r.includes("openrouter"))).toBe(true);
    expect(t1?.fallbackRoutes.some((r) => r.includes("openrouter"))).toBe(true);
    // The primary bills regardless of the flag; the fallback is still gated by it
    // and refused under ALLOW_METERED=0 — both facts belong in one honest summary.
    expect(view.summary).toMatch(/regardless of LORE_ALLOW_METERED/);
    expect(view.summary).toMatch(/REFUSED/);
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

  /**
   * 8a04e087, found by lore's own review: a BLANK `LORE_WEBHOOK_URL` — exactly what
   * docker-compose passes through (`${LORE_WEBHOOK_URL:-}`) when an operator's `.env`
   * omits it — rendered as value "(set)", source "set here", because the row
   * pre-converted the raw value to the literal string "(set)" before `entry()`'s own
   * blank check could see the real value. The page built to answer "is alerting wired"
   * asserted it was, for the default, most common deployment shape.
   */
  it("says the webhook is UNSET when its env value is blank, not just when it is absent", () => {
    const e = configView(env({ LORE_WEBHOOK_URL: "" })).entries.find((x) => x.name === "LORE_WEBHOOK_URL");
    expect(e?.value).toBe("(unset — alerts are logged only)");
    expect(e?.source).toBe("built-in default");
  });

  /**
   * 4ef54ed2, found by lore's own review: `LORE_HEARTBEAT_URL` — the one variable that
   * decides whether the §3 deadman can page at all — had no row on the page built to
   * show every parameter, so an unarmed deadman was indistinguishable from an armed
   * one here. Redacted and blank-checked the same way as `LORE_WEBHOOK_URL`.
   */
  it("shows the heartbeat URL, redacted, and treats a blank value as unset", () => {
    const armed = configView(env({ LORE_HEARTBEAT_URL: "https://hc-ping.com/secret-uuid" })).entries.find(
      (x) => x.name === "LORE_HEARTBEAT_URL",
    );
    expect(armed?.value).toBe("(set)");
    expect(armed?.source).toBe("set here");
    expect(JSON.stringify(configView(env({ LORE_HEARTBEAT_URL: "https://hc-ping.com/secret-uuid" })))).not.toContain(
      "secret-uuid",
    );

    const unarmed = configView(env({ LORE_HEARTBEAT_URL: "" })).entries.find((x) => x.name === "LORE_HEARTBEAT_URL");
    expect(unarmed?.value).toBe("(unset — the deadman cannot page)");
    expect(unarmed?.source).toBe("built-in default");
  });
});
