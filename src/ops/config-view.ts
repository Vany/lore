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

import { DEFAULT_TIERS, loadPools, loadTiers, ladderIsOperatorWritten } from "../core/ladder.ts";
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
    /** Whether any route for this tier bills per call (D-117). */
    readonly metered: boolean;
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
      const named = t.model ?? "";
      const routes = pools[named] ?? (named === "" ? [] : [named]);
      return { tier: t.id, configured: named, routes, metered: routes.some(isMeteredRoute) };
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

  const paid = ladder.filter((l) => l.metered).map((l) => l.tier);
  const summary =
    paid.length === 0
      ? "No tier in this ladder can reach a route that bills per call. An outage costs coverage, never money."
      : allowMetered
        ? `Paid routes are ALLOWED, and ${paid.join(", ")} can reach one. An outage costs money.`
        : `Paid routes are REFUSED, and ${paid.join(", ")} can only reach one. An outage costs those tiers, ` +
          "and the verdict is reported as partial rather than clean.";

  return { entries, ladder, summary };
}
