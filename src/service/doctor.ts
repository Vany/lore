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

import { createOpencodeClient } from "@opencode-ai/sdk";
import { loadTiers, vendorOf, type Tier } from "../core/ladder.ts";
import { longFetch } from "../reviewer/long-fetch.ts";
import { DEFAULT_REVIEWER, type ReviewerConfig } from "../reviewer/opencode.ts";

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** A failed check that does not prevent reviewing. */
  readonly warning?: boolean;
}

function client(cfg: ReviewerConfig) {
  const basic =
    cfg.password === undefined
      ? undefined
      : `Basic ${Buffer.from(`${cfg.username ?? ""}:${cfg.password}`).toString("base64")}`;
  return createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: longFetch(cfg.timeoutMs),
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
  let providers: { id?: string; models?: Record<string, unknown> }[] = [];
  let connected = new Set<string>();
  try {
    const res = await api.provider.list();
    const status = res.response?.status ?? 200;
    if (status === 401) {
      checks.push({
        name: "opencode auth",
        ok: false,
        detail: `401 from ${cfg.baseUrl} — set OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD to match the server`,
      });
      return checks;
    }
    // `all` is the catalogue of providers opencode KNOWS. `connected` is the ones
    // it can actually reach. The distinction is the whole point: a model id can be
    // perfectly valid and still unusable because nobody authenticated its provider.
    const data = res.data as { all?: typeof providers; connected?: string[] } | undefined;
    providers = data?.all ?? [];
    connected = new Set(data?.connected ?? []);
    checks.push({
      name: "opencode reachable",
      ok: true,
      detail: `${cfg.baseUrl} · ${connected.size} authenticated of ${providers.length} known: ${[...connected].join(", ") || "none"}`,
    });
  } catch (e) {
    checks.push({
      name: "opencode reachable",
      ok: false,
      detail: `${cfg.baseUrl}: ${e instanceof Error ? e.message : String(e)} — is 'opencode serve' running?`,
    });
    return checks;
  }

  const known = new Set<string>();
  for (const p of providers) {
    for (const m of Object.keys(p.models ?? {})) known.add(`${p.id ?? ""}/${m}`);
  }

  // The check that pays for this file. Either failure — a model id that resolves
  // to nothing, or a real id whose provider nobody authenticated — otherwise
  // surfaces mid-review, after the diff, T0 and the prompt have all been paid for.
  for (const tier of tiers.filter((t) => t.kind === "model")) {
    const id = tier.model ?? "";
    const provider = id.split("/")[0] ?? "";
    const idExists = known.has(id);
    const providerReady = connected.has(provider);

    checks.push({
      name: `tier ${tier.id}`,
      ok: idExists && providerReady,
      detail: !idExists
        ? `'${id}' is not a known model — check the id with 'opencode models'${suggest(known, id)}`
        : !providerReady
          ? `'${id}' is valid but '${provider}' is not authenticated — run 'opencode auth login' and choose it`
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
