/**
 * Scope: the code a verdict was about, so the verdict can expire with it.
 *
 * A justification is a claim about specific code. When that code changes the
 * reason may no longer hold, so the verdict is invalidated and the finding is
 * allowed to reappear.
 *
 * This is the single guard against the failure mode most likely to appear in six
 * months: silently honouring stale justifications, which turns the whole design
 * into rubber-stamping. Without expiry, `lore` accumulates reasons to ignore
 * things and never revisits any of them.
 *
 * SPEC: spec/review-ladder.md §4.1
 */

import { createHash } from "node:crypto";

export interface Scope {
  /** git blob sha of the file at verdict time. */
  readonly blob: string;
  /** Hash of the enclosing hunk's text at verdict time. */
  readonly hunk: string;
}

/**
 * Lines carrying a `lore-ok` MARKER. Not its continuation lines, which stay in the
 * hash — they are prose the author wrote and are as much part of the file as any
 * other comment.
 *
 * That asymmetry is deliberate and worth stating, because the docstring here first
 * claimed it stripped continuations and did not: the regex requires `lore-ok[` on the
 * line. What must not shift the hash is the ACT of marking, and the marker line is
 * that act. A reason that grows a paragraph is an edit like any other.
 *
 * Loose across the three comment syntaxes, erring toward stripping too much rather
 * than too little: a stray line ignored costs nothing, a marker line counted is the
 * livelock below.
 */
const ANNOTATION = /^\s*(?:\/\/|\*|<!--|#)?\s*lore-ok\[/;

/**
 * Hash a hunk's text — the CODE, never the annotation about it.
 *
 * Whitespace-insensitive on purpose: a reformat is not a semantic change, and
 * invalidating every verdict in a file because Prettier ran would train people to
 * ignore the reappearing findings. Anything beyond whitespace counts as a change,
 * because we cannot tell which edits preserve the reason.
 *
 * **And `lore-ok` lines are stripped, because otherwise a justification invalidates
 * itself.** We tell the client to write the marker AT THE SITE; the scope that
 * decides whether the justification survives is the hunk around that same line. So
 * the reason lived inside the code it depended on staying stable, and writing it was
 * itself a change to that code.
 *
 * Observed as a livelock on 2026-08-06. One semgrep false positive, in a file the
 * branch never touched, was justified and expired FOUR times across nine rounds:
 * accepted at round 2, expired, re-accepted at 4, expired, 6, expired, 8, expired.
 * The recorded hunk was byte-identical every time. It cost 109 minutes of model time
 * and ended when the review hit a bound, and it re-derived the same rule into the
 * knowledge base on every cycle — 21 of that repository's 27 derived rules were one
 * sentence about one false positive.
 *
 * This is what `spec/knowledge.md` already said and the code did not do: *a
 * justification's scope is taken from the code it defends, never from wherever the
 * reason is written*.
 */
export function hashHunk(text: string): string {
  const code = text
    .split("\n")
    .filter((l) => !ANNOTATION.test(l))
    .join("\n");
  const normalized = code.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function makeScope(blob: string, hunkText: string): Scope {
  return { blob, hunk: hashHunk(hunkText) };
}

/**
 * Is a verdict recorded against `recorded` still applicable to `current`?
 *
 * The blob alone is too coarse — any edit anywhere in a file would expire every
 * verdict in it. The hunk alone is too narrow — a file can be replaced wholesale
 * with a hunk that happens to survive. Requiring the hunk to match, and treating a
 * changed blob with an unchanged hunk as still valid, is the useful middle: the
 * verdict follows the code it was about, wherever that code moved to.
 */
export function isStale(recorded: Scope, current: Scope | undefined): boolean {
  // The code the verdict was about is gone entirely — deleted file, or a hunk that
  // no longer exists. A verdict about vanished code cannot be applied to anything.
  if (current === undefined) return true;
  return recorded.hunk !== current.hunk;
}

/** Window size used when a hunk is captured, and when it is later searched for. */
const HUNK_RADIUS = 12;

/**
 * Look for the code a verdict was about, wherever it has moved to.
 *
 * Sliding the window across the file is deliberately more forgiving than comparing
 * the blob: a verdict must survive an edit *elsewhere* in its file, or every
 * justification in a busy file expires on every commit and people learn to ignore
 * the findings that reappear.
 *
 * It must still expire when the code itself changes, because a reason attached to
 * code that no longer exists is how this design would rot into rubber-stamping.
 */
// lore-ok[7f126450]: raised, then argued down to unreachable by the same reply — a window
// only strips to empty (and so collides with any OTHER all-marker window) if EVERY one of
// its `2*radius+1` lines independently matches ANNOTATION, i.e. is itself a marker START.
// `ANNOTATION` matches only the start line of a `lore-ok[...]` marker; hashHunk's own
// docstring says continuation prose deliberately stays in the hash. Every real marker this
// codebase writes — including every fix in this review — is one start line followed by
// code or continuation prose, neither of which matches ANNOTATION. Twenty-five consecutive
// stacked marker-start lines with no code or continuation between any of them is not a
// shape any documented workflow produces; it would take deliberate construction. Left as
// a comment rather than code because there is nothing here to defensively handle — same
// call this project already made for the fingerprint length-prefix case this finding cites.
// lore-ok[3b0669bb]: independent confirmation of 7f126450 by a deeper tier, same reasoning
// — a match at any tried length still requires the recorded code to be contiguously
// present, which is this module's own definition of "still there".
// lore-ok[a9173659]: independent confirmation of 7f126450/3b0669bb, also verifying the
// multi-length search fix above introduces no regression: the full window is tried first
// (no added cost on the common case), the exhaustive scan runs only on genuine expiry, and
// every caller (review.ts:2548, 2998, 3068) moves only in the safer direction.
export function hunkStillPresent(source: string, hunk: string, radius = HUNK_RADIUS): boolean {
  const lines = source.split("\n");
  const window = radius * 2 + 1;
  // EVERY LENGTH FROM THE FULL WINDOW DOWN TO ONE LINE, not just `window` — found by
  // lore's own review, sibling of the boundary-clipping bug `hunkAround` was just fixed
  // for. `hunkAround` captures the WHOLE file when it has `<= window` lines — correct at
  // capture time — but if that file later GROWS past `window`, the recorded hash
  // represents FEWER than `window` lines, and a search that only ever tries full-`window`
  // slices can never reproduce it: a verdict on a 20-line file reads as stale the moment
  // ten unrelated lines are appended anywhere, even though the original 20 are untouched.
  // Longest length first, since a normal (already-long-at-capture-time) verdict — the
  // common case — matches on the very first length tried.
  for (let len = Math.min(window, lines.length); len >= 1; len--) {
    for (let start = 0; start + len <= lines.length; start++) {
      if (hashHunk(lines.slice(start, start + len).join("\n")) === hunk) return true;
    }
  }
  return false;
}

/**
 * Capture the code around a line, for later comparison.
 *
 * MUST produce a window the same SIZE `hunkStillPresent` searches for, never a
 * shorter one — found by lore's own review reading this file cold: a line within
 * `radius` of a file's start or end used to get a boundary-CLIPPED window (as few as
 * `radius + 1` lines), while `hunkStillPresent`'s slide only ever tries full
 * `2*radius+1`-line windows once the file exceeds that length. A clipped window's
 * hash could never match ANY window that search tries, so a verdict on a finding
 * near either end of any file over `2*radius+1` lines read as stale on every later
 * round even when the file had not changed a byte — the 2026-08-06 livelock
 * (`hashHunk`'s own docstring above), reopened by position in the file rather than
 * by the lore-ok-stripping bug that livelock was about. Clamping the window's START
 * to stay in bounds, rather than clamping its LENGTH, keeps the window full-size
 * everywhere `hunkStillPresent` can find it. The short-file branch matches
 * `hunkStillPresent`'s own short-file branch exactly: the whole source, unsliced.
 */
export function hunkAround(source: string, line: number, radius = HUNK_RADIUS): string {
  const lines = source.split("\n");
  const window = radius * 2 + 1;
  if (lines.length <= window) return source;
  const start = Math.min(Math.max(0, line - 1 - radius), lines.length - window);
  return lines.slice(start, start + window).join("\n");
}
