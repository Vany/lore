import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { extractRules, rank } from "./ingest.ts";

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
