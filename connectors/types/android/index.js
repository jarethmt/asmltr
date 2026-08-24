'use strict';
/**
 * asmltr connector type: android — a device gateway for the native mobile assistant.
 *
 * Unlike telegram/discord (server-side adapters that reach a platform's API), the "platform" here is
 * OUR OWN app on a phone. Each installed device holds a long-lived SSE stream to this connector and
 * POSTs turns to it. That makes the phone a FIRST-CLASS channel: its turns run through the core like
 * any other (trust, moderation, sessions), so the interoception agent sees the device session, the web
 * GUI can claim/take it over, and `asmltr send android <device> …` / announcements / steer push straight
 * to the phone over its SSE. Voice I/O (STT in, TTS out) stays on the device using the core's `/v2`
 * speech endpoints — this connector is the conversation channel, audio is edge-local.
 *
 * Transport (no new deps — matches the core's SSE style):
 *   • device→server:  POST /gw/turn   { token, device, name?, text }  → streamed reply over the SSE
 *   • server→device:  GET  /gw/stream?token=&device=&name=            → SSE: ready|delta|done|inject|error
 *   • manager→device: POST /out       { target:<device>, text }        → an `inject` frame (routing/steer)
 *
 * Auth: a device presents a token from the gitignored keys file (token → trust identity), exactly like
 * the openai connector. conversation_key = `android:<instanceId>:device:<deviceId>` (stable per install
 * → the core session resumes, and the card is takeover-able).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const silo = require('../../../shared/silo');          // Self silo (allowed base for outbound files)
const uploads = require('../../../shared/uploads');    // shared upload area (allowed base for outbound files)
const { guessMime } = require('../../../shared/mimeguess'); // MIME for the media frame + /gw/file Content-Type
// Speech is proxied through this connector so the phone has ONE token-authed surface (no separate
// core-auth for /v2/transcribe + /v2/tts). Same shared modules the core /v2 speech endpoints use.
const stt = require('../../../shared/speech/stt');
const tts = require('../../../shared/speech/tts');
const { auxUsage, estimateAudioSeconds } = require('../../../shared/usage'); // priced tts/stt cost events
const identity = require('../../../shared/identity'); // for /gw/theme (signature palette + agent name)
const { extractDeviceToken, deviceAuthAllowed, resolveTurnKey } = require('./device-auth');

const meta = {
  type: 'android',
  displayName: 'Android assistant',
  // Push channel: the manager /send router + announcements/steer reach a device via POST /out.
  // 'file' → a `media` SSE frame the app renders inline (image) or as a download (served by /gw/file).
  outbound: { kinds: ['text', 'file'], target: { required: true, label: 'Device id' } },
  configSchema: {
    type: 'object',
    properties: {
      http_port: { type: 'integer', title: 'HTTP port (device gateway + /out)', default: 3027 },
      bind_host: { type: 'string', title: 'Bind address', default: '127.0.0.1' },
      keys_file: { type: 'string', title: 'Device tokens file (gitignored: token → trust identity)', default: '' },
      require_token: { type: 'boolean', title: 'Require a device token', default: true },
    },
  },
};

function loadKeys(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.keys) ? j.keys : []; } catch { return []; }
}

async function start(ctx) {
  const cfg = ctx.config || {};
  const PORT = cfg.http_port || 3027;
  const BIND = cfg.bind_host || '127.0.0.1';
  const requireToken = cfg.require_token !== false;
  const keysFile = cfg.keys_file || path.join(__dirname, 'keys.json');

  // deviceId → { res, name, identity, since }. One live SSE per device (a reconnect replaces it).
  const devices = new Map();
  // Separate PERSISTENT control link, held by the phone's native foreground service (not the WebView).
  // This is what lets any agent session actuate the phone even when the overlay/app is closed — the chat
  // stream (devices) is ephemeral UI; this one stays connected in the background.
  const controlDevices = new Map(); // deviceId → { res, name, since }
  function pushControl(device, obj) {
    const d = controlDevices.get(device);
    if (!d) return false;
    try { d.res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch (_) { return false; }
  }

  function keyEntry(token) { return loadKeys(keysFile).find((k) => k.key === token) || null; }
  // Resolve a device's caller identity from its token. Returns null when a token is required but invalid.
  function auth(token) {
    const d = deviceAuthAllowed({ requireToken, token, lookup: keyEntry });
    return d.ok ? { identity: d.identity, username: d.username } : null;
  }
  const convKey = (device) => `android:${ctx.instanceId}:device:${device}`;
  function pushSSE(device, obj) {
    const d = devices.get(device);
    if (!d) return false;
    try { d.res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch (_) { return false; }
  }

  // --- outbound file attachments: opaque id → real file, served by /gw/file -------------------------
  // Outbound files (kind:'file') can't be inlined into an SSE frame, so we register the file under an
  // opaque id and stream it from a token-gated /gw/file. The id map is the PRIMARY guard: a device can
  // only fetch files a trusted send explicitly registered (no path param → no traversal). We ALSO clamp
  // to an allowlist of base dirs (defense-in-depth) and persist the map to disk so ids survive a restart
  // (history replay can re-serve them). Override the allowlist with ASMLTR_ANDROID_FILE_BASES (':'-sep).
  const MEDIA_DB = process.env.ASMLTR_ANDROID_MEDIA_DB || path.join(os.homedir(), '.asmltr', 'android-media.jsonl');
  const mediaMap = new Map(); // id → { path, mime, name }
  (function loadMedia() {
    try { for (const line of fs.readFileSync(MEDIA_DB, 'utf8').split('\n')) {
      if (!line.trim()) continue; const r = JSON.parse(line);
      if (r && r.id && r.path) mediaMap.set(r.id, { path: r.path, mime: r.mime, name: r.name });
    } } catch (_) {}
  })();
  function allowedBases() {
    if (process.env.ASMLTR_ANDROID_FILE_BASES) {
      return process.env.ASMLTR_ANDROID_FILE_BASES.split(':').filter(Boolean)
        .map((p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } });
    }
    const bases = [];
    try { bases.push(fs.realpathSync(silo.selfSub('artifacts'))); } catch (_) {} // finished agent outputs
    try { bases.push(fs.realpathSync(uploads.baseDir())); } catch (_) {}         // shared inbound files
    return bases;
  }
  function underAllowed(real) {
    return allowedBases().some((b) => real === b || real.startsWith(b + path.sep));
  }
  function registerMedia(real, mime, name) {
    const id = crypto.randomBytes(9).toString('base64url');
    mediaMap.set(id, { path: real, mime, name });
    try { fs.mkdirSync(path.dirname(MEDIA_DB), { recursive: true }); fs.appendFileSync(MEDIA_DB, JSON.stringify({ id, path: real, mime, name, at: Date.now() }) + '\n'); } catch (_) {}
    return id;
  }
  // Connector-relative URL (leading slash) the app resolves against its configured gateway base — exactly
  // like it builds `${cfg.baseUrl}/gw/stream`. The device token rides as a query param so the URL is
  // self-authorizing (drop straight into <img src>, no headers). Token omitted → replay rebuilds it per-request.
  function mediaUrl(id, token) {
    const q = new URLSearchParams({ id });
    if (token) q.set('token', token);
    return `/gw/file?${q.toString()}`;
  }

  const app = express();
  app.use(express.json({ limit: '16mb' })); // room for base64 audio on /gw/transcribe
  // The mobile WebView is a different origin (capacitor://localhost). These endpoints are token-authed,
  // so a permissive CORS policy is fine and required for fetch()/EventSource from the app.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', type: 'android', instance: ctx.instanceId, devices: devices.size }));

  // --- server→device push channel (the phone holds this open) ---------------------------------------
  app.get('/gw/stream', (req, res) => {
    const who = auth(req.query.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(req.query.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    const name = String(req.query.name || who.username || 'android');

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    // Replace any stale stream for this device (reconnect).
    const prev = devices.get(device); if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
    // Keep the device's own token so an outbound `media` frame can hand it a self-authorizing /gw/file URL.
    devices.set(device, { res, name, identity: who.identity, since: Date.now(), token: req.query.token });
    res.write(`data: ${JSON.stringify({ type: 'ready', device, conversation_key: convKey(device) })}\n\n`);
    ctx.emit({ event_type: 'control', session_id: convKey(device), identity: who.identity, payload: { action: 'device-connected', device } });
    try { ctx.heartbeat(); } catch (_) {}

    // keep-alive comments so proxies don't drop the idle stream
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 25000); ka.unref && ka.unref();
    req.on('close', () => {
      clearInterval(ka);
      if (devices.get(device) && devices.get(device).res === res) devices.delete(device);
      ctx.emit({ event_type: 'control', session_id: convKey(device), identity: who.identity, payload: { action: 'device-disconnected', device } });
    });
  });

  // --- session switcher: list/attach ANY asmltr session from the overlay (like the web GUI) ----------
  // The connector reads the collector (localhost, open) for the reconciled session list + per-session
  // history, so the phone can browse every channel's sessions, load one, and direct its next turn at it.
  const INSIGHTS_BASE = (process.env.ASMLTR_INSIGHTS_BASE || 'http://127.0.0.1:3017').replace(/\/+$/, '');
  const INSIGHTS_TOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';
  async function collector(p) {
    const r = await fetch(INSIGHTS_BASE + p, { headers: INSIGHTS_TOKEN ? { Authorization: `Bearer ${INSIGHTS_TOKEN}` } : {} });
    if (!r.ok) throw new Error(`collector ${r.status}`);
    return r.json();
  }
  app.get('/gw/sessions', async (req, res) => {
    if (requireToken && !auth(req.query.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const j = await collector('/api/sessions?active=1');
      // last_activity_unix etc. are stored in MILLISECONDS despite the name → normalize to seconds so
      // the app's "x ago" is correct (else everything reads "just now").
      const secs = (n) => { n = Number(n) || 0; return n > 1e11 ? Math.round(n / 1000) : n; };
      const rows = (j.sessions || []).map((s) => ({
        key: s.session_id, surface: s.surface || 'core',
        title: (s.title || s.task || '').trim(), task: (s.task || '').trim(),
        status: s.status || '', identity: s.identity || '', tools: s.tool_count || 0,
        updated: secs(s.last_activity_unix || s.updated_unix || s.started_unix || 0),
      })).filter((r) => r.key).sort((a, b) => b.updated - a.updated);
      res.json({ ok: true, sessions: rows });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });
  app.get('/gw/history', async (req, res) => {
    if (requireToken && !auth(req.query.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });
    try {
      const j = await collector(`/api/events?session=${encodeURIComponent(key)}&limit=${Math.min(parseInt(req.query.limit, 10) || 300, 1000)}`);
      const items = [];
      for (const e of (j.events || [])) {
        let p = {}; try { p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {}); } catch (_) {}
        switch (e.event_type) {
          case 'inbound': items.push({ kind: 'user', text: p.text || '', ts: e.ts }); break;
          case 'outbound':
            // An outbound with a `media` payload is an attachment — replay it as a `media` item, rebuilding
            // the /gw/file URL with THIS requester's token (tokens are never persisted in the event log).
            if (p.media && p.media.id) {
              const q = new URLSearchParams({ id: p.media.id });
              if (req.query.token) q.set('token', String(req.query.token));
              items.push({ kind: 'media', url: `/gw/file?${q.toString()}`, mime: p.media.mime, name: p.media.name, caption: p.media.caption || p.text || '', ts: e.ts });
            } else {
              items.push({ kind: 'assistant', text: p.text || '', ts: e.ts });
            }
            break;
          case 'thinking': items.push({ kind: 'thinking', text: p.text || '', ts: e.ts }); break;
          case 'tool': items.push({ kind: 'tool', name: p.tool || p.name || 'tool', input: p.input, ts: e.ts }); break;
          case 'tool_result': items.push({ kind: 'tool_result', output: p.output || '', is_error: !!p.is_error, ts: e.ts }); break;
          case 'subagent': items.push({ kind: 'subagent', id: p.id, name: p.name, status: p.status, summary: p.summary || '', ts: e.ts }); break;
          default: break; // session-start/end/control → skip
        }
      }
      items.sort((a, b) => (a.ts || 0) - (b.ts || 0)); // chronological for display
      res.json({ ok: true, key, items });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  // Start a fresh conversation for this device (clear context): forget the core session so the next turn
  // re-injects a clean system prompt (identity/trust/history reset). Surfaced by the overlay's "New session".
  const CORE_FORGET = (process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle$/, '/v2/session/forget');
  app.post('/gw/forget', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(b.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    const key = convKey(device);
    try {
      const r = await fetch(CORE_FORGET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_key: key, by: 'android-device' }) });
      const j = await r.json().catch(() => ({}));
      res.json({ ok: true, conversation_key: key, existed: !!j.existed });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- persistent control link: the native foreground service holds this open 24/7 -------------------
  // Same auth as the chat stream, but a SEPARATE registry so it doesn't get replaced when the overlay's
  // chat stream (re)connects. Device_rpc frames are pushed here so phone control works with no UI open.
  app.get('/gw/control', (req, res) => {
    const who = auth(req.query.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(req.query.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    const name = String(req.query.name || who.username || 'android');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const prev = controlDevices.get(device); if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
    controlDevices.set(device, { res, name, since: Date.now() });
    res.write(`data: ${JSON.stringify({ type: 'ready', device, control: true })}\n\n`);
    ctx.emit({ event_type: 'control', session_id: convKey(device), identity: who.identity, payload: { action: 'control-connected', device } });
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 25000); ka.unref && ka.unref();
    req.on('close', () => {
      clearInterval(ka);
      if (controlDevices.get(device) && controlDevices.get(device).res === res) controlDevices.delete(device);
      ctx.emit({ event_type: 'control', session_id: convKey(device), identity: who.identity, payload: { action: 'control-disconnected', device } });
    });
  });

  // --- device→server: submit a turn, stream the reply back over the device's SSE --------------------
  app.post('/gw/turn', async (req, res) => {
    const b = req.body || {};
    const who = auth(b.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(b.device || '').trim();
    const text = typeof b.text === 'string' ? b.text : '';
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });
    const name = String(b.name || who.username || 'android');
    // Fail closed: target_key may only be this device's convKey or another key owned by this identity.
    const ownKey = convKey(device);
    const identityOwnKeys = new Set([ownKey]);
    for (const [id, d] of devices) {
      if (d.identity && who && d.identity === who.identity) identityOwnKeys.add(convKey(id));
    }
    const targetKey = String(b.target_key || '').trim();
    const decided = resolveTurnKey({ targetKey, ownConvKey: ownKey, identityOwnKeys });
    if (!decided.ok) return res.status(decided.status).json({ ok: false, error: decided.error });
    const targetSurface = String(b.target_surface || '').trim();
    const convo = decided.conversationKey;
    const channel = targetKey ? (targetSurface || (convo.includes(':') ? convo.split(':')[0] : 'core')) : 'android';

    // Surface MUST be 'assistant-native' — 'android' isn't a valid event surface, so it'd be dropped and
    // never persist to history (why user/assistant/thinking text didn't replay on overlay reopen).
    ctx.emit({ surface: 'assistant-native', event_type: 'inbound', session_id: convo, identity: who.identity, payload: { text: text.slice(0, 100000) } }); // keep full — this is the conversation record the app replays as history
    const envelope = {
      channel,
      conversation_key: convo,
      message_id: String(Date.now()),
      sender: { raw_id: who.identity, raw_username: name },
      content: { text },
      delivery: 'sync',
      public: false, // 1:1 authed device; redaction still applies unless the identity is full-trust
      // `target` mirrors `device` so the core's ATTACHMENTS system-prompt hint renders the exact command
      // (`asmltr send android <device> --file …`).
      channel_context: { device, target: device },
      context: { scope_name: targetKey ? `Session ${convo}` : 'Android assistant' },
      // This channel CAN receive outbound files (rendered as a `media` frame + served by /gw/file), so the
      // core tells the agent it may attach here instead of claiming it can't.
      capabilities: { max_message_chars: 100000, supports_markdown: false, streaming: true, supports_attachments_out: true },
    };

    // Ack immediately (the reply streams over the SSE, not this POST response).
    res.json({ ok: true, conversation_key: convo, streaming: devices.has(device) });
    let replyText = ''; // accumulate streamed reply so it persists to history (live pushSSE alone isn't retained)
    try {
      await ctx.core.handleStream(envelope, {
        // `key: convo` tags every frame with its conversation so the app can demultiplex concurrent
        // turns into the right session TAB (one device SSE carries all of a device's live sessions).
        onDelta: (t) => { replyText += t; pushSSE(device, { type: 'delta', key: convo, text: t }); },            // streamed reply text
        onThinking: (t) => { ctx.emit({ surface: 'assistant-native', event_type: 'thinking', session_id: convo, identity: 'assistant', payload: { text: t } }); pushSSE(device, { type: 'thinking', key: convo, text: t }); }, // reasoning steps
        onToolCall: (t) => { ctx.emit({ surface: 'assistant-native', event_type: 'tool', session_id: convo, identity: 'assistant', payload: { tool: t.name, input: t.input } }); pushSSE(device, { type: 'tool', key: convo, name: t.name, input: t.input }); }, // tool call + args
        onToolResult: (r) => { ctx.emit({ surface: 'assistant-native', event_type: 'tool_result', session_id: convo, identity: 'assistant', payload: { output: r.output, is_error: r.is_error } }); pushSSE(device, { type: 'tool_result', key: convo, output: r.output, is_error: r.is_error }); }, // its output
        // Sub-agent (Task) lifecycle → SSE `subagent` frame the app renders in a live panel (Claude only;
        // Codex/Gemini never emit these so the app simply never shows the panel).
        onSubagent: (s) => { ctx.emit({ surface: 'assistant-native', event_type: 'subagent', session_id: convo, identity: 'assistant', payload: { id: s.id, name: s.name, status: s.status, summary: s.summary } }); pushSSE(device, { type: 'subagent', key: convo, id: s.id, name: s.name, status: s.status, summary: s.summary }); },
      });
      // Persist the assistant's final reply under 'assistant-native' so it replays on reopen (symmetric with media).
      if (replyText.trim()) ctx.emit({ surface: 'assistant-native', event_type: 'outbound', session_id: convo, identity: 'assistant', payload: { text: replyText } });
      pushSSE(device, { type: 'done', conversation_key: convo });
    } catch (e) {
      ctx.log(`android turn error (${device}): ${e.message}`);
      pushSSE(device, { type: 'error', key: convo, error: e.message });
    }
    try { ctx.heartbeat(); } catch (_) {}
  });

  // Stop the in-flight turn for this device (the overlay Stop button) → core aborts by conversation_key.
  const CORE_ABORT = (process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle$/, '/v2/abort');
  app.post('/gw/abort', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(b.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    try { await fetch(CORE_ABORT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_key: convKey(device) }) }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- #77 device control: core→device RPC round-trip -----------------------------------------------
  // The core's `asmltr-device` MCP tool POSTs /gw/rpc; we push a `device_rpc` frame to the phone, the
  // app runs it via the AsmltrDevice bridge and POSTs /gw/rpc-result, and we resolve the original POST
  // with the device's result. Lets the assistant actually actuate the phone (volume, launch apps, …).
  const pendingRpc = new Map(); // id → { resolve, timer }
  let rpcSeq = 0;
  // Prefer the persistent control link (works with no UI open); fall back to the chat stream (PWA/web).
  function pickTarget(requested) {
    const pick = (map) => {
      if (requested) return map.has(requested) ? requested : null;
      let best = null, bestSince = -1;
      for (const [id, d] of map) if (d.since > bestSince) { best = id; bestSince = d.since; }
      return best;
    };
    const c = pick(controlDevices); if (c) return { device: c, push: pushControl };
    const d = pick(devices); if (d) return { device: d, push: pushSSE };
    return null;
  }
  app.post('/gw/rpc', (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(extractDeviceToken(req))) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const tgt = pickTarget(b.device ? String(b.device).trim() : '');
    if (!tgt) return res.status(404).json({ ok: false, error: 'no connected device' });
    const tool = String(b.tool || '').trim();
    if (!tool) return res.status(400).json({ ok: false, error: 'tool required' });
    const id = `rpc${++rpcSeq}-${Date.now()}`;
    const timeoutMs = Math.min(Math.max(parseInt(b.timeout_ms, 10) || 20000, 1000), 60000);
    const timer = setTimeout(() => {
      if (pendingRpc.has(id)) { pendingRpc.delete(id); res.status(504).json({ ok: false, error: 'device did not respond in time' }); }
    }, timeoutMs);
    if (timer.unref) timer.unref();
    pendingRpc.set(id, { resolve: (result) => { clearTimeout(timer); res.json({ ok: true, device: tgt.device, result }); }, timer });
    const delivered = tgt.push(tgt.device, { type: 'device_rpc', id, tool, args: b.args || {} });
    if (!delivered) { clearTimeout(timer); pendingRpc.delete(id); return res.status(502).json({ ok: false, error: 'device push failed' }); }
  });
  app.post('/gw/rpc-result', (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const id = String(b.id || '');
    const p = pendingRpc.get(id);
    if (!p) return res.json({ ok: false, error: 'unknown or expired rpc id' });
    pendingRpc.delete(id);
    p.resolve(b.result != null ? b.result : { ok: false, error: 'no result' });
    res.json({ ok: true });
  });
  // Let the core discover which devices can be actuated (for the MCP tool's device targeting).
  app.get('/gw/devices', (req, res) => {
    res.json({ ok: true,
      devices: [...devices.entries()].map(([id, d]) => ({ id, name: d.name, since: d.since })),
      control: [...controlDevices.entries()].map(([id, d]) => ({ id, name: d.name, since: d.since })) });
  });

  // --- manager→device push: `asmltr send android <device>` / announcements / steer / notify ----------
  // kind:'inject' (default) steers text into a turn; kind:'speak' (asmltr notify, Part A) asks the device
  // to read the text ALOUD without running a turn. A '*' / empty target broadcasts to every connected
  // device — and to the background control link too, so read-aloud works even when the overlay is closed.
  app.post('/out', (req, res) => {
    if (requireToken && !auth(extractDeviceToken(req))) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const { target, text, kind, title, require_headphones, path: filePath, caption, host_id, control } = req.body || {};
    const device = String(target || '').trim();
    // kind:'file' → register the file + push a `media` frame the app renders inline / downloads via /gw/file.
    // A '*'/empty target broadcasts to every connected device (each gets a URL bearing its OWN token).
    if (kind === 'file') {
      const fp = String(filePath || '');
      if (!fp) return res.status(400).json({ ok: false, error: 'file kind requires a `path`' });
      let real, st;
      try { real = fs.realpathSync(fp); st = fs.statSync(real); } catch (_) { return res.status(404).json({ ok: false, error: 'file not found' }); }
      if (!st.isFile()) return res.status(400).json({ ok: false, error: 'not a file' });
      if (!underAllowed(real)) return res.status(403).json({ ok: false, error: 'file must live under an allowed base (Self silo artifacts / shared uploads)' });
      const mime = guessMime(real);
      const name = path.basename(real);
      const cap = String(caption || '');
      const id = registerMedia(real, mime, name);
      // Resolve the target → connected device ids: a device id matches directly; an IDENTITY (e.g. 'owner')
      // matches every device authed under it; '*'/empty broadcasts to all. Falls back to the raw target so
      // an offline device id still gets a replayable record. (Was: raw target used as a device-map key, so
      // sending to identity 'owner' silently matched nothing yet reported success.)
      let targetIds;
      if (!device || device === '*') targetIds = [...devices.keys()];
      else if (devices.has(device)) targetIds = [device];
      else {
        const byIdentity = [...devices.entries()].filter(([, d]) => d.identity === device).map(([k]) => k);
        targetIds = byIdentity.length ? byIdentity : [device];
      }
      let delivered = 0; const seen = new Set();
      for (const dev of targetIds) {
        if (seen.has(dev)) continue; seen.add(dev);
        // Persist a token-FREE renderable record so a reconnecting device replays the attachment via
        // /gw/history (which rebuilds the URL with the requester's own token). Emitted even if the live
        // push below fails, so an offline device still sees it on next connect. Surface must be the
        // canonical 'assistant-native' — 'android' isn't a valid event surface, so it'd be dropped.
        ctx.emit({ surface: 'assistant-native', event_type: 'outbound', session_id: convKey(dev), identity: 'assistant', payload: { text: cap, media: { id, mime, name, caption: cap } } });
        const d = devices.get(dev);
        if (d && pushSSE(dev, { type: 'media', url: mediaUrl(id, d.token), mime, name, caption: cap })) delivered++;
      }
      // Honest result: `delivered` counts LIVE pushes only. 0 (offline / no match) → ok:false so the notify
      // ladder and `asmltr send` don't report a false success; the record still replays on reconnect.
      return res.json({ ok: delivered > 0, delivered, id, mime, name,
        url: mediaUrl(id, undefined),
        conversation_key: targetIds.length === 1 ? convKey(targetIds[0]) : undefined,
        error: delivered > 0 ? undefined : 'no matching connected device (saved for reconnect)' });
    }
    if (kind === 'speak') {
      const frame = { type: 'speak', text: String(text || ''), title: title || null, require_headphones: !!require_headphones };
      let delivered = 0;
      if (!device || device === '*') {
        for (const id of devices.keys()) if (pushSSE(id, frame)) delivered++;
        for (const id of controlDevices.keys()) if (pushControl(id, frame)) delivered++;
      } else {
        if (pushSSE(device, frame)) delivered++;
        if (pushControl(device, frame)) delivered++;
      }
      return res.json({ ok: delivered > 0, delivered, error: delivered ? undefined : 'no device connected' });
    }
    // kind:'open-remote-desktop' → tell the app to OPEN a live remote-desktop stream from host_id (the
    // cast-to-device primitive; the remote-desktop broker's /rd/cast calls this). Pushed to the chat SSE
    // (which navigates the WebView to the RD viewer) AND the background control link. '*'/empty target
    // broadcasts to every connected device. This is the "open a live host stream on this device" sibling
    // of the `media` screenshot frame the app already renders inline.
    if (kind === 'open-remote-desktop') {
      const frame = { type: 'open-remote-desktop', host_id: String(host_id || ''), control: !!control };
      if (!frame.host_id) return res.status(400).json({ ok: false, error: 'open-remote-desktop requires host_id' });
      let delivered = 0;
      if (!device || device === '*') {
        for (const id of devices.keys()) if (pushSSE(id, frame)) delivered++;
        for (const id of controlDevices.keys()) if (pushControl(id, frame)) delivered++;
      } else {
        if (pushSSE(device, frame)) delivered++;
        if (pushControl(device, frame)) delivered++;
      }
      return res.json({ ok: delivered > 0, delivered, error: delivered ? undefined : 'no device connected' });
    }
    if (!device) return res.status(400).json({ ok: false, error: 'target device id required' });
    const delivered = pushSSE(device, { type: 'inject', text: String(text || '') });
    if (!delivered) return res.json({ ok: false, error: 'device not connected', conversation_key: convKey(device) });
    return res.json({ ok: true, conversation_key: convKey(device) });
  });

  // Presence — is any assistant device reachable right now (chat stream or background control link)?
  // The notify ladder + GUI use this to decide whether the read-aloud step can land.
  app.get('/gw/presence', (req, res) => res.json({
    ok: true,
    reachable: devices.size > 0 || controlDevices.size > 0,
    chat: devices.size, control: controlDevices.size,
    devices: [...new Set([...devices.keys(), ...controlDevices.keys()])],
  }));

  // --- edge speech: STT + TTS proxied here so the phone needs only its device token ----------------
  app.post('/gw/transcribe', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const buf = Buffer.from(String(b.audio_base64 || ''), 'base64');
      if (!buf.length) return res.status(400).json({ ok: false, error: 'audio_base64 required' });
      const r = await stt.transcribe(buf, { mime: b.mime || 'audio/webm', filename: b.filename, language: b.language });
      // Aux cost: metered STT key → price by audio seconds (est. from clip size when no reported duration).
      const seconds = r.duration || estimateAudioSeconds(r.bytes, b.mime || 'audio/webm');
      ctx.emit(auxUsage({ surface: 'assistant-native', feature: 'stt', provider: 'openai', model: r.model, seconds }));
      res.json({ ok: true, text: r.text || '', model: r.model });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Live (streaming) STT: mint a short-lived EPHEMERAL OpenAI realtime-transcription secret so the phone
  // can open a WebRTC session straight to OpenAI and receive partial transcript deltas while the user
  // speaks — the real openai key never leaves the host (minted in shared/speech/stt.realtimeToken).
  // The overlay falls back to batch /gw/transcribe when this is off or fails.
  app.post('/gw/realtime-token', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      // Realtime = the 'realtime_transcribe' voice role (epic #113) → gpt-live-transcribe (streaming
      // partials, no server_vad), distinct from the batch 'transcribe' model. stt.realtimeToken already
      // mints via /v1/realtime/client_secrets with the transcription session baked in.
      const t = await stt.realtimeToken({ model: b.model || 'gpt-live-transcribe' });
      res.json({ ok: true, value: t.value, expires_at: t.expires_at, model: t.model });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });
  app.post('/gw/tts', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const text = String(b.text || '').trim();
      if (!text) return res.status(400).json({ ok: false, error: 'text required' });
      const r = await tts.synthesize(text, { voice: b.voice, model: b.model });
      // Aux cost: metered TTS key → price by characters synthesized.
      const c = tts.config();
      ctx.emit(auxUsage({ surface: 'assistant-native', feature: 'tts',
        provider: c.provider, model: b.model || c.model, chars: text.length }));
      res.json({ ok: true, mime: r.mime, b64: Buffer.from(r.audio).toString('base64') });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- APK download: open (the app isn't a secret; the device token gates the API, not the binary) ---
  // Prefer a packaged RELEASE apk, fall back to the debug build. A debug APK makes Android show an
  // "App Compatibility / debuggable app" warning on install and leaves the app's private data readable
  // via `run-as`, so ship release when one exists. Override either with ASMLTR_ANDROID_APK.
  // Install straight from the instance: https://<host>/app/gw/download
  const MOBILE_DIR = path.join(__dirname, '..', '..', '..', 'mobile');
  const APK_CANDIDATES = [
    path.join(MOBILE_DIR, 'dist', 'asmltr.apk'),
    path.join(MOBILE_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    path.join(MOBILE_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
  ];
  const APK = process.env.ASMLTR_ANDROID_APK || APK_CANDIDATES.find((p) => fs.existsSync(p)) || APK_CANDIDATES[APK_CANDIDATES.length - 1];
  const APK_VER = path.join(__dirname, '..', '..', '..', 'mobile', 'app-version.json');
  app.get('/gw/app', (req, res) => {
    let v = {}; try { v = JSON.parse(fs.readFileSync(APK_VER, 'utf8')); } catch (_) {}
    res.json({ available: fs.existsSync(APK), download: '/app/gw/download', filename: 'asmltr.apk', versionCode: v.versionCode || 0, versionName: v.versionName || '' });
  });
  // Branding + the global voice/VAD tuning (from core /v2/voice/config), so the app themes itself AND
  // applies the shared end-of-speech / mic-sensitivity settings edited in the web GUI / TUI.
  const CORE_VOICE = (process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle$/, '/v2/voice/config');
  app.get('/gw/theme', async (req, res) => {
    let palette = '', name = '';
    try { palette = identity.getFacet('palette') || ''; } catch (_) {}
    try { name = identity.name() || ''; } catch (_) {}
    let stt = null;
    try { const r = await fetch(CORE_VOICE); if (r.ok) { const j = await r.json(); stt = j.stt || null; } } catch (_) {}
    const vad = stt ? { endpoint_ms: stt.vad_endpoint_ms, start_ms: stt.vad_start_ms, sensitivity: stt.vad_sensitivity } : null;
    const wake = stt ? { enabled: !!stt.wake_enabled, phrase: stt.wake_phrase || '', sensitivity: stt.wake_sensitivity } : null;
    const stopPhrases = stt && stt.stop_phrases != null ? stt.stop_phrases : '';
    res.json({ palette, agentName: name, vad, wake, stop_phrases: stopPhrases });
  });

  // Wake word (Vosk, offline): the app fetches config here + the model URL. The phrase is a runtime
  // grammar string on the device — no per-phrase model, no external site. One ~40MB model, downloaded
  // once to the phone, covers every phrase. Model URL overridable via ASMLTR_VOSK_MODEL_URL (self-host).
  const VOSK_MODEL_URL = process.env.ASMLTR_VOSK_MODEL_URL || 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
  const VOSK_MODEL_ID = process.env.ASMLTR_VOSK_MODEL_ID || 'vosk-model-small-en-us-0.15';
  app.get('/gw/wake', async (req, res) => {
    if (requireToken && !auth(req.query.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    let stt = null;
    try { const r = await fetch(CORE_VOICE); if (r.ok) { const j = await r.json(); stt = j.stt || null; } } catch (_) {}
    const phrase = (stt && stt.wake_phrase) || `hey ${process.env.ASSISTANT_NAME || 'assistant'}`;
    res.json({ ok: true, engine: 'vosk',
      enabled: !!(stt && stt.wake_enabled), phrase,
      sensitivity: (stt && stt.wake_sensitivity != null) ? stt.wake_sensitivity : 50,
      model_url: VOSK_MODEL_URL, model_id: VOSK_MODEL_ID });
  });

  // Notification reader (Part B): the app posts an incoming phone notification; the core's DEFAULT engine
  // triages it → { speak, priority, synopsis }. Separate system from asmltr notify — NO push/telegram
  // fallback; the phone either reads it over BT or stays quiet.
  const CORE_TRIAGE = (process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle$/, '/v2/notify/triage');
  app.post('/gw/notify-triage', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const r = await fetch(CORE_TRIAGE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: b.app, package: b.package, title: b.title, text: b.text }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) return res.status(502).json({ ok: false, error: (j && j.error) || `core ${r.status}` });
      res.json({ ok: true, speak: !!j.speak, priority: j.priority || 0, synopsis: j.synopsis || '' });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });
  // Let the phone app write voice/wake settings back (so it's configurable IN the app, not just the web GUI).
  app.post('/gw/voice-config', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const r = await fetch(CORE_VOICE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stt: b.stt || {} }) });
      const j = await r.json().catch(() => ({}));
      res.json({ ok: true, stt: j.stt || null });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });
  app.get('/gw/download', (req, res) => {
    if (!fs.existsSync(APK)) return res.status(404).json({ ok: false, error: 'APK not built yet' });
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="asmltr.apk"');
    fs.createReadStream(APK).pipe(res);
  });

  // Serve an outbound attachment referenced by a `media` frame's URL. Token-gated (any valid device
  // token) like /gw/stream + /gw/wake. Security: serves ONLY files a prior kind:'file' send registered
  // (opaque id → real path — no path param, so no traversal), and re-validates the real path is a file
  // under an allowed base. Content-Type from the stored MIME so <img src> renders it directly.
  app.get('/gw/file', (req, res) => {
    if (requireToken && !auth(req.query.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const rec = mediaMap.get(String(req.query.id || ''));
    if (!rec) return res.status(404).json({ ok: false, error: 'unknown media id' });
    let real, st;
    try { real = fs.realpathSync(rec.path); st = fs.statSync(real); } catch (_) { return res.status(404).json({ ok: false, error: 'file gone' }); }
    if (!st.isFile() || !underAllowed(real)) return res.status(403).json({ ok: false, error: 'forbidden' });
    res.setHeader('Content-Type', rec.mime || guessMime(real));
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Content-Disposition', `inline; filename="${(rec.name || path.basename(real)).replace(/["\\]/g, '')}"`);
    fs.createReadStream(real).on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
  });

  const httpServer = app.listen(PORT, BIND, () => ctx.log(`android device gateway on ${BIND}:${PORT} (${requireToken ? 'token required' : 'OPEN'})`));

  return {
    async stop() {
      for (const d of devices.values()) { try { d.res.end(); } catch (_) {} }
      for (const d of controlDevices.values()) { try { d.res.end(); } catch (_) {} }
      devices.clear(); controlDevices.clear();
      await new Promise((r) => httpServer.close(() => r()));
    },
    health() { return { http_port: PORT, devices: devices.size, control: controlDevices.size }; },
  };
}

module.exports = { meta, start };
