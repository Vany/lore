/**
 * The client hears the CONTRACT; the kitchen stays in the kitchen.
 *
 * Vany, 2026-08-14, generalising the origin rule: *"remove all internal kitchen from
 * MCP."* The reasons lore records are written for the operator — they name opencode,
 * providers, model routes, billing URLs, API error classes — and they were crossing the
 * boundary verbatim in `failed_because` and `checks_skipped`. A client can act on none
 * of that: its whole world is the review — states, findings, tiers as units of evidence,
 * times, and what to do next. Everything else taught agents to reason about machinery,
 * and one real client spent turns explaining kimi's billing page to its user.
 *
 * So the boundary translates. The RAW string stays in the store, the logs and the board
 * — an operator debugging wants the provider's exact words — and the client gets the
 * same fact in contract language. Translation, never summarisation: every rule below
 * maps one mechanism phrase to the consequence it has for the review, and a string no
 * rule matches passes through untouched, because hiding an unknown reason would be
 * worse than leaking its vocabulary (INV-1 prefers an ugly truth to a tidy silence).
 *
 * The rules are ordered and idempotent: applying `forClient` twice is the identity on
 * its own output, which is what lets inbox and poll share it without bookkeeping.
 */

const RULES: readonly { readonly find: RegExp; readonly replace: string }[] = [
  // The runtime's name and its error framing. "opencode returned 403: APIError: ..."
  // carries three layers of kitchen before the provider's sentence starts.
  { find: /opencode returned \d+: APIError: /g, replace: "" },
  { find: /opencode returned (\d+)/g, replace: "lore's model runtime answered $1" },
  { find: /opencode ran past (\d+)s without finishing/g, replace: "the reviewing model did not finish within its $1s limit" },
  { find: /could not reach opencode at \S+/g, replace: "lore's model runtime was unreachable" },
  { find: /\(getaddrinfo [A-Z]+ \S+\)/g, replace: "" },
  { find: /opencode/g, replace: "lore's model runtime" },
  // Billing mechanics. The upsell URL is the provider talking to ITS customer — lore's
  // operator — through somebody else's client.
  { find: / To continue now, purchase extra usage or upgrade your plan: https?:\/\/\S+/g, replace: "" },
  { find: /https?:\/\/\S+/g, replace: "" },
  // Routes and subscriptions. The tier id is the unit of evidence a client knows from
  // the attestation contract; the model and plan behind it are procurement.
  { find: /tier (t\d+) \([^)]*\)/g, replace: "tier $1" },
  { find: /\bwas answered by \S+ rather than \S+/g, replace: "was answered by an equivalent stand-in for its usual model" },
  { find: /the subscription is out of quota, so the same model was asked through a metered provider/g, replace: "its usual capacity was exhausted, so an equivalent answered — its opinion counts in full" },
  { find: /refused on quota:/g, replace: "was out of capacity:" },
];

/** One reason, rendered for the client. See the module doc for what may survive. */
export function forClient(reason: string): string {
  let out = reason;
  for (const r of RULES) out = out.replace(r.find, r.replace);
  // Collapse the seams the removals leave behind, so the sentence still reads.
  return out.replace(/ {2,}/g, " ").replace(/ ([.,;])/g, "$1").trim();
}
