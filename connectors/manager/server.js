#!/usr/bin/env node
'use strict';
require('../../shared/loadenv'); // load <repo>/.env before anything reads config
const { settleDelivery } = require('../../shared/send-result'); // unify send/read HTTP status ↔ body `ok`
const attachStage = require('../../shared/attach-stage');
const { bearerEqual } = require('../../shared/bearer-equal');
const { connectorAuthHeaders } = require('../../shared/connector-http-auth');
/**
 * asmltr connector manager — registry + supervisor + management API (the plane
 * the dashboard "Integrations" page drives). Host/PM2, bind 127.0.0.1.
 *
 *   GET  /types                       available connector types (+ configSchema)
 *   GET  /instances                   instances + live status
 *   POST /instances                   create (validate vs type schema) [+ start if enabled]
 *   GET  /instances/:id               detail + recent logs
 *   PATCH /instances/:id              update config/name/enabled (restart if running)
 *   DELETE /instances/:id             stop + remove
 *   POST /instances/:id/{start,stop,restart}
 *   GET  /instances/:id/logs
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const registry = require('./registry');
const { makeSupervisor } = require('./supervisor');

const PORT = Number(process.env.ASMLTR_MANAGER_PORT || 3024);
const HOST = '127.0.0.1';
const TOKEN = process.env.ASMLTR_MANAGER_TOKEN || '';

const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ASMLTR_CORE_URL: process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle',
  ASMLTR_COLLECTOR_URL: process.env.ASMLTR_COLLECTOR_URL || 'http://127.0.0.1:3017/ingest',
  ASMLTR_INSIGHTS_TOKEN: process.env.ASMLTR_INSIGHTS_TOKEN || '',
  ASMLTR_MANAGER_TOKEN: process.env.ASMLTR_MANAGER_TOKEN || '',
};
const supervisor = makeSupervisor(childEnv);

// --- discover type plugins ---------------------------------------------------
const TYPES_DIR = path.join(__dirname, '..', 'types');
function loadTypes() {
  const out = {};
  for (const t of fs.readdirSync(TYPES_DIR)) {
    const dir = path.join(TYPES_DIR, t);
    let st;
    try { st = fs.statSync(dir); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    // Node connector plugin = index.js + meta. Hook-only dirs (claude-code/hook.py) are
    // not plugins — skip silent (was: "type 'claude-code' failed to load" every boot).
    // Interactive CLIs are not types/ folders: `asmltr grok` → grok, `asmltr gemini` →
    // gemini, `asmltr codex` → codex (cli/asmltr-engine.js). Native Stop/SessionStart
    // hooks for Gemini/Codex would live next to this as their own hook script, not here.
    if (!fs.existsSync(path.join(dir, 'index.js'))) continue;
    try {
      const mod = require(dir);
      if (mod && mod.meta) out[mod.meta.type] = mod.meta;
    } catch (e) { console.error(`[manager] type '${t}' failed to load:`, e.message); }
  }
  return out;
}
const TYPES = loadTypes();

// Resolve an instance's outbound HTTP port the same way the connector itself does.
//
// Every connector binds `cfg.http_port || <default>` (discord 3016, telegram 3008), so the port is
// ALWAYS listening — even when the instance config omits the field. The manager, however, used to
// read `config.http_port` with no fallback, so any instance created without that key explicitly
// persisted (the schema `default` is only materialized by the GUI form, not by the API or a
// hand-seeded row) failed EVERY outbound send, file attachment, and channel-list call with
// "instance 'x' has no http_port" — while the connector sat there listening on exactly that port.
//
// Falling back to the type's configSchema default makes the manager agree with the connector.
function instancePort(inst) {
  const fromConfig = inst && inst.config && inst.config.http_port;
  if (fromConfig) return fromConfig;
  const schema = TYPES[inst && inst.type] && TYPES[inst.type].configSchema;
  const props = (schema && schema.properties) || {};
  return (props.http_port && props.http_port.default) || null;
}

function validateConfig(typeMeta, config) {
  const req = (typeMeta.configSchema && typeMeta.configSchema.required) || [];
  const missing = req.filter((k) => config[k] === undefined || config[k] === null || config[k] === '');
  return missing.length ? `missing required config: ${missing.join(', ')}` : null;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
function requireToken(req, res, next) {
  if (bearerEqual(req.get('authorization'), TOKEN)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'asmltr-connector-manager', types: Object.keys(TYPES) }));
// Build identity — the code sha this process is actually running + when it started. An updater
// checks this (not just /health, which is 200 even on stale code) to confirm the restart landed.
const BUILD_SHA = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (_) { return 'unknown'; } })();
const STARTED_AT = new Date().toISOString();
app.get('/version', (req, res) => res.json({ service: 'asmltr-connector-manager', ...require('../../shared/version').info(), sha: BUILD_SHA, started_at: STARTED_AT, pid: process.pid }));
app.get('/types', requireToken, (req, res) => res.json({ types: Object.values(TYPES) }));

app.get('/instances', requireToken, (req, res) => {
  // Surface each type's capabilities so the dashboard doesn't hardcode them: `mutable`
  // declares the connector supports per-unit monitoring on/off (e.g. Discord per channel).
  res.json({ instances: registry.list().map((i) => ({ ...i, runtime: supervisor.status(i.id), mutable: (TYPES[i.type] && TYPES[i.type].mutable) || null })) });
});
app.get('/instances/:id', requireToken, (req, res) => {
  const i = registry.get(req.params.id);
  if (!i) return res.status(404).json({ error: 'not found' });
  res.json({ ...i, runtime: supervisor.status(i.id), logs: supervisor.logs(i.id) });
});
app.get('/instances/:id/logs', requireToken, (req, res) => res.json({ logs: supervisor.logs(req.params.id) }));

app.post('/instances', requireToken, (req, res) => {
  const { type, name, config = {}, enabled = false } = req.body || {};
  if (!TYPES[type]) return res.status(400).json({ error: `unknown type '${type}'` });
  const bad = validateConfig(TYPES[type], config);
  if (bad) return res.status(400).json({ error: bad });
  const inst = registry.create({ type, name, config, enabled });
  if (inst.enabled) supervisor.spawnInstance(inst);
  res.json(inst);
});

app.patch('/instances/:id', requireToken, (req, res) => {
  const cur = registry.get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (req.body.config) {
    const bad = validateConfig(TYPES[cur.type], req.body.config);
    if (bad) return res.status(400).json({ error: bad });
  }
  const next = registry.update(req.params.id, req.body);
  // apply runtime change
  if (next.enabled) supervisor.restartInstance(next);
  else supervisor.stopInstance(next.id);
  res.json(next);
});

app.post('/instances/:id/start', requireToken, (req, res) => {
  const i = registry.get(req.params.id); if (!i) return res.status(404).json({ error: 'not found' });
  registry.update(i.id, { enabled: true }); supervisor.spawnInstance({ ...i, enabled: true }); res.json({ ok: true });
});
app.post('/instances/:id/stop', requireToken, (req, res) => {
  const i = registry.get(req.params.id); if (!i) return res.status(404).json({ error: 'not found' });
  registry.update(i.id, { enabled: false }); supervisor.stopInstance(i.id); res.json({ ok: true });
});
app.post('/instances/:id/restart', requireToken, (req, res) => {
  const i = registry.get(req.params.id); if (!i) return res.status(404).json({ error: 'not found' });
  supervisor.restartInstance(i); res.json({ ok: true });
});
// --- per-channel enable/disable: proxy to the connector's own /channels endpoint (no restart).
// Lets the TUI/GUI see every channel a connector can reach and toggle whether it relays to core.
// Proxy a control request to a running connector instance's HTTP surface (its declared `endpoints`,
// e.g. Discord's `channels` + `servers`). Generic so a new connector endpoint needs no manager change.
async function proxyEndpoint(id, endpoint, method, body) {
  const inst = registry.get(id);
  if (!inst) return { status: 404, json: { ok: false, error: 'not found' } };
  const port = instancePort(inst);
  if (!port) return { status: 400, json: { ok: false, error: `instance '${inst.name}' has no http_port (and type '${inst.type}' declares no default)` } };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/${endpoint}`, {
      method, headers: connectorAuthHeaders(TOKEN), body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, json: { instance_id: id, type: inst.type, name: inst.name, ...j } };
  } catch (e) { return { status: 502, json: { ok: false, error: `connector unreachable: ${e.message}` } }; }
}
app.get('/instances/:id/channels', requireToken, async (req, res) => { const r = await proxyEndpoint(req.params.id, 'channels', 'GET'); res.status(r.status).json(r.json); });
app.post('/instances/:id/channels', requireToken, async (req, res) => { const r = await proxyEndpoint(req.params.id, 'channels', 'POST', req.body || {}); res.status(r.status).json(r.json); });
// Discord server membership: GET → invite URL + guilds the bot is in; POST { leave } → leave a guild.
app.get('/instances/:id/servers', requireToken, async (req, res) => { const r = await proxyEndpoint(req.params.id, 'servers', 'GET'); res.status(r.status).json(r.json); });
app.post('/instances/:id/servers', requireToken, async (req, res) => { const r = await proxyEndpoint(req.params.id, 'servers', 'POST', req.body || {}); res.status(r.status).json(r.json); });

app.delete('/instances/:id', requireToken, (req, res) => {
  supervisor.stopInstance(req.params.id);
  registry.remove(req.params.id);
  res.json({ ok: true });
});

// Attachment-kind taxonomy + the canonical "can this connector send a file out?" flag. A type
// supports outbound attachments iff its meta.outbound.kinds lists any attachment kind. Used to
// gate `--file` sends and surfaced on /send/targets so callers know before they try.
const ATTACH_KINDS = ['file', 'photo', 'document'];
const supportsAttachments = (meta) => !!(meta && meta.outbound && (meta.outbound.kinds || []).some((k) => ATTACH_KINDS.includes(k)));

// --- unified outbound: route a message OUT through a connector instance --------
// POST /send { channel|instance_id, target, kind?, text?, path?, caption?, subject?, cc?, ref?, title?, require_headphones?, force? }
async function deliver({ channel, instance_id, target, kind = 'text', text, path: filePath, caption, subject, cc, ref, title, require_headphones, source_guild, on_behalf_of, reply_to, source_channel, query, force, drop, reply_all, new_thread }) {
  const inst = instance_id ? registry.get(instance_id)
    : channel ? (registry.list().find((i) => i.type === channel && i.enabled) || registry.list().find((i) => i.type === channel))
    : null;
  if (!inst) return { ok: false, status: 404, error: 'no connector instance for that channel/instance_id' };
  const meta = TYPES[inst.type];
  if (!meta || !meta.outbound) return { ok: false, status: 400, error: `type '${inst.type}' has no outbound capability` };
  // Outbound file-attachment capability: a connector must DECLARE it supports an attachment kind
  // (file/photo/document in meta.outbound.kinds) before we route a file to it — a clean, honest
  // "this channel can't attach files" instead of a confusing failure inside the connector.
  if (ATTACH_KINDS.includes(kind) && !supportsAttachments(meta)) {
    return { ok: false, status: 400, error: `type '${inst.type}' does not support outbound file attachments` };
  }
  if (filePath) {
    const stage = attachStage;
    if (typeof stage.outboundFileAllowed === 'function' && !stage.outboundFileAllowed(filePath)) {
      return { ok: false, status: 403, error: 'path not allowed (attach-stage, gen-ref, uploads, or silo)' };
    }
  }
  const port = instancePort(inst);
  if (!port) return { ok: false, status: 400, error: `instance '${inst.name}' has no http_port (and type '${inst.type}' declares no default)` };
  // Reach the connector on the interface it actually bound. Most bind 127.0.0.1, but some (e.g. the
  // android gateway) bind a bridge IP so an off-host client can reach them — honor that, or 127.0.0.1
  // can't reach a connector bound to only that interface. 0.0.0.0/:: → localhost is fine.
  const bindHost = inst.config && inst.config.bind_host;
  const host = (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') ? bindHost : '127.0.0.1';
  try {
    const r = await fetch(`http://${host}:${port}/out`, { method: 'POST', headers: connectorAuthHeaders(TOKEN), body: JSON.stringify({ kind, target, text, path: filePath, caption, subject, cc, ref, title, require_headphones, source_guild, on_behalf_of, reply_to, source_channel, query, force, drop, reply_all, new_thread }) });
    const j = await r.json().catch(() => ({}));
    // Status follows the connector's own `ok` (authoritative — a real send), not the raw fetch status,
    // so a delivered message can't come back as an HTTP failure. See shared/send-result.js.
    const settled = settleDelivery(r.ok, j, { via: `${inst.type}:${inst.name}` });
    return settled;
  } catch (e) { return { ok: false, status: 502, error: `connector unreachable: ${e.message}` }; }
}
app.post('/send', requireToken, async (req, res) => { const r = await deliver(req.body || {}); res.status(r.status).json(r); });

// --- unified read: browse a READABLE connector's source (e.g. an email mailbox) ---------
// POST /read { channel|instance_id, op, ...args } → proxied to the connector's /read. Symmetric
// with /send→/out. A connector must declare meta.readable (e.g. email: list|read|search).
const isReadable = (meta) => !!(meta && meta.readable);
async function readSource(body) {
  const { channel, instance_id } = body || {};
  const inst = instance_id ? registry.get(instance_id)
    : channel ? (registry.list().find((i) => i.type === channel && i.enabled) || registry.list().find((i) => i.type === channel))
    : null;
  if (!inst) return { ok: false, status: 404, error: 'no connector instance for that channel/instance_id' };
  const meta = TYPES[inst.type];
  if (!isReadable(meta)) return { ok: false, status: 400, error: `type '${inst.type}' is not readable (no browse capability)` };
  const port = instancePort(inst);
  if (!port) return { ok: false, status: 400, error: `instance '${inst.name}' has no http_port (and type '${inst.type}' declares no default)` };
  try {
    const { channel: _c, instance_id: _i, ...args } = body;
    const r = await fetch(`http://127.0.0.1:${port}/read`, { method: 'POST', headers: connectorAuthHeaders(TOKEN), body: JSON.stringify(args) });
    const j = await r.json().catch(() => ({}));
    return settleDelivery(r.ok, j, { via: `${inst.type}:${inst.name}` });
  } catch (e) { return { ok: false, status: 502, error: `connector unreachable: ${e.message}` }; }
}
app.post('/read', requireToken, async (req, res) => { const r = await readSource(req.body || {}); res.status(r.status).json(r); });

// --- deferred announcements: queued now, delivered AFTER the next (re)start once the target
// connector reconnects. Lets an agent that just triggered its OWN update (over a channel)
// confirm completion in-channel, even though the restart killed the turn that issued it.
// POST /announce { channel|instance_id, target, text }
const ANNOUNCE_FILE = process.env.ASMLTR_ANNOUNCE_FILE || path.join(__dirname, 'data', 'announcements.json');
app.post('/announce', requireToken, (req, res) => {
  const { channel, instance_id, target, text } = req.body || {};
  if (!text || (!channel && !instance_id)) return res.status(400).json({ error: 'need text + channel or instance_id' });
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf8')); } catch (_) {}
  if (!Array.isArray(queue)) queue = [];
  queue.push({ channel, instance_id, target, kind: 'text', text });
  try { fs.mkdirSync(path.dirname(ANNOUNCE_FILE), { recursive: true }); fs.writeFileSync(ANNOUNCE_FILE, JSON.stringify(queue)); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, queued: queue.length });
});
async function drainAnnouncements() {
  let queue;
  try { queue = JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf8')); } catch (_) { return; }
  if (!Array.isArray(queue) || !queue.length) return;
  try { fs.writeFileSync(ANNOUNCE_FILE, '[]'); } catch (_) {} // clear first so a crash-loop can't re-spam
  for (const a of queue) {
    let sent = false;
    for (let i = 0; i < 6 && !sent; i++) { const r = await deliver(a).catch(() => ({ ok: false })); sent = !!r.ok; if (!sent) await new Promise((res) => setTimeout(res, 3000)); }
    console.log(`[manager] announcement ${sent ? 'delivered' : 'FAILED'}: ${String(a.text || '').slice(0, 60)}`);
  }
}
// list outbound-capable destinations (for the skill / dashboard)
app.get('/send/targets', requireToken, (req, res) => {
  const dests = registry.list().filter((i) => TYPES[i.type] && TYPES[i.type].outbound)
    .map((i) => ({ instance_id: i.id, channel: i.type, name: i.name, enabled: i.enabled, outbound: TYPES[i.type].outbound, attachments: supportsAttachments(TYPES[i.type]), readable: isReadable(TYPES[i.type]) }));
  res.json({ targets: dests });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`asmltr-connector-manager on http://${HOST}:${PORT} — types: ${Object.keys(TYPES).join(', ')}`);
  if (!TOKEN) console.warn('[manager] ASMLTR_MANAGER_TOKEN unset — auth disabled (dev)');
  // boot: supervise enabled instances
  for (const inst of registry.list()) {
    if (inst.enabled) { console.log(`[manager] starting enabled instance ${inst.type}:${inst.name}`); supervisor.spawnInstance(inst); }
  }
  // deliver any announcement queued before a restart, once the connectors have reconnected
  setTimeout(drainAnnouncements, Number(process.env.ASMLTR_ANNOUNCE_DELAY_MS || 12000));
});

// Graceful shutdown: reap every connector child, THEN exit — so `pm2 restart` cleanly cycles
// the whole tree onto new code with no orphans and no external `pkill` needed. Handle SIGINT too:
// pm2's default kill signal is SIGINT, so a SIGTERM-only handler never ran on `pm2 restart` (the
// original reason a manual pkill was bolted onto the update flow). The safety-net timeout stays
// under the pm2 kill_timeout (5000ms) so we always exit cleanly before pm2 escalates to SIGKILL.
let _shuttingDown = false;
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[manager] ${signal} — reaping connector children before exit…`);
  try { server.close(); } catch (_) {}
  supervisor.stopAll(() => { console.log('[manager] all children stopped — exiting'); process.exit(0); });
  setTimeout(() => { console.warn('[manager] shutdown grace elapsed — exiting'); process.exit(0); }, 4500).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { app };
