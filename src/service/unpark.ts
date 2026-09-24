/**
 * What lore is refusing to ask, and forgetting it on an operator's word (D-155).
 *
 * lore parks what refused it — one subscription's ROUTE (D-93) or a whole TIER (D-90) —
 * and learns of a recovery only by asking again. The person who just reset a limit,
 * upgraded a plan or re-logged a credential knows what lore cannot: the refusal stopped
 * being true. This is how they say so. It exists because it kept happening — a plan
 * upgrade on 2026-09-16 and limit resets on 2026-09-22 and 2026-09-24 were each cleared
 * with a hand-typed `node -e` into the container, and a hand-typed DELETE exits 0 whether
 * or not its key matched anything.
 *
 * FACTS PER MARK, RULES ONCE. Each mark is listed as what it is — route or tier, who named
 * the wait, until when, when last probed, how many failures, why — and what lore does with
 * each kind on its own is stated once, as `LEGEND`. The first version predicted per mark
 * whether lore would re-ask and what still blocked a clear; every such prediction was a
 * second implementation of `review.ts`'s routing (cool-off, probe due, metered gate, pools
 * and spares), and a second copy of that logic drifts from the first. Facts do not. Vany
 * chose this over computing the predictions exactly through one shared definition.
 *
 * SPEC: spec/operations.md §2.4.2
 */

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

/**
 * One mark, as facts only. A route's mark records which refusal it was (D-143); a tier's
 * does not — it may be a stated limit reset or a screen that went unanswered — so a tier gets
 * no label and its `why` speaks for it, rather than a label that would be a guess.
 */
export function describePark(p: Park, now: number): string {
  const facts = [
    ...(p.kind === "route" ? [p.auth ? "credential rejected" : "quota"] : []),
    p.stated ? "provider-stated" : "lore's guess",
    `${String(p.failures)} failure(s)`,
    Date.parse(p.until) > now ? `in force until ${p.until}` : `expired ${p.until}`,
    p.probedAt === undefined ? "never probed" : `last probed ${p.probedAt}`,
  ].join(", ");
  return `${p.kind.padEnd(5)} ${p.id}  [${facts}]\n      why: ${p.why}`;
}

/**
 * What lore does with each kind of mark on its own — stated once, by rule, with the
 * decision each line comes from, so a reader can check it against SPEC rather than trust
 * a per-mark prediction. The two "waited out" lines are the cases a clear exists for.
 */
export const LEGEND = [
  "Re-tested by the next review that reaches it, at most every 15 minutes:",
  "  a route lore guessed about, while some tier uses it as its primary (D-125)",
  "  a tier the provider stated a reset for — reviews skip its primary between probes (D-94)",
  "Waited out until its time, however wrong that has become:",
  "  a route the provider stated a reset for (D-91), unless a probe of its tier asks it first",
  "  a route that is only a fallback, or is metered while metered use is off",
  "A tier lore guessed about holds back only the background screen; reviews still call it.",
  "An expired mark holds nothing back; it is kept for the failure count the next backoff uses.",
].join("\n");

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
    LEGEND,
    "",
    "If you fixed what a mark names, clear it: --route <prefix>, --tier <prefix>, or --all.",
    AFTER_CLEARING,
    "",
  ].join("\n");
}

/**
 * The clear, and what is still in force — facts, never a promise about the next review.
 *
 * "Nothing else is IN FORCE", not "nothing else is parked": an expired mark is still held,
 * for its failure count, and the next listing shows it — found by lore's own review,
 * fingerprint 1bf96fd2, when the clear's last line contradicted the listing after it.
 */
export function renderCleared(cleared: readonly Park[], remaining: readonly Park[], now: number): string {
  const inForce = remaining.filter((p) => Date.parse(p.until) > now);
  return [
    ...cleared.map((p) => `cleared ${describePark(p, now)}`),
    "",
    `${String(cleared.length)} mark(s) cleared.`,
    ...(inForce.length === 0
      ? ["Nothing else is in force."]
      : ["Still in force:", ...inForce.map((p) => describePark(p, now)), "", LEGEND]),
    AFTER_CLEARING,
    "",
  ].join("\n");
}
