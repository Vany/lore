/**
 * Hand the host's opencode credentials to the deployment's opencode, and say which changed.
 *
 * WHY THROUGH THE API. opencode v2 keeps credentials in its database, not in `auth.json`:
 * it reads `auth.json` exactly once, in the migration that creates the database, and never
 * again (measured 2026-10-03 — a fresh ChatGPT login on the host landed in the host's
 * `credential` table while `auth.json` kept the token that had died two days earlier). So
 * the file the deployment used to bind-mount carries nothing after first boot, and a
 * re-login can only reach a running opencode through `POST /api/credential`.
 *
 * WHAT IT REFUSES, loudly, because each is a silent way to make things worse:
 *   - a FORBIDDEN integration: Claude writes the code under review, so no reviewer may
 *     reach an Anthropic model (D-1). Enforced by absence — the credential never arrives.
 *   - GOING BACKWARDS: opencode renews an OAuth token itself and, with refresh-token
 *     rotation, the copy it replaced may already be dead. A container token that expires
 *     LATER than the host's is the newer one, and overwriting it would kill a working
 *     login while reading as a renewal. That ONE integration is held back unless forced; the
 *     rest of the plan is unaffected, because both sides renew independently and this is
 *     the ordinary state, not an error.
 *
 * The caller decides what "nothing changed" means; this only reports it.
 *
 * SPEC: spec/operations.md §2.4.2
 */

import { isDeepStrictEqual } from "node:util";
import type { OpenCodeClient } from "@opencode/client";

/**
 * Integrations a reviewer must never be able to reach (D-1).
 *
 * The same list `deploy/sync-opencode.sh` strips from the config it stages — two copies in
 * two languages, which this repository knows drift; the shell copy exists only because
 * the staging script cannot import this one. Change both or neither.
 */
export const FORBIDDEN_INTEGRATIONS: ReadonlySet<string> = new Set(["anthropic"]);

/** One credential as opencode's `/api/credential` lists it — the fields this module reads. */
export interface Credential {
  readonly id: string;
  readonly integrationID: string;
  readonly label: string;
  readonly active: boolean;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface Plan {
  /** Host credentials the container does not hold yet, in the form it should hold them. */
  readonly push: readonly Credential[];
  /** Integrations already identical on both sides. */
  readonly unchanged: readonly string[];
  /** OAuth logins the container has renewed past the host's copy — pushing would go backwards. */
  readonly behind: readonly { readonly integrationID: string; readonly host: number; readonly container: number }[];
  /** Host integrations refused by `FORBIDDEN_INTEGRATIONS`. */
  readonly forbidden: readonly string[];
}

const expiresOf = (c: Credential | undefined): number => {
  const v = c?.value;
  return v?.["type"] === "oauth" && typeof v["expires"] === "number" ? v["expires"] : 0;
};

/**
 * What a sync would do, without doing it. Only ACTIVE credentials count on either side:
 * an inactive one is history, and opencode answers with the active one.
 */
export function plan(host: readonly Credential[], container: readonly Credential[], force = false): Plan {
  const push: Credential[] = [];
  const unchanged: string[] = [];
  const behind: { integrationID: string; host: number; container: number }[] = [];
  const forbidden: string[] = [];
  for (const h of host.filter((c) => c.active)) {
    if (FORBIDDEN_INTEGRATIONS.has(h.integrationID)) {
      forbidden.push(h.integrationID);
      continue;
    }
    const there = container.find((c) => c.active && c.integrationID === h.integrationID);
    if (there !== undefined && isDeepStrictEqual(there.value, h.value)) {
      unchanged.push(h.integrationID);
      continue;
    }
    if (!force && expiresOf(there) > expiresOf(h) && expiresOf(h) > 0) {
      behind.push({ integrationID: h.integrationID, host: expiresOf(h), container: expiresOf(there) });
      continue;
    }
    push.push(h);
  }
  return { push, unchanged, behind, forbidden };
}

/**
 * Carry out the push half of a plan: create each credential (opencode makes the newest one
 * active), then remove the container's older ones for that integration so exactly one
 * remains. Returns the integrations that changed.
 *
 * REMOVAL COMES ONLY AFTER A SUCCESSFUL CREATE, so a failure part-way leaves the old login
 * in place and active rather than none at all.
 *
 * `applied` RUNS PER INTEGRATION, the moment it is in place — not once at the end. The
 * caller unparks there, and a batch that unparked only after its last create left every
 * earlier success parked when a later one failed; the retry then saw those as unchanged
 * and never unparked them at all, so a repaired provider stayed skipped.
 */
export async function apply(
  client: OpenCodeClient,
  p: Plan,
  container: readonly Credential[],
  applied: (integrationID: string) => void = () => undefined,
): Promise<readonly string[]> {
  const changed: string[] = [];
  for (const c of p.push) {
    const created = await client.credential.create({
      integrationID: c.integrationID,
      label: `${c.label} (synced by lore)`,
      // why: the host's value is passed through exactly as opencode listed it; its shape is
      // opencode's to validate, and re-typing it here would be a second definition of it.
      value: c.value as never,
      // Explicit, though measured on 2.0.20 the newest credential becomes active anyway —
      // a sync that left the old login answering would report a change nobody gets.
      activate: true,
    });
    for (const old of container.filter((o) => o.integrationID === c.integrationID && o.id !== created.id)) {
      await client.credential.remove({ credentialID: old.id });
    }
    changed.push(c.integrationID);
    applied(c.integrationID);
  }
  return changed;
}

/** `GET /api/credential`'s body, or its `data`, as the host printed it. Throws on anything else. */
export function parseHostCredentials(raw: string): readonly Credential[] {
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed) ? parsed : (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) {
    throw new Error("expected opencode's credential list (`opencode api GET /api/credential`) on stdin");
  }
  for (const c of list as Partial<Credential>[]) {
    if (typeof c.integrationID !== "string" || typeof c.value !== "object" || c.value === null) {
      throw new Error(`a credential on stdin has no integrationID or value: ${JSON.stringify(Object.keys(c))}`);
    }
  }
  return list as Credential[];
}
