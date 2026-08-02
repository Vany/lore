import { describe, expect, it } from "vitest";
import { hashHunk, isStale, makeScope } from "./scope.ts";

describe("hashHunk", () => {
  it("ignores reformatting", () => {
    // Invalidating every verdict in a file because Prettier ran would train people
    // to ignore the findings that reappear.
    expect(hashHunk("if (a) {\n  b();\n}")).toBe(hashHunk("if (a) {   b(); }"));
  });

  it("does not ignore a semantic change", () => {
    expect(hashHunk("if (a) { b(); }")).not.toBe(hashHunk("if (!a) { b(); }"));
  });
});

describe("isStale", () => {
  const recorded = makeScope("blob1", "release(hold)");

  it("holds while the code it was about is unchanged", () => {
    expect(isStale(recorded, makeScope("blob1", "release(hold)"))).toBe(false);
  });

  it("follows the code when the file changed but the hunk did not", () => {
    // The verdict was about this code, wherever it moved to. Expiring on the blob
    // alone would kill every verdict in a file on any edit anywhere in it.
    expect(isStale(recorded, makeScope("blob2", "release(hold)"))).toBe(false);
  });

  it("expires when the code it was about changed", () => {
    expect(isStale(recorded, makeScope("blob1", "// release removed"))).toBe(true);
  });

  it("expires when the code is gone entirely", () => {
    expect(isStale(recorded, undefined)).toBe(true);
  });
});
