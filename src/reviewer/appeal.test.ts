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
import { Store } from "../store/store.ts";
import type { ReviewerLike, ReviewerResult } from "./opencode.ts";
import { runRound } from "./review.ts";

/** A model tier that says exactly what the test scripts, and keeps every prompt it saw. */
class ScriptedReviewer implements ReviewerLike {
  readonly prompts: string[] = [];
  private readonly script: (readonly Finding[])[];
  constructor(script: (readonly Finding[])[]) {
    this.script = script;
  }
  async review(_tier: unknown, prompt: string): Promise<ReviewerResult> {
    this.prompts.push(prompt);
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

const source = (comment?: string): void =>
  writeFileSync(
    join(dir, "src/hold.ts"),
    ["export function capture() {", ...(comment === undefined ? [] : [`  // ${comment}`]), "  return 1;", "}", ""].join("\n"),
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
