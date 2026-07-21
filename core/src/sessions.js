'use strict';
/**
 * asmltr-core — session store (plan §A2).
 *
 * Maps a channel-computed `conversation_key` → the SDK-assigned
 * `engine_session_id`. The SDK assigns the id (unlike the CLI's --session-id);
 * we capture it from the first `system`/`result` event and persist it, then
 * resume via options.resume. This subsumes Discord per-server, Telegram
 * per-user, MCP per-user, etc. — they are all just different key formulas.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const DB_PATH = require('./db-path').coreDbPath();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    conversation_key   TEXT PRIMARY KEY,
    engine_session_id  TEXT,
    channel            TEXT NOT NULL,
    idle_policy        TEXT NOT NULL DEFAULT 'infinite',  -- 'infinite' | 'idle:<minutes>'
    created_at         INTEGER NOT NULL,
    last_activity_at   INTEGER NOT NULL,
    turn_count         INTEGER NOT NULL DEFAULT 0,
    claim_state        TEXT NOT NULL DEFAULT 'free',       -- free|channel-running|terminal-claimed|paused
    claimed_by         TEXT,
    working_dir        TEXT,                               -- where to resume/attach (worktree or default)
    outbound_instance_id TEXT,                             -- connector instance to reply THROUGH for an out-of-band inject
    outbound_target    TEXT                                -- channel/chat id to reply TO
  );
`);

// Migrations: add columns to a pre-existing table (created before they existed).
const _cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
for (const col of ['working_dir', 'outbound_instance_id', 'outbound_target']) {
  if (!_cols.includes(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
}
// Per-session cursor: the highest announcement id this session has already drained.
if (!_cols.includes('last_announce_id')) db.exec('ALTER TABLE sessions ADD COLUMN last_announce_id INTEGER DEFAULT 0');

// Announcements = a cross-session mailbox. A write is delivered into a session's context at
// the START of its next turn (guaranteed-on-next-activity awareness, no tokens on idle sessions).
db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    target       TEXT NOT NULL DEFAULT '*',   -- '*' | <conversation_key> | 'surface:<channel>' | 'identity:<key>'
    text         TEXT NOT NULL,
    priority     TEXT NOT NULL DEFAULT 'normal',
    from_session TEXT,
    created_at   INTEGER NOT NULL,            -- ms since epoch (the announcement's timestamp)
    expires_at   INTEGER                      -- optional TTL (ms); null = never
  );
`);

const _get = db.prepare('SELECT * FROM sessions WHERE conversation_key = ?');
const _insert = db.prepare(`
  INSERT INTO sessions (conversation_key, channel, idle_policy, created_at, last_activity_at, turn_count, working_dir)
  VALUES (@conversation_key, @channel, @idle_policy, @now, @now, 0, @working_dir)
`);
// Spawn/resume cwd for a session. Neutral default: the running user's home
// (os.homedir()), so the SDK loads the host's project context (CLAUDE.md) but NOT
// whatever project the core process happens to live in. That resolves to /root when
// the core runs as root (the prior hardcoded value) and to the user's home otherwise.
// A hardcoded /root made spawn() fail with EACCES for any non-root user, who can't
// chdir into it. Override with ASMLTR_SESSION_CWD. Resume must use the SAME cwd the
// session was born in (that's how `claude --resume` locates it), so it's per-session.
const DEFAULT_CWD = process.env.ASMLTR_SESSION_CWD || os.homedir();
const _setEngineId = db.prepare('UPDATE sessions SET engine_session_id = ?, last_activity_at = ? WHERE conversation_key = ?');
const _touch = db.prepare('UPDATE sessions SET last_activity_at = ?, turn_count = turn_count + 1 WHERE conversation_key = ?');
const _setClaim = db.prepare('UPDATE sessions SET claim_state = ?, claimed_by = ? WHERE conversation_key = ?');
const _setRoute = db.prepare('UPDATE sessions SET outbound_instance_id = ?, outbound_target = ? WHERE conversation_key = ?');
const _remove = db.prepare('DELETE FROM sessions WHERE conversation_key = ?');
// Forget a session entirely: the next inbound on this key gets a FRESH engine session (new history).
function remove(conversation_key) { return _remove.run(conversation_key).changes > 0; }

const _insAnnounce = db.prepare('INSERT INTO announcements (target, text, priority, from_session, created_at, expires_at) VALUES (@target, @text, @priority, @from_session, @created_at, @expires_at)');
const _liveAnnounce = db.prepare('SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > @now) ORDER BY id ASC');
const _maxAnnounceId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM announcements');
const _setCursor = db.prepare('UPDATE sessions SET last_announce_id = ? WHERE conversation_key = ?');

function nowMs() { return Date.now(); }

/** Get the row for a key, creating it if absent. */
function ensure(conversation_key, channel, idle_policy = 'infinite', working_dir = DEFAULT_CWD) {
  let row = _get.get(conversation_key);
  if (!row) {
    _insert.run({ conversation_key, channel, idle_policy, now: nowMs(), working_dir });
    row = _get.get(conversation_key);
  }
  return row;
}

/**
 * Decide how to run the next turn for a conversation.
 * @returns {{ resume: string|null, key: string }} resume id (or null for a fresh session)
 */
function resolveForTurn(conversation_key, channel, idle_policy = 'infinite', working_dir = DEFAULT_CWD) {
  const row = ensure(conversation_key, channel, idle_policy, working_dir);
  if (!row.engine_session_id) return { resume: null, key: conversation_key };

  // idle:<minutes> policy → start fresh if past the window; 'infinite' always resumes.
  const m = /^idle:(\d+)$/.exec(row.idle_policy || 'infinite');
  if (m) {
    const windowMs = Number(m[1]) * 60 * 1000;
    if (nowMs() - row.last_activity_at > windowMs) return { resume: null, key: conversation_key };
  }
  return { resume: row.engine_session_id, key: conversation_key };
}

/** Persist the SDK-assigned engine session id captured from the event stream. */
function recordEngineId(conversation_key, engine_session_id) {
  if (!engine_session_id) return;
  _setEngineId.run(engine_session_id, nowMs(), conversation_key);
}

/** Bump activity + turn count after a completed turn. */
function touch(conversation_key) {
  _touch.run(nowMs(), conversation_key);
}

/** Takeover bookkeeping (used by the collector/CLI claim/release primitive). */
function setClaim(conversation_key, claim_state, claimed_by = null) {
  _setClaim.run(claim_state, claimed_by, conversation_key);
}

function get(conversation_key) { return _get.get(conversation_key); }

/** Post an announcement to the cross-session mailbox. Returns { id, created_at }. */
function addAnnouncement({ text, target = '*', priority = 'normal', from_session = null, ttlSec = null }) {
  const created_at = nowMs();
  const expires_at = ttlSec ? created_at + ttlSec * 1000 : null;
  const info = _insAnnounce.run({ target, text, priority: priority === 'urgent' ? 'urgent' : 'normal', from_session, created_at, expires_at });
  return { id: info.lastInsertRowid, created_at };
}

function _targetMatches(target, ctx) {
  if (!target || target === '*') return true;
  if (target === ctx.conversation_key) return true;
  const m = /^(surface|identity):(.+)$/.exec(target);
  if (m) return (m[1] === 'surface' && m[2] === ctx.channel) || (m[1] === 'identity' && m[2] === ctx.identity);
  return false;
}

/**
 * Drain the announcements this session hasn't seen yet (id > its cursor), that target it,
 * are unexpired, and aren't its own. Advances the cursor past ALL current announcements so
 * each is evaluated once. Returns the due list (with timestamps) to prepend to the turn.
 */
function drainAnnouncements(conversation_key, channel, identity) {
  const row = _get.get(conversation_key);
  const cursor = (row && row.last_announce_id) || 0;
  const now = nowMs();
  const live = _liveAnnounce.all({ now });
  const due = live.filter((a) => a.id > cursor && a.from_session !== conversation_key
    && _targetMatches(a.target, { conversation_key, channel, identity })).slice(-15); // cap to avoid a flood on a fresh session
  const maxId = _maxAnnounceId.get().m;
  if (maxId > cursor) _setCursor.run(maxId, conversation_key);
  return due;
}

/** List currently-live announcements (for `asmltr announcements` / dashboards). */
function listAnnouncements() { return _liveAnnounce.all({ now: nowMs() }); }

/** Remember where to send an out-of-band reply (operator inject) for this session. */
function setOutboundRoute(conversation_key, instance_id, target) {
  _setRoute.run(instance_id || null, target != null ? String(target) : null, conversation_key);
}

module.exports = { db, ensure, resolveForTurn, recordEngineId, touch, setClaim, setOutboundRoute, get, remove, addAnnouncement, drainAnnouncements, listAnnouncements, DB_PATH };
