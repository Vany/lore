import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import type { ReviewState } from "../core/review-state.ts";
import { Store } from "../store/store.ts";
import { withInstallLock } from "../t0/runner.ts";
import { DEFAULT_RETENTION, collect, expireStale, type RetentionConfig } from "./retention.ts";

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

  /**
   * FINDINGS DIM BEFORE THEY DIE (D-106). Vany: *"happens after ready STALE_HOURS,
   * lasts a week, and the same as ready, but gray."* 48 hours bright, seven days gray,
   * then gone — and the week counts from the DIMMING, whose write restarts the clock.
   */
  describe("findings_ready dims instead of dying", () => {
    it("turns gray at the cutoff rather than expiring", () => {
      review("r1", "findings_ready", 3);
      expect(expireStale(store, cfg), "graying is not an expiry").toBe(0);
      expect(store.getReview("r1", "p")?.state).toBe("findings_stale");
    });

    it("leaves bright findings bright before the cutoff", () => {
      review("r1", "findings_ready", 1);
      expect(expireStale(store, cfg)).toBe(0);
      expect(store.getReview("r1", "p")?.state).toBe("findings_ready");
    });

    it("keeps a gray review alive inside its week", () => {
      review("r1", "findings_stale", 5);
      expect(expireStale(store, cfg)).toBe(0);
      expect(store.getReview("r1", "p")?.state).toBe("findings_stale");
    });

    it("expires a gray review after its week is spent", () => {
      review("r1", "findings_stale", 8);
      expect(expireStale(store, cfg)).toBe(1);
      expect(store.getReview("r1", "p")?.state).toBe("expired");
    });

    // The full life, end to end: bright, gray, gone — with the week counted from the
    // graying, not from the last answer.
    it("lives 48 hours bright and seven days gray", () => {
      review("r1", "findings_ready", 3);
      expireStale(store, cfg);
      expect(store.getReview("r1", "p")?.state).toBe("findings_stale");

      // Six days after the graying: still answerable.
      const grayedAt = store.getReview("r1", "p")?.updatedAt ?? "";
      store.db
        .prepare("UPDATE review SET updated_at = ? WHERE id = 'r1'")
        .run(new Date(Date.parse(grayedAt) - 6 * 86_400_000).toISOString());
      expect(expireStale(store, cfg)).toBe(0);

      // Past the week: gone, and gone as `expired` — nobody came back.
      store.db
        .prepare("UPDATE review SET updated_at = ? WHERE id = 'r1'")
        .run(new Date(Date.parse(grayedAt) - 8 * 86_400_000).toISOString());
      expect(expireStale(store, cfg)).toBe(1);
      expect(store.getReview("r1", "p")?.state).toBe("expired");
    });
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

  // git cannot collect a record whose directory it can no longer reach — a crash
  // between creating and recording, an operator clearing space, or a data directory
  // that moved. Twelve such records were found on the deployment, naming a path from
  // a previous layout, that nothing had ever collected because nothing ever pruned.
  it("collects git records whose directory vanished behind its back", async () => {
    const dir = reviewWithWorktree("revGone", "findings_ready");
    rmSync(dir, { recursive: true, force: true }); // as if something removed it by hand
    expect(git("-C", bare(), "worktree", "list")).toContain("revGone");

    await collect(store, { ...DEFAULT_RETENTION, reposRoot: join(root, "repos") });

    expect(git("-C", bare(), "worktree", "list")).not.toContain("revGone");
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

// THE ONE DISK FACT THAT IS OURS, and nothing was collecting it.
//
// The npm cache is keyed by lockfile hash, so every distinct lockfile leaves a
// directory for ever; scratch gets one per review and the review goes away. Measured
// 2026-08-07: 5.7 GB of cache and 1.1 GB of scratch, against 4.4 GB recorded a day
// earlier — a curve with no ceiling, in the data directory that also holds the
// knowledge base. The host-disk alerts were removed (a full disk belongs to whoever
// owns the machine); this is the part that is ours to answer for.
describe("the sandbox cache does not grow for ever", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lore-cache-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const dirAged = (parent: string, name: string, ageDays: number) => {
    const p = join(parent, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "blob"), "x".repeat(1024));
    const at = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(p, at, at);
    return p;
  };

  const sweep = (over: Partial<RetentionConfig> = {}) =>
    collect(store, {
      ...DEFAULT_RETENTION,
      reposRoot: join(root, "repos"),
      cacheRoot: join(root, "npm-cache"),
      scratchRoot: join(root, "scratch"),
      ...over,
    });

  it("collects a cache nothing has touched, and says how much it freed", async () => {
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const old = dirAged(join(root, "npm-cache"), "lockfile-aaa", 30);

    const r = await sweep();
    expect(r.cacheDirsRemoved).toBe(1);
    expect(r.cacheBytesFreed).toBeGreaterThan(0);
    expect(existsSync(old)).toBe(false);
  });

  // The cache exists to make an install cheap. Collecting a warm one would turn every
  // review into a cold install, which is the cost this directory is paying to avoid.
  it("leaves a cache that is still being used", async () => {
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const warm = dirAged(join(root, "npm-cache"), "lockfile-bbb", 1);

    expect((await sweep()).cacheDirsRemoved).toBe(0);
    expect(existsSync(warm)).toBe(true);
  });

  // ffbda1f7, found by lore's own review: the sweep called `rm` with no reference
  // to `withInstallLock`'s own map at all — a directory old ENOUGH by mtime (a
  // long cold install, or a burst of reviews queued behind one, can leave it
  // mid-use for minutes) could be deleted while tsc/eslint were reading it, the
  // exact "half-written node_modules" false-finding failure runner.ts's own
  // comment already documents once, reopened one caller over.
  it("never deletes a cache directory an install is using right now, however old its mtime", async () => {
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const busy = dirAged(join(root, "npm-cache"), "lockfile-ccc", 30);

    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const installing = withInstallLock(busy, () => held);

    try {
      expect((await sweep()).cacheDirsRemoved, "must not delete a directory mid-install").toBe(0);
      expect(existsSync(busy)).toBe(true);
    } finally {
      release();
      await installing;
    }
  });

  it("collects abandoned scratch as well as cache", async () => {
    mkdirSync(join(root, "scratch"), { recursive: true });
    dirAged(join(root, "scratch"), "rev_gone", 30);
    expect((await sweep()).cacheDirsRemoved).toBe(1);
  });

  // A deployment that does not mount these has nothing to collect, and inventing the
  // directories to sweep them would be the sweep creating what it cleans up.
  it("does nothing when the deployment has no sandbox roots", async () => {
    const r = await collect(store, { ...DEFAULT_RETENTION, reposRoot: join(root, "repos"), cacheRoot: undefined, scratchRoot: undefined });
    expect(r.cacheDirsRemoved).toBe(0);
    expect(r.cacheBytesFreed).toBe(0);
  });
});
