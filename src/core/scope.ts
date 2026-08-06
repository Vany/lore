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
export function hunkStillPresent(source: string, hunk: string, radius = HUNK_RADIUS): boolean {
  const lines = source.split("\n");
  const window = radius * 2 + 1;
  if (lines.length <= window) return hashHunk(source) === hunk;

  for (let start = 0; start + window <= lines.length; start++) {
    if (hashHunk(lines.slice(start, start + window).join("\n")) === hunk) return true;
  }
  return false;
}

/** Capture the code around a line, for later comparison. */
export function hunkAround(source: string, line: number, radius = HUNK_RADIUS): string {
  const lines = source.split("\n");
  return lines.slice(Math.max(0, line - 1 - radius), Math.min(lines.length, line + radius)).join("\n");
}
