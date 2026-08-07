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

/**
 * An APPEAL is a different claim from a justification, and the parser has to tell them
 * apart (D-83).
 *
 * "trust my judgement about this line" and "you are enforcing something we decided not
 * to enforce" get different treatment downstream: only the second quotes a team rule to
 * the tier, and only the second can buy a suppression if the tier agrees. The whole
 * distinction rests on this regex, so the near-misses are tested as carefully as the
 * hits — a reason that merely BEGINS with the word "rule" must stay an ordinary reason,
 * or an author acquires an authority they never cited.
 */
describe("citing a development rule", () => {
  it("separates the rule id from the reason", () => {
    expect(parseLoreOk("// lore-ok[a1b2c3d4]: rule 3f9a2c11 — loopback in tests is not transport")).toStrictEqual([
      { short: "a1b2c3d4", reason: "loopback in tests is not transport", line: 1, rule: "3f9a2c11" },
    ]);
  });

  // A client that pastes the whole id rather than the eight it was handed: taken whole,
  // because `policyByShort` matches on prefix and a full id resolves as well as its head.
  it("takes a longer id whole rather than splitting it", () => {
    const m = parseLoreOk("// lore-ok[a1b2c3d4]: rule 3f9a2c11-aaaa-bbbb — behind the overlay")[0];
    expect(m?.rule).toBe("3f9a2c11-aaaa-bbbb");
    expect(m?.reason).toBe("behind the overlay");
  });

  it("accepts the separators an agent will actually type", () => {
    for (const sep of ["—", "–", "-", ":", ""]) {
      const src = `// lore-ok[a1b2c3d4]: rule 3f9a2c11 ${sep} behind the overlay`;
      expect(parseLoreOk(src)[0], sep).toMatchObject({ rule: "3f9a2c11", reason: "behind the overlay" });
    }
  });

  it("reads an appeal written in the block-comment form", () => {
    const src = ["/**", " * lore-ok[a1b2c3d4]: rule 3f9a2c11 — behind", " * the overlay", " */"].join("\n");
    expect(parseLoreOk(src)[0]).toMatchObject({ rule: "3f9a2c11", reason: "behind the overlay" });
  });

  it("reads an appeal from the markdown ledger form", () => {
    expect(parseLoreOk("<!-- lore-ok[a1b2c3d4]: rule 3f9a2c11 — the schema is strict -->")[0]).toMatchObject({
      rule: "3f9a2c11",
      reason: "the schema is strict",
    });
  });

  // The near-misses. Each of these is an ordinary reason that happens to start with the
  // word, and reading any of them as a citation would hand the author an authority they
  // did not invoke — or, worse, one that resolves to somebody else's rule.
  it("is not triggered by a reason that merely begins with the word", () => {
    for (const reason of [
      "rule of thumb: this path is bounded by the caller",
      "rules here are enforced at the boundary instead",
      "rule 12 of the style guide covers this",
      // FOUR HEX DIGITS IS ALSO A NUMBER. Accepted once, so an ordinary justification
      // saying "rule 1234 of the style guide" was read as an appeal to a rule nobody
      // wrote, and the tier was told its central claim was unsupported.
      "rule 1234 of the style guide covers this",
      "rule 0000 is about naming, which is not what this line does",
      "rule zzz — not a hex id",
    ]) {
      expect(parseLoreOk(`// lore-ok[a1b2c3d4]: ${reason}`)[0], reason).toStrictEqual({
        short: "a1b2c3d4",
        reason,
        line: 1,
      });
    }
  });
});
