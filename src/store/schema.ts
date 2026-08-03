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

export const SCHEMA_VERSION = 1;

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
  branch      TEXT NOT NULL,
  into_ref    TEXT NOT NULL,
  ticket      TEXT NOT NULL,
  type        TEXT NOT NULL,
  state       TEXT NOT NULL,
  -- The tree actually reviewed. The attestation covers this, not a branch name
  -- (D-40): if the branch moved, the signature does not describe what is there now.
  tree_hash   TEXT,
  ladder      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_by_principal ON review(principal, updated_at DESC);
CREATE INDEX IF NOT EXISTS review_by_repo ON review(repo_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tier_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   TEXT NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  tier        TEXT NOT NULL,
  round       INTEGER NOT NULL,
  outcome     TEXT,
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
  round            INTEGER NOT NULL,
  first_seen       TEXT NOT NULL,
  -- Poll returns deltas, so a client is never shown the same finding twice: in an
  -- LLM-driven loop duplicate work is indistinguishable from real work.
  delivered_at     TEXT,
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
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verdict_by_finding ON verdict(review_id, fingerprint, id DESC);

CREATE TABLE IF NOT EXISTS knowledge (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repo(id),
  -- rule | fact | mistake
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
  scope_blob     TEXT,
  scope_hunk     TEXT,
  confidence     REAL,
  verified_at    TEXT NOT NULL,
  retired_at     TEXT,
  retired_reason TEXT
);
CREATE INDEX IF NOT EXISTS knowledge_live ON knowledge(repo_id, retired_at);
CREATE INDEX IF NOT EXISTS knowledge_by_path ON knowledge(repo_id, path);

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
  outcome       TEXT NOT NULL,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_by_day ON usage(at);

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
`;
