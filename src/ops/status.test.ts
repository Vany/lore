/**
 * The mirror-staleness warning, which is the only thing that notices a dead
 * refresher.
 *
 * lore does not fetch (D-65). A host timer does, outside the container, as the
 * operator — the right place, with one weakness: nothing in lore knows whether it is
 * still alive. A stopped LaunchAgent looks exactly like a healthy one right up until
 * a review is refused, and on 2026-08-05 a mirror nobody refreshed failed more
 * reviews than every model and transport fault combined.
 *
 * So this is the safety net for the whole arrangement, and it gets a test. It had
 * none until the module was made importable: `status.ts` opened a database and wrote
 * to stdout at import time, so nothing could load it.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { REVIEW_STATES } from "../core/review-state.ts";
import { MAX_MIRROR_AGE_MS } from "../git/repo.ts";
import { Store } from "../store/store.ts";
import { renderStatus } from "./status.ts";

let dir: string;
let store: Store;

const mirrorAged = (repoId: string, ms: number) => {
  const bare = join(dir, "repos", repoId, "bare.git");
  mkdirSync(bare, { recursive: true });
  const head = join(bare, "FETCH_HEAD");
  writeFileSync(head, "");
  const at = new Date(Date.now() - ms);
  utimesSync(head, at, at);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-status-"));
  store = new Store(join(dir, "lore.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const render = (reviewId?: string) => {
  const db = new DatabaseSync(join(dir, "lore.db"), { readOnly: true });
  try {
    return renderStatus(db, reviewId, dir);
  } finally {
    db.close();
  }
};

// D-68 ranks inherited pattern matches below the branch's own for the CLIENT, on the
// reasoning that a reader triaging by severity should not answer test-fixture noise
// first. The operator view inherited raw severity and said `3 finding(s), 2 high` for
// a review whose only branch-caused finding was the `low` — the two highs were the
// semgrep CWE-319 hit on fixtures the branch never touches, justified here repeatedly.
// An alarm that fires on the same known noise every day is one that gets ignored.
describe("uncollected findings distinguish the branch's own from inherited ones", () => {
  const withFindings = (branch: string, fs: { severity: string; preexisting: number }[]) => {
    const repoId = store.upsertRepo("demo", `git@example.com:o/${branch}.git`).id;
    const id = `rev_${branch.replace(/\W/g, "")}`;
    store.createReview({
      id, repoId, principal: "p", branch, intoRef: "main",
      ticket: "t", type: "code-arch", state: "findings_ready", ladder: initialState(),
    });
    fs.forEach((f, i) => {
      store.recordFinding(id, {
        fingerprint: `${branch}${i}`.padEnd(12, "0"), file: "a.ts", line: 1, symbol: "s",
        severity: f.severity as "high" | "medium" | "low", claim: `c${i}`, evidence: "e",
        failureScenario: "s", origin: "t0", round: 1, firstSeen: new Date().toISOString(),
        preexisting: f.preexisting === 1,
      });
    });
  };

  it("does not count an inherited high as the branch's own", () => {
    withFindings("feat/x", [
      { severity: "high", preexisting: 1 },
      { severity: "high", preexisting: 1 },
      { severity: "low", preexisting: 0 },
    ]);
    const out = render();
    expect(out).toContain("2 high preexisting");
    // The alarming form must NOT appear: this branch caused no high finding.
    expect(out).not.toMatch(/3 finding\(s\), 2 high(?! preexisting)/);
  });

  it("still shouts when the branch really did cause a high finding", () => {
    withFindings("feat/y", [
      { severity: "high", preexisting: 0 },
      { severity: "high", preexisting: 1 },
    ]);
    const out = render();
    expect(out).toContain("1 high");
    expect(out).toContain("1 high preexisting");
  });
});

describe("what the operator is told about the mirrors", () => {
  it("marks a mirror past the review threshold, not merely old-ish", () => {
    const fresh = store.upsertRepo("fresh-repo", "git@example.com:o/a.git").id;
    const stale = store.upsertRepo("stale-repo", "git@example.com:o/b.git").id;
    mirrorAged(fresh, MAX_MIRROR_AGE_MS / 2);
    mirrorAged(stale, MAX_MIRROR_AGE_MS * 3);

    const out = render();

    // The threshold is MAX_MIRROR_AGE_MS itself, not a second number beside it: a
    // warning that fires at a different age than the refusal is a warning that
    // eventually disagrees with the thing it is warning about.
    expect(out).toMatch(/✓ \d+m ago\s+fresh-repo/);
    expect(out).toMatch(/✗ \d+m ago\s+stale-repo/);
    // Said in terms of the consequence, because "stale" alone is not actionable.
    expect(out).toContain("a review started now would be refused");
  });

  // Never fetched is WORSE than stale, not milder: refs/remotes/origin/* does not
  // exist, so a base cut from it takes the frozen clone-time commit.
  it("distinguishes never fetched from stale", () => {
    store.upsertRepo("never-repo", "git@example.com:o/c.git");
    expect(render()).toMatch(/✗ never fetched\s+never-repo/);
  });

  // "Nothing is happening" and "nothing CAN happen" look identical otherwise, and
  // the idle path is exactly when a dead refresher goes unnoticed the longest.
  it("reports mirrors even when there is nothing to review", () => {
    const id = store.upsertRepo("idle-repo", "git@example.com:o/d.git").id;
    mirrorAged(id, MAX_MIRROR_AGE_MS * 4);

    const out = render();
    expect(out).toContain("idle");
    expect(out).toMatch(/✗ \d+m ago\s+idle-repo/);
  });

  it("says nothing about mirrors when no repository is registered", () => {
    expect(render()).not.toContain("mirrors");
  });
});

// Eighteen findings sat unread across four reviews on 2026-08-05, fourteen of them
// `high`. The review reached findings_ready, nothing polled it again, and nothing
// said so — `delivered_at` had recorded it per finding the whole time.
describe("findings nobody has collected", () => {
  const withFinding = (severity: "high" | "low", fingerprint: string) => {
    store.createReview({
      id: "revU", repoId: store.upsertRepo("r", "git@x:r.git").id, principal: "alice",
      branch: "feat/unread", intoRef: "main", ticket: "t", type: "code-arch",
      state: "findings_ready", ladder: initialState(),
    });
    store.recordFinding("revU", {
      fingerprint, file: "a.ts", line: 1, symbol: undefined, severity,
      claim: "something is wrong", evidence: "e", failureScenario: "f",
      cwe: undefined, origin: "t1", round: 1, firstSeen: new Date().toISOString(),
    });
  };

  it("names them, counts the high ones, and says how long they have waited", () => {
    withFinding("high", "f".repeat(64));
    const out = render();
    expect(out).toContain("waiting to be collected");
    expect(out).toMatch(/1 finding\(s\), 1 high\s+feat\/unread/);
    expect(out).toContain("unread since");
    // The consequence, not just the count — this is why it is worth a line.
    expect(out).toContain("a review that did not run, later");
  });

  it("says nothing when everything has been collected", () => {
    withFinding("low", "e".repeat(64));
    store.markDelivered("revU", ["e".repeat(64)]);
    expect(render()).not.toContain("waiting to be collected");
  });

  // 038955e5, found by lore's own review: this query had no review-state filter at
  // all, unlike uncollectedHighOlderThan (the heartbeat ticket for this same fact),
  // which excludes cancelled and expired. An expired review's findings are
  // PERMANENTLY uncollectible — a terminal review refuses a submit — and already
  // had days of escalating signal before the sweep ended it; without the filter
  // they sat here for the full 90-day retention window, painted as something an
  // operator should chase.
  it("stays quiet about an expired review's findings — permanently uncollectible, already escalated", () => {
    withFinding("high", "d".repeat(64));
    store.updateReview("revU", { state: "expired" });
    expect(render()).not.toContain("waiting to be collected");
  });

  it("stays quiet about a cancelled review's findings too — handed over at the cancel itself", () => {
    withFinding("high", "c".repeat(64));
    store.updateReview("revU", { state: "cancelled" });
    expect(render()).not.toContain("waiting to be collected");
  });

  // 56141f57, found by lore's own review: the `reviews` query above excludes a
  // review older than a day UNLESS it is non-terminal — but `failed` is
  // deliberately NOT excluded from `uncollectedLines` (038955e5's own note:
  // "failed has neither of THEIR reasons to be excluded", no warning, no handover,
  // so its findings can sit undelivered indefinitely). A review that failed two
  // days ago holding a HIGH finding made `reviews` empty, and the idle early
  // return skipped this whole section — "lore is idle" while a real, undelivered
  // HIGH finding sat unmentioned. The exact false all-clear this project refuses
  // everywhere else.
  it("still names an old FAILED review's undelivered finding while otherwise idle", () => {
    withFinding("high", "a".repeat(64));
    store.updateReview("revU", { state: "failed" });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = ?").run(twoDaysAgo, "revU");

    const out = render();
    expect(out, "must still say the service is idle").toContain("lore` is idle");
    expect(out, "must not hide the uncollected finding behind the idle message").toContain(
      "waiting to be collected",
    );
    expect(out).toMatch(/1 finding\(s\), 1 high\s+feat\/unread/);
  });
});

/**
 * 36006b58, found by lore's own review: `updated_at` is written as
 * `new Date().toISOString()` (a `T` separator), but the old query compared it
 * against SQLite's `datetime('now','-1 day')` (a space separator) as plain TEXT.
 * `'T' > ' '` in ASCII regardless of the times either side of it, so a review whose
 * DATE happened to match the cutoff's date read as "recent" however old it actually
 * was within that window — verified directly with a standalone script: a review
 * updated 28 real hours ago was included.
 *
 * REAL, UNMOCKED TIME, deliberately: `datetime('now', ...)` is evaluated inside
 * `node:sqlite`'s native engine, which reads the OS clock directly and is provably
 * unreachable by `vi.setSystemTime()` (checked directly — SQLite kept answering the
 * real date while `Date.now()` was pinned to 2020). The fixed code no longer calls
 * SQLite's clock at all, but a test built to fail against the OLD code has to trigger
 * the OLD code's actual comparison, which means using the OS clock it actually read.
 * One minute before the cutoff shares the cutoff's calendar date on all but the
 * rare run that starts in the sixty seconds after UTC midnight.
 */
describe("the 24-hour review window survives the text-vs-space quirk in SQLite's own dates", () => {
  it("excludes a terminal review over a day old even when its calendar date matches the cutoff's", () => {
    const repo = store.upsertRepo("demo", "git@x:demo.git");
    store.createReview({
      id: "revOld", repoId: repo.id, principal: "p", branch: "b", intoRef: "main",
      ticket: "t", type: "code-arch", state: "passed", ladder: initialState(),
    });
    // Genuinely over a day old (24h + 1min), so it must be excluded — but its
    // calendar date, on all but the rarest run, still matches the cutoff's, which is
    // exactly the shape the text comparison got wrong.
    const justOverADayAgo = new Date(Date.now() - (24 * 3_600_000 + 60_000)).toISOString();
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = ?").run(justOverADayAgo, "revOld");

    expect(render(), "a review just over a day old must not read as within the last day").toContain(
      "lore` is idle",
    );
  });
});

// 1eaf7dc6, found by lore's own review: a specific reviewId that matched nothing
// (a typo, or a row aged out past the retention window) fell into the SAME
// `reviews.length === 0` branch as "nothing is running at all", so an operator
// asking about one review was told the whole service was idle — including sections
// about mirrors and uncollected findings that answer a question nobody asked.
describe("a review id that matches nothing is not the same fact as an idle service", () => {
  it("says the id was not found, not that lore is idle", () => {
    const repo = store.upsertRepo("demo", "git@x:demo.git");
    // A DIFFERENT review is actively running, so a correct "idle" reading is
    // impossible here — proving this path is reached because of the id, not
    // because the service genuinely has nothing going on.
    store.createReview({
      id: "revRunning", repoId: repo.id, principal: "p", branch: "b", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });

    const out = render("rev_TYPO");
    expect(out, "must not claim the service is idle").not.toContain("is idle");
    expect(out, "must say the id was not found").toContain("rev_TYPO");
  });
});

// 3468ba9e, found by lore's own review: `tierDownLines`'s D-90 banner used to run
// only AFTER the idle early-return, so a stated provider cool-off in force — it can
// outlive every review that triggered it, days per `runRound`'s own words — was
// invisible on a service with no open reviews, exactly when an operator checking
// "is anything wrong before I start work?" would see only "lore is idle".
describe("a stated provider cool-off survives an otherwise-idle service", () => {
  it("shows the cool-off banner alongside the idle message, not hidden behind it", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    store.markTierUnavailable("t1", until, "the provider said its limit resets then", 1, true);

    const out = render();
    expect(out, "must still say the service is idle").toContain("lore` is idle");
    expect(out, "must not hide the cool-off behind the idle message").toContain("IS NOT BEING ASKED");
  });
});

// c1b6fc4c, found by lore's own review: `tierDownLines` called `loadPools`/`loadTiers`
// with nothing catching them, and both read LORE_TIERS from disk and THROW on a bad
// path or malformed JSON — reachable the moment any tier-unavailable mark exists,
// which is this function's whole reason to run. `make status` is the one view built
// to explain a service that will not start; it must not be the thing that also
// crashes on the same broken config.
describe("a LORE_TIERS that will not load does not crash the status view", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["LORE_TIERS"];
    process.env["LORE_TIERS"] = "/definitely/does/not/exist/tiers.json";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["LORE_TIERS"];
    else process.env["LORE_TIERS"] = saved;
  });

  it("shows the tier's own mark with a degraded coverage line, instead of throwing", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    store.markTierUnavailable("t1", until, "quota exhausted", 1, true);

    let out = "";
    expect(() => {
      out = render();
    }, "a broken ladder file must not crash the one view built to explain a broken deployment").not.toThrow();
    expect(out, "the tier's own mark must still be shown").toContain("IS NOT BEING ASKED");
    expect(out, "must say why coverage could not be assessed").toContain("LORE_TIERS itself would not load");
  });
});

// 0a47f502, found by lore's own review: the header's own "queued N" was a bare
// `COUNT(*) FROM job WHERE state = 'queued'`, with no join to the review at all —
// while store.queueDepth() (read by /status, the board and the queueBacked ticket)
// joins and excludes a terminal review's jobs, for the exact reason its own comment
// gives: three unclaimable rows, one nineteen hours old, on a service with eleven
// idle workers. `make status`'s header was the one reader left disagreeing.
describe("the header's own queue count agrees with everyone else's", () => {
  it("does not count a queued job whose review has already ended", () => {
    const repo = store.upsertRepo("demo", "git@x:demo.git");
    store.createReview({
      id: "revEnded", repoId: repo.id, principal: "p", branch: "b", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
    store.enqueue("revEnded", "fast");

    // Bypasses `updateReview`'s own `discardQueuedJobs` call on a terminal
    // transition, to build exactly the leaked-row shape `queueDepth()`'s comment
    // describes rather than the ordinary, already-handled path.
    store.db.prepare("UPDATE review SET state = ? WHERE id = ?").run("passed", "revEnded");

    expect(render(), "the job's review already ended; it must not count as backlog").toMatch(/queued 0\s+in flight/);
  });
});

/**
 * "A tier is working" was a label, not a fact, and it cost forty-five minutes.
 *
 * `rev_NYiv0xfO` sat `running` under that sentence for three quarters of an hour on
 * 2026-08-08 while the hang was in the knowledge screen — which spends a model BEFORE
 * `openTierRun` exists, so no tier had been asked anything and none was working. I read
 * the line and reported a hung tier to Vany. The database disagreed one query away: no
 * `tier_run` row for any model tier at all.
 *
 * The operator view is where a stall is diagnosed, so a confident wrong sentence there
 * is worse than none — it does not merely fail to help, it aims the search.
 */
describe("what a running review is actually doing", () => {
  const running = (id: string) => {
    const repo = store.upsertRepo("demo", "git@x:demo.git");
    store.createReview({
      id, repoId: repo.id, principal: "alice", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
    return repo.id;
  };

  // a5b95147, found by lore's own review: the fixture's own id, `rev_screen`, matched
  // the `/ingest|screen/` assertion below regardless of what `phaseNote` actually
  // said — renderStatus prints the review id verbatim, so this passed whether or not
  // the sentence it claimed to pin was present at all. Renamed to `revA`, which
  // contains neither substring, so the assertion can only pass by matching the real
  // note text.
  it("says NO TIER IS WORKING when the round has not reached one", () => {
    running("revA");
    // t0 done, nothing else opened — the exact shape of the four-and-a-half-hour stall.
    const t0 = store.openTierRun("revA", "t0", 1, new Date().toISOString());
    store.closeTierRun(t0, "clean", []);

    const out = render();
    expect(out).toMatch(/NO TIER IS WORKING/);
    expect(out, "and it must say where the round really is").toMatch(
      /between the deterministic sweep and its first tier/,
    );
    expect(out).not.toMatch(/a tier is working/);
  });

  // The ordinary case must be untouched: this is a correction, not a new alarm to
  // learn to ignore.
  it("still says a tier is working when one has an open row", () => {
    running("rev_tier");
    const t0 = store.openTierRun("rev_tier", "t0", 1, new Date().toISOString());
    store.closeTierRun(t0, "clean", []);
    store.openTierRun("rev_tier", "t1", 1, new Date().toISOString());

    const out = render();
    expect(out).toContain("a tier is working");
    expect(out).not.toMatch(/NO TIER IS WORKING/);
  });

  // Before t0 has closed anything there is nothing to be wrong about yet, and calling
  // that "no tier is working" would fire on every review's first seconds.
  it("says it is starting when nothing has run at all", () => {
    running("rev_fresh");
    const out = render();
    expect(out).toMatch(/starting/);
  });
});

/**
 * Fingerprint 68b3e26f, found by lore's own review of the OOM-kill fix: a t0 round
 * an engine was killed in still closed with zero findings, and this board's own
 * `outcome === "clean"` check painted that green — the colour this file's own header
 * comment says means "genuinely clean, and nothing else may borrow it". The tier_run
 * `unavailable` column already held the honest reason; this view just never selected
 * it. `interrupted` is its own outcome now (store.ts), and the reason is inline.
 */
describe("an interrupted t0 engine is never painted as a clean, completed round", () => {
  it("names the outcome and the reason, not a false clean", () => {
    const repo = store.upsertRepo("demo", "git@x:demo.git");
    store.createReview({
      id: "rev_interrupted", repoId: repo.id, principal: "alice", branch: "feat/x", intoRef: "main",
      ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
    });
    const t0 = store.openTierRun("rev_interrupted", "t0", 1, new Date().toISOString());
    store.closeTierRun(t0, "interrupted", [
      "tsc: `npm run typecheck` did not complete (killed, exit 137) — almost always a memory limit, not a fault in the branch.",
    ]);

    const out = render();
    expect(out).toContain("interrupted");
    expect(out, "not the same red marker as a tier that never ran at all").not.toContain("✘ interrupted");
    expect(out).toMatch(/killed, exit 137/);
  });
});

// D-130: a folder review carries no into_ref (the write side stores "" there — see
// store.ts's createReview). Left unguarded, `${into_ref}`.slice(0, 12) would render
// as a bare arrow with nothing after it rather than telling the reader what this
// review is actually scoped to.
describe("a folder review's board line names its path, not a missing into", () => {
  it("shows the folder path instead of an empty into", () => {
    const repo = store.upsertRepo("demo", "git@x:demo.git");
    store.createReview({
      id: "rev_folder",
      repoId: repo.id,
      principal: "alice",
      branch: "feat/x",
      reviewPath: "src/payments",
      ticket: "t",
      type: "code-arch",
      state: "running",
      ladder: initialState(),
    });

    const out = render();
    expect(out).toContain("folder: src/payments");
    expect(out).not.toContain("undefined");
  });

  // The ordinary case stays exactly as it was — this is one new branch, not a
  // rewrite of the line every other review's status depends on.
  it("still shows into for an ordinary diff review", () => {
    const repo = store.upsertRepo("demo", "git@x:demo.git");
    store.createReview({
      id: "rev_diff",
      repoId: repo.id,
      principal: "alice",
      branch: "feat/x",
      intoRef: "main",
      ticket: "t",
      type: "code-arch",
      state: "running",
      ladder: initialState(),
    });

    const out = render();
    expect(out).toContain("main");
    expect(out).not.toContain("folder:");
  });
});

/**
 * Every state the review machine can reach has to have a colour and a sentence.
 *
 * `cancelled` did not, for weeks, so the operator board rendered a deliberate stop as
 * `? unrecognised state` — the one place a person goes to find out what happened,
 * answering that it does not know. Checked against the state list rather than spot-tested,
 * because the next state added will have the same gap and nobody will notice again.
 */
describe("the operator board knows every state", () => {
  it("has a style for each, and none of them reads as unrecognised", () => {
    const store2 = new Store(join(dir, "lore.db"));
    const repo = store2.upsertRepo("demo", "git@x:demo.git");
    REVIEW_STATES.forEach((state, i) => {
      store2.createReview({
        id: `rev_state_${String(i)}`, repoId: repo.id, principal: "alice", branch: "feat/x",
        intoRef: "main", ticket: "t", type: "code-arch", state, ladder: initialState(),
      });
    });
    store2.close();

    const out = render();
    expect(out, "a state the board cannot name is a state a person cannot act on").not.toContain("unrecognised state");
    for (const state of REVIEW_STATES) expect(out).toContain(state.toUpperCase());
  });
});
