'use strict';
/**
 * core/src/streams.js — topic/project event STREAMS (roadmap §A, issue #93).
 *
 * A stream is a genuinely separate, append-only event log for a project or topic that multiple agent
 * sessions register to and RECALL from on demand — so they share context without each carrying the whole
 * history in their prompt (which would blow the KV cache). This is the "context bank" idea, renamed to
 * streams. Recall is retrieve-on-demand (FTS5/BM25), and freshness is an edge-triggered watermark: a
 * session is told "N new events since I last checked" only when that count RISES, counting only events
 * from OTHER sources (not its own writes) so it never nudges itself every turn.
 *
 * Tables (in the core DB): streams · stream_events (+ FTS5 mirror) · stream_members · stream_cursors.
 */
const Database = require('better-sqlite3');
const DB_PATH = require('./db-path').coreDbPath();
const fs = require('fs');
const path = require('path');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL'); // exec, not pragma(): Node 24 GC of throwaway Statement ABRTs

db.exec(`
  CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, description TEXT,
    owner TEXT, created INTEGER
  );
  CREATE TABLE IF NOT EXISTS stream_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id TEXT NOT NULL, ts INTEGER NOT NULL,
    source TEXT,          -- who wrote it: a session key, 'asset', 'note', 'operator', …
    session_key TEXT,     -- the originating session (NULL for filed assets) — used to exclude own writes
    kind TEXT,            -- turn | note | asset | recording | control | …
    text TEXT, meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_stream_events_sid_ts ON stream_events(stream_id, ts);
  CREATE TABLE IF NOT EXISTS stream_members (
    stream_id TEXT, session_key TEXT, attached_at INTEGER,
    PRIMARY KEY (stream_id, session_key)
  );
  CREATE TABLE IF NOT EXISTS stream_cursors (
    session_key TEXT, stream_id TEXT, last_announced INTEGER DEFAULT 0,
    PRIMARY KEY (session_key, stream_id)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS stream_events_fts USING fts5(text, content='stream_events', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS stream_events_ai AFTER INSERT ON stream_events BEGIN
    INSERT INTO stream_events_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS stream_events_ad AFTER DELETE ON stream_events BEGIN
    INSERT INTO stream_events_fts(stream_events_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`);

const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // a session is "active" on a stream if it wrote within this window
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'stream';
const rowToMeta = (r) => { if (r && typeof r.meta === 'string') { try { r.meta = JSON.parse(r.meta); } catch (_) { r.meta = null; } } return r; };

function create({ name, description, owner } = {}) {
  const base = slugify(name || 'stream');
  let slug = base, n = 2;
  while (db.prepare('SELECT 1 FROM streams WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  const id = 'stream_' + require('crypto').randomBytes(6).toString('hex');
  db.prepare('INSERT INTO streams (id, slug, name, description, owner, created) VALUES (?,?,?,?,?,?)')
    .run(id, slug, name || slug, description || '', owner || process.env.ASSISTANT_NAME || 'self', Date.now());
  return get(id);
}

function get(slugOrId) {
  return db.prepare('SELECT * FROM streams WHERE id = ? OR slug = ?').get(slugOrId, slugOrId) || null;
}

// List streams with liveness: event count, last-touched, and which sessions are currently active on them.
function list() {
  const streams = db.prepare('SELECT * FROM streams ORDER BY created DESC').all();
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  return streams.map((s) => {
    const agg = db.prepare('SELECT COUNT(*) c, MAX(ts) last, MAX(source) src FROM stream_events WHERE stream_id = ?').get(s.id);
    const active = db.prepare('SELECT DISTINCT session_key k FROM stream_events WHERE stream_id = ? AND ts > ? AND session_key IS NOT NULL').all(s.id, cutoff).map((r) => r.k);
    return { ...s, event_count: agg.c || 0, last_ts: agg.last || null, active_sessions: active };
  });
}

function attach(streamId, sessionKey) {
  const s = get(streamId); if (!s) return null;
  db.prepare('INSERT OR IGNORE INTO stream_members (stream_id, session_key, attached_at) VALUES (?,?,?)').run(s.id, sessionKey, Date.now());
  return s;
}
function detach(streamId, sessionKey) { const s = get(streamId); if (s) db.prepare('DELETE FROM stream_members WHERE stream_id = ? AND session_key = ?').run(s.id, sessionKey); }
function membersOf(sessionKey) { return db.prepare('SELECT stream_id FROM stream_members WHERE session_key = ?').all(sessionKey).map((r) => r.stream_id); }

// Append an event to a stream. `ts` epoch-ms (defaults now). Returns the new event id.
function append(streamId, { source, session_key, kind, text, meta, ts } = {}) {
  const s = get(streamId); if (!s) return null;
  const info = db.prepare('INSERT INTO stream_events (stream_id, ts, source, session_key, kind, text, meta) VALUES (?,?,?,?,?,?,?)')
    .run(s.id, ts || Date.now(), source || null, session_key || null, kind || 'note', String(text || ''), meta ? JSON.stringify(meta) : null);
  return info.lastInsertRowid;
}

function recent(streamId, n = 50) {
  const s = get(streamId); if (!s) return [];
  return db.prepare('SELECT * FROM stream_events WHERE stream_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(s.id, n).reverse().map(rowToMeta);
}

// FTS5/BM25 recall within a stream. Query is sanitized to a safe MATCH expression (terms OR'd, prefix-matched).
function search(streamId, query, n = 20) {
  const s = get(streamId); if (!s) return [];
  const terms = String(query || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (!terms.length) return recent(streamId, n);
  const match = terms.map((t) => `"${t}"*`).join(' OR ');
  try {
    return db.prepare(
      `SELECT e.* FROM stream_events_fts f JOIN stream_events e ON e.id = f.rowid
       WHERE e.stream_id = ? AND stream_events_fts MATCH ? ORDER BY bm25(stream_events_fts) LIMIT ?`
    ).all(s.id, match, n).map(rowToMeta);
  } catch (_) { return recent(streamId, n); }
}

// Freshness watermark for a session: for each attached stream, how many events from OTHER sources have
// landed since we last told this session (its cursor). Only streams with new>0 are "fresh". Reading this
// does NOT advance the cursor — call markAnnounced() once the nudge has actually been shown.
function freshness(sessionKey) {
  const out = [];
  for (const sid of membersOf(sessionKey)) {
    const s = get(sid); if (!s) continue;
    const ext = db.prepare('SELECT COUNT(*) c, MAX(ts) last FROM stream_events WHERE stream_id = ? AND (session_key IS NULL OR session_key != ?)').get(sid, sessionKey);
    const cur = db.prepare('SELECT last_announced FROM stream_cursors WHERE session_key = ? AND stream_id = ?').get(sessionKey, sid);
    const total = ext.c || 0, announced = (cur && cur.last_announced) || 0;
    out.push({ stream_id: sid, slug: s.slug, name: s.name, new: Math.max(0, total - announced), total_external: total, last_ts: ext.last || null });
  }
  return out;
}
function markAnnounced(sessionKey, streamId, count) {
  db.prepare('INSERT INTO stream_cursors (session_key, stream_id, last_announced) VALUES (?,?,?) ON CONFLICT(session_key, stream_id) DO UPDATE SET last_announced = excluded.last_announced')
    .run(sessionKey, streamId, count);
}

function remove(streamId) {
  const s = get(streamId); if (!s) return false;
  db.prepare('DELETE FROM stream_events WHERE stream_id = ?').run(s.id);
  db.prepare('DELETE FROM stream_members WHERE stream_id = ?').run(s.id);
  db.prepare('DELETE FROM stream_cursors WHERE stream_id = ?').run(s.id);
  db.prepare('DELETE FROM streams WHERE id = ?').run(s.id);
  return true;
}

module.exports = { db, create, get, list, attach, detach, membersOf, append, recent, search, freshness, markAnnounced, remove };
