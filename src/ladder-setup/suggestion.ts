/**
 * What the model is allowed to say, and the two checks its reply must pass beyond
 * per-item parsing: exactly one pick per role, and three distinct vendors (D-32/D-49).
 *
 * SPEC: spec/review-ladder.md
 */

import type { Tier } from "../core/ladder.ts";
import type { ItemParser } from "../reviewer/opencode.ts";
import { vendorOfCandidate } from "./catalog.ts";

export type Role = "t1" | "t2" | "t3";
const ROLES: readonly Role[] = ["t1", "t2", "t3"];

const EFFORTS: readonly NonNullable<Tier["effort"]>[] = ["low", "medium", "high", "max"];
function isEffort(s: unknown): s is NonNullable<Tier["effort"]> {
  return typeof s === "string" && (EFFORTS as readonly string[]).includes(s);
}

export interface TierPick {
  readonly role: Role;
  readonly model: string;
  readonly effort: NonNullable<Tier["effort"]>;
  /** Shown to the operator; never stored in the written config. */
  readonly why: string;
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * A factory, not a bare parser — `ItemParser`'s own signature (`raw, index, total`) has
 * no room for the catalog, so it is closed over here instead. `knownIds` is exactly what
 * `prompt.ts` showed the model, never the wider set `doctor.ts` would accept: a pick
 * outside what was actually offered is a hallucination even if the id happens to be real.
 */
export function makeTierPickParser(knownIds: ReadonlySet<string>): ItemParser<TierPick> {
  return (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { rejected: `not an object: ${JSON.stringify(input)?.slice(0, 120) ?? "undefined"}` };
    }
    const o = input as Record<string, unknown>;

    const role = str(o, "role");
    if (role === undefined || !(ROLES as readonly string[]).includes(role)) {
      return { rejected: `'role' must be one of ${ROLES.join(", ")}, got ${JSON.stringify(o["role"])}` };
    }
    const model = str(o, "model");
    if (model === undefined) return { rejected: `${role}: 'model' is required and was empty` };
    if (!knownIds.has(model)) {
      return { rejected: `${role}: '${model}' was not one of the candidates offered — refusing rather than guessing` };
    }
    const effort = o["effort"];
    if (!isEffort(effort)) return { rejected: `${role}: 'effort' must be one of ${EFFORTS.join(", ")}` };
    const why = str(o, "why") ?? "";

    return { role: role as Role, model, effort, why };
  };
}

/**
 * The cross-item checks a single `ItemParser` cannot make: one pick per role, and three
 * DIFFERENT underlying vendors. A count or a role check alone would accept three t1s or
 * three z-ai models under different route names — the failure this whole feature exists
 * to prevent, just moved one level up from where the old hardcoded ladder made it by hand.
 *
 * Uses `vendorOfCandidate` (`catalog.ts`), not bare `vendorOf` — found missing here by
 * lore's own review, fingerprints 119dcfd0/992002a4: the tilde-prefix fix first landed
 * only in `catalog.ts`'s own display column, so this function — the thing
 * that actually ENFORCES the rule — still called `vendorOf` on the raw picked id and
 * would have accepted `z-ai` and `~z-ai` as two independent vendors, the exact miscount
 * the fix was named for, surviving in the one place it had to not survive. One shared
 * function now, so the table the model reads and the check that enforces the rule
 * cannot independently drift the way this already did once.
 *
 * `vendorOf` itself compares ID STRINGS, not corporate identity, on purpose (its own
 * doc comment in `core/ladder.ts`: "guessing that two ids are one company because they
 * look alike is how a rule that must be exactly right becomes approximately right"), so
 * beyond the one confirmed, systematic `~`-alias case, this codebase's own considered
 * position — an unaliased id stands for itself rather than being heuristically merged —
 * is kept rather than overridden with a guess `vendorOf`'s own author already argued
 * against; `prompt.ts`'s own instructions ask the model to use its broader knowledge of
 * real corporate ownership instead, which a hardcoded string table cannot do as well or
 * as current.
 */
export function validatePicks(picks: readonly TierPick[]): string | undefined {
  if (picks.length !== 3) return `expected exactly 3 picks, got ${String(picks.length)}`;
  const roles = new Set(picks.map((p) => p.role));
  if (roles.size !== 3) return `expected one pick per role (t1, t2, t3), got ${[...roles].sort().join(", ")}`;
  const vendors = new Set(picks.map((p) => vendorOfCandidate(p.model)));
  if (vendors.size !== 3) {
    return `expected three different vendors, got only ${vendors.size} (${picks.map((p) => `${p.role}=${vendorOfCandidate(p.model)}`).join(", ")}) — two tiers from the same organisation are one opinion asked twice (D-32/D-49)`;
  }
  return undefined;
}
