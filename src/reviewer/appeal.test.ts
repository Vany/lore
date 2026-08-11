/**
 * Appealing a finding to a development rule, end to end (D-83).
 *
 * The mechanism is small and every part of it is a place where an appeal could quietly
 * become something stronger than it should be, so this walks the whole loop with real
 * git, the real store, the real ladder, and a fake T0 that re-raises the same
 * deterministic finding for ever — which is the case the feature exists for.
 *
 * The four refusals matter as much as the acceptance. An appeal must not be able to
 * silence a check when the rule does not resolve, when a MODEL raised the finding, when
 * the finding has no engine rule class, or when the tier disagreed — and each of those
 * is a different line of code, so each gets a test. Getting any of them wrong turns
 * "argue your case to a reviewer" into "write a rule, cite it, switch the check off",
 * which is D-10 defeated with an audit trail that reads like due process.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "../core/finding.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { initialState } from "../core/ladder.ts";
import { CODE_ARCH } from "../core/review-type.ts";
import { Store, type RecordedFinding } from "../store/store.ts";
import type { ReviewerLike, ReviewerResult } from "./opencode.ts";
import { alreadyAnswered, filesInDiff, runRound } from "./review.ts";

/** A model tier that says exactly what the test scripts, and keeps every prompt it saw. */
class ScriptedReviewer implements ReviewerLike {
  /**
   * A PAIR NOW, NOT A STRING (D-80). `review()` takes either one prompt or the
   * initial/continued pair a kept session needs, and a fixture that recorded the object
   * would assert against "[object Object]" — passing or failing for reasons unrelated to
   * what it is testing. The INITIAL is what these tests are about: what a tier is told
   * when it first looks.
   */
  static text(p: unknown): string {
    return typeof p === "string" ? p : String((p as { initial?: string }).initial ?? "");
  }


  readonly prompts: string[] = [];
  private readonly script: (readonly Finding[])[];
  constructor(script: (readonly Finding[])[]) {
    this.script = script;
  }
  async review(_tier: unknown, prompt: unknown): Promise<ReviewerResult> {
    this.prompts.push(ScriptedReviewer.text(prompt));
    return {
      findings: this.script.shift() ?? [],
      raw: "",
      inputTokens: 100,
      cachedTokens: 50,
      outputTokens: 10,
      costUsd: 0.001,
      latencyMs: 1,
      discarded: [],
      retried: false,
      steps: 1,
    };
  }
}

/**
 * What a T0 engine reports: the rule id at the head of the claim.
 *
 * That prefix IS the class an appeal settles (`engineRuleClass`), so the shape of this
 * literal is the thing under test as much as the loop around it.
 */
const LOOPBACK: Finding = {
  file: "src/hold.ts",
  line: 3,
  symbol: "capture",
  severity: "medium",
  claim: "avoid-bind-all: binds 0.0.0.0 rather than an interface",
  evidence: "server.listen(port)",
  failureScenario: "the process is reachable from outside the host",
};

/** A T0 finding with no rule class — a failing script, which nothing may appeal past. */
const SUITE_RED: Finding = {
  ...LOOPBACK,
  line: 9,
  claim: "`npm test` fails on this branch",
  evidence: "2 failing",
};

let dir: string;
let store: Store;
let repoId: string;
let ruleId: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A deterministic engine that reports the same thing every round, as they do. */
const t0Reporting = (...findings: readonly Finding[]): Parameters<typeof runRound>[0]["t0"] =>
  (async () => ({ findings, unavailable: [] as readonly string[], outcomes: [] as readonly unknown[], skipped: [] })) as unknown as Parameters<
    typeof runRound
  >[0]["t0"];

/**
 * The file under review. Two functions, because one test needs two findings in it.
 *
 * The comment slot is always emitted — blank when there is nothing to say — so a line
 * number means the same thing whether or not a `lore-ok` is present. A finding whose
 * line does not exist in the file gets no scope, and a verdict with no scope can never
 * carry forward (D-56), which looks exactly like the bug a test is trying to catch.
 */
const source = (comment?: string, second?: string): void =>
  writeFileSync(
    join(dir, "src/hold.ts"),
    [
      "export function capture() {",
      comment === undefined ? "" : `  // ${comment}`,
      "  return 1;",
      "}",
      "",
      "export function probe() {",
      second === undefined ? "" : `  // ${second}`,
      "  return 2;",
      "}",
      "",
    ].join("\n"),
  );

const newReview = (id: string): void =>
  store.createReview({
    id,
    repoId,
    principal: "p",
    branch: "feat/holds",
    intoRef: "main",
    ticket: "Add capture().",
    type: CODE_ARCH.id,
    state: "running",
    ladder: initialState(CODE_ARCH.tiers),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-appeal-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "src.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  git("checkout", "-qb", "feat/holds");
  execFileSync("mkdir", ["-p", join(dir, "src")]);
  source();
  git("add", "-A");
  git("commit", "-qm", "add capture");

  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", dir).id;
  ruleId = store.addKnowledge({
    repoId,
    kind: "policy",
    source: "taught",
    statement: "Services in this repo bind 0.0.0.0; the container's network is the boundary.",
    why: "Every deployment is behind a private overlay, and per-interface binds broke two rollouts.",
    path: undefined,
    cwe: undefined,
    provenance: "taught by vany",
    sourceBlob: undefined,
    confidence: 1,
  }).id;
  newReview("r1");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const TYPE = { ...CODE_ARCH, t0: [] as const };
const cite = (): string => ruleId.slice(0, 8);
const fp = (f: Finding): string => fingerprint(f);

/** Round 1 raises it, the author appeals, round 2 rules on the appeal. */
async function appeal(
  reason: string,
  opts: { readonly finding?: Finding; readonly round2?: readonly Finding[] } = {},
): Promise<void> {
  const f = opts.finding ?? LOOPBACK;
  const t0 = t0Reporting(f);
  const reviewer = new ScriptedReviewer([[], opts.round2 ?? []]);
  await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });
  source(`lore-ok[${fp(f).slice(0, 8)}]: ${reason}`);
  await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });
}

describe("an accepted appeal settles the class for that path", () => {
  it("records a suppression the tier's acceptance bought", async () => {
    await appeal(`rule ${cite()} — this service is behind the overlay`);

    expect(store.liveSuppressions(repoId)).toStrictEqual([
      {
        ruleClass: "avoid-bind-all",
        path: "src/hold.ts",
        policyShort: cite(),
        statement: "Services in this repo bind 0.0.0.0; the container's network is the boundary.",
        acceptedAt: expect.any(String) as unknown as string,
        tier: "t1",
      },
    ]);
  });

  // THE POINT OF THE WHOLE FEATURE. Settling by fingerprint alone means the next edit
  // to the file produces a new fingerprint for the same rule and the identical argument
  // starts again — which is what 63 accepted justifications of one semgrep rule were.
  it("silences the same rule at a later line, in a review that never saw the appeal", async () => {
    await appeal(`rule ${cite()} — this service is behind the overlay`);

    const moved: Finding = { ...LOOPBACK, line: 41, claim: "avoid-bind-all: binds 0.0.0.0 in the retry path" };
    expect(fp(moved)).not.toBe(fp(LOOPBACK));

    newReview("r2");
    const t0 = t0Reporting(moved);
    const result = await runRound({
      store, reviewer: new ScriptedReviewer([[]]), reviewId: "r2", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}),
    });

    expect(store.openFindings("r2")).toStrictEqual([]);
    expect(result.t0Unavailable.join("\n")).toContain("avoid-bind-all was NOT reported at src/hold.ts");
  });

  /**
   * AND THE REVIEWER IS NOT SHOWN THE RULE, which is the same promise the prompt makes.
   *
   * `knowledge_teach` says reviewers are told a project HAS development rules and never
   * what they say, and that a rule's text arrives only with the appeal citing it. The
   * suppression notice went into `t0.unavailable`, which `renderT0` turns into prompt
   * text — so ONE accepted appeal would have injected its rule into every review of that
   * repository, for ever. Precisely the standing injection the design refuses, arriving
   * through the channel built to be honest about gaps.
   */
  it("tells the reviewer a check was silenced without quoting the rule at it", async () => {
    await appeal(`rule ${cite()} — this service is behind the overlay`);

    newReview("r2");
    const reviewer = new ScriptedReviewer([[]]);
    const t0 = t0Reporting(LOOPBACK);
    await runRound({ store, reviewer, reviewId: "r2", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });

    const prompt = reviewer.prompts[0] ?? "";
    expect(prompt, "the tier is told the gap exists").toMatch(/was NOT reported at src\/hold\.ts/);
    expect(prompt, "and NOT what the rule says").not.toContain("the container's network is the boundary");
    // The ID may well appear — the author's own `lore-ok` comment is in the diff, and the
    // reviewer must see the code as written. It is the rule's TEXT that must not be
    // standing in the prompt, because that is what turns one appeal into a permanent
    // injection for every later review.
    // The escape hatch is stated, because a tier is not bound by a suppression an
    // engine's rule bought — and a model finding cannot be silenced by class at all.
    expect(prompt).toMatch(/free to raise the underlying problem yourself/);

    // The CLIENT still gets the whole reason: that channel is the audit trail.
    const skipped = store.unavailableChecks("r2").join("\n");
    expect(skipped).toContain("the container's network is the boundary");
    expect(skipped).toContain(cite());
  });

  // A suppressed check is a check that did not run, and INV-1 governs it exactly as it
  // governs an engine that could not start. Silence here would be the failure this
  // service exists to refuse, dressed as a feature.
  it("says so in checks_skipped, naming the rule that bought it", async () => {
    await appeal(`rule ${cite()} — this service is behind the overlay`);
    newReview("r2");
    const t0 = t0Reporting(LOOPBACK);
    await runRound({
      store, reviewer: new ScriptedReviewer([[]]), reviewId: "r2", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}),
    });

    const skipped = store.unavailableChecks("r2").join("\n");
    expect(skipped).toContain(cite());
    expect(skipped).toContain("the container's network is the boundary");
    expect(skipped).toContain("retire the rule to switch it back on");
  });

  // The rule is what authorises the hole, so the hole closes with it — by a JOIN at
  // read time, not by a sweep somebody has to remember to run.
  it("stops applying the moment the rule is retired", async () => {
    await appeal(`rule ${cite()} — this service is behind the overlay`);
    expect(store.retirePolicy(repoId, cite(), "we moved off the overlay")).toBe("retired");
    expect(store.liveSuppressions(repoId)).toStrictEqual([]);

    newReview("r2");
    const t0 = t0Reporting(LOOPBACK);
    await runRound({
      store, reviewer: new ScriptedReviewer([[]]), reviewId: "r2", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}),
    });
    expect(store.openFindings("r2").map((f) => f.claim)).toStrictEqual([LOOPBACK.claim]);
  });

  /**
   * RETIRING A RULE MUST NOT DISTURB SOMEBODY ELSE'S JUSTIFICATION.
   *
   * The first version of the retire path asked whether the finding's engine rule class
   * and path matched a revoked suppression — which is broader than the claim it was
   * making. An ORDINARY `lore-ok`, citing no rule at all, on a finding that merely shared
   * a class and a file with somebody else's appeal, was blocked from carrying forward and
   * had to be re-argued for a rule it never invoked.
   *
   * The verdict now records what it rests on, so the two cases cannot be confused: an
   * appeal carries `via_rule`, an ordinary reason carries NULL and is untouchable.
   */
  it("leaves an ordinary justification of the same class and file alone", async () => {
    // A second finding, SAME engine rule and SAME file, justified without citing
    // anything. It has to come first: once the appeal is accepted the class is silenced
    // for that file, so nothing of that class is ever recorded there again.
    const probe: Finding = { ...LOOPBACK, line: 8, symbol: "probe", claim: "avoid-bind-all: binds 0.0.0.0 in the probe" };
    const both = t0Reporting(probe, LOOPBACK);
    const reviewer = new ScriptedReviewer([[], [], []]);

    // 1. The ordinary justification, argued on its own words. No rule exists for it.
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(both ? { t0: both } : {}) });
    source(undefined, `lore-ok[${fp(probe).slice(0, 8)}]: the probe is deliberately reachable`);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(both ? { t0: both } : {}) });
    expect(store.settledFingerprints("r1")).toContain(fp(probe));

    // 2. The APPEAL, on the other finding, buying a suppression for the same (class, file).
    source(
      `lore-ok[${fp(LOOPBACK).slice(0, 8)}]: rule ${cite()} — this service is behind the overlay`,
      `lore-ok[${fp(probe).slice(0, 8)}]: the probe is deliberately reachable`,
    );
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(both ? { t0: both } : {}) });
    expect(store.liveSuppressions(repoId)).toHaveLength(1);

    // 3. Withdraw the rule. It never had anything to do with the probe's justification.
    expect(store.retirePolicy(repoId, cite(), "we moved off the overlay")).toBe("retired");

    newReview("r2");
    await runRound({
      store, reviewer: new ScriptedReviewer([[]]), reviewId: "r2", principal: "p", worktree: dir, type: TYPE,
      ...(both ? { t0: both } : {}),
    });
    expect(
      store.settledFingerprints("r2"),
      "an ordinary reason must survive the retirement of a rule it never cited",
    ).toContain(fp(probe));
    // And the appeal's own finding is back open, which is the half that SHOULD change.
    expect(store.openFindings("r2").map((f) => f.fingerprint)).toStrictEqual([fp(LOOPBACK)]);
  });

  // Narrow on purpose. A directory-wide suppression is a wider claim than the one that
  // was argued, applied to files no tier looked at.
  it("does not reach a second file", async () => {
    await appeal(`rule ${cite()} — this service is behind the overlay`);

    newReview("r2");
    const elsewhere: Finding = { ...LOOPBACK, file: "src/other.ts" };
    const t0 = t0Reporting(elsewhere);
    await runRound({
      store, reviewer: new ScriptedReviewer([[]]), reviewId: "r2", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}),
    });
    expect(store.openFindings("r2").map((f) => f.file)).toStrictEqual(["src/other.ts"]);
  });
});

describe("what an appeal may not do", () => {
  // The tier ruled against it. An appeal is a claim to be argued, and losing the
  // argument must leave nothing behind — otherwise citing a rule is worth trying even
  // when it does not apply.
  it("buys nothing when the tier raises the finding again", async () => {
    await appeal(`rule ${cite()} — this service is behind the overlay`, { round2: [LOOPBACK] });
    expect(store.liveSuppressions(repoId)).toStrictEqual([]);
  });

  // Silencing a class of MODEL findings is silencing a kind of thought. A model re-reads
  // and re-decides every round; there is no pattern to switch off, and its claim has no
  // engine rule at its head to switch off by.
  it("buys nothing for a finding a model tier raised", async () => {
    const modelFound: Finding = { ...LOOPBACK, claim: "avoid-bind-all: the model happened to phrase it this way" };
    const reviewer = new ScriptedReviewer([[modelFound], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    source(`lore-ok[${fp(modelFound).slice(0, 8)}]: rule ${cite()} — behind the overlay`);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    expect(store.settledFingerprints("r1")).toContain(fp(modelFound));
    expect(store.liveSuppressions(repoId)).toStrictEqual([]);
  });

  // Nothing appeals its way past a red suite. `tests: ...` has a space before the
  // colon, so it yields no class, so there is nothing to suppress by.
  it("buys nothing for a finding with no engine rule class", async () => {
    await appeal(`rule ${cite()} — behind the overlay`, { finding: SUITE_RED });
    expect(store.settledFingerprints("r1")).toContain(fp(SUITE_RED));
    expect(store.liveSuppressions(repoId)).toStrictEqual([]);
  });

  /**
   * AND IT SAYS SO WHERE THE AUTHOR CAN READ IT.
   *
   * Accepted, the fingerprint settles either way — so without this the author is told
   * their argument won, and believes it settled the class, while the same check goes on
   * raising it. That is a worse outcome than the finding, because it is a false belief
   * about what was decided.
   *
   * `checks_skipped`, not the log. The first version wrote it to stderr — the channel
   * defect this same branch fixed for the oversize notice, where "written to a log no
   * client can read" WAS the bug, reintroduced two files away within a day.
   */
  it("tells the client, in checks_skipped, when an appeal bought no suppression", async () => {
    await appeal(`rule ${cite()} — behind the overlay`, { finding: SUITE_RED });
    const skipped = store.unavailableChecks("r1").join("\n");
    expect(skipped, "the author must not be left thinking the class was settled").toContain(
      "settled THIS finding only",
    );
    expect(skipped).toContain(cite());
    expect(skipped).toMatch(/names no engine rule/);
  });

  // A model finding is a different sentence: its judgement is never suppressed by class,
  // and it may simply not be raised again — so the notice must not promise it will be.
  it("says the accurate thing for a model-raised finding", async () => {
    const modelFound: Finding = { ...LOOPBACK, claim: "avoid-bind-all: the model phrased it this way" };
    const reviewer = new ScriptedReviewer([[modelFound], []]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });
    source(`lore-ok[${fp(modelFound).slice(0, 8)}]: rule ${cite()} — behind the overlay`);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const skipped = store.unavailableChecks("r1").join("\n");
    expect(skipped).toContain("a model raised it");
    expect(skipped, "it may never come back; do not claim it will").toMatch(/may or may not be raised again/);
  });

  // An id that resolves to nothing must not be able to switch a check off, and the tier
  // must be TOLD its central claim is unsupported rather than left to wonder why the
  // reason reads oddly.
  it("buys nothing when the cited rule does not resolve, and says so to the tier", async () => {
    const reviewer = new ScriptedReviewer([[], []]);
    const t0 = t0Reporting(LOOPBACK);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });
    source(`lore-ok[${fp(LOOPBACK).slice(0, 8)}]: rule deadbeef — behind the overlay`);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });

    expect(store.liveSuppressions(repoId)).toStrictEqual([]);
    expect(reviewer.prompts[1]).toContain("WHICH DOES NOT RESOLVE");
  });

  // Two rules sharing a prefix: `policyByShort` refuses rather than picking one, so the
  // appeal is judged as unsupported. Silently applying the wrong rule's authority is
  // worse than making the author type four more characters.
  it("refuses an ambiguous citation rather than choosing a rule", () => {
    store.addKnowledge({
      repoId, kind: "policy", source: "taught", statement: "second rule", why: "w",
      path: undefined, cwe: undefined, provenance: "taught by vany", sourceBlob: undefined, confidence: 1,
      id: `${cite()}-collision-0000-0000-000000000000`,
    });
    expect(store.policyByShort(repoId, cite())).toBeUndefined();
    expect(store.retirePolicy(repoId, cite(), "x")).toBe("ambiguous");
  });
});

describe("the reviewer's side of an appeal", () => {
  it("is told the rules exist and how many, but never their text", async () => {
    const reviewer = new ScriptedReviewer([[]]);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE });

    const prompt = reviewer.prompts[0] ?? "";
    expect(prompt).toContain("THIS PROJECT HAS 1 DEVELOPMENT RULE(S)");
    // The cost this avoids is the reason it works this way: up to sixty rules already
    // go into every prompt, and a policy nobody cited helps no reviewer.
    expect(prompt).not.toContain("the container's network is the boundary");
  });

  it("gets the rule's full text the moment an appeal cites it", async () => {
    const reviewer = new ScriptedReviewer([[], []]);
    const t0 = t0Reporting(LOOPBACK);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });
    source(`lore-ok[${fp(LOOPBACK).slice(0, 8)}]: rule ${cite()} — this service is behind the overlay`);
    await runRound({ store, reviewer, reviewId: "r1", principal: "p", worktree: dir, type: TYPE, ...(t0 ? { t0 } : {}) });

    const prompt = reviewer.prompts[1] ?? "";
    expect(prompt).toContain("the container's network is the boundary");
    expect(prompt).toContain("per-interface binds broke two rollouts");
    // The instruction, not just the text: silence is assent here as everywhere, and a
    // tier that does not know that cannot rule.
    expect(prompt).toContain("Accept by not raising it again");
  });
});

/**
 * WHAT `review_submit` PROMISES A CLIENT ABOUT ITS NEXT ROUND.
 *
 * `will_not_settle` is the only warning that saves a client a deep-tier round: it says,
 * the instant a patch applies, which open findings the next round cannot possibly settle
 * — because D-56 requires the named code to have MOVED, and silence over untouched code
 * is a tier changing its mind rather than being satisfied.
 *
 * Its advice is *"say so at the named line with a lore-ok and submit again"*. It gave
 * that advice about a finding whose named line carried one, sent in that very diff,
 * because it only ever asked whether the code had moved. A warning that fires on the
 * correct answer is a warning clients learn to skip — and this one has no second chance,
 * since ignoring it costs exactly the round it exists to save.
 *
 * Tested through `alreadyAnswered`, which is the predicate the preview and the round now
 * share, so the two cannot drift into disagreeing about what counts as answered.
 */
describe("a finding answered at its named line is not still nagged about", () => {
  const recorded = (f: Finding, fingerprint: string): RecordedFinding => ({
    ...f,
    fingerprint,
    origin: "t0",
    round: 1,
    firstSeen: new Date().toISOString(),
    preexisting: false,
  });

  it("counts a lore-ok in the finding's own file", async () => {
    const f = recorded(LOOPBACK, fp(LOOPBACK));
    const resolve = (_r: string, short: string) => (fp(LOOPBACK).startsWith(short) ? fp(LOOPBACK) : undefined);

    expect(await alreadyAnswered(dir, "r1", resolve, f), "no marker yet").toBe(false);
    source(`lore-ok[${fp(LOOPBACK).slice(0, 8)}]: the probe is deliberately reachable`);
    expect(await alreadyAnswered(dir, "r1", resolve, f)).toBe(true);
  });

  // D-57: a finding in a file with no comment syntax has nowhere else to put its reason,
  // so missing the ledger would reintroduce the nag for exactly the files that cannot
  // avoid it.
  it("counts a lore-ok in the repo-level ledger", async () => {
    const inJson: Finding = { ...LOOPBACK, file: "deploy/tiers.json" };
    const f = recorded(inJson, fp(inJson));
    const resolve = (_r: string, short: string) => (fp(inJson).startsWith(short) ? fp(inJson) : undefined);

    expect(await alreadyAnswered(dir, "r1", resolve, f)).toBe(false);
    writeFileSync(join(dir, ".lore-ok.md"), `<!-- lore-ok[${fp(inJson).slice(0, 8)}]: the schema is strict -->\n`);
    expect(await alreadyAnswered(dir, "r1", resolve, f)).toBe(true);
  });

  // Somebody else's marker in the same file is not an answer to this finding.
  it("does not count a marker that resolves to a different finding", async () => {
    const f = recorded(LOOPBACK, fp(LOOPBACK));
    source("lore-ok[deadbeef]: about something else entirely");
    expect(await alreadyAnswered(dir, "r1", () => "some-other-fingerprint", f)).toBe(false);
  });
});

/**
 * The submit-time preview must never be able to break the submit it previews.
 *
 * `will_not_settle` runs AFTER the patch is applied, the review is queued and the job is
 * enqueued. `resolveShort` throws on an ambiguous 8-hex prefix, so a throw there reported
 * a FAILED submit for a mutation that had already committed — and a client doing the
 * obvious thing resends it.
 *
 * And it reads the same files the round does. The round scans every changed file, so a
 * `lore-ok` written where the fix was made — which the preview's own advice calls "often
 * the right place" — settled in the round while the preview went on naming the finding.
 */
describe("the submit-time preview", () => {
  const recorded = (f: Finding): RecordedFinding => ({
    ...f, fingerprint: fp(f), origin: "t0", round: 1, firstSeen: new Date().toISOString(), preexisting: false,
  });

  it("sees a lore-ok written in another file the diff touched", async () => {
    const f = recorded(LOOPBACK);
    const resolve = (_r: string, short: string) => (fp(LOOPBACK).startsWith(short) ? fp(LOOPBACK) : undefined);
    writeFileSync(join(dir, "src/other.ts"), `// lore-ok[${fp(LOOPBACK).slice(0, 8)}]: fixed at the cause here\n`);

    expect(await alreadyAnswered(dir, "r1", resolve, f), "not scanned without the diff's files").toBe(false);
    expect(await alreadyAnswered(dir, "r1", resolve, f, ["src/other.ts"])).toBe(true);
  });

  it("takes the post-image names out of a diff, and not /dev/null", () => {
    const diff = [
      "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@",
      "--- a/src/gone.ts", "+++ /dev/null",
      "--- /dev/null", "+++ b/src/new.ts",
    ].join("\n");
    expect(filesInDiff(diff)).toStrictEqual(["src/a.ts", "src/new.ts"]);
  });
});
