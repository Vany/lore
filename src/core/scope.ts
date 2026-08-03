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
 * Hash a hunk's text.
 *
 * Whitespace-insensitive on purpose: a reformat is not a semantic change, and
 * invalidating every verdict in a file because Prettier ran would train people to
 * ignore the reappearing findings. Anything beyond whitespace counts as a change,
 * because we cannot tell which edits preserve the reason.
 */
export function hashHunk(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
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
export const HUNK_RADIUS = 12;

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
