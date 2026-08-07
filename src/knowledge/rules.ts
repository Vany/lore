/**
 * Development rules from the operator's side: add one, list them, withdraw one.
 *
 * A project's development rules are appealable (D-83) — a client answers a finding with
 * `lore-ok[<fp>]: rule <id> — <why>`, and the reviewing tier rules on it. The rules
 * themselves are ordinary knowledge rows of kind `policy`; what this file adds is the
 * *operator's* door to them, because the client's door (`knowledge_teach` /
 * `knowledge_retire`) needs a token and a running service, and the person who decides
 * what a team enforces is often sitting at the deployment host with neither.
 *
 * Deliberately thin. Every rule here is one SQL-free call into the store plus the words
 * a human needs to act on the answer; the interesting decisions live in `review.ts`
 * (what an accepted appeal settles) and `store.ts` (what keeps a suppression alive).
 *
 * SPEC: SPEC.md D-83, spec/knowledge.md §2.3
 */

import type { KnowledgeItem, Store } from "../store/store.ts";

/** How many characters of a rule id an appeal cites. Matches `cite_as` in the MCP reply. */
export const CITE_LENGTH = 8;

export function addRule(
  store: Store,
  repoId: string,
  r: { readonly statement: string; readonly why: string; readonly path?: string; readonly by: string },
): KnowledgeItem {
  return store.addKnowledge({
    repoId,
    kind: "policy",
    source: "taught",
    statement: r.statement,
    why: r.why,
    path: r.path,
    cwe: undefined,
    // Who decided, kept for the same reason `knowledge_teach` keeps it: a rule that
    // switches a check off must name somebody who can be asked about it.
    provenance: `taught by ${r.by}`,
    sourceBlob: undefined,
    confidence: 1,
  });
}

/**
 * The rules, and what each one is currently silencing.
 *
 * The two are shown together because separately they mislead in opposite directions: a
 * rule list alone reads as harmless prose, and a suppression list alone reads as a set
 * of unexplained holes. Joined, the page answers the only question worth asking of it —
 * what is this project not checking, and who said so.
 */
export function ruleReport(store: Store, repoId: string): {
  readonly rules: readonly { readonly cite: string; readonly item: KnowledgeItem; readonly silencing: readonly string[] }[];
} {
  const live = store.liveSuppressions(repoId);
  return {
    rules: store.policies(repoId).map((item) => {
      const cite = item.id.slice(0, CITE_LENGTH);
      return {
        cite,
        item,
        silencing: live.filter((s) => cite.startsWith(s.policyShort)).map((s) => `${s.ruleClass} in ${s.path}`),
      };
    }),
  };
}

export function renderRules(r: ReturnType<typeof ruleReport>): string {
  if (r.rules.length === 0) {
    return "no development rules. Add one with `lore rule --add \"<statement>\" --why \"<reason>\"`.";
  }
  const lines: string[] = [`${r.rules.length} development rule(s) — a finding may be appealed to any of these:`, ""];
  for (const { cite, item, silencing } of r.rules) {
    lines.push(`  ${cite}  ${item.statement}`);
    if (item.why !== undefined) lines.push(`            why: ${item.why}`);
    if (item.path !== undefined) lines.push(`            scope: ${item.path}`);
    if (item.provenance !== undefined) lines.push(`            ${item.provenance}`);
    // The consequence, not the rule. This is the line an operator is actually looking
    // for: a rule with nothing under it costs nothing, a rule silencing four engine
    // checks is a decision somebody should still agree with.
    lines.push(
      silencing.length === 0
        ? "            silencing nothing yet — a tier has not accepted an appeal to it"
        : `            SILENCING: ${silencing.join(", ")}`,
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
