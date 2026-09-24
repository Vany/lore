/**
 * What lore is refusing to ask, and forgetting it on an operator's word.
 *
 * lore parks what refused it — one subscription's ROUTE (D-93) or a whole TIER (D-90) —
 * and learns of a recovery only by asking again. Whether it asks again ON ITS OWN depends
 * on who named the wait:
 *
 *   route, lore's guess      re-tested by the next review 15 min after its last probe (D-94)
 *   route, provider-stated   honoured to the second, never re-tested before `until` (D-91)
 *   tier,  provider-stated   reviews skip the tier, re-testing it once per 15 min (D-94)
 *   tier,  lore's guess      reviews ignore it; only the background screen waits (D-90)
 *
 * The person who just reset a limit, upgraded a plan or re-logged a credential knows what
 * lore cannot: the refusal stopped being true. This is how they say so. It exists because
 * it kept happening — a plan upgrade on 2026-09-16 and limit resets on 2026-09-22 and
 * 2026-09-24 were each cleared with a hand-typed `node -e` into the container, and a
 * hand-typed DELETE exits 0 whether or not its key matched anything.
 *
 * LISTING COMES FIRST, and says when lore would ask on its own, because the table above
 * means clearing often buys nothing: on 2026-09-24 the park being cleared was a guess,
 * probed seven minutes earlier and due again in eight. The line that says so is the
 * difference between an operator who needs this command and one who only needs to wait.
 *
 * SPEC: spec/operations.md §2.4.2
 */

import { PROBE_INTERVAL_MS } from "../core/cooloff.ts";
import { UsageError } from "../core/errors.ts";
import type { Store } from "../store/store.ts";

export interface Park {
  readonly kind: "route" | "tier";
  /** A route's model id (`openai/gpt-5.6-sol`), or a tier's id (`t3`). */
  readonly id: string;
  readonly until: string;
  readonly why: string;
  readonly failures: number;
  readonly stated: boolean;
  /** A rejected credential rather than a spent quota (D-143). Routes only: tiers never record it. */
  readonly auth: boolean;
  readonly probedAt: string | undefined;
}

/** Tiers first, then routes, each in id order — both kinds, because a stated tier mark parks a tier every route mark can be clear of. */
export function parks(store: Store): readonly Park[] {
  return [
    ...store.parkedTiers().map(({ tier, mark }) => ({
      kind: "tier" as const,
      id: tier,
      until: mark.until,
      why: mark.why,
      failures: mark.failures,
      stated: mark.stated,
      auth: false,
      probedAt: mark.probedAt,
    })),
    ...store.parkedRoutes().map(({ route, mark }) => ({
      kind: "route" as const,
      id: route,
      until: mark.until,
      why: mark.why,
      failures: mark.failures,
      stated: mark.stated,
      auth: mark.auth === true,
      probedAt: mark.probedAt,
    })),
  ];
}

export type UnparkRequest =
  | { readonly all: true }
  | { readonly all: false; readonly route: string | undefined; readonly tier: string | undefined };

/**
 * `lore unpark`'s own arguments: `undefined` means list, anything else names what to clear.
 *
 * A flag given WITHOUT a value is refused rather than dropped — `lore unpark --route`
 * falling through to the listing would look like a clear that did nothing. So is an empty
 * one: `startsWith("")` is true of every route, so `--route ""` would be `--all` in disguise.
 */
export function parseRequest(argv: readonly string[]): UnparkRequest | undefined {
  const valueOf = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v === "" || v.startsWith("--")) {
      throw new UsageError(`--${name} needs a value: lore unpark --${name} <id or prefix>`);
    }
    return v;
  };
  const route = valueOf("route");
  const tier = valueOf("tier");
  if (argv.includes("--all")) {
    if (route !== undefined || tier !== undefined) {
      throw new UsageError("--all clears every mark; give it no --route or --tier.");
    }
    return { all: true };
  }
  return route === undefined && tier === undefined ? undefined : { all: false, route, tier };
}

/**
 * Forget what the request names, and return exactly what was forgotten.
 *
 * A PREFIX CLEARS EVERY MATCH — deliberately not git's rule, which `revoke` follows. There a
 * wrong match locks a teammate out; here it costs one request: the route is asked, refuses,
 * and parks again. Refusing an ambiguous prefix costs the friction this exists to remove —
 * `openai` is what a person who reset OpenAI types, and on the day this was written it also
 * matched a long-expired `openai/gpt-5.6-terra` mark. Every cleared mark is returned and
 * printed, so an over-match is visible rather than silent.
 */
export function unpark(store: Store, req: UnparkRequest): readonly Park[] {
  const hit = (p: Park): boolean => {
    if (req.all) return true;
    const prefix = p.kind === "route" ? req.route : req.tier;
    return prefix !== undefined && p.id.startsWith(prefix);
  };
  const cleared = parks(store).filter(hit);
  for (const p of cleared) {
    if (p.kind === "route") store.clearRouteUnavailable(p.id);
    else store.clearTierUnavailable(p.id);
  }
  return cleared;
}

/**
 * Whether lore would ask again without being told, and when — the line that decides
 * whether clearing buys anything at all. Mirrors the table at the top of this file, and
 * `review.ts`'s own gates: a stated route is exempt from probing, a guessed tier binds
 * only the screen.
 */
function onItsOwn(p: Park, now: number): string {
  if (Date.parse(p.until) <= now) return "expired: blocks nothing now, kept for its failure count";
  const probedAt = p.probedAt === undefined ? Number.NaN : Date.parse(p.probedAt);
  const nextProbe = Number.isNaN(probedAt) ? now : probedAt + PROBE_INTERVAL_MS;
  const whenProbed =
    nextProbe <= now
      ? "the next review that needs it re-tests it"
      : `the first review after ${new Date(nextProbe).toISOString()} re-tests it`;
  if (p.kind === "route") {
    return p.stated ? `provider-stated: never re-tested before ${p.until}` : `lore's guess: ${whenProbed}`;
  }
  return p.stated
    ? `provider-stated: reviews skip this tier; ${whenProbed}`
    : `lore's guess: reviews ignore it; only the background screen waits until ${p.until}`;
}

export function describePark(p: Park, now: number): string {
  // A route's mark records which refusal it was (D-143); a tier's does not — it may be a
  // stated limit reset or a screen that went unanswered — so a tier gets no label and its
  // `why` speaks for it, rather than a label that would be a guess.
  const what = p.kind === "tier" ? [] : [p.auth ? "credential rejected" : "quota"];
  const force = Date.parse(p.until) <= now ? "expired" : `in force until ${p.until}`;
  const facts = [...what, `${String(p.failures)} failure(s)`, force].join(", ");
  return (
    `${p.kind.padEnd(5)} ${p.id}  [${facts}]\n` +
    `      ${onItsOwn(p, now)}\n` +
    `      why: ${p.why}`
  );
}

/**
 * What a re-park after clearing looks like, said once wherever a clear is offered — found
 * wrong in this command's first draft, which promised a failure count "intact": clearing
 * DELETES the mark, so a route that is still refusing starts its backoff over.
 */
const AFTER_CLEARING =
  "A mark cleared while the refusal is still real costs one request: the next call is refused\n" +
  "and parks again — until the provider's stated time if it names one, else on lore's backoff\n" +
  "starting over from a single failure.";

export function renderParks(list: readonly Park[], now: number): string {
  if (list.length === 0) return "nothing parked — lore is not refusing to ask anything.\n";
  return [
    "parked:",
    ...list.map((p) => describePark(p, now)),
    "",
    "clear with --route <prefix>, --tier <prefix>, or --all.",
    AFTER_CLEARING,
    "",
  ].join("\n");
}

export function renderCleared(cleared: readonly Park[], now: number): string {
  return [
    ...cleared.map((p) => `cleared ${describePark(p, now)}`),
    "",
    `${String(cleared.length)} mark(s) cleared: the next review that needs one asks it.`,
    AFTER_CLEARING,
    "",
  ].join("\n");
}
