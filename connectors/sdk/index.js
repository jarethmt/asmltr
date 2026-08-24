'use strict';
/**
 * asmltr connector SDK — the contract + context every connector type plugin uses.
 *
 * A TYPE plugin (connectors/types/<type>/index.js) exports:
 *   module.exports = {
 *     meta: { type, displayName, supportsMultiple, capabilities, credentialKeys, configSchema },
 *     async start(ctx) -> { stop():Promise, health():object }   // long-running connector instance
 *   }
 *
 * The runtime harness builds `ctx` and calls start(); the manager runs one OS
 * process per INSTANCE (isolation — one connector crashing can't take others down).
 *
 * ctx = {
 *   instanceId, instanceName, config,
 *   core:    { handle(envelope) -> actions[] },   // posts to asmltr-core /v2/handle
 *   secrets: { get(bwsKey) -> value },            // Bitwarden, cached
 *   emit(partialEvent),                           // telemetry to the collector
 *   log(...args),
 *   signal,                                       // AbortSignal, fired on shutdown
 * }
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const http = require('http');
const https = require('https');
const { buildEvent } = require('../../shared/events');

/**
 * Client to asmltr-core. handle() runs one turn and returns outbound actions.
 *
 * Uses raw http(s), NOT global fetch: a single turn (deep research, tool-heavy
 * GitHub issues) can hold the connection open for many minutes, but Node's fetch
 * (undici) aborts with "fetch failed" at its ~300s headers timeout while the core
 * keeps running — the GitHub 5-min freeze / MCP long-research cutoff (2026-06-24).
 * http.request imposes no response timeout, so long turns complete.
 */
function makeCoreClient(coreUrl) {
  const u = new URL(coreUrl);
  const lib = u.protocol === 'https:' ? https : http;
  // Idle-socket timeout so a DROPPED core connection (e.g. the core restarting mid-turn) can't
  // leave a request pending forever — which strands the connector's per-channel lock and "hangs"
  // the assistant on that channel. Generous, and reset by any socket activity, so long streaming
  // turns (which emit data) are unaffected; a genuinely silent turn beyond this is treated as dead.
  const REQ_TIMEOUT = Number(process.env.ASMLTR_CORE_TIMEOUT_MS || 15 * 60 * 1000);
  const guard = (req) => { req.setTimeout(REQ_TIMEOUT, () => req.destroy(new Error('core request timed out (connection dropped?)'))); };
  // Premature close: the core dies AFTER response headers are sent (the common case — it restarts
  // mid-turn). Node then emits ONLY 'aborted'/'error' on the RESPONSE: `req.on('error')` never fires,
  // 'end' never fires, and nothing throws — so without this the promise never settles at all. The
  // `guard` above can't cover it either: setTimeout timers live on the socket, and that socket is
  // already destroyed. A never-settling turn strands the caller's per-channel lock and typing
  // indicator forever (Discord "…is typing" with the channel deaf to every later message, 2026-08-20).
  const watchClose = (res, fail) => {
    res.on('aborted', () => fail(new Error('core closed the connection mid-response (core restarted?)')));
    res.on('error', (e) => fail(e));
  };
  return {
    handle(envelope) {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(envelope);
        const req = lib.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
          let data = '';
          res.setEncoding('utf8');
          watchClose(res, reject);
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            let j = {};
            try { j = data ? JSON.parse(data) : {}; } catch (_) {}
            if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(j.error || `core ${res.statusCode}`));
            resolve(j.actions || []);
          });
        });
        req.on('error', reject);
        guard(req);
        req.write(payload);
        req.end();
      });
    },
    // Streaming turn: posts to the core /v2/stream (SSE) and resolves with the final actions[].
    // `handlers` is either a function (treated as onDelta — token stream) or an object:
    //   { onDelta(text), onSegment(text), onTool(name), onThinking(text) }
    // Token consumers (voice/openai) use onDelta; step consumers (Discord) use onSegment/onTool.
    handleStream(envelope, handlers) {
      const h = typeof handlers === 'function' ? { onDelta: handlers } : (handlers || {});
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(envelope);
        const req = lib.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: '/v2/stream',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'text/event-stream' },
        }, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error(`core ${res.statusCode}`)); }
          let buf = '', settled = false;
          const fail = (e) => { if (!settled) { settled = true; reject(e); } };
          res.setEncoding('utf8');
          watchClose(res, fail);
          res.on('data', (c) => {
            buf += c;
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:'));
              buf = buf.slice(i + 2);
              if (!line) continue;
              let obj; try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
              if (obj.type === 'delta') { if (h.onDelta && obj.text) { try { h.onDelta(obj.text); } catch (_) {} } }
              else if (obj.type === 'segment') { if (h.onSegment && obj.text) { try { h.onSegment(obj.text); } catch (_) {} } }
              else if (obj.type === 'tool') { if (h.onTool && obj.name) { try { h.onTool(obj.name); } catch (_) {} } if (h.onToolCall) { try { h.onToolCall(obj); } catch (_) {} } }
              else if (obj.type === 'tool_result') { if (h.onToolResult) { try { h.onToolResult(obj); } catch (_) {} } }
              else if (obj.type === 'thinking') { if (h.onThinking && obj.text) { try { h.onThinking(obj.text); } catch (_) {} } }
              else if (obj.type === 'effort') { if (h.onEffort && obj.effort) { try { h.onEffort(obj.effort, obj); } catch (_) {} } }
              else if (obj.type === 'subagent') { if (h.onSubagent && obj.id) { try { h.onSubagent(obj); } catch (_) {} } }
              else if (obj.type === 'done') { settled = true; resolve(obj.actions || []); }
              else if (obj.type === 'error') { settled = true; reject(new Error(obj.error || 'stream error')); }
            }
          });
          res.on('end', () => { if (!settled) resolve([]); });
        });
        req.on('error', reject);
        guard(req);
        req.write(payload);
        req.end();
      });
    },
    // Read-only trust resolution (for connector-side authorization, e.g. owner-only commands).
    resolve(envelope) {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(envelope);
        const req = lib.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: '/trust/resolve',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
          let data = '';
          res.setEncoding('utf8');
          watchClose(res, reject);
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            let j = {};
            try { j = data ? JSON.parse(data) : {}; } catch (_) {}
            if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(j.error || `core ${res.statusCode}`));
            resolve(j);
          });
        });
        req.on('error', reject);
        guard(req);
        req.write(payload);
        req.end();
      });
    },
    // Device registry auth (docs/DEVICE-REGISTRY.md): verify a credential a device presented.
    // Resolves to the device record, or null when the credential is unknown/revoked — that is an
    // EXPECTED outcome on an auth path, not an error, so it resolves rather than rejects. A genuine
    // transport failure still rejects, so a caller can tell "bad token" from "core unreachable"
    // and fail closed loudly instead of silently locking every device out.
    deviceAuth(token, transport) {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ token, transport: transport || null });
        const req = lib.request({
          hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: '/v2/devices/auth', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
          let data = ''; res.setEncoding('utf8'); watchClose(res, reject); res.on('data', (c) => { data += c; });
          res.on('end', () => {
            if (res.statusCode === 401) return resolve(null);
            let j = {}; try { j = data ? JSON.parse(data) : {}; } catch (_) {}
            if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(j.error || `core ${res.statusCode}`));
            resolve(j);
          });
        });
        req.on('error', reject); guard(req); req.write(payload); req.end();
      });
    },
    // Fire-and-resolve JSON POST to a core control endpoint (abort/inject live-turn controls).
    _post(path, body) {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = lib.request({
          hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
          let data = ''; res.setEncoding('utf8'); watchClose(res, reject); res.on('data', (c) => { data += c; });
          res.on('end', () => { let j = {}; try { j = data ? JSON.parse(data) : {}; } catch (_) {}
            if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(j.error || `core ${res.statusCode}`));
            resolve(j); });
        });
        req.on('error', reject); guard(req); req.write(payload); req.end();
      });
    },
    _get(path) {
      return new Promise((resolve, reject) => {
        const req = lib.request({
          hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path, method: 'GET',
          headers: { Accept: 'application/json' },
        }, (res) => {
          let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c; });
          res.on('end', () => { let j = {}; try { j = data ? JSON.parse(data) : {}; } catch (_) {}
            if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(j.error || `core ${res.statusCode}`));
            resolve(j); });
        });
        req.on('error', reject); guard(req); req.end();
      });
    },
    // Access principals for public-surface sanitizer hints (ids / names / mailboxes). Fail-open at caller.
    trustPrincipals() { return this._get('/trust/principals').then((j) => j.principals || []); },
    // Abort the in-flight turn for a conversation (the session survives + is resumable).
    abort(conversationKey) { return this._post('/v2/abort', { conversation_key: conversationKey }); },
    // Inject text into a running/next turn as steering guidance. interrupt:true aborts+redirects;
    // interrupt:false (default) queues behind the current turn and continues it with the guidance folded in.
    inject(conversationKey, text, opts = {}) { return this._post('/v2/inject', { conversation_key: conversationKey, text, by: opts.by || 'operator', interrupt: !!opts.interrupt }); },
  };
}

/** Secret accessor — pluggable provider (env / file / command). See shared/secrets.js. */
function makeSecrets() {
  return require('../../shared/secrets');
}

/** Shared upload surface — connectors register EVERY inbound file here so any session,
 *  on any channel, can find it the same way. See shared/uploads.js. */
function makeUploads() {
  return require('../../shared/uploads');
}

/** Telemetry emitter → collector /ingest (best-effort, never blocks the connector). */
function makeEmitter(collectorUrl, token, defaults) {
  return function emit(partial) {
    let evt;
    try { evt = buildEvent({ ...defaults, ...partial }); } catch (e) { return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    fetch(collectorUrl, { method: 'POST', headers, body: JSON.stringify(evt), signal: ctrl.signal })
      .catch(() => {}).finally(() => clearTimeout(t));
  };
}

/** Build the ctx handed to a plugin's start(). */
function buildContext({ instanceId, instanceName, type, config, coreUrl, collectorUrl, token, signal }) {
  const emit = makeEmitter(collectorUrl, token, { surface: type, source: `connector:${instanceId}` });
  const { HEARTBEAT_TOKEN } = require('../manager/health');
  return {
    instanceId,
    instanceName,
    config: config || {},
    core: makeCoreClient(coreUrl),
    secrets: makeSecrets(),
    uploads: makeUploads(),
    emit,
    log: (...a) => console.log(`[${type}:${instanceName || instanceId}]`, ...a),
    // Liveness signal: a connector calls this from its ACTIVE I/O path (a successful poll cycle, a
    // gateway that's still Ready). It writes one sentinel line to stdout, which the manager already
    // scrapes, and the supervisor records the time. A dead I/O loop stops calling it, so the manager
    // marks the instance stale WITHOUT the process having to crash. Never throws.
    heartbeat: () => { try { process.stdout.write(HEARTBEAT_TOKEN + '\n'); } catch (_) {} },
    signal,
  };
}

module.exports = { makeCoreClient, makeSecrets, makeEmitter, buildContext };
