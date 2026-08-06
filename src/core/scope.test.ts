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

// THE LIVELOCK, 2026-08-06.
//
// We tell a client to write its `lore-ok` AT THE SITE. The scope deciding whether the
// justification survives is the hunk around that same line. So the reason lived inside
// the code it depended on staying stable, and writing it down was itself a change to
// that code — a justification that invalidates itself by existing.
//
// One semgrep false positive, in a file the branch never touched, was justified and
// expired FOUR times across nine rounds: accepted at 2, expired, 4, expired, 6,
// expired, 8, expired. 109 minutes of model time, ended on a bound, and it re-derived
// the same rule into the knowledge base every cycle.
describe("a justification does not invalidate itself", () => {
  const CODE = [
    "  test('DELETE /v1/passkeys/:id', async () => {",
    "    server.use(...handlers)",
    "    const res = await fetch('http://auth.test/v1/passkeys/cred-123')",
    "    expect(res.status).toBe(204)",
    "  })",
  ].join("\n");

  const withMarker = [
    "  test('DELETE /v1/passkeys/:id', async () => {",
    "    server.use(...handlers)",
    "    // lore-ok[dce912fc]: msw intercepts in-process; `auth.test` is a reserved TLD.",
    "    const res = await fetch('http://auth.test/v1/passkeys/cred-123')",
    "    expect(res.status).toBe(204)",
    "  })",
  ].join("\n");

  it("hashes the same with and without the marker that defends it", () => {
    expect(hashHunk(withMarker)).toBe(hashHunk(CODE));
  });

  // Removing it must not expire the verdict either: what was ratified is the REASON,
  // and a client that regenerates its diff without the comment has not changed the
  // code the reason was about.
  it("survives the marker being taken away again", () => {
    const recorded = makeScope("blob1", withMarker);
    expect(isStale(recorded, makeScope("blob2", CODE))).toBe(false);
  });

  it.each([
    ["  // lore-ok[abcd1234]: reason"],
    ["   * lore-ok[abcd1234]: reason"],
    ["<!-- lore-ok[abcd1234]: reason -->"],
  ])("strips %s, whichever comment syntax it arrived in", (marker) => {
    expect(hashHunk(`${CODE}\n${marker}`)).toBe(hashHunk(CODE));
  });

  // The guard must still do its job: a REAL edit near the finding expires the reason,
  // because the reason was about code that has now changed.
  it("still expires when the code itself changes", () => {
    const recorded = makeScope("blob1", withMarker);
    const edited = CODE.replace("toBe(204)", "toBe(200)");
    expect(isStale(recorded, makeScope("blob2", edited))).toBe(true);
  });
});
