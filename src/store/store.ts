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

export interface RepoRow {
  readonly id: string;
  readonly name: string;
  readonly gitUrl: string;
}

export interface ReviewRow {
  readonly id: string;
  readonly repoId: string;
  readonly principal: string;
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
 * had explicitly refused to accept. Raised by t2 against the commit that introduced
 * the note, with a standalone repro.
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
 * production, and nothing was in a position to notice (d17c92f8).
 */
export type TierOutcome = "clean" | "findings" | "failed" | "unpayable";

export interface VerdictRow {
  readonly fingerprint: string;
  readonly verdict: VerdictKind;
  readonly rationale: string | undefined;
  readonly scope: Scope | undefined;
  readonly tier: string | undefined;
  readonly round: number | undefined;
  readonly createdAt: string;
}

export type KnowledgeKind = "rule" | "fact" | "mistake";
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

  constructor(path: string) {
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
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO repo(id, name, git_url, created_at) VALUES(?, ?, ?, ?)")
      .run(id, name, gitUrl, now());
    return { id, name, gitUrl };
  }

  // ---------------------------------------------------------------- review

  createReview(r: Omit<ReviewRow, "treeHash"> & { treeHash?: string }): void {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO review(id, repo_id, principal, branch, into_ref, ticket, type, state, tree_hash, ladder, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.repoId,
        r.principal,
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
      ladder: JSON.parse(row["ladder"] ?? "{}") as LadderState,
    };
  }

  updateReview(id: string, patch: { state?: ReviewState; ladder?: LadderState; treeHash?: string }): void {
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
  }

  /** Reviews for a principal, newest first — backs `review.inbox`. */
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
  closeTierRun(id: number, outcome: TierOutcome, unavailable: readonly string[] = []): void {
    this.db
      .prepare("UPDATE tier_run SET outcome = ?, unavailable = ?, finished_at = ? WHERE id = ?")
      .run(outcome, unavailable.length > 0 ? unavailable.join("\n") : null, now(), id);
  }

  /**
   * Every engine that could not run in this review, deduplicated, worst-case first
   * seen. Empty means everything the review type asks for actually executed.
   */
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
   * Do we already hold this exact statement for this repository?
   *
   * Compared on normalised text rather than on provenance: the same reason ratified
   * in two reviews is one fact about the codebase, however many times it was argued.
   */
  hasKnowledgeStatement(repoId: string, statement: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS present FROM knowledge WHERE repo_id = ? AND retired_at IS NULL AND LOWER(TRIM(statement)) = ? LIMIT 1",
      )
      .get(repoId, statement.trim().toLowerCase()) as Record<string, number> | undefined;
    return row !== undefined;
  }

  unavailableChecks(reviewId: string): readonly string[] {
    const rows = this.db
      .prepare("SELECT unavailable FROM tier_run WHERE review_id = ? AND unavailable IS NOT NULL ORDER BY id")
      .all(reviewId) as { unavailable: string }[];
    return [...new Set(rows.flatMap((r) => r.unavailable.split("\n")).filter((l) => l.length > 0))];
  }

  recordTierRun(reviewId: string, tier: string, round: number, outcome: TierOutcome, startedAt: string): void {
    this.db
      .prepare(
        "INSERT INTO tier_run(review_id, tier, round, outcome, started_at, finished_at) VALUES(?, ?, ?, ?, ?, ?)",
      )
      .run(reviewId, tier, round, outcome, startedAt, now());
  }

  // --------------------------------------------------------------- finding

  /**
   * Record a finding, idempotently.
   *
   * A re-raise of a finding already on file is not new work, so the first sighting
   * wins and `first_seen` is preserved. Returns whether this was genuinely new.
   */
  recordFinding(reviewId: string, f: RecordedFinding): boolean {
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

  // --------------------------------------------------------------- verdict

  recordVerdict(reviewId: string, v: Omit<VerdictRow, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO verdict(review_id, fingerprint, verdict, rationale, scope_blob, scope_hunk, tier, round, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                               source_blob, confidence, verified_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        n(item.confidence),
        item.verifiedAt,
      );
    return item;
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
   * Retire knowledge derived from a document that has changed.
   *
   * Re-derived, never retained: a stale doc must not become a confidently wrong
   * rule injected into every future session (D-20). This is the single guard
   * against the knowledge base rotting.
   */
  retireForChangedBlob(repoId: string, provenance: string, currentBlob: string): number {
    const res = this.db
      .prepare(
        `UPDATE knowledge SET retired_at = ?, retired_reason = 'source document changed'
         WHERE repo_id = ? AND provenance = ? AND source_blob IS NOT NULL
           AND source_blob != ? AND retired_at IS NULL`,
      )
      .run(now(), repoId, provenance, currentBlob);
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
   */
  resolveConflict(repoId: string, keepId: string, retireId: string, reason: string): boolean {
    return this.tx(() => {
      const open = this.db
        .prepare(
          `SELECT id FROM knowledge_conflict
           WHERE repo_id = ? AND state = 'open'
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
   * Observed on `rev_cuZabwdrspNwv3OV6eu0IHA_`, 2026-08-04. Two `fast` jobs existed
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
   * TOCTOU that t2 found (8b859cdc): a job sits queued, the check says no round is
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

  failureReason(reviewId: string): string | undefined {
    const row = this.db
      .prepare("SELECT last_error FROM job WHERE review_id = ? AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(reviewId) as { last_error: string } | undefined;
    return row?.last_error ?? undefined;
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

  reclaimOrphanedJobs(maxAttempts = 3): { readonly requeued: number; readonly failed: number } {
    return this.tx(() => {
      const failed = this.db
        .prepare(
          `UPDATE job SET state = 'failed', last_error = ?, updated_at = ?
           WHERE state = 'running' AND attempts >= ?`,
        )
        .run(
          `abandoned by a worker that stopped mid-round, and it had already used its ${maxAttempts} attempts`,
          now(),
          maxAttempts,
        );
      // `attempts < ?` is REDUNDANT and stays, because the redundancy is the point.
      //
      // The statement above has already set the burnt-out rows to 'failed', so they no
      // longer match `state = 'running'` and this would skip them anyway — correct,
      // but correct only because of the order these two statements appear in, with
      // nothing saying so. Swap them and every job at the limit is quietly requeued
      // instead of failed, which is the crash-loop the bound exists to prevent, and
      // the tests would still pass on the original order.
      //
      // Found by a reviewer reading this an hour after it was written.
      const requeued = this.db
        .prepare("UPDATE job SET state = 'queued', updated_at = ? WHERE state = 'running' AND attempts < ?")
        .run(now(), maxAttempts);
      return { requeued: Number(requeued.changes), failed: Number(failed.changes) };
    });
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
    confidence: un(row["confidence"] as number | null) ?? undefined,
    verifiedAt: String(row["verified_at"] ?? ""),
  };
}
