import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import type { ReviewState } from "../core/review-state.ts";
import { Store } from "../store/store.ts";
import { DEFAULT_RETENTION, collect, expireStale } from "./retention.ts";

let store: Store;
let repoId: string;

const cfg = { ...DEFAULT_RETENTION, reposRoot: "/tmp/lore-test-repos" };

function review(id: string, state: string, updatedDaysAgo: number): void {
  store.createReview({
    id, repoId, principal: "p", branch: `b-${id}`, intoRef: "main",
    ticket: "t", type: "code-arch", state: "running", ladder: initialState(),
  });
  const when = new Date(Date.now() - updatedDaysAgo * 86_400_000).toISOString();
  store.db.prepare("UPDATE review SET state = ?, updated_at = ? WHERE id = ?").run(state, when, id);
}

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("demo", "git@x:demo.git").id;
});

describe("expireStale", () => {
  // A review the developer walked away from told us nothing about the code, and
  // `expired` must not read as though it did.
  it("expires an untouched unfinished review", () => {
    review("r1", "awaiting_diff", 5);
    expect(expireStale(store, cfg)).toBe(1);
    expect(store.getReview("r1", "p")?.state).toBe("expired");
  });

  it("leaves a recent one alone", () => {
    review("r1", "awaiting_diff", 0);
    expect(expireStale(store, cfg)).toBe(0);
  });

  it("never reopens or re-expires a finished review", () => {
    review("r1", "passed", 30);
    expect(expireStale(store, cfg)).toBe(0);
    expect(store.getReview("r1", "p")?.state).toBe("passed");
  });
});

describe("collect", () => {
  it("deletes review rows past the retention window", async () => {
    review("old", "passed", 200);
    review("recent", "passed", 1);

    const r = await collect(store, cfg);
    expect(r.reviewsDeleted).toBe(1);
    expect(store.getReview("old", "p")).toBeUndefined();
    expect(store.getReview("recent", "p")).toBeDefined();
  });

  it("cascades findings and verdicts with the review they belong to", async () => {
    review("old", "passed", 200);
    store.recordFinding("old", {
      fingerprint: "aaaa1111", file: "a.ts", severity: "low", claim: "c",
      evidence: "e", failureScenario: "s", origin: "t1", round: 1,
      firstSeen: "2026-01-01T00:00:00.000Z",
    });
    store.recordVerdict("old", { fingerprint: "aaaa1111", verdict: "fixed", rationale: undefined, scope: undefined, tier: "t1", round: 1 });

    await collect(store, cfg);
    const left = store.db.prepare("SELECT COUNT(*) AS c FROM finding").get() as Record<string, number | bigint>;
    expect(Number(left["c"])).toBe(0);
  });

  // The asymmetry that matters: a deleted review costs one re-run, deleted
  // knowledge costs everything the workgroup ever taught the service.
  it("never touches knowledge, even when its review is deleted", async () => {
    review("old", "passed", 200);
    store.addKnowledge({
      repoId, kind: "rule", source: "derived", statement: "amounts are integers",
      why: "float money", path: undefined, cwe: undefined, provenance: "old",
      sourceBlob: undefined, confidence: 0.7,
    });

    await collect(store, cfg);
    expect(store.getReview("old", "p")).toBeUndefined();
    expect(store.knowledgeFor(repoId)).toHaveLength(1);
  });

  it("survives a worktree directory that is already gone", async () => {
    review("old", "passed", 30);
    // A missing directory is the desired state; failing over one would leave every
    // later one uncollected.
    await expect(collect(store, cfg)).resolves.toBeDefined();
  });
});

// D-70. A terminal review's worktree serves nothing — its tree hash is recorded,
// attestation reads only the store, and review_submit refuses a finished review. They
// were held for seven days, so on 2026-08-05 sixteen finished reviews were still
// holding worktrees, the oldest for two days, on a disk at 88%.
describe("a finished review gives its worktree back", () => {
  let root: string;
  let store: Store;
  let repoId: string;

  const bare = () => join(root, "repos", repoId, "bare.git");
  const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lore-retain-"));
    store = new Store(":memory:");

    // A real repository with a real worktree, because the thing under test is what
    // git is left holding — which a mocked filesystem cannot show.
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    git("init", "-q", "-b", "main", src);
    git("-C", src, "config", "user.email", "t@e.com");
    git("-C", src, "config", "user.name", "t");
    writeFileSync(join(src, "a.txt"), "a\n");
    git("-C", src, "add", "-A");
    git("-C", src, "commit", "-qm", "x");

    repoId = store.upsertRepo("demo", src).id;
    mkdirSync(join(root, "repos", repoId), { recursive: true });
    git("clone", "--bare", "-q", src, bare());
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const reviewWithWorktree = (id: string, state: ReviewState) => {
    const dir = join(root, "repos", repoId, "wt", id);
    git("-C", bare(), "worktree", "add", "--detach", "-q", dir, "main");
    store.createReview({
      id, repoId, principal: "p", branch: "main", intoRef: "main",
      ticket: "t", type: "code-arch", state, ladder: initialState(),
    });
    return dir;
  };

  it("releases git's bookkeeping, not just the directory", async () => {
    const dir = reviewWithWorktree("revT", "passed");
    expect(git("-C", bare(), "worktree", "list")).toContain("revT");

    await collect(store, { ...DEFAULT_RETENTION, reposRoot: join(root, "repos") });

    expect(existsSync(dir)).toBe(false);
    // The half a bare `rm` leaves behind: git goes on listing a worktree that is not
    // there, and bare.git/worktrees/<id> accumulates for ever.
    expect(git("-C", bare(), "worktree", "list")).not.toContain("revT");
    expect(existsSync(join(bare(), "worktrees", "revT"))).toBe(false);
  });

  // It was omitted from the hand-written list in all three queries, so a partial pass
  // held its worktree for ever and its row was never collected.
  it("treats passed_partial as finished, like every other terminal state", async () => {
    const dir = reviewWithWorktree("revPP", "passed_partial");
    await collect(store, { ...DEFAULT_RETENTION, reposRoot: join(root, "repos") });
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves a review that can still be worked on alone", async () => {
    const dir = reviewWithWorktree("revLive", "findings_ready");
    await collect(store, { ...DEFAULT_RETENTION, reposRoot: join(root, "repos") });
    expect(existsSync(dir)).toBe(true);
  });
});

// A verdict destroyed by a sweep. `expireStale` listed the terminal states by hand
// and left out passed_partial, so a review that legitimately reached a partial pass
// would be overwritten with `expired` 48 hours later.
describe("expiry never overwrites a verdict", () => {
  it("does not expire a passed_partial review", () => {
    const store = new Store(":memory:");
    const repoId = store.upsertRepo("r", "git@x:r.git").id;
    store.createReview({
      id: "revPP2", repoId, principal: "p", branch: "b", intoRef: "main",
      ticket: "t", type: "code-arch", state: "passed_partial", ladder: initialState(),
    });
    store.db.prepare("UPDATE review SET updated_at = ? WHERE id = 'revPP2'")
      .run(new Date(Date.now() - 100 * 3_600_000).toISOString());

    expireStale(store, DEFAULT_RETENTION);

    expect(store.getReview("revPP2", "p")?.state).toBe("passed_partial");
    store.close();
  });
});
