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
// Speech is proxied through this connector so the phone has ONE token-authed surface (no separate
// core-auth for /v2/transcribe + /v2/tts). Same shared modules the core /v2 speech endpoints use.
const stt = require('../../../shared/speech/stt');
const tts = require('../../../shared/speech/tts');

const meta = {
  type: 'android',
  displayName: 'Android assistant',
  // Push channel: the manager /send router + announcements/steer reach a device via POST /out.
  outbound: { kinds: ['text'], target: { required: true, label: 'Device id' } },
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

  function keyEntry(token) { return loadKeys(keysFile).find((k) => k.key === token) || null; }
  // Resolve a device's caller identity from its token. Returns null when a token is required but invalid.
  function auth(token) {
    if (!requireToken) { const e = token && keyEntry(token); return { identity: (e && e.identity) || 'android-anon', username: (e && e.username) || 'android' }; }
    if (!token) return null;
    const e = keyEntry(token);
    return e ? { identity: e.identity, username: e.username || e.identity } : null;
  }
  const convKey = (device) => `android:${ctx.instanceId}:device:${device}`;
  function pushSSE(device, obj) {
    const d = devices.get(device);
    if (!d) return false;
    try { d.res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch (_) { return false; }
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
    devices.set(device, { res, name, identity: who.identity, since: Date.now() });
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

    ctx.emit({ event_type: 'inbound', session_id: convKey(device), identity: who.identity, payload: { text: text.slice(0, 200) } });
    const envelope = {
      channel: 'android',
      conversation_key: convKey(device),
      message_id: String(Date.now()),
      sender: { raw_id: who.identity, raw_username: name },
      content: { text },
      delivery: 'sync',
      public: false, // 1:1 authed device; redaction still applies unless the identity is full-trust
      channel_context: { device },
      context: { scope_name: 'Android assistant' },
      capabilities: { max_message_chars: 100000, supports_markdown: false, streaming: true, supports_attachments_out: false },
    };

    // Ack immediately (the reply streams over the SSE, not this POST response).
    res.json({ ok: true, conversation_key: convKey(device), streaming: devices.has(device) });
    try {
      await ctx.core.handleStream(envelope, (delta) => pushSSE(device, { type: 'delta', text: delta }));
      pushSSE(device, { type: 'done', conversation_key: convKey(device) });
    } catch (e) {
      ctx.log(`android turn error (${device}): ${e.message}`);
      pushSSE(device, { type: 'error', error: e.message });
    }
    try { ctx.heartbeat(); } catch (_) {}
  });

  // --- manager→device push: `asmltr send android <device>` / announcements / steer ------------------
  app.post('/out', (req, res) => {
    const { target, text } = req.body || {};
    const device = String(target || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'target device id required' });
    const delivered = pushSSE(device, { type: 'inject', text: String(text || '') });
    if (!delivered) return res.json({ ok: false, error: 'device not connected', conversation_key: convKey(device) });
    return res.json({ ok: true, conversation_key: convKey(device) });
  });

  // --- edge speech: STT + TTS proxied here so the phone needs only its device token ----------------
  app.post('/gw/transcribe', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const buf = Buffer.from(String(b.audio_base64 || ''), 'base64');
      if (!buf.length) return res.status(400).json({ ok: false, error: 'audio_base64 required' });
      const r = await stt.transcribe(buf, { mime: b.mime || 'audio/webm', filename: b.filename, language: b.language });
      res.json({ ok: true, text: r.text || '', model: r.model });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/gw/tts', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const text = String(b.text || '').trim();
      if (!text) return res.status(400).json({ ok: false, error: 'text required' });
      const r = await tts.synthesize(text, { voice: b.voice, model: b.model });
      res.json({ ok: true, mime: r.mime, b64: Buffer.from(r.audio).toString('base64') });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- APK download: open (the app isn't a secret; the device token gates the API, not the binary) ---
  // Default: the built debug APK; override with ASMLTR_ANDROID_APK. Install straight from the instance:
  // https://<host>/app/gw/download
  const APK = process.env.ASMLTR_ANDROID_APK || path.join(__dirname, '..', '..', '..', 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  app.get('/gw/app', (req, res) => res.json({ available: fs.existsSync(APK), download: '/app/gw/download', filename: 'asmltr.apk' }));
  app.get('/gw/download', (req, res) => {
    if (!fs.existsSync(APK)) return res.status(404).json({ ok: false, error: 'APK not built yet' });
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="asmltr.apk"');
    fs.createReadStream(APK).pipe(res);
  });

  const httpServer = app.listen(PORT, BIND, () => ctx.log(`android device gateway on ${BIND}:${PORT} (${requireToken ? 'token required' : 'OPEN'})`));

  return {
    async stop() {
      for (const d of devices.values()) { try { d.res.end(); } catch (_) {} }
      devices.clear();
      await new Promise((r) => httpServer.close(() => r()));
    },
    health() { return { http_port: PORT, devices: devices.size }; },
  };
}

module.exports = { meta, start };
