-- asmltr-insights — collector data model (better-sqlite3, WAL).
-- The `events` table is the append-only spine; sessions/usage_rollup/notifications
-- are projections maintained in the same transaction as each ingest for fast panels.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Append-only event spine. Every producer writes here. Mirrors shared/events.js.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,                 -- unix ms
  surface     TEXT    NOT NULL,                 -- discord|telegram|assistant-web|assistant-native|mcp|github|claude-code|system|core
  session_id  TEXT,                             -- conversation/session id (nullable for system events)
  identity    TEXT,                             -- resolved user/channel key
  event_type  TEXT    NOT NULL,                 -- inbound|outbound|tool|token-usage|identity_resolved|moderation_decision|session-start|session-end|system-sample|notification|control
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL    NOT NULL DEFAULT 0,       -- 0 for Max-subscription surfaces; >0 only where an API key backs it
  payload     TEXT,                             -- JSON blob
  source      TEXT                              -- concrete producer that posted it (audit)
);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_surface ON events(surface, ts);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type, ts);

-- ---------------------------------------------------------------------------
-- Session projection. Claude Code sessions are RECONCILED (mirrored) from
-- /tmp/eve-sessions-enhanced.json (never written back); bot daemons and core
-- conversations upsert their own rows. This is the "really alive" view the
-- dashboard reads (with liveness correction applied in reconcile.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,          -- conversation_key, CC screen id, or daemon name
  surface            TEXT NOT NULL,
  kind               TEXT NOT NULL,             -- 'ephemeral' | 'persistent'
  pid                INTEGER,
  identity           TEXT,
  context            TEXT,                      -- general|client-work|personal-project|infrastructure|opensource
  working_dir        TEXT,
  task               TEXT,
  title              TEXT,                      -- short generated label for the session card
  location           TEXT,                      -- human origin, e.g. "Acme · #general" (Discord server · channel)
  status             TEXT,                      -- active|idle|ended|paused
  started_unix       INTEGER,
  last_activity_unix INTEGER,
  tool_count         INTEGER DEFAULT 0,
  tokens_total       INTEGER DEFAULT 0,
  -- takeover / attach (A5b, B6)
  engine_session_id  TEXT,                      -- claude session uuid for --resume
  worktree           TEXT,                      -- git worktree path for diff/attach cwd
  claim_state        TEXT DEFAULT 'free',       -- free|channel-running|terminal-claimed|paused
  claimed_by         TEXT,                      -- e.g. cli:user@pts/3 or dashboard:<user>
  multiplexer        TEXT DEFAULT 'none',       -- none|tmux|screen
  tmux_target        TEXT,                      -- tmux session name when taken over
  updated_unix       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_claim  ON sessions(claim_state);

-- ---------------------------------------------------------------------------
-- Pre-aggregated usage for the cost/usage panel (hourly buckets).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_rollup (
  bucket_hour INTEGER NOT NULL,                 -- unix hour (ts // 3600000 * 3600000)
  surface     TEXT    NOT NULL,
  identity    TEXT    NOT NULL DEFAULT '',
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL    NOT NULL DEFAULT 0,
  msg_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_hour, surface, identity)
);

-- ---------------------------------------------------------------------------
-- Notifications feed (mirrors what an admin-notify hook sent).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  channel    TEXT NOT NULL,                     -- telegram|discord|tts|push
  title      TEXT,
  body       TEXT,
  surface    TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(ts);

-- ---------------------------------------------------------------------------
-- System metrics samples (also emitted as 'system-sample' events for the timeline).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_metrics (
  ts            INTEGER PRIMARY KEY,            -- unix ms
  cpu_pct       REAL,
  load1         REAL,
  load5         REAL,
  mem_used_mb   INTEGER,
  mem_total_mb  INTEGER,
  disk_used_pct REAL,
  disk_free_gb  REAL
);

-- ---------------------------------------------------------------------------
-- Audit log of privileged control actions (kill/stop/resume/claim/release/restart).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL,                         -- Remote-User from Authelia, or cli:<user>@<tty>
  action TEXT NOT NULL,                         -- kill|stop|resume|claim|release|takeover|diff|restart-daemon
  target TEXT NOT NULL,                         -- session_id / pid / container
  result TEXT NOT NULL,                         -- success|failure|denied
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON control_audit(ts);

-- Schema version marker (single row).
CREATE TABLE IF NOT EXISTS schema_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT INTO schema_meta (k, v) VALUES ('version', '1')
  ON CONFLICT(k) DO UPDATE SET v = excluded.v;
