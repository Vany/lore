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
import type { LadderState } from "../core/ladder.ts";
import { TERMINAL_SQL, type ReviewState } from "../core/review-state.ts";
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
  readonly intoRef: string;
  readonly ticket: string;
  readonly type: string;
  readonly state: ReviewState;
  readonly treeHash: string | undefined;
  readonly ladder: LadderState;
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
export const TIER_OUTCOMES = ["clean", "findings", "failed", "unpayable"] as const;
export type TierOutcome = (typeof TIER_OUTCOMES)[number];

/** The outcomes that mean the tier did NOT read the code, as a SQL list. Derived, never spelled out. */
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
    this.db.close();
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

  createReview(r: Omit<ReviewRow, "treeHash"> & { treeHash?: string }): void {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO review(id, repo_id, principal, token_hash, tiers, branch, into_ref, ticket, type, state, tree_hash, ladder, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.repoId,
        r.principal,
        n(r.tokenHash),
        n(r.tiers),
        r.branch,
        r.intoRef,
        r.ticket,
        r.type,
        r.state,
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
  ): { id: string; state: string; round: number; ageHours: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, state, ladder, updated_at FROM review
         WHERE repo_id = ? AND branch = ? AND state NOT IN (${TERMINAL_SQL})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repoId, branch) as Record<string, string> | undefined;
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
      intoRef: row["into_ref"] ?? "",
      ticket: row["ticket"] ?? "",
      type: row["type"] ?? "",
      state: (row["state"] ?? "failed") as ReviewState,
      treeHash: un(row["tree_hash"] ?? null),
      tokenHash: un(row["token_hash"] ?? null),
      tiers: un(row["tiers"] ?? null),
      ladder: JSON.parse(row["ladder"] ?? "{}") as LadderState,
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

  updateReview(id: string, patch: { state?: ReviewState; ladder?: LadderState; treeHash?: string }): void {
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
    args.push(id);
    this.db.prepare(`UPDATE review SET ${sets.join(", ")} WHERE id = ?`).run(...args);
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
  expireStaleReviews(cutoff: string): readonly string[] {
    const ids = this.tx(() => {
      const rows = this.db
        .prepare(`SELECT id FROM review WHERE updated_at < ? AND state NOT IN (${TERMINAL_SQL})`)
        .all(cutoff) as Record<string, string>[];
      if (rows.length > 0) {
        this.db
          .prepare(
            `UPDATE review SET state = 'expired', updated_at = ?
             WHERE updated_at < ? AND state NOT IN (${TERMINAL_SQL})`,
          )
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
        `SELECT id FROM review WHERE principal = ? AND (? IS NULL OR repo_id = ?)
         ORDER BY updated_at DESC LIMIT ?`,
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
  closeTierRun(id: number, outcome: TierOutcome, unavailable: readonly string[] = [], treeHash?: string): void {
    this.db
      .prepare("UPDATE tier_run SET outcome = ?, unavailable = ?, tree_hash = ?, finished_at = ? WHERE id = ?")
      .run(outcome, unavailable.length > 0 ? unavailable.join("\n") : null, n(treeHash), now(), id);
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
   * Has any model call this deployment ever made reported a cost?
   *
   * Distinguishes "spent nothing" from "cannot measure spending". Asked of ALL of
   * history rather than of today, because a subscription-only deployment never
   * reports a cost on any day, and one day's zero is normal even where costs exist.
   */
  hasMeteredUsage(): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM usage WHERE cost_usd > 0 LIMIT 1").get() as
      | Record<string, number>
      | undefined;
    return row !== undefined;
  }

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

  /** Does any live rule for this repository come from this source? */
  hasKnowledgeFrom(repoId: string, provenance: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM knowledge WHERE repo_id = ? AND provenance = ? AND retired_at IS NULL LIMIT 1")
        .get(repoId, provenance) !== undefined
    );
  }

  /**
   * What this repository decided about findings LIKE this one, elsewhere.
   *
   * Matched on the normalised claim OR the CWE, not the fingerprint: the same defect in
   * another file is the same lesson described differently, and the fingerprint cannot
   * see that (D-44). The current finding is excluded, so "prior" means what it says.
   */
  priorVerdictsLike(repoId: string, fingerprint: string, normalizedClaim: string, cwe: string | undefined): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT v.verdict AS verdict
         FROM finding fi
         JOIN review r ON r.id = fi.review_id
         JOIN verdict v ON v.fingerprint = fi.fingerprint AND v.review_id = fi.review_id
         WHERE r.repo_id = ?
           AND fi.fingerprint != ?
           AND (LOWER(TRIM(fi.claim)) = ? OR (fi.cwe IS NOT NULL AND fi.cwe = ?))
           AND v.id = (SELECT MAX(v2.id) FROM verdict v2
                       WHERE v2.fingerprint = v.fingerprint AND v2.review_id = v.review_id)`,
      )
      .all(repoId, fingerprint, normalizedClaim, cwe ?? " ") as Record<string, string>[];
    return rows.map((r) => r["verdict"] ?? "");
  }

  /** How many times this repository has raised a finding like this one, elsewhere. */
  countPriorLike(repoId: string, fingerprint: string, normalizedClaim: string, cwe: string | undefined): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM finding fi JOIN review r ON r.id = fi.review_id
         WHERE r.repo_id = ?
           AND fi.fingerprint != ?
           AND (LOWER(TRIM(fi.claim)) = ? OR (fi.cwe IS NOT NULL AND fi.cwe = ?))`,
      )
      .get(repoId, fingerprint, normalizedClaim, cwe ?? " ") as Record<string, number> | undefined;
    return Number(row?.["c"] ?? 0);
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

  /** Reviews holding findings nobody has collected — `/status`'s uncollected section. */
  uncollectedByReview(): readonly Record<string, string | number | null>[] {
    return this.db
      .prepare(
        `SELECT r.id, r.branch,
                COUNT(*) AS undelivered,
                SUM(CASE WHEN f.severity = 'high' THEN 1 ELSE 0 END) AS high,
                MIN(f.first_seen) AS waiting_since
         FROM finding f JOIN review r ON r.id = f.review_id
         WHERE f.delivered_at IS NULL
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

  /** Delete finished reviews older than a cutoff. Returns how many rows went. */
  deleteReviewsBefore(iso: string): number {
    const res = this.db
      .prepare(`DELETE FROM review WHERE state IN (${TERMINAL_SQL}) AND updated_at < ?`)
      .run(iso);
    return Number(res.changes);
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
   */
  retirePolicy(repoId: string, short: string, reason: string): "retired" | "not-found" | "ambiguous" {
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

  /** Live knowledge for a repo, optionally narrowed to a path prefix. */
  knowledgeFor(repoId: string, pathPrefix?: string, limit = 200): readonly KnowledgeItem[] {
    const rows = (
      pathPrefix === undefined
        ? this.db
            .prepare("SELECT * FROM knowledge WHERE repo_id = ? AND retired_at IS NULL LIMIT ?")
            .all(repoId, limit)
        : this.db
            .prepare(
              `SELECT * FROM knowledge WHERE repo_id = ? AND retired_at IS NULL
               AND (path IS NULL OR ? LIKE path || '%') LIMIT ?`,
            )
            .all(repoId, pathPrefix, limit)
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
   */
  resolveConflict(repoId: string, keepId: string, retireId: string, reason: string): boolean {
    return this.tx(() => {
      const open = this.db
        .prepare(
          `SELECT id FROM knowledge_conflict
           WHERE repo_id = ? AND state IN ('open', 'needs-human')
             AND ((left_id = ? AND right_id = ?) OR (left_id = ? AND right_id = ?))`,
        )
        .get(repoId, keepId, retireId, retireId, keepId) as Record<string, number> | undefined;
      if (open === undefined) return false;

      const t = now();
      this.db
        .prepare("UPDATE knowledge SET retired_at = ?, retired_reason = ? WHERE id = ? AND repo_id = ?")
        .run(t, reason, retireId, repoId);
      this.db
        .prepare("UPDATE knowledge_conflict SET state = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?")
        .run(reason, t, Number(open["id"]));
      return true;
    });
  }

  /** Mark a conflict as one only a person can settle. Still blocks passing. */
  escalateConflict(repoId: string, leftId: string, rightId: string, note: string): void {
    this.db
      .prepare(
        `UPDATE knowledge_conflict SET state = 'needs-human', resolution = ?
         WHERE repo_id = ? AND state = 'open'
           AND ((left_id = ? AND right_id = ?) OR (left_id = ? AND right_id = ?))`,
      )
      .run(note, repoId, leftId, rightId, rightId, leftId);
  }

  /**
   * Conflicts that still block a review from passing.
   *
   * Both `open` and `needs-human` count. Escalating to a person is not progress
   * toward passing — it is a statement that passing requires someone who has not
   * looked yet.
   */
  openConflicts(repoId: string): readonly { left: string; right: string; state: string }[] {
    const rows = this.db
      .prepare(
        "SELECT left_id, right_id, state FROM knowledge_conflict WHERE repo_id = ? AND state IN ('open', 'needs-human')",
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
    this.db
      .prepare("UPDATE job SET state = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(state, n(error), now(), id);
  }

  queueDepth(): number {
    // COUNT() comes back as bigint from node:sqlite for large values.
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM job WHERE state = 'queued'").get() as
      | Record<string, number | bigint>
      | undefined;
    return Number(row?.["c"] ?? 0);
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
  resumeNeedsHuman(repoId: string): number {
    const rows = this.db
      .prepare("SELECT id FROM review WHERE repo_id = ? AND state = 'needs_human'")
      .all(repoId) as Record<string, string>[];
    for (const r of rows) {
      const id = r["id"] ?? "";
      // `enqueue` collapses an identical queued round (D-53), so resolving two
      // conflicts in a row cannot buy the same review two workers.
      this.enqueue(id, "fast");
      this.updateReview(id, { state: "queued" });
    }
    return rows.length;
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
