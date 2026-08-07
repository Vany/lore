import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { EXTRACTOR_VERSION, UNSCREENED, extractRules, ingestDocs, rank, type Screen } from "./ingest.ts";

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
    // The bullet is ONE rule: its first sentence, with the rest as the reason.
    expect(rules[0]?.statement).toBe("SPEC is ground truth");
    expect(rules[0]?.why).toContain("I update SPEC in the same change");
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

  // A BULLET IS ONE RULE, AND THE REST IS WHY, which is the trade this reader makes
  // deliberately. It used to split a bullet back into sentences and offer each alone —
  // so every multi-sentence bullet shed its tail as a free-standing "team decision"
  // ("The audit half of that design could never have fired") and the reason a rule
  // exists was thrown away in the same motion, because it is almost always the NEXT
  // sentence. Measured: `why` coverage 5 of 66 -> 30 of 58.
  //
  // THE KNOWN COST, recorded rather than hidden: a bullet that really does hold two
  // rules keeps only the first as a rule. The second is not lost — it becomes the
  // reason, so it still reaches every prompt — but it is attached rather than standing
  // on its own. Two rules crammed into one bullet is rarer than a rule followed by its
  // justification, and the second shape was producing most of the fragments.
  it("takes a bullet as one rule, with the rest as its reason", () => {
    const md = "- Reviewer agents are read-only, always. A fake reviewer must not be kinder than production.";
    const rules = extractRules(md);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.statement).toBe("Reviewer agents are read-only, always");
    expect(rules[0]?.why).toContain("kinder than production");
  });

  // Shapes a regex CAN name, unlike the residue the model screen exists for (D-81).
  it("refuses a lead-in and a label line", () => {
    expect(extractRules("- Two things a client must get right, both of which fail silently:")).toStrictEqual([]);
    expect(extractRules("- Arguments: `branch` (required), `into` (required).")).toStrictEqual([]);
  });

  it("refuses a bullet that names an approach rather than stating a rule", () => {
    const md = "- Watching opencode's event stream and aborting on the cap looks right and must never be trusted.";
    expect(extractRules(md)).toStrictEqual([]);
  });

  // THE SHAPE DECIDES. A paragraph carrying a modal is almost always the STORY of a
  // decision rather than the decision — measured 2026-08-06, SPEC.md produced 111 rules
  // and 108 of them came from paragraphs of incident narrative, arriving as fragments
  // with their subjects in sentences that were never captured.
  //
  // What it yields TODAY is deliberately not written here. SPEC.md is edited most
  // sessions, so the figure moves without the extractor changing: this comment said 8
  // while three other places said 15 and the real answer was 18, which is a false alarm
  // planted in the middle of an audit this branch itself orders. The behaviour below is
  // what the test holds; the count is a measurement with a date on it, kept in the one
  // place that explains the reader (`EXTRACTOR_VERSION`).
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

// The screen is a model, so every test here is about what happens when the model is
// wrong, absent, or expensive — never about it being right, which is not this module's
// property to hold.
describe("the screen's veto over what was mined", () => {
  let dir: string;
  let store: Store;
  let repoId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-screen-"));
    writeFileSync(
      join(dir, "PROG.md"),
      "- Handles are CSPRNG-generated, never sequential\n- The distinction is load-bearing and must not erode\n",
      // Two candidates. The second is exactly what the SCREEN exists for and no regex
      // can name: rule-shaped, correctly punctuated, carrying a modal — and meaningless
      // read alone, because "The distinction" points at something in a paragraph that
      // was never captured. It was live in the store.
    );
    store = new Store(":memory:");
    repoId = store.upsertRepo("r", "git@example.com:o/r.git").id;
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const failing: Screen = (_doc, candidates) => Promise.resolve({ kept: candidates, refused: [], ran: false });

  const refusing = (statement: string, because: string): Screen =>
    (_doc, candidates) =>
      Promise.resolve({
        kept: candidates.filter((c) => !c.statement.includes(statement)),
        refused: candidates.filter((c) => c.statement.includes(statement)).map((c) => ({ statement: c.statement, because })),
        ran: true,
      });

  it("keeps what survived and stamps it with the reader that screened it", async () => {
    const out = await ingestDocs(store, repoId, dir, {
      files: ["PROG.md"],
      screen: refusing("The distinction", "\"The distinction\" has no antecedent"),
    });

    expect(out.added).toBe(1);
    expect(out.screenedOut).toBe(1);
    expect(out.unscreened).toBe(0);
    const live = store.knowledgeFor(repoId);
    expect(live.map((k) => k.statement)).toStrictEqual(["Handles are CSPRNG-generated, never sequential"]);
    expect(live[0]?.extractor).toBe(EXTRACTOR_VERSION);
  });

  // THE WHOLE OBJECTION TO A FILTER is that a rule which never arrives is invisible —
  // nobody knows it is missing and re-reading the document will not bring it back,
  // because the reader that mined it also refused it. So the refusal is a row.
  it("records what it threw away, with the reason, where an operator can find it", async () => {
    await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen: refusing("The distinction", "\"The distinction\" has no antecedent") });

    const rows = store.db
      .prepare("SELECT statement, retired_reason FROM knowledge WHERE repo_id = ? AND retired_at IS NOT NULL")
      .all(repoId) as { statement: string; retired_reason: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.statement).toBe("The distinction is load-bearing and must not erode");
    expect(rows[0]?.retired_reason).toBe('screened out: "The distinction" has no antecedent');
    // And it is not live, so no reviewer is ever shown it.
    expect(store.knowledgeFor(repoId).map((k) => k.statement)).not.toContain("The distinction is load-bearing and must not erode");
  });

  // A QUOTA REFUSAL MUST NOT EMPTY A REPOSITORY'S MEMORY. The knowledge base is the
  // product; a review running with a fifth of its rules being fragments is worth more
  // than one running blind, and the stamp is what stops "for now" becoming "for ever".
  it("keeps everything and stamps it unscreened when the screen could not run", async () => {
    const out = await ingestDocs(store, repoId, dir, {
      files: ["PROG.md"],
      screen: (_doc, candidates) => Promise.resolve({ kept: candidates, refused: [], ran: false }),
    });

    expect(out.added).toBe(2);
    expect(out.unscreened).toBe(1);
    expect(store.knowledgeFor(repoId).every((k) => k.extractor === UNSCREENED)).toBe(true);
  });

  // ...and the next ingest comes back for them, which is the half that makes keeping
  // them defensible rather than a silent downgrade.
  it("re-screens the rows a failed screen left behind, with the document unchanged", async () => {
    await ingestDocs(store, repoId, dir, {
      files: ["PROG.md"],
      screen: (_doc, candidates) => Promise.resolve({ kept: candidates, refused: [], ran: false }),
    });

    const second = await ingestDocs(store, repoId, dir, {
      files: ["PROG.md"],
      screen: refusing("The distinction", "\"The distinction\" has no antecedent"),
    });
    expect(second.retired).toBe(2);
    expect(second.added).toBe(1);
    expect(store.knowledgeFor(repoId).map((k) => k.extractor)).toStrictEqual([EXTRACTOR_VERSION]);
  });

  // `ingestDocs` runs on EVERY review and almost always finds every document unchanged.
  // Without the cheap check first, the screen would buy a model call per document per
  // review, for ever, to write nothing at all.
  it("does not ask the model when nothing about the document or the reader changed", async () => {
    let asked = 0;
    const counting: Screen = (_doc, candidates) => {
      asked++;
      return Promise.resolve({ kept: candidates, refused: [], ran: true });
    };

    await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen: counting });
    expect(asked).toBe(1);
    await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen: counting });
    expect(asked).toBe(1);
  });

  // ...INCLUDING WHEN NOTHING SURVIVED, which is where the cheap check leaked and had no
  // floor. Asking only about LIVE rules meant a document whose every candidate was
  // legitimately refused looked unread on every subsequent review: a model call each
  // time, each one inserting another identical set of dead rows, for ever — in exactly
  // the case where the screen has the most to say.
  it("does not re-ask about a document whose candidates were all refused", async () => {
    let asked = 0;
    const refusingAll: Screen = (_doc, candidates) => {
      asked++;
      return Promise.resolve({
        kept: [],
        refused: candidates.map((c) => ({ statement: c.statement, because: "none of these are rules" })),
        ran: true,
      });
    };

    const first = await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen: refusingAll });
    expect(first.added).toBe(0);
    expect(first.screenedOut).toBe(2);

    const second = await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen: refusingAll });
    expect(asked).toBe(1);
    expect(second.screenedOut).toBe(0);
    // And the dead rows did not double.
    const dead = store.db
      .prepare("SELECT COUNT(*) c FROM knowledge WHERE repo_id = ? AND retired_at IS NOT NULL")
      .get(repoId) as { c: number };
    expect(Number(dead.c)).toBe(2);
  });

  // Without a screen configured the rows are stamped unscreened, NOT as though a screen
  // had passed them — otherwise a deployment with no model would look identical to one
  // whose screen approved everything, and would never be revisited.
  it("stamps rows unscreened when no screen is configured at all", async () => {
    const out = await ingestDocs(store, repoId, dir, { files: ["PROG.md"] });
    expect(out.unscreened).toBe(1);
    expect(store.knowledgeFor(repoId).every((k) => k.extractor === UNSCREENED)).toBe(true);
  });

  // THE DEGRADED MODE MUST NOT BE THE ONE THAT CORRUPTS THE RECORD. While the provider
  // is down every review comes back to retry, which is right — and the pass that follows
  // would otherwise retire every unscreened row (`extractor IS NOT '3.1'` matches
  // `3.1-unscreened`) with the reason "extracted by an older reader", which is false
  // because the reader never changed, then re-insert the identical set with fresh ids.
  // One full dead copy of the rule base per review, for the length of the outage, in the
  // path whose entire purpose is to survive an outage.
  //
  // Nothing called `ingestDocs` twice with the screen failing before this.

  it("rewrites nothing on a second pass while the screen is still down", async () => {
    const first = await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen: failing });
    expect(first.added).toBe(2);

    const before = store.db.prepare("SELECT COUNT(*) c FROM knowledge WHERE repo_id = ?").get(repoId) as { c: number };
    const second = await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen: failing });
    const after = store.db.prepare("SELECT COUNT(*) c FROM knowledge WHERE repo_id = ?").get(repoId) as { c: number };

    expect(second.added).toBe(0);
    expect(second.retired).toBe(0);
    // Still reported as unscreened, because it still is — the caller must keep hearing it.
    expect(second.unscreened).toBe(1);
    expect(Number(after.c)).toBe(Number(before.c));
  });

  // ONE ROW PER REFUSED STATEMENT, however often it is refused. A document is
  // re-ingested on every edit, so a statement the screen keeps rejecting was recorded
  // again each time and nothing collected the old copies — `retireForChangedBlob` only
  // touches live rows and these are born retired. 23 rows for 15 statements after one
  // afternoon, on files edited most sessions.
  it("does not stack a fresh refusal row every time a document is edited", async () => {
    const screen = refusing("The distinction", '"The distinction" has no antecedent');
    const dead = () =>
      Number((store.db.prepare("SELECT COUNT(*) c FROM knowledge WHERE retired_reason LIKE 'screened out:%'").get() as { c: number }).c);

    await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen });
    expect(dead()).toBe(1);

    // The document changes — a normal edit — so everything is re-extracted and
    // re-screened, and the same statement is refused again.
    writeFileSync(join(dir, "PROG.md"), readFileSync(join(dir, "PROG.md"), "utf8") + "\n- Fakes must not be kinder than production\n");
    await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen });
    expect(dead()).toBe(1);
  });

  // A DEGRADED READER MUST NEVER UNDO A GOOD ONE'S WORK, and this is the concurrent
  // shape of it: two reviews of one repository ingest the same changed document, A's
  // screen succeeds and refuses a candidate, B's provider call fails. B finds no
  // unscreened row, retires nothing of A's (A's rows carry the current blob and reader),
  // and would insert every candidate live and unscreened — including the one the model
  // had just rejected, which then goes back into every reviewer prompt until some later
  // ingest happens to heal it. There is no uniqueness constraint to catch it and no
  // ordering between the two reviews to rely on.
  // INTERLEAVED, not sequential, and the first version of this test was wrong for
  // exactly that reason: run one after the other, B's cheap check sees A's rows and
  // stops before the screen, so the test passed against the unfixed code. The race needs
  // B to pass that check while nothing is written yet, then have A land during B's
  // provider call. B's screen does A's whole ingest, which is a faithful and
  // deterministic stand-in for the interleaving.
  it("does not let a failed screen reinstate what a successful one refused", async () => {
    const slowAndFailing: Screen = async (_doc, candidates) => {
      await ingestDocs(store, repoId, dir, {
        files: ["PROG.md"],
        screen: refusing("The distinction", "\"The distinction\" has no antecedent"),
      });
      return { kept: candidates, refused: [], ran: false };
    };

    const b = await ingestDocs(store, repoId, dir, { files: ["PROG.md"], screen: slowAndFailing });

    const live = store.knowledgeFor(repoId).map((k) => k.statement);
    expect(b.added).toBe(0);
    // A's verdict stands: the statement the model rejected is still not live.
    expect(live).not.toContain("The distinction is load-bearing and must not erode");
    expect(live).toStrictEqual(["Handles are CSPRNG-generated, never sequential"]);
    expect(store.knowledgeFor(repoId).every((k) => k.extractor === EXTRACTOR_VERSION)).toBe(true);
  });

  // ...and the same must hold with no screen configured at all, which is the other way
  // a deployment sits in this state indefinitely.
  it("rewrites nothing on a second pass with no screen configured", async () => {
    await ingestDocs(store, repoId, dir, { files: ["PROG.md"] });
    const before = store.db.prepare("SELECT COUNT(*) c FROM knowledge WHERE repo_id = ?").get(repoId) as { c: number };
    const second = await ingestDocs(store, repoId, dir, { files: ["PROG.md"] });
    const after = store.db.prepare("SELECT COUNT(*) c FROM knowledge WHERE repo_id = ?").get(repoId) as { c: number };

    expect(second.added).toBe(0);
    expect(second.retired).toBe(0);
    expect(Number(after.c)).toBe(Number(before.c));
  });

  // THE SCREEN IS HALF OF WHAT DECIDES WHICH RULES LIVE, so the stamp has to name it.
  // Versioning only `extractRules` recreated the exact trap the stamp was built to
  // close, one layer up: the prompt or the tier could change and nothing already stored
  // would move, so an unchanged document kept an old screen's vetoes for ever and a
  // wrongly-refused rule stayed invisible — which is what the fragments did before any
  // stamp existed. The next planned change to this code is "measure the screen, then
  // improve the prompt", which walks straight into it.
  it("names both readers in the stamp, so a screen change retires what it produced", () => {
    const [extract, screenV] = EXTRACTOR_VERSION.split(".");
    expect(extract).toBeDefined();
    expect(screenV).toBeDefined();

    // A row from the same extractor but an older SCREEN is not a current row.
    store.addKnowledge({
      repoId, kind: "rule", source: "ingested", statement: "an older screen kept this",
      why: undefined, path: undefined, cwe: undefined, provenance: "PROG.md",
      sourceBlob: "blobA", extractor: `${String(extract)}.0`, confidence: 0.8,
    });
    expect(store.hasKnowledgeBlob(repoId, "PROG.md", "blobA", EXTRACTOR_VERSION)).toBe(false);
    expect(store.retireForChangedBlob(repoId, "PROG.md", "blobA", EXTRACTOR_VERSION)).toBe(1);
  });
});
