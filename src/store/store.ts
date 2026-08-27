/**
 * The store: everything that must survive between invocations.
 *
 * `lore` is stateless per call — Claude Code drives the loop and calls it
 * repeatedly (SPEC §2). A reviewer that forgot between calls would restart at the
 * bottom tier every time and re-raise everything it had already settled, so the
 * loop would never terminate and every round would cost full price. This file is
 * what makes the loop finite.
 *
 * Effectful edge: everything above it (core/) is pure and testable without a
 * database.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AmbiguousFingerprint } from "../core/errors.ts";
import type { Finding, Severity } from "../core/finding.ts";
import { clientDeliveredWork, type LadderState } from "../core/ladder.ts";
import { isTerminal, TERMINAL_SQL, PERSON_OR_CLOCK_DECIDED_SQL, type ReviewState, FINDINGS_SQL } from "../core/review-state.ts";
import type { Scope } from "../core/scope.ts";
import { DDL, FINDING_ORDER_SQL, PRAGMAS, SCHEMA_VERSION, applyMigrations, assertNotDowngrade } from "./schema.ts";
import { NO_EVENTS, type ReviewEvents } from "../mcp/events.ts";

export interface RepoRow {
  readonly id: string;
  readonly name: string;
  readonly gitUrl: string;
}

export interface ReviewRow {
  readonly id: string;
  readonly repoId: string;
  readonly principal: string;
  /**
   * The token that started it (D-78), or `undefined` for a row that predates the column.
   *
   * NOT attribution — *who* started a review is `principal`, and every agent acting for
   * a person is that person. This exists because `review_poll` returns deltas and marks
   * them delivered, so a colleague polling a review they did not start takes its
   * findings and the owner is shown nothing.
   */
  readonly tokenHash?: string | undefined;
  /** The ladder this review started on, `<id>:<model>` per tier. See `schema.ts`. */
  readonly tiers?: string | undefined;
  readonly branch: string;
  /**
   * The pull request this branch is proposed in, if the client named one.
   *
   * `undefined` is ordinary and always will be: lore reviews its own commits from scratch
   * `review/<sha>` refs, which have no pull request, and no client is forced to supply one
   * (see `review_start` — making it required would have failed every call from every
   * client already mid-flight). It exists so a person reading the board can get from a
   * branch name to the thing they actually want to look at.
   */
  readonly pullRequest?: string | undefined;
  /**
   * The branch this review diffs against. `undefined` means there is none to diff
   * against at all — a folder review (D-130), scoped by `reviewPath` instead.
   */
  readonly intoRef?: string | undefined;
  /**
   * Set only for a folder review (D-130): the path it is scoped to (`"."` for the
   * whole worktree), reviewed as a full read against git's empty tree rather than
   * against `intoRef`. `undefined` is an ordinary branch-vs-`into` review — today's
   * only shape before this column existed, and still the default.
   */
  readonly reviewPath?: string | undefined;
  readonly ticket: string;
  readonly type: string;
  readonly state: ReviewState;
  readonly treeHash: string | undefined;
  /**
   * The tree ORIGIN was last pinned at — set once at `review_start` and again on every
   * successful `pull_fresh`, and never moved by a submit, a held diff, or a round's own
   * fixes (`treeHash` is that one). `pull_fresh`'s "origin has nothing newer" check reads
   * this, not `treeHash`, because comparing against the fixes-applied tree meant the
   * check could never fire again once any fix had landed — a no-op pull_fresh silently
   * rewound the review to the pre-fix tip. `undefined` on a row written before
   * the column existed, which the check reads as "no opinion" rather than a guess.
   */
  readonly originTreeHash?: string | undefined;
  /**
   * The commit this review's change-set is measured FROM (D-113), resolved at pin time —
   * the first round, and every `pull_fresh` — and untouched between pins.
   *
   * `intoRef` is a branch NAME, so recomputing the merge-base every round let the
   * change-set shrink and finally vanish as the base branch advanced to contain the
   * branch under review. `undefined` predates the column and recomputes as before,
   * because back-filling a base for an in-flight review would redefine what it attests.
   */
  readonly baseCommit?: string | undefined;
  readonly ladder: LadderState;
  /**
   * When this review last moved — and therefore when the stale sweep will take it.
   *
   * Read by `review_inbox` to tell a client how long it has left to answer, which is the
   * only number that makes "waiting on you" actionable rather than merely true.
   */
  readonly updatedAt: string;
}

export interface RecordedFinding extends Finding {
  readonly fingerprint: string;
  /**
   * The code this finding is about, as it stood when it was raised (D-56).
   *
   * Absent for findings raised before the column existed, and for anything whose
   * file could not be read. Absent means "cannot tell whether it moved", which is
   * why it never auto-settles: guessing here would write a false `fixed` into an
   * attestation.
   */
  readonly scope?: Scope | undefined;
  /** Tier id or T0 engine name that raised it. */
  readonly origin: string;
  /**
   * True when this finding is about code THIS BRANCH DOES NOT TOUCH (D-68).
   *
   * T0 scans the whole worktree, so a pattern engine reports every match in the
   * repository — and those same matches then appear on every unrelated branch,
   * forever. Not false, and not this merge's doing.
   */
  readonly preexisting?: boolean | undefined;
  readonly round: number;
  readonly firstSeen: string;
}

export type VerdictKind = "fixed" | "justified-accepted" | "justified-rejected";

/**
 * The verdicts that CLOSE a finding. `justified-rejected` is deliberately not one:
 * the reviewer read the reason and refused it, which leaves the defect open and
 * makes it worse than one nobody argued about.
 *
 * Exported because "settled" was defined twice and the definitions disagreed.
 * `openFindings` had it right in SQL; `review_poll` asked instead whether a verdict
 * row EXISTED, so a rejected justification was labelled "Already settled — nothing to
 * do", stripped of its `justify_with`, and still counted in `open_count`. A client
 * trusting the per-finding note over the aggregate would merge a defect its reviewer
 * had explicitly refused to accept.
 */
export const SETTLING_VERDICTS: readonly VerdictKind[] = ["fixed", "justified-accepted"];

export function isSettled(v: VerdictKind): boolean {
  return SETTLING_VERDICTS.includes(v);
}

/**
 * What a TIER did. Never what the ladder decided about it.
 *
 * Two vocabularies used to reach this column, because `runRound` closed the row a
 * second time with `stepped.decision.kind` — so `passed`, `escalate` and `fastClean`
 * landed in it, and `make status` painted an answered, clean tier red as a tier that
 * never finished. That second write is gone, and this type is what stops the two
 * vocabularies meeting again.
 *
 * It is a type rather than a comment because the drift outlived the bug: the
 * attestation fixtures went on asserting `fastClean`/`escalate`/`passed` and stayed
 * green, since `countTiers` reads DISTINCT tier and never looks at the outcome. A
 * test that describes a state production cannot produce proves nothing about
 * production, and nothing was in a position to notice.
 */
/**
 * What a tier run DID — a different vocabulary from `ReviewState`, sharing the word
 * `failed` with it. The two were once written into this one column and the column stopped
 * answering which question it was for; `one-definition.test.ts` bans review states spelled
 * out in SQL partly because of that collision.
 */
// `stopped` is a lore-caused end — a cancel, a superseding restart, a shutdown — and it
// is its own outcome precisely so it stays OUT of `DID_NOT_LOOK_SQL` below. The tier did
// not look, which is why it is not `clean`; but it is not EVIDENCE ABOUT THE TIER, which
// is why it must not feed `tierFailureCount` and from there the skip that costs a review
// an independent vendor. `CancelledByLore` exists for the same distinction one layer up,
// and the rethrow that carries it was landing after this row had already been written
// `failed`.
// `interrupted` is t0's own, one level below the tier vocabulary above it: at least one
// ENGINE attempted to run and did not finish (killed, ran out of memory) rather than
// being genuinely absent (no config, not installed). Found by lore's own review,
// fingerprint 68b3e26f: before this existed, an interrupted round's zero findings
// closed the row `clean` — the same false claim D-102 already fixed for `reused`, here
// for a different trigger. Kept distinct from `clean` (which the operator board paints
// green) and out of `DID_NOT_LOOK_SQL` below, matching `reused`: unlike `failed` or
// `unpayable`, t0 partially ran and may have real findings from engines that DID finish.
export const TIER_OUTCOMES = ["clean", "findings", "failed", "unpayable", "reused", "stopped", "interrupted"] as const;
export type TierOutcome = (typeof TIER_OUTCOMES)[number];

/**
 * The outcomes that mean the tier did NOT read the code, as a SQL list. Derived, never
 * spelled out.
 *
 * `reused` is deliberately NOT here. D-92 reuses t0 only when the tree hash and the engine
 * set both match, so that run DID read these exact bytes — in an earlier round. It is the
 * one outcome that looked without working, and treating it as a miss would weaken every
 * verdict built on it for no reason. `interrupted` is excluded for the same reason as
 * `reused`, not the same reason as each other: t0 genuinely attempted this round, and an
 * engine that finished before another was cut short still produced real findings.
 */
const DID_NOT_LOOK_SQL = TIER_OUTCOMES.filter((o) => o === "failed" || o === "unpayable")
  .map((o) => `'${o}'`)
  .join(", ");

export interface VerdictRow {
  readonly fingerprint: string;
  readonly verdict: VerdictKind;
  readonly rationale: string | undefined;
  readonly scope: Scope | undefined;
  readonly tier: string | undefined;
  readonly round: number | undefined;
  /** The development rule this acceptance rested on, when it was an appeal (D-83). */
  readonly viaRule?: string | undefined;
  readonly createdAt: string;
}

/**
 * A candidate prior sighting of a finding, elsewhere in this repo — unfiltered.
 *
 * `claim` is returned uninterpreted because a CWE-only match is a weak signal (see
 * `Store.priorLike`); the caller decides whether it is corroborated enough to count.
 * `verdict` is the LATEST verdict for that finding, or `undefined` if it was never
 * answered.
 */
export interface PriorFinding {
  readonly claim: string;
  readonly verdict: string | undefined;
}

/**
 * `policy` is a DEVELOPMENT RULE a client can appeal to (D-83).
 *
 * The others describe the codebase; a policy describes what this project has decided to
 * enforce and what it has decided not to. That difference has one consequence and it is
 * the reason for a separate kind: **a policy is not injected into review prompts.**
 * Up to sixty rules already go in under "treat these as this team's decisions", and a
 * policy says nothing a reviewer needs until somebody cites it — so the prompt carries
 * their EXISTENCE, and a cited policy's text arrives with the appeal.
 */
export type KnowledgeKind = "rule" | "fact" | "mistake" | "policy";
export type KnowledgeSource = "taught" | "ingested" | "derived";

/**
 * Pass as `knowledgeFor`'s `limit` for "every live row" — see that method's docs
 * (`aa57c0f2`) for why this is `-1` and not `undefined`.
 */
export const NO_LIMIT = -1;

export interface KnowledgeItem {
  readonly id: string;
  readonly repoId: string;
  readonly kind: KnowledgeKind;
  readonly source: KnowledgeSource;
  readonly statement: string;
  readonly why: string | undefined;
  readonly path: string | undefined;
  readonly cwe: string | undefined;
  readonly provenance: string | undefined;
  readonly sourceBlob: string | undefined;
  /** For ingested rules: which extractor version produced this. */
  readonly extractor?: string | undefined;
  readonly confidence: number | undefined;
  readonly verifiedAt: string;
}

export interface UsageRecord {
  readonly repoId?: string;
  readonly reviewId?: string;
  readonly tier: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly cachedTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly latencyMs?: number;
  /** Agentic turns the tier took. Absent means "not measured", never "none" (D-50). */
  readonly steps?: number;
  /** Diff size in characters before truncation, so the ceiling is observed (D-58). */
  readonly diffChars?: number;
  readonly outcome: string;
}

/** node:sqlite rejects `undefined` as a bound parameter; SQL wants NULL. */
function n<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

function un<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

function now(): string {
  return new Date().toISOString();
}

export class Store {
  readonly db: DatabaseSync;
  /** Where this database lives, so `integrityFault` can ask a FRESH reader about it. */
  private readonly path: string;

  /**
   * Who to tell when a review moves — set once during wiring, after the MCP handler
   * that owns the publish side exists (D-80).
   *
   * Late-bound rather than a constructor argument because of a genuine ordering
   * problem: the store is opened before anything is serving, and the notifier belongs
   * to the handler. Defaulting to a no-op means the CLI and every test that does not
   * care simply never notice — publishing into the void is correct where nothing can
   * subscribe, and must stay silent so the log keeps carrying only real faults.
   *
   * Set HERE rather than at each mutation site: `updateReview` has ten callers and
   * `recordFinding` two, and a hand-maintained list of places to publish from is the
   * shape that has produced a missing case every single time it has been tried in
   * this codebase.
   */
  events: ReviewEvents = NO_EVENTS;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    for (const p of PRAGMAS) this.db.exec(p);
    this.db.exec(DDL);
    // Before the migrations, and before the version row is overwritten: it is the
    // PREVIOUS build's number that says whether this one is a downgrade, and writing
    // first would destroy the only evidence.
    assertNotDowngrade(this.db);
    // `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it found it,
    // so this is what reaches a column added after the deployment already had a
    // database (see `MIGRATIONS`).
    applyMigrations(this.db);
    // Written after the migrations and UPDATED, not left alone: the row is only
    // worth having if it describes the tables that are actually there.
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
      .run(String(SCHEMA_VERSION), String(SCHEMA_VERSION));
  }

  close(): void {
    // IDEMPOTENT. `node:sqlite` throws `database is not open` on a second close, so any
    // path where a shutdown hook and an owner both tidy up — or a test that closes the
    // store its fixture also closes — turned ordinary cleanup into a throw. Closing what
    // is already closed is the caller getting what it asked for, not an error.
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /**
   * THE STORE IS SHUT, AND SAYING SO BEATS THROWING.
   *
   * A round in flight when the process goes down writes its own completion — and the
   * handle is already closed, so `node:sqlite` throws `ERR_INVALID_STATE: database is
   * not open` out of a detached promise. An unhandled rejection, during exactly the
   * window three deploys have now gone wrong in, from code whose whole job is to record
   * what happened.
   *
   * Refusing the write is SAFE HERE and nowhere else, and the reason is specific rather
   * than convenient: everything a round writes at its end is recoverable by design. The
   * job row stays `running`, and `reclaimOrphanedJobs` requeues exactly those rows at the
   * next startup — that is what it is for. So the outcome of dropping the write is the
   * outcome the restart path already produces, while the outcome of throwing is an
   * unhandled rejection that can take the process with it.
   *
   * Said out loud, once per call, because a silent drop is the shape this project
   * refuses; and NOT used as a general shield — only the three round-completion writes
   * consult it, so a write to a closed store anywhere else still throws and is still a
   * defect.
   */
  private closed = false;

  isClosed(): boolean {
    return this.closed;
  }

  private refusedByClose(what: string): boolean {
    if (!this.closed) return false;
    console.error(
      `[lore:log] ${what} was not written — the store is closed, so this process is going down mid-round. ` +
        "The job row stays `running` and startup will requeue it; nothing was lost.",
    );
    return true;
  }

  /**
   * Run `fn` in a transaction.
   *
   * Nothing half-applied: a review whose findings were recorded but whose ladder
   * state was not would re-raise them forever.
   */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ------------------------------------------------------------------ repo

  upsertRepo(name: string, gitUrl: string): RepoRow {
    const existing = this.db.prepare("SELECT * FROM repo WHERE git_url = ?").get(gitUrl) as
      | Record<string, string>
      | undefined;
    if (existing !== undefined) {
      return { id: existing["id"] ?? "", name: existing["name"] ?? "", gitUrl };
    }
    // ON CONFLICT, because the read above is a check-then-act with no lock between it
    // and this insert: two provisions of one repository racing both find nothing and
    // both insert, and then tokens, reviews and knowledge split across two rows for one
    // repository. The unique index in `DDL` is what makes this reachable rather than
    // decorative; this arm turns the race into a no-op instead of a throw.
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO repo(id, name, git_url, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(git_url) DO NOTHING")
      .run(id, name, gitUrl, now());
    const row = this.db.prepare("SELECT id, name FROM repo WHERE git_url = ?").get(gitUrl) as
      | Record<string, string>
      | undefined;
    return { id: row?.["id"] ?? id, name: row?.["name"] ?? name, gitUrl };
  }

  // ---------------------------------------------------------------- review

  // `updatedAt` is not a caller's to supply — it is written here and moved by
  // `updateReview`, and a review that could be created claiming it last moved yesterday
  // would be swept the moment it was born.
  createReview(r: Omit<ReviewRow, "treeHash" | "updatedAt"> & { treeHash?: string }): void {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO review(id, repo_id, principal, token_hash, tiers, branch, pull_request, into_ref, review_path, ticket, type, state, tree_hash, origin_tree_hash, ladder, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.repoId,
        r.principal,
        n(r.tokenHash),
        n(r.tiers),
        r.branch,
        n(r.pullRequest),
        // "" rather than NULL: `into_ref` predates this column and is TEXT NOT NULL in
        // the original CREATE TABLE, and this project's migration system deliberately
        // refuses anything beyond ADD COLUMN (schema.ts) — relaxing an existing NOT
        // NULL needs a table rebuild, real risk on a live database for a boundary this
        // narrow. "" cannot collide with a real branch name; git itself refuses an
        // empty ref name. Confined to this file — see the matching read below.
        r.intoRef ?? "",
        n(r.reviewPath),
        r.ticket,
        r.type,
        r.state,
        n(r.treeHash),
        // THE INITIAL PIN, recorded as origin's tree from the moment the review begins —
        // `review_start` cuts the worktree from origin before this is called, so
        // `r.treeHash` at creation time already IS the origin pin; pull_fresh is what
        // later needs a value that ordinary fixes do not move.
        n(r.treeHash),
        JSON.stringify(r.ladder),
        t,
        t,
      );
  }

  /**
   * Fetch a review, enforcing that it belongs to the caller.
   *
   * Possession of a `review_id` is never authentication (D-23). A valid id from
   * another principal must fail exactly as a forged one does — which is why the
   * principal is a parameter here rather than something callers remember to check.
   */
  /**
   * The review of this branch that is still going, if there is one.
   *
   * Scoped to the repo rather than the principal: two teammates reviewing one branch
   * are duplicating the same work and paying twice for it, and the second should be
   * told about the first rather than quietly starting a parallel ladder.
   *
   * Newest first, because if several are somehow open the useful one to continue is
   * the one that has got furthest.
   */
  /**
   * The open review on this branch, if there is one.
   *
   * Carries its AGE because the refusal built on it is read by someone deciding
   * whether to continue or restart, and that decision turns entirely on how stale the
   * pinned snapshot is. Without the age the message could only offer `restart: true`
   * "if the branch was rebased" — which fired on a review from twenty hours and
   * twenty-five commits earlier that had been neither rebased nor force-pushed, so the
   * one legitimate escape did not appear to apply.
   */
  openReviewFor(
    repoId: string,
    branch: string,
    /**
     * `undefined` for an ordinary diff review; a path for a folder review (D-130).
     *
     * Part of the dedup key, not just the lookup: a folder review of `src/payments`
     * and a diff review of the same branch are different work, and so are folder
     * reviews of two different paths on the same branch. `IS`, not `=` — SQLite's `=`
     * never matches NULL, which would have made every diff-mode review on a branch
     * invisible to its own one-review-per-branch check.
     */
    path?: string | undefined,
  ): { id: string; state: string; round: number; ageHours: number; principal: string } | undefined {
    // lore-ok[b547e780]: equivalent spellings of one path ("src", "src/", "./src")
    // would defeat this comparison if they ever reached it — fixed one layer up, not
    // here: `mcp/server.ts`'s `normalizeReviewPath` canonicalizes `path` before it is
    // ever passed in, for both this lookup and the row `createReview` writes, so the
    // two sides of this `IS` are always already in the same spelling by the time this
    // function sees them. Verified directly: http.test.ts's "treats equivalent
    // spellings of one path as the same review, not three".
    const row = this.db
      .prepare(
        `SELECT id, state, ladder, updated_at, principal FROM review
         WHERE repo_id = ? AND branch = ? AND review_path IS ? AND state NOT IN (${TERMINAL_SQL})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repoId, branch, n(path)) as Record<string, string> | undefined;
    if (row === undefined) return undefined;
    const ladder = JSON.parse(row["ladder"] ?? "{}") as { round?: number };
    const updated = Date.parse(row["updated_at"] ?? "");
    return {
      id: row["id"] ?? "",
      state: row["state"] ?? "",
      round: ladder.round ?? 0,
      // NaN would print as "NaN hours old", so an unparseable timestamp reads as 0 —
      // which suppresses the staleness advice rather than inventing it.
      ageHours: Number.isFinite(updated) ? Math.max(0, (Date.now() - updated) / 3_600_000) : 0,
      // Who started it — 8d847ca4: `restart: true` cancels this review, and a
      // destructive action needs to know whose it is before it can refuse to act on
      // a colleague's, the same way every other review-touching handler does via
      // `mine()`. Not part of the dedup key or the staleness advice above; only the
      // restart guard reads it.
      principal: row["principal"] ?? "",
    };
  }

  getReview(id: string, principal: string): ReviewRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM review WHERE id = ? AND principal = ?")
      .get(id, principal) as Record<string, string> | undefined;
    if (row === undefined) return undefined;
    return {
      id: row["id"] ?? "",
      repoId: row["repo_id"] ?? "",
      principal: row["principal"] ?? "",
      branch: row["branch"] ?? "",
      // The write side's "" sentinel, undone. See the matching comment in createReview.
      intoRef: row["into_ref"] === "" || row["into_ref"] === undefined ? undefined : row["into_ref"],
      reviewPath: un(row["review_path"] ?? null),
      ticket: row["ticket"] ?? "",
      type: row["type"] ?? "",
      state: (row["state"] ?? "failed") as ReviewState,
      treeHash: un(row["tree_hash"] ?? null),
      originTreeHash: un(row["origin_tree_hash"] ?? null),
      baseCommit: un(row["base_commit"] ?? null),
      tokenHash: un(row["token_hash"] ?? null),
      tiers: un(row["tiers"] ?? null),
      pullRequest: un(row["pull_request"] ?? null),
      ladder: JSON.parse(row["ladder"] ?? "{}") as LadderState,
      updatedAt: row["updated_at"] ?? "",
    };
  }

  /**
   * A review's state, with no principal — for machinery that acts on a review rather
   * than answering somebody about one.
   *
   * `getReview` requires a principal because possession of an id is never authentication
   * (D-23), and that is right for every path a client can reach. The worker is not on
   * such a path: it holds a job, and needs to know whether the review that job belongs to
   * has already ended before it writes an outcome over it.
   */
  stateOf(id: string): ReviewState | undefined {
    const row = this.db.prepare("SELECT state FROM review WHERE id = ?").get(id) as
      | Record<string, string>
      | undefined;
    return row?.["state"] as ReviewState | undefined;
  }

  updateReview(
    id: string,
    patch: {
      state?: ReviewState;
      ladder?: LadderState;
      treeHash?: string;
      originTreeHash?: string;
      baseCommit?: string;
    },
  ): void {
    // See `refusedByClose`: the deploy window, where a round writes its own ending into
    // a handle that is already shut. The review keeps the state it had and its `running`
    // job is requeued at startup — the same place the restart path would have put it.
    if (this.refusedByClose(`the state of ${id}`)) return;
    // Read first, so the wake below can be about a CHANGE rather than about a write.
    const before = this.db.prepare("SELECT state FROM review WHERE id = ?").get(id) as
      | Record<string, string>
      | undefined;
    const sets: string[] = ["updated_at = ?"];
    const args: (string | null)[] = [now()];
    if (patch.state !== undefined) {
      sets.push("state = ?");
      args.push(patch.state);
    }
    if (patch.ladder !== undefined) {
      sets.push("ladder = ?");
      args.push(JSON.stringify(patch.ladder));
    }
    if (patch.treeHash !== undefined) {
      sets.push("tree_hash = ?");
      args.push(patch.treeHash);
    }
    // WRITTEN ONLY WHEN A CALLER MEANS IT — `pull_fresh` is currently the only one that
    // ever passes this. Every ordinary round writes `treeHash` alone, which is exactly
    // right: applying a fix must not move the reader's idea of "what origin last had".
    if (patch.originTreeHash !== undefined) {
      sets.push("origin_tree_hash = ?");
      args.push(patch.originTreeHash);
    }
    // WRITTEN ONLY AT A PIN (D-113) — the first round, and every `pull_fresh`. A pin is
    // the one moment the client has said "this is my branch now", so it is the only
    // moment the question "what is this a review OF" may legitimately be re-answered.
    // Every ordinary round leaves it alone, which is the whole point of the column.
    if (patch.baseCommit !== undefined) {
      sets.push("base_commit = ?");
      args.push(patch.baseCommit);
    }
    args.push(id);
    this.db.prepare(`UPDATE review SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    // A REVIEW THAT HAS ENDED LEAVES NO WORK BEHIND IT.
    //
    // `claimJob` refuses a job whose review is terminal — correctly, since a cancelled
    // review must not go on being paid for. But nothing ever CLOSED those rows, so they
    // sat in `queued` for ever, unclaimable, and `queueDepth` counted them as a backlog.
    //
    // Found by Vany asking the right question about the operator view: *"a job must be
    // picked immediately. Why has nobody claimed it?"* Three jobs had been queued for up
    // to nineteen hours with eleven idle workers and three free model slots, and the
    // honest answer was that they were not waiting for anything — they were dead. The
    // number said work was piling up while the service was idle, which is the same false
    // reassurance in the opposite direction as the drain flag that answered `ok: true`
    // for thirteen hours.
    if (patch.state !== undefined && isTerminal(patch.state)) this.discardQueuedJobs(id);
    // THE ONLY PLACE A SUBSCRIBED CLIENT IS WOKEN. `recordFinding` deliberately does
    // not — see the note there.
    //
    // AFTER the write. The comment here used to say exactly that while the call sat
    // above the UPDATE: the false-statement-about-behaviour this repository is worst
    // at, written into the feature that exists to keep clients informed. Woken first,
    // a client re-reads and sees the state it was just told had changed; if the write
    // then throws, it waits for a second wake that will never come.
    //
    // And ONLY on a state change, which is the promise `spec/mcp-api.md` §2.0.1 makes.
    // Every round boundary writes `state: running` over `running`, and the next round
    // writes it again — so a review climbing t1→t2→t3 with nothing to report woke its
    // subscriber twice per tier, each wake costing an LLM turn to poll and learn
    // nothing. That is the same shape as notifying on a re-raised finding, which this
    // file already refuses for the same reason: a notification per non-event teaches a
    // client to ignore the stream. The ladder cursor is deliberately NOT news — it is
    // bookkeeping the client cannot act on.
    if (patch.state !== undefined && patch.state !== before?.["state"]) this.events.changed(id);
  }

  /**
   * Expire every review that has not moved since `cutoff`, and wake whoever waited.
   *
   * The SQL used to live in `ops/retention.ts` and wrote `state` directly, which made
   * it the one review-state mutation that published nothing: a client subscribed to a
   * review — the path the docs lead with — was never told it had been abandoned, and
   * waited on a stream that would never deliver for it again. Exactly the failure the
   * comment on `events` predicts, in a file that comment's author never looked at.
   *
   * Ids are read inside the transaction and published after it commits: woken before,
   * a client re-reads and sees a review that is still open.
   */
  expireStaleReviews(cutoff: string, staleCutoff?: string): readonly string[] {
    const ids = this.tx(() => {
      // TWO CLOCKS SINCE D-106. `findings_ready` does not die at `cutoff` — it turns
      // `findings_stale` and gets `staleCutoff`'s longer grace; everything else
      // non-terminal expires at `cutoff` exactly as before. The stale rows expire on
      // THEIR clock, which restarts when the graying writes `updated_at` — so the week
      // counts from going gray, not from the last submit.
      const rows = this.db
        .prepare(
          `SELECT id FROM review WHERE state NOT IN (${TERMINAL_SQL}) AND (
             (state NOT IN (${FINDINGS_SQL}) AND updated_at < ?)
             OR (state = 'findings_stale' AND updated_at < ?))`,
        )
        .all(cutoff, staleCutoff ?? cutoff) as Record<string, string>[];
      if (rows.length > 0) {
        this.db
          .prepare(
            `UPDATE review SET state = 'expired', updated_at = ?
             WHERE state NOT IN (${TERMINAL_SQL}) AND (
               (state NOT IN (${FINDINGS_SQL}) AND updated_at < ?)
               OR (state = 'findings_stale' AND updated_at < ?))`,
          )
          .run(now(), cutoff, staleCutoff ?? cutoff);
        // The same reason `updateReview` does it, and this path has to be told
        // separately BECAUSE it writes state in SQL rather than going through there.
        // That split has already cost one bug — this was the single review-state
        // mutation that published no event — and leaving unclaimable jobs behind would
        // have been the second instance of the identical mistake.
        for (const r of rows) this.discardQueuedJobs(r["id"] ?? "");
      }
      return rows.map((r) => r["id"] ?? "");
    });
    for (const id of ids) this.events.changed(id);
    return ids;
  }

  /**
   * Gray the reviews that sat in `findings_ready` past the cutoff (D-106).
   *
   * The state is `findings_stale`: everything about it still works — findings
   * collectable, a submit accepted, the worktree held — it is `findings_ready` wearing
   * gray, a visible grace between "waiting on you" and "nobody came back". Writing
   * `updated_at` here is what starts the week: the stale clock counts from going gray.
   *
   * Published like every state change, for the same reason `expireStaleReviews` was
   * taught to: a subscriber watching this review deserves to hear it dim.
   */
  grayStaleFindings(cutoff: string): readonly string[] {
    const ids = this.tx(() => {
      const rows = this.db
        .prepare(`SELECT id FROM review WHERE state = 'findings_ready' AND updated_at < ?`)
        .all(cutoff) as Record<string, string>[];
      if (rows.length > 0) {
        this.db
          .prepare(`UPDATE review SET state = 'findings_stale', updated_at = ? WHERE state = 'findings_ready' AND updated_at < ?`)
          .run(now(), cutoff);
      }
      return rows.map((r) => r["id"] ?? "");
    });
    for (const id of ids) this.events.changed(id);
    return ids;
  }

  /**
   * Who a review belongs to — the ownership rule, without the review.
   *
   * `getReview` already enforces this and takes the principal as an argument, because
   * its answer is a review. This answers the narrower question a subscription stream
   * asks — *may THIS listener hear about THIS id* — where the caller holds the
   * subscriber and the id is whatever the client typed. `undefined` for an id that does
   * not exist, which the bus treats identically to one that is somebody else's: see
   * `ScopedEventBus`, and `mine()`'s NOT FOUND, for the same reason.
   */
  ownerOf(
    reviewId: string,
  ): { readonly principal: string; readonly repoId: string; readonly tokenHash?: string } | undefined {
    const row = this.db
      .prepare("SELECT principal, repo_id, token_hash FROM review WHERE id = ?")
      .get(reviewId) as Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    // `token_hash` travels with it so a SUBSCRIPTION can apply the same rule `mine()`
    // does (D-78). Without it the stream authorised on principal+repo alone, so a second
    // token of the same person was woken on every state change of a review that
    // `review_poll` would answer NOT FOUND for — and the file's own comment claimed the
    // two were in step.
    const hash = row["token_hash"];
    return {
      principal: String(row["principal"] ?? ""),
      repoId: String(row["repo_id"] ?? ""),
      ...(typeof hash === "string" && hash !== "" ? { tokenHash: hash } : {}),
    };
  }

  /**
   * Whether a token is still live, by its stored hash.
   *
   * Authentication happens once per HTTP exchange, and a `subscriptions/listen` stream
   * is one exchange that stays open for hours. Without re-checking, revoking a leaked
   * token would leave every stream it had already opened delivering — while `make
   * revoke` tells an operator the opposite.
   */
  tokenLive(hash: string): boolean {
    return this.db.prepare("SELECT 1 FROM token WHERE hash = ? AND revoked_at IS NULL").get(hash) !== undefined;
  }

  /**
   * The audit trail's two chronologies, with their columns NAMED.
   *
   * `lore://review/{id}` used to build these with `SELECT *` from the MCP layer, which
   * is two faults in one line. The smaller is that the query lived outside the store at
   * all. The larger is that `*` makes the client-facing shape of this resource a
   * function of the schema: every column added here — a model name, an internal
   * bookkeeping flag, whatever the next migration needs — would ship to every client
   * that reads the trail, silently, without anyone deciding to publish it.
   *
   * Named columns make that a decision instead of a consequence. These are exactly what
   * the resource already returned on the day this was written; adding to either list is
   * now an act, and `spec/mcp-api.md` §2.0 is where it has to be written down.
   */
  verdictsFor(reviewId: string): readonly Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT id, review_id, fingerprint, verdict, rationale, scope_blob, scope_hunk, tier, model, round,
                created_at
         FROM verdict WHERE review_id = ? ORDER BY id`,
      )
      .all(reviewId) as Record<string, unknown>[];
  }

  tierRunsFor(reviewId: string): readonly Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT id, review_id, tier, round, outcome, unavailable, tree_hash, started_at, finished_at
         FROM tier_run WHERE review_id = ? ORDER BY id`,
      )
      .all(reviewId) as Record<string, unknown>[];
  }

  /** Every repository, for the operator-facing paths that enumerate them. */
  repos(): readonly RepoRow[] {
    const rows = this.db.prepare("SELECT id, name, git_url FROM repo ORDER BY name").all() as Record<string, string>[];
    return rows.map((r) => ({ id: r["id"] ?? "", name: r["name"] ?? "", gitUrl: r["git_url"] ?? "" }));
  }

  /** Point a repository at a new remote, keeping its id and everything hanging off it. */
  relocateRepo(repoId: string, gitUrl: string): void {
    this.db.prepare("UPDATE repo SET git_url = ? WHERE id = ?").run(gitUrl, repoId);
  }

  /**
   * Where a finding was raised, by fingerprint.
   *
   * Used when a `lore-ok` names a fingerprint whose finding is not in the round's own
   * list — a justification for something a previous round settled. The file is what
   * makes the marker placeable.
   */
  fileOfFinding(reviewId: string, fingerprint: string): string | undefined {
    const row = this.db
      .prepare("SELECT file FROM finding WHERE review_id = ? AND fingerprint = ?")
      .get(reviewId, fingerprint) as Record<string, string> | undefined;
    return row?.["file"];
  }

  /**
   * Completed round latencies for a tier on ONE repository, ascending — the input to
   * `check_back_after_ms`.
   *
   * Scoped by repository because `paceNote` tells the client the number was "measured
   * across N completed runs on this repository" and, pooled, it was not: one `lore.db`
   * serves every repo a workgroup provisions, and a 741 KB monorepo and an 80 KB diff
   * of our own do not take the same time at the same tier. The column was there and
   * written the whole time (`recordUsage`); only the read ignored it.
   *
   * The honest cost is that scoping shrinks the sample, and a tier below `MIN_RUNS`
   * for a repository now gets no interval rather than another repository's. That is
   * the trade this file already makes everywhere else: no number beats a wrong one.
   */
  latenciesFor(tier: string, repoId: string): readonly number[] {
    const rows = this.db
      .prepare(
        "SELECT latency_ms FROM usage WHERE tier = ? AND repo_id = ? AND latency_ms IS NOT NULL" +
          " AND outcome != 'failed' ORDER BY latency_ms",
      )
      .all(tier, repoId) as { latency_ms: number }[];
    return rows.map((r) => r.latency_ms);
  }

  /**
   * When THIS TIER'S run in flight started, or `undefined` if it has not begun.
   *
   * Needed because "how long should I wait" is not a property of the tier alone: a round
   * that has already run for longer than the median has a shorter wait left, not another
   * whole median.
   *
   * **Asked per tier, and it has to be.** Any open `tier_run` used to answer, and during
   * T0 the only open row is T0's — while the ladder cursor already points at the model
   * tier, so `pacing` compared a T0-window elapsed against the MODEL tier's latencies. On
   * a repository where T0 takes minutes (this deployment has measured ~21) every poll
   * from a few minutes in computed elapsed past every recorded model run and told the
   * client the round had been open longer than any completed one — before the tier had
   * been asked anything, which is the exact false claim the previous fix was for. Then
   * the model tier's row opened and the advertised wait jumped back UP to the full
   * median, contradicting the field's own promise that it only shrinks.
   *
   * `undefined` before the tier starts is the honest answer and the caller wants it:
   * elapsed zero, so the first call gets the plain median.
   */
  roundStartedAt(reviewId: string, tier: string): number | undefined {
    const row = this.db
      .prepare(
        "SELECT started_at FROM tier_run WHERE review_id = ? AND tier = ? AND finished_at IS NULL" +
          " ORDER BY id DESC LIMIT 1",
      )
      .get(reviewId, tier) as Record<string, string> | undefined;
    const at = row?.["started_at"];
    return at === undefined ? undefined : Date.parse(at);
  }

  /**
   * A principal's reviews, optionally narrowed to one repository.
   *
   * `repoId` is REQUIRED to be written even when it is `undefined`, because omitting
   * it is exactly the bug this parameter was added to fix: tokens are scoped per
   * repository (D-23) and this was scoped per PRINCIPAL, so one person's token for
   * repo A listed their reviews of repo B. Reported by a client that could see
   * lore's own branches through a rigid-monorepo token.
   *
   * `undefined` means "every repository" and is right for the CLI, which runs on the
   * operator's own machine against their own database. It is never right at the MCP
   * boundary, where the token is the only thing saying who is asking.
   */
  listReviews(principal: string, repoId: string | undefined, limit = 50): readonly ReviewRow[] {
    const rows = this.db
      .prepare(
        // UNFINISHED FIRST, then by recency — and the ordering is what makes the LIMIT
        // safe rather than merely tidy.
        //
        // `review_inbox` filters this list down to what is still open, and it filters
        // AFTER the query. Ordered by recency alone, fifty freshly-finished reviews fill
        // the whole result and an older review parked in `findings_ready` never reaches
        // the filter — invisible until it expires, which is precisely the abandonment
        // D-95 exists to end, reintroduced by a row cap. Raised by lore's own t2 against
        // the change that added the filter.
        `SELECT id FROM review WHERE principal = ? AND (? IS NULL OR repo_id = ?)
         ORDER BY (state IN (${TERMINAL_SQL})), updated_at DESC LIMIT ?`,
      )
      .all(principal, repoId ?? null, repoId ?? null, limit) as Record<string, string>[];
    return rows
      .map((r) => this.getReview(r["id"] ?? "", principal))
      .filter((r): r is ReviewRow => r !== undefined);
  }

  // -------------------------------------------------------------- tier runs

  /**
   * Record that a tier ran.
   *
   * The attestation counts distinct tiers from this table, so without it the
   * signed line would claim "0 tiers" — a false statement in the one output the
   * whole service exists to produce.
   */
  /**
   * Open a tier run BEFORE the tier is asked anything, and return its row id.
   *
   * Runs used to be written only on completion, so a tier that threw left no trace
   * at all: a 30-minute `glm-5.2` call that timed out was, to every reader of this
   * database, indistinguishable from a tier that never started. The operator view
   * said "updated 41 minutes ago" and was telling the literal truth.
   *
   * That is INV-1 inside the bookkeeping — work that did not finish, reported as
   * work that never happened — and it is worse here than in a review result,
   * because this is the table someone consults precisely when they are asking
   * "what is going on?"
   *
   * `finished_at` stays NULL until `closeTierRun`, which is what lets a reader tell
   * IN FLIGHT from FINISHED from DIED: null and recent means running, null and old
   * means something stopped without saying so.
   */
  openTierRun(reviewId: string, tier: string, round: number, startedAt: string): number {
    const res = this.db
      .prepare("INSERT INTO tier_run(review_id, tier, round, outcome, started_at, finished_at) VALUES(?, ?, ?, NULL, ?, NULL)")
      .run(reviewId, tier, round, startedAt);
    return Number(res.lastInsertRowid);
  }

  /**
   * Close a run opened by `openTierRun`. The outcome is only known now.
   *
   * `unavailable` records the engines that did NOT run and why. It is persisted
   * rather than only passed to the model prompt because a client polling this review
   * has no other way to learn that `tsc` or the suite never executed — and a check
   * that did not run must never read as a check that found nothing (INV-1).
   */
  closeTierRun(
    id: number,
    outcome: TierOutcome,
    unavailable: readonly string[] = [],
    treeHash?: string,
    /**
     * The same list as the REVIEWER is shown, when the two differ (D-83).
     *
     * They differ for one reason and it matters: a suppression notice tells the client
     * which development rule silenced a check AND quotes it, while the reviewer is told a
     * check was silenced and never what the rule says. Storing only the client's was
     * harmless while every round recomputed both — and became a standing injection once a
     * round could REUSE a stored t0 (D-92), because the reused text feeds `renderT0` and
     * from there every later model prompt.
     *
     * Absent means the two are the same, which is true of every tier but t0.
     */
    unavailableForTier?: readonly string[],
    /** The engine set that produced this row, so a reuse can refuse a changed one (D-92). */
    engines?: readonly string[],
  ): void {
    this.db
      .prepare(
        "UPDATE tier_run SET outcome = ?, unavailable = ?, unavailable_for_tier = ?, engines = ?, tree_hash = ?, finished_at = ? WHERE id = ?",
      )
      .run(
        outcome,
        unavailable.length > 0 ? unavailable.join("\n") : null,
        // NULL AND EMPTY STRING MEAN DIFFERENT THINGS HERE, and collapsing them was
        // wrong. NULL is "nobody recorded a reviewer-facing list" — an old row, or a tier
        // other than t0, where the two audiences are identical and the client's list is
        // the right fallback. `""` is a recorded answer meaning "nothing to tell the
        // reviewer", which must NOT fall back to a client list that may quote a rule.
        // SQLite hands both back as a property of the row, so `undefined` cannot separate
        // them; the value has to.
        unavailableForTier === undefined ? null : unavailableForTier.join("\n"),
        // Sorted, so the same set written in two orders compares equal — the question is
        // WHICH engines ran, not the order a config happened to list them in.
        engines === undefined ? null : [...engines].sort().join(","),
        n(treeHash),
        now(),
        id,
      );
  }

  /**
   * Add to a t0 row's disclosure AFTER it closed, touching only the two
   * `unavailable` columns — never `outcome`, `finished_at`, `engines` or
   * `tree_hash`, which `closeTierRun` owns and D-102's IN-FLIGHT/FINISHED/DIED
   * reading depends on staying exactly as that call left them.
   *
   * lore-ok[d8e642af]: EXISTS BECAUSE D-107's held-diff boundary can discover a
   * live D-83 suppression matches for the FIRST time in a round — new code the
   * fix itself introduced, or a file round-open t0 never touched — after the
   * round's one t0 row has already closed. Filtering the boundary's findings
   * (the fix for f68ace59) correctly keeps the tier from seeing it, but without
   * this, `checks_skipped` (`checksSkippedFor`, read from every `tier_run.unavailable`
   * across the review) would never carry it if this review never independently
   * matches it again — the suppression was appealed and accepted on SOME
   * branch, but not necessarily this one.
   *
   * MERGED, deduped against what the row already has — a notice this round-open
   * already recorded is a no-op here, not a duplicate line.
   */
  appendUnavailable(tierRunId: number, notices: readonly string[], forTier: readonly string[]): void {
    if (notices.length === 0 && forTier.length === 0) return;
    const row = this.db
      .prepare("SELECT unavailable, unavailable_for_tier FROM tier_run WHERE id = ?")
      .get(tierRunId) as { unavailable: string | null; unavailable_for_tier: string | null } | undefined;
    if (row === undefined) return;
    const merge = (existing: string | null, added: readonly string[]): string | null => {
      const set = new Set(String(existing ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== ""));
      for (const a of added) set.add(a);
      return set.size > 0 ? [...set].join("\n") : null;
    };
    this.db
      .prepare("UPDATE tier_run SET unavailable = ?, unavailable_for_tier = ? WHERE id = ?")
      .run(merge(row.unavailable, notices), merge(row.unavailable_for_tier, forTier), tierRunId);
  }

  /**
   * The tiers that read a particular tree, cheapest-first as recorded.
   *
   * Since a closed tier is no longer re-run after a fix, "tiers that ran" and "tiers
   * that read the tree being signed" are different sets, and only the second is what an
   * attestation may claim. Runs from before the column existed carry NULL and are
   * excluded — a run that cannot say which tree it read cannot be counted as having
   * read this one.
   */
  tiersOnTree(reviewId: string, treeHash: string): readonly string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT tier FROM tier_run WHERE review_id = ? AND tree_hash = ? ORDER BY tier")
      .all(reviewId, treeHash) as Record<string, string>[];
    return rows.map((r) => r["tier"] ?? "");
  }

  /**
  /**
   * Every engine that could not run in this review, deduplicated, worst-case first
   * seen. Empty means everything the review type asks for actually executed.
   */
  /**
   * Add to what a tier run says it did NOT cover, after the row is closed.
   *
   * `closeTierRun` happens when the tier answers; some facts about what the round did not
   * cover are only known after — an accepted appeal that bought no class suppression is
   * decided in the reconciliation that follows. Appended rather than replaced, because
   * the reason the tier was closed with is not superseded by this.
   */
  noteChecksSkipped(tierRunId: number, lines: readonly string[]): void {
    if (lines.length === 0) return;
    const row = this.db.prepare("SELECT unavailable FROM tier_run WHERE id = ?").get(tierRunId) as
      | { unavailable: string | null }
      | undefined;
    const existing = row?.unavailable ?? "";
    this.db
      .prepare("UPDATE tier_run SET unavailable = ? WHERE id = ?")
      .run([existing, ...lines].filter((l) => l.length > 0).join("\n"), tierRunId);
  }

  /**
   * How many times this tier has ENDED BADLY in this review — failed or unpayable.
   *
   * The retry budget, read from the evidence already recorded rather than tracked
   * separately. A tier that could not answer once deserves the cheap attempt again; one
   * that could not answer twice has spent it, and its work passes to the next tier
   * rather than killing the review (D-48, extended).
   */
  tierFailureCount(reviewId: string, tier: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM tier_run WHERE review_id = ? AND tier = ? AND outcome IN (${DID_NOT_LOOK_SQL})`)
      .get(reviewId, tier) as Record<string, number> | undefined;
    return Number(row?.["c"] ?? 0);
  }

  /**
   * The last completed t0 run of this review: which tree it read, and what it could not
   * check (D-92).
   *
   * t0 runs at the head of every round so a fix that breaks the build is caught. But a
   * round that follows an ESCALATION rather than a submit reads a byte-identical tree,
   * and t0 is deterministic — that is the property `spec/review-ladder.md` §1.1 makes it
   * carry. Measured across every t0 run ever recorded: **18% of t0 time on
   * rigid-monorepo, 26% on lore, spent re-reading a tree it had already read in the same
   * review.** Nineteen minutes on one repository.
   *
   * `unavailable` comes back with it because that list is a real coverage statement — an
   * engine that could not run is a check nobody made — and it must survive into the round
   * that reuses the result, or reusing would quietly drop it.
   */
  lastT0(reviewId: string): {
    readonly treeHash: string;
    readonly unavailable: readonly string[];
    /**
     * `undefined` when nobody recorded a reviewer-facing list for this row.
     *
     * NOT the client's list as a fallback, which is what the first version did. This
     * query reads ONLY `tier = 't0'` rows, so the "a tier where both audiences agree"
     * case it was reasoning about cannot occur here — the only NULL it can ever see is a
     * row written before the split, and those are exactly the rows whose client text can
     * quote a development rule. The fallback therefore fed the one thing it existed to
     * withhold, and the reusing round re-stored it, making it permanent for that review.
     *
     * The caller declines to reuse instead: not knowing what the reviewer was told is a
     * reason to re-derive it, at the price of one t0 run on reviews open across a deploy.
     */
    readonly unavailableForTier: readonly string[] | undefined;
    /** The engine set that produced it, or `undefined` for a row written before D-92. */
    readonly engines: string | undefined;
    /**
     * Was the reused run itself interrupted (an engine killed, out of memory)?
     *
     * Found by lore's own review of the OOM-kill fix, fingerprint 4c38b78d/928bccd1:
     * the reuse path used to hardcode `interrupted: false` on the reasoning that
     * `codeMoved`'s own guard makes it moot — true only if the worktree cannot move
     * within the SAME round after reuse fires, which D-107's held-diff boundary
     * mechanism means it can. `false` for a row written before `interrupted` existed
     * (the column predates it) — the same "cannot tell, so do not guess" stance
     * `unavailableForTier` already takes one field up, chosen over `true` because an
     * old row is far more likely to be a genuine clean run than a killed one, and
     * this call site's only use of it is to WITHHOLD trust, never to grant it.
     *
     * WALKS BACK PAST ANY NUMBER OF `reused` ROWS to the outcome underneath them —
     * found by lore's own review of the fix directly above, fingerprint 1f8b0b2d:
     * a reusing round always closes its OWN row `reused` (D-102 — the operator
     * board must see that, not `interrupted`), so `interrupted` carried only ONE
     * hop: the SECOND consecutive reuse read the first reuse's own row, whose
     * outcome says `reused`, not the `interrupted` truth two rows back. D-92
     * measured `reused` at roughly a fifth of all rounds, so a chain longer than
     * one is the ordinary case, not an edge one. `unavailable`/`unavailableForTier`
     * /`engines` do not need this — a reuse round already copies them forward
     * verbatim (see the `t0 = {...}` reuse branch in reviewer/review.ts) — only
     * `outcome`, which a reuse round deliberately overwrites for the board.
     */
    readonly interrupted: boolean;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT tree_hash, unavailable, unavailable_for_tier, engines,
           (SELECT t2.outcome FROM tier_run t2
            WHERE t2.review_id = t1.review_id AND t2.tier = 't0' AND t2.id <= t1.id AND t2.outcome != 'reused'
            ORDER BY t2.id DESC LIMIT 1) AS underlying_outcome
         FROM tier_run t1
         WHERE t1.review_id = ? AND t1.tier = 't0' AND t1.finished_at IS NOT NULL AND t1.tree_hash IS NOT NULL
         ORDER BY t1.id DESC LIMIT 1`,
      )
      .get(reviewId) as Record<string, string | null> | undefined;
    const treeHash = row?.["tree_hash"];
    if (treeHash === undefined || treeHash === null) return undefined;
    const lines = (v: string | null | undefined): readonly string[] => (v ?? "").split("\n").filter((l) => l.length > 0);
    const client = lines(row?.["unavailable"]);
    // NULL IS "UNKNOWN", NEVER "THE SAME AS THE CLIENT'S". An empty string is a recorded
    // answer meaning nothing to tell the reviewer; NULL is a row from before the split,
    // and the caller must re-derive rather than guess — see the field's own note.
    const stored = row?.["unavailable_for_tier"] ?? null;
    const forTier = stored === null ? undefined : lines(stored);
    return {
      treeHash,
      unavailable: client,
      unavailableForTier: forTier,
      engines: row?.["engines"] ?? undefined,
      interrupted: row?.["underlying_outcome"] === "interrupted",
    };
  }

  unavailableChecks(reviewId: string): readonly string[] {
    const rows = this.db
      .prepare("SELECT unavailable FROM tier_run WHERE review_id = ? AND unavailable IS NOT NULL ORDER BY id")
      .all(reviewId) as { unavailable: string }[];
    return [...new Set(rows.flatMap((r) => r.unavailable.split("\n")).filter((l) => l.length > 0))];
  }

  recordTierRun(
    reviewId: string,
    tier: string,
    round: number,
    outcome: TierOutcome,
    startedAt: string,
    treeHash?: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO tier_run(review_id, tier, round, outcome, tree_hash, started_at, finished_at)" +
          " VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(reviewId, tier, round, outcome, n(treeHash), startedAt, now());
  }

  // --------------------------------------------------------------- finding

  /**
   * Record a finding, idempotently.
   *
   * A re-raise of a finding already on file is not new work, so the first sighting
   * wins and `first_seen` is preserved. Returns whether this was genuinely new.
   */
  recordFinding(reviewId: string, f: RecordedFinding): boolean {
    // THIS DOES NOT WAKE ANYONE, and the reasoning is worth keeping because the first
    // version did.
    //
    // A round records its findings in one synchronous burst, so N findings meant N
    // notifications within milliseconds — and the shipped instruction is to poll on
    // each wake, where the first poll returns all N (deltas) and the rest return
    // nothing. N-1 client turns spent to learn nothing, which is the same waste this
    // file refuses for a re-raised finding, one level along.
    //
    // And the client could not have acted on any of them: D-55 refuses a submit while
    // the round is running, so a mid-round wake tells a client something it must sit
    // on until the round ends. The round END is a state change to `findings_ready`,
    // and `updateReview` publishes that. So a wake means exactly one thing — the
    // review's state changed — which is the only thing a client can act on.
    const res = this.db
      .prepare(
        `INSERT INTO finding(review_id, fingerprint, file, line, symbol, severity, claim, evidence,
                             failure_scenario, cwe, origin, round, first_seen, scope_blob, scope_hunk,
                             preexisting)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(review_id, fingerprint) DO NOTHING`,
      )
      .run(
        reviewId,
        f.fingerprint,
        f.file,
        n(f.line),
        n(f.symbol),
        f.severity,
        f.claim,
        f.evidence,
        f.failureScenario,
        n(f.cwe),
        f.origin,
        f.round,
        f.firstSeen,
        n(f.scope?.blob),
        n(f.scope?.hunk),
        f.preexisting === true ? 1 : 0,
      );
    return res.changes > 0;
  }

  /**
   * Findings not yet handed to the client — `poll` returns deltas, never repeats.
   *
   * Worst first (`FINDING_ORDER_SQL`). This is the list `review_poll`, `review_inbox`
   * and the CLI all render, and a client that reads only the top of it must be
   * reading the worst of it.
   */
  /**
   * Every finding this review raised, delivered or not, worst first.
   *
   * `undelivered` is the loop's query — deltas, so a client is never shown the same
   * finding twice. This is the HANDOVER query: a cancelled review hands over
   * everything it found, because the client stopping may not be the one that polled,
   * and "you already saw that one" is the wrong answer when the review is ending and
   * will never be polled again.
   */
  allFindings(reviewId: string): readonly RecordedFinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM finding WHERE review_id = ? ORDER BY ${FINDING_ORDER_SQL}`)
      .all(reviewId) as Record<string, string | number | null>[];
    return rows.map(toFinding);
  }

  undelivered(reviewId: string): readonly RecordedFinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM finding WHERE review_id = ? AND delivered_at IS NULL ORDER BY ${FINDING_ORDER_SQL}`)
      .all(reviewId) as Record<string, string | number | null>[];
    return rows.map(toFinding);
  }

  markDelivered(reviewId: string, fingerprints: readonly string[]): void {
    const stmt = this.db.prepare(
      "UPDATE finding SET delivered_at = ? WHERE review_id = ? AND fingerprint = ?",
    );
    const t = now();
    for (const fp of fingerprints) stmt.run(t, reviewId, fp);
  }

  /**
   * Findings nothing has settled yet. Worst first, for the same reason as
   * `undelivered` — and because an unordered query lets SQLite pick a different plan
   * and hand back a different order for the same data, which makes any downstream
   * "take the first N" silently non-deterministic.
   */
  openFindings(reviewId: string): readonly RecordedFinding[] {
    const rows = this.db
      .prepare(
        `SELECT f.* FROM finding f
         WHERE f.review_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM verdict v
             WHERE v.review_id = f.review_id AND v.fingerprint = f.fingerprint
               -- The LATEST verdict, matching settledFingerprints. Without this it
               -- matched ANY historical row, so a justification that was accepted and
               -- later REJECTED — which is exactly what expireStaleVerdicts writes
               -- when the code moves — still excluded the finding here while
               -- settledFingerprints correctly stopped counting it settled. Neither
               -- open nor settled: the livelock review.ts:427 describes.
               AND v.id = (SELECT MAX(id) FROM verdict w
                           WHERE w.review_id = v.review_id AND w.fingerprint = v.fingerprint)
               AND v.verdict IN (${SETTLING_VERDICTS.map((v) => `'${v}'`).join(", ")})
           )
         ORDER BY ${FINDING_ORDER_SQL}`,
      )
      .all(reviewId) as Record<string, string | number | null>[];
    return rows.map(toFinding);
  }

  /**
   * Resolve the short id from a `lore-ok[…]` comment, or `undefined` if this review
   * raised no such finding.
   *
   * **No match is not an error, and this used to throw.** A source tree accumulates
   * `lore-ok` comments from every review that ever ran against it, and a fingerprint
   * belongs to the review that raised it — so a justification accepted last week
   * matches nothing this week, which is the normal steady state rather than a fault.
   * Throwing meant the SECOND review of any repo using the feature died, and lore's
   * own docs (which carry `lore-ok[a1b2c3d4]` as the format example) killed the first
   * one. Found by running the loop; no unit test would have posed the question.
   *
   * Ambiguity is still an error, never a guess. Picking a winner would close a defect
   * nobody examined (spec/review-ladder.md §3.1.2) — git's rule for short object ids,
   * for the same reason.
   */
  resolveShort(reviewId: string, short: string): string | undefined {
    const rows = this.db
      .prepare("SELECT fingerprint FROM finding WHERE review_id = ? AND fingerprint LIKE ?")
      .all(reviewId, `${short}%`) as Record<string, string>[];
    const matches = rows.map((r) => r["fingerprint"] ?? "");
    if (matches.length === 0) return undefined;
    if (matches.length > 1) throw new AmbiguousFingerprint(short, matches);
    return matches[0] ?? "";
  }

  /**
   * Has any review of this repository ever raised a finding with this short prefix?
   *
   * **Tells a HISTORICAL marker from a typo**, which the round could not do before and
   * which is the whole difference between a useful log line and noise. A `lore-ok`
   * written into the source is permanent: the review that earned it ends, the marker
   * stays, and every later round finds it matching nothing in ITS review and said so.
   * 66 of them in this tree and rising with every justification anyone writes —
   * measured, 18 of 29 log lines in three hours, in the log the oversize warning and
   * the knowledge counts share. A log nobody reads is where a "did not run" hides,
   * which this project has now been bitten by twice in one day.
   *
   * A marker matching nothing ANYWHERE is the case worth naming individually: a typo,
   * or an agent believing it answered a finding it never touched.
   */
  shortKnownToRepo(repoId: string, short: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM finding f JOIN review r ON r.id = f.review_id
           WHERE r.repo_id = ? AND f.fingerprint LIKE ? LIMIT 1`,
        )
        .get(repoId, `${short}%`) !== undefined
    );
  }

  /**
   * Every finding this repository has raised, with the verdict that settled it.
   *
   * The input to recurrence derivation. `verdict` is the LATEST one, because a
   * justification accepted and later rejected is a different lesson from one that
   * stood, and a cluster nobody has answered teaches nothing yet.
   */
  findingsWithVerdict(repoId: string): readonly { readonly cwe: string | undefined; readonly claim: string; readonly file: string; readonly verdict: string | undefined }[] {
    const rows = this.db
      .prepare(
        `SELECT f.cwe AS cwe, f.claim AS claim, f.file AS file,
                (SELECT v.verdict FROM verdict v
                  WHERE v.review_id = f.review_id AND v.fingerprint = f.fingerprint
                  ORDER BY v.id DESC LIMIT 1) AS verdict
         FROM finding f JOIN review r ON r.id = f.review_id
         WHERE r.repo_id = ?`,
      )
      .all(repoId) as Record<string, string | null>[];
    return rows.map((r) => ({
      cwe: un(r["cwe"] ?? null),
      claim: r["claim"] ?? "",
      file: r["file"] ?? "",
      verdict: un(r["verdict"] ?? null),
    }));
  }

  /**
   * Has a rule from this source EVER existed for this repository — live or retired.
   *
   * lore-ok[b04fcd4e]: was `retired_at IS NULL`, found wrong by lore's own review and
   * reproduced directly — `promoteRecurring` (`derive.ts`), this method's one caller,
   * uses it purely as an idempotence guard ("did I already promote this cluster"),
   * and a `mistake` row's only real retirement path is `resolveConflict`, a person or
   * model DELIBERATELY deciding the derived lesson lost against another rule. Filtering
   * to live rows made that decision self-undoing: the very next `promoteRecurring` (every
   * review runs it) saw no live row, concluded the cluster had never been promoted, and
   * silently re-inserted the identical statement — verified directly, with a brand new
   * id, re-arming whatever it had just been resolved against. A `mistake` row is never
   * retired by `retireForChangedBlob` (its `sourceBlob` is always undefined) or
   * `retirePolicy` (`kind` is never `policy`), so "ever existed" and "a person decided
   * against it" are the same fact for this caller — dropping the liveness filter closes
   * the gap without weakening anything else, since nothing else calls this.
   */
  hasKnowledgeFrom(repoId: string, provenance: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM knowledge WHERE repo_id = ? AND provenance = ? LIMIT 1")
        .get(repoId, provenance) !== undefined
    );
  }

  /**
   * Candidate findings LIKE this one, elsewhere in this repo.
   *
   * Matched on the normalised claim OR the CWE, not the fingerprint: the same defect in
   * another file is the same lesson described differently, and the fingerprint cannot
   * see that (D-44). But a CWE alone is a WEAK signal — CWE-20 spans nearly any
   * input-validation defect in the repo — so this deliberately over-fetches and
   * returns the claim text uninterpreted rather than a count. The caller (`enrich.ts`'s
   * `sameDefectPriors`) corroborates a CWE-only match against claim-text similarity
   * before counting it as a real prior; a normalised-claim match needs no further
   * corroboration since it is already the tight comparison. The current finding is
   * excluded, so "prior" means what it says.
   *
   * lore-ok[4029f8b3]: found real by lore's own review — this used to be two methods
   * (`countPriorLike`, `priorVerdictsLike`) that returned a raw count and a raw verdict
   * list respectively, with no way for the caller to tell a genuine repeat from two
   * findings that share nothing but a broad CWE. A repo with 40 unrelated CWE-754
   * findings turned a brand-new, never-before-seen finding into "raised 40× ...
   * justified away N× — the check itself may be wrong here. TELL YOUR USER" — fabricated
   * pattern evidence off findings that had nothing to do with each other. Returning the
   * claim text lets the caller require actual similarity, not just a shared taxonomy
   * entry.
   */
  priorLike(repoId: string, fingerprint: string, normalizedClaim: string, cwe: string | undefined): readonly PriorFinding[] {
    const rows = this.db
      .prepare(
        `SELECT fi.claim AS claim,
                (SELECT v.verdict FROM verdict v
                 WHERE v.fingerprint = fi.fingerprint AND v.review_id = fi.review_id
                 ORDER BY v.id DESC LIMIT 1) AS verdict
         FROM finding fi
         JOIN review r ON r.id = fi.review_id
         WHERE r.repo_id = ?
           AND fi.fingerprint != ?
           AND (LOWER(TRIM(fi.claim)) = ? OR (fi.cwe IS NOT NULL AND fi.cwe = ?))`,
      )
      .all(repoId, fingerprint, normalizedClaim, cwe ?? " ") as { claim: string; verdict: string | null }[];
    return rows.map((r) => ({ claim: r.claim, verdict: r.verdict ?? undefined }));
  }

  /**
   * Every finding of a review, worst first, WITH ITS COLUMNS NAMED.
   *
   * `SELECT *` built `lore://review/{id}` and the VEX document, which made the
   * client-facing shape of both a function of the schema: every column a future
   * migration adds would have shipped to every client silently, without anyone deciding
   * to publish it. `token_hash` landing on a review row is the near miss that makes the
   * point — it is one join away from this table.
   *
   * The field names are exactly what `SELECT *` produced, deliberately: this pins the
   * published shape rather than changing it, so no client sees anything different
   * today, and adding a column is now a decision instead of an accident.
   */
  findingRowsForReview(reviewId: string): readonly Record<string, string | number | null>[] {
    return this.db
      .prepare(
        `SELECT review_id, fingerprint, file, line, symbol, severity, claim, evidence,
                failure_scenario, cwe, origin, preexisting, round, first_seen, delivered_at,
                scope_blob, scope_hunk
         FROM finding WHERE review_id = ? ORDER BY ${FINDING_ORDER_SQL}`,
      )
      .all(reviewId) as Record<string, string | number | null>[];
  }

  /** Spend and call count per tier since a moment — the operator's cost view. */
  spendByTierSince(sinceIso: string): readonly { readonly tier: string; readonly usd: number; readonly calls: number }[] {
    const rows = this.db
      .prepare(
        `SELECT tier, COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls
         FROM usage WHERE at >= ? GROUP BY tier ORDER BY usd DESC`,
      )
      .all(sinceIso) as Record<string, string | number | bigint>[];
    return rows.map((r) => ({
      tier: String(r["tier"] ?? ""),
      usd: Number(r["usd"] ?? 0),
      calls: Number(r["calls"] ?? 0),
    }));
  }

  /** A repository by name or id, for a command that took whichever the operator typed. */
  repoByNameOrId(nameOrId: string): RepoRow | undefined {
    const row = this.db
      .prepare("SELECT id, name, git_url FROM repo WHERE name = ? OR id = ?")
      .get(nameOrId, nameOrId) as Record<string, string> | undefined;
    if (row === undefined) return undefined;
    return { id: row["id"] ?? "", name: row["name"] ?? "", gitUrl: row["git_url"] ?? "" };
  }

  /** Reviews that have not finished — what `propose` refuses to compete with. */
  reviewsInFlight(): readonly { readonly id: string; readonly branch: string }[] {
    const rows = this.db
      .prepare("SELECT id, branch FROM review WHERE state IN ('queued', 'running', 'fast_clean')")
      .all() as Record<string, string>[];
    return rows.map((r) => ({ id: r["id"] ?? "", branch: r["branch"] ?? "" }));
  }

  /** Which tier first raised this finding, for deciding whether a re-raise is stronger. */
  originOfFinding(reviewId: string, fingerprint: string): string | undefined {
    const row = this.db
      .prepare("SELECT origin FROM finding WHERE review_id = ? AND fingerprint = ?")
      .get(reviewId, fingerprint) as Record<string, string> | undefined;
    return row?.["origin"];
  }

  /** How many findings a review raised, and how its verdicts settled — for the attestation. */
  findingCount(reviewId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM finding WHERE review_id = ?")
      .get(reviewId) as Record<string, number | bigint> | undefined;
    return Number(row?.["c"] ?? 0);
  }

  /**
   * Verdict counts by kind, per FINDING and by its LATEST verdict.
   *
   * The same rule `settledFingerprints` uses. Counting verdict rows was wrong twice over
   * and the first attestation ever produced showed both: verdicts are append-only, so a
   * justification carried across rounds counted repeatedly, and one later overturned
   * counted as both.
   */
  latestVerdictCounts(reviewId: string): readonly { readonly verdict: string; readonly c: number }[] {
    const rows = this.db
      .prepare(
        `SELECT v.verdict, COUNT(*) AS c FROM verdict v
         WHERE v.review_id = ?
           AND v.id = (SELECT MAX(id) FROM verdict w WHERE w.review_id = v.review_id AND w.fingerprint = v.fingerprint)
         GROUP BY v.verdict`,
      )
      .all(reviewId) as Record<string, string | number | bigint>[];
    return rows.map((r) => ({ verdict: String(r["verdict"] ?? ""), c: Number(r["c"] ?? 0) }));
  }

  /** How many DISTINCT tiers ran — what an attestation may claim looked at the code. */
  tiersThatRan(reviewId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT tier) AS c FROM tier_run WHERE review_id = ?")
      .get(reviewId) as Record<string, number | bigint> | undefined;
    return Number(row?.["c"] ?? 0);
  }

  /** A review's branch, repo and remote — what the worker needs to cut a worktree. */
  reviewLocation(reviewId: string): { readonly branch: string; readonly repoId: string; readonly gitUrl: string } | undefined {
    const row = this.db
      .prepare("SELECT r.branch, r.repo_id, p.git_url FROM review r JOIN repo p ON p.id = r.repo_id WHERE r.id = ?")
      .get(reviewId) as Record<string, string> | undefined;
    if (row === undefined) return undefined;
    return { branch: row["branch"] ?? "", repoId: row["repo_id"] ?? "", gitUrl: row["git_url"] ?? "" };
  }

  /** Who a review belongs to. The worker acts for whoever owns it. */
  principalOf(reviewId: string): string | undefined {
    const row = this.db.prepare("SELECT principal FROM review WHERE id = ?").get(reviewId) as
      | Record<string, string>
      | undefined;
    return row?.["principal"];
  }

  /** A repository's remote. */
  gitUrlOf(repoId: string): string | undefined {
    const row = this.db.prepare("SELECT git_url FROM repo WHERE id = ?").get(repoId) as
      | Record<string, string>
      | undefined;
    return row?.["git_url"];
  }

  /**
   * Reviews holding findings nobody has collected — `/status`'s uncollected section.
   *
   * `r.state NOT IN (PERSON_OR_CLOCK_DECIDED_SQL)` — the same fix as
   * `ops/status.ts`'s ANSI rendering of this same fact (038955e5, found by lore's
   * own review of that file first): without it, an `expired` review's findings —
   * permanently uncollectible, a terminal review refuses a submit — stayed in this
   * JSON forever, the exact predicate `uncollectedHighOlderThan` (the heartbeat
   * ticket for the same fact) already excludes them from, for the same reason.
   *
   * `high`/`high_pre` SPLIT, matching `ops/status.ts`'s `uncollectedLines` and this
   * class's own `uncollectedHighOlderThan` (`f.preexisting = 0`) — found by lore's
   * own review, fingerprint be79f02a: this was the one representation of "uncollected
   * findings" left counting every `high` alike, so the JSON surface a monitor or
   * operator SCRIPT reads (unlike the other two, which a person reads) reported
   * inherited fixture noise — a branch whose only OWN finding is a `low`, plus two
   * inherited semgrep hits on test fixtures neither touch, is D-68's own example —
   * as branch-caused highs, alerting on the same known noise every day.
   */
  uncollectedByReview(): readonly Record<string, string | number | null>[] {
    return this.db
      .prepare(
        `SELECT r.id, r.branch,
                COUNT(*) AS undelivered,
                SUM(CASE WHEN f.severity = 'high' AND f.preexisting = 0 THEN 1 ELSE 0 END) AS high,
                SUM(CASE WHEN f.severity = 'high' AND f.preexisting = 1 THEN 1 ELSE 0 END) AS high_pre,
                MIN(f.first_seen) AS waiting_since
         FROM finding f JOIN review r ON r.id = f.review_id
         WHERE f.delivered_at IS NULL AND r.state NOT IN (${PERSON_OR_CLOCK_DECIDED_SQL})
         GROUP BY r.id, r.branch
         ORDER BY waiting_since`,
      )
      .all() as Record<string, string | number | null>[];
  }

  /** Reviews that have not reached a verdict, newest first. */
  reviewsUnfinished(limit = 50): readonly Record<string, string | null>[] {
    return this.db
      .prepare(
        `SELECT id, branch, state, type, updated_at FROM review
         WHERE state NOT IN (${TERMINAL_SQL})
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, string | null>[];
  }

  /** Finished reviews whose worktrees the sweep may release. */
  finishedBefore(iso: string): readonly Record<string, string>[] {
    return this.db
      .prepare(
        `SELECT id, repo_id, state FROM review
         WHERE state IN (${TERMINAL_SQL}) AND updated_at <= ?`,
      )
      .all(iso) as Record<string, string>[];
  }

  /**
   * Delete finished reviews older than a cutoff. Returns how many rows went.
   *
   * HELD DIFFS GO FIRST, EXPLICITLY, and this is not belt-and-braces. Every other
   * review-child table cascades; `held_diff` was created without `ON DELETE CASCADE`,
   * and `PRAGMA foreign_keys` is ON — so with `CREATE TABLE IF NOT EXISTS` unable to
   * retrofit the constraint, an existing database still has the un-cascading version
   * however the DDL now reads. A hold outliving its review is ordinary rather than
   * exotic: a client submits mid-round (told "held — you do not need to resubmit"),
   * then cancels, and nothing on any terminal path clears it. The first such review to
   * age past retention would fail this DELETE, abort the whole hourly sweep before it
   * closed jobs or collected sandboxes, ticket, and then do it again every hour for
   * ever — while no old review was deleted at all, since the statement rolls back whole.
   *
   * In one transaction, so the two deletes cannot half-happen.
   */
  deleteReviewsBefore(iso: string): number {
    return this.tx(() => {
      this.db
        .prepare(
          `DELETE FROM held_diff WHERE review_id IN
             (SELECT id FROM review WHERE state IN (${TERMINAL_SQL}) AND updated_at < ?)`,
        )
        .run(iso);
      const res = this.db
        .prepare(`DELETE FROM review WHERE state IN (${TERMINAL_SQL}) AND updated_at < ?`)
        .run(iso);
      return Number(res.changes);
    });
  }

  /** A review's repository and state, for deciding whether its worktree may be released. */
  repoAndStateOf(reviewId: string): { readonly repoId: string; readonly state: ReviewState } | undefined {
    const row = this.db.prepare("SELECT repo_id, state FROM review WHERE id = ?").get(reviewId) as
      | Record<string, string>
      | undefined;
    if (row === undefined) return undefined;
    return { repoId: row["repo_id"] ?? "", state: (row["state"] ?? "failed") as ReviewState };
  }

  // ----------------------------------------------------------------- token
  //
  // The token table's queries live here rather than in `mcp/auth.ts` for the same reason
  // every other query does — one place that knows the schema — and for one specific to
  // credentials: a `SELECT *` over this table would put a hash into whatever the caller
  // does next. Every method below names its columns.

  insertToken(hash: string, principal: string, repoId: string, label: string | undefined): void {
    this.db
      .prepare("INSERT INTO token(hash, principal, repo_id, label, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(hash, principal, repoId, n(label), now());
  }

  /**
   * Every live token's hash and what it is scoped to.
   *
   * Returns them ALL, because the comparison that follows is timing-safe and a
   * `WHERE hash = ?` would leak through the query planner what a constant-time compare
   * exists to hide.
   */
  liveTokens(): readonly { readonly hash: string; readonly principal: string; readonly repoId: string }[] {
    const rows = this.db
      .prepare("SELECT hash, principal, repo_id FROM token WHERE revoked_at IS NULL")
      .all() as Record<string, string>[];
    return rows.map((r) => ({ hash: r["hash"] ?? "", principal: r["principal"] ?? "", repoId: r["repo_id"] ?? "" }));
  }

  /** Who holds a token, for what, and whether it still works — the operator's view. */
  tokensWithRepo(): readonly Record<string, string | null>[] {
    return this.db
      .prepare(
        "SELECT t.hash, t.principal, t.label, t.created_at, t.revoked_at, r.name AS repo" +
          " FROM token t LEFT JOIN repo r ON r.id = t.repo_id ORDER BY t.created_at",
      )
      .all() as Record<string, string | null>[];
  }

  /** Tokens whose hash starts with this prefix. Several means the prefix is ambiguous. */
  tokensByPrefix(prefix: string): readonly Record<string, string | null>[] {
    return this.db
      .prepare(
        "SELECT t.hash, t.principal, t.revoked_at, r.name AS repo FROM token t" +
          " LEFT JOIN repo r ON r.id = t.repo_id WHERE t.hash LIKE ?",
      )
      .all(`${prefix.toLowerCase()}%`) as Record<string, string | null>[];
  }

  revokeTokenByHash(hash: string): void {
    this.db.prepare("UPDATE token SET revoked_at = ? WHERE hash = ?").run(now(), hash);
  }

  // --------------------------------------------------------------- verdict

  recordVerdict(reviewId: string, v: Omit<VerdictRow, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO verdict(review_id, fingerprint, verdict, rationale, scope_blob, scope_hunk, tier, round,
                             via_rule, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reviewId,
        v.fingerprint,
        v.verdict,
        n(v.rationale),
        n(v.scope?.blob),
        n(v.scope?.hunk),
        n(v.tier),
        n(v.round),
        n(v.viaRule),
        now(),
      );
  }

  latestVerdict(reviewId: string, fingerprint: string): VerdictRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM verdict WHERE review_id = ? AND fingerprint = ? ORDER BY id DESC LIMIT 1",
      )
      .get(reviewId, fingerprint) as Record<string, string | number | null> | undefined;
    if (row === undefined) return undefined;
    const blob = row["scope_blob"];
    const hunk = row["scope_hunk"];
    return {
      fingerprint: String(row["fingerprint"] ?? ""),
      verdict: String(row["verdict"] ?? "fixed") as VerdictKind,
      rationale: un(row["rationale"] as string | null) ?? undefined,
      scope:
        typeof blob === "string" && typeof hunk === "string" ? { blob, hunk } : undefined,
      tier: un(row["tier"] as string | null) ?? undefined,
      round: un(row["round"] as number | null) ?? undefined,
      viaRule: un(row["via_rule"] as string | null) ?? undefined,
      createdAt: String(row["created_at"] ?? ""),
    };
  }

  /**
   * The last accepted justification for this fingerprint **anywhere in this repo**,
   * from a review other than the one asking.
   *
   * This is what makes an accepted justification durable rather than per-review, and
   * it is the product premise: *"an accepted justification becomes durable
   * knowledge."* Without it, a reason ratified last week matched nothing this week —
   * fingerprints belong to the review that raised them — so every new review
   * re-raised every settled finding and the author re-submitted the same comment
   * forever. Observed, not theorised: a `lore-ok` accepted in one review was ignored
   * by the next review's first round.
   *
   * Only `justified-accepted` carries. `fixed` does not: that verdict says the code
   * changed, and if the same fingerprint is raised again the code evidently did not
   * stay fixed. A rejected one obviously does not carry either.
   *
   * The SCOPE comes back with it, and the caller must check staleness before
   * honouring it. A reason is about a piece of code, so it survives exactly as long
   * as that code does — carrying one forward without that check is how a ladder rots
   * into rubber-stamping.
   */
  priorAcceptedVerdict(repoId: string, fingerprint: string, exceptReviewId: string): VerdictRow | undefined {
    const row = this.db
      .prepare(
        `SELECT v.* FROM verdict v
         JOIN review r ON r.id = v.review_id
         WHERE r.repo_id = ? AND v.fingerprint = ? AND v.review_id <> ?
           AND v.id = (SELECT MAX(id) FROM verdict w WHERE w.review_id = v.review_id AND w.fingerprint = v.fingerprint)
           AND v.verdict = 'justified-accepted'
         ORDER BY v.id DESC LIMIT 1`,
      )
      .get(repoId, fingerprint, exceptReviewId) as Record<string, string | number | null> | undefined;
    if (row === undefined) return undefined;
    const blob = row["scope_blob"];
    const hunk = row["scope_hunk"];
    return {
      fingerprint: String(row["fingerprint"] ?? ""),
      verdict: String(row["verdict"] ?? "justified-accepted") as VerdictKind,
      rationale: un(row["rationale"] as string | null) ?? undefined,
      scope: typeof blob === "string" && typeof hunk === "string" ? { blob, hunk } : undefined,
      tier: un(row["tier"] as string | null) ?? undefined,
      round: un(row["round"] as number | null) ?? undefined,
      viaRule: un(row["via_rule"] as string | null) ?? undefined,
      createdAt: String(row["created_at"] ?? ""),
    };
  }

  /**
   * Fingerprints considered settled: fixed, or justified and accepted.
   *
   * Only the **latest** verdict counts. Verdicts are append-only, so matching any
   * historical row would mean a justification that was accepted and then rejected
   * — or expired because its code changed — stayed settled forever, which is
   * exactly the rubber-stamping this design exists to prevent.
   */
  settledFingerprints(reviewId: string): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT v.fingerprint FROM verdict v
         WHERE v.review_id = ?
           AND v.id = (SELECT MAX(id) FROM verdict w WHERE w.review_id = v.review_id AND w.fingerprint = v.fingerprint)
           AND v.verdict IN (${SETTLING_VERDICTS.map((v) => `'${v}'`).join(", ")})`,
      )
      .all(reviewId) as Record<string, string>[];
    return rows.map((r) => r["fingerprint"] ?? "");
  }

  // ------------------------------------------------------------- knowledge

  addKnowledge(k: Omit<KnowledgeItem, "id" | "verifiedAt"> & { id?: string }): KnowledgeItem {
    const item: KnowledgeItem = { ...k, id: k.id ?? randomUUID(), verifiedAt: now() };
    this.db
      .prepare(
        `INSERT INTO knowledge(id, repo_id, kind, source, statement, why, path, cwe, provenance,
                               source_blob, extractor, confidence, verified_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.repoId,
        item.kind,
        item.source,
        item.statement,
        n(item.why),
        n(item.path),
        n(item.cwe),
        n(item.provenance),
        n(item.sourceBlob),
        n(item.extractor),
        n(item.confidence),
        item.verifiedAt,
      );
    return item;
  }

  /**
   * A candidate the screen threw away, written as a row that is BORN RETIRED.
   *
   * The whole objection to filtering a knowledge base is that a rule which never arrives
   * is invisible: nobody knows it is missing, and reading the document again will not
   * bring it back, because the reader that mined it also refused it. So the refusal is a
   * row — never live, never shown to a reviewer, never counted — carrying the statement
   * and the model's reason, so *"why is that rule not in the base"* has an answer an
   * operator can query.
   *
   * `retired_reason` is prefixed rather than given its own column: every other retirement
   * writes its reason there and the operator views already read it, and a second column
   * would be a second thing to remember to look at.
   */
  recordScreenedOut(item: Omit<KnowledgeItem, "id" | "verifiedAt">, because: string): void {
    const at = now();
    // ONE ROW PER REFUSED STATEMENT, NOT ONE PER TIME IT WAS REFUSED.
    //
    // A document is re-ingested whenever it changes, so a statement the screen keeps
    // rejecting was recorded again on every edit — and nothing collected the old copies,
    // because `retireForChangedBlob` only touches rows that are still live and these are
    // born retired. Measured after a single afternoon: 23 rows for 15 distinct
    // statements, three copies of some, on files edited most sessions. The same
    // unbounded shape as the livelock that once wrote 21 duplicate derived rules.
    //
    // The newest reason wins, which is the one worth keeping: it came from the current
    // reader and the current wording of the document.
    this.db
      .prepare(
        "DELETE FROM knowledge WHERE repo_id = ? AND provenance IS ? AND statement = ? AND retired_reason LIKE 'screened out:%'",
      )
      .run(item.repoId, n(item.provenance), item.statement);
    this.db
      .prepare(
        `INSERT INTO knowledge(id, repo_id, kind, source, statement, why, path, cwe, provenance,
                               source_blob, extractor, confidence, verified_at, retired_at, retired_reason)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        item.repoId,
        item.kind,
        item.source,
        item.statement,
        n(item.why),
        n(item.path),
        n(item.cwe),
        n(item.provenance),
        n(item.sourceBlob),
        n(item.extractor),
        n(item.confidence),
        at,
        at,
        `screened out: ${because}`,
      );
  }

  /**
   * When this database last recorded anything, in its own timestamps.
   *
   * **The question the replica monitor actually needs**, and not the one it was asking.
   * It compared the newest replica file against `max(mtime(lore.db), mtime(lore.db-wal))`
   * — and SQLite touches `-wal` on open and on checkpoint, not only on commit. A restart
   * therefore moved it with no transaction behind it, and `/status` reported
   * "replica 14m behind" while litestream's own log said `txid.replica == txid.db` on
   * every sync. Measured 2026-08-07, and it pointed an operator at a healthy replicator
   * during the twenty minutes the DATABASE was unreadable.
   *
   * These are lore's own written timestamps, so they move when and only when something
   * was actually recorded — which is exactly the event litestream would have a new
   * segment for. Idle database: both sides freeze, level. Dead replicator with writes
   * continuing: this advances and the replica does not, behind. Both correct, and the
   * touched-WAL case that cried wolf produces no movement at all.
   *
   * `undefined` for a database nothing has ever been written to.
   */
  lastWriteAt(): string | undefined {
    // EVERY TIMESTAMP COLUMN, because the claim above is only true if the list is
    // complete — and a TABLE-shaped list is not the same thing. `finding` was named and
    // `delivered_at` still missed, which is the column `markDelivered` writes on every
    // poll: the single most frequent write this service makes. It named five and missed five kinds of write outright: issuing or
    // revoking a token, retiring knowledge, opening or resolving a conflict, recording a
    // verdict, and accepting an appeal. A workgroup can spend an afternoon doing nothing
    // but answering findings — all verdicts — and this would not move, so a dead
    // replicator would read as level throughout. The monitor's whole job is to notice
    // that, and it was blind to the writes a review actually produces most of.
    const row = this.db
      .prepare(
        `SELECT MAX(t) AS t FROM (
           SELECT MAX(updated_at) t FROM review
           UNION ALL SELECT MAX(updated_at) FROM job
           UNION ALL SELECT MAX(verified_at) FROM knowledge
           UNION ALL SELECT MAX(retired_at) FROM knowledge
           UNION ALL SELECT MAX(at) FROM usage
           UNION ALL SELECT MAX(first_seen) FROM finding
           UNION ALL SELECT MAX(delivered_at) FROM finding
           UNION ALL SELECT MAX(created_at) FROM verdict
           UNION ALL SELECT MAX(created_at) FROM token
           UNION ALL SELECT MAX(revoked_at) FROM token
           UNION ALL SELECT MAX(created_at) FROM knowledge_conflict
           UNION ALL SELECT MAX(resolved_at) FROM knowledge_conflict
           UNION ALL SELECT MAX(accepted_at) FROM suppression
           UNION ALL SELECT MAX(started_at) FROM tier_run
           UNION ALL SELECT MAX(created_at) FROM repo
         )`,
      )
      .get() as { t: string | null } | undefined;
    return row?.t ?? undefined;
  }

  /**
   * Could a NEW reader open this database and read it?
   *
   * **Asked on a fresh connection, and that is the whole point.** SQLite serves an open
   * connection from its page cache, so a long-lived process can go on answering from
   * memory while the file beneath it is unreadable — which is exactly what happened on
   * 2026-08-07: `/status` kept replying for twenty minutes while every new connection
   * (`make mirror`, a shell query, a restart) failed with `database disk image is
   * malformed`. A check on the live handle reproduced that and reported clean, so it
   * would have shipped watching nothing.
   *
   * The question that matters is not "can I still read my cache" but "can anyone else
   * read this file" — litestream, the next process, a restore. That is a new reader.
   *
   * `quick_check` rather than `integrity_check`: it skips the index-versus-table
   * cross-check, the part whose cost grows with the data, and still catches every
   * structural fault — 7ms against 10ms on the live 3 MB file, both trivial today and
   * only one of them still trivial at a hundred times the size. `make db-check` remains
   * the thorough one, for when somebody is asking deliberately.
   *
   * Returns the fault, or `undefined` when it is fine. It THROWS nothing: a corrupt
   * database makes every statement fail, including this one, and a health check that
   * dies rather than reporting is the failure it exists to catch wearing another hat.
   */
  integrityFault(): string | undefined {
    // An in-memory database has no file for a second reader to open, and opening the
    // name again would make a different, empty one — which would report a clean bill
    // about something that is not this store. Ask the live handle instead.
    if (this.path === ":memory:") return faultOf(() => this.db);

    let fresh: DatabaseSync | undefined;
    try {
      return faultOf(() => {
        fresh = new DatabaseSync(this.path, { readOnly: true });
        return fresh;
      });
    } finally {
      try {
        fresh?.close();
      } catch {
        // A corrupt database can fail to close. The answer is already computed.
      }
    }
  }

  /**
   * A development rule by short id, for an appeal that cited one (D-83).
   *
   * Ambiguity is REFUSED rather than resolved, exactly as `resolveShort` refuses an
   * ambiguous finding: silently picking one of two policies would let an appeal succeed
   * against a rule the author did not mean, and the reviewer would rule on the wrong
   * text with no sign anything had gone astray.
   */
  policyByShort(repoId: string, short: string): KnowledgeItem | undefined {
    const rows = this.db
      .prepare(
        "SELECT * FROM knowledge WHERE repo_id = ? AND kind = 'policy' AND retired_at IS NULL AND id LIKE ?",
      )
      .all(repoId, `${short}%`) as Record<string, string | number | null>[];
    if (rows.length !== 1) return undefined;
    return toKnowledge(rows[0] as Record<string, string | number | null>);
  }

  /**
   * `policyByShort`'s twin for ANY kind of knowledge row, not only `kind = 'policy'`
   * — found by lore's own review, fingerprint b1a9841c. `knowledge_resolve`'s
   * `keep`/`retire` name whichever two rows are in conflict, which are
   * document-derived facts and ADR-sourced rules (D-35's bootstrap ingestion),
   * never development rules — so `policyByShort`'s own `kind` filter would refuse
   * them outright, not just their short form.
   *
   * `resolveConflict` matched `keep`/`retire` with exact `=` — the one id-comparison
   * path in this file still exact after every OTHER one (`retirePolicy`,
   * `policyByShort`, the appeal grammar) was hardened to prefix matching this same
   * review. A client naturally holds the SAME rule in two lengths: `open_questions`
   * (`review_poll`/`review_inbox`) renders full ids, `knowledge_teach` returns both
   * a full `id` and an 8-char `cite_as`. Mixing them — full from one tool, short
   * from the other, the obvious thing to do with two ids for one rule — made every
   * `=` comparison fail silently as "no open conflict", for a `needs_human` review
   * that a person HAD in fact just decided.
   *
   * Same charset gate and same ambiguity handling as `retirePolicy`: `undefined`
   * covers both "matches nothing" and "matches more than one", collapsed exactly as
   * `policyByShort` already collapses them, since the caller's own refusal message
   * ("no open conflict between X and Y") is accurate either way.
   */
  knowledgeByShort(repoId: string, short: string): string | undefined {
    if (!/^[0-9a-f]{8}([0-9a-f-]*[0-9a-f])?$/i.test(short)) return undefined;
    const rows = this.db
      .prepare("SELECT id FROM knowledge WHERE repo_id = ? AND retired_at IS NULL AND id LIKE ?")
      .all(repoId, `${short}%`) as { id: string }[];
    if (rows.length !== 1) return undefined;
    return (rows[0] as { id: string }).id;
  }

  /**
   * Record that a tier accepted an appeal, for the whole (rule class, path) (D-83).
   *
   * `INSERT OR REPLACE` on the unique triple: re-accepting the same appeal refreshes
   * which review and tier stand behind it, rather than accumulating rows that all say
   * the same thing with different dates.
   */
  recordSuppression(s: {
    readonly repoId: string;
    readonly ruleClass: string;
    readonly path: string;
    readonly policyShort: string;
    readonly reviewId: string;
    readonly tier: string;
  }): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO suppression(repo_id, rule_class, path, policy_short, review_id, tier, accepted_at)" +
          " VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(s.repoId, s.ruleClass, s.path, s.policyShort, s.reviewId, s.tier, now());
  }

  /**
   * Suppressions that are still authorised, with the rule that authorises each.
   *
   * The JOIN is the mechanism, not an optimisation. A suppression is a check switched
   * off, and the only thing that makes that legitimate is a live development rule
   * saying so — so retiring the rule must switch the check back on, at the next review,
   * without anything sweeping the table. An `INNER JOIN` on live knowledge is how that
   * happens by construction rather than by a cleanup job somebody has to remember.
   *
   * A rule whose short id has since become ambiguous (a second policy created with the
   * same prefix) yields two rows and is refused below for the reason `policyByShort`
   * refuses it: silently applying the wrong rule's authority is worse than re-raising.
   */
  liveSuppressions(repoId: string): readonly {
    readonly ruleClass: string;
    readonly path: string;
    readonly policyShort: string;
    readonly statement: string;
    readonly acceptedAt: string;
    readonly tier: string;
  }[] {
    const rows = this.db
      .prepare(
        "SELECT s.rule_class, s.path, s.policy_short, s.accepted_at, s.tier, k.statement, COUNT(*) AS n" +
          " FROM suppression s JOIN knowledge k" +
          "   ON k.repo_id = s.repo_id AND k.kind = 'policy' AND k.retired_at IS NULL" +
          "   AND k.id LIKE s.policy_short || '%'" +
          " WHERE s.repo_id = ?" +
          " GROUP BY s.id" +
          " ORDER BY s.rule_class, s.path",
      )
      .all(repoId) as { rule_class: string; path: string; policy_short: string; accepted_at: string; tier: string; statement: string; n: number }[];
    return rows
      .filter((r) => Number(r.n) === 1)
      .map((r) => ({
        ruleClass: r.rule_class,
        path: r.path,
        policyShort: r.policy_short,
        statement: r.statement,
        acceptedAt: r.accepted_at,
        tier: r.tier,
      }));
  }

  /**
   * Is this development rule still standing?
   *
   * Asked of a verdict's `via_rule` before that verdict is carried into a new review.
   * The class suppression dies with its rule by construction — `liveSuppressions` joins —
   * but the individual acceptance the appeal earned would otherwise keep being carried
   * forward (D-51), so the one place the rule was actually argued would stay silent for
   * ever while `lore rule --retire` reported that every check now reports again.
   *
   * Only a verdict an APPEAL bought carries a `via_rule`. An ordinary justification was
   * argued on its own words with no rule beneath it, and carries forward exactly as it
   * always did — the first version of this asked whether the finding's rule CLASS and
   * PATH matched a revoked suppression, which also caught ordinary justifications that
   * happened to share a class and a file with somebody else's appeal.
   */
  isLivePolicy(repoId: string, short: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS live FROM knowledge WHERE repo_id = ? AND kind = 'policy' AND retired_at IS NULL" +
          " AND id LIKE ? LIMIT 1",
      )
      .get(repoId, `${short}%`) as Record<string, number> | undefined;
    return row !== undefined;
  }

  /**
   * Retire a development rule by short id, and say which of the four things happened.
   *
   * The suppressions it bought are NOT deleted, and that is deliberate: `liveSuppressions`
   * joins them to the live rule, so they stop applying the moment this row is retired,
   * and the rows stay readable as the record of a check that WAS off and why. Deleting
   * them would erase the only evidence that a review once did not cover something.
   *
   * a6a4b832/c7235bcb: found by lore's own review — `short` reached the `LIKE`
   * pattern below with no character gate, so `%` or `_` in it are SQL wildcards, not
   * literal text. With exactly one live policy, `short: "%%%%"` matched it and
   * retired a rule nobody identified, silently re-enabling every check it had
   * suppressed; with several, it made them all read as "ambiguous". Same gate as
   * the identical shape one module over (`revokeByPrefix`, mcp/auth.ts) —
   * ambiguity is refused, but a pattern that was never really a prefix must not
   * reach the query to be ambiguous or unique about.
   *
   * 16d21041/0234d575: the first version of this gate was hex-only, which rejects
   * the hyphens of a full `randomUUID()` — and a full id is not a hypothetical
   * caller error: `knowledge_teach`'s own reply hands one back as `id`, and the
   * appeal grammar (`core/lore-ok.ts`'s own comment: "a full uuid resolves as well
   * as its head") already accepts one for exactly this reason, via `policyByShort`
   * a few lines down, which matches on prefix with no charset gate of its own
   * because the `lore-ok[...]` PARSER already constrains what reaches it
   * (`[0-9a-f]{8}[0-9a-f-]*`) before it ever gets here — the same shape this gate
   * now matches directly, since this caller has no such upstream parser to lean
   * on. A caller retiring the exact id it was just handed must not be told no live
   * rule starts with its own id.
   *
   * 72313b18: THAT version still admitted a bare trailing hyphen — `"550e8400-"`
   * passed `[0-9a-f-]{0,28}` because a hyphen is in the class. Every real id has a
   * hyphen at position 9 (`randomUUID`'s own layout), so `LIKE '550e8400-%'`
   * matches exactly the same rows `LIKE '550e8400%'` does — the trailing hyphen
   * adds no precision, so a caller who typed it believing it narrowed the match
   * (a transcription that truncated a longer id at its first hyphen, say) gets a
   * result no different from having typed eight fewer characters, silently. The
   * suffix must now END in hex, never in a hyphen — still every real id and every
   * real prefix of one, never a pattern whose specificity is smaller than it looks.
   */
  retirePolicy(repoId: string, short: string, reason: string): "retired" | "not-found" | "ambiguous" {
    if (!/^[0-9a-f]{8}([0-9a-f-]*[0-9a-f])?$/i.test(short)) return "not-found";
    const rows = this.db
      .prepare("SELECT id FROM knowledge WHERE repo_id = ? AND kind = 'policy' AND retired_at IS NULL AND id LIKE ?")
      .all(repoId, `${short}%`) as { id: string }[];
    if (rows.length === 0) return "not-found";
    if (rows.length > 1) return "ambiguous";
    this.db
      .prepare("UPDATE knowledge SET retired_at = ?, retired_reason = ? WHERE id = ?")
      .run(now(), reason, (rows[0] as { id: string }).id);
    return "retired";
  }

  /** Every live development rule, with the short id an appeal cites it by. */
  policies(repoId: string): readonly KnowledgeItem[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM knowledge WHERE repo_id = ? AND kind = 'policy' AND retired_at IS NULL ORDER BY verified_at",
      )
      .all(repoId) as Record<string, string | number | null>[];
    return rows.map((r) => toKnowledge(r));
  }

  /** How many development rules this repository has — what the prompt indicates. */
  policyCount(repoId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM knowledge WHERE repo_id = ? AND kind = 'policy' AND retired_at IS NULL")
      .get(repoId) as Record<string, number> | undefined;
    return Number(row?.["c"] ?? 0);
  }

  /** Live rules for a repository, counted by where they came from. */
  liveKnowledgeBySource(repoId: string): readonly { readonly source: string; readonly n: number }[] {
    const rows = this.db
      .prepare(
        "SELECT source, COUNT(*) n FROM knowledge WHERE repo_id = ? AND retired_at IS NULL GROUP BY source ORDER BY source",
      )
      .all(repoId) as { source: string; n: number }[];
    return rows.map((r) => ({ source: r.source, n: Number(r.n) }));
  }

  /**
   * Kept against refused, per source document — the operator's view of the screen.
   *
   * COUNT(DISTINCT statement), not COUNT(*), and the difference is a factor of three. A
   * refusal is re-recorded every time its document changes and nothing collects the old
   * copies, so counting rows read `spec/mcp-api.md` as 69% refused when three statements
   * had been written three times each; the honest figure was 43%. A report whose first
   * number is wrong by that much is worse than no report.
   */
  knowledgeByDocument(repoId: string): readonly { readonly provenance: string; readonly kept: number; readonly refused: number }[] {
    const rows = this.db
      .prepare(
        `SELECT provenance,
                COUNT(DISTINCT CASE WHEN retired_at IS NULL THEN statement END) kept,
                COUNT(DISTINCT CASE WHEN retired_reason LIKE 'screened out:%' THEN statement END) refused
         FROM knowledge
         WHERE repo_id = ? AND source = 'ingested' AND provenance IS NOT NULL
         GROUP BY provenance
         HAVING kept > 0 OR refused > 0
         ORDER BY refused DESC, provenance`,
      )
      .all(repoId) as { provenance: string; kept: number; refused: number }[];
    return rows.map((r) => ({ provenance: r.provenance, kept: Number(r.kept), refused: Number(r.refused) }));
  }

  /**
   * What the screen threw away, and the reason it gave (D-81).
   *
   * The whole objection to filtering a memory is that a rule which never arrives is
   * invisible. These rows are the answer to that — and were unreadable outside a SQL
   * prompt until this existed, which made the guarantee worth about as much as not
   * having made it.
   */
  screenRefusals(repoId: string): readonly { readonly provenance: string; readonly statement: string; readonly because: string }[] {
    // ONE ROW PER STATEMENT, and `DISTINCT` over three columns is not that. A refusal is
    // re-recorded whenever its document changes, and the model words the reason freshly
    // each time — so distinct triples counted 40 where the tally beside it counted 15,
    // and a report that disagrees with itself in two adjacent lines is worse than none.
    // The same trap as `knowledgeByDocument`, one function away, caught by reading the
    // two numbers together. MAX() picks the most recent wording arbitrarily but
    // consistently; every copy says the same thing in different words.
    const rows = this.db
      .prepare(
        `SELECT COALESCE(provenance, '?') provenance, statement, MAX(retired_reason) retired_reason
         FROM knowledge
         WHERE repo_id = ? AND retired_reason LIKE 'screened out:%'
         GROUP BY provenance, statement
         ORDER BY provenance, statement`,
      )
      .all(repoId) as { provenance: string; statement: string; retired_reason: string }[];
    return rows.map((r) => ({
      provenance: r.provenance,
      statement: r.statement,
      because: r.retired_reason.replace(/^screened out: /, ""),
    }));
  }

  /** Documents whose rules were kept WITHOUT a screen passing them — degraded, healing. */
  unscreenedDocuments(repoId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(DISTINCT provenance) n FROM knowledge WHERE repo_id = ? AND retired_at IS NULL AND extractor LIKE '%-unscreened'",
      )
      .get(repoId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Live knowledge for a repo, optionally narrowed to a path prefix — newest
   * VERIFIED first. `limit: NO_LIMIT` means every live row, no cap.
   *
   * lore-ok[372b6bf0,f9559e98]: was `? LIKE path || '%'`, a raw prefix match with no
   * segment boundary — found by lore's own review, the same bug `enrich.ts`'s
   * `relevantTo` and `conflict.ts`'s `scopesOverlap` carried (see the latter's docs).
   * `'src/payroll/x.ts' LIKE 'src/pay' || '%'` is true, so a query for one directory
   * pulled in every rule scoped to any sibling sharing its prefix. Requires the
   * boundary to land on a `/`, or an exact match for a rule scoped to one file.
   *
   * lore-ok[aa57c0f2]: found real by lore's own review — this had no ORDER BY, so a
   * plain LIMIT returned whichever rows SQLite happened to enumerate first (the
   * OLDEST live ones, in practice). A repo past the cap silently lost its NEWEST
   * knowledge — the rule a person just wrote with knowledge_teach, most of all —
   * from every review prompt, from conflict detection, and from knowledge_query,
   * with nothing telling anyone. Ordering by `verified_at DESC` means a capped
   * caller's window is now the MOST CURRENT rows rather than an arbitrary one.
   * Callers that need every row to be correct — not merely representative — pass
   * `NO_LIMIT`: conflict detection must see every pair to find one, and anything
   * resolving a specific id an open conflict names must be able to find it, or it
   * renders the same "(retired)" placeholder a genuinely retired row does, which is
   * the 592cd49f bug's other door.
   *
   * `NO_LIMIT` is `-1`, not `undefined` — a DEFAULT PARAMETER fires on an explicit
   * `undefined` exactly as it does on an omitted argument, so `undefined` cannot be
   * told apart from "use the ordinary cap" at the call site. Caught by a test that
   * asked for every row and silently got 200 anyway. `-1` is SQLite's own "no bound
   * on rows returned," verified directly against `node:sqlite` rather than assumed.
   */
  knowledgeFor(repoId: string, pathPrefix?: string, limit = 200): readonly KnowledgeItem[] {
    const rows = (
      pathPrefix === undefined
        ? this.db
            .prepare("SELECT * FROM knowledge WHERE repo_id = ? AND retired_at IS NULL ORDER BY verified_at DESC LIMIT ?")
            .all(repoId, limit)
        : this.db
            .prepare(
              `SELECT * FROM knowledge WHERE repo_id = ? AND retired_at IS NULL
               AND (path IS NULL OR ? = path OR ? LIKE path || '/%') ORDER BY verified_at DESC LIMIT ?`,
            )
            .all(repoId, pathPrefix, pathPrefix, limit)
    ) as Record<string, string | number | null>[];
    return rows.map(toKnowledge);
  }

  /**
   * Has THIS READER already read this document at THIS BLOB — whatever survived?
   *
   * The reader half is why the parameter is here: the sentence claimed it and the query
   * did not ask, which was survivable only because `retireForChangedBlob` runs first
   * inside the same transaction and clears the stale-reader rows before this is
   * consulted. It stopped being survivable once ingest grew a step that costs money —
   * this is the cheap question asked BEFORE the screen, so an unchanged document does
   * not buy a model call on every review.
   *
   * **A SCREENED-OUT ROW COUNTS AS HAVING READ IT**, and asking only about live rules was
   * a leak with no floor. A document whose every candidate the screen legitimately
   * refuses leaves no live row, so it looked unread on the next review and the one after:
   * a model call per review for ever, each one inserting another identical set of dead
   * rows — precisely in the case where the screen has the most to say. The question this
   * needs to answer is "did this reader process this text", and a refusal answers it.
   *
   * Rows retired for any OTHER reason are correctly not evidence: `retireForChangedBlob`
   * only ever retires rows whose blob or reader differs from the arguments here, so they
   * cannot match, and a rule a person retired through `knowledge_resolve` should not stop
   * the document being read again.
   */
  hasKnowledgeBlob(repoId: string, provenance: string, blob: string, extractor: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM knowledge WHERE repo_id = ? AND provenance = ? AND source_blob = ? AND extractor IS ?" +
            " AND (retired_at IS NULL OR retired_reason LIKE 'screened out:%') LIMIT 1",
        )
        .get(repoId, provenance, blob, extractor) !== undefined
    );
  }

  /**
   * Live rules that were kept without ever being screened, with the document they came
   * from — the backlog the background screen works through (D-89).
   *
   * These are ordinary live rules and reviewers use them; the stamp says only that
   * nothing has judged whether they are rules at all. `<version>-unscreened` is written
   * whenever the screen could not run, and the whole point of it is that it can be found
   * again. Until D-89 the only thing that came back for them was the next review of the
   * same repository, which is why 27 of 181 live rules had sat unscreened.
   *
   * Grouped by document version — `(provenance, source_blob)` — because that is the unit
   * the screen judges: it is asked "which of these are not rules?" about one document's
   * candidates at once, and a prompt mixing two documents would be a different question.
   */
  unscreenedRules(repoId: string, unscreenedStamp: string): readonly {
    readonly id: string;
    readonly statement: string;
    readonly why: string | undefined;
    readonly provenance: string;
    readonly sourceBlob: string;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT id, statement, why, provenance, source_blob FROM knowledge
         WHERE repo_id = ? AND retired_at IS NULL AND extractor IS ?
           AND provenance IS NOT NULL AND source_blob IS NOT NULL
         ORDER BY provenance, id`,
      )
      .all(repoId, unscreenedStamp) as Record<string, string | null>[];
    return rows.map((r) => ({
      id: r["id"] ?? "",
      statement: r["statement"] ?? "",
      why: un(r["why"] ?? null),
      provenance: r["provenance"] ?? "",
      sourceBlob: r["source_blob"] ?? "",
    }));
  }

  /**
   * Record what a late screen decided about rules already in the base (D-89).
   *
   * ONE WRITE, because the two halves are one fact — *these survived, those did not* —
   * and a crash between them leaves a document half-judged with nothing to say so.
   *
   * The refused rows are RETIRED IN PLACE rather than deleted and re-inserted as
   * screened-out. They are already the row; retiring carries the model's reason onto the
   * history that already exists, where `recordScreenedOut` would leave the live row
   * behind and add a second one beside it.
   */
  settleLateScreen(
    kept: readonly string[],
    refused: readonly { readonly id: string; readonly because: string }[],
    stamp: string,
  ): void {
    this.tx(() => {
      const promote = this.db.prepare("UPDATE knowledge SET extractor = ? WHERE id = ? AND retired_at IS NULL");
      for (const id of kept) promote.run(stamp, id);
      const retire = this.db.prepare(
        "UPDATE knowledge SET retired_at = ?, retired_reason = ?, extractor = ? WHERE id = ? AND retired_at IS NULL",
      );
      const at = now();
      for (const r of refused) retire.run(at, `screened out: ${r.because}`, stamp, r.id);
    });
  }

  /**
   * Retire knowledge derived from a document that has changed.
   *
   * Re-derived, never retained: a stale doc must not become a confidently wrong
   * rule injected into every future session (D-20). This is the single guard
   * against the knowledge base rotting.
   */

  /**
   * `extractor` is REQUIRED, and that is a guard rather than a style preference.
   *
   * Optional, it was a trap with the pre-existing three-argument call shape as its
   * trigger: omitted, it binds NULL, `extractor IS NOT NULL` matches every stamped row,
   * and one call retires a document's entire live rule set with the reason "extracted by
   * an older reader" — which no reader earned. A hotfix written against last week's
   * signature would have compiled. Required, it is a type error.
   */
  retireForChangedBlob(repoId: string, provenance: string, currentBlob: string, extractor: string): number {
    // EITHER HALF GOING STALE RETIRES THE RULE. The text changing was always handled;
    // the READER changing was not, and that is the gap that let 399 decontextualised
    // fragments outlive the extractor that made them — re-ingestion triggers on the
    // source document, and the source document had not changed.
    const res = this.db
      .prepare(
        `UPDATE knowledge
         SET retired_at = ?,
             retired_reason = CASE WHEN source_blob != ? THEN 'source document changed'
                                   ELSE 'extracted by an older reader' END
         WHERE repo_id = ? AND provenance = ? AND source_blob IS NOT NULL AND retired_at IS NULL
           AND (source_blob != ? OR extractor IS NOT ?)`,
      )
      .run(now(), currentBlob, repoId, provenance, currentBlob, n(extractor));
    // node:sqlite reports `changes` as number | bigint.
    return Number(res.changes);
  }

  /**
   * Every document this repo has EVER ingested a live rule from.
   *
   * `ingestDocs`'s own sweep (`lore-ok[a2f4d4f9]`) diffs this against what it just
   * discovered on disk to find a document that is gone entirely — deleted, or
   * renamed — which `retireForChangedBlob` can never reach, because nothing calls it
   * for a path it never reads. `source_blob IS NOT NULL` is the same filter that
   * function uses to mean "ingested from a document", excluding `taught` and
   * `derived` rows, which have no document to disappear.
   */
  liveDocumentProvenances(repoId: string): readonly string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT provenance FROM knowledge WHERE repo_id = ? AND retired_at IS NULL AND source_blob IS NOT NULL",
      )
      .all(repoId) as { provenance: string | null }[];
    return rows.map((r) => r.provenance).filter((p): p is string => p !== null);
  }

  /**
   * Retire every live rule from a document that no longer exists at all.
   *
   * The sibling case to `retireForChangedBlob`: that one retires when a document's
   * TEXT changed, reached because re-ingestion calls it for every document it reads.
   * A document deleted or renamed is never read again, so nothing ever calls that —
   * `ingestDocs`'s sweep calls this instead, for exactly the provenances
   * `liveDocumentProvenances` names that its own discovery pass did not find.
   */
  retireForMissingDoc(repoId: string, provenance: string, reason: string): number {
    const res = this.db
      .prepare(
        "UPDATE knowledge SET retired_at = ?, retired_reason = ? WHERE repo_id = ? AND provenance = ? AND source_blob IS NOT NULL AND retired_at IS NULL",
      )
      .run(now(), reason, repoId, provenance);
    return Number(res.changes);
  }

  recordConflict(repoId: string, leftId: string, rightId: string): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_conflict(repo_id, left_id, right_id, state, created_at)
         VALUES(?, ?, ?, 'open', ?)`,
      )
      .run(repoId, leftId, rightId, now());
  }

  /**
   * Settle a conflict by retiring the rule that lost, with the reason.
   *
   * The losing rule is retired, not deleted: the decision has to be
   * reconstructable later, and "we used to believe X, until Y" is exactly the kind
   * of thing a codebase forgets and then re-litigates.
   *
   * **`needs-human` is settleable, and used not to be.** Only `state = 'open'` matched,
   * so `knowledge_escalate` was a one-way door: it moved a conflict to `needs-human`
   * and nothing on earth could move it back, while D-77 and `spec/knowledge.md` §7.3
   * both say the exit from an escalation is a person deciding and the client calling
   * this. Latent until the resume gate started counting escalated conflicts as
   * blocking, which turned it into a review that could never be resumed and a reply
   * telling the client to do something the API refuses.
   *
   * **`keepId`/`retireId` resolve through `knowledgeByShort` first** — found by
   * lore's own review, fingerprint b1a9841c: this matched them with exact `=`
   * while every OTHER id path in this file now resolves a prefix, so a client
   * holding the SAME rule in two lengths (a full id from `open_questions`, an
   * 8-char `cite_as` from `knowledge_teach` — the two tools that hand a client
   * ids to cite) failed silently here whenever it mixed them, on a `needs_human`
   * review a person HAD just decided. A full id resolves through unchanged (it is
   * a prefix of itself, matching exactly one row), so this changes nothing for an
   * already-full pair.
   */
  resolveConflict(repoId: string, keepId: string, retireId: string, reason: string): boolean {
    return this.tx(() => {
      const keep = this.knowledgeByShort(repoId, keepId);
      const retire = this.knowledgeByShort(repoId, retireId);
      if (keep === undefined || retire === undefined) return false;
      const open = this.db
        .prepare(
          `SELECT id FROM knowledge_conflict
           WHERE repo_id = ? AND state IN ('open', 'needs-human')
             AND ((left_id = ? AND right_id = ?) OR (left_id = ? AND right_id = ?))`,
        )
        .get(repoId, keep, retire, retire, keep) as Record<string, number> | undefined;
      if (open === undefined) return false;

      const t = now();
      this.db
        .prepare("UPDATE knowledge SET retired_at = ?, retired_reason = ? WHERE id = ? AND repo_id = ?")
        .run(t, reason, retire, repoId);
      this.db
        .prepare("UPDATE knowledge_conflict SET state = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?")
        .run(reason, t, Number(open["id"]));
      return true;
    });
  }

  /**
   * Mark a conflict as one only a person can settle. Still blocks passing.
   *
   * Returns whether a matching OPEN conflict actually existed to escalate.
   *
   * lore-ok[55452eb0]: was `void` — found by lore's own review, against
   * `resolveConflict` a few methods above, which already returns whether it matched
   * anything for exactly this reason. A conditional UPDATE with no existence check
   * is a silent no-op for wrong ids, another repo's ids, or a conflict already at
   * `needs-human` — and the caller (`knowledge_escalate`) reported "Recorded"
   * regardless, so an author's note calling for a human decision could vanish while
   * the reply said it was written down.
   */
  escalateConflict(repoId: string, leftId: string, rightId: string, note: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE knowledge_conflict SET state = 'needs-human', resolution = ?
         WHERE repo_id = ? AND state = 'open'
           AND ((left_id = ? AND right_id = ?) OR (left_id = ? AND right_id = ?))`,
      )
      .run(note, repoId, leftId, rightId, rightId, leftId);
    return res.changes > 0;
  }

  /**
   * Conflicts that still block a review from passing.
   *
   * Both `open` and `needs-human` count. Escalating to a person is not progress
   * toward passing — it is a statement that passing requires someone who has not
   * looked yet.
   *
   * lore-ok[592cd49f]: JOINs both sides against LIVE `knowledge` rows now — found by
   * lore's own review, reproduced directly: nothing that retires a rule for a reason
   * OTHER than resolving a conflict (`retireForChangedBlob` on a document edit,
   * `retirePolicy`, `settleLateScreen`) ever touched `knowledge_conflict`, so a
   * conflict recorded between two rules stayed `open` — and blocking — forever once
   * either rule was gone. Worse, `renderConflicts` builds its `byId` map from live
   * rows only and silently drops a pair it cannot fully resolve, so the reviewer was
   * told to settle a contradiction and shown nothing to settle: `needs_human` with no
   * way to ever clear it, since `resolveConflict` is the only path that closes a row
   * and it needs a live pair to retire one side of. A conflict whose rule no longer
   * exists cannot be reasoned about by anyone, so it is not "still blocking" by this
   * function's own contract — the row itself is untouched (still `open` in the table,
   * the history intact), only what counts as OUTSTANDING changes.
   */
  openConflicts(repoId: string): readonly { left: string; right: string; state: string }[] {
    const rows = this.db
      .prepare(
        `SELECT c.left_id, c.right_id, c.state
         FROM knowledge_conflict c
         JOIN knowledge l ON l.id = c.left_id AND l.retired_at IS NULL
         JOIN knowledge r ON r.id = c.right_id AND r.retired_at IS NULL
         WHERE c.repo_id = ? AND c.state IN ('open', 'needs-human')`,
      )
      .all(repoId) as Record<string, string>[];
    return rows.map((r) => ({
      left: r["left_id"] ?? "",
      right: r["right_id"] ?? "",
      state: r["state"] ?? "open",
    }));
  }

  // ----------------------------------------------------------------- usage

  recordUsage(u: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage(repo_id, review_id, tier, model, input_tokens, cached_tokens,
                           output_tokens, cost_usd, latency_ms, steps, diff_chars, outcome, at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        n(u.repoId),
        n(u.reviewId),
        u.tier,
        n(u.model),
        u.inputTokens ?? 0,
        u.cachedTokens ?? 0,
        u.outputTokens ?? 0,
        u.costUsd ?? 0,
        n(u.latencyMs),
        // `n`, not `?? 0`, unlike every token column above it: a missing token count
        // really is nothing spent, a missing step count is nothing KNOWN.
        n(u.steps),
        n(u.diffChars),
        u.outcome,
        now(),
      );
  }

  /**
   * What this tier's session on THIS model has already recorded for this review,
   * summed across every prior round it answered on.
   *
   * lore-ok[43cfcfbc,45fa213f]: EXISTS so a kept session's (D-80, `conversation: true`)
   * usage row can be turned into a DELTA before it is recorded, not written cumulative.
   * `conduct` (opencode.ts) reads a session's usage from its WHOLE message list, which
   * for a fresh, one-round session is that round's own true total — but for a session a
   * tier keeps across rounds, round N's "whole session" total already includes rounds
   * 1..N-1. A round recorded VERBATIM on top of the rows before it means `spendSince` and
   * the per-tier board (both `SUM(cost_usd)` across rows) add every earlier round's total
   * again on top of the next one's.
   *
   * SCOPED BY MODEL, not tier alone — found by lore's own review of the first version of
   * this fix, fingerprint 45fa213f: `sessionKey` (continuity.ts) addresses a session by
   * `(review, tier, MODEL)`, because a fallback keeps the tier's id and changes its model
   * (D-80's own reasoning for including it). A tier-only sum summed a DIFFERENT session's
   * already-banked total into the baseline, so a route flip's first round floored to a
   * false $0 delta (subtracting a total that has nothing to do with the new session), and
   * summing across every model a tier ever ran on undercounts anywhere the ladder tracks
   * a route change, which the deployed configuration does on every conversation tier.
   */
  usageSoFar(
    reviewId: string,
    tier: string,
    model: string,
  ): { inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(cached_tokens), 0) AS c,
                COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cost_usd), 0) AS d
         FROM usage WHERE review_id = ? AND tier = ? AND model = ?`,
      )
      .get(reviewId, tier, model) as Record<string, number | bigint> | undefined;
    return {
      inputTokens: Number(row?.["i"] ?? 0),
      cachedTokens: Number(row?.["c"] ?? 0),
      outputTokens: Number(row?.["o"] ?? 0),
      costUsd: Number(row?.["d"] ?? 0),
    };
  }

  /**
   * The largest diff this tier has ever **finished** reviewing (D-58).
   *
   * `undefined` when it has never finished one, and that is the useful half: with no
   * evidence there is no warning, rather than a guessed constant. A threshold nobody
   * can calibrate fails real reviews for nothing — the same trap D-50 names — so the
   * only number allowed here is one the tier has actually demonstrated.
   *
   * Completed only. A run that timed out proves the opposite of capacity, and
   * counting it would raise the ceiling every time the tier failed.
   */
  largestCompletedDiff(tier: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(diff_chars) AS m FROM usage
         WHERE tier = ? AND diff_chars IS NOT NULL AND outcome LIKE 'ok%'`,
      )
      .get(tier) as Record<string, number | bigint | null> | undefined;
    const m = row?.["m"];
    return m === null || m === undefined ? undefined : Number(m);
  }

  /** Spend since an ISO timestamp — what the daily ceiling is checked against. */
  spendSince(iso: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE at >= ?").get(iso) as
      | Record<string, number | bigint>
      | undefined;
    return Number(row?.["total"] ?? 0);
  }

  // ------------------------------------------------------------------- job

  /**
   * Queue a round, unless an identical one is already waiting (D-53).
   *
   * Two callers reach here for the same review: `review_start` and `review_submit`.
   * A client that starts a review and immediately submits a diff — which is the
   * normal shape of the loop, not an abuse of it — used to stack two `fast` jobs,
   * and stacked jobs became simultaneous rounds.
   *
   * Deduplicated on (review, stage) rather than on review alone: collapsing a `deep`
   * into a waiting `fast` would silently drop the escalation. Two IDENTICAL waiting
   * rounds are redundant; two different ones are a sequence.
   */
  enqueue(reviewId: string, stage: "fast" | "deep"): void {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO job(review_id, stage, state, created_at, updated_at)
         SELECT ?, ?, 'queued', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM job WHERE review_id = ? AND stage = ? AND state = 'queued')`,
      )
      .run(reviewId, stage, t, t, reviewId, stage);
  }

  /**
   * Claim one queued job, for a review that has none already running (D-53).
   *
   * The old version claimed the oldest queued job of ANY review and said it was safe
   * "so two workers never take the same one". That is true and it is the wrong
   * invariant: what must not happen twice is not a job, it is a ROUND ON A REVIEW.
   *
   * Observed 2026-08-04. Two `fast` jobs existed
   * for one review, two worker loops took one each, and both called t1 — 550s and
   * 590s, overlapping. `runRound` reads the ladder, runs a tier and writes the ladder
   * back, so the two interleaved: the state settled at `round: 1, tierRounds: {t1: 1}`
   * after two rounds had finished, and one completed review that returned `ok` was
   * discarded. `tier_run` and `usage` disagreed about which tier had run, because
   * different rounds wrote them. It cost a paid call and corrupted the audit trail,
   * which is worse than a stall — the same hazard `reclaimOrphanedJobs` refuses to
   * risk mid-flight, arriving through the front door instead.
   *
   * Reviews still run in parallel with EACH OTHER, which is the concurrency worth
   * having; only one round at a time within a review. A blocked job is left queued
   * and the loop polls again, so nothing is lost — and a review whose `running` job
   * belongs to a dead process is freed by `reclaimOrphanedJobs` at startup.
   *
   * lore-ok[3b2e40c0]: the subquery is indexed, not a table scan. Asked of SQLite
   * rather than reasoned about, against the deployed database:
   *
   *   CORRELATED SCALAR SUBQUERY 1
   *     SEARCH r USING COVERING INDEX job_by_review (review_id=? AND state=?)
   *
   * `job_by_review` is exactly (review_id, state), which is exactly what this
   * predicate binds — and COVERING means it is answered from the index without
   * touching the table at all. The finding's own evidence undoes it: it faults the
   * plan for not using a `stage` column that this index does not contain. `stage`
   * belongs to `enqueue`'s predicate, and SQLite picks the same index there.
   */
  claimJob(): { id: number; reviewId: string; stage: "fast" | "deep" } | undefined {
    return this.tx(() => {
      const row = this.db
        .prepare(
          // A TERMINAL REVIEW NEVER GETS ANOTHER ROUND. This checked only that no
          // other job for the review was running, so a review that had reached a
          // verdict — or been cancelled — still had its queued jobs claimed and paid
          // for. Cancellation made that visible: marking the state stopped nothing,
          // because nothing between here and `runRound` ever asked what the state was.
          // Terminal means finished, and the queue is the one place that had not
          // been told.
          `SELECT j.id, j.review_id, j.stage FROM job AS j
           JOIN review AS rv ON rv.id = j.review_id
           WHERE j.state = 'queued'
             AND rv.state NOT IN (${TERMINAL_SQL})
             AND NOT EXISTS (SELECT 1 FROM job AS r WHERE r.review_id = j.review_id AND r.state = 'running')
           ORDER BY j.id LIMIT 1`,
        )
        .get() as Record<string, string | number> | undefined;
      if (row === undefined) return undefined;
      const id = Number(row["id"]);
      this.db
        .prepare("UPDATE job SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(now(), id);
      return { id, reviewId: String(row["review_id"]), stage: String(row["stage"]) as "fast" | "deep" };
    });
  }

  /**
   * A re-raise refreshes what the finding is ABOUT (D-56).
   *
   * `recordFinding` is `ON CONFLICT DO NOTHING`, which is right for the finding's
   * text — the claim, the evidence, when it was first seen — and wrong for the two
   * fields the settling rule reads, because both describe the world at the LAST
   * raise rather than the first. t3 raised both against D-56:
   *
   *   * **scope** — code can move without the finding being fixed. Testing the first
   *     raise's hunk then finds it absent and records `fixed` for a defect the tier
   *     is still complaining about, which is a false claim in a signed line.
   *   * **origin** — if t3 re-raises what t1 first found, a stale `t1` lets t1's
   *     silence close it, and the qualified-tier guard exists precisely to stop a
   *     weaker tier doing that. Raised only, never lowered: the strongest tier that
   *     has confirmed a defect is the one that must be satisfied it is gone.
   */
  refreshFinding(reviewId: string, fingerprint: string, scope: Scope | undefined, origin: string | undefined): void {
    if (scope !== undefined) {
      this.db
        .prepare("UPDATE finding SET scope_blob = ?, scope_hunk = ? WHERE review_id = ? AND fingerprint = ?")
        .run(scope.blob, scope.hunk, reviewId, fingerprint);
    }
    if (origin !== undefined) {
      this.db
        .prepare("UPDATE finding SET origin = ? WHERE review_id = ? AND fingerprint = ?")
        .run(origin, reviewId, fingerprint);
    }
  }

  /**
   * Does this review have a round that has not finished — queued OR running?
   *
   * For callers that must not touch the review's WORKTREE (D-55). D-53 stopped two
   * rounds running at once; it did nothing about a writer outside the queue, and
   * `review_submit` is exactly that — it patches the worktree a tier is reading.
   *
   * QUEUED COUNTS, and that is the whole point. Asking only about `running` left a
   * TOCTOU that t2 found: a job sits queued, the check says no round is
   * in flight, the handler yields on the next `await`, a worker loop claims that
   * job and `computeDiff` starts reading — and the handler resumes and patches the
   * files underneath it. The tree hash then matches a tree the findings never
   * described. Counting queued closes it by leaving nothing for a worker to claim,
   * rather than by making the window smaller and hoping.
   */
  /**
   * The tree a tier's kept session last SAW (D-108) — written at the end of each
   * streamed run, read at the start of the next. When the review's tree has moved in
   * between (a submit, a held diff, a pull_fresh re-pin), the difference between this
   * and the round's tree is exactly the diff the session has not seen — and the next
   * message opens with it, so to the model every advance looks the same: the author
   * answered. Absent means no streamed run has finished, and the session (if any)
   * is told nothing extra.
   *
   * KEYED BY ROUTE AS WELL AS TIER, because that is how the sessions themselves are
   * keyed. A tier's kept session lives per (review, tier, MODEL) — `sessionKey` in
   * opencode.ts — so with a pool or a fallback, one tier can hold several sessions,
   * each having seen a different tree. Keyed per tier alone, a route flip handed the
   * primary's kept session a delta computed from the TWIN's tree: everything between
   * the primary's last look and the twin's was never delivered, breaking D-108's
   * "exactly the unseen delta" precisely during quota flapping. Raised by lore's own
   * t2 against the D-109 change. A record written under the old tier-only key is
   * simply never read again: the session opens with the full orientation once, exactly
   * the documented lore-restart behaviour, and the stale row dies with the review in
   * `clearSessionTrees`.
   */
  sessionTreeOf(reviewId: string, tierId: string, route: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`session-tree:${reviewId}:${tierId}:${route}`) as
      | { value?: string }
      | undefined;
    return row?.value;
  }

  setSessionTree(reviewId: string, tierId: string, route: string, tree: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`session-tree:${reviewId}:${tierId}:${route}`, tree);
  }

  /**
   * What a tier's kept session was last SHOWN of t0 (D-108), so a fix message can carry
   * the delta instead of the repeat. Same lifecycle — and same per-route key — as the
   * session-tree record.
   */
  sessionT0Of(reviewId: string, tierId: string, route: string): readonly { fingerprint: string; file: string; line?: number; severity: string; claim: string }[] | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`session-t0:${reviewId}:${tierId}:${route}`) as
      | { value?: string }
      | undefined;
    if (row?.value === undefined) return undefined;
    try {
      return JSON.parse(row.value) as { fingerprint: string; file: string; line?: number; severity: string; claim: string }[];
    } catch {
      return undefined;
    }
  }

  setSessionT0(reviewId: string, tierId: string, route: string, seen: readonly { fingerprint: string; file: string; line?: number | undefined; severity: string; claim: string }[]): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`session-t0:${reviewId}:${tierId}:${route}`, JSON.stringify(seen));
  }

  /**
   * WHICH opencode SESSION A TIER IS KEEPING — the one part of D-80 that used to die
   * with the process.
   *
   * The map lived in `Reviewer` memory and nowhere else, so a restart lost every warm
   * conversation lore held. opencode did NOT lose them: its session store is a named
   * volume that survives container recreation. Only the ids were forgotten — so every
   * tier of every open review fell back to a cold start and re-read the whole diff at
   * full price, on a deploy that was supposed to cost one interrupted round.
   *
   * Vany: *"deployment must not kill the full ladder, may be one step."* That is what
   * this makes true. `reclaimOrphanedJobs` already requeues the interrupted round and
   * the ladder, findings and ratified justifications were always in SQLite; this was the
   * last thing a restart destroyed, and it was the expensive one.
   *
   * KEYED BY THE COMPOSED `sessionKey` (review, tier, MODEL), not by the triple, so the
   * key format has exactly one definition and it lives with the sessions in
   * `reviewer/continuity.ts`. Same reasoning as the per-route keying of `session-tree`
   * below it: one tier can hold several sessions when a pool or a fallback is in play.
   */
  keptSessionOf(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`session-id:${key}`) as
      | { value?: string }
      | undefined;
    return row?.value;
  }

  setKeptSession(key: string, sessionId: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`session-id:${key}`, sessionId);
  }

  /**
   * A session opencode no longer has.
   *
   * Persisting an id makes a new failure reachable that an in-memory map could not have:
   * a row pointing at a session that is gone (opencode's volume wiped, its data pruned,
   * a database restored from a backup older than the session). Left in place that row
   * would fail the same tier on EVERY future round of that review — permanent, and worse
   * than the cold start it was meant to avoid. So the resume path forgets and starts
   * cold, once, and says so.
   */
  forgetKeptSession(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(`session-id:${key}`);
  }

  /**
   * Has this notice already been delivered today?
   *
   * Separate from `claimDailyNotice` because the claim must happen AFTER the notice
   * actually got out, and the check must happen before it is attempted — one atomic
   * check-and-claim cannot express that, and using it as both was how an undelivered
   * alert came to suppress every later one for a day.
   */
  dailyNoticeGiven(kind: string, dayIso: string): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM meta WHERE key = ?").get(`told:${kind}:${dayIso}`) as
      | Record<string, number>
      | undefined;
    return row !== undefined;
  }

  /**
   * TRUE FOR WHOEVER CLAIMS THE DAY, once.
   *
   * `INSERT OR IGNORE` so two concurrent rounds cannot both believe they were first —
   * SQLite decides, and the winner is whoever's insert changed a row.
   *
   * CLAIMED AFTER THE NOTICE IS DELIVERED, never before. This was both the check and the
   * claim, which read well and meant an undelivered alert — a webhook answering 500 —
   * consumed the day: the operator heard nothing and every later paid call was suppressed
   * by a record of a message that never arrived. `dailyNoticeGiven` above is the check
   * half; the cost of splitting them is a possible duplicate under a race, which is the
   * right way round for a message about money.
   *
   * The day key is passed in rather than read here so the caller owns the boundary and a
   * test can name a day.
   */
  claimDailyNotice(kind: string, dayIso: string): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)")
      .run(`told:${kind}:${dayIso}`, "1");
    return Number(r.changes ?? 0) > 0;
  }

  /**
   * Every kept-session key on record, prefix stripped.
   *
   * The reconcile sweeps reviews that ended without a job or a cancel — the retention
   * sweep marking one `expired` in SQL — and it can only sweep what it can enumerate. A
   * lookup-only port left it reading the process-local cache, which a restart empties, so
   * the rows and their opencode sessions would survive every review that owned them.
   */
  keptSessionKeys(): readonly string[] {
    const rows = this.db.prepare("SELECT key FROM meta WHERE key LIKE 'session-id:%'").all() as { key?: string }[];
    return rows.map((r) => String(r.key ?? "").slice("session-id:".length)).filter((k) => k !== "");
  }

  /** Housekeeping for a review that ended — the records are meaningless without it. */
  clearSessionTrees(reviewId: string): void {
    this.db.prepare("DELETE FROM meta WHERE key LIKE ?").run(`session-tree:${reviewId}:%`);
    this.db.prepare("DELETE FROM meta WHERE key LIKE ?").run(`session-t0:${reviewId}:%`);
    // The session ids go the same way and for the same reason: a review that ended will
    // never send another turn, and a row nobody reads is a row that outlives its meaning.
    this.db.prepare("DELETE FROM meta WHERE key LIKE ?").run(`session-id:${reviewId}:%`);
  }

  /**
   * Accept a diff while a round runs; it is applied at the reviewer's next emission
   * (D-107). Returns the row's own id, so a caller that decides to take a hold BACK
   * (a race window closed, nothing will ever consume it) can clear exactly the row it
   * inserted rather than every row this review happens to have — a concurrent submit's
   * own hold, landed in the same narrow window, is not this caller's to discard.
   */
  holdDiff(reviewId: string, diff: string, treeHash: string): number {
    const res = this.db
      .prepare("INSERT INTO held_diff(review_id, diff, tree_hash, created_at) VALUES(?, ?, ?, ?)")
      .run(reviewId, diff, treeHash, now());
    // NO BOUNDS RESET HERE, though a held diff IS client work.
    //
    // It was here, and it was silently thrown away: this is a read-modify-write of the
    // ladder blob, fired while a round is in flight BY DEFINITION (a diff is only held
    // when one is), and that round writes its own ladder at the end from the snapshot it
    // took at the start. The reset lived for the length of one round and vanished — so
    // D-114 worked precisely when a client waited for a quiet moment and failed when it
    // followed the documented "submit any time" cadence, which is backwards.
    //
    // The round applies the reset itself, at the emission boundary where the diff lands
    // and the tree is observed to move (`consumeHeldDiffs`), so there is exactly one
    // writer of the ladder per round.
    return Number(res.lastInsertRowid);
  }

  /**
   * The client delivered work: recorded WHERE IT VERIFIES, applied where the ladder is
   * owned (D-114).
   *
   * Three windows produced the same defect in three shapes before this became one flag,
   * and the pattern is the lesson: the ladder blob has exactly one legitimate writer per
   * round, so anything that wants to change it from outside a round either gets clobbered
   * or has to find its own moment — and each moment missed a different path.
   *
   *   * written at SUBMIT time, into a blob the running round had already snapshotted:
   *     overwritten by that round's terminal write, so it worked only for clients that
   *     waited for a quiet moment;
   *   * moved to the round's emission boundary: missed the worker's late-hold sweep,
   *     where a diff that arrives after the model declares done is consumed at no
   *     boundary at all;
   *   * still missed a round that DIES after consuming — `ServiceUnreachable`, the
   *     ordinary D-104 case — because the reset was on the success path while the held
   *     rows were already deleted, so nothing downstream could ever observe the work.
   *
   * A durable flag outside the ladder fixes all three at once. It is set the moment a
   * diff applies and hash-verifies, survives a round dying, and is taken by the next
   * round when it owns the ladder. `meta` rather than a column: it is a transient signal,
   * not a fact about the review, and it is deleted as it is read.
   */
  noteClientWork(reviewId: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
      .run(`client-work:${reviewId}`);
  }

  /**
   * Whether client work landed since the last round took it — and clears it.
   *
   * Read-and-clear in one call so the signal cannot be applied twice: two resets for one
   * submit would hand a client double the budget for the same material.
   */
  takeClientWork(reviewId: string): boolean {
    const key = `client-work:${reviewId}`;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | Record<string, string>
      | undefined;
    if (row === undefined) return false;
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    return true;
  }

  /** Applies a pending client-work signal to a ladder, or returns it untouched. */
  withClientWork(reviewId: string, ladder: LadderState): LadderState {
    return this.takeClientWork(reviewId) ? clientDeliveredWork(ladder) : ladder;
  }

  /** In arrival order — each was built by the client on top of the one before. */
  heldDiffs(reviewId: string): readonly { readonly id: number; readonly diff: string; readonly treeHash: string }[] {
    const rows = this.db
      .prepare("SELECT id, diff, tree_hash FROM held_diff WHERE review_id = ? ORDER BY id")
      .all(reviewId) as Record<string, unknown>[];
    return rows.map((r) => ({ id: Number(r["id"]), diff: String(r["diff"]), treeHash: String(r["tree_hash"]) }));
  }

  /** One consumed row, or — on a mid-chain mismatch — everything still queued. */
  clearHeldDiff(reviewId: string, id?: number): void {
    if (id === undefined) this.db.prepare("DELETE FROM held_diff WHERE review_id = ?").run(reviewId);
    else this.db.prepare("DELETE FROM held_diff WHERE review_id = ? AND id = ?").run(reviewId, id);
  }

  hasPendingRound(reviewId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM job WHERE review_id = ? AND state IN ('queued', 'running') LIMIT 1")
      .get(reviewId) as Record<string, number> | undefined;
    return row !== undefined;
  }

  /**
   * Requeue jobs a dead process left behind. Call at STARTUP, before any loop runs.
   *
   * `claimJob` sets `running` and `finishJob` clears it, so a process that dies in
   * between leaves the row `running` for ever. Nothing reclaimed it and nothing said
   * so: the review simply stopped advancing, and `queueDepth` counts only `queued`,
   * so the operator view showed an idle service with work stranded inside it. That is
   * INV-1 wearing the scheduler's clothes — a round that did not run, reported as
   * nothing to do.
   *
   * `attempts` was already incremented on every claim and read by nothing, which is
   * the same decoration `SCHEMA_VERSION` was. It is now the bound.
   *
   * AT STARTUP SPECIFICALLY, so no timeout has to be guessed. Mid-flight this would
   * need a staleness threshold longer than the longest legitimate round — T1 has been
   * measured at 1006s and `longFetch` allows 30 minutes — and getting that wrong
   * requeues a job that is still running, so the same review runs twice and pays
   * twice. At startup there is no such ambiguity: this process holds no jobs, so
   * anything `running` belongs to a process that is gone.
   *
   * A job that has burnt its attempts is FAILED, not requeued. A round that reliably
   * kills the worker would otherwise crash-loop on restart for ever, and a review
   * that cannot finish must say so rather than be retried in silence.
   */
  /**
   * Why the last job for this review stopped, if it stopped badly.
   *
   * The reason is written to `job.last_error` and was never readable through the
   * MCP surface, so a client polling a `failed` review saw the word and nothing
   * else. INV-1 says a review that did not run must never look like one that found
   * nothing — and a bare `failed` does exactly that, then invites the client to
   * invent a cause. One did: told only `failed`, it published that this repository
   * was not registered with lore, when it was registered, mirrored, and had just
   * authenticated with its own token. The real reason was a stale mirror, and the
   * message naming the fix already existed one table away.
   */
  /**
   * How far the base moved ahead of this branch, as of the last round.
   *
   * Deterministic, known in milliseconds, and the single most useful fact for
   * deciding whether a branch is landable — so it belongs where the decision is
   * made rather than only in the reviewer's prompt. A client triaging eight open
   * pull requests should not need eight model-tier reviews to learn which are
   * stale.
   */
  setBehindBy(reviewId: string, n: number): void {
    this.db.prepare("UPDATE review SET behind_by = ? WHERE id = ?").run(n, reviewId);
  }

  behindBy(reviewId: string): number | undefined {
    const row = this.db.prepare("SELECT behind_by FROM review WHERE id = ?").get(reviewId) as
      | { behind_by: number | null }
      | undefined;
    return row?.behind_by ?? undefined;
  }

  /**
   * Why a review will not finish.
   *
   * `inferFromJobs` decides whether a round that THREW may answer for it, and the
   * caller owns that choice because it depends on the state. For `failed` the job
   * error is usually the truest account there is. For `cancelled` it is a fabrication:
   * somebody stopped the review deliberately, and a transport error from an unrelated
   * round two hours earlier would be handed back as their reason — in the field
   * `review_cancel` calls "the only account anyone gets". A cancel with nothing
   * recorded must say nothing was recorded.
   */
  failureReason(reviewId: string, inferFromJobs = true): string | undefined {
    // The review's own reason first. `job.last_error` only ever covers a round that
    // THREW; a review stopped by the ladder — a round bound reached — left every job
    // `done` with no error, so `review_poll` answered "no reason was recorded, which is
    // itself a defect" about a cause the code knew exactly. Raised against a review of
    // this repository that had itself just hit the per-tier bound (D-57, INV-1).
    const own = this.db.prepare("SELECT failed_because FROM review WHERE id = ?").get(reviewId) as
      | Record<string, string | null>
      | undefined;
    const stated = own?.["failed_because"];
    if (typeof stated === "string" && stated !== "") return stated;
    if (!inferFromJobs) return undefined;

    const row = this.db
      .prepare("SELECT last_error FROM job WHERE review_id = ? AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(reviewId) as { last_error: string } | undefined;
    return row?.last_error ?? undefined;
  }

  /** Record why a review will not finish, for `failureReason` to hand to the client. */
  setFailureReason(reviewId: string, why: string): void {
    if (this.refusedByClose(`the failure reason for ${reviewId}`)) return;
    this.db.prepare("UPDATE review SET failed_because = ? WHERE id = ?").run(why, reviewId);
  }

  /**
   * Stop claiming new rounds, so a deploy can wait for the ones in flight (D-72).
   *
   * A restart does not lose state — everything is here on disk — but it does throw
   * away MODEL TIME: `reclaimOrphanedJobs` requeues an interrupted round and it runs
   * again from scratch, paid for twice. One morning that cost 109 minutes of t2 work
   * in a container that could have been drained first.
   *
   * In `meta` rather than a file because the job table is already the coordination
   * point, and this is a fact about the same thing. Draining affects CLAIMING only:
   * MCP keeps serving, new reviews still queue, and the next process runs them.
   */
  setDraining(on: boolean): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES('draining', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
      .run(on ? "1" : "0", on ? "1" : "0");
  }

  isDraining(): boolean {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'draining'").get() as
      | Record<string, string>
      | undefined;
    return row?.["value"] === "1";
  }

  /**
   * A tier that could not answer, SERVICE-WIDE, and when to try it again (D-90).
   *
   * Vany: *"if t1 is skipped, it must not even initiate screen."*
   *
   * Until this existed, "this tier is dead" was known only inside one review's ladder —
   * `LadderState.unavailable`, which is per-review by construction. So every review, and
   * then every background screen pass, re-learned it from scratch at the cost of a full
   * hang deadline. With an exhausted Z.ai plan that was 45 minutes an hour, for ever,
   * against a fact whose reset time we already knew.
   *
   * The fact is LEARNED, never inferred from a name or a schedule: it is written when a
   * call actually fails with a fault that belongs to the tier rather than to the request,
   * and cleared the moment one succeeds. That is the only evidence lore can get, because
   * opencode swallows the provider's refusal (D-84) — there is no status code to read and
   * no limit to retrieve.
   *
   * In `meta` for the same reason `draining` is: it is one fact about the service, read
   * by whatever is about to spend, and it must survive a restart — a process that forgot
   * would go straight back to hanging.
   */
  markTierUnavailable(
    tierId: string,
    untilIso: string,
    why: string,
    failures: number,
    stated = false,
    /** When a review last asked this tier whether it was back (D-94). */
    probedAt?: string,
  ): void {
    // `stated` IS LOAD-BEARING, not bookkeeping. A time the PROVIDER named is a fact about
    // itself and true for every review at once; our doubling backoff is a guess, and a
    // review acting on someone else's guess narrows its own coverage from evidence it
    // never saw. SPEC D-90 says exactly that and the write side honoured it — the READ
    // side did not, because nothing in the row distinguished the two.
    //
    // AN UPDATE THAT DOES NOT NAME `probedAt` KEEPS THE ONE ALREADY THERE, and this is the
    // whole of D-94's rate limit. The probe stamps the mark before it calls, then the call
    // refuses and the catch rewrites the mark — with five arguments, no stamp — so the
    // probe was erased by the very refusal that discovered it. `shouldProbe` then read
    // "never probed" and every review asked the dead tier again, which is the once-per-
    // review cost D-94 exists to bound, restored in full while looking fixed.
    //
    // Preserved HERE and not at the two call sites, because one of them is reached by the
    // cool-off's own synthetic `Exhausted` — no provider was asked on that path, so a site
    // that stamped `now` would push the next probe forward for a call that never happened
    // and D-94 would never probe at all under steady load. The store keeps what it knows;
    // only a real call names a new time. `clearTierUnavailable` is what forgets.
    const kept = probedAt ?? this.tierUnavailable(tierId)?.probedAt;
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`tier-unavailable:${tierId}`, JSON.stringify({ until: untilIso, why, failures, stated, probedAt: kept }));
  }

  /**
   * The same fact, about ONE ROUTE rather than one tier (D-93).
   *
   * A tier whose model names a pool has several subscriptions behind it, and their quotas
   * are independent: `zai-coding-plan` can be dry while `zai-coding-plan2` is untouched,
   * and both are `t2`. A per-tier mark cannot say that — it would either strike out a
   * plan that is fine or keep asking one that is empty.
   *
   * **Optimistic to begin with.** Vany: *"let's at the start assume all connections have
   * quota, and clarify if it is; and if it is not, what time of release when it rejects to
   * work."* Absence of a record means the route is believed good, so a fresh service asks
   * rather than assumes, and only a refusal writes anything down. Nothing here is inferred
   * from a plan's name or from the calendar.
   *
   * `stated` carries the same weight it does for a tier and for the same reason: a time
   * the PROVIDER named is a fact about itself, true for every review at once, while our
   * doubling backoff is a guess — and a review must not narrow its own coverage on
   * somebody else's guess (D-90).
   */
  markRouteUnavailable(model: string, untilIso: string, why: string, failures: number, stated = false): void {
    // AN UPDATE THAT DOES NOT NAME `probedAt` KEEPS THE ONE ALREADY THERE — the same rule
    // `markTierUnavailable` carries above, and for the same reason, which I reproduced here
    // within an hour of writing the route probe.
    //
    // The probe stamps the mark before it calls; the call refuses; this line rewrites the
    // mark from the catch with no stamp — so the probe is erased by the very refusal that
    // discovered it, `shouldProbe` reads "never probed", and every round re-asks a dead
    // route. That is the per-round re-ask D-94 exists to bound, restored in full while
    // looking fixed. Caught by watching the live deployment rather than by the test I wrote
    // for it, which passed for an unrelated reason.
    const kept = this.routeUnavailable(model)?.probedAt;
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(
        `route-unavailable:${model}`,
        JSON.stringify({ until: untilIso, why, failures, stated, ...(kept === undefined ? {} : { probedAt: kept }) }),
      );
  }

  /**
   * A PARKED ROUTE WAS JUST RE-TESTED (D-94, widened to routes 2026-08-17).
   *
   * Stamped BEFORE the call, so a route that hangs cannot be probed again by every review
   * that starts while it hangs — the same reason the per-tier probe stamps first.
   *
   * The mark is otherwise untouched: a probe that fails leaves the backoff exactly as it
   * was, and one that succeeds clears the whole row through `clearRouteUnavailable`.
   */
  markRouteProbed(model: string): void {
    const mark = this.routeUnavailable(model);
    if (mark === undefined) return;
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`route-unavailable:${model}`, JSON.stringify({ ...mark, probedAt: new Date().toISOString() }));
  }

  /** Forgotten the moment the route answers, exactly as for a tier. */
  clearRouteUnavailable(model: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(`route-unavailable:${model}`);
  }

  /**
   * What is known about one route being out of quota, or `undefined` if nothing is.
   *
   * Returned even when `until` has passed, like its per-tier twin: the failure count is
   * what the next backoff is computed from, and an operator wants to know a route failed
   * at all rather than only that it is failing now.
   */
  routeUnavailable(model: string): { readonly until: string; readonly why: string; readonly failures: number; readonly stated: boolean; readonly probedAt?: string } | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`route-unavailable:${model}`) as
      | Record<string, string>
      | undefined;
    if (row?.["value"] === undefined) return undefined;
    try {
      const v = JSON.parse(row["value"]) as { until?: string; why?: string; failures?: number; stated?: boolean; probedAt?: string };
      return {
        until: v.until ?? "",
        why: v.why ?? "",
        failures: v.failures ?? 1,
        stated: v.stated === true,
        // Absent means never probed, which `shouldProbe` reads as "due now" — so the first
        // review after this shipped re-tests every route parked on a guess, which is
        // exactly right for marks written before probing existed.
        ...(v.probedAt === undefined ? {} : { probedAt: v.probedAt }),
      };
    } catch {
      // Unreadable is not "out of quota". A row we cannot parse must not silently strike
      // a paid-for route out of every ladder that names it.
      return undefined;
    }
  }

  /** Forgotten the moment the tier answers — a stale mark is a tier we stop using for nothing. */
  clearTierUnavailable(tierId: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(`tier-unavailable:${tierId}`);
  }

  /**
   * What is known about a tier being down, or `undefined` if nothing is.
   *
   * Returns the record even when it has EXPIRED, with `until` in the past, because the
   * caller needs the failure count to decide how long to wait after the next failure —
   * and because an operator reading this wants to know a tier failed at all, not only
   * that it is currently in a cool-off.
   */
  tierUnavailable(tierId: string): {
    readonly until: string;
    readonly why: string;
    readonly failures: number;
    readonly stated: boolean;
    /** When a review last probed it, absent if never (D-94). */
    readonly probedAt?: string;
  } | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`tier-unavailable:${tierId}`) as
      | Record<string, string>
      | undefined;
    if (row?.["value"] === undefined) return undefined;
    try {
      const v = JSON.parse(row["value"]) as {
        until?: string; why?: string; failures?: number; stated?: boolean; probedAt?: string;
      };
      // Defaults to FALSE, which is the conservative reading: a row written before this
      // field existed is treated as a guess, so it bounds the screen and never a review.
      return {
        until: v.until ?? "",
        why: v.why ?? "",
        failures: v.failures ?? 1,
        stated: v.stated === true,
        ...(v.probedAt === undefined ? {} : { probedAt: v.probedAt }),
      };
    } catch {
      // A meta row we cannot parse is a row we wrote wrong; treating it as "no record"
      // costs one hang and self-heals, where throwing would take down whatever read it.
      return undefined;
    }
  }

  /** Every tier currently in a cool-off, for the operator view. */
  unavailableTiers(
    nowIso: string,
  ): readonly { readonly tier: string; readonly until: string; readonly why: string; readonly stated: boolean }[] {
    const rows = this.db
      .prepare("SELECT key, value FROM meta WHERE key LIKE 'tier-unavailable:%'")
      .all() as Record<string, string>[];
    const out: { tier: string; until: string; why: string; stated: boolean }[] = [];
    for (const r of rows) {
      const tier = (r["key"] ?? "").slice("tier-unavailable:".length);
      try {
        const v = JSON.parse(r["value"] ?? "{}") as { until?: string; why?: string; stated?: boolean };
        // `stated` TRAVELS, because the two marks mean different things to a reader: a
        // provider's word stops reviews calling the tier, our own guess stops only the
        // background screen. A field named `tiers_not_being_asked` that carried both was
        // telling a monitor reviews were degraded when they were not.
        if ((v.until ?? "") > nowIso) {
          out.push({ tier, until: v.until ?? "", why: v.why ?? "", stated: v.stated === true });
        }
      } catch {
        // See `tierUnavailable`: an unparseable row is treated as absent.
      }
    }
    return out;
  }

  reclaimOrphanedJobs(maxAttempts = 3): {
    readonly requeued: number;
    readonly failed: number;
    readonly closedRuns: number;
    readonly reviewsFailed: number;
  } {
    const woken: string[] = [];
    const out = this.tx(() => {
      const at = now();
      // READ FIRST. The two UPDATEs this used to be were correct only because of the
      // order they appeared in — the first set the burnt-out rows to `failed` so the
      // second's `attempts < ?` could not see them — with nothing saying so, and
      // swapping them would have quietly requeued every job at the limit, which is the
      // crash-loop the bound exists to prevent. Driving both from one read of the rows
      // removes the ordering dependency instead of commenting on it.
      const orphans = this.db
        .prepare("SELECT id, review_id, attempts FROM job WHERE state = 'running'")
        .all() as Record<string, string | number>[];
      const burntOut = orphans.filter((j) => Number(j["attempts"] ?? 0) >= maxAttempts);
      const retryable = orphans.filter((j) => Number(j["attempts"] ?? 0) < maxAttempts);

      for (const j of burntOut) {
        this.db
          .prepare("UPDATE job SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
          .run(
            `abandoned by a worker that stopped mid-round, and it had already used its ${String(maxAttempts)} attempts`,
            at,
            j["id"] as number,
          );
      }
      for (const j of retryable) {
        this.db.prepare("UPDATE job SET state = 'queued', updated_at = ? WHERE id = ?").run(at, j["id"] as number);
      }

      // THE TIER RUN OUTLIVES THE JOB THAT OWNED IT. `openTierRun` leaves `finished_at`
      // NULL on purpose: null and recent means a tier is working, null and old means
      // something stopped without saying so. A process that dies mid-round leaves that
      // row open FOR EVER, so the operator view shows a tier still running weeks later
      // and nothing distinguishes it from one that is. Reclaiming the job and leaving
      // its row open fixes the queue and leaves the evidence lying.
      let closedRuns = 0;
      for (const id of new Set(orphans.map((j) => String(j["review_id"] ?? "")))) {
        closedRuns += Number(
          this.db
            .prepare(
              "UPDATE tier_run SET outcome = 'failed', finished_at = ? WHERE review_id = ? AND finished_at IS NULL",
            )
            .run(at, id).changes,
        );
      }

      // AND EVERY OPEN RUN ON A REVIEW THAT HAS ALREADY ENDED, which the loop above
      // cannot reach and which is where the rows actually pile up.
      //
      // That loop is scoped to reviews with a job still `running` at startup — the
      // process died THIS time. A row orphaned by an earlier kill, whose job was later
      // requeued and then failed, has no running job left to find it by, so it stays
      // open for ever. Four such rows were sitting in the live database claiming a tier
      // had been reading `rigid-monorepo` for forty-six hours, on reviews that failed
      // two days earlier; the sweep that was supposed to catch them ran past them at
      // every restart. It was written as "clean up after the jobs I am reclaiming" when
      // the invariant is simpler and does not depend on why the row is open: A REVIEW
      // THAT HAS REACHED A VERDICT HAS NO TIER READING IT.
      //
      // `finished_at` is the operator view's only signal for in-flight work, so a row
      // that lies about it is INV-1 in the bookkeeping: something that stopped without
      // saying so, indistinguishable from something still working.
      closedRuns += Number(
        this.db
          .prepare(
            `UPDATE tier_run SET outcome = 'failed', finished_at = ?
             WHERE finished_at IS NULL
               AND review_id IN (SELECT id FROM review WHERE state IN (${TERMINAL_SQL}))`,
          )
          .run(at).changes,
      );

      // AND A REVIEW WHOSE LAST ATTEMPT BURNED OUT IS NOT STILL RUNNING. Nothing will
      // ever claim that job again, but the review sat in `running` until the 48h sweep
      // called it `expired` — and `expired` says nobody came back, which is false: the
      // ladder died. `failed` with a reason is the true answer and the one a client can
      // act on. A review that already reached a verdict is left alone.
      for (const j of burntOut) {
        const id = String(j["review_id"] ?? "");
        const changed = this.db
          .prepare(
            `UPDATE review SET state = 'failed', failed_because = ?, updated_at = ?
             WHERE id = ? AND state NOT IN (${TERMINAL_SQL})`,
          )
          .run(
            `Every attempt at a round died along with the process running it, ${String(maxAttempts)} times over. ` +
              "This is NOT a pass and NOT 'nothing found' — no tier ever finished reading the code. Something on " +
              "the lore host is killing the worker; find that before starting another review of this branch.",
            at,
            id,
          );
        if (Number(changed.changes) > 0 && !woken.includes(id)) woken.push(id);
      }

      return { requeued: retryable.length, failed: burntOut.length, closedRuns, reviewsFailed: woken.length };
    });
    // AFTER the commit, never inside it: a subscriber woken from within the transaction
    // re-reads and sees the state it was just told had changed.
    for (const id of woken) this.events.changed(id);
    return out;
  }

  finishJob(id: number, state: "done" | "failed", error?: string): void {
    // See `refusedByClose`: a round completing into a shut store is the deploy window,
    // and the job row it leaves `running` is exactly what startup requeues.
    if (this.refusedByClose(`job ${String(id)} finishing as '${state}'`)) return;
    this.db
      .prepare("UPDATE job SET state = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(state, n(error), now(), id);
  }

  /**
   * Is any job for this review queued or running right now?
   *
   * For the worker's post-close look at late-held diffs: an open job means a round
   * exists that will consume them itself, and enqueueing another would only make the
   * ladder walk an empty extra round.
   */
  hasOpenJob(reviewId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS one FROM job WHERE review_id = ? AND state IN ('queued', 'running') LIMIT 1")
      .get(reviewId) as { one?: number } | undefined;
    return row !== undefined;
  }

  /**
   * Queued jobs a worker COULD actually claim.
   *
   * The predicate is `claimJob`'s, minus the one-round-per-review clause: a job whose
   * review has ended can never be claimed, so counting it reports a backlog that does not
   * exist. It did — three unclaimable rows, one of them nineteen hours old, on a service
   * with eleven idle workers — and this number is what `/status`, the operator board and
   * the `queueBacked` ticket all read. `discardQueuedJobs` closes those rows now; this
   * stays narrow anyway, because a review can go terminal between an enqueue and a claim
   * and the count must never overstate in that window either.
   */
  queueDepth(): number {
    // `Number()` because the DECLARED type is `number | bigint`, not because a bigint
    // can arrive here. Verified against Node 26: node:sqlite returns integers as JS
    // numbers and THROWS `RangeError: Value is too large to be represented as a
    // JavaScript number` past 2^53 — it never silently hands back a bigint unless
    // `StatementSync.setReadBigInts(true)` is called, which nothing here does. A comment
    // saying otherwise stood for months and read as a guard against overflow; the real
    // reason a count cannot overflow is that it counts rows in a queue.
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM job j JOIN review rv ON rv.id = j.review_id
         WHERE j.state = 'queued' AND rv.state NOT IN (${TERMINAL_SQL})`,
      )
      .get() as Record<string, number | bigint> | undefined;
    return Number(row?.["c"] ?? 0);
  }

  /**
   * Close the queued jobs of every ENDED review at once — the sweep's backstop for
   * `discardQueuedJobs`, which fires on the transition. Returns how many.
   *
   * `failed` rather than deleted: the job table is the record of what the scheduler did,
   * and a row that vanishes cannot be asked about afterwards. `last_error` says which
   * ending it was, so a reader is never left guessing whether the round ran. Only
   * `queued`: a `running` job on a terminal review is a round being aborted right now,
   * and its worker is the one that writes its outcome — taking it from underneath would
   * race the very code that reports what the abort cost.
   *
   * `discardQueuedJobs` fires on the transition, which covers everything from now on.
   * This exists for rows that leaked before it did, and for any path that ends a review
   * without going through either place. In a healthy service it returns zero for ever,
   * which is exactly why the number is reported rather than swallowed.
   */
  closeJobsOfEndedReviews(): number {
    const res = this.db
      .prepare(
        `UPDATE job SET state = 'failed', last_error = ?, updated_at = ?
         WHERE state = 'queued'
           AND review_id IN (SELECT id FROM review WHERE state IN (${TERMINAL_SQL}))`,
      )
      .run("the review had already ended when this round was swept", now());
    return Number(res.changes);
  }

  discardQueuedJobs(reviewId: string): number {
    const state = this.stateOf(reviewId) ?? "cancelled";
    const res = this.db
      .prepare(
        "UPDATE job SET state = 'failed', last_error = ?, updated_at = ? WHERE review_id = ? AND state = 'queued'",
      )
      .run(`the review ended as '${state}' before this round was claimed`, now(), reviewId);
    return Number(res.changes);
  }

  /**
   * Reviews that have not finished, service-wide — what admission control counts (D-98).
   *
   * Across every repository on purpose: the resources it protects are shared, and a
   * per-repository limit would let four repositories put four times the load on the one
   * provider that matters.
   */
  openReviewCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM review WHERE state NOT IN (${TERMINAL_SQL})`)
      .get() as Record<string, number | bigint> | undefined;
    return Number(row?.["c"] ?? 0);
  }

  /**
   * Put a job back on the queue because LORE went away, not because the round failed.
   *
   * Returns false once it has been tried too often: a sidecar that is genuinely down —
   * rather than restarting — would otherwise requeue for ever, and a review looping
   * silently is the shape this project refuses above all others. `attempts` is already
   * incremented on every claim, so the bound is read from evidence rather than tracked.
   */
  requeueJob(id: number, why: string, maxAttempts = 3): boolean {
    const row = this.db.prepare("SELECT attempts FROM job WHERE id = ?").get(id) as
      | Record<string, number>
      | undefined;
    if (Number(row?.["attempts"] ?? 0) >= maxAttempts) return false;
    this.db
      .prepare("UPDATE job SET state = 'queued', last_error = ?, updated_at = ? WHERE id = ?")
      .run(why, now(), id);
    return true;
  }

  /** Jobs holding a worker right now. `queueDepth`'s counterpart: waiting versus working. */
  jobsRunning(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM job WHERE state = 'running'").get() as
      | Record<string, number | bigint>
      | undefined;
    return Number(row?.["c"] ?? 0);
  }

  // ------------------------------------------------------- the operator board (D-96)
  //
  // Five reads, named here rather than written at the call site, because `board.ts` is a
  // second consumer of shapes `review`, `tier_run` and `finding` already have opinions
  // about — and a query at the call site is one this class cannot maintain when a column
  // moves. The board polls while anybody is watching, so each of these is indexed and
  // none of them is per-review except where the definition it needs already lives here.

  /**
   * What belongs on the board: everything unfinished, plus whatever ended recently.
   *
   * Unfinished first regardless of recency — a verdict that just landed is interesting,
   * but it is never more interesting than the eight things still running.
   */
  boardReviews(finishedSinceIso: string, limit = 60): readonly Record<string, string | null>[] {
    return this.db
      .prepare(
        `SELECT id, repo_id, branch, pull_request, into_ref, review_path, type, state, ladder, created_at, updated_at FROM review
         WHERE state NOT IN (${TERMINAL_SQL}) OR updated_at > ?
         ORDER BY (state IN (${TERMINAL_SQL})), updated_at DESC
         LIMIT ?`,
      )
      .all(finishedSinceIso, limit) as Record<string, string | null>[];
  }

  /**
   * How many reviews `boardReviews` would return if it had no limit.
   *
   * So the board can say what its cap left out. Ordering means the rows dropped are the
   * least interesting ones — finished, then oldest — but "least interesting" is a
   * property of the ordering, not a promise about the sixty-first, and a board that shows
   * an incomplete list without saying so is telling an operator they have seen everything.
   */
  boardReviewCount(finishedSinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM review WHERE state NOT IN (${TERMINAL_SQL}) OR updated_at > ?`,
      )
      .get(finishedSinceIso) as Record<string, number | bigint> | undefined;
    return Number(row?.["c"] ?? 0);
  }

  /**
   * Every tier attempt across MANY reviews, oldest first, open runs included.
   *
   * Deliberately not named `tierRunsFor`: that already exists one screen up, takes a
   * single id and returns every column. Two overloads of one name is how this file
   * briefly had two — TypeScript called it a duplicate implementation, the later one won
   * at runtime, and a subscription test failed somewhere unrelated.
   */
  tierRunsAcross(reviewIds: readonly string[]): readonly Record<string, string | number | null>[] {
    if (reviewIds.length === 0) return [];
    return this.db
      .prepare(
        `SELECT review_id, tier, round, outcome, started_at, finished_at FROM tier_run
         WHERE review_id IN (${reviewIds.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...reviewIds) as Record<string, string | number | null>[];
  }

  /** Findings per review per severity — raw counts; `openFindings` is what is still work. */
  findingCountsFor(reviewIds: readonly string[]): readonly Record<string, string | number | null>[] {
    if (reviewIds.length === 0) return [];
    return this.db
      .prepare(
        `SELECT review_id, severity, COUNT(*) c FROM finding
         WHERE review_id IN (${reviewIds.map(() => "?").join(",")}) GROUP BY review_id, severity`,
      )
      .all(...reviewIds) as Record<string, string | number | null>[];
  }

  /** The newline-separated "did not run" notes from every round of one review (INV-1). */
  checksSkippedFor(reviewId: string): readonly string[] {
    const rows = this.db
      .prepare("SELECT unavailable FROM tier_run WHERE review_id = ? AND unavailable IS NOT NULL")
      .all(reviewId) as Record<string, string | null>[];
    const seen = new Set<string>();
    for (const r of rows) {
      for (const line of String(r["unavailable"] ?? "").split("\n")) {
        if (line.trim() !== "") seen.add(line.trim());
      }
    }
    return [...seen];
  }

  /**
   * When this review last had a finding raised against it, or `undefined` if never.
   *
   * Evidence of life that touches no other table: a tier can raise findings for twenty
   * minutes without the review row moving at all.
   */
  lastFindingAt(reviewId: string): string | undefined {
    const row = this.db
      .prepare("SELECT MAX(first_seen) AS m FROM finding WHERE review_id = ?")
      .get(reviewId) as Record<string, string | null> | undefined;
    const m = row?.["m"];
    return m === null || m === undefined ? undefined : String(m);
  }

  /**
   * Re-queue every review of this repo that is parked on `needs_human`.
   *
   * Called when a conflict is settled. `spec/knowledge.md` §7.3 says a block must have
   * an exit and that the ladder recomputes `needsHuman` from currently-open conflicts
   * each round — true, and unreachable, because nothing scheduled the round that would
   * do the recomputing. A client that resolved the conflict and waited, exactly as
   * instructed, waited for nothing; `needs_human` is not terminal, so the staleness
   * sweep turned the review into `expired` two days later.
   *
   * Only reviews still parked are touched. One that has moved on, been abandoned, or
   * reached a verdict is left alone — re-queueing a finished review would pay for a
   * round nobody asked for.
   *
   * Returns how many were resumed, so the caller can say so rather than implying it.
   */
  resumeNeedsHuman(repoId: string, decision?: string): number {
    const rows = this.db
      .prepare("SELECT id FROM review WHERE repo_id = ? AND state = 'needs_human'")
      .all(repoId) as Record<string, string>[];
    for (const r of rows) {
      const id = r["id"] ?? "";
      // WHAT THE PERSON DECIDED, written BEFORE the state changes (D-99).
      //
      // The state change is what wakes a subscribed client, and a client woken before
      // this row is written re-reads the review and finds the decision missing — the same
      // ordering bug `updateReview`'s own comment records, which had the wake published
      // ahead of the write. To the client the wake would look like an ordinary requeue,
      // which is precisely the thing it must not look like: a person acted, and the
      // client is about to redo work they have already settled.
      if (decision !== undefined) {
        this.db.prepare("UPDATE review SET human_decision = ? WHERE id = ?").run(decision, id);
      }
      // `enqueue` collapses an identical queued round (D-53), so resolving two
      // conflicts in a row cannot buy the same review two workers.
      this.enqueue(id, "fast");
      this.updateReview(id, { state: "queued" });
    }
    return rows.length;
  }

  /** What a person decided about the question that blocked this review, if one did. */
  /**
   * Forget a person's answer when the review parks on a NEW question.
   *
   * `human_decision` tells a client "somebody already decided; do not ask your user". Left
   * standing, it says that about a contradiction that has nothing to do with the one now
   * blocking the review — so a client obeying the docs never escalates the second question,
   * nothing else can move `needs_human`, and the review is swept as `expired` having
   * concluded nothing. Exactly the abandonment D-95 and D-99 were built to end, reached by
   * a different road. Raised by lore's own t2.
   */
  clearHumanDecision(reviewId: string): void {
    this.db.prepare("UPDATE review SET human_decision = NULL WHERE id = ?").run(reviewId);
  }

  humanDecision(reviewId: string): string | undefined {
    const row = this.db.prepare("SELECT human_decision FROM review WHERE id = ?").get(reviewId) as
      | Record<string, string | null>
      | undefined;
    const v = row?.["human_decision"];
    return v === null || v === undefined ? undefined : String(v);
  }

  /**
   * REVIEWS HOLDING A HIGH FINDING NOBODY HAS COLLECTED, older than `hours`.
   *
   * `make status` has shown these since D-96 and nothing ever alerted on them, so the one
   * party who can see a rotting review is the operator — who cannot act, because the
   * findings belong to another principal's token and `review_inbox` is correctly scoped to
   * that token. Observed 2026-08-17: one review on `master` holding an undelivered HIGH,
   * unread for nearly three days, visible on `/status` the whole time and invisible to
   * every client. A deep tier was paid to produce it.
   *
   * `delivered_at IS NULL` is the same predicate the operator view groups by, so the two
   * cannot disagree about what "uncollected" means. HIGH only, and the branch's OWN
   * (`preexisting = 0`) — D-68's reasoning applies here more than anywhere, because an
   * alert that fires on the same inherited pattern match every day is one nobody reads.
   *
   * Counted as REVIEWS rather than findings: the thing that has gone wrong is that a
   * client stopped coming back, and that is one fact per review however many findings sit
   * behind it.
   */
  uncollectedHighOlderThan(hours: number): number {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    const row = this.db
      .prepare(
        // EXCLUDES ONLY WHAT GENUINELY SELF-RESOLVES, and `TERMINAL_SQL` was the wrong
        // set for that — found live, four days after this line shipped.
        //
        // `TERMINAL_SQL` excluded `failed` alongside `expired`/`cancelled`, and `failed`
        // has neither of THEIR reasons to be excluded. `cancelled` hands its findings over
        // explicitly at the moment of cancelling (`review_cancel` calls `markDelivered` on
        // everything raised, as its own comment says: "this is the handover") — genuinely
        // self-resolving. `expired` only happens after `findings_ready` sat unanswered for
        // days of escalating signal (`findings_stale`, then the sweep) — the client was
        // told repeatedly and chose not to come back. `failed` has NEITHER: a round can
        // fail on its very first attempt, with no warning and no handover, and nothing
        // marks what it already found as delivered. That is precisely the live case that
        // found this — a HIGH finding on `master`, undelivered for four days, invisible to
        // this query the whole time because the review carrying it happened to end
        // `failed` rather than `expired`.
        //
        // `PERSON_OR_CLOCK_DECIDED_SQL` is the set this always meant: a person's decision
        // or the clock's abandonment-timeout, as opposed to the round's own mechanical
        // conclusion — which says nothing about whether anyone ever saw what it found.
        `SELECT COUNT(*) AS c FROM (
           SELECT f.review_id FROM finding f JOIN review r ON r.id = f.review_id
           WHERE f.delivered_at IS NULL AND f.severity = 'high' AND f.preexisting = 0
             AND r.state NOT IN (${PERSON_OR_CLOCK_DECIDED_SQL})
           GROUP BY f.review_id HAVING MIN(f.first_seen) < ?
         )`,
      )
      .get(cutoff) as Record<string, number | bigint> | undefined;
    return Number(row?.["c"] ?? 0);
  }

  /**
   * Reviews parked on a question nobody has answered for `hours`.
   *
   * `needs_human` blocks its review from ever passing (spec/knowledge.md §7.2), so one
   * that ages is not merely waiting — it is a review that will never finish, and the
   * only thing that can move it is a person who does not know they are needed. The
   * ticket condition for this has existed unsent since the alerting table was written.
   *
   * `updated_at` rather than `created_at`: the clock starts when the review REACHED
   * the question, not when the review began.
   */
  needsHumanOlderThan(hours: number): number {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM review WHERE state = 'needs_human' AND updated_at < ?")
      .get(cutoff) as Record<string, number | bigint> | undefined;
    return Number(row?.["c"] ?? 0);
  }
}

function toFinding(row: Record<string, string | number | null>): RecordedFinding {
  const line = row["line"];
  const symbol = row["symbol"];
  const cwe = row["cwe"];
  const scopeBlob = row["scope_blob"];
  const scopeHunk = row["scope_hunk"];
  return {
    fingerprint: String(row["fingerprint"] ?? ""),
    file: String(row["file"] ?? ""),
    ...(typeof line === "number" ? { line } : {}),
    ...(typeof symbol === "string" ? { symbol } : {}),
    severity: String(row["severity"] ?? "low") as Severity,
    claim: String(row["claim"] ?? ""),
    evidence: String(row["evidence"] ?? ""),
    failureScenario: String(row["failure_scenario"] ?? ""),
    ...(typeof cwe === "string" ? { cwe } : {}),
    origin: String(row["origin"] ?? ""),
    round: Number(row["round"] ?? 0),
    firstSeen: String(row["first_seen"] ?? ""),
    // Rows written before the column existed read as `false`, which is the safe
    // direction: an old finding is treated as this branch's, not silently demoted.
    preexisting: Number(row["preexisting"] ?? 0) === 1,
    // Absent stays absent: it means "cannot tell whether the code moved", and the
    // settling rule in D-56 declines to act on that rather than guessing.
    ...(typeof scopeBlob === "string" && typeof scopeHunk === "string"
      ? { scope: { blob: scopeBlob, hunk: scopeHunk } }
      : {}),
  };
}

/** Run `quick_check` on whatever connection is handed over, reporting rather than throwing. */
function faultOf(open: () => DatabaseSync): string | undefined {
  try {
    const rows = open().prepare("PRAGMA quick_check").all() as { quick_check?: string }[];
    const first = rows[0]?.quick_check ?? "ok";
    return first === "ok" ? undefined : first;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function toKnowledge(row: Record<string, string | number | null>): KnowledgeItem {
  return {
    id: String(row["id"] ?? ""),
    repoId: String(row["repo_id"] ?? ""),
    kind: String(row["kind"] ?? "fact") as KnowledgeKind,
    source: String(row["source"] ?? "derived") as KnowledgeSource,
    statement: String(row["statement"] ?? ""),
    why: un(row["why"] as string | null) ?? undefined,
    path: un(row["path"] as string | null) ?? undefined,
    cwe: un(row["cwe"] as string | null) ?? undefined,
    provenance: un(row["provenance"] as string | null) ?? undefined,
    sourceBlob: un(row["source_blob"] as string | null) ?? undefined,
    // WRITTEN AND NEVER READ BACK is the shape this codebase teaches against, and this
    // field is the one where it costs most: `retireForChangedBlob` decides what to
    // retire by comparing stamps, so anybody auditing the base through the Store saw
    // `undefined` on every row and would conclude the stamping never landed — or, worse,
    // treat a current row as one an older reader wrote. The audit that re-measured this
    // base had to go around the Store into raw SQL to see the column at all.
    extractor: un(row["extractor"] as string | null) ?? undefined,
    confidence: un(row["confidence"] as number | null) ?? undefined,
    verifiedAt: String(row["verified_at"] ?? ""),
  };
}
