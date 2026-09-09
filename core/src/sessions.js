'use strict';
/**
 * asmltr-core — session store (plan §A2).
 *
 * Maps a channel-computed `conversation_key` → `engine_session_id`, then the
 * next core turn passes that id as runTurn({ resume }). This subsumes Discord
 * per-server, Telegram per-user, MCP per-user, CLI, web chat — they are all
 * just different key formulas.
 *
 * RESUME UUID (Grok first-class):
 *   For the grok engine, engine_session_id IS the Grok CLI session UUID
 *   (UUIDv7 from `grok -s` / the streaming-json sessionId). The next turn
 *   passes resume=that UUID → grok.js emits `-r <uuid>`. That is the real
 *   continuity mechanism. Do not fake it by re-injecting the full system
 *   prompt every turn: grok's `-r` already replays the first-turn system
 *   block (historyReplaysSystemPrompt=true). When a finite idle expires we CLEAR the
 *   UUID (and last_stable_*) so the next turn is a fresh grok session and
 *   the full identity prompt is sent again. The infinite path never clears
 *   the grok UUID.
 *
 * IDLE POLICY:
 *   Stored as 'infinite' | 'idle:<minutes>' (integer minutes — see
 *   parseIdlePolicy / idlePolicyFromEnv). Default is infinite (jarethmt).
 *   Session idle reads ASMLTR_IDLE_POLICY only (infinite/off/none or idle:N).
 *   Do not read ASMLTR_IDLE_MS here — that env is the Live card nap
 *   (collector liveActive.js + dashboard format.js DEFAULT_IDLE_MS 1800000).
 *   Unset policy → infinite even when ASMLTR_IDLE_MS=1800000 is set for Live.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const DB_PATH = require('./db-path').coreDbPath();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL'); // exec, not pragma(): Node 24 GC of throwaway Statement ABRTs

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
    outbound_target    TEXT,                               -- channel/chat id to reply TO
    last_stable_hash   TEXT,                               -- sha256 of the STABLE system-prompt block last injected (inject-once optimization)
    last_stable_engine TEXT,                               -- which engine that stable block was injected for (guards a mid-session engine switch)
    next_effort        TEXT                                -- one-shot grok --effort for the NEXT spawn (high|xhigh|medium|low); cleared after use
  );
`);

// Migrations: add columns to a pre-existing table (created before they existed).
const _colsStmt = db.prepare('PRAGMA table_info(sessions)');
const _cols = _colsStmt.all().map((c) => c.name);
for (const col of ['working_dir', 'outbound_instance_id', 'outbound_target', 'last_stable_hash', 'last_stable_engine', 'next_effort']) {
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
// Drop a dead engine session (pruned/expired upstream) without touching the conversation itself.
const _clearEngineId = db.prepare('UPDATE sessions SET engine_session_id = NULL, last_stable_hash = NULL, last_stable_engine = NULL, last_activity_at = ? WHERE conversation_key = ?');
const _touch = db.prepare('UPDATE sessions SET last_activity_at = ?, turn_count = turn_count + 1 WHERE conversation_key = ?');
const _setClaim = db.prepare('UPDATE sessions SET claim_state = ?, claimed_by = ? WHERE conversation_key = ?');
const _setRoute = db.prepare('UPDATE sessions SET outbound_instance_id = ?, outbound_target = ? WHERE conversation_key = ?');
const _setStable = db.prepare('UPDATE sessions SET last_stable_hash = ?, last_stable_engine = ? WHERE conversation_key = ?');
const _remove = db.prepare('DELETE FROM sessions WHERE conversation_key = ?');
// Forget a session entirely: the next inbound on this key gets a FRESH engine session (new history).
function remove(conversation_key) { return _remove.run(conversation_key).changes > 0; }

const _insAnnounce = db.prepare('INSERT INTO announcements (target, text, priority, from_session, created_at, expires_at) VALUES (@target, @text, @priority, @from_session, @created_at, @expires_at)');
const _liveAnnounce = db.prepare('SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > @now) ORDER BY id ASC');
const _maxAnnounceId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM announcements');
const _setCursor = db.prepare('UPDATE sessions SET last_announce_id = ? WHERE conversation_key = ?');

function nowMs() { return Date.now(); }

// --- idle policy -------------------------------------------------------------
// Canonical on-disk values: 'infinite' | 'idle:<minutes>'. Accept a few human
// aliases at the env boundary ('15m', '15', 'off') and always persist the
// canonical form so resolveForTurn's /^idle:(\d+)$/ keeps working.
const DEFAULT_IDLE_MINUTES = 30;

function parseIdlePolicy(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (v === 'infinite' || v === 'off' || v === 'none') return 'infinite';
  let m = /^idle:(\d+)$/.exec(v);
  if (m) return Number(m[1]) > 0 ? `idle:${Number(m[1])}` : 'infinite';
  m = /^(\d+)\s*m$/.exec(v);
  if (m) return Number(m[1]) > 0 ? `idle:${Number(m[1])}` : 'infinite';
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n > 0 ? `idle:${n}` : 'infinite';
  }
  return null;
}

/** Session idle: ASMLTR_IDLE_POLICY if set; else infinite. ASMLTR_IDLE_MS is Live-only. */
function idlePolicyFromEnv() {
  const named = parseIdlePolicy(process.env.ASMLTR_IDLE_POLICY);
  if (named) return named;
  return 'infinite';
}

const _setIdle = db.prepare('UPDATE sessions SET idle_policy = ? WHERE conversation_key = ?');
const _clearEngine = db.prepare('UPDATE sessions SET engine_session_id = NULL, last_stable_hash = NULL, last_stable_engine = NULL WHERE conversation_key = ?');

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
 * @returns {{ resume: string|null, key: string, expired: boolean }}
 *   resume = Grok/engine UUID to pass as runTurn({ resume }), or null for a fresh session.
 *   expired = true when idle:<minutes> elapsed and we CLEARED the stored UUID.
 */
function resolveForTurn(conversation_key, channel, idle_policy = 'infinite', working_dir = DEFAULT_CWD) {
  const row = ensure(conversation_key, channel, idle_policy, working_dir);
  // Keep the stored policy in sync with what this turn asked for (env can change
  // without dropping the conversation_key).
  if (idle_policy && row.idle_policy !== idle_policy) {
    _setIdle.run(idle_policy, conversation_key);
    row.idle_policy = idle_policy;
  }
  if (!row.engine_session_id) return { resume: null, key: conversation_key, expired: false };

  // idle:<minutes> → drop the engine UUID and start fresh; 'infinite' always resumes.
  const m = /^idle:(\d+)$/.exec(row.idle_policy || 'infinite');
  if (m) {
    const windowMs = Number(m[1]) * 60 * 1000;
    if (nowMs() - row.last_activity_at > windowMs) {
      // Fresh grok session: do not pass -r of a stale UUID, and drop last_stable_*
      // so inject-once re-sends the full system prompt on the new session.
      _clearEngine.run(conversation_key);
      return { resume: null, key: conversation_key, expired: true };
    }
  }
  return { resume: row.engine_session_id, key: conversation_key, expired: false };
}

/** Persist the engine session id (for grok: the CLI resume UUID) captured from the turn. */
function recordEngineId(conversation_key, engine_session_id) {
  if (!engine_session_id) return;
  _setEngineId.run(engine_session_id, nowMs(), conversation_key);
}

/**
 * Forget only the ENGINE session, keeping the conversation row. Used when the engine reports that the
 * id we asked it to resume no longer exists (Claude Code prunes transcripts after its retention
 * window), so the next turn starts a fresh engine session instead of failing forever on a dead id.
 *
 * The stable-block marker goes with it: a fresh session has never been sent the stable prompt, so
 * leaving the marker would make inject-once skip it on a history-retaining engine.
 *
 * Deliberately NOT `remove()` — working_dir, idle policy, outbound route and turn count all describe
 * the CONVERSATION, not the engine session, and the conversation is still very much alive.
 * @returns {boolean} true if a row was updated
 */
function clearEngineId(conversation_key) {
  return _clearEngineId.run(nowMs(), conversation_key).changes > 0;
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

/**
 * Record which STABLE system-prompt block (by hash) was last delivered for a session, and for which
 * engine. Powers the inject-once optimization: on a history-retaining engine (e.g. codex, whose resume
 * replays prior turns server-side), the next turn re-sends only the small volatile tail when this hash
 * still matches — instead of folding the whole identity/trust/toolbelt block into every user turn.
 */
function recordStable(conversation_key, stable_hash, engine) {
  _setStable.run(stable_hash || null, engine || null, conversation_key);
}

const _setNextEffort = db.prepare('UPDATE sessions SET next_effort = ? WHERE conversation_key = ?');

/**
 * Operator one-shot: persist effort for the NEXT grok -p on this conversation_key.
 * Consumed (cleared) by consumeNextEffort at spawn. Current in-flight grok -p is unchanged.
 * effort: high|xhigh|medium|low. Pass null to clear.
 */
function setNextEffort(conversation_key, effort) {
  if (!conversation_key) return false;
  if (effort == null || effort === '') {
    _setNextEffort.run(null, conversation_key);
    return true;
  }
  const v = String(effort).trim().toLowerCase();
  if (!['low', 'medium', 'high', 'xhigh'].includes(v)) return false;
  _setNextEffort.run(v, conversation_key);
  return true;
}

/** Return next_effort and clear it (one-shot). */
function consumeNextEffort(conversation_key) {
  if (!conversation_key) return null;
  const row = _get.get(conversation_key);
  if (!row || !row.next_effort) return null;
  const v = String(row.next_effort).trim().toLowerCase();
  _setNextEffort.run(null, conversation_key);
  return ['low', 'medium', 'high', 'xhigh'].includes(v) ? v : null;
}

module.exports = { db, ensure, resolveForTurn, recordEngineId, clearEngineId, touch, setClaim, setOutboundRoute, recordStable, get, remove, addAnnouncement, drainAnnouncements, listAnnouncements, parseIdlePolicy, idlePolicyFromEnv, DEFAULT_IDLE_MINUTES, DB_PATH, setNextEffort, consumeNextEffort };
