#!/usr/bin/env node
'use strict';
require('../../shared/loadenv'); // load <repo>/.env before anything reads config
/**
 * asmltr-insights — collector server (plan §B1).
 *
 * POST /ingest         producers post shared-contract events (bearer-gated)
 * GET  /api/sessions   reconciled live sessions (the honest instance list)
 * GET  /api/events     filtered event feed
 * GET  /api/usage      hourly usage rollup (tokens + attribution)
 * GET  /api/system     system metric samples
 * GET  /api/notifications
 * GET  /api/brief      compact summary (the morning-brief JSON)
 * GET  /health
 * socket.io broadcasts: 'event', 'system-sample', 'sessions-changed'
 *
 * Host/PM2, bind 127.0.0.1:3017. Control routes (kill/resume/attach) land in
 * Phase 4 with stronger (Authelia group + control-token) gating.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const dbmod = require('./db');
const reconcile = require('./reconcile');
const sampler = require('./sampler');
const tailer = require('./tailer');
const { makeControl } = require('./control');
const { buildEvent } = require('../../shared/events');

const PORT = Number(process.env.ASMLTR_INSIGHTS_PORT || 3017);
const HOST = '127.0.0.1';
const TOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';
const CONTROL_TOKEN = process.env.ASMLTR_INSIGHTS_CONTROL_TOKEN || '';
const RECONCILE_MS = Number(process.env.ASMLTR_RECONCILE_MS || 15000);
const SAMPLE_MS = Number(process.env.ASMLTR_SAMPLE_MS || 30000);
const TAIL_MS = Number(process.env.ASMLTR_TAIL_MS || 5000);
const ENABLE_TAILER = process.env.ASMLTR_ENABLE_TAILER !== '0';

const app = express();
app.use(express.json({ limit: '5mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- auth: read + ingest require the service bearer (Authelia Remote-User layer
//     is added at the Traefik edge when the dashboard lands; control routes get
//     the stronger group+control-token gate in Phase 4). ----------------------
function requireToken(req, res, next) {
  if (!TOKEN) return next(); // dev mode: warned at boot
  const auth = req.get('authorization') || '';
  if (auth === `Bearer ${TOKEN}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Control routes need a STRONGER gate than reads (they SIGTERM host pids /
// restart daemons): control token + (at the edge) an admins group. Actor is the
// Authelia-forwarded Remote-User when present, else the CLI identity.
const control = makeControl(dbmod);
function requireControl(req, res, next) {
  const actor = req.get('x-remote-user') || req.get('remote-user') || req.query.actor || 'cli';
  if (CONTROL_TOKEN) {
    const auth = req.get('authorization') || '';
    if (auth !== `Bearer ${CONTROL_TOKEN}`) return res.status(403).json({ error: 'control: forbidden' });
  }
  req.actor = actor;
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'asmltr-insights-collector' }));
// Build identity — the code sha this process is running + when it started (an updater checks this
// to confirm the restart landed; /health returns 200 even on stale code).
const BUILD_SHA = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (_) { return 'unknown'; } })();
const STARTED_AT = new Date().toISOString();
app.get('/version', (req, res) => res.json({ service: 'asmltr-insights-collector', ...require('../../shared/version').info(), sha: BUILD_SHA, started_at: STARTED_AT, pid: process.pid }));

// --- session titles ----------------------------------------------------------
// Label each session card with a short generated title. On the FIRST inbound for a
// session (and every ASMLTR_TITLE_REFRESH_TURNS after) we ask the core to summarize the
// conversation into a title (a cheap, no-tools SDK call). Gen is serialized (one at a
// time) so it never floods; titles aren't urgent.
const CORE_BASE = process.env.ASMLTR_CORE_BASE || 'http://127.0.0.1:3023';
const TITLE_EVERY = Math.max(1, Number(process.env.ASMLTR_TITLE_REFRESH_TURNS || 15));
const _inboundCounts = new Map(); // session_id -> inbound events seen this process
let _titleChain = Promise.resolve();
function payloadText(e) { try { const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {}); return p.text || ''; } catch { return ''; } }
function recentConvo(sid) {
  try {
    const rows = dbmod.db.prepare("SELECT event_type, payload FROM events WHERE session_id=? AND event_type IN ('inbound','outbound') ORDER BY ts DESC LIMIT 12").all(sid);
    return rows.reverse().map((r) => { let p = {}; try { p = JSON.parse(r.payload); } catch {} const t = String(p.text || '').slice(0, 300); return t ? `${r.event_type === 'inbound' ? 'User' : 'Assistant'}: ${t}` : ''; }).filter(Boolean).join('\n');
  } catch { return ''; }
}
function queueTitle(session_id, text) {
  if (!text) return;
  _titleChain = _titleChain.then(async () => {
    try {
      const r = await fetch(CORE_BASE + '/v2/title', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.title) { dbmod.setTitle(session_id, j.title); io.emit('sessions-changed', {}); }
    } catch (_) {}
  }).catch(() => {});
}
function maybeTitle(e) {
  if (!e || e.event_type !== 'inbound' || !e.session_id || e.surface === 'system') return;
  const sid = e.session_id;
  const n = (_inboundCounts.get(sid) || 0) + 1;
  _inboundCounts.set(sid, n);
  if (dbmod.isTitleLocked(sid)) return;                                  // manual override → never auto-title
  if (!dbmod.getTitle(sid)) queueTitle(sid, payloadText(e));             // first inbound → title it now
  else if (n % TITLE_EVERY === 0) queueTitle(sid, recentConvo(sid) || payloadText(e)); // periodic refresh
}

// --- live ACTIVITY rollup: "what is this session doing right now" ------------
// The rolling counterpart to the title. Refreshed from recent activity (messages AND tools) at
// most once per session per STATUS_MIN_SEC, triggered by inbound + tool events (so a session
// grinding on a long multi-tool task updates mid-work, not just on a new message).
const STATUS_MIN_SEC = Math.max(10, Number(process.env.ASMLTR_STATUS_REFRESH_SEC || 30));
const _statusLast = new Map(); // session_id -> last status-gen time (unix sec)
let _statusChain = Promise.resolve();
function recentActivity(sid) {
  try {
    // Only the USER request + the TOOLS run — the honest signal for "what is it doing". We
    // deliberately EXCLUDE the assistant's own first-person narration/thinking, which the summarizer
    // otherwise echoes back ("Let me check…" / "I'll…") instead of producing a third-person label.
    const rows = dbmod.db.prepare(
      "SELECT event_type, payload FROM events WHERE session_id=? AND event_type IN ('inbound','tool') ORDER BY ts DESC LIMIT 18"
    ).all(sid);
    return rows.reverse().map((r) => {
      let p = {}; try { p = JSON.parse(r.payload); } catch {}
      if (r.event_type === 'inbound') return `User request: ${String(p.text || '').slice(0, 240)}`;
      return `ran ${p.tool || 'tool'}${p.input ? ': ' + String(typeof p.input === 'string' ? p.input : JSON.stringify(p.input)).slice(0, 120) : ''}`;
    }).filter(Boolean).join('\n');
  } catch { return ''; }
}
function queueActivity(session_id, text) {
  if (!text) return;
  _statusChain = _statusChain.then(async () => {
    try {
      const r = await fetch(CORE_BASE + '/v2/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.status) { dbmod.setActivity(session_id, j.status); io.emit('sessions-changed', {}); }
    } catch (_) {}
  }).catch(() => {});
}
function maybeActivity(e) {
  if (!e || !e.session_id || e.surface === 'system') return;
  if (e.event_type !== 'inbound' && e.event_type !== 'tool') return;
  const sid = e.session_id;
  const now = Date.now() / 1000;
  if (now - (_statusLast.get(sid) || 0) < STATUS_MIN_SEC) return;
  _statusLast.set(sid, now);
  queueActivity(sid, recentActivity(sid));
}

// --- self-update awareness: periodically check origin/main; surface + optionally auto-run --------
const selfUpdate = require('../../shared/update');
const UPDATE_CHECK_MS = Math.max(60000, Number(process.env.ASMLTR_UPDATE_CHECK_MS || 15 * 60 * 1000));
let _updateStatus = { available: false, behind: 0, checked_at: 0 };
async function checkUpdates() {
  try {
    const s = await selfUpdate.getUpdateStatus();
    const changed = s.available !== _updateStatus.available || s.behind !== _updateStatus.behind;
    _updateStatus = { ...s, auto: selfUpdate.isAutoUpdate() };
    if (changed) io.emit('update-status', _updateStatus);
    if (s.available && selfUpdate.isAutoUpdate()) {
      console.log(`[update] auto-update enabled and ${s.behind} commit(s) behind — triggering update session`);
      try { await fetch(CORE_BASE + '/v2/update/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'auto-update' }) }); } catch (_) {}
    }
  } catch (_) {}
}
setInterval(checkUpdates, UPDATE_CHECK_MS).unref();
setTimeout(checkUpdates, 8000); // initial check shortly after boot

// --- ingest ------------------------------------------------------------------
app.post('/ingest', requireToken, (req, res) => {
  const body = req.body;
  const list = Array.isArray(body) ? body : [body];
  let ok = 0;
  for (const e of list) {
    try {
      const stored = dbmod.ingestEvent(e);
      io.emit('event', stored);
      maybeTitle(stored);
      maybeActivity(stored);
      ok++;
    } catch (err) {
      return res.status(400).json({ error: err.message, ingested: ok });
    }
  }
  res.json({ ingested: ok });
});

// --- read API ----------------------------------------------------------------
app.get('/api/sessions', requireToken, (req, res) => {
  const rows = req.query.active === '1'
    ? dbmod.listLiveActive()
    : dbmod.q.sessions.all({ limit: Number(req.query.limit) || 200 });
  res.json({ sessions: rows, count: rows.length });
});
app.get('/api/update-status', requireToken, (req, res) => res.json(_updateStatus));
app.get('/api/events', requireToken, (req, res) => {
  const rows = dbmod.q.events.all({
    surface: req.query.surface || null,
    identity: req.query.identity || null,
    session: req.query.session || null,
    since: Number(req.query.since) || 0,
    limit: Math.min(Number(req.query.limit) || 100, 1000),
  });
  res.json({ events: rows, count: rows.length });
});
// where each session is ACTIVELY working — derived from recent tool events' file paths
// (resolved to the git repo root), NOT the static spawn dir. This is the honest map.
// Absolute paths under a real filesystem root — used to mine "where" out of shell commands. Anchored
// on known roots so it doesn't match flags/URLs/relative tokens. Catches `cd /x`, `git -C /x`, file args.
const _ABS_PATH_RE = /\/(?:root|home|opt|srv|var|tmp|mnt|data|workspace)\/[A-Za-z0-9._\-\/]+/g;
function _pathsFromTool(payload) {
  let p; try { p = JSON.parse(payload); } catch { return []; }
  let inp = p && p.input;
  if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch {} } // core stores input JSON-stringified
  const out = [];
  if (inp && typeof inp === 'object') {
    for (const k of ['file_path', 'notebook_path', 'path']) if (typeof inp[k] === 'string' && inp[k].startsWith('/')) out.push(inp[k]);
    // Bash/shell is the bulk of real work (git/npm/build/scripts) and carries no path arg — mine the
    // command string so a shell-heavy session isn't invisible to the map. cwd targets + file args.
    const cmd = typeof inp.command === 'string' ? inp.command : '';
    if (cmd) for (const m of cmd.matchAll(_ABS_PATH_RE)) out.push(m[0]);
  } else if (typeof inp === 'string' && inp) {
    for (const m of inp.matchAll(_ABS_PATH_RE)) out.push(m[0]);
  }
  return out;
}
const _repoCache = new Map();
function _repoRoot(dir) {
  if (_repoCache.has(dir)) return _repoCache.get(dir);
  let d = dir, root = dir;
  for (let i = 0; i < 15 && d && d !== '/'; i++) { try { if (fs.existsSync(path.join(d, '.git'))) { root = d; break; } } catch {} d = path.dirname(d); }
  _repoCache.set(dir, root);
  return root;
}
// Console manifest — the ONE declarative source of truth for control surfaces (settings + actions +
// screens), consumed by both the web dashboard and the terminal TUI. Add a setting/action there → both.
app.get('/api/manifest', requireToken, (req, res) => {
  try { res.json(require('../../shared/console-manifest')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Proprioception — the body-schema graph (parts + structural edges). The live vital sign.
const selfSchema = require('./self-schema');
app.get('/api/self/schema', requireToken, (req, res) => {
  try { res.json(selfSchema.buildSchema(dbmod, { since: Number(req.query.since) || undefined })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Proprioception 1b — the considered self-assessment: latest deduced goal/threads/flags/relations,
// plus a short history so the goal can be watched shifting. Written by the reflect() heartbeat below.
app.get('/api/self/assessment', requireToken, (req, res) => {
  try {
    const row = dbmod.q.latestAssessment.get();
    const latest = row ? {
      ts: row.ts, goal: row.goal || '', parts: row.parts, edges: row.edges,
      threads: JSON.parse(row.threads_json || '[]'), flags: JSON.parse(row.flags_json || '[]'),
      relations: JSON.parse(row.relations_json || '[]'),
    } : null;
    res.json({ latest, history: dbmod.q.assessmentHistory.all({ limit: 20 }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Session map — WHAT each currently-active agent is doing and WHERE. "What" is the live activity
// rollup (built from inbound + ALL tool events, incl. Bash) with title/task fallbacks. "Where" is the
// filesystem location mined from recent tool activity (file args + shell paths), falling back to the
// session's working_dir (terminal sessions) or channel location. Every session active within the
// window is listed — not just ones that happened to run a file-path tool — so a shell-heavy or
// channel session is no longer invisible. Grouped by repo → same repo, 2+ sessions = collision.
app.get('/api/map', requireToken, (req, res) => {
  const since = Number(req.query.since) || (Date.now() - 30 * 60000);
  const meta = {};
  for (const s of dbmod.q.activeSessions.all()) meta[s.session_id] = s;
  const acc = {}; // session_id -> { repos: {repo: hits}, dirs: {dir: hits} } from recent tool activity
  for (const r of dbmod.q.toolEventsSince.all({ since })) {
    if (!meta[r.session_id]) continue;
    for (const fp of _pathsFromTool(r.payload)) {
      // Group by the INNERMOST git repo of the full path (walk up to .git) — not the path's parent
      // dir, which would mis-group a `cd <repo>` under its container. Track containing dirs for display.
      const repo = _repoRoot(fp);
      const dir = fp.replace(/\/[^/]*$/, '') || '/';
      const a = (acc[r.session_id] = acc[r.session_id] || { repos: {}, dirs: {} });
      a.repos[repo] = (a.repos[repo] || 0) + 1;
      a.dirs[dir] = (a.dirs[dir] || 0) + 1;
    }
  }
  const sessions = [];
  for (const s of Object.values(meta)) {
    if (!(s.last_activity_unix > since)) continue;              // only agents active in the window
    const what = s.activity || s.title || s.task || null;       // what it's doing (live rollup first)
    const a = acc[s.session_id];
    let repo, dirList;
    if (a && Object.keys(a.repos).length) {                     // where: innermost repo by hit count
      repo = Object.entries(a.repos).sort((x, y) => y[1] - x[1])[0][0];
      dirList = Object.entries(a.dirs).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([dir, hits]) => ({ dir, hits }));
    } else if (s.working_dir) {                                 // fallback: terminal spawn cwd
      repo = _repoRoot(s.working_dir);
      dirList = [{ dir: s.working_dir, hits: 0 }];
    } else {                                                    // channel session, no fs activity yet
      repo = s.location || '(no filesystem activity)';
      dirList = [];
    }
    sessions.push({
      session_id: s.session_id, surface: s.surface, what, title: s.title || null, activity: s.activity || null,
      identity: s.identity || null, last_activity_unix: s.last_activity_unix, repo, dirs: dirList,
    });
  }
  sessions.sort((a, b) => b.last_activity_unix - a.last_activity_unix);
  res.json({ since, sessions });
});

// search session CONTENT — which sessions have events whose text matches a query.
// Returns distinct session_ids with a hit count + a snippet around the first match.
app.get('/api/search', requireToken, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ q, sessions: [] });
  const since = Number(req.query.since) || (Date.now() - 30 * 86400000); // last 30 days
  const rows = dbmod.q.searchEvents.all({ like: '%' + q + '%', since });
  const ql = q.toLowerCase();
  const bySession = {};
  for (const r of rows) {
    if (!bySession[r.session_id]) {
      let text = '';
      try { const p = JSON.parse(r.payload); text = String(p.text || p.output || (p.tool ? `${p.tool}: ${typeof p.input === 'object' ? JSON.stringify(p.input) : (p.input || '')}` : '') || r.payload); }
      catch { text = r.payload; }
      const i = text.toLowerCase().indexOf(ql);
      const snippet = ((i > 30 ? '…' : '') + text.slice(Math.max(0, i - 30), i + q.length + 60)).replace(/\s+/g, ' ').trim();
      bySession[r.session_id] = { session_id: r.session_id, hits: 0, snippet };
    }
    bySession[r.session_id].hits++;
  }
  res.json({ q, sessions: Object.values(bySession) });
});

// who touched a path recently — group matching tool events by session (collision radar)
app.get('/api/who', requireToken, (req, res) => {
  const p = String(req.query.path || '').trim();
  if (!p) return res.status(400).json({ error: 'need ?path=' });
  const since = Number(req.query.since) || (Date.now() - 6 * 3600000);
  const rows = dbmod.q.eventsLike.all({ like: '%' + p + '%', since });
  const bySession = {};
  for (const r of rows) {
    if (!bySession[r.session_id]) {
      let sample = '';
      try { const pl = JSON.parse(r.payload); sample = String(pl.tool ? `${pl.tool}: ${typeof pl.input === 'object' ? JSON.stringify(pl.input) : (pl.input || '')}` : (pl.output || '')).replace(/\s+/g, ' ').slice(0, 90); } catch {}
      bySession[r.session_id] = { session_id: r.session_id, surface: r.surface, last_ts: r.ts, hits: 0, sample };
    }
    bySession[r.session_id].hits++;
  }
  res.json({ path: p, since, sessions: Object.values(bySession).sort((a, b) => b.last_ts - a.last_ts) });
});
app.get('/api/usage', requireToken, (req, res) => {
  const since = Number(req.query.since) || Date.now() - 24 * 3600000;
  // `usage` = per-(surface,identity) token rollup; `aux` = per-(feature,provider,model) metered
  // side-surface spend (tts/stt/moderation) for the breakdown panel.
  res.json({ usage: dbmod.q.usage.all({ since }), aux: dbmod.q.usageAux.all({ since }) });
});
app.get('/api/system', requireToken, (req, res) => {
  const since = Number(req.query.since) || Date.now() - 3600000;
  res.json({ samples: dbmod.q.system.all({ since, limit: Math.min(Number(req.query.limit) || 500, 5000) }) });
});
app.get('/api/notifications', requireToken, (req, res) => {
  res.json({ notifications: dbmod.q.notifications.all({ limit: Number(req.query.limit) || 100 }) });
});

// --- brief: compact summary (replaces stdout-only morning brief data) --------
app.get('/api/brief', requireToken, (req, res) => {
  const active = dbmod.listLiveActive();
  const since = Math.floor((Date.now() - 24 * 3600000) / 3600000) * 3600000;
  const usage = dbmod.q.usage.all({ since });
  const bySurface = {};
  let tokens = 0;
  for (const u of usage) {
    bySurface[u.surface] = (bySurface[u.surface] || 0) + u.tokens_in + u.tokens_out;
    tokens += u.tokens_in + u.tokens_out;
  }
  res.json({
    ts: Date.now(),
    active_sessions: active.length,
    sessions: active.map((s) => ({ id: s.session_id, surface: s.surface, kind: s.kind, task: s.task, activity: s.activity, title: s.title, context: s.context })),
    tokens_24h: tokens,
    tokens_by_surface_24h: bySurface,
  });
});

// --- control plane (privileged) ----------------------------------------------
app.post('/api/control/kill', requireControl, (req, res) => {
  const r = control.kill(req.body.session_id, req.actor, req.body.hard === true);
  io.emit('control', { action: 'kill', target: req.body.session_id, ok: r.ok });
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/control/stop', requireControl, (req, res) => {
  const r = control.stop(req.body.session_id, req.actor);
  io.emit('control', { action: 'stop', target: req.body.session_id, ok: r.ok });
  res.status(r.ok ? 200 : 400).json(r);
});
// Forget/delete a session: remove it from tracking + purge its events (collector), AND clear the
// core's engine mapping so the next inbound on this key starts a FRESH session with new history.
// For channel sessions the collector session_id IS the core conversation_key.
app.post('/api/control/forget', requireControl, async (req, res) => {
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  const r = control.forget(session_id, req.actor);
  if (r.ok) {
    try { await fetch(CORE_BASE + '/v2/session/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_key: session_id, by: req.actor || 'dashboard' }) }); }
    catch (e) { console.warn('[forget] core notify failed:', e.message); } // local (non-channel) sessions have no core row — fine
    io.emit('sessions-changed', {});
  }
  io.emit('control', { action: 'forget', target: session_id, ok: r.ok });
  res.status(r.ok ? 200 : 400).json(r);
});
// inject into a tmux-backed `asmltr claude` session (steer / interrupt)
app.post('/api/control/send-keys', requireControl, (req, res) => {
  const { session_id, text, keys, enter } = req.body || {};
  const r = control.sendKeys(session_id, { text, keys, enter }, req.actor);
  io.emit('control', { action: 'send-keys', target: session_id, ok: r.ok });
  res.status(r.ok ? 200 : 400).json(r);
});
// manually set a session title (locks it against AI regeneration); empty title unlocks + reverts to AI
app.post('/api/control/session-title', requireControl, (req, res) => {
  const { session_id, title } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  const ok = dbmod.setTitleManual(session_id, title);
  if (ok) io.emit('sessions-changed', {});
  res.status(ok ? 200 : 404).json({ ok, locked: !!(title || '').trim(), error: ok ? undefined : 'unknown session (no row yet)' });
});
app.get('/api/control/diff', requireControl, (req, res) => {
  control.diff(req.query.session_id, (_e, r) => res.status(r.ok ? 200 : 400).json(r));
});
app.post('/api/control/restart-daemon', requireControl, (req, res) => {
  control.restartDaemon(req.body.target, req.actor, (_e, r) => {
    io.emit('control', { action: 'restart-daemon', target: req.body.target, ok: r.ok });
    res.status(r.ok ? 200 : 400).json(r);
  });
});
app.get('/api/control/audit', requireToken, (req, res) => res.json({ audit: control.recentAudit(Number(req.query.limit) || 50) }));

// --- proprioception 1b: the self-assessment heartbeat -----------------------
// The considered, slow voice. Every REFLECT_CHECK_MS it snapshots the body; it only spends an LLM
// turn when the body has MATERIALLY changed (digest hash differs) or REFLECT_MAX_MS has elapsed
// since the last one — "considered and less often", change-triggered. Needs ≥2 parts (a lone limb
// has no relations and no whole to deduce a goal from). Non-influential: it records, never steers.
const crypto = require('crypto');
const REFLECT_CHECK_MS = Math.max(60000, Number(process.env.ASMLTR_REFLECT_CHECK_MS || 5 * 60000));
const REFLECT_MAX_MS = Math.max(REFLECT_CHECK_MS, Number(process.env.ASMLTR_REFLECT_MAX_MS || 25 * 60000));
let _reflectBusy = false;
let _lastReflect = 0;
let _lastDigestHash = '';
async function reflect() {
  if (_reflectBusy) return;
  let schema, digest;
  try {
    schema = selfSchema.buildSchema(dbmod);
    if (schema.nodes.length < 2) return; // nothing to relate — leave the last assessment standing
    digest = selfSchema.buildDigest(schema);
  } catch (e) { console.warn('[reflect] digest failed:', e.message); return; }
  const hash = crypto.createHash('sha1').update(digest.text).digest('hex');
  const now = Date.now();
  const changed = hash !== _lastDigestHash;
  const stale = now - _lastReflect > REFLECT_MAX_MS;
  if (!changed && !stale) return;
  _reflectBusy = true;
  try {
    const r = await fetch(CORE_BASE + '/v2/self-assessment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest: digest.text }),
    });
    if (!r.ok) { console.warn('[reflect] core said', r.status); return; }
    const j = await r.json();
    const a = j && j.assessment;
    if (!a) return;
    // map the model's index-based relations back to session_id pairs so the GUI can overlay them
    const relations = (a.relations || []).map((rel) => {
      const from = digest.index[rel.a], to = digest.index[rel.b];
      if (!from || !to || from === to) return null;
      return { from, to, rel: rel.rel };
    }).filter(Boolean);
    dbmod.insertAssessment({
      ts: now, goal: a.goal || '', threads_json: JSON.stringify(a.threads || []),
      flags_json: JSON.stringify(a.flags || []), relations_json: JSON.stringify(relations),
      parts: schema.counts.parts, edges: schema.counts.edges, digest_hash: hash,
    });
    _lastDigestHash = hash; _lastReflect = now;
    io.emit('self-assessment-changed', { at: now });
    console.log(`[reflect] assessed body: ${schema.counts.parts} parts, goal="${(a.goal || '').slice(0, 60)}"`);
  } catch (e) { console.warn('[reflect] failed:', e.message); }
  finally { _reflectBusy = false; }
}

server.listen(PORT, HOST, () => {
  console.log(`asmltr-insights-collector on http://${HOST}:${PORT}`);
  if (!TOKEN) console.warn('[collector] WARNING: ASMLTR_INSIGHTS_TOKEN unset — auth disabled (dev mode)');

  reconcile.start(dbmod, RECONCILE_MS, (n) => io.emit('sessions-changed', { count: n }));
  sampler.start(dbmod, SAMPLE_MS, (s) => io.emit('system-sample', s));
  setTimeout(reflect, 20000).unref?.();               // first pass shortly after boot
  setInterval(reflect, REFLECT_CHECK_MS).unref?.();   // then change-triggered on each check
  if (ENABLE_TAILER) {
    tailer.start(dbmod, TAIL_MS, (n) => console.log(`[tailer] ingested ${n} events from proxy logs`));
    console.log('[collector] JSONL tailer active (proxy logs → events)');
  }
});

module.exports = { app, server };
