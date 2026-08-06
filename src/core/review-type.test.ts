/**
 * The type registry, which decides which engines run and what the tiers are asked.
 *
 * `SECURITY` was exported and referenced by nothing outside its own file — no caller,
 * no test — for the whole of Phase 5's life. It IS reachable, through the registry
 * map, which is why the dead-export sweep was right to flag it and wrong to condemn
 * it. What was actually missing was any assertion that the second review type
 * resolves, carries the security engines, and asks a different question from the
 * first: `type` has been in the MCP surface since day one (D-43) with nothing pinning
 * what it selects.
 */

import { describe, expect, it } from "vitest";
import { UsageError } from "./errors.ts";
import { CODE_ARCH, DEFAULT_TYPE, SECURITY, reviewType, reviewTypeIds } from "./review-type.ts";

describe("review types are named pipelines", () => {
  it("resolves the default without an argument", () => {
    expect(reviewType().id).toBe(DEFAULT_TYPE);
    expect(reviewType().id).toBe(CODE_ARCH.id);
  });

  it("resolves the security type, which nothing had ever asked for", () => {
    expect(reviewType("security")).toBe(SECURITY);
  });

  // The engines are the whole difference. A security review that ran code-arch's T0
  // would enumerate no dependencies and report nothing — a confident claim about a
  // dependency tree it never opened, which is the one output this type exists to make.
  it("selects the security engines, not the code-arch ones", () => {
    expect([...SECURITY.t0]).toStrictEqual(["sbom", "osv", "semgrep"]);
    expect(SECURITY.t0).not.toContain("tsc");
    expect(CODE_ARCH.t0).not.toContain("osv");
  });

  it("asks the tiers a different question, since the prompts are built from it", () => {
    expect(SECURITY.question).not.toBe(CODE_ARCH.question);
    expect(SECURITY.question).toMatch(/reach/i);
  });

  // An unknown type must never fall through to the default. Silently reviewing
  // `type: "secrutiy"` as code-arch would answer a question nobody asked and report
  // it as though the asked one had been answered.
  it("refuses an unknown type rather than defaulting", () => {
    expect(() => reviewType("secrutiy")).toThrow(UsageError);
    expect(() => reviewType("secrutiy")).toThrow(/known: /);
  });

  it("advertises every registered type, so the CLI usage cannot drift from the registry", () => {
    expect([...reviewTypeIds()].sort()).toStrictEqual(["code-arch", "security"]);
  });
});
