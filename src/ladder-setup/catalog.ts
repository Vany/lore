/**
 * What a bare OpenRouter credential can actually reach, right now.
 *
 * `DEFAULT_TIERS` (`core/ladder.ts`) is a hardcoded three-model guess, written once and
 * never re-checked against what OpenRouter offers — prices move, models get deprecated,
 * new ones ship. This asks opencode itself, the same way `doctor.ts` already validates an
 * operator-written ladder after the fact: `api.provider.list()`, not OpenRouter's own
 * `/api/v1/models` directly, so every candidate is guaranteed reachable by THIS
 * deployment's opencode rather than merely listed somewhere.
 *
 * SPEC: spec/review-ladder.md
 */

import { vendorOf } from "../core/ladder.ts";
import { DEFAULT_REVIEWER, type ReviewerConfig } from "../reviewer/opencode.ts";
import { client } from "../service/doctor.ts";

export interface CatalogModel {
  /** Provider-qualified, exactly the shape a `Tier.model` field expects. */
  readonly id: string;
  /** The underlying organisation — z-ai, moonshotai, openai, anthropic, ... — for the
   *  one-vendor-per-tier rule (D-32/D-49), not the route prefix (always "openrouter"). */
  readonly vendor: string;
  /** Per-token, in the currency opencode reports it (USD). `undefined` when unpriced. */
  readonly costInput: number | undefined;
  readonly costOutput: number | undefined;
  readonly contextTokens: number;
}

/**
 * Only the fields this module reads, named locally rather than importing the SDK's own
 * generated response type into pure logic — narrower, and does not need editing every
 * time an unrelated field is added to `ProviderListResponses`.
 *
 * `capabilities.toolcall`, NOT a flat `tool_call` — found live, against a real deployment,
 * fingerprint-worthy on its own: `node_modules/@opencode-ai/sdk`'s own generated
 * `types.gen.d.ts` names TWO different shapes for what is nominally the same "model"
 * concept (`ProviderListResponses`'s inline type has a flat, snake_case `tool_call`; a
 * separate exported `Model` type nearby has `capabilities: { toolcall, ... }`), and the
 * live server's actual wire response matches the SECOND one for THIS endpoint — every
 * one of 353 real OpenRouter models filtered to zero before this was corrected, caught
 * only by running `lore ladder-suggest` against the real deployment rather than trusting
 * either static type on its own.
 */
export interface RawModel {
  readonly capabilities: { readonly toolcall: boolean };
  readonly status?: "alpha" | "beta" | "deprecated" | "active";
  readonly cost?: { readonly input: number; readonly output: number };
  readonly limit: { readonly context: number };
}

/**
 * `status` and `cost` are BOTH optional on the wire — a model missing `status` is not
 * thereby unusable, so this excludes only what is explicitly marked bad rather than
 * requiring an explicit "active". Excluding on absence would shrink the candidate pool
 * for a field plenty of models apparently just don't report.
 */
const EXCLUDED_STATUS = new Set(["deprecated", "alpha"]);

/**
 * The pure half: what a provider's own `models` map reduces to once filtered to what a
 * review session can actually use. Tool-call support is not optional for an agentic
 * reviewer, and a deprecated or alpha model is not a bet worth a fresh install making by
 * default. Separated from `fetchCatalog` so this — the part with real branches worth
 * testing — needs no network, no opencode, no `ReviewerConfig` to exercise.
 */
export function filterCatalog(models: Readonly<Record<string, RawModel>>): readonly CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const [modelId, m] of Object.entries(models)) {
    if (!m.capabilities.toolcall) continue;
    if (m.status !== undefined && EXCLUDED_STATUS.has(m.status)) continue;
    const id = `openrouter/${modelId}`;
    out.push({
      id,
      // `~` STRIPPED FIRST — found live against the real deployment, fingerprint
      // fc9e8468: OpenRouter's own catalog carries a SECOND namespace for at least
      // seven vendors (`~anthropic/claude-opus-latest` alongside `anthropic/claude-
      // opus-5`, and six more — `~x-ai`, `~z-ai`, `~openai`, `~google`,
      // `~moonshotai`, `~deepseek`) — a "-latest" pointer alias for the SAME real
      // organisation, not a second one. Left unstripped, `vendorOf` (which compares
      // strings, not corporate identity, on purpose — see its own doc comment)
      // would count `~z-ai` and `z-ai` as two independent vendors, exactly the
      // miscount the one-vendor-per-tier rule (D-32/D-49) exists to catch.
      vendor: vendorOf(id).replace(/^~/, ""),
      costInput: m.cost?.input,
      costOutput: m.cost?.output,
      contextTokens: m.limit.context,
    });
  }
  return out;
}

/**
 * The I/O half. Empty rather than thrown when the provider is not connected or opencode
 * has no `openrouter` entry at all — the caller (`run.ts`) turns that into a loud
 * refusal with the actual reason, which belongs closer to the operator-facing message
 * than here.
 */
export async function fetchCatalog(cfg: ReviewerConfig = DEFAULT_REVIEWER): Promise<readonly CatalogModel[]> {
  const api = client(cfg);
  const res = await api.provider.list();
  const openrouter = res.data?.all.find((p) => p.id === "openrouter");
  if (openrouter === undefined || !(res.data?.connected ?? []).includes("openrouter")) return [];
  // Cast, not trusted structurally — `openrouter.models`'s OWN generated type (flat
  // `tool_call`) disagrees with the live wire shape (`capabilities.toolcall`) this file's
  // own `RawModel` doc comment explains; `doctor.ts`'s own `client()` caller two lines up
  // already casts `res.data` rather than trusting the generated type, for the same reason.
  return filterCatalog(openrouter.models as unknown as Readonly<Record<string, RawModel>>);
}
