/**
 * `filterCatalog`'s own branches — no network, no opencode, mirroring `core/ladder.ts`'s
 * own "pure reducer, testable without paying anyone" shape.
 *
 * SPEC: spec/review-ladder.md
 */

import { describe, expect, it } from "vitest";
import { filterCatalog, type RawModel } from "./catalog.ts";

const base: RawModel = { capabilities: { toolcall: true }, limit: { context: 128_000 } };

describe("filterCatalog", () => {
  it("keeps a tool-call-capable model with no status at all", () => {
    const out = filterCatalog({ "z-ai/glm-5.2": base });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("openrouter/z-ai/glm-5.2");
  });

  it("drops a model with no tool-call support — an agentic reviewer cannot use it", () => {
    const out = filterCatalog({ "some/no-tools": { ...base, capabilities: { toolcall: false } } });
    expect(out).toHaveLength(0);
  });

  it("drops deprecated and alpha models", () => {
    const out = filterCatalog({
      "a/deprecated": { ...base, status: "deprecated" },
      "b/alpha": { ...base, status: "alpha" },
    });
    expect(out).toHaveLength(0);
  });

  it("keeps active and beta models", () => {
    const out = filterCatalog({
      "a/active": { ...base, status: "active" },
      "b/beta": { ...base, status: "beta" },
    });
    expect(out).toHaveLength(2);
  });

  it("derives the vendor from the underlying organisation, not the openrouter prefix", () => {
    const out = filterCatalog({ "moonshotai/kimi-k3": base });
    expect(out[0]?.vendor).toBe("moonshotai");
  });

  it("carries cost as undefined rather than a fabricated 0 when the model is unpriced", () => {
    const out = filterCatalog({ "free/model": base });
    expect(out[0]?.costInput).toBeUndefined();
    expect(out[0]?.costOutput).toBeUndefined();
  });

  it("carries real cost and context figures through unchanged", () => {
    const out = filterCatalog({
      "z-ai/glm-5.2": { ...base, cost: { input: 0.0000006, output: 0.0000022 }, limit: { context: 128_000 } },
    });
    expect(out[0]?.costInput).toBe(0.0000006);
    expect(out[0]?.costOutput).toBe(0.0000022);
    expect(out[0]?.contextTokens).toBe(128_000);
  });

  /**
   * THE TILDE PREFIX IS EXCLUDED ENTIRELY, NOT MERELY NORMALISED — found live against
   * the real deployment, fingerprint fc9e8468, then widened by fingerprint 4f56d47a:
   * OpenRouter's own catalog carries a "-latest" pointer-alias namespace for at least
   * seven vendors (`~z-ai/glm-5.2-latest` alongside `z-ai/glm-5.2`, and six more). A
   * normalised vendor COLUMN was not enough — every review-time consumer of vendor
   * identity (`core/ladder.ts`'s `vendorSpread`, which decides `passed`/
   * `passed_partial` and feeds the signed attestation; `reviewer/review.ts`'s
   * fallback prose; `doctor.ts`'s own check) calls bare `vendorOf` with no tilde
   * awareness, a blind spot harmless until this feature could legitimately WRITE a
   * tilde id into a real `LORE_TIERS` file. Excluding the shape here means one never
   * can.
   */
  it("excludes a tilde-prefixed id from the catalog entirely, offering only the real one", () => {
    const out = filterCatalog({
      "~z-ai/glm-5.2-latest": base,
      "z-ai/glm-5.2": base,
    });
    expect(out.map((m) => m.id)).toEqual(["openrouter/z-ai/glm-5.2"]);
  });

  /**
   * ONE MALFORMED ENTRY MUST NOT CRASH THE WHOLE CATALOG — found by lore's own
   * review, fingerprint 707e8388: `fetchCatalog`'s own cast (`as unknown as
   * Record<string, RawModel>`) explicitly does not trust this wire data
   * structurally, so a locally-defined custom model missing `capabilities` or
   * `limit` entirely — a real, reachable shape via `make sync-opencode`'s own
   * host-config derivation — used to throw a bare TypeError and take every OTHER
   * candidate down with it.
   */
  it("skips an entry missing capabilities entirely, rather than throwing", () => {
    const malformed = { "custom/no-capabilities": {} as RawModel };
    expect(() => filterCatalog({ ...malformed, "z-ai/glm-5.2": base })).not.toThrow();
    expect(filterCatalog({ ...malformed, "z-ai/glm-5.2": base }).map((m) => m.id)).toEqual([
      "openrouter/z-ai/glm-5.2",
    ]);
  });

  it("skips an entry missing limit.context, rather than fabricating a window size", () => {
    const { limit, ...noLimit } = base;
    void limit;
    const out = filterCatalog({ "custom/no-limit": noLimit as RawModel, "z-ai/glm-5.2": base });
    expect(out.map((m) => m.id)).toEqual(["openrouter/z-ai/glm-5.2"]);
  });
});
