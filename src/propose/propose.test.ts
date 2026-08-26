/**
 * The pure half of `lore propose`: what a proposal is, and what demotes one.
 *
 * The screen's failure modes are asymmetric and the tests are weighted accordingly. A
 * FALSE match hides a new idea behind an old decision, and the reader never learns what
 * they were not shown — that is the expensive one. A MISSED match costs them a paragraph
 * they recognise. So `restates` is biased toward not matching, and the tests pin that
 * bias rather than just its successes.
 *
 * SPEC: spec/propose.md §4, §5
 */

import { describe, expect, it } from "vitest";
import type { KnowledgeItem } from "../store/store.ts";
import { inScope, parseProposal, type Proposal } from "./proposal.ts";
import { restates, screen } from "./screen.ts";

const PROPOSAL = {
  lens: "seams",
  idea: "Split the store's query surface from its migration surface so a caller cannot reach both.",
  touches: ["src/store/store.ts", "src/store/schema.ts"],
  trueIf: "callers actually use one or the other, never both",
  costIfWrong: "a week, and every call site touched twice",
  contradictedBy: "PROG.md says one file, one piece of functionality",
  settledBy: "grep the call sites: if fewer than three use both surfaces, this is worth doing",
  preserves: "every existing test passes unedited and the exported names are unchanged",
};

const proposal = (over: Partial<Proposal> = {}): Proposal => ({ ...(parseProposal(PROPOSAL) as Proposal), ...over });

/** The same proposal with one optional field genuinely absent, not set to undefined. */
const lacking = (key: "settledBy" | "preserves"): Proposal => {
  const { [key]: _dropped, ...rest } = PROPOSAL;
  return parseProposal(rest) as Proposal;
};

const known = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: "k1",
  repoId: "r",
  kind: "rule",
  source: "taught",
  statement: "s",
  why: undefined,
  path: undefined,
  cwe: undefined,
  provenance: undefined,
  sourceBlob: undefined,
  confidence: undefined,
  verifiedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("parseProposal", () => {
  it("accepts a complete proposal", () => {
    expect(parseProposal(PROPOSAL)).toMatchObject({ lens: "seams", touches: PROPOSAL.touches });
  });

  // "Malformed JSON" was once said about perfectly valid JSON the schema declined, and
  // it sent an hour of debugging in the wrong direction. Each rejection names its field.
  it("names the field that failed, never just 'malformed'", () => {
    const r = parseProposal({ ...PROPOSAL, trueIf: "  " });
    expect(r).toHaveProperty("rejected");
    expect((r as { rejected: string }).rejected).toContain("trueIf");
  });

  it("rejects a lens it was not sent from", () => {
    const r = parseProposal({ ...PROPOSAL, lens: "vibes" });
    expect((r as { rejected: string }).rejected).toContain("lens must be one of");
  });

  // Missing is KEPT, not rejected: this is a generator, and dropping its output for
  // being weakly stated is the failure D-66 settled for findings.
  it("keeps a proposal that offers no measurement, without its settledBy", () => {
    const { settledBy: _drop, ...without } = PROPOSAL;
    const r = parseProposal(without) as Proposal;
    expect(r.settledBy).toBeUndefined();
    expect(r.idea).toBe(PROPOSAL.idea);
  });

  it("keeps a proposal that says nothing about what it preserves", () => {
    const { preserves: _drop, ...without } = PROPOSAL;
    expect((parseProposal(without) as Proposal).preserves).toBeUndefined();
  });

  // Fingerprint b551376e: `rejects` is the critic's structured verdict, read as a fact
  // rather than left absent for a caller to infer from `idea`'s prose.
  it("reads the critic's rejects verdict when set", () => {
    expect((parseProposal({ ...PROPOSAL, rejects: true }) as Proposal).rejects).toBe(true);
  });

  it("leaves rejects genuinely absent, not false, when nothing said either way", () => {
    expect((parseProposal(PROPOSAL) as Proposal).rejects).toBeUndefined();
  });
});

describe("inScope", () => {
  it("is satisfied by one file inside the folder", () => {
    // A proposal that moves a seam necessarily touches both sides; requiring every path
    // to be inside would reject exactly the structural ideas this tool exists to get.
    expect(inScope("src/store", ["src/mcp/server.ts", "src/store/store.ts"])).toBe(true);
  });

  it("rejects a change that lands entirely elsewhere", () => {
    expect(inScope("src/store", ["src/mcp/server.ts"])).toBe(false);
  });

  it("does not match a folder that merely shares a prefix", () => {
    expect(inScope("src/store", ["src/storefront/a.ts"])).toBe(false);
  });

  it("treats the repository root as everything", () => {
    for (const root of ["", ".", "/", "./"]) expect(inScope(root, ["anywhere/at/all.ts"])).toBe(true);
  });

  it("ignores a leading ./ or / on either side", () => {
    expect(inScope("./src/store/", ["/src/store/a.ts"])).toBe(true);
  });
});

describe("restates", () => {
  it("matches an idea against the decision it repeats", () => {
    expect(
      restates(
        "We should split store.ts into separate query and migration modules.",
        "Splitting store.ts into query and migration modules was considered and rejected.",
      ),
    ).toBe(true);
  });

  // The expensive failure. A screen that matches loosely hides new ideas behind old
  // decisions and the reader never learns what they did not see.
  it("does not match two unrelated statements that share common words", () => {
    expect(
      restates(
        "Move the review ladder's bounds into the tier configuration.",
        "Splitting store.ts into query and migration modules was considered and rejected.",
      ),
    ).toBe(false);
  });

  // MEASURED ON THE FIRST REAL SWEEP. The ingested rule "The prompts do not ask for
  // that, and the output shows it" reduces to four terms, three of which turned up in
  // an unrelated 200-word paragraph about a budget guard — so a genuinely new idea was
  // reported to the reader as already decided. That is the expensive direction of this
  // filter: the reader never learns what they were not shown.
  it("does not match a short statement on three common words in a long idea", () => {
    expect(
      restates(
        "The budget guard in propose() is a guard whose silence is ambiguous. sessionsSpent is incremented " +
          "only after a successful ask, so when every call fails the budget check never fires and the loop " +
          "attempts every lens, each one creating a session and consuming tokens without the ceiling " +
          "taking effect. Ask for the output it shows.",
        "The prompts do not ask for that, and the output shows it",
      ),
    ).toBe(false);
  });

  it("refuses to match on a statement too short to mean anything", () => {
    expect(restates("anything at all about the store", "no globals")).toBe(false);
  });
});

describe("screen", () => {
  it("lets a complete, in-scope, novel proposal through undemoted", () => {
    const [s] = screen([proposal()], "src/store", []);
    expect(s?.demotions).toStrictEqual([]);
  });

  it("drops a proposal about somewhere else, and says where it landed", () => {
    const [s] = screen([proposal({ touches: ["src/mcp/server.ts"] })], "src/store", []);
    expect(s?.demotions).toContain("out-of-scope");
    expect(s?.because.join(" ")).toContain("src/mcp/server.ts");
  });

  // A proposal that names no files cannot be placed, which is the same problem as
  // landing elsewhere — and saying so is more useful than silently keeping it.
  it("treats a proposal that names no files as unplaceable", () => {
    const [s] = screen([proposal({ touches: [] })], "src/store", []);
    expect(s?.demotions).toContain("out-of-scope");
    expect(s?.because.join(" ")).toContain("named no files");
  });

  // MEASURED ON THE FIRST REAL SWEEP: four proposals named src/knowledge/compiler.ts,
  // src/ops/health.ts, src/mcp/submit.ts and its test — none of which exist. Nothing
  // checked, so an invented sibling rode in on a real path and the reader had no way to
  // tell which was which.
  it("says which named files are not in the tree, and keeps the idea", () => {
    const real = (p: string) => p !== "src/store/schema.ts";
    const [s] = screen([proposal()], "src/store", [], real);
    expect(s?.demotions).toContain("invented-paths");
    expect(s?.because.join(" ")).toContain("src/store/schema.ts");
    // Kept, not dropped: the idea may be sound and one path invented.
    expect(s?.demotions).not.toContain("out-of-scope");
  });

  it("drops a proposal whose every named file is imaginary", () => {
    const [s] = screen([proposal()], "src/store", [], () => false);
    expect(s?.demotions).toContain("out-of-scope");
    expect(s?.because.join(" ")).toContain("names only files that do not exist");
  });

  it("takes paths on trust when nothing can check them", () => {
    const [s] = screen([proposal()], "src/store", []);
    expect(s?.demotions).toStrictEqual([]);
  });

  it("marks a proposal unappraisable and says which half is missing", () => {
    const [s] = screen([lacking("settledBy")], "src/store", []);
    expect(s?.demotions).toStrictEqual(["unappraisable"]);
    expect(s?.because.join(" ")).toContain("no measurement");
    expect(s?.because.join(" ")).not.toContain("keeps working");
  });

  it("counts a missing preserves as unappraisable too — functionality is the constraint", () => {
    const [s] = screen([lacking("preserves")], "src/store", []);
    expect(s?.demotions).toStrictEqual(["unappraisable"]);
    expect(s?.because.join(" ")).toContain("keeps working");
  });

  // ALMOST EVERY RULE IN A CODEBASE IS A PROHIBITION — "reviewers do not write to the
  // repo" — so matching on "do not" classified the whole knowledge base as decisions
  // this project had made AGAINST things, and any idea sharing words with one was
  // reported as already rejected. Measured on the first real sweep.
  it("does not treat an ordinary prohibition as a decision against something", () => {
    const k = known({
      kind: "rule",
      source: "ingested",
      statement: "Reviewers do not write to the repository, because independence is the whole point of them.",
    });
    const [s] = screen([proposal({ idea: "Reviewers do not write to the repository, independence is the point." })], "src/store", [k]);
    expect(s?.demotions).not.toContain("already-decided");
  });

  it("annotates an idea this repository already rejected, with the date", () => {
    const k = known({
      kind: "mistake",
      statement: "Splitting the store's query surface from its migration surface was considered and rejected.",
      verifiedAt: "2026-07-04T00:00:00.000Z",
    });
    const [s] = screen([proposal()], "src/store", [k]);
    expect(s?.demotions).toContain("already-decided");
    expect(s?.because.join(" ")).toContain("2026-07-04");
  });

  // Fingerprint dda7d5b7, found by lore's own review: `run.ts`'s own knowledgeBlock
  // (lore-ok 77edbad4) already tells the PROPOSER that a `kind: "fact"` row is an
  // unverified, single-branch reading, not a confirmed decision — "an unverified
  // planted claim can suppress or bias exactly the ideas this feature exists to
  // generate." The screen half trusted the same row's wording as an actual decision.
  // A `mistake` row with identical wording still demotes (the case above); only the
  // unverified `fact` kind must not.
  it("does not treat an unverified bootstrap fact as a decision this repository made", () => {
    const k = known({
      kind: "fact",
      source: "derived",
      statement: "Splitting the store's query surface from its migration surface was considered and rejected.",
      verifiedAt: "2026-07-04T00:00:00.000Z",
    });
    const [s] = screen([proposal()], "src/store", [k]);
    expect(s?.demotions).not.toContain("already-decided");
  });

  // Not dropped: a taught rule can be wrong, and a model arguing against one is worth
  // reading. The reader is only told they are arguing with a decision, not with nothing.
  it("keeps an idea that argues with a taught rule, and says so", () => {
    const k = known({
      source: "taught",
      statement:
        "The store's query surface and its migration surface stay in one file, so a migration cannot drift " +
        "from the queries it changes.",
    });
    const [s] = screen([proposal()], "src/store", [k]);
    expect(s?.demotions).toContain("contradicts-taught");
    expect(s?.because.join(" ")).toContain("taught rule");
  });

  it("ranks survivors first and out-of-scope last", () => {
    const out = screen(
      [
        proposal({ idea: "elsewhere", touches: ["src/mcp/a.ts"] }),
        { ...lacking("settledBy"), idea: "weak" },
        proposal({ idea: "good" }),
      ],
      "src/store",
      [],
    );
    expect(out.map((s) => s.proposal.idea)).toStrictEqual(["good", "weak", "elsewhere"]);
  });
});
