import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { extractRules, ingestDocs, rank } from "./ingest.ts";

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

  // Two rules in one paragraph are still two rules.
  it("splits a paragraph into sentences", () => {
    const md = "Reviewer agents are read-only, always. A fake reviewer must not be kinder than production.";
    expect(extractRules(md)).toHaveLength(2);
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
