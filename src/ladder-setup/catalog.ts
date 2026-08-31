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
 * `vendorOf`, with the one normalisation this module needs on top of it — the SINGLE
 * place that happens, exported so every caller uses the same answer rather than each
 * recomputing it. Kept as defence in depth after `filterCatalog` (below) stopped
 * offering tilde-prefixed ids at all — `validatePicks` still runs it on whatever a
 * reply names, so a tilde id reaching it by any other path is still caught, not just
 * the one this module controls.
 */
export function vendorOfCandidate(id: string): string {
  return vendorOf(id).replace(/^~/, "");
}

/**
 * The pure half: what a provider's own `models` map reduces to once filtered to what a
 * review session can actually use and WRITE OUT. Tool-call support is not optional for
 * an agentic reviewer, and a deprecated or alpha model is not a bet worth a fresh
 * install making by default. Separated from `fetchCatalog` so this — the part with
 * real branches worth testing — needs no network, no opencode, no `ReviewerConfig` to
 * exercise.
 *
 * `~`-PREFIXED IDS ARE EXCLUDED ENTIRELY, not merely vendor-normalised — widened from
 * an earlier version that only fixed the DISPLAY column and the in-run vendor check
 * (fc9e8468, then 119dcfd0/992002a4 for the check itself) after lore's own review,
 * fingerprint 4f56d47a, found the deeper problem: a tilde id that PASSES those checks
 * can still be WRITTEN into a real `LORE_TIERS` file, and every review-time consumer of
 * vendor identity — `core/ladder.ts`'s `vendorSpread` (the actual `passed`/
 * `passed_partial` decision and signed attestation), `reviewer/review.ts`'s fallback
 * prose, `doctor.ts`'s own check — calls bare `vendorOf` with no tilde awareness at
 * all, a blind spot that was harmless before this feature because nothing had reason to
 * hand-write a `~`-prefixed "-latest" pointer id into a ladder file. Excluding the shape
 * at the source closes that for good, rather than teaching three more call sites (most
 * outside this module's own scope) about a normalisation only this feature needed.
 * OpenRouter's own catalog carries this namespace for at least seven vendors — z-ai,
 * anthropic, openai, x-ai, google, moonshotai, deepseek — none of it lost: the real,
 * pinnable id (`z-ai/glm-5.2`, not `~z-ai/glm-5.2-latest`) is offered either way.
 */
export function filterCatalog(models: Readonly<Record<string, RawModel>>): readonly CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const [modelId, m] of Object.entries(models)) {
    if (modelId.startsWith("~")) continue;
    if (!m.capabilities.toolcall) continue;
    if (m.status !== undefined && EXCLUDED_STATUS.has(m.status)) continue;
    const id = `openrouter/${modelId}`;
    out.push({
      id,
      vendor: vendorOfCandidate(id),
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
