/**
 * Failure types and exit codes.
 *
 * The caller is a program, so the exit code is the API (SPEC §2.1). The single
 * rule this file exists to enforce: **a review that did not run is not a review
 * that found nothing** (INV-1). Every failure path lands here, loudly, with a code
 * that cannot be mistaken for success.
 */

export const EXIT = {
  /** Reviewed, ladder exhausted, nothing new. The ONLY success. */
  PASS: 0,
  /** Findings to fix or justify, then call again. */
  FINDINGS: 1,
  /**
   * Every tier that COULD run agreed; some could not be paid for (D-48).
   *
   * Deliberately not 0. `passed` means three independent vendors found nothing;
   * this means the ones we could afford found nothing. Weaker evidence, and a
   * caller that wants to treat them alike must say so itself.
   */
  PARTIAL: 3,
  /** Bad invocation. */
  USAGE: 2,
  /** Did not run. Never confuse with PASS. */
  DID_NOT_RUN: 70,
  /** Budget or quota exhausted. Also not PASS. */
  EXHAUSTED: 75,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Base for every failure that must not read as a clean result. */
export class LoreError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/**
 * The review could not be completed. Crashed reviewer, unparseable output,
 * timeout, missing tooling — all of them are "did not run".
 */
export class DidNotRun extends LoreError {
  // Declared rather than a parameter property: erasableSyntaxOnly forbids those,
  // because node strips types rather than compiling them (tsconfig, D-3).
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message, EXIT.DID_NOT_RUN);
    this.reason = reason;
  }
}

/** A tier's provider is out of budget or rate limit. Never a reason to skip it. */
export class Exhausted extends LoreError {
  constructor(message: string) {
    super(message, EXIT.EXHAUSTED);
  }
}

/** Bad arguments or configuration. */
export class UsageError extends LoreError {
  constructor(message: string) {
    super(message, EXIT.USAGE);
  }
}

/**
 * A provider rejected our credentials.
 *
 * Its own type because the blast radius is not one review: a dead credential stops
 * every review at that tier at once, and it is a thing an operator must go and fix
 * rather than a branch being difficult. Separated from `Exhausted` for the same reason
 * that one was separated from `DidNotRun` — an unpaid bill, a spent quota and a
 * revoked key each want a different person to do a different thing, and collapsing
 * them sends the search to the prompt.
 *
 * Still exit 70: it did not run.
 */
export class ProviderAuthFailed extends DidNotRun {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(`${provider} rejected our credentials — ${message}`);
    this.provider = provider;
  }
}

/**
 * Short-id lookup found more than one match.
 *
 * Resolving it by picking a winner would close a defect nobody examined
 * (spec/review-ladder.md §3.1.2). Git's rule for short object ids: ambiguity is an
 * error.
 */
export class AmbiguousFingerprint extends LoreError {
  readonly matches: readonly string[];

  constructor(short: string, matches: readonly string[]) {
    super(
      `fingerprint '${short}' is ambiguous — ${matches.length} findings share it: ${matches.join(", ")}`,
      EXIT.DID_NOT_RUN,
    );
    this.matches = matches;
  }
}
