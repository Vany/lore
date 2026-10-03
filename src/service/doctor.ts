/**
 * Preflight: is this deployment actually able to review anything?
 *
 * Every check here exists because its failure is otherwise discovered *during* a
 * review — as an unparseable reply, a bare 401, or a model id that resolves to
 * nothing. Those all surface as "the review did not run", which is honest but
 * useless: it says something is broken without saying what.
 *
 * Run before the first review, and after any change to tiers or credentials.
 */

import { ClientError, OpenCode } from "@opencode/client";
import { loadTiers, vendorOf, type Tier } from "../core/ladder.ts";
import { longFetch } from "../reviewer/long-fetch.ts";
import { DEFAULT_REVIEWER, V2_USER, type ReviewerConfig } from "../reviewer/opencode.ts";

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** A failed check that does not prevent reviewing. */
  readonly warning?: boolean;
}

/** Shared with `ladder-setup/catalog.ts` — the same authenticated client both need. */
export function client(cfg: ReviewerConfig) {
  // lore-ok[0738503c]: a password-only v2 config sends the user `opencode` (V2_USER), not "".
  const basic =
    cfg.password === undefined
      ? undefined
      : `Basic ${Buffer.from(`${cfg.username ?? V2_USER}:${cfg.password}`).toString("base64")}`;
  return OpenCode.make({
    baseUrl: cfg.baseUrl,
    fetch: longFetch(cfg.timeoutMs) as typeof globalThis.fetch,
    ...(basic === undefined ? {} : { headers: { Authorization: basic } }),
  });
}

export async function doctor(cfg: ReviewerConfig = DEFAULT_REVIEWER): Promise<readonly Check[]> {
  const checks: Check[] = [];

  let tiers: readonly Tier[] = [];
  try {
    tiers = loadTiers();
    checks.push({
      name: "tier config",
      ok: true,
      detail: tiers.map((t) => t.model ?? t.kind).join(" → "),
    });
  } catch (e) {
    return [{ name: "tier config", ok: false, detail: e instanceof Error ? e.message : String(e) }];
  }

  // Independence is the premise of the whole design (D-1/D-7). A single-vendor
  // ladder is workable but degraded, and the operator should be reminded every
  // time rather than only once at configuration.
  const vendors = new Set(tiers.filter((t) => t.kind === "model").map((t) => vendorOf(t.model ?? "")));
  checks.push({
    name: "vendor diversity",
    ok: vendors.size > 1,
    warning: true,
    detail:
      vendors.size > 1
        ? `${vendors.size} vendors: ${[...vendors].join(", ")}`
        : `only ${[...vendors][0] ?? "?"} — tiers share blind spots, so this is closer to one opinion asked ${tiers.filter((t) => t.kind === "model").length} times`,
  });

  const api = client(cfg);

  // Reachability and auth are separate failures with the same symptom, so they are
  // separate checks: a bare 401 looks identical to a wrong port from a stack trace.
  //
  // THREE LISTS IN v2, where v1 had one with two halves. `/api/integration` is every
  // provider opencode KNOWS how to connect; `/api/provider` is the ones it HAS connected;
  // `/api/model` is what the connected ones offer. The distinction is the whole point: a
  // model id can be perfectly valid and still unusable because nobody authenticated its
  // provider — and v2 cannot list an unconnected provider's models at all, so for that
  // case the honest answer is "provider not connected", not "model unknown".
  let integrations = new Set<string>();
  let connected = new Set<string>();
  const known = new Set<string>();
  try {
    const [ints, provs, models] = await Promise.all([api.integration.list(), api.provider.list(), api.model.list()]);
    integrations = new Set(ints.data.map((i) => i.id));
    // LISTED IS NOT USABLE: a provider with `activation: "disabled"` or a model with
    // `enabled: false` is returned and cannot be called. Counted as ready, it would pass
    // here and fail only after a review had paid for its diff and its sweep.
    connected = new Set(provs.data.filter((p) => p.activation !== "disabled").map((p) => p.id));
    for (const m of models.data) if (m.enabled !== false) known.add(`${m.providerID}/${m.id}`);
    checks.push({
      name: "opencode reachable",
      ok: true,
      detail: `${cfg.baseUrl} · ${connected.size} connected of ${integrations.size} known: ${[...connected].join(", ") || "none"}`,
    });
  } catch (e) {
    const status = e instanceof ClientError ? (e.cause as { status?: unknown } | undefined)?.status : undefined;
    const tag = (e as { _tag?: unknown } | undefined)?._tag;
    if (status === 401 || tag === "UnauthorizedError") {
      checks.push({
        name: "opencode auth",
        ok: false,
        detail: `401 from ${cfg.baseUrl} — set OPENCODE_SERVER_PASSWORD to match the server; opencode v2 accepts only the user name \`opencode\``,
      });
      return checks;
    }
    checks.push({
      name: "opencode reachable",
      ok: false,
      detail: `${cfg.baseUrl}: ${e instanceof Error ? e.message : String(e)} — is 'opencode serve' running?`,
    });
    return checks;
  }

  // The check that pays for this file. Either failure — a model id that resolves
  // to nothing, or a real id whose provider nobody authenticated — otherwise
  // surfaces mid-review, after the diff, T0 and the prompt have all been paid for.
  for (const tier of tiers.filter((t) => t.kind === "model")) {
    const id = tier.model ?? "";
    const provider = id.split("/")[0] ?? "";
    const providerReady = connected.has(provider);
    const idExists = known.has(id);

    checks.push({
      name: `tier ${tier.id}`,
      ok: idExists && providerReady,
      // Provider first: an unconnected provider's models are not listed at all, so
      // "unknown model" there would be a guess presented as a finding.
      detail: !providerReady
        ? integrations.has(provider)
          ? `'${provider}' is not connected — run 'make sync-creds' after 'opencode auth login' on the host`
          : `'${provider}' is not a provider opencode knows — check the id with 'opencode models'${suggest(known, id)}`
        : !idExists
          ? `'${id}' is not a model '${provider}' offers — check the id with 'opencode models'${suggest(known, id)}`
          : `${id} ready`,
    });
  }

  return checks;
}

export function render(checks: readonly Check[]): string {
  const lines = checks.map((c) => {
    const mark = c.ok ? "ok  " : c.warning === true ? "warn" : "FAIL";
    return `  [${mark}] ${c.name.padEnd(20)} ${c.detail}`;
  });

  const failed = checks.filter((c) => !c.ok && c.warning !== true);
  lines.push(
    "",
    failed.length === 0
      ? "ready — every configured model resolves."
      : `NOT ready: ${failed.length} check(s) failed. A review would start, spend on the diff and T0, and then not run.`,
  );
  return lines.join("\n");
}

export function healthy(checks: readonly Check[]): boolean {
  return checks.every((c) => c.ok || c.warning === true);
}

/**
 * Offer near-misses for a model id that does not exist.
 *
 * A wrong id is almost always a wrong *prefix* — the same GLM model is published
 * by a dozen gateways under a dozen names. Printing the real ones is faster than
 * telling someone to go and grep for them.
 */
function suggest(known: ReadonlySet<string>, wanted: string): string {
  const leaf = (wanted.split("/").pop() ?? "").toLowerCase();
  if (leaf.length < 3) return "";
  const near = [...known].filter((k) => k.toLowerCase().endsWith(`/${leaf}`)).slice(0, 4);
  return near.length === 0 ? "" : `. Did you mean: ${near.join(", ")}`;
}
