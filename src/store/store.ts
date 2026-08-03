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
import type { ReviewState } from "../core/review-state.ts";
import type { Scope } from "../core/scope.ts";
import { DDL, PRAGMAS, SCHEMA_VERSION } from "./schema.ts";

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
  /** Tier id or T0 engine name that raised it. */
  readonly origin: string;
  readonly round: number;
  readonly firstSeen: string;
}

export type VerdictKind = "fixed" | "justified-accepted" | "justified-rejected";

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
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO NOTHING")
      .run(String(SCHEMA_VERSION));
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
  listReviews(principal: string, limit = 50): readonly ReviewRow[] {
    const rows = this.db
      .prepare("SELECT id FROM review WHERE principal = ? ORDER BY updated_at DESC LIMIT ?")
      .all(principal, limit) as Record<string, string>[];
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
  recordTierRun(reviewId: string, tier: string, round: number, outcome: string, startedAt: string): void {
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
                             failure_scenario, cwe, origin, round, first_seen)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
    return res.changes > 0;
  }

  /** Findings not yet handed to the client — `poll` returns deltas, never repeats. */
  undelivered(reviewId: string): readonly RecordedFinding[] {
    const rows = this.db
      .prepare("SELECT * FROM finding WHERE review_id = ? AND delivered_at IS NULL ORDER BY severity, file")
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

  openFindings(reviewId: string): readonly RecordedFinding[] {
    const rows = this.db
      .prepare(
        `SELECT f.* FROM finding f
         WHERE f.review_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM verdict v
             WHERE v.review_id = f.review_id AND v.fingerprint = f.fingerprint
               AND v.verdict IN ('fixed', 'justified-accepted')
           )`,
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
           AND v.verdict IN ('fixed', 'justified-accepted')`,
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
                           output_tokens, cost_usd, latency_ms, outcome, at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        u.outcome,
        now(),
      );
  }

  /** Spend since an ISO timestamp — what the daily ceiling is checked against. */
  spendSince(iso: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE at >= ?").get(iso) as
      | Record<string, number | bigint>
      | undefined;
    return Number(row?.["total"] ?? 0);
  }

  // ------------------------------------------------------------------- job

  enqueue(reviewId: string, stage: "fast" | "deep"): void {
    const t = now();
    this.db
      .prepare("INSERT INTO job(review_id, stage, state, created_at, updated_at) VALUES(?, ?, 'queued', ?, ?)")
      .run(reviewId, stage, t, t);
  }

  /** Claim one queued job atomically, so two workers never take the same one. */
  claimJob(): { id: number; reviewId: string; stage: "fast" | "deep" } | undefined {
    return this.tx(() => {
      const row = this.db
        .prepare("SELECT id, review_id, stage FROM job WHERE state = 'queued' ORDER BY id LIMIT 1")
        .get() as Record<string, string | number> | undefined;
      if (row === undefined) return undefined;
      const id = Number(row["id"]);
      this.db
        .prepare("UPDATE job SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(now(), id);
      return { id, reviewId: String(row["review_id"]), stage: String(row["stage"]) as "fast" | "deep" };
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
}

function toFinding(row: Record<string, string | number | null>): RecordedFinding {
  const line = row["line"];
  const symbol = row["symbol"];
  const cwe = row["cwe"];
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
