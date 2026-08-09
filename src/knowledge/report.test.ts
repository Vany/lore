/**
 * The operator view of the memory.
 *
 * The two things it must not do are report a number that disagrees with the number
 * beside it, and hide a refusal — because the whole justification for letting a model
 * throw rules away (D-81) is that every refusal is recorded and readable.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { knowledgeReport, renderKnowledge } from "./report.ts";

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
});

const kept = (provenance: string, statement: string, extractor = "3.1") =>
  store.addKnowledge({
    repoId, kind: "rule", source: "ingested", statement, why: undefined, path: undefined,
    cwe: undefined, provenance, sourceBlob: "b", extractor, confidence: 0.8,
  });

const refused = (provenance: string, statement: string, because: string) =>
  store.recordScreenedOut(
    {
      repoId, kind: "rule", source: "ingested", statement, why: undefined, path: undefined,
      cwe: undefined, provenance, sourceBlob: "b", extractor: "3.1", confidence: 0.8,
    },
    because,
  );

describe("knowledgeReport", () => {
  it("counts kept against refused, per document", () => {
    kept("PROG.md", "Fakes must not be kinder than production");
    kept("PROG.md", "Assert the consequence, never the setup");
    kept("SPEC.md", "D-71 — lore reads a test suite and never runs it");
    refused("SPEC.md", "The distinction is load-bearing", "no antecedent");

    const r = knowledgeReport(store, "demo", repoId);
    expect(r.byDocument).toStrictEqual([
      { provenance: "SPEC.md", kept: 1, refused: 1 },
      { provenance: "PROG.md", kept: 2, refused: 0 },
    ]);
  });

  // THE TWO NUMBERS MUST AGREE. A refusal is re-recorded whenever its document changes
  // and the model words the reason freshly each time, so counting distinct triples read
  // 40 refusals beside a tally of 15 — a report contradicting itself two lines apart,
  // which is worse than no report. Caught by reading its own first output.
  it("counts a statement refused several times once, in both places", () => {
    kept("SPEC.md", "Handles are CSPRNG-generated, never sequential");
    refused("SPEC.md", "The distinction is load-bearing", "no antecedent");
    refused("SPEC.md", "The distinction is load-bearing", "'The distinction' points at nothing");
    refused("SPEC.md", "The distinction is load-bearing", "a dangling definite reference");

    const r = knowledgeReport(store, "demo", repoId);
    expect(r.byDocument).toStrictEqual([{ provenance: "SPEC.md", kept: 1, refused: 1 }]);
    expect(r.refusals).toHaveLength(1);
    // And the rendered text agrees with the table above it.
    const out = renderKnowledge(r);
    expect(out).toContain("1 refusal(s) recorded");
  });

  it("hands back what was refused with the reason given, on request", () => {
    refused("SPEC.md", "Cost. A conversation re-sends its context", "a topic label with no list");
    const out = renderKnowledge(knowledgeReport(store, "demo", repoId), { refusals: true });
    expect(out).toContain("Cost. A conversation re-sends its context");
    expect(out).toContain("a topic label with no list");
  });

  /**
   * Since D-89 this is a QUEUE, not a degradation: extraction keeps every candidate live
   * and the background pass judges them within the hour. It is still printed, because a
   * queue that has stopped draining looks exactly like one that is draining — the count
   * failing to fall across days is the signal, and only a person can see that.
   */
  it("says how many documents are waiting for the screen", () => {
    kept("PROG.md", "Fakes must not be kinder than production", "3.1-unscreened");
    const r = knowledgeReport(store, "demo", repoId);
    expect(r.unscreened).toBe(1);
    const out = renderKnowledge(r);
    expect(out).toContain("waiting for the screen");
    // The rules are LIVE meanwhile, and saying so is the difference between a queue and
    // a hole: a reader told only "unscreened" reasonably assumes they are being withheld.
    expect(out).toContain("live and in use");
  });

  it("says nothing about the screen queue when every document has been judged", () => {
    kept("PROG.md", "Fakes must not be kinder than production");
    expect(renderKnowledge(knowledgeReport(store, "demo", repoId))).not.toContain("waiting for the screen");
  });

  it("groups live rules by where they came from", () => {
    kept("PROG.md", "an ingested rule");
    store.addKnowledge({
      repoId, kind: "rule", source: "taught", statement: "a taught rule", why: undefined,
      path: undefined, cwe: undefined, provenance: undefined, sourceBlob: undefined, confidence: 1,
    });
    const r = knowledgeReport(store, "demo", repoId);
    expect(r.bySource).toStrictEqual([
      { source: "ingested", n: 1 },
      { source: "taught", n: 1 },
    ]);
    expect(renderKnowledge(r)).toContain("2 live rules");
  });
});
