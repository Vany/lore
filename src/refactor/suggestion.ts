/**
 * What a refactor suggestion is.
 *
 * Deliberately NOT the finding schema (same reasoning as `propose/proposal.ts`'s own
 * header, one door down): nothing here gates a merge, nothing gets attested, and there
 * is no claim/evidence/failureScenario to defend — a suggestion is an opinion about what
 * would be better to own, not an assertion that something is broken (D-136).
 *
 * Nothing is dropped for being badly formed. A suggestion missing an optional field is
 * kept as-is; only a suggestion that fails to parse AT ALL is refused, and refused loudly
 * (`ItemParser`'s `{ rejected }` arm) rather than silently — the same D-66 reasoning
 * applied here as everywhere else a model's reply is turned into structured rows.
 *
 * SPEC: spec/refactor.md
 */

export type RoughSize = "small" | "medium" | "large";

const ROUGH_SIZES: readonly RoughSize[] = ["small", "medium", "large"];

function isRoughSize(s: unknown): s is RoughSize {
  return typeof s === "string" && (ROUGH_SIZES as readonly string[]).includes(s);
}

export interface RefactorSuggestion {
  /** One line, plain enough to sort a list by. */
  readonly title: string;
  /** Files or subdirectories this lands in — folder-scoped, never a line number. */
  readonly area: readonly string[];
  /** Why this is worth doing, in the model's own words. */
  readonly rationale: string;
  readonly roughSize?: RoughSize;
}

/** Anything not a non-empty string is absent; say which field failed, never "malformed". */
function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Parse one suggestion, or say precisely what was wrong with it — mirrors
 * `propose/proposal.ts`'s `parseProposal`: "malformed" without saying which field is a
 * debugging session sent in the wrong direction once already in this codebase.
 */
export function parseSuggestion(input: unknown): RefactorSuggestion | { readonly rejected: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { rejected: `not an object: ${JSON.stringify(input)?.slice(0, 120) ?? "undefined"}` };
  }
  const o = input as Record<string, unknown>;

  const title = str(o, "title");
  if (title === undefined) return { rejected: "'title' is required and was empty" };
  const rationale = str(o, "rationale");
  if (rationale === undefined) return { rejected: `${title}: 'rationale' is required and was empty` };

  const area = Array.isArray(o["area"])
    ? o["area"].filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim())
    : [];
  if (area.length === 0) return { rejected: `${title}: 'area' is required and must name at least one file or directory` };

  const roughSize = o["roughSize"];
  return {
    title,
    area,
    rationale,
    ...(isRoughSize(roughSize) ? { roughSize } : {}),
  };
}
