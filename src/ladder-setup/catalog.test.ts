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
});
