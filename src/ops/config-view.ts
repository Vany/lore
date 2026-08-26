/**
 * THE SHAPE OF THIS DEPLOYMENT, IN ONE PLACE (D-118).
 *
 * Vany: *"make config window on web with this checkbox, also put all parameters there."*
 *
 * The knobs that matter are the ones that cost money or decide what runs, and they are
 * spread across a `.env` nobody reads, a JSON file on the host, and `make` targets only
 * one person runs. An operator cannot see the shape of their own deployment — which is
 * not a convenience complaint: on 2026-08-16 the answer to *"why did this cost $101.36"*
 * was one variable in one file, and nothing anywhere displayed it.
 *
 * **READ ONLY, and that is a decision rather than an unfinished edge.** Making a knob
 * live-editable means every reader of it going through one resolver, and today several
 * read `process.env` directly — `concreteRoute`, `noRouteBecause`, `renderStatus`. Wiring
 * some of them would leave this page asserting a value the ladder does not use, which is
 * exactly the class of defect this repository keeps paying for: a rule stated in one place
 * and applied in another. So each entry says whether it can be changed and how, and
 * nothing here pretends to change it.
 *
 * `source` is on every row for the same reason. "0" means nothing without "because you set
 * it" or "because that is the default", and the 2026-08-16 post-mortem needed exactly that
 * distinction to answer whether anybody had chosen the behaviour.
 */

import { DEFAULT_TIERS, exemptLiteral, loadPools, loadTiers, ladderIsOperatorWritten, routesFor } from "../core/ladder.ts";
import { allowMeteredFromEnv, isMeteredRoute } from "../core/metered.ts";
import { MAX_OPEN_REVIEWS } from "../core/admission.ts";
import { DEFAULT_RETENTION } from "./retention.ts";

export interface ConfigEntry {
  /** What an operator calls it — the environment variable where there is one. */
  readonly name: string;
  readonly value: string;
  /** Where this value came from, because a default and a choice read identically. */
  readonly source: "set here" | "built-in default";
  /** What it does, in one sentence, for somebody who has never read the spec. */
  readonly what: string;
  /**
   * How to change it, or why it cannot be changed from here.
   *
   * Never an empty string and never omitted: a row with no answer to "can I change this"
   * invites the reader to assume the page will let them, which it will not.
   */
  readonly change: string;
}

export interface ConfigView {
  readonly entries: readonly ConfigEntry[];
  /**
   * The ladder, resolved — what will ACTUALLY be called, not what the file says.
   *
   * A nickname in a tiers file is not a model id, and the difference is where two of this
   * month's incidents lived. Showing the configured text alone would reproduce the exact
   * blindness the window exists to remove.
   */
  readonly ladder: readonly {
    readonly tier: string;
    readonly configured: string;
    readonly routes: readonly string[];
    /**
     * Every concrete route this tier's OWN fallback chain can reach (`ladder.ts`'s
     * `fallbackRoutes`, scoped to this tier) — found by lore's own review,
     * fingerprint 60dcf7a5: a tier can be entirely free on its primary and still
     * bill, because a round pays on the fallback whenever `LORE_ALLOW_METERED=1` walks
     * the chain there (D-109). Omitted from `routes` before this fix, `metered`
     * below read `false` for exactly the deployed shape this page exists to warn
     * about — a free pooled primary with a metered fallback.
     */
    readonly fallbackRoutes: readonly string[];
    /** Whether any route this tier can reach, primary or fallback, bills per call (D-117). */
    readonly metered: boolean;
    /**
     * Does a LITERAL model id on this tier bypass `LORE_ALLOW_METERED` entirely
     * (D-117's `exemptLiteral`)? A person who names a specific paid route directly,
     * on an operator-written ladder, has already chosen it — the flag gates only
     * routes LORE would otherwise pick between (a pool, or the built-in default).
     */
    readonly exempt: boolean;
  }[];
  /**
   * The one sentence that answers "will an outage cost me money or coverage".
   *
   * Derived rather than restated, so it cannot drift from the entries above it.
   */
  readonly summary: string;
}

const entry = (
  name: string,
  raw: string | undefined,
  fallback: string,
  what: string,
  change: string,
): ConfigEntry => ({
  name,
  value: raw === undefined || raw.trim() === "" ? fallback : raw,
  source: raw === undefined || raw.trim() === "" ? "built-in default" : "set here",
  what,
  change,
});

export function configView(env: NodeJS.ProcessEnv = process.env): ConfigView {
  const allowMetered = allowMeteredFromEnv(env["LORE_ALLOW_METERED"]);
  // BOTH FROM THE SAME SOURCE. `loadPools()` defaults to `process.env` while the tiers
  // came from the argument, so a caller naming an env — every test, and any future caller
  // describing a deployment that is not this process — got one ladder's tiers with another
  // ladder's pools, and a pooled tier rendered as its nickname. Two readers of one setting,
  // which is the shape this page exists to make visible.
  const source = env["LORE_TIERS"];
  const pools = loadPools(source);
  const tiers = ladderIsOperatorWritten(source) ? loadTiers(source) : DEFAULT_TIERS;

  const ladder = tiers
    .filter((t) => t.kind === "model")
    .map((t) => {
      // The shared resolver, not a second hand-rolled copy of it — found by lore's
      // own review against the SAME mistake this whole session keeps finding: one
      // thing defined twice always disagrees eventually.
      const routes = routesFor(t, pools);
      const fallback = (t.fallback ?? []).flatMap((f) => routesFor({ ...t, model: f }, pools));
      return {
        tier: t.id,
        configured: t.model ?? "",
        routes,
        fallbackRoutes: fallback,
        metered: routes.some(isMeteredRoute) || fallback.some(isMeteredRoute),
        exempt: exemptLiteral(t, pools, source),
      };
    });

  const entries: ConfigEntry[] = [
    entry(
      "LORE_ALLOW_METERED",
      env["LORE_ALLOW_METERED"],
      "0",
      "Whether a review may fall back onto a route that bills per call. At 0 the tier is skipped " +
        "instead, and the verdict says so.",
      "Set it in the deployment's .env and redeploy. It is NOT editable here yet — see the module note.",
    ),
    entry(
      "LORE_TIERS",
      env["LORE_TIERS"],
      "(unset — the built-in ladder)",
      "The ladder: which models review, in which order, with which fallbacks.",
      "Edit the tiers file and redeploy. Unset means the BUILT-IN ladder, whose tiers are all metered.",
    ),
    entry("LORE_PORT", env["LORE_PORT"], "7777", "The port MCP and this board are served on.", "Redeploy."),
    entry("LORE_HOST", env["LORE_HOST"], "0.0.0.0", "The interface bound. The perimeter is the tailnet (D-33).", "Redeploy."),
    entry(
      "LORE_WEBHOOK_URL",
      env["LORE_WEBHOOK_URL"] === undefined ? undefined : "(set)",
      "(unset — alerts are logged only)",
      "Where operator alerts go. Unset means they reach the log and nowhere else.",
      "Redeploy. The value is never shown here — it is a credential in most deployments.",
    ),
    entry(
      "LORE_BACKUP_DIR",
      env["LORE_BACKUP_DIR"],
      "(unset — replica unmonitored)",
      "Litestream's replica folder, so the service can page when the knowledge base stops replicating.",
      "Redeploy. Unset reports `replica: unconfigured`, which is not the same as healthy.",
    ),
    {
      name: "admission limit",
      value: String(MAX_OPEN_REVIEWS),
      source: "built-in default",
      what: "How many reviews may be open at once before review_start refuses a new one (D-98).",
      change: "Not configurable. It is the bound that replaced a worker-pool size.",
    },
    {
      name: "retention",
      value: `${String(DEFAULT_RETENTION.staleHours)}h to stale, ${String(DEFAULT_RETENTION.reviewDays)}d to deletion`,
      source: "built-in default",
      what: "How long an unanswered review stays answerable, and how long its rows survive after it ends.",
      change: "Not configurable.",
    },
  ];

  // SPLIT BY WHETHER `LORE_ALLOW_METERED` GOVERNS THE ROUTE AT ALL — found by lore's
  // own review, fingerprint 60dcf7a5. The original split only on `allowMetered`,
  // which is correct for a POOLED tier and wrong for an EXEMPT literal one: D-117's own rule
  // is that naming a paid route directly, on an operator-written ladder, is the
  // operator switching it on regardless of the flag (`exemptLiteral`). Under
  // ALLOW_METERED=0 the old summary told an operator "Paid routes are REFUSED" for
  // a tier that was billing every round — the one page built to answer "will this
  // cost me money", giving the opposite answer.
  //
  // EXEMPTION IS A PROPERTY OF THE PRIMARY ROUTE ONLY, never the fallback — my own
  // first draft of this fix got that wrong, checking `l.metered` (primary OR
  // fallback) against `l.exempt` (a fact about the primary alone) as though they
  // shared one flag. `runRound`'s own comment on the fallback chain is explicit:
  // "THE PRIMARY IS DELIBERATELY NOT FILTERED [when exempt]... A fallback is
  // CONDITIONAL... only one of them can surprise somebody" — the fallback chain is
  // filtered by `allowMetered` alone (`withoutMetered(reachable, input.allowMetered)`),
  // with no exemption check at all, regardless of whether the tier's primary is
  // exempt. So a tier can genuinely belong to BOTH lists at once: an exempt literal
  // primary that bills unconditionally, with a metered fallback that is still gated.
  const exempt = ladder.filter((l) => l.routes.some(isMeteredRoute) && l.exempt).map((l) => l.tier);
  // GATED SPLITS AGAIN, BY WHETHER THE MONEY IS OUTAGE-SHAPED — found by lore's own
  // review, fingerprint ec572ac6, against this same fix's OWN prior wording: "can
  // reach one on an outage" is only true for a metered FALLBACK. A metered route
  // sitting in a POOLED PRIMARY is not outage-gated at all — `runRound`'s own
  // comment on `pool[0]`: "a nickname's pool can put a paid route there — in some
  // rounds by shuffle, in every round once the free routes are parked" — so under
  // LORE_ALLOW_METERED=1 such a tier can bill on ANY ordinary round, healthy or
  // not, and under =0 a pool that is ENTIRELY metered runs no round at all rather
  // than "costing on an outage".
  //
  // THE TWO CHECKS ARE INDEPENDENT, not `else` branches of one another — a second
  // bug caught rewriting this same fix, before it shipped: whether the PRIMARY is
  // pooled-metered says nothing about whether the FALLBACK is separately metered
  // too, and gating `gatedFallback` on "the primary is NOT metered" excluded
  // exactly the tier the previous fix's own test exists for (an exempt literal
  // primary with a genuinely gated metered fallback) — that tier's primary is
  // metered, so the wrongly-`!`-guarded check dropped its fallback from the
  // summary entirely, the fallback note simply never appearing. A tier can be in
  // `exempt` for its primary AND `gatedFallback` for its fallback at once.
  const gatedPooled = ladder.filter((l) => l.routes.some(isMeteredRoute) && !l.exempt).map((l) => l.tier);
  const gatedFallback = ladder.filter((l) => l.fallbackRoutes.some(isMeteredRoute)).map((l) => l.tier);

  const exemptNote =
    exempt.length === 0
      ? undefined
      : `${exempt.join(", ")} ${exempt.length === 1 ? "names" : "name"} a paid route directly and ` +
        `${exempt.length === 1 ? "pays" : "pay"} every round regardless of LORE_ALLOW_METERED — an ` +
        "operator-written ladder naming a specific paid route IS the operator switching it on (D-117).";
  const gatedPooledNote =
    gatedPooled.length === 0
      ? undefined
      : allowMetered
        ? `A paid route sits in ${gatedPooled.join(", ")}'s own pool, so it can be picked on ANY round, not ` +
          "only an outage — every round once its free pool-mates are all parked, and some rounds before that."
        : `${gatedPooled.join(", ")} keeps a paid route out of its pool under LORE_ALLOW_METERED=0 — reviews ` +
          "run on its free pool-mates, or not at all if none are reachable, and the verdict is reported as " +
          "partial rather than clean when that happens.";
  const gatedFallbackNote =
    gatedFallback.length === 0
      ? undefined
      : allowMetered
        ? `Paid fallback routes are ALLOWED, and ${gatedFallback.join(", ")} can reach one on an outage. That outage costs money.`
        : `Paid fallback routes are REFUSED, and ${gatedFallback.join(", ")} can only reach one. An outage costs ` +
          "those tiers, and the verdict is reported as partial rather than clean.";

  const summary =
    exemptNote === undefined && gatedPooledNote === undefined && gatedFallbackNote === undefined
      ? "No tier in this ladder can reach a route that bills per call. An outage costs coverage, never money."
      : [exemptNote, gatedPooledNote, gatedFallbackNote].filter((s) => s !== undefined).join(" ");

  return { entries, ladder, summary };
}
