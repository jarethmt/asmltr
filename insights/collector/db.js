'use strict';
/**
 * asmltr-insights — SQLite layer (plan §B1/§B2).
 *
 * `events` is the append-only spine; sessions/usage_rollup/notifications are
 * projections maintained in the SAME transaction as each ingest. Synchronous
 * better-sqlite3 fits a single-writer collector.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildEvent } = require('../../shared/events');
const liveActive = require('./liveActive');

const DB_PATH = process.env.ASMLTR_INSIGHTS_DB || path.join(__dirname, 'data', 'insights.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Migrations: add columns to a pre-existing sessions table (created before they existed).
{
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!cols.includes('title')) db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
  if (!cols.includes('location')) db.exec('ALTER TABLE sessions ADD COLUMN location TEXT');
  if (!cols.includes('activity')) db.exec('ALTER TABLE sessions ADD COLUMN activity TEXT'); // live "what it's doing now" rollup
  if (!cols.includes('title_locked')) db.exec('ALTER TABLE sessions ADD COLUMN title_locked INTEGER DEFAULT 0'); // 1 = manually set, AI gen must not overwrite
  const mcols = db.prepare('PRAGMA table_info(system_metrics)').all().map((c) => c.name);
  if (!mcols.includes('swap_used_mb')) db.exec('ALTER TABLE system_metrics ADD COLUMN swap_used_mb INTEGER DEFAULT 0');
  if (!mcols.includes('swap_total_mb')) db.exec('ALTER TABLE system_metrics ADD COLUMN swap_total_mb INTEGER DEFAULT 0');
  // billed_cost_usd: the actually-billed portion (API-key surfaces), split out from cost_usd (equivalent value).
  const ecols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  if (!ecols.includes('billed_cost_usd')) db.exec('ALTER TABLE events ADD COLUMN billed_cost_usd REAL NOT NULL DEFAULT 0');
  const ucols = db.prepare('PRAGMA table_info(usage_rollup)').all().map((c) => c.name);
  if (!ucols.includes('billed_cost_usd')) db.exec('ALTER TABLE usage_rollup ADD COLUMN billed_cost_usd REAL NOT NULL DEFAULT 0');
}

// Proprioception 1b — the considered self-assessment series (deduced goal + threads + flags +
// semantic relations), one row per reflection so the goal can be watched shifting over time.
db.exec(`CREATE TABLE IF NOT EXISTS self_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  goal TEXT,
  threads_json TEXT,
  flags_json TEXT,
  relations_json TEXT,
  parts INTEGER,
  edges INTEGER,
  digest_hash TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_self_assessments_ts ON self_assessments (ts DESC)');

const _insEvent = db.prepare(`
  INSERT INTO events (ts, surface, session_id, identity, event_type, tokens_in, tokens_out, cost_usd, billed_cost_usd, payload, source)
  VALUES (@ts, @surface, @session_id, @identity, @event_type, @tokens_in, @tokens_out, @cost_usd, @billed_cost_usd, @payload, @source)
`);
const _upsertUsage = db.prepare(`
  INSERT INTO usage_rollup (bucket_hour, surface, identity, tokens_in, tokens_out, cost_usd, billed_cost_usd, msg_count)
  VALUES (@bucket, @surface, @identity, @ti, @to, @cost, @bc, @msg)
  ON CONFLICT(bucket_hour, surface, identity) DO UPDATE SET
    tokens_in = tokens_in + @ti, tokens_out = tokens_out + @to,
    cost_usd = cost_usd + @cost, billed_cost_usd = billed_cost_usd + @bc, msg_count = msg_count + @msg
`);
const _upsertAux = db.prepare(`
  INSERT INTO usage_aux (bucket_hour, surface, feature, provider, model, units, unit_count, calls, cost_usd, billed_cost_usd)
  VALUES (@bucket, @surface, @feature, @provider, @model, @units, @count, 1, @cost, @bc)
  ON CONFLICT(bucket_hour, surface, feature, provider, model, units) DO UPDATE SET
    unit_count = unit_count + @count, calls = calls + 1,
    cost_usd = cost_usd + @cost, billed_cost_usd = billed_cost_usd + @bc
`);
const _insNotif = db.prepare(`
  INSERT INTO notifications (ts, channel, title, body, surface, session_id)
  VALUES (@ts, @channel, @title, @body, @surface, @session_id)
`);
const _upsertSession = db.prepare(`
  INSERT INTO sessions (session_id, surface, kind, identity, status, started_unix, last_activity_unix, tokens_total, tool_count, updated_unix)
  VALUES (@sid, @surface, @kind, @identity, @status, @now, @now, @tokens, @tools, @now)
  ON CONFLICT(session_id) DO UPDATE SET
    surface = excluded.surface,
    identity = COALESCE(excluded.identity, sessions.identity),
    status = excluded.status,
    last_activity_unix = excluded.last_activity_unix,
    tokens_total = sessions.tokens_total + @tokens,
    tool_count = sessions.tool_count + @tools,
    updated_unix = excluded.updated_unix
`);

const SESSION_EVENTS = new Set(['inbound', 'outbound', 'tool', 'token-usage', 'session-start']);

/**
 * Ingest one event (already-built shape from shared/events.js). Writes the spine
 * row + all projections atomically. Returns the stored event, or throws on a
 * malformed event so the HTTP layer can 400.
 */
const ingestEvent = db.transaction((raw) => {
  // Normalize via the shared contract: defaults ts/tokens, validates enums
  // (throws on bad surface/event_type → HTTP layer turns it into a 400).
  const evt = buildEvent(raw);

  const row = {
    ts: evt.ts,
    surface: evt.surface,
    session_id: evt.session_id || null,
    identity: evt.identity || null,
    event_type: evt.event_type,
    tokens_in: evt.tokens_in || 0,
    tokens_out: evt.tokens_out || 0,
    cost_usd: evt.cost_usd || 0,
    billed_cost_usd: evt.billed_cost_usd || 0,
    payload: evt.payload ? JSON.stringify(evt.payload) : null,
    source: evt.source || null,
  };
  _insEvent.run(row);

  // usage rollup (hourly bucket). Count an inbound as one message.
  if (row.tokens_in || row.tokens_out || row.cost_usd || row.event_type === 'inbound') {
    _upsertUsage.run({
      bucket: Math.floor(row.ts / 3600000) * 3600000,
      surface: row.surface,
      identity: row.identity || '',
      ti: row.tokens_in, to: row.tokens_out, cost: row.cost_usd, bc: row.billed_cost_usd,
      msg: row.event_type === 'inbound' ? 1 : 0,
    });
  }

  // aux usage rollup — a token-usage event tagged with a `feature` in its payload is a metered
  // side-surface call (tts/stt/moderation/…). Break it out per provider/feature/model for the panel.
  if (row.event_type === 'token-usage' && evt.payload && evt.payload.feature) {
    const p = evt.payload;
    _upsertAux.run({
      bucket: Math.floor(row.ts / 3600000) * 3600000,
      surface: row.surface,
      feature: String(p.feature),
      provider: p.provider ? String(p.provider) : '',
      model: p.model ? String(p.model) : '',
      units: p.units ? String(p.units) : '',
      count: Number(p.count) || 0,
      cost: row.cost_usd,
      bc: row.billed_cost_usd,
    });
  }

  // notifications feed
  if (row.event_type === 'notification') {
    _insNotif.run({
      ts: row.ts,
      channel: (evt.payload && evt.payload.channel) || 'unknown',
      title: (evt.payload && evt.payload.title) || null,
      body: (evt.payload && evt.payload.body) || null,
      surface: row.surface,
      session_id: row.session_id,
    });
  }

  // session projection (CC sessions are overlaid by reconcile.js; this covers core/channels/bots)
  if (row.session_id && SESSION_EVENTS.has(row.event_type)) {
    _upsertSession.run({
      sid: row.session_id,
      surface: row.surface,
      // Conversations are ephemeral session records, NOT daemons. (The actual
      // long-running connector bots are managed via the connector manager, not here.)
      kind: 'ephemeral',
      identity: row.identity,
      status: row.event_type === 'session-end' ? 'ended' : 'active',
      now: row.ts,
      tokens: row.tokens_in + row.tokens_out,
      tools: row.event_type === 'tool' ? 1 : 0,
    });
    // origin (server · channel) rides on inbound events — record it on the session for the card
    if (row.event_type === 'inbound' && evt.payload && (evt.payload.server || evt.payload.channel)) {
      const loc = fmtLocation(evt.payload.server, evt.payload.channel);
      if (loc) _setLocation.run(loc, row.session_id);
    }
    // attach/control metadata (working dir, multiplexer, pane, pid) rides on a session-start event
    if (row.event_type === 'session-start' && evt.payload) {
      const p = evt.payload;
      if (p.working_dir || p.multiplexer || p.tmux_target || p.pid || p.task) {
        _setSessionMeta.run(p.working_dir || null, p.multiplexer || null, p.tmux_target || null, p.pid || null, p.task || null, row.session_id);
      }
    }
  }

  return evt;
});
function fmtLocation(server, channel) {
  const s = server && server !== 'Direct Message' ? server : null;
  const c = channel && channel !== 'DM' ? channel : null;
  if (s && c) return `${s} · #${c}`;
  if (s) return s;
  if (c) return `#${c}`;
  return server || null; // e.g. "Direct Message"
}

// --- read queries (REST API) -------------------------------------------------
const q = {
  sessions: db.prepare(`SELECT * FROM sessions ORDER BY last_activity_unix DESC LIMIT @limit`),
  activeSessions: db.prepare(`SELECT * FROM sessions WHERE status = 'active' ORDER BY last_activity_unix DESC`),
  events: db.prepare(`
    SELECT * FROM events
    WHERE (@surface IS NULL OR surface = @surface)
      AND (@identity IS NULL OR identity = @identity)
      AND (@session IS NULL OR session_id = @session)
      AND ts >= @since
    ORDER BY ts DESC LIMIT @limit
  `),
  // tool events whose payload mentions a path (for `asmltr who <path>` — collision radar)
  eventsLike: db.prepare(`
    SELECT session_id, surface, event_type, payload, ts FROM events
    WHERE event_type IN ('tool', 'tool_result') AND payload LIKE @like AND ts > @since
    ORDER BY ts DESC LIMIT 400
  `),
  // recent tool events (for `asmltr map` — derive where each session is actively working)
  toolEventsSince: db.prepare(`
    SELECT session_id, payload, ts FROM events
    WHERE event_type = 'tool' AND ts > @since ORDER BY ts DESC LIMIT 3000
  `),
  // recent announce control events (for proprioception communicated-edges: from → target)
  announceEventsSince: db.prepare(`
    SELECT identity, payload, ts FROM events
    WHERE event_type = 'control' AND payload LIKE '%"action":"announce"%' AND ts > @since
    ORDER BY ts DESC LIMIT 500
  `),
  // full-content search across events (for the dashboard session search)
  searchEvents: db.prepare(`
    SELECT session_id, event_type, payload, ts FROM events
    WHERE session_id IS NOT NULL AND payload LIKE @like AND ts > @since
    ORDER BY ts DESC LIMIT 800
  `),
  usage: db.prepare(`SELECT * FROM usage_rollup WHERE bucket_hour >= @since ORDER BY bucket_hour DESC`),
  usageAux: db.prepare(`SELECT * FROM usage_aux WHERE bucket_hour >= @since ORDER BY cost_usd DESC`),
  system: db.prepare(`SELECT * FROM system_metrics WHERE ts >= @since ORDER BY ts DESC LIMIT @limit`),
  notifications: db.prepare(`SELECT * FROM notifications ORDER BY ts DESC LIMIT @limit`),
  // proprioception 1b — latest assessment + a short history for the goal timeline
  latestAssessment: db.prepare(`SELECT * FROM self_assessments ORDER BY ts DESC LIMIT 1`),
  assessmentHistory: db.prepare(`SELECT id, ts, goal, parts, edges FROM self_assessments ORDER BY ts DESC LIMIT @limit`),
};

// insert one self-assessment row (relations already mapped to session_id pairs by the caller)
const _insAssessment = db.prepare(`
  INSERT INTO self_assessments (ts, goal, threads_json, flags_json, relations_json, parts, edges, digest_hash)
  VALUES (@ts, @goal, @threads_json, @flags_json, @relations_json, @parts, @edges, @digest_hash)`);
function insertAssessment(a) { _insAssessment.run(a); }

// --- session upsert used by reconcile.js (richer column set) -----------------
const _reconcileUpsert = db.prepare(`
  INSERT INTO sessions (session_id, surface, kind, pid, identity, context, working_dir, task, status,
                        started_unix, last_activity_unix, tool_count, multiplexer, tmux_target, updated_unix)
  VALUES (@sid, @surface, @kind, @pid, @identity, @context, @working_dir, @task, @status,
          @started_unix, @last_activity_unix, @tool_count, @multiplexer, @tmux_target, @now)
  ON CONFLICT(session_id) DO UPDATE SET
    pid = excluded.pid, context = excluded.context, working_dir = excluded.working_dir,
    task = excluded.task, status = excluded.status, last_activity_unix = excluded.last_activity_unix,
    tool_count = excluded.tool_count, multiplexer = excluded.multiplexer,
    tmux_target = excluded.tmux_target, updated_unix = excluded.updated_unix
`);
function reconcileUpsert(s) { _reconcileUpsert.run({ tmux_target: null, ...s }); }

// AI-generated titles NEVER overwrite a manually-set (locked) one.
const _setTitle = db.prepare('UPDATE sessions SET title = ? WHERE session_id = ? AND COALESCE(title_locked, 0) = 0');
function setTitle(session_id, title) { _setTitle.run(title || null, session_id); }
// Manual override: lock a title so the generator leaves it alone. An empty title unlocks
// (reverts to AI generation — the title is cleared so the next inbound re-titles it).
const _setTitleManual = db.prepare('UPDATE sessions SET title = ?, title_locked = ? WHERE session_id = ?');
function setTitleManual(session_id, title) {
  const t = (title || '').trim();
  const info = _setTitleManual.run(t || null, t ? 1 : 0, session_id);
  return info.changes > 0;
}
const _setActivity = db.prepare('UPDATE sessions SET activity = ? WHERE session_id = ?');
function setActivity(session_id, activity) { _setActivity.run(activity || null, session_id); }
const _setLocation = db.prepare('UPDATE sessions SET location = ? WHERE session_id = ?');
// attach/control metadata carried on a session-start event (e.g. from the claude-code hook):
// working dir + multiplexer + pane target + pid. COALESCE so a null never clobbers a known value.
const _setSessionMeta = db.prepare(`UPDATE sessions SET
  working_dir = COALESCE(?, working_dir), multiplexer = COALESCE(?, multiplexer),
  tmux_target = COALESCE(?, tmux_target), pid = COALESCE(?, pid), task = COALESCE(?, task)
  WHERE session_id = ?`);
const _getTitle = db.prepare('SELECT title, title_locked FROM sessions WHERE session_id = ?');
function getTitle(session_id) { const r = _getTitle.get(session_id); return r ? r.title : null; }
function isTitleLocked(session_id) { const r = _getTitle.get(session_id); return !!(r && r.title_locked); }

// --- system sample (sampler.js): write metrics table + a timeline event ------
const _insMetric = db.prepare(`
  INSERT OR REPLACE INTO system_metrics (ts, cpu_pct, load1, load5, mem_used_mb, mem_total_mb, swap_used_mb, swap_total_mb, disk_used_pct, disk_free_gb)
  VALUES (@ts, @cpu_pct, @load1, @load5, @mem_used_mb, @mem_total_mb, @swap_used_mb, @swap_total_mb, @disk_used_pct, @disk_free_gb)
`);
const insertSystemSample = db.transaction((s) => {
  _insMetric.run(s);
  _insEvent.run({
    ts: s.ts, surface: 'system', session_id: null, identity: null, event_type: 'system-sample',
    tokens_in: 0, tokens_out: 0, cost_usd: 0, billed_cost_usd: 0,
    payload: JSON.stringify({ cpu_pct: s.cpu_pct, mem_used_mb: s.mem_used_mb, disk_used_pct: s.disk_used_pct }),
    source: 'sampler',
  });
});

const _endSession = db.prepare(
  `UPDATE sessions SET status = 'ended', updated_unix = ? WHERE session_id = ? AND status = 'active'`
);

/**
 * Honest Live list: status=active rows that are still inside the idle window
 * (or pid-backed). Past-idle no-pid web rows are excluded and marked ended
 * without DELETE so history stays and a later inbound can set active again.
 */
function listLiveActive({ persistEnded = true, now = Date.now(), idleMs } = {}) {
  const cutoffMs = idleMs == null ? liveActive.idleMsFromEnv() : idleMs;
  const rows = q.activeSessions.all();
  const live = [];
  const stale = [];
  for (const s of rows) {
    if (liveActive.isLiveActive(s, now, cutoffMs)) live.push(s);
    else stale.push(s);
  }
  if (persistEnded && stale.length) {
    const tx = db.transaction((list) => {
      const ts = Date.now();
      for (const s of list) _endSession.run(ts, s.session_id);
    });
    tx(stale);
  }
  return live;
}

module.exports = { db, ingestEvent, reconcileUpsert, setTitle, setTitleManual, getTitle, isTitleLocked, setActivity, insertSystemSample, insertAssessment, q, listLiveActive, isLiveActive: liveActive.isLiveActive, DB_PATH };
