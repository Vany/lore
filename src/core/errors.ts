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

/**
 * This tier could not look at this code — for a reason that is about the TIER, not
 * about the branch.
 *
 * The ladder steps over one of these and finishes with what remains, reaching
 * `passed_partial` at best (D-48). That is the whole distinction: a tier that could
 * not run is a limitation, honestly labelled; a tier that ran and broke is a failure.
 *
 * Two of them, and the second arrived because the first's machinery was already
 * right. Quota was the original case. Context is the other: a diff too large for a
 * model's window is not a defect in the branch, and treating it as a failed review is
 * what made a 741 KB branch unreviewable for two days when two of the three tiers
 * could hold it comfortably.
 */
export abstract class TierUnavailable extends LoreError {}

/** A tier's provider is out of budget or rate limit. Never a reason to skip it. */
export class Exhausted extends TierUnavailable {
  /**
   * When the provider says the limit lifts, ISO, if it said so.
   *
   * Z.ai names it — *"Your limit will reset at 2026-08-10 18:19:09"* — and lore spent
   * three days believing that fact was unreachable. It is not: opencode publishes the
   * refusal verbatim on its event stream, keyed by session (D-91). We had been reading
   * the message body, where it genuinely is swallowed, and concluded it was gone.
   *
   * Optional, because most refusals name no time and a guess is worse than none: absent
   * means fall back to the doubling cool-off, which is what D-90 does when nobody tells
   * it anything.
   */
  readonly resetAt: string | undefined;

  constructor(message: string, resetAt?: string) {
    super(message, EXIT.EXHAUSTED);
    this.resetAt = resetAt;
  }
}

/**
 * The prompt cannot fit this tier's context window.
 *
 * Known BEFORE the call, from the model's own advertised limit, so it costs nothing
 * to discover. Previously this was discovered by spending: the provider answered HTTP
 * 200 with an empty body — a refusal inside a success — which `describeReply` reported
 * as "usually a provider failure inside a 200", and the client, told that `failed` is
 * often transient, retried. Five times over two days on one branch, 21 minutes of T0
 * and ten empty model calls, ending with the client reporting to its operator that
 * lore's tier was broken. It was not: the diff was 3.4× the largest that tier had ever
 * finished, and 95% of its window before a single tool call.
 */
export class TooLargeForTier extends TierUnavailable {
  // Declared rather than parameter properties: `erasableSyntaxOnly` forbids those,
  // because node strips types rather than compiling them (D-3).
  readonly tierId: string;
  readonly model: string;
  readonly promptTokens: number;
  /** The advertised window, or `undefined` when the provider refused without naming one. */
  readonly contextLimit: number | undefined;

  constructor(tierId: string, model: string, promptTokens: number, contextLimit: number) {
    super(
      `tier ${tierId} (${model}) cannot hold this review: the prompt is about ${promptTokens.toLocaleString()} ` +
        `tokens against a ${contextLimit.toLocaleString()}-token context window. Not a defect in the branch and ` +
        `not a fault in the model — this tier is too small for this diff, so it is skipped and a larger tier ` +
        `looks instead. To get every tier to look, review a smaller range.`,
      EXIT.EXHAUSTED,
    );
    this.tierId = tierId;
    this.model = model;
    this.promptTokens = promptTokens;
    this.contextLimit = contextLimit;
  }

  /**
   * The provider refused the prompt as too long, and the advertised window said it fit.
   *
   * A separate constructor because the honest message is different: above, we KNOW the
   * limit and computed that we would exceed it, which is a fact about the model. Here we
   * checked, believed it would fit, sent it, and were refused — so the number we have is
   * not the number that applies, and claiming one would be inventing it.
   *
   * Observed 2026-08-07: `zai-coding-plan/glm-5-turbo` advertises 200,000 tokens of
   * context through opencode's `/config/providers`, a 104 KB prompt was therefore well
   * inside `compactToFit`'s budget and sent unchanged, and the endpoint answered
   * 400 "Prompt exceeds max length". A subscription plan can cap a request far below the
   * model's nominal context and nothing publishes that ceiling.
   */
  static refusedAsTooLong(tierId: string, model: string, promptChars: number, providerSaid: string): TooLargeForTier {
    const e = new TooLargeForTier(tierId, model, Math.round(promptChars / 4), 1);
    return Object.assign(e, {
      contextLimit: undefined,
      message:
        `tier ${tierId} (${model}) REFUSED this review as too long: "${providerSaid}". The prompt was about ` +
        `${Math.round(promptChars / 1024).toLocaleString()} KB and fit the window this model advertises, so the ` +
        `limit that actually applies is smaller than the one it publishes and lore cannot read it. Not a defect ` +
        `in the branch and not a fault in the model — this tier is skipped and a larger one looks instead. To ` +
        `get every tier to look, review a smaller range.`,
    });
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
