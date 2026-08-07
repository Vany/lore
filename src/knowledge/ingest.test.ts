import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { EXTRACTOR_VERSION, extractRules, ingestDocs, rank } from "./ingest.ts";

describe("extractRules", () => {
  it("takes bulleted rules", () => {
    const rules = extractRules(`
# Rules

- Fail loud, exit non-zero. No path may log a problem and carry on.
- Amounts must be integers in minor units, never JS numbers.
`);
    expect(rules.map((r) => r.statement)).toContain("Amounts must be integers in minor units, never JS numbers");
  });

  it("separates the rule from its reason", () => {
    const [rule] = extractRules(
      "- Reviewers must never write to the repo, because an author that can edit can close its own findings.",
    );
    expect(rule?.statement).toBe("Reviewers must never write to the repo");
    expect(rule?.why).toBe("an author that can edit can close its own findings");
  });

  // A rule inside a code block is an EXAMPLE of a rule, not one. Ingesting it
  // would put sample text into every future prompt as though the team meant it.
  it("ignores fenced code", () => {
    const rules = extractRules(["```", "// you must never do this", "```", ""].join("\n"));
    expect(rules).toStrictEqual([]);
  });

  it("ignores headings, quotes and prose with no instruction in it", () => {
    expect(extractRules("# You must read this heading")).toStrictEqual([]);
    expect(extractRules("> quoted: you must not trust this")).toStrictEqual([]);
    expect(extractRules("The service listens on port 7777 and writes to a database.")).toStrictEqual([]);
  });

  // EVERY ROW IS SHOWN ALONE, under "treat these as this team's decisions", with
  // nothing around it. So a statement whose subject lived in the sentence before is
  // not a rule the model can use — it is free to bind "it" to whatever it is reading.
  // All of these were live in the store.
  it("refuses a statement whose subject is somewhere else", () => {
    for (const fragment of [
      "- It has to be, because the secret is shown once and never stored",
      "- This retires the refusal in D-55, which must never be reinstated",
      "- Therefore a required field must be treated as free money for in-flight decisions",
      "- They must never be trusted after the blob changes",
    ]) {
      expect(extractRules(fragment)).toStrictEqual([]);
    }
  });

  // A clause lifted out of a sentence whose beginning is gone.
  it("refuses a statement that starts mid-sentence", () => {
    expect(extractRules("- matching the line refused the corrected file, which must never happen")).toStrictEqual([]);
  });

  // AND ASKS IT OF THE TEXT AS WRITTEN. The guard ran on the markup-stripped text, so a
  // rule opening on a code span became a lowercase word and was refused as a lifted
  // clause — this exact line from `spec/operations.md` was ingested under the old reader
  // and silently vanished under the new one. Backticks are an author saying a statement
  // begins here; the only fixture for this guard was a gerund fragment, so nothing said.
  it("keeps a rule that opens on a code span", () => {
    const [rule] = extractRules('- `fast_clean`, `failed` and `expired` are distinct states, never blended into "not passed"');
    expect(rule?.statement).toBe('fast_clean, failed and expired are distinct states, never blended into "not passed"');
  });

  // Emphasis is not that signal, and stripping it must not open the same hole.
  it("still refuses a lifted clause wearing italics", () => {
    expect(extractRules("- *matching* the line refused the corrected file, which must never happen")).toStrictEqual([]);
  });

  it("ignores navigational prose that only looks like a rule", () => {
    expect(extractRules("- See SPEC.md, which you must read before working here.")).toStrictEqual([]);
  });

  it("strips markdown so the same rule written two ways is one rule", () => {
    const [rule] = extractRules("- **Never** use `toEqual` when asserting absence of a property.");
    expect(rule?.statement).toBe("Never use toEqual when asserting absence of a property");
  });

  it("does not emit the same statement twice from one document", () => {
    const rules = extractRules("- Must not log and continue.\n- Must not log and continue.\n");
    expect(rules).toHaveLength(1);
  });
});

describe("rank", () => {
  let store: Store;
  let repoId: string;

  beforeEach(() => {
    store = new Store(":memory:");
    repoId = store.upsertRepo("r", "git@x:r.git").id;
  });

  const add = (source: "taught" | "ingested" | "derived", statement: string) =>
    store.addKnowledge({
      repoId, kind: "rule", source, statement, why: undefined, path: undefined,
      cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: 0.5,
    });

  it("puts taught rules above ingested, and ingested above derived", () => {
    add("derived", "derived rule");
    add("taught", "taught rule");
    add("ingested", "ingested rule");
    expect(rank(store.knowledgeFor(repoId)).map((k) => k.source)).toStrictEqual([
      "taught",
      "ingested",
      "derived",
    ]);
  });
});

// The knowledge base IS the product, and it was 78% fragments — 727 rows of 938.
//
// The extractor read PHYSICAL lines, and these documents are hard-wrapped at eighty
// characters, so most rules were cut at the wrap. What reached the store, and what
// every client was served, looked like "change — I do not let code and spec drift
// apart quietly": true, unattributable, and beginning mid-sentence because the
// clause before it lived on the previous line.
describe("wrapped markdown is one rule, not several", () => {
  it("joins a rule split across lines", () => {
    const md = [
      "- SPEC is ground truth. If reality disagrees with SPEC, I update SPEC in the",
      "  same change — I do not let code and spec drift apart quietly.",
    ].join("\n");

    const rules = extractRules(md);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.statement).toContain("I update SPEC in the same change");
    // The tail must not have become a rule of its own.
    expect(rules.some((r) => /^change —/.test(r.statement))).toBe(false);
  });

  // A table row matches a modal as readily as prose — and arrives as pipes and
  // alignment rather than as something anyone can act on.
  it("ignores table rows", () => {
    const md = [
      "| # | decision | status |",
      "|---|---|---|",
      "| **D-2** | `lore` never commits or pushes; the client owns its history | confirmed |",
    ].join("\n");
    expect(extractRules(md)).toStrictEqual([]);
  });

  // Two rules in one bullet are still two rules.
  it("splits a bullet into sentences", () => {
    const md = "- Reviewer agents are read-only, always. A fake reviewer must not be kinder than production.";
    expect(extractRules(md)).toHaveLength(2);
  });

  // THE SHAPE DECIDES. A paragraph carrying a modal is almost always the STORY of a
  // decision rather than the decision — measured on this repository, SPEC.md produced
  // 111 rules and 108 of them came from paragraphs of incident narrative, arriving as
  // fragments with their subjects in sentences that were never captured. That same
  // document now yields 8.
  it("does not mine a narrative paragraph for rules", () => {
    const md =
      "The audit half of that design could never have fired. A reviewer ran it against a dead port and " +
      "nothing printed, so the cap was never tripped and we always assumed it worked.";
    expect(extractRules(md)).toStrictEqual([]);
  });

  // A document that states its rules one to a line — which plenty do, and which the
  // fixtures below are — still works. The discriminator is that a rule is ONE
  // statement; a narrative paragraph sets something up, says what happened, and draws a
  // conclusion, and it is the middle sentences that arrive with their subjects missing.
  it("takes a rule written as a one-sentence paragraph", () => {
    expect(extractRules("Money values must use Money<Currency>, never number.")).toHaveLength(1);
  });

  it("still takes the same sentence when someone writes it as a bullet", () => {
    expect(extractRules("- A reviewer must never write to the repository under review.")).toHaveLength(1);
  });

  // A bullet ends at the next bullet, not at the end of the list.
  it("keeps separate bullets separate", () => {
    const md = ["- Comments must carry why.", "- Tests must not be kinder than production."].join("\n");
    const rules = extractRules(md);
    expect(rules).toHaveLength(2);
    expect(rules[0]?.statement).not.toContain("kinder");
  });
});

// The spec promised ADRs and the code never read one.
//
// `spec/knowledge.md` §2 says rules come from "CLAUDE.md, PROG.md, SPEC.md, ADRs".
// `discoverable()` returned the root files alone, so `docs/adr/` was never opened —
// while `RULE_DIRS` sat beside it looking used, because a second function consumed it
// to SCOPE a rule found under one of those directories. That branch was unreachable.
//
// It cost the product: rigid-monorepo carries 37 ADRs and had EIGHT rules, none of
// them from a decision record — the reasoning a reviewer most needs and can least
// infer from code.
// A RULE MUST NOT OUTLIVE THE READER THAT PRODUCED IT, any more than it may outlive
// the text (D-20). `source_blob` enforced the second and nothing enforced the first, so
// when the extractor was narrowed, 399 decontextualised fragments stayed live — because
// re-ingestion triggers on the source document changing and the source had not changed.
//
// The stamp closes it, and it heals the store on its own: `ingestDocs` runs on every
// review, so the first review after a bump retires what the old reader wrote.
describe("improving the reader retires what the old one wrote", () => {
  it("retires rules carrying an older stamp, even when the document is unchanged", async () => {
    const store = new Store(":memory:");
    const repoId = store.upsertRepo("r", "git@example.com:o/r.git").id;

    // A row as an older extractor would have left it: same blob, no stamp.
    store.addKnowledge({
      repoId, kind: "rule", source: "ingested",
      statement: "It has to be, because the secret is shown once", why: undefined,
      path: undefined, cwe: undefined, provenance: "PROG.md", sourceBlob: "same-blob",
      confidence: 0.8,
    });
    expect(store.knowledgeFor(repoId)).toHaveLength(1);

    // `IS NOT` is null-safe in SQLite, which is what makes an unstamped row match.
    const retired = store.retireForChangedBlob(repoId, "PROG.md", "same-blob", EXTRACTOR_VERSION);
    expect(retired).toBe(1);
    expect(store.knowledgeFor(repoId)).toHaveLength(0);
    store.close();
  });

  it("leaves a rule alone when both the document and the reader are unchanged", () => {
    const store = new Store(":memory:");
    const repoId = store.upsertRepo("r", "git@example.com:o/r.git").id;
    store.addKnowledge({
      repoId, kind: "rule", source: "ingested",
      statement: "Reviewers must never write to the repository", why: undefined,
      path: undefined, cwe: undefined, provenance: "PROG.md", sourceBlob: "same-blob",
      extractor: EXTRACTOR_VERSION, confidence: 0.8,
    });
    expect(store.retireForChangedBlob(repoId, "PROG.md", "same-blob", EXTRACTOR_VERSION)).toBe(0);
    expect(store.knowledgeFor(repoId)).toHaveLength(1);
    store.close();
  });
});

describe("the documents that get read", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-ingest-"));
    writeFileSync(join(dir, "CLAUDE.md"), "Money values must use Money<Currency>, never number.\n");
    mkdirSync(join(dir, "docs/adr"), { recursive: true });
    writeFileSync(join(dir, "docs/adr/0026-holds.md"), "Holds must be idempotent on the network transaction id.\n");
    // Filed into a subdirectory, which is what happens once there are enough of them.
    mkdirSync(join(dir, "docs/adr/superseded"), { recursive: true });
    writeFileSync(join(dir, "docs/adr/superseded/0004-old.md"), "Retries must never exceed three attempts.\n");
    mkdirSync(join(dir, "spec"), { recursive: true });
    writeFileSync(join(dir, "spec/ledger.md"), "The ledger must never allow a negative balance.\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads decision records and specs, not only the root files", async () => {
    const store = new Store(":memory:");
    const repoId = store.upsertRepo("r", "git@example.com:o/r.git").id;

    await ingestDocs(store, repoId, dir);
    const statements = store.knowledgeFor(repoId).map((k) => k.statement).join(" | ");

    expect(statements).toContain("Money<Currency>");        // the root file, as before
    expect(statements).toContain("network transaction id"); // docs/adr — never read until now
    expect(statements).toContain("three attempts");         // a nested ADR
    expect(statements).toContain("negative balance");       // spec/
    store.close();
  });

  // A rule from a directory is about that area; one from a root CLAUDE.md is about
  // everything. That distinction had no reachable input before.
  it("scopes a directory's rules to the directory", async () => {
    const store = new Store(":memory:");
    const repoId = store.upsertRepo("r", "git@example.com:o/r.git").id;

    await ingestDocs(store, repoId, dir);
    const adr = store.knowledgeFor(repoId).find((k) => k.statement.includes("network transaction id"));
    const root = store.knowledgeFor(repoId).find((k) => k.statement.includes("Money<Currency>"));

    expect(adr?.path).toBe("docs/adr");
    expect(root?.path).toBeUndefined();
    store.close();
  });
});
