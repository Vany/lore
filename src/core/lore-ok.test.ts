import { describe, expect, it } from "vitest";
import { parseLoreOk } from "./lore-ok.ts";

describe("parseLoreOk", () => {
  it("reads a single-line justification", () => {
    const found = parseLoreOk(`const x = 1;\n// lore-ok[a1b2c3d4]: bounded by the caller\n`);
    expect(found).toStrictEqual([
      { short: "a1b2c3d4", reason: "bounded by the caller", line: 2 },
    ]);
  });

  it("joins continuation lines into one reason", () => {
    const src = [
      "// lore-ok[a1b2c3d4]: bounded by the caller's schema check at api/route.ts:31,",
      "// so a negative amount cannot reach here.",
      "doThing();",
    ].join("\n");
    expect(parseLoreOk(src)[0]?.reason).toBe(
      "bounded by the caller's schema check at api/route.ts:31, so a negative amount cannot reach here.",
    );
  });

  it("stops absorbing at the first non-comment line", () => {
    const src = ["// lore-ok[a1b2c3d4]: first", "doThing();", "// unrelated comment"].join("\n");
    expect(parseLoreOk(src)[0]?.reason).toBe("first");
  });

  // Two markers must never merge into one reason: that would attach one author's
  // argument to a finding they never looked at.
  it("does not merge two adjacent justifications", () => {
    const src = ["// lore-ok[aaaaaaaa]: first reason", "// lore-ok[bbbbbbbb]: second reason"].join("\n");
    const found = parseLoreOk(src);
    expect(found).toHaveLength(2);
    expect(found[0]?.reason).toBe("first reason");
    expect(found[1]?.reason).toBe("second reason");
  });

  it("reads the HTML form, including across lines", () => {
    const src = `# Spec\n\n<!-- lore-ok[a1b2c3d4]: the spec is\n     deliberately silent here -->\n`;
    expect(parseLoreOk(src)[0]).toStrictEqual({
      short: "a1b2c3d4",
      reason: "the spec is deliberately silent here",
      line: 3,
    });
  });

  // An empty marker is not a justification. Accepting it would let a bare comment
  // close a finding — writing your way past a defect without making an argument.
  it("ignores a marker with no reason", () => {
    expect(parseLoreOk("// lore-ok[a1b2c3d4]:")).toStrictEqual([]);
    expect(parseLoreOk("// lore-ok[a1b2c3d4]:    ")).toStrictEqual([]);
    expect(parseLoreOk("<!-- lore-ok[a1b2c3d4]:  -->")).toStrictEqual([]);
  });

  it("ignores malformed fingerprints", () => {
    expect(parseLoreOk("// lore-ok[xyz]: too short")).toStrictEqual([]);
    expect(parseLoreOk("// lore-ok[A1B2C3D4]: uppercase is not hex here")).toStrictEqual([]);
  });

  it("finds nothing in a file with no markers", () => {
    expect(parseLoreOk("const x = 1;\n// an ordinary comment\n")).toStrictEqual([]);
  });

  it("returns findings in line order regardless of comment form", () => {
    const src = ["<!-- lore-ok[bbbbbbbb]: html first -->", "// lore-ok[aaaaaaaa]: slash second"].join("\n");
    expect(parseLoreOk(src).map((f) => f.short)).toStrictEqual(["bbbbbbbb", "aaaaaaaa"]);
  });
});

// The block-comment form, added because it was silently missing and that cost a
// justification: this codebase explains itself in `/** ... */`, a long reason lands
// there by reflex, and `parseLoreOk` skipped it — so the finding it answered could
// never settle.
describe("the block-comment form", () => {
  it("reads a lore-ok written as JSDoc", () => {
    const src = ["/**", " * Some prose.", " * lore-ok[a1b2c3d4]: bounded by the caller", " */"].join("\n");
    expect(parseLoreOk(src)).toStrictEqual([{ short: "a1b2c3d4", reason: "bounded by the caller", line: 3 }]);
  });

  it("continues across ` * ` lines and stops at the closing delimiter", () => {
    const src = ["/**", " * lore-ok[a1b2c3d4]: bounded by the", " * caller's schema check", " */", "const after = 1;"].join("\n");
    expect(parseLoreOk(src)[0]?.reason).toBe("bounded by the caller's schema check");
  });

  it("does not merge two markers in one block", () => {
    const src = ["/**", " * lore-ok[aaaaaaaa]: first reason", " * lore-ok[bbbbbbbb]: second reason", " */"].join("\n");
    expect(parseLoreOk(src).map((f) => f.short)).toStrictEqual(["aaaaaaaa", "bbbbbbbb"]);
    expect(parseLoreOk(src)[0]?.reason).toBe("first reason");
  });

  // A bare ` *` is a paragraph break, not a continuation. Matching it let the reason
  // run on into whatever prose followed, so a justification silently acquired an
  // unrelated paragraph and the reviewer ruled on text nobody wrote for it.
  it("stops at a blank star line instead of swallowing the next paragraph", () => {
    const src = [
      "/**",
      " * lore-ok[a1b2c3d4]: the actual reason",
      " *",
      " * Unrelated prose about something else entirely.",
      " */",
    ].join("\n");
    expect(parseLoreOk(src)[0]?.reason).toBe("the actual reason");
  });

  it("still refuses an empty reason", () => {
    expect(parseLoreOk(["/**", " * lore-ok[a1b2c3d4]:", " */"].join("\n"))).toStrictEqual([]);
  });
});
