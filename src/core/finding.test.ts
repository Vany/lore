import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAIM_MAX,
  compareFindings,
  normalizeClaim,
  parseFinding,
  severityRank,
  SEVERITIES,
  worstSeverity,
  type Severity,
} from "./finding.ts";

const valid = {
  file: "src/pay/hold.ts",
  line: 142,
  symbol: "capturePayment",
  severity: "high",
  claim: "decline path leaves the hold active",
  evidence: "hold released only in the success branch (hold.ts:142-151)",
  failureScenario: "card declines → funds stay held until the 7d sweeper",
} as const;

describe("parseFinding", () => {
  it("accepts a well-formed finding", () => {
    expect(parseFinding(valid)).toStrictEqual(valid);
  });

  it("accepts one with only the required fields", () => {
    const minimal = {
      file: "README.md",
      severity: "low",
      claim: "no tests cover the drain path",
      evidence: "no reference to drain() in any test file",
      failureScenario: "shutdown drops in-flight work and nothing notices",
    };
    expect(parseFinding(minimal)).toStrictEqual(minimal);
  });

  // The drift detector. A model that invents a field means our prompt and this
  // schema have parted ways, and dropping it silently would hide that for as long
  // as it took someone to notice the findings had quietly got worse.
  it("rejects unknown keys rather than dropping them", () => {
    expect(() => parseFinding({ ...valid, confidence: 0.8 })).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() => parseFinding({ ...valid, file: "/etc/passwd" })).toThrow();
  });

  it("rejects a path that escapes the repo", () => {
    expect(() => parseFinding({ ...valid, file: "../../secrets.env" })).toThrow();
    expect(() => parseFinding({ ...valid, file: "a/../b" })).toThrow();
    expect(() => parseFinding({ ...valid, file: "a/b/.." })).toThrow();
    expect(() => parseFinding({ ...valid, file: ".." })).toThrow();
  });

  // Found by lore's own review of src/core (D-130 folder mode): the escape guard used to
  // be a bare `.includes("..")`, which refuses ANY path containing two consecutive dots
  // anywhere — not just a ".." path segment. Verified against real git: it tracks
  // `docs/api..deprecated.md` without complaint. No repair step in this file's chain
  // touches `file`, so an over-broad guard here does not degrade the finding, it discards
  // the whole thing.
  it("accepts a legal filename that merely contains two dots, not a traversal segment", () => {
    expect(parseFinding({ ...valid, file: "docs/api..deprecated.md" }).file).toBe("docs/api..deprecated.md");
    expect(parseFinding({ ...valid, file: "src/a..b.ts" }).file).toBe("src/a..b.ts");
  });

  it("accepts a well-formed cwe, and REPAIRS a malformed one rather than losing the finding", () => {
    expect(parseFinding({ ...valid, cwe: "CWE-362" }).cwe).toBe("CWE-362");
    // Reversed by D-116's follow-through. These used to throw, discarding a whole finding
    // over a taxonomy field most findings do not even carry. The drift is still reported —
    // in `evidence`, where every reader of the finding sees it — which is the thing the
    // old rejection was for.
    for (const bad of ["89", "CWE-", "CWE-abc", "nonsense"]) {
      const got = parseFinding({ ...valid, cwe: bad });
      expect(got.cwe, `cwe=${bad}`).toBeUndefined();
      expect(got.evidence).toContain("lore dropped the CWE");
      expect(got.evidence, "the original evidence survives the repair").toContain(valid.evidence);
    }
  });

  // Found by lore's own review of src/core (D-130 folder mode): a padded-but-valid cwe
  // ("CWE-362 ") used to fail this file's own repair check on a TRIMMED comparison, then
  // fail the schema's UNTRIMMED regex downstream — losing the whole finding, which is
  // worse than what happens to a genuinely malformed cwe like "CWE-abc" one line above.
  // Silently normalized, not repaired-with-a-note: padding is not a vocabulary
  // disagreement worth surfacing.
  it.each([["CWE-362 "], [" CWE-362"], ["  CWE-362  "]])("normalizes a padded-but-valid cwe %s", (cwe) => {
    expect(parseFinding({ ...valid, cwe }).cwe).toBe("CWE-362");
  });

  // Every way a model has been seen to write "no CWE applies", pinned.
  //
  // This table is the point. The `""` behaviour was written to stop one blank
  // field discarding a whole paid-for batch, the reasoning was put in a comment,
  // and NOTHING tested it — so deleting the preprocess left the suite green while
  // re-arming the original incident. `null` is here because a review found it
  // missing: it is the more natural JSON for absent, and it was still rejected.
  it.each([
    ["absent", undefined],
    ["empty string", ""],
    ["whitespace", "   "],
    ["null", null],
  ])("reads cwe %s as no CWE rather than as malformed", (_label, cwe) => {
    expect(parseFinding({ ...valid, cwe }).cwe).toBeUndefined();
  });

  // The other half, revised. Drift still fails loudly — it just no longer fails by
  // DISCARDING the report, which is the trade D-115 and D-116 reversed twice before this.
  // A cwe that is not a string at all is a different fault: that is a malformed reply
  // rather than an unfamiliar vocabulary, and it still refuses.
  it.each([[89], [{}], [[]]])("still rejects %s as a cwe, because it is not a word", (cwe) => {
    expect(() => parseFinding({ ...valid, cwe })).toThrow();
  });

  // EVERY optional field, not just the one that was reported.
  //
  // The `cwe` table above existed, the reasoning was written beside it, and the fix
  // was applied to that field instead of to the rule — so `symbol` and `line` kept
  // the identical defect. glm-5-turbo sent `symbol: null`, twice, and the whole
  // review failed: the schema is `.strict()` inside a batch parse, so one null
  // discards every finding in a reply that has already been paid for.
  //
  // Parameterised over the fields so adding an optional one without deciding this
  // question is not possible by accident.
  it.each([["cwe"], ["symbol"], ["line"]])("reads %s null/blank as absent, not as malformed", (field) => {
    for (const v of [undefined, null, "", "   "]) {
      const got = parseFinding({ ...valid, [field]: v });
      expect(got[field as keyof typeof got], `${field}=${JSON.stringify(v)}`).toBeUndefined();
    }
  });

  // Forgiving blank must not become forgiving anything — still true of `symbol`, whose
  // wrong shapes are malformed replies rather than impossible values.
  it.each([
    ["symbol", 42],
    ["symbol", {}],
  ])("still rejects %s = %s", (field, v) => {
    expect(() => parseFinding({ ...valid, [field]: v })).toThrow();
  });

  /**
   * A LINE THAT CANNOT BE A LINE DEGRADES THE FINDING TO FILE-LEVEL, rather than costing
   * it. Reversed with the cwe case above and for the same reason: the schema already
   * supports a file-level finding, so dropping the number keeps strictly more information
   * than dropping the record. `0`, `-1`, `1.5` and `"top"` are all cases where the model
   * MEANT a line and named an impossible one — distinct from omitting it, which `absent`
   * has always read as "no line" and still does.
   */
  it.each([["top"], [0], [-1], [1.5]])("repairs line = %s into a file-level finding", (v) => {
    const got = parseFinding({ ...valid, line: v });
    expect(got.line).toBeUndefined();
    expect(got.evidence).toContain("lore dropped the line");
    expect(got.evidence).toContain(valid.evidence);
  });

  // Both repairs at once, because a reply that got one field wrong often got two.
  it("repairs a bad line and a bad cwe together, reporting both", () => {
    const got = parseFinding({ ...valid, line: 0, cwe: "CWE-abc" });
    expect(got.line).toBeUndefined();
    expect(got.cwe).toBeUndefined();
    expect(got.evidence).toContain("lore dropped the line");
    expect(got.evidence).toContain("lore dropped the CWE");
  });

  // Found by lore's own review of src/core (D-130 folder mode): repairStructure used to
  // append its note AFTER evidence, so on evidence already close to TEXT_MAX,
  // clampOverlongText's tail-cut (it runs last and keeps the first TEXT_MAX-1 characters)
  // could slice the note off entirely — silently defeating the "marked, never silent"
  // rule this file states twice, on the one path meant to disclose a repair. The note now
  // goes first, same reasoning foldOverlongClaim already applies to its own carried claim.
  it("keeps the line-repair note intact even when evidence alone is close to TEXT_MAX", () => {
    const got = parseFinding({ ...valid, line: 0, evidence: "e".repeat(1990) });
    expect(got.line).toBeUndefined();
    expect(got.evidence).toContain("lore dropped the line the reviewer gave (0)");
  });

  /**
   * D-128, from a real loss on this repository's own review of D-127: a critical finding
   * about a real reconciliation bug (services/clearing-settlement/src/logic/run-
   * reconciliation.ts), reported as `{"title": ..., "detail": ..., "severity": "critical"}`
   * instead of `claim`/`evidence`, refused by `.strict()`, and recovered only because a
   * retry — a second, independently-worded generation of the same finding — happened to
   * land on the right names. This is that exact reply, repaired at the boundary instead of
   * gambled on a second attempt.
   */
  it("reads title/detail as claim/evidence instead of losing a finding to the wrong field names", () => {
    const garbled = {
      file: "services/clearing-settlement/src/logic/run-reconciliation.ts",
      line: 130,
      symbol: "runReconciliation",
      severity: "critical",
      title: "Lookback widening counts pre-window clearing positions without their credits",
      detail:
        "`positionFromDate` now fetches positions before `fromDate`, but ledger credits are still filtered " +
        "at `fromDate` itself, so a pre-window position can be counted with no matching credit ever fetched.",
    };
    const got = parseFinding(garbled);
    expect(got.claim).toBe(garbled.title);
    expect(got.evidence).toContain(garbled.detail);
    // Nothing invented a distinct failure scenario, so it reuses evidence rather than
    // failing the whole finding over the one field with no source to repair it from.
    expect(got.failureScenario).toContain(garbled.detail);
    // NOT evidence that severity survived unchanged: "critical" is not one of SEVERITIES
    // and D-115 maps any unrecognised word to "high" — on a well-formed reply exactly as
    // readily as on this repaired one (see the synonym table below). What this repair
    // actually removes is the RETRY, and the total-loss risk a second, independent
    // generation of the finding carries — not a severity difference, which was never real.
    expect(got.severity).toBe("high");
    expect("title" in got).toBe(false);
    expect("detail" in got).toBe(false);
  });

  // Found by lore's own review of src/core (D-130 folder mode), sibling of the same fix
  // to repairStructure: this used to append its "lore read X as Y" note AFTER the
  // promoted detail/evidence, so a long detail already close to TEXT_MAX let
  // clampOverlongText's later tail-cut slice the note off entirely — repairFieldNames
  // runs FIRST in the chain, so it is exposed to the same clamp every later step is.
  it("keeps the field-name repair note intact even when detail alone is close to TEXT_MAX", () => {
    const got = parseFinding({
      file: valid.file,
      severity: valid.severity,
      title: "a claim, misnamed",
      detail: "e".repeat(1990),
      failureScenario: valid.failureScenario,
    } as never);
    expect(got.evidence).toContain('lore read "detail" as "evidence"');
  });

  it("leaves a reply that already has claim alone, even beside a stray title", () => {
    // The narrow half of D-128: an extra field beside otherwise-correct output is a
    // stronger drift signal than a substitution for a genuinely missing one, and this
    // repair must not swallow it — `.strict()` still refuses, matching "rejects unknown
    // keys rather than dropping them" above.
    expect(() => parseFinding({ ...valid, title: "a stray title" })).toThrow();
  });

  // THE OTHER HALF OF THE SAME NARROWNESS, missed the first time — found by lore's own t1
  // reviewing D-128 itself. `claim` missing (title legitimately promoted) but `evidence`
  // ALREADY present, with a stray `detail` beside it: the promotion loop used to delete
  // `detail` unconditionally after checking whether `evidence` needed it, so this exact
  // shape silently dropped the reviewer's `detail` content with no note and no chance for
  // `.strict()` to name it — the drift detector this repair is supposed to leave standing.
  it("does not silently drop a stray detail when evidence did not need it", () => {
    expect(() =>
      parseFinding({
        file: valid.file,
        severity: valid.severity,
        title: "the claim, misnamed",
        evidence: valid.evidence,
        detail: "unrelated content beside an already-correct evidence",
        failureScenario: valid.failureScenario,
      }),
    ).toThrow();
  });

  it("repairs claim alone when only title is wrong, leaving a correct evidence untouched", () => {
    const got = parseFinding({ file: valid.file, severity: valid.severity, title: "the claim, misnamed",
      evidence: valid.evidence, failureScenario: valid.failureScenario });
    expect(got.claim).toBe("the claim, misnamed");
    expect(got.evidence).toContain(valid.evidence);
    expect(got.failureScenario).toBe(valid.failureScenario); // untouched: it was never missing
  });

  // THE MIRROR GAP, found by lore's own t1 reviewing the fix above: the entry guard
  // returned early whenever `claim` was already present, so a reply that got `claim`
  // right but `evidence` wrong — the same substitution, one field along — was never
  // reached at all, even though the `detail`→`evidence` promotion below could have
  // handled it. Each field's repair must not depend on the OTHER field having needed one.
  it("repairs evidence alone when only detail is wrong, leaving a correct claim untouched", () => {
    const got = parseFinding({ file: valid.file, severity: valid.severity, claim: valid.claim,
      detail: "the evidence, misnamed", failureScenario: valid.failureScenario });
    expect(got.claim).toBe(valid.claim); // untouched: it was never missing
    expect(got.evidence).toContain("the evidence, misnamed");
    expect("detail" in got).toBe(false);
  });

  // MISSING IS NOT THE SAME CLAIM AS WRONG-TYPED — asked by lore's own t2, reviewing the
  // fix above: should `claim: 7` beside a good `title` be silently overwritten? This
  // answers no, and pins the line the answer depends on: the same distinction `cwe`
  // already draws ("blank is forgiven; WRONG is still rejected"). A wrong-typed claim is
  // left exactly alone — not promoted over — so `.strict()` names BOTH problems: the type
  // error on `claim`, and the now-genuinely-unused `title` beside it.
  it("does not promote title over a wrong-typed claim, letting the type error stand", () => {
    expect(() => parseFinding({ ...valid, claim: 7 as never, title: "a real claim" })).toThrow();
  });

  // THE OTHER HALF OF THE SAME LINE: an EMPTY claim is "nothing was said", the same as
  // absent, and stays repair-eligible — matching `absent()`'s treatment of blank
  // elsewhere in this file, not the wrong-type case above.
  it("still promotes title over a blank (not wrong-typed) claim", () => {
    const got = parseFinding({ ...valid, claim: "   ", title: "a real claim" });
    expect(got.claim).toBe("a real claim");
  });

  // A NOTE IS NOT PROOF — found by lore's own t2, reviewing the repair above. `title`
  // alone, no `detail` and no `evidence` under either name: before this, the final
  // note-append step had nothing real to attach its note to and fabricated `evidence`
  // FROM the note itself ("lore read title as claim"), which satisfies the schema and
  // reads as proof of nothing. This must still fail exactly as it would have with none of
  // these repairs — a model that supplied no evidence gets no evidence invented for it.
  it("still refuses a finding whose evidence is fabricated from nothing but a repair note", () => {
    expect(() =>
      parseFinding({
        file: valid.file,
        severity: valid.severity,
        title: "a claim with no evidence anywhere",
        failureScenario: valid.failureScenario,
      }),
    ).toThrow();
  });

  // THE SAME BUG, FOUND SECONDS LATER IN `repairStructure` — the SPEC text excusing that
  // join called it safe because it "only runs on a finding whose evidence this schema
  // already required", which is backwards: the required check is the Zod parse AFTER every
  // preprocessing step, this one included. A bad `line` with no `evidence` anywhere used to
  // reach the join with nothing real to attach a note to, fabricating evidence from the
  // "lore dropped the line" note alone.
  it("still refuses a finding whose evidence is fabricated from nothing but a line-repair note", () => {
    expect(() =>
      parseFinding({
        file: valid.file,
        line: 0, // malformed, triggers repairStructure's note
        severity: valid.severity,
        claim: valid.claim,
        failureScenario: valid.failureScenario,
        // no evidence anywhere
      } as never),
    ).toThrow();
  });

  // THE THIRD FIELD, missed when `missing()` was written for claim/evidence and not
  // carried to the backfill beside them: a wrong-typed `failureScenario` used to read as
  // "absent" (via `usable()`) and get silently overwritten by the evidence backfill, with
  // a note claiming none was found — false, one was given, just wrong-typed. `title`/
  // `detail` here (not `claim`/`evidence`) are what get the repair PAST the entry guard,
  // so the backfill guard is the thing actually under test.
  it("does not let the failureScenario backfill overwrite a wrong-typed one", () => {
    expect(() =>
      parseFinding({
        file: valid.file,
        severity: valid.severity,
        title: "a claim",
        detail: "the evidence",
        failureScenario: 42 as never,
      }),
    ).toThrow();
  });

  /**
   * THE SAME RULE ON THE FIELDS IT HAD NOT REACHED. D-115 fixed `severity`, D-116 fixed
   * `claim`, and these two kept the identical defect one field along — which is exactly
   * how the first two came to exist. Parameterised over the fields so adding a third text
   * field without deciding this question is not possible by accident.
   */
  it.each([["evidence"], ["failureScenario"]])(
    "clamps an over-long %s instead of losing the finding",
    (field) => {
      const long = "word ".repeat(600); // 3000 chars, well past TEXT_MAX
      const got = parseFinding({ ...valid, [field]: long });
      const text = got[field as "evidence" | "failureScenario"];
      expect(text.length).toBeLessThanOrEqual(2000);
      // MARKED, never silent — the whole difference from the mid-clause truncation D-64
      // condemns is that a reader can see something was cut.
      expect(text.endsWith("…")).toBe(true);
    },
  );

  // Order matters: the claim fold WRITES into evidence, so clamping evidence first would
  // leave the join to overflow and lose the finding both folds exist to save.
  it("survives an over-long claim and an over-long evidence together", () => {
    const f = parseFinding({
      ...valid,
      claim: "c".repeat(CLAIM_MAX * 3),
      evidence: "e".repeat(5000),
    });
    expect(f.claim.length).toBeLessThanOrEqual(CLAIM_MAX);
    expect(f.evidence.length).toBeLessThanOrEqual(2000);
  });

  /**
   * FOLDS AN OVER-LONG CLAIM RATHER THAN THROWING THE FINDING AWAY (D-116). Reversed
   * deliberately, exactly as the severity case above was: this used to assert `toThrow()`,
   * and the cost was measured on this repository: a t2 finding — a ledger read ordered
   * before a bound check — was lost to `claim: Too big: expected string to have <=500
   * characters`, in the same review where two more were lost to the severity word D-115
   * had just fixed.
   *
   * Derived from the constant, not from a literal: the cap moved 300 → 500 and a
   * hardcoded 301 would have kept passing while asserting nothing.
   */
  it("folds an over-long claim instead of losing the finding", () => {
    const long = `${"word ".repeat(CLAIM_MAX)}end`;
    const f = parseFinding({ ...valid, claim: long });
    expect(f.claim.length).toBeLessThanOrEqual(CLAIM_MAX);
    expect(f.claim.endsWith("…")).toBe(true);
  });

  // Nothing the author wrote may be lost — that is the whole difference between this and
  // the mid-clause truncation D-64's rationale condemns. Sized like the observed failure
  // (a claim a few hundred over the cap), which is the case this has to get right; the
  // pathological one is asserted separately below.
  it("carries the full claim into evidence, verbatim", () => {
    const long = `${"word ".repeat(140)}end`;
    expect(long.length).toBeGreaterThan(CLAIM_MAX);
    const f = parseFinding({ ...valid, claim: long });
    expect(f.evidence).toContain(long.trim());
    expect(f.evidence).toContain(valid.evidence);
    expect(f.evidence.length).toBeLessThanOrEqual(2000);
  });

  // Both fields share TEXT_MAX, so a claim longer than the whole evidence budget cannot be
  // carried whole AND leave the original evidence intact. The claim wins, because it is the
  // field that was about to cost the finding — and the clamp is marked, not silent. Asserted
  // rather than left implicit: this is the one case where the fold is lossy.
  it("prefers the claim over the original evidence when the claim alone exceeds TEXT_MAX", () => {
    const enormous = "word ".repeat(600); // 3000 chars, well past TEXT_MAX
    const f = parseFinding({ ...valid, claim: enormous, evidence: "original evidence" });
    expect(f.evidence.startsWith("Claim in full: word word")).toBe(true);
    expect(f.evidence.endsWith("…")).toBe(true);
    expect(f.evidence.length).toBeLessThanOrEqual(2000);
  });

  // A fold must not trade one refusal for another: evidence at its own cap plus a carried
  // claim would overflow TEXT_MAX and lose the finding this just rescued.
  it("keeps evidence inside its cap when both are at their limits", () => {
    const f = parseFinding({
      ...valid,
      claim: "x".repeat(CLAIM_MAX * 3),
      evidence: "e".repeat(2000),
    });
    expect(f.evidence.length).toBeLessThanOrEqual(2000);
    expect(f.claim.length).toBeLessThanOrEqual(CLAIM_MAX);
  });

  // The boundary itself is untouched: a claim exactly at the cap is not a fold candidate,
  // so it keeps its last character and gains no ellipsis and no evidence prefix.
  it("leaves a claim at exactly the cap alone", () => {
    const f = parseFinding({ ...valid, claim: "x".repeat(CLAIM_MAX) });
    expect(f.claim).toBe("x".repeat(CLAIM_MAX));
    expect(f.evidence).toBe(valid.evidence);
  });

  it("rejects empty required text", () => {
    expect(() => parseFinding({ ...valid, claim: "" })).toThrow();
    expect(() => parseFinding({ ...valid, evidence: "" })).toThrow();
    expect(() => parseFinding({ ...valid, failureScenario: "" })).toThrow();
  });

  // The line cases moved to `repairs line = %s into a file-level finding` above, where
  // the reversal is explained. Left as a pointer rather than deleted: two tests asserting
  // opposite things about `line` in one file is how a reversal gets half-applied, and this
  // file already carries one instance of exactly that (the `cwe` reasoning that was
  // written down while nothing executed it).
  // Any line that cannot be one is dropped, whatever shape it arrived in. Written after
  // the first attempt asserted that `{}` and `[]` still refuse — they do not, and should
  // not: the rule is about the FINDING surviving, and it does not become less true because
  // the model sent an object where a number belongs.
  it.each([[{}], [[]], [true]])("repairs a line of shape %s the same way", (v) => {
    const got = parseFinding({ ...valid, line: v });
    expect(got.line).toBeUndefined();
    expect(got.evidence).toContain("lore dropped the line");
  });

  /**
   * MAPS AN UNKNOWN SEVERITY RATHER THAN THROWING THE FINDING AWAY. Reversed
   * deliberately: this used to assert `toThrow()`, and the cost of that strictness was
   * measured on this repository — t1 raised a `critical` finding about an unbounded round
   * loop, the parse failed, and the whole report was discarded. What reached the client
   * was a `checks_skipped` line saying a finding existed and could not be shown: a review
   * that found something and said nothing, which is INV-1 exactly.
   *
   * The scale stays three (D-50). A model reaching for a fourth word is expressing
   * urgency, not proposing a taxonomy, so the word is mapped and the finding survives.
   */
  it("maps an unknown severity to high instead of losing the finding", () => {
    expect(parseFinding({ ...valid, severity: "critical" }).severity).toBe("high");
    expect(parseFinding({ ...valid, severity: "blocker" }).severity).toBe("high");
    // Unrecognised means ESCALATE, never bury: `severityRank` ranks an unknown first for
    // the same reason, and a nit misfiled as high costs a reader one line.
    expect(parseFinding({ ...valid, severity: "wat" }).severity).toBe("high");
  });

  it("maps the ordinary synonyms to the scale that exists", () => {
    expect(parseFinding({ ...valid, severity: "MODERATE" }).severity).toBe("medium");
    expect(parseFinding({ ...valid, severity: "informational" }).severity).toBe("low");
    expect(parseFinding({ ...valid, severity: " High " }).severity).toBe("high");
  });

  it("still rejects a severity that is not a word at all", () => {
    expect(() => parseFinding({ ...valid, severity: 3 })).toThrow();
    expect(() => parseFinding({ ...valid, severity: null })).toThrow();
  });
});

// D-64 said "the number is now in one place". It was not, and I wrote that sentence
// into SPEC without checking it.
//
// t2 found four survivors: `src/t0/engines.ts` and `src/security/osv.ts` both
// truncated claims at a hardcoded 300 — with an ellipsis, mid-clause, which is the
// exact failure D-64's own rationale gives for raising the cap rather than
// truncating — `src/knowledge/bootstrap.ts` told a model "max 300 characters", and
// `src/security/security.test.ts` asserted `<= 300` under the title "satisfy the
// finding schema's caps", so correcting osv.ts would have made that test fail and
// blocked its own fix.
//
// The consequence was worse than staleness: a 350-character claim from semgrep was
// silently cut while an identical one from a model passed intact, so the same
// finding got different treatment depending on which engine raised it.
//
// This is the check that makes the claim in SPEC true, mechanically, instead of by
// assertion — the same shape as `docs.test.ts`, and for the same reason.
// The rule, not the field. `cwe` was given a preprocess mapping null and blank to
// absent, with the reasoning written beside it, and `symbol`, `line` and all five
// optional MCP tool arguments kept the defect — because the fix went where the bug
// was reported instead of where it applied. It then went off: `symbol: null`, twice,
// and a whole review discarded.
//
// Zod's `.optional()` short-circuits on `undefined` alone, so a bare one always
// rejects `null` — and every caller here is a language model, which writes `null` for
// absent as readily as it omits the key.
describe("no schema field is optional without deciding what null means", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));

  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return e.isFile() && p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });

  it("routes every .optional() through absent()", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      // The helper itself is where `.optional()` is allowed to appear.
      if (file.endsWith("core/optional.ts")) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (line.includes(".optional()")) offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toStrictEqual([]);
  });
});

describe("the claim cap lives in exactly one place", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));

  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return e.isFile() && p.endsWith(".ts") ? [p] : [];
    });

  // Comments are exempt, and that is not a loophole — it is the same rule MEMO
  // follows. "glm-5.2 wrote a 325-character claim against a 300-character cap" is a
  // record of what was true then; rewriting it to say 500 would falsify the history
  // that justifies the current value. Three such lines exist and all three are
  // history. What must never appear is an EXECUTABLE 300: a cap, an assertion, or a
  // string handed to a model.
  const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

  it("is not hardcoded in any code path that caps or states it", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (isComment(line) || !/\bclaim\b/i.test(line)) return;
          // The shapes that drifted: `cap(claim, 300)`, `"max 300 characters"`,
          // `toBeLessThanOrEqual(300)`. The CURRENT value is matched too, so raising
          // the cap again cannot leave a fresh literal behind — this test has to
          // fail on its own next revision, not just on the last one.
          if (/\b(300|500)\b/.test(line) && !line.includes("CLAIM_MAX")) {
            offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toStrictEqual([]);
  });
});

describe("normalizeClaim", () => {
  it("ignores case, surrounding space and collapsed whitespace", () => {
    expect(normalizeClaim("  Decline   path\nleaves the hold ACTIVE  ")).toBe(
      "decline path leaves the hold active",
    );
  });

  it("ignores trailing sentence punctuation", () => {
    expect(normalizeClaim("hold stays active.")).toBe("hold stays active");
    expect(normalizeClaim("hold stays active!!")).toBe("hold stays active");
  });

  // Guards against over-normalising. Two genuinely different claims must stay
  // different: a wrongly merged finding is one that never gets fixed.
  it("does not merge claims that differ in meaning", () => {
    expect(normalizeClaim("hold is released twice")).not.toBe(
      normalizeClaim("hold is never released"),
    );
  });

  it("leaves internal punctuation alone", () => {
    expect(normalizeClaim("uses toEqual, not toStrictEqual")).toBe(
      "uses toequal, not tostrictequal",
    );
  });
});

// The order findings are presented in (D-50). Pinned because the natural orders are
// both wrong: alphabetically "high, low, medium", by insertion whatever the engines
// happened to emit. The one that matters is worst first, and it matters most in the
// places that show only the top of the list.
describe("severity ordering", () => {
  it("declares SEVERITIES worst first, since the index IS the rank", () => {
    expect(SEVERITIES).toStrictEqual(["high", "medium", "low"]);
  });

  it("ranks medium as worse than low", () => {
    expect(severityRank("high")).toBeLessThan(severityRank("medium"));
    // The whole bug in one assertion: as text, "low" < "medium".
    expect(severityRank("medium")).toBeLessThan(severityRank("low"));
  });

  // Only reachable through a row written around the schema. First, not last: at the
  // bottom it would read as a nit, and it would be the first thing a cut discarded.
  it("ranks a severity it does not recognise first, not last", () => {
    const bogus = "catastrophic" as Severity;
    expect(severityRank(bogus)).toBeLessThan(severityRank("high"));
  });

  it("sorts worst first, then by file, then by line", () => {
    const f = (severity: Severity, file: string, line?: number) => ({
      severity,
      file,
      ...(line === undefined ? {} : { line }),
    });
    const shuffled = [
      f("low", "a.ts", 1),
      f("medium", "b.ts", 1),
      f("high", "z.ts", 9),
      f("medium", "a.ts", 40),
      f("medium", "a.ts", 2),
      f("medium", "a.ts"),
    ];
    expect([...shuffled].sort(compareFindings)).toStrictEqual([
      f("high", "z.ts", 9),
      // No line first within a file: file-level findings are about the whole file.
      f("medium", "a.ts"),
      f("medium", "a.ts", 2),
      f("medium", "a.ts", 40),
      f("medium", "b.ts", 1),
      f("low", "a.ts", 1),
    ]);
  });

  it("finds the worst severity present rather than the first one listed", () => {
    expect(worstSeverity(["low", "medium", "low"])).toBe("medium");
    expect(worstSeverity(["low", "high", "medium"])).toBe("high");
    expect(worstSeverity(["low"])).toBe("low");
    expect(worstSeverity([])).toBeUndefined();
  });
});
