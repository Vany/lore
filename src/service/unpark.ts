/**
 * What lore is refusing to ask, and forgetting it on an operator's word.
 *
 * lore parks what refused it — one subscription's ROUTE (D-93) or a whole TIER (D-90) —
 * and learns of a recovery only by asking again. Whether it asks again ON ITS OWN depends
 * on who named the wait:
 *
 *   route, lore's guess      re-tested by the next review 15 min after its last probe (D-94)
 *                            — but only as a tier's PRIMARY: a route that is only a fallback
 *                            is filtered out of the fallback walk, never probed, and waits
 *                            out its whole backoff
 *   route, provider-stated   not re-tested before `until` (D-91) — except by the probe of a
 *                            parked tier it is the primary of, which asks every primary route
 *   tier,  provider-stated   reviews skip its primary, probing it once per 15 min (D-94)
 *   tier,  lore's guess      reviews still call it, a due one as a probe under the probe's
 *                            shorter deadline; the background screen waits it out (D-90)
 *
 * So a review skips a tier's primary while the tier carries a STATED mark or that route is
 * parked, and a clear that lifts one while the other stands buys nothing — which is why a clear
 * reports what still stands in front of it, read off the ladder, rather than promising
 * the next review will ask.
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
import { routesFor, type ModelPools, type Tier } from "../core/ladder.ts";
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
 * EVERY ARGUMENT IS ACCOUNTED FOR. Found by lore's own review, fingerprint bd6ba0c0: the
 * first version looked only for the flags it knew, so `--rout openai` matched none of them
 * and fell through to the listing with exit 0 — a clear that did nothing, reporting
 * success, which is the exact failure this command replaced. So is a flag given without a
 * value, and an empty one: `startsWith("")` is true of every route, so `--route ""` would
 * be `--all` in disguise. `--db` is the one global option that means anything here.
 */
export function parseRequest(argv: readonly string[]): UnparkRequest | undefined {
  const values = new Map<string, string>();
  let all = false;
  for (let i = argv[0] === "unpark" ? 1 : 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--all") {
      all = true;
      continue;
    }
    const name = ["--route", "--tier", "--db"].includes(a) ? a.slice(2) : undefined;
    if (name === undefined) {
      throw new UsageError(`unknown argument '${a}' — lore unpark takes --route <prefix>, --tier <prefix> or --all`);
    }
    const v = argv[i + 1];
    if (v === undefined || v === "" || v.startsWith("--")) {
      throw new UsageError(`--${name} needs a value: lore unpark --${name} <id or prefix>`);
    }
    if (values.has(name)) throw new UsageError(`--${name} given twice — give it once`);
    values.set(name, v);
    i++;
  }
  const route = values.get("route");
  const tier = values.get("tier");
  if (all) {
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

/** The tiers that have this route as a PRIMARY — the only role D-94's route probe reaches. */
function primaryOf(route: string, ladder: Ladder): readonly string[] {
  return ladder.tiers.filter((t) => t.kind === "model" && routesFor(t, ladder.pools).includes(route)).map((t) => t.id);
}

/**
 * Whether lore would ask again without being told, and when — the line that decides
 * whether clearing buys anything. Mirrors the table at the top of this file, which
 * mirrors `review.ts`; lore's own review found it saying more than review.ts does four
 * times before it did (fingerprints e0fa6114, 3e88004b, and b13d07f3 — a guessed route
 * is re-tested only as a tier's PRIMARY; a fallback-only route waits out its time, so on
 * the deployed ladder "the next review re-tests it" would have told the person who reset
 * plan 2 to wait hours for nothing).
 */
function onItsOwn(p: Park, now: number, ladder: Ladder | Error): string {
  if (Date.parse(p.until) <= now) return "expired: blocks nothing now, kept for its failure count";
  const probedAt = p.probedAt === undefined ? Number.NaN : Date.parse(p.probedAt);
  const nextProbe = Number.isNaN(probedAt) ? now : probedAt + PROBE_INTERVAL_MS;
  const due = nextProbe <= now ? "the next review" : `the first review after ${new Date(nextProbe).toISOString()}`;
  const who = p.stated ? "provider-stated" : "lore's guess";
  if (p.kind === "route") {
    if (ladder instanceof Error) {
      return `${who}: whether any review re-tests it is unknown — the ladder could not be read (${ladder.message})`;
    }
    const tiers = primaryOf(p.id, ladder);
    if (tiers.length === 0) return `${who}: not any tier's primary, so no probe reaches it — it waits out ${p.until}`;
    return p.stated
      ? `provider-stated: not re-tested before ${p.until}, unless ${tiers.join(", ")} is parked too and its ` +
          "probe comes due first"
      : `lore's guess, primary of ${tiers.join(", ")}: ${due} that needs it re-tests it`;
  }
  return p.stated
    ? `provider-stated: reviews skip this tier's primary; ${due} that needs it probes it`
    : `lore's guess: reviews still call it — ${due} as a probe, under the shorter probe deadline — ` +
        `and the background screen waits until ${p.until}`;
}

/**
 * `cleared` drops the line about what lore would do on its own: that line describes a mark,
 * and a cleared one no longer exists. Found by lore's own review, fingerprint 05e651dd — the
 * first version reused the listing's wording after a clear, so an expired mark came back as
 * "kept for its failure count" two lines above the text saying the count was gone.
 */
export function describePark(p: Park, now: number, ladder: Ladder | Error, cleared = false): string {
  // A route's mark records which refusal it was (D-143); a tier's does not — it may be a
  // stated limit reset or a screen that went unanswered — so a tier gets no label and its
  // `why` speaks for it, rather than a label that would be a guess.
  const what = p.kind === "tier" ? [] : [p.auth ? "credential rejected" : "quota"];
  const force = Date.parse(p.until) <= now ? "expired" : `in force until ${p.until}`;
  const facts = [...what, `${String(p.failures)} failure(s)`, force].join(", ");
  return (
    `${p.kind.padEnd(5)} ${p.id}  [${facts}]\n` +
    (cleared ? "" : `      ${onItsOwn(p, now, ladder)}\n`) +
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

const BOTH_KINDS =
  "A review skips a tier's primary while the tier carries a provider-stated mark or that\n" +
  "route is parked, so if your fix covers both, clear both.";

export function renderParks(list: readonly Park[], now: number, ladder: Ladder | Error): string {
  if (list.length === 0) return "nothing parked — lore is not refusing to ask anything.\n";
  return [
    "parked:",
    ...list.map((p) => describePark(p, now, ladder)),
    "",
    "clear with --route <prefix>, --tier <prefix>, or --all.",
    BOTH_KINDS,
    AFTER_CLEARING,
    "",
  ].join("\n");
}

/** The ladder a clear is judged against: which routes are each tier's primary. */
export interface Ladder {
  readonly tiers: readonly Tier[];
  readonly pools: ModelPools;
}

/**
 * The marks still in force that stand in front of what was just cleared.
 *
 * Found by lore's own review, fingerprint 59ae6ccc: listing EVERY remaining mark as a
 * possible blocker sent an operator to clear unrelated ones too, deleting failure counts
 * lore still needed. The relationship is read off the ladder instead, by `review.ts`'s own
 * order: a tier's cool-off is checked before its PRIMARY routes and not before its
 * fallbacks, which are walked regardless. So a cleared ROUTE is blocked by a STATED tier
 * mark on any tier it is a primary route of, and a cleared TIER by route marks only when every one
 * of its primary routes is still parked — a pool twin that is free serves it.
 */
export function blockers(cleared: readonly Park[], remaining: readonly Park[], ladder: Ladder, now: number): readonly Park[] {
  const primaries = (tierId: string): readonly string[] => {
    const t = ladder.tiers.find((x) => x.id === tierId && x.kind === "model");
    return t === undefined ? [] : routesFor(t, ladder.pools);
  };
  const inForce = remaining.filter((p) => Date.parse(p.until) > now);
  const parkedRoutes = new Set(inForce.filter((p) => p.kind === "route").map((p) => p.id));
  return inForce.filter((m) =>
    m.kind === "tier"
      ? // STATED only — found by lore's own review, fingerprint 24b6c2f3: `inCoolOff` in
        // review.ts is `down.stated && …`, so a guessed tier mark keeps no review off the
        // tier, and naming it here sent an operator to delete the screen's failure count.
        m.stated && cleared.some((c) => c.kind === "route" && primaries(m.id).includes(c.id))
      : cleared.some((c) => {
          if (c.kind !== "tier") return false;
          const routes = primaries(c.id);
          return routes.includes(m.id) && routes.every((r) => parkedRoutes.has(r));
        }),
  );
}

/**
 * The clear, and what still stands in front of it — never a promise past it. Found by
 * lore's own review, fingerprint ac16d99e: every clear used to end "the next review that
 * needs one asks it", false while a stated tier mark still blocked the route just cleared.
 *
 * `ladder` is an `Error` when the ladder could not be read; then which remaining mark
 * blocks what is unknown, and the output says exactly that rather than guessing either way.
 */
export function renderCleared(cleared: readonly Park[], remaining: readonly Park[], now: number, ladder: Ladder | Error): string {
  const inForce = remaining.filter((p) => Date.parse(p.until) > now);
  const after =
    inForce.length === 0
      ? ["Nothing else is parked: the next review that reaches these asks them."]
      : ladder instanceof Error
        ? [
            `The ladder could not be read (${ladder.message}), so whether the ${String(inForce.length)} mark(s) still in`,
            "force stand in front of these is unknown. Run `lore unpark` to see them.",
            BOTH_KINDS,
          ]
        : ((): string[] => {
            const blocking = blockers(cleared, remaining, ladder, now);
            return blocking.length === 0
              ? ["Nothing still parked stands in front of these: the next review that reaches them asks them."]
              : ["Still parked, and in front of what you cleared:", ...blocking.map((p) => describePark(p, now, ladder)), BOTH_KINDS];
          })();
  return [
    ...cleared.map((p) => `cleared ${describePark(p, now, ladder, true)}`),
    "",
    `${String(cleared.length)} mark(s) cleared.`,
    ...after,
    AFTER_CLEARING,
    "",
  ].join("\n");
}
