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
 * A scaffolded path that must never return a plausible default.
 *
 * PROG.md: unimplemented paths throw. A stub returning "clean" would be exactly
 * the failure INV-1 exists to prevent, shipped on day one.
 */
export class NotImplemented extends LoreError {
  constructor(what: string) {
    super(`${what} is not implemented yet — see TODO.md`, EXIT.DID_NOT_RUN);
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
