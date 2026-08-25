import { describe, expect, it } from "vitest";
import { hashHunk, hunkAround, hunkStillPresent, isStale, makeScope } from "./scope.ts";

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

// Found by lore's own review of src/core (D-130 folder mode): hunkAround used to
// CLIP its window at a file's start or end (as few as radius + 1 lines) instead of
// keeping it full size, while hunkStillPresent's slide only ever tries full
// 2*radius+1-line windows once the file is longer than that — so a clipped window's
// hash could never match anything the search tries, and a verdict on a finding near
// either end of any file over that length read as stale on every later round, even
// unchanged. Same shape as the 2026-08-06 livelock this file's docstring already
// describes, triggered by position instead of by lore-ok stripping.
describe("hunkAround and hunkStillPresent round-trip at a file's boundaries", () => {
  const longSource = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

  it.each([
    ["the first line", 1],
    ["a few lines from the start", 5],
    ["a few lines from the end", 95],
    ["the last line", 100],
    ["comfortably in the middle", 50],
  ])("a finding on %s survives on the unchanged file", (_name, line) => {
    const hunk = hashHunk(hunkAround(longSource, line));
    expect(hunkStillPresent(longSource, hunk)).toBe(true);
  });

  it("still expires a boundary finding when the code around it actually changed", () => {
    const hunk = hashHunk(hunkAround(longSource, 3));
    const edited = longSource.replace("line 3", "line 3 (changed)");
    expect(hunkStillPresent(edited, hunk)).toBe(false);
  });

  it("a boundary finding survives an unrelated edit far away in the file", () => {
    const hunk = hashHunk(hunkAround(longSource, 3));
    const editedElsewhere = longSource.replace("line 50", "line 50 (changed)");
    expect(hunkStillPresent(editedElsewhere, hunk)).toBe(true);
  });

  it("a short file (at or under the window size) round-trips as a whole", () => {
    const shortSource = Array.from({ length: 13 }, (_, i) => `s${i + 1}`).join("\n");
    const hunk = hashHunk(hunkAround(shortSource, 7));
    expect(hunkStillPresent(shortSource, hunk)).toBe(true);
    // A real edit to the ORIGINAL content still expires it.
    expect(hunkStillPresent(shortSource.replace("s7", "s7 (changed)"), hunk)).toBe(false);
  });

  // Found by lore's own review of src/core (D-130 folder mode), sibling of the boundary-
  // clipping bug above: hunkAround captures the WHOLE file when it has <= window lines,
  // so the recorded hash represents FEWER than `window` lines. If that same file later
  // GROWS past `window`, the old search only ever tried full-`window` slices and could
  // never reproduce a shorter recorded hash — a verdict on a short, untouched file read as
  // stale the moment unrelated lines were added anywhere. hunkStillPresent now tries every
  // length from the full window down to one line, so a shorter original capture can still
  // be found as a contiguous, unchanged block wherever it ended up.
  it("a verdict from a short file survives growth past the window size, in either direction", () => {
    const original = Array.from({ length: 13 }, (_, i) => `s${i + 1}`).join("\n");
    const hunk = hashHunk(hunkAround(original, 7));
    const grownAfter = `${original}\n${Array.from({ length: 20 }, (_, i) => `new ${i + 1}`).join("\n")}`;
    expect(hunkStillPresent(grownAfter, hunk)).toBe(true);
    const grownBefore = `${Array.from({ length: 20 }, (_, i) => `new ${i + 1}`).join("\n")}\n${original}`;
    expect(hunkStillPresent(grownBefore, hunk)).toBe(true);
    // The original content itself still expires the verdict once it actually changes.
    const grownAndEdited = grownAfter.replace("s7", "s7 (changed)");
    expect(hunkStillPresent(grownAndEdited, hunk)).toBe(false);
  });
});
