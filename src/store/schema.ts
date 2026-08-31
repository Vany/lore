/**
 * The database schema.
 *
 * One SQLite file per deployment. `node:sqlite` is built into Node ≥24, so
 * persistence costs no dependency. WAL because reviews run in parallel and readers
 * must not block the writer.
 *
 * The knowledge tables are the ones that matter: findings and verdicts are the
 * record of one review, but `knowledge` is what the service is *for* (D-14). Losing
 * it loses everything the workgroup ever taught the tool, which is why backups are
 * a first-class operational concern rather than housekeeping.
 *
 * SPEC: SPEC.md §3, spec/knowledge.md
 */

import type { DatabaseSync } from "node:sqlite";
import { SEVERITIES } from "../core/finding.ts";

// 22: refactor_run / refactor_suggestion (D-136).
// 21: held_diff.fixed_elsewhere (D-133).
// 20: fixed_elsewhere_claim (D-133).
// 4: usage.diff_chars (D-58).
// 3: finding.scope_blob / finding.scope_hunk (D-56). Bumped in the same change that
// adds the columns, because this number is what `assertNotDowngrade` compares — left
// behind, it says a database written by this build is identical to one written before
// the columns existed.
export const SCHEMA_VERSION = 22;

/**
 * How findings are ordered wherever the service hands them out: worst first.
 *
 * `severity` is TEXT and SQLite orders TEXT lexicographically, so `ORDER BY severity`
 * meant "high", "low", "medium" — a **low**-severity finding served ahead of a medium
 * one by every query that presents findings. Ordering matters most where a list gets
 * cut short, because there it decides what a reader never sees at all.
 *
 * Generated from `SEVERITIES` (declared worst first) rather than written out, so the
 * SQL rank and `severityRank` cannot drift apart. The interpolation is over a
 * compile-time `as const` array of bare words — no value here comes from input.
 *
 * `ELSE -1` puts a severity the code does not know at the very top: an unrecognised
 * value is a bug in whatever wrote it, and burying it at the bottom of a truncated
 * list is how it would stay unnoticed.
 *
 * `fingerprint` is last so the keys are unique within a review and the sequence does
 * not depend on which plan SQLite chose.
 */
export const FINDING_ORDER_SQL = `CASE severity ${SEVERITIES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(" ")} ELSE -1 END, file, line, fingerprint`;

export const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  // Durable enough for this workload and far faster than FULL: WAL + NORMAL loses
  // at most the last transaction on power loss, and a lost review is re-runnable.
  // Lost *knowledge* would not be, which is what replication is for.
  "PRAGMA synchronous = NORMAL",
  "PRAGMA busy_timeout = 5000",
] as const;

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repo (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  git_url    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token (
  -- sha256 of the bearer token. The plaintext is shown once at provisioning and
  -- never stored: a database backup should not be a set of live credentials.
  hash       TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  repo_id    TEXT NOT NULL REFERENCES repo(id),
  label      TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS token_live ON token(hash, revoked_at);

CREATE TABLE IF NOT EXISTS review (
  id          TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL REFERENCES repo(id),
  -- The token principal this handle belongs to. Every call re-checks it: possession
  -- of a review id is never authentication (D-23).
  principal   TEXT NOT NULL,
  -- WHICH TOKEN started it (D-78). A poll RETURNS DELTAS AND MARKS THEM DELIVERED, so
  -- a colleague polling a review they did not start silently takes its findings and the
  -- owner is shown nothing — with three holders on one repository that is a matter of
  -- days, not a threat model. NULL means repository scope, which is what rows written
  -- before this column were started under.
  token_hash  TEXT,
  -- THE LADDER THIS REVIEW STARTED ON, one id:model per tier.
  --
  -- LadderState.cursor is an index into the tier list, resolved against whatever
  -- config is loaded NOW. Switch LORE_TIERS with a review open and cursor 1 stops
  -- meaning the tier it meant: tier_run then carries two rows both called t1
  -- naming different models, in the one table that exists to say whether a review
  -- really ran. Not a crash — a corrupted audit trail, which is worse.
  tiers       TEXT,
  branch      TEXT NOT NULL,
  -- WHERE A HUMAN GOES TO LOOK, when the client named it. A branch name is not
  -- clickable; the operator board links this. NULL is ordinary and permanent for
  -- lore's own reviews, which are cut from scratch review/<sha> refs.
  -- (No backticks in this string: the whole DDL is one template literal.)
  pull_request TEXT,
  into_ref    TEXT NOT NULL,
  ticket      TEXT NOT NULL,
  type        TEXT NOT NULL,
  state       TEXT NOT NULL,
  -- The tree actually reviewed. The attestation covers this, not a branch name
  -- (D-40): if the branch moved, the signature does not describe what is there now.
  tree_hash   TEXT,
  -- WHAT THIS REVIEW IS A REVIEW OF, frozen at review_start (D-113).
  --
  -- The commit the change-set is measured FROM. Every round used to recompute it as
  -- merge-base(into_ref, HEAD), resolving into_ref freshly each time — so when the base
  -- branch advanced to CONTAIN the branch under review, the merge-base collapsed onto
  -- HEAD and the change-set became empty. Four tiers then read nothing and the ladder
  -- could still return 'passed'. NULL predates the column and falls back to the old
  -- recompute, because inventing a base for a review already in flight would change what
  -- it claims to have read.
  base_commit TEXT,
  ladder      TEXT NOT NULL,
  -- WHY a review did not run, in the client's words, when the LADDER is what stopped
  -- it rather than a round that threw. failureReason used to read only job.last_error,
  -- which covers a throw and nothing else, so hitting a round bound produced a bare
  -- 'failed' whose own message said "no reason was recorded, which is itself a defect".
  -- It was: the bound and the tier that hit it were known exactly (D-57, INV-1).
  failed_because TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
-- ONE ROW PER REPOSITORY, enforced rather than assumed. upsertRepo reads by git_url
-- and inserts when it finds nothing, which is a check-then-act with no lock between
-- the two:
-- two provisions of the same repository racing both see nothing and both insert. Then
-- tokens, reviews and knowledge split across two rows for one repository — the knowledge
-- base halves, and a client holding the older token cannot see reviews started under the
-- newer one: one thing defined twice always disagrees eventually, with rows instead of
-- constants. Verified against the deployed database before adding: none exist there,
-- so this cannot fail an open.
CREATE UNIQUE INDEX IF NOT EXISTS repo_by_git_url ON repo(git_url);
CREATE INDEX IF NOT EXISTS review_by_principal ON review(principal, updated_at DESC);
CREATE INDEX IF NOT EXISTS review_by_repo ON review(repo_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tier_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   TEXT NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  tier        TEXT NOT NULL,
  round       INTEGER NOT NULL,
  outcome     TEXT,
  -- Engines that did NOT run, and why, newline-separated. A check that did not run
  -- must never read as a check that found nothing (INV-1), and this is the only
  -- durable record of it: T0 reports it to the model prompt in the same round, but a
  -- client polling later has no other way to learn that tsc or the suite was absent.
  unavailable TEXT,
  -- THE TREE THIS TIER ACTUALLY READ. Since a closed tier is not re-run after a fix
  -- (D-6, revised 2026-08-07), the tiers that ran early may never have seen the tree
  -- that is finally signed — so an attestation counting every tier that ever ran would
  -- claim more scrutiny than the signed tree received.
  tree_hash   TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS tier_run_by_review ON tier_run(review_id, id);

CREATE TABLE IF NOT EXISTS finding (
  review_id        TEXT NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  fingerprint      TEXT NOT NULL,
  file             TEXT NOT NULL,
  line             INTEGER,
  symbol           TEXT,
  severity         TEXT NOT NULL,
  claim            TEXT NOT NULL,
  evidence         TEXT NOT NULL,
  failure_scenario TEXT NOT NULL,
  cwe              TEXT,
  origin           TEXT NOT NULL,
  -- 1 when the branch does not touch this file and the engine only pattern-matches,
  -- so the defect was already there and every other branch inherits it too (D-68).
  preexisting      INTEGER,
  round            INTEGER NOT NULL,
  first_seen       TEXT NOT NULL,
  -- Poll returns deltas, so a client is never shown the same finding twice: in an
  -- LLM-driven loop duplicate work is indistinguishable from real work.
  delivered_at     TEXT,
  -- The code this finding is ABOUT, as it stood when the finding was raised (D-56).
  -- Blob sha of the file plus a hash of the lines around it, the same shape a
  -- verdict records. It is what lets a later round tell a finding the author FIXED
  -- from one a tier merely stopped mentioning: silence alone cannot distinguish
  -- them, and calling the second "fixed" would put a false claim in the
  -- attestation. Null for findings raised before this column existed, which are
  -- therefore never auto-settled.
  scope_blob       TEXT,
  scope_hunk       TEXT,
  PRIMARY KEY (review_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS finding_undelivered ON finding(review_id, delivered_at);
CREATE INDEX IF NOT EXISTS finding_by_short ON finding(review_id, substr(fingerprint, 1, 8));

CREATE TABLE IF NOT EXISTS verdict (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   TEXT NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  -- fixed | justified-accepted | justified-rejected
  verdict     TEXT NOT NULL,
  rationale   TEXT,
  scope_blob  TEXT,
  scope_hunk  TEXT,
  tier        TEXT,
  model       TEXT,
  round       INTEGER,
  -- The development rule this acceptance rested on, when it was an APPEAL (D-83).
  --
  -- NULL for an ordinary justification, which is the common case and the important
  -- distinction: an ordinary reason was argued on its own words and nothing can be
  -- withdrawn from under it, so it carries forward for ever (D-51). An appeal borrowed
  -- a rule's authority, and when the rule is retired the acceptance goes with it.
  --
  -- Recorded rather than inferred. It was first derived by matching the finding's engine
  -- rule class and path against the suppression table, which is broader than the claim
  -- the comment beside it made: an ORDINARY justification of a finding that merely shared
  -- a class and file with some other appeal was blocked from carrying too. A column says
  -- exactly what happened; a match says something adjacent to it.
  via_rule    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verdict_by_finding ON verdict(review_id, fingerprint, id DESC);

CREATE TABLE IF NOT EXISTS knowledge (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repo(id),
  -- rule | fact | mistake | policy  (policy = a development rule an appeal may cite, D-83)
  kind           TEXT NOT NULL,
  -- taught | ingested | derived  (precedence, highest first: D-20)
  source         TEXT NOT NULL,
  statement      TEXT NOT NULL,
  why            TEXT,
  path           TEXT,
  cwe            TEXT,
  provenance     TEXT,
  -- For ingested rules: the blob they were derived from. When it changes the rule
  -- is re-derived, never retained -- a stale doc must not become a confidently
  -- wrong rule applied to every future session.
  source_blob    TEXT,
  -- WHICH READER produced this, for ingested rules.
  --
  -- D-20 says a rule must not outlive the text that justified it, and source_blob
  -- enforces exactly that. It does not enforce the other half: a rule must not outlive
  -- the EXTRACTOR that produced it. When the reader improves, everything it wrote
  -- before stays live until somebody happens to edit the document -- which is how 399
  -- decontextualised fragments survived, because re-ingestion triggers on the source
  -- changing and the source had not changed.
  extractor      TEXT,
  scope_blob     TEXT,
  scope_hunk     TEXT,
  confidence     REAL,
  verified_at    TEXT NOT NULL,
  retired_at     TEXT,
  retired_reason TEXT
);
CREATE INDEX IF NOT EXISTS knowledge_live ON knowledge(repo_id, retired_at);
CREATE INDEX IF NOT EXISTS knowledge_by_path ON knowledge(repo_id, path);

-- What a tier decided when it ACCEPTED an appeal to a development rule (D-83).
--
-- The verdict table already remembers that one finding was justified, keyed by its
-- fingerprint -- which is the exact claim about the exact code. That is too narrow for
-- an appeal: the author's claim is not "this line is fine", it is "this project decided
-- not to enforce this rule here", and the very next edit to the file produces a new
-- fingerprint for the same rule and re-raises it. Answering the same appeal forever is
-- the loop D-57 exists to end.
--
-- So the unit is (engine rule class, path), which is what a person appealing means.
-- Deliberately NOT a directory prefix: a wider suppression than the one that was
-- argued for is a check silently switched off in files nobody looked at.
--
-- policy_short is not decoration. A suppression is only as alive as the rule that
-- authorised it: retire the rule and every suppression it bought stops applying, on the
-- next review, with no sweep -- the same shape as D-20 for ingested rules.
CREATE TABLE IF NOT EXISTS suppression (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      TEXT NOT NULL REFERENCES repo(id),
  -- The engine's own rule id, as it appears at the head of the finding's claim.
  rule_class   TEXT NOT NULL,
  -- Exactly the file the appeal was accepted for, repo-relative.
  path         TEXT NOT NULL,
  -- Short id of the development rule cited, resolved against knowledge at read time.
  policy_short TEXT NOT NULL,
  -- Who decided, and where it can be read back. A suppression with no audit trail is
  -- an unexplained hole in the review.
  review_id    TEXT NOT NULL,
  tier         TEXT NOT NULL,
  accepted_at  TEXT NOT NULL,
  UNIQUE(repo_id, rule_class, path)
);
CREATE INDEX IF NOT EXISTS suppression_by_repo ON suppression(repo_id);

CREATE TABLE IF NOT EXISTS knowledge_conflict (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     TEXT NOT NULL REFERENCES repo(id),
  left_id     TEXT NOT NULL REFERENCES knowledge(id),
  right_id    TEXT NOT NULL REFERENCES knowledge(id),
  -- open | resolved | needs-human
  state       TEXT NOT NULL,
  resolution  TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS conflict_open ON knowledge_conflict(repo_id, state);

-- D-133: a client's claim that a finding was fixed somewhere other than the line
-- it was raised on. Persisted, not held in memory -- review_submit's handler and
-- the round that actually rules on the claim are different invocations (the round
-- runs off the job queue), so a claim that only lived in the request would be gone
-- before anything read it. Never deleted: once its finding settles it drops out of
-- openFindings, which is what fixedElsewhereFor joins against, so a ruled-on claim
-- simply stops being fed in -- the same re-scan-and-let-settlement-silence-it shape
-- collectJustifications already uses for text markers.
-- ON DELETE CASCADE, unlike held_diff right above it in this file's history --
-- found by lore's own review, fingerprint f83d72a1: held_diff predates this table
-- and cannot retrofit the constraint onto an already-deployed database (CREATE
-- TABLE IF NOT EXISTS does nothing to an existing table), which is why
-- deleteReviewsBefore pre-deletes it by hand instead. fixed_elsewhere_claim has
-- never been deployed, so there is no old database to be stuck with -- the
-- correct constraint from the start avoids the exact incident deleteReviewsBefore's
-- own docblock describes: one child row with no cascade makes the retention
-- sweep's DELETE FROM review violate the FK, roll back the WHOLE transaction, and
-- repeat that failure every hour for ever, silently, with nothing old ever deleted.
CREATE TABLE IF NOT EXISTS fixed_elsewhere_claim (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   TEXT NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  file        TEXT NOT NULL,
  line        INTEGER,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fixed_elsewhere_by_review ON fixed_elsewhere_claim(review_id, fingerprint);

CREATE TABLE IF NOT EXISTS usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       TEXT,
  review_id     TEXT,
  tier          TEXT NOT NULL,
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  latency_ms    INTEGER,
  -- Agentic turns the tier took (D-50). Nullable on purpose: NULL means nobody could
  -- count them, and 0 would mean a review that never asked the model anything. The
  -- column exists to turn "cap exploration" from an argument into a distribution.
  steps         INTEGER,
  -- How big the diff was, in characters before truncation (D-58). Recorded so the
  -- ceiling can be observed instead of guessed: a threshold nobody can calibrate
  -- fails real reviews for nothing, which is D-50's trap.
  diff_chars    INTEGER,
  outcome       TEXT NOT NULL,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_by_day ON usage(at);

-- A diff accepted while a round is running, waiting for the reviewer's next emission
-- (D-107). The tree_hash is the CLIENT'S claim, verified at APPLY time — a mismatch then
-- must surface on poll, never drop the diff silently. Rows apply in id order: each held
-- diff was built by the client on top of the one before it.
-- ON DELETE CASCADE like every other review-child table. Without it the retention
-- sweep's DELETE FROM review hits a foreign-key error on the first terminal review
-- still holding an unconsumed diff (submit-then-cancel leaves exactly that) and aborts
-- the whole sweep, hourly, for ever. CREATE TABLE IF NOT EXISTS cannot retrofit this
-- onto a database that already has the table, so deleteReviewsBefore clears the rows
-- explicitly as well — this line is what makes a FRESH database right.
CREATE TABLE IF NOT EXISTS held_diff (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id  TEXT NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  diff       TEXT NOT NULL,
  tree_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id  TEXT NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  -- fast | deep
  stage      TEXT NOT NULL,
  -- queued | running | done | failed
  state      TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_queue ON job(state, id);
-- claimJob asks, for every candidate, whether that REVIEW already has a job
-- running (D-53), and enqueue asks whether an identical one is already queued.
-- Both are correlated lookups on (review_id, state), run on every poll of every
-- worker loop. (No backticks in here: this string is a template literal, and a
-- stray one ends it -- the same self-closing-delimiter bug as a */ in a block
-- comment, which happened the same night.)
CREATE INDEX IF NOT EXISTS job_by_review ON job(review_id, state);

-- Refactor suggestions (D-136): separate from review start to finish. No review_id
-- anywhere in either table, on purpose — a refactor run gates nothing and settles no
-- finding, so folding it under 'review' would let the retention sweep's own
-- ON DELETE CASCADE reach rows a review's lifecycle has no business governing.
-- (No backticks in this string: the whole DDL is one template literal, and a stray one
-- ends it early -- the same self-closing-delimiter bug as a */ in a block comment.)
CREATE TABLE IF NOT EXISTS refactor_run (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repo(id),
  principal     TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  folder        TEXT NOT NULL,
  -- queued | running | done | failed
  state         TEXT NOT NULL,
  -- Whether t1 actually merged the fan-out sets, once done — 0 means 'suggestion' below
  -- holds the raw union instead, because t1 was unavailable, failed, or misbehaved.
  -- Never silently indistinguishable from a real merge (INV-1, applied here as
  -- everywhere else): a client reading a done run must be able to tell which it got.
  combined      INTEGER,
  combiner_note TEXT,
  -- Every fan-out tier's own outcome, JSON-encoded ({tier, ok, error?, count}[]) — the
  -- same "a tier that could not run is reported" record tier_run's own 'unavailable'
  -- column keeps for review, kept here as one small blob rather than a third table since nothing
  -- queries a single tier's row on its own.
  sources       TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- lore-ok[10f8e818]: found by lore's own review — both indexes below back no
-- query that actually runs. claimRefactorRun orders 'state = queued' by
-- created_at, id (lore-ok[28be6b5c], store.ts) once id stopped being creation
-- order, not by id alone; recentRefactorRuns filters repo_id and orders
-- created_at DESC (lore-ok[cc9d46fd]), never principal or updated_at. Matched
-- to the queries that exist now instead of the ones that no longer do.
CREATE INDEX IF NOT EXISTS refactor_run_queue ON refactor_run(state, created_at, id);
CREATE INDEX IF NOT EXISTS refactor_run_by_repo ON refactor_run(repo_id, created_at DESC);
-- lore-ok[b09e98cb]: found by lore's own review of the SAME change that added
-- boardRefactorRuns/boardRefactorRunCount (D-139) — neither index above serves
-- WHERE state IN (...) OR updated_at > ? ORDER BY (...), updated_at DESC, and
-- unlike review (bounded by 90-day retention), nothing ever deletes a
-- refactor_run row: the scan this pair backs grows without bound. A plain
-- updated_at index lets SQLite's OR-optimisation combine it with the existing
-- (state, ...) index above — one branch of the OR each — instead of falling
-- back to a full scan on a table with no ceiling.
CREATE INDEX IF NOT EXISTS refactor_run_by_updated ON refactor_run(updated_at DESC);

CREATE TABLE IF NOT EXISTS refactor_suggestion (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES refactor_run(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  -- JSON array of repo-relative paths — folder-scoped, never a line number.
  area       TEXT NOT NULL,
  rationale  TEXT NOT NULL,
  rough_size TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refactor_suggestion_by_run ON refactor_suggestion(run_id, id);
`;

/**
 * Columns added to `DDL` after a database already existed somewhere.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing at all to a table that is already there,
 * so a column added above is invisible to every database created before it — and the
 * first `INSERT` naming it dies with `no such column`, taking a review that had
 * already paid for a model with it. This is not hypothetical: `lore` runs on a
 * deployed SQLite file whose `usage` table was created by version 1.
 *
 * Additive only, and each entry names the column it is adding so the check can be
 * "is it there?" rather than "has this run before?".
 */
export const MIGRATIONS: readonly { readonly table: string; readonly column: string; readonly sql: string }[] = [
  { table: "usage", column: "steps", sql: "ALTER TABLE usage ADD COLUMN steps INTEGER" },
  { table: "finding", column: "scope_blob", sql: "ALTER TABLE finding ADD COLUMN scope_blob TEXT" },
  { table: "finding", column: "scope_hunk", sql: "ALTER TABLE finding ADD COLUMN scope_hunk TEXT" },
  { table: "usage", column: "diff_chars", sql: "ALTER TABLE usage ADD COLUMN diff_chars INTEGER" },
  { table: "tier_run", column: "unavailable", sql: "ALTER TABLE tier_run ADD COLUMN unavailable TEXT" },
  // THE SAME LIST, FOR THE OTHER AUDIENCE. `unavailable` is the CLIENT's text and quotes
  // the development rule an accepted appeal cited; the reviewer's version must not, because
  // `knowledge_teach` promises a tier is told a project HAS rules and never what they say
  // (D-83). One column held only the client's, which was harmless while every round
  // recomputed both — and became a standing injection the moment a round could REUSE a
  // stored t0 (D-92), because the reused text goes straight into `renderT0` and from there
  // into every later model prompt.
  { table: "tier_run", column: "unavailable_for_tier", sql: "ALTER TABLE tier_run ADD COLUMN unavailable_for_tier TEXT" },
  // WHICH ENGINES PRODUCED THIS ROW. D-92 reuses a t0 result when the tree has not moved,
  // on the reasoning that a deterministic engine set given the same bytes cannot answer
  // differently — and left the SET a free variable. The model ladder is pinned and a
  // change refuses the review (`ladderChanged`); its deterministic half was not, so a
  // deploy that adds or drops an engine mid-review would carry the old set's answer
  // forward as though it were the new set's.
  { table: "tier_run", column: "engines", sql: "ALTER TABLE tier_run ADD COLUMN engines TEXT" },
  { table: "review", column: "behind_by", sql: "ALTER TABLE review ADD COLUMN behind_by INTEGER" },
  // Whether this finding is about code the branch never touched (D-68).
  { table: "finding", column: "preexisting", sql: "ALTER TABLE finding ADD COLUMN preexisting INTEGER" },
  // Why the ladder stopped, when it is the ladder that stopped it rather than a throw.
  { table: "review", column: "failed_because", sql: "ALTER TABLE review ADD COLUMN failed_because TEXT" },
  // WHICH TREE this tier actually read, so an attestation cannot over-claim.
  { table: "tier_run", column: "tree_hash", sql: "ALTER TABLE tier_run ADD COLUMN tree_hash TEXT" },
  // WHICH EXTRACTOR produced an ingested rule, so improving the reader retires its output.
  { table: "knowledge", column: "extractor", sql: "ALTER TABLE knowledge ADD COLUMN extractor TEXT" },
  // WHICH TOKEN started this review, so its findings are not consumed by a colleague
  // (D-78). NULL on every row that predates it, and NULL means repository scope — the
  // behaviour those reviews were started under, which is the only honest thing to give
  // a row that was never bound to anything.
  { table: "review", column: "token_hash", sql: "ALTER TABLE review ADD COLUMN token_hash TEXT" },
  // WHICH LADDER this review started on, so swapping `LORE_TIERS` cannot silently
  // rebind its cursor to a different model. NULL predates the column and is not checked.
  { table: "review", column: "tiers", sql: "ALTER TABLE review ADD COLUMN tiers TEXT" },
  // WHICH DEVELOPMENT RULE an acceptance rested on, so retiring the rule retires the
  // acceptance (D-83). NULL means an ordinary justification, which is what every row
  // written before this column was.
  { table: "verdict", column: "via_rule", sql: "ALTER TABLE verdict ADD COLUMN via_rule TEXT" },
  // WHERE A HUMAN GOES TO LOOK. A branch name is not clickable and not everyone knows
  // which forge it lives on; the operator board links to this. NULL is the ordinary
  // case for every row written before it existed, and for lore's own reviews, which are
  // cut from scratch `review/<sha>` refs that have no pull request at all.
  { table: "review", column: "pull_request", sql: "ALTER TABLE review ADD COLUMN pull_request TEXT" },
  // A PERSON ANSWERED THE QUESTION THAT BLOCKED THIS REVIEW, and the client has to be
  // told (D-99). The board can settle a contradiction with a button, which resumes every
  // review parked on it — and to the client that looks like the state simply changing,
  // with no way to learn that a human already decided or what they decided. NULL is every
  // review that was never blocked, which is almost all of them.
  { table: "review", column: "human_decision", sql: "ALTER TABLE review ADD COLUMN human_decision TEXT" },
  // THE TREE ORIGIN WAS LAST PINNED AT — never moved by a submit, a held diff, or a
  // round's fixes, which is what `tree_hash` tracks and why `pull_fresh`'s "origin has
  // nothing newer" check could never fire once any fix had landed (it compared against
  // the fixes-applied tree, not the last origin pin, so a no-op pull_fresh silently
  // rewound the review to the pre-fix tip). Set once at `review_start` and again on
  // every successful `pull_fresh`; NULL predates the column, and a NULL is read as "no
  // opinion" — the unchanged check simply cannot fire for a review that old, same as
  // before this existed.
  { table: "review", column: "origin_tree_hash", sql: "ALTER TABLE review ADD COLUMN origin_tree_hash TEXT" },
  // THE COMMIT THE CHANGE-SET IS MEASURED FROM, frozen at review_start (D-113). See the
  // column's comment in DDL for what moved underneath it. NULL predates the column and
  // means "recompute as before" — deliberately, because a review already in flight was
  // started under the old rule and back-filling a base would silently redefine what it
  // is attesting to.
  { table: "review", column: "base_commit", sql: "ALTER TABLE review ADD COLUMN base_commit TEXT" },
  // A FOLDER REVIEW'S SCOPE (D-130): the path it reviews as a full read against git's
  // empty tree, instead of diffing `into_ref` (which the write side sets to "" for
  // these rows — see store.ts's `createReview`, since `into_ref` predates this column
  // and is TEXT NOT NULL, and this migration list can only ADD a column, never relax
  // an existing constraint). NULL is every review before this column existed, and
  // every ordinary branch-vs-`into` review from here on — nearly all of them.
  { table: "review", column: "review_path", sql: "ALTER TABLE review ADD COLUMN review_path TEXT" },
  // D-133: claims a HELD diff carries, JSON-encoded, promoted to real
  // fixed_elsewhere_claim rows only once consumeHeldDiffs confirms THIS diff
  // actually applied — see holdDiff's own comment for why immediate persistence is
  // wrong. NULL for a diff with no claims and for every row written before this
  // column existed; both read back as "no claims", which is correct either way.
  { table: "held_diff", column: "fixed_elsewhere", sql: "ALTER TABLE held_diff ADD COLUMN fixed_elsewhere TEXT" },
];

/**
 * Bring an existing database up to `DDL`.
 *
 * Asks the live table what columns it has rather than trusting a version row, so it
 * is idempotent and cannot be fooled by a database whose bookkeeping and columns
 * disagree — which is how a migration system comes to believe it has already run.
 *
 * A table that is missing entirely is not an old file, it is a broken assumption:
 * `DDL` runs immediately before this. It throws, because the alternative is skipping
 * quietly and failing later at the insert, one layer away from the cause.
 */
export function applyMigrations(db: DatabaseSync, migrations: typeof MIGRATIONS = MIGRATIONS): void {
  for (const m of migrations) {
    // THIS LIST CAN ONLY EXPRESS "ADD COLUMN", so it refuses anything else rather
    // than mishandling it quietly.
    //
    // Idempotence here comes from asking whether the COLUMN exists. Put a
    // `CREATE INDEX` or a backfill `UPDATE` in this list and that question is
    // answered "no" for ever: the statement runs on every single open — silently for
    // an `IF NOT EXISTS` index, and as a crash-on-startup for anything else. Neither
    // failure points at this list.
    //
    // A migration system that supports one kind of change should say so at the point
    // someone writes the second kind, not at 3am on the deployment.
    if (!/^\s*ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s/i.test(m.sql)) {
      throw new Error(
        `migration for ${m.table}.${m.column} is not an ADD COLUMN: ${m.sql}. ` +
          "applyMigrations decides what has already run by looking for the column, so it can express nothing else. " +
          "Anything more needs a real versioned migration step.",
      );
    }
    const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(m.table) as { name?: string }[];
    if (columns.length === 0) throw new Error(`cannot migrate: table '${m.table}' does not exist`);
    if (columns.some((c) => c.name === m.column)) continue;
    db.exec(m.sql);
  }
}

/**
 * Refuse a database written by a NEWER build than this one.
 *
 * `SCHEMA_VERSION` was written on every open and read by nothing — a number that
 * looked like protection and was decoration, which is this codebase's characteristic
 * bug rather than an oversight. It now buys one specific thing.
 *
 * Rolling the container back is a normal operational move, and a downgrade is the one
 * case column-sniffing cannot handle: the columns an older build wants all exist, so
 * every migration is skipped, everything appears fine, and the old code writes into a
 * schema it does not understand — losing whatever the newer build recorded in the
 * columns it cannot see. Silent, and discovered later as missing data.
 *
 * Forward is still handled by the columns, not by this number. A version row that
 * disagrees with the actual columns must never be able to skip a migration, which is
 * why this only ever refuses and never approves.
 */
export function assertNotDowngrade(db: DatabaseSync): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value?: string }
    | undefined;
  if (row?.value === undefined) return; // first open, or a database from before this row existed
  const found = Number(row.value);
  if (!Number.isFinite(found) || found <= SCHEMA_VERSION) return;
  throw new Error(
    `this database was written by schema version ${found}; this build is ${SCHEMA_VERSION}. ` +
      "Refusing to open it: the older code would skip every migration, write into columns it does not know about, " +
      "and lose what the newer build recorded. Restore a backup from this version, or run the newer build.",
  );
}
