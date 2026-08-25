'use strict';
/**
 * asmltr connector type: remote-desktop — the SIGNALING BROKER + control plane for the custom WebRTC
 * remote-desktop capability (see docs/REMOTE-DESKTOP.md). It is NOT the media path: it introduces a
 * source (a host agent) to a viewer (the app), relays their SDP/ICE so ICE can hole-punch a DIRECT
 * peer-to-peer connection, hands out STUN (+ optional TURN-fallback) config, and enforces per-host
 * view/control trust grants. Media flows peer-to-peer; the broker never sees it.
 *
 * Transport mirrors the android connector's proven gateway (no new deps): each peer holds an outbound
 * SSE stream (GET /rd/stream) and POSTs signaling messages (POST /rd/msg). Token-authed via the same
 * gitignored keys file convention. conversation-less: this is infra signaling, not a chat channel.
 *
 *   host agent → GET /rd/stream?token=&role=host&host_id=&name=   (holds the stream; receives offers/ice)
 *   viewer     → GET /rd/stream?token=&role=viewer&client_id=     (holds the stream; receives answers/ice)
 *   any        → POST /rd/msg { token, type, ... }                (register/list/connect/sdp/ice/bye)
 *   any        → GET /rd/ice-config?token=                        (STUN urls + short-lived TURN creds if on)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const meta = {
  type: 'remote-desktop',
  displayName: 'Remote desktop (WebRTC signaling)',
  // An outward capability, not a conversation channel (docs/INTEGRATIONS.md). `role` is what keeps
  // it out of the send-target list now — it no longer has to fake an empty outbound surface to
  // avoid being offered as one.
  role: 'service',
  kind: 'transport',        // it yields access to a MACHINE, bound to a device row
  lifecycle: 'supervised',  // a long-running broker, supervised by the same machinery as channels
  optional: true,           // asmltr runs fine without remote desktop — that is what makes it an integration
  configSchema: {
    type: 'object',
    properties: {
      http_port: { type: 'integer', title: 'HTTP port (signaling)', default: 3028 },
      bind_host: { type: 'string', title: 'Bind address', default: '127.0.0.1' },
      keys_file: { type: 'string', title: 'Peer tokens file (gitignored: token → trust identity)', default: '' },
      require_token: { type: 'boolean', title: 'Require a peer token', default: true },
      // NAT traversal: STUN is always on (own service preferred; public fallback list). TURN is an
      // explicit last-resort for symmetric-NAT-on-both-ends only; OFF by default = direct-or-nothing.
      stun_urls: { type: 'array', title: 'STUN urls', items: { type: 'string' },
        default: ['stun:stun.l.google.com:19302'] },
      turn_enabled: { type: 'boolean', title: 'Enable TURN fallback (relays media through server)', default: false },
      turn_url: { type: 'string', title: 'TURN url', default: '' },
      turn_secret_key: { type: 'string', title: 'TURN shared-secret vault key (coturn REST auth)', default: '' },
      // Cast-to-device: the broker doesn't hold a phone's SSE (the android connector does), so to project
      // a host onto a device it calls the android gateway's internal /out push path. Localhost, no new dep.
      android_gw_url: { type: 'string', title: 'Android gateway URL (cast-to-device push target)', default: 'http://127.0.0.1:3027' },
    },
  },
};

function loadKeys(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.keys) ? j.keys : []; } catch { return []; }
}

async function start(ctx) {
  const cfg = ctx.config || {};
  const PORT = cfg.http_port || 3028;
  const BIND = cfg.bind_host || '127.0.0.1';
  const requireToken = cfg.require_token !== false;
  const keysFile = cfg.keys_file || path.join(__dirname, 'keys.json');

  const hosts = new Map();    // host_id → { res, name, identity, caps, since }
  const viewers = new Map();  // client_id → { res, identity, since }
  const sessions = new Map(); // session_id → { host_id, client_id, control, identity, since }

  // --- peer authentication: the DEVICE REGISTRY first, keys.json only as a migration fallback -----
  // Credentials used to live in a hand-edited gitignored keys.json. They now live in the TRUST vault,
  // issued per device by `asmltr device enroll`, with the registry holding only a hash (see
  // docs/DEVICE-REGISTRY.md). The file path is kept ONLY so an install mid-migration keeps working;
  // it logs loudly every time it is used so the leftover cannot go unnoticed.
  //
  // This runs on EVERY signaling message, so it must not put a core round-trip in front of each ICE
  // candidate: results are cached briefly, negatives for less time than positives, and core pokes
  // POST /rd/invalidate on revoke so a revocation is not left waiting on a TTL.
  const AUTH_TTL_MS = Number(cfg.auth_cache_ttl_ms || 60000);
  const AUTH_NEG_TTL_MS = Math.min(15000, AUTH_TTL_MS);
  const authCache = new Map(); // token → { who: entry|null, exp }
  let warnedLegacyKeys = false;

  const keyEntry = (token) => loadKeys(keysFile).find((k) => k.key === token) || null;

  function legacyAuth(token) {
    const e = token && keyEntry(token);
    if (!e) return null;
    if (!warnedLegacyKeys) {
      warnedLegacyKeys = true;
      ctx.log(`WARNING: peer authenticated from the legacy ${path.basename(keysFile)} instead of the device registry. ` +
        'Enroll this peer (`asmltr device enroll`) and delete the file — it is an un-revocable credential on disk.');
    }
    return { identity: e.identity, device_id: null, device_name: e.username || e.identity, legacy: true };
  }

  const ANON = { identity: 'rd-anon', device_id: null, device_name: 'anonymous', legacy: true };

  async function auth(token) {
    if (!token) return requireToken ? null : ANON;
    const hit = authCache.get(token);
    if (hit && hit.exp > Date.now()) return hit.who;

    let who = null;
    try {
      const d = await ctx.core.deviceAuth(token, 'rd');
      if (d && d.ok) {
        // Grants still resolve against a PRINCIPAL in P0 — the device's owner. Per-device grants
        // (principal x device x capability) land in P1; until then this preserves today's behaviour
        // exactly while moving where the credential is stored.
        who = { identity: d.owner_principal_id || d.device_id, device_id: d.device_id, device_name: d.name, legacy: false };
      }
    } catch (e) {
      // Core unreachable: do NOT fall through to a cached/legacy allow. Fail closed and say so.
      ctx.log(`device auth unavailable (${e.message}) — refusing the peer`);
      return null;
    }
    if (!who) who = legacyAuth(token);
    authCache.set(token, { who, exp: Date.now() + (who ? AUTH_TTL_MS : AUTH_NEG_TTL_MS) });
    // An open broker (require_token=false) still authenticates a KNOWN token, so an enrolled device
    // keeps its real identity and grants; only an unrecognised peer degrades to the anonymous one.
    return who || (requireToken ? null : ANON);
  }
  const push = (map, id, obj) => { const d = map.get(id); if (!d) return false; try { d.res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch (_) { return false; } };

  // --- authorization: per (principal x device x capability), not per person --------------------
  // Until P1 this was two booleans derived from the caller's trust tier, evaluated once for the
  // whole surface — so "may control ANY machine" was the only expressible answer. Access is now a
  // property of the PAIR: the registry resolves what this principal may do to THIS device over THIS
  // transport, default-deny, forbid-wins (core/src/devices/store.js: resolveDeviceGrants).
  //
  // A peer still on the legacy keys.json has no device row, so it falls back to the old trust-tier
  // check — otherwise a mid-migration install would lock itself out of its own machines.
  async function deviceGrants(principalId, deviceId) {
    if (!principalId || !deviceId) return { view: false, control: false };
    try {
      const r = await ctx.core._post('/v2/device-grants/resolve', { principal_id: principalId, device_id: deviceId, transport: 'rd' });
      return { view: !!(r && r.allow && r.allow.view), control: !!(r && r.allow && r.allow.control) };
    } catch (_) { return { view: false, control: false }; } // fail closed
  }

  async function legacyGrants(identity) {
    try {
      const r = await ctx.core.resolve({ channel: 'remote-desktop', sender: { raw_id: identity } });
      const tier = Number(r && r.trust_tier) || 0;
      const bypass = !!(r && r.bypass_moderation);
      const known = !!(r && !r.is_default && !r.revoked);
      return { view: known && (bypass || tier >= 1), control: bypass };
    } catch (_) { return { view: false, control: false }; }
  }

  // `who` is the authenticated peer (the viewer); `hostDeviceId` is the machine it wants.
  async function grantsFor(who, hostDeviceId) {
    if (who && who.device_id && hostDeviceId) return deviceGrants(who.identity, hostDeviceId);
    return legacyGrants(who && who.identity);
  }

  // Audit: the broker owns the truth about who connected to what, so it writes the record.
  // Best-effort — a failed audit write must never block or break a legitimate session.
  const openSession = (sid, hostDeviceId, who, capability) => {
    ctx.core._post('/v2/device-sessions', {
      id: sid, device_id: hostDeviceId, principal_id: who.identity, transport: 'rd', capability, surface: 'remote-desktop',
    }).catch(() => {});
  };
  const closeSession = (sid, reason) => { ctx.core._post(`/v2/device-sessions/${sid}/close`, { reason }).catch(() => {}); };

  // Where to reach the android connector's device gateway for cast-to-device pushes (its /out path).
  const ANDROID_GW = (cfg.android_gw_url || process.env.ASMLTR_ANDROID_GW_URL || 'http://127.0.0.1:3027').replace(/\/+$/, '');

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ICE config: STUN always; TURN only if explicitly enabled (short-lived coturn REST creds).
  app.get('/rd/ice-config', async (req, res) => {
    if (requireToken && !(await auth(req.query.token))) return res.status(401).json({ ok: false, error: 'invalid token' });
    const iceServers = [{ urls: cfg.stun_urls && cfg.stun_urls.length ? cfg.stun_urls : ['stun:stun.l.google.com:19302'] }];
    if (cfg.turn_enabled && cfg.turn_url) {
      try {
        const secret = cfg.turn_secret_key ? await ctx.secrets.get(cfg.turn_secret_key) : '';
        const ttl = 600; const username = `${Math.floor(Date.now() / 1000) + ttl}`;
        const credential = crypto.createHmac('sha1', secret || '').update(username).digest('base64');
        iceServers.push({ urls: [cfg.turn_url], username, credential });
      } catch (_) {}
    }
    res.json({ ok: true, iceServers, turn_enabled: !!cfg.turn_enabled });
  });

  // Persistent SSE stream per peer (host or viewer).
  app.get('/rd/stream', async (req, res) => {
    const who = await auth(req.query.token);
    if (requireToken && !who) return res.status(401).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders && res.flushHeaders();
    const role = String(req.query.role || '');
    if (role === 'host') {
      const id = String(req.query.host_id || who.identity);
      const prev = hosts.get(id); if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
      const caps = { video: true, audio: req.query.audio === '1', control: req.query.control === '1' };
      hosts.set(id, { res, name: String(req.query.name || id), identity: who.identity, device_id: who.device_id || null, caps, since: Date.now() });
      res.write(`data: ${JSON.stringify({ type: 'ready', host_id: id })}\n\n`);
      ctx.emit({ surface: 'assistant-native', event_type: 'control', session_id: `rd:host:${id}`, identity: who.identity, payload: { action: 'host-online', host_id: id } });
      req.on('close', () => { if (hosts.get(id) && hosts.get(id).res === res) hosts.delete(id); });
    } else {
      const id = String(req.query.client_id || who.identity);
      const prev = viewers.get(id); if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
      viewers.set(id, { res, identity: who.identity, device_id: who.device_id || null, since: Date.now() });
      res.write(`data: ${JSON.stringify({ type: 'ready', client_id: id })}\n\n`);
      req.on('close', () => { if (viewers.get(id) && viewers.get(id).res === res) viewers.delete(id); });
    }
  });

  // All signaling messages. SDP/ICE are relayed VERBATIM between the two peers of a session only.
  app.post('/rd/msg', async (req, res) => {
    const b = req.body || {};
    const who = await auth(b.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid token' });
    const type = String(b.type || '');
    try {
      if (type === 'list') {
        // Filtered per host: a caller sees exactly the machines they hold a view grant on, so an
        // unauthorized machine is not merely un-connectable, it is invisible.
        const out = [];
        for (const [id, h] of hosts.entries()) {
          const g = await grantsFor(who, h.device_id || id);
          if (!g.view) continue;
          out.push({ host_id: id, name: h.name, caps: h.caps, online: true, can_control: g.control });
        }
        return res.json({ ok: true, hosts: out });
      }
      if (type === 'connect') {
        const hostId = String(b.host_id || '');
        const host = hosts.get(hostId);
        if (!host) return res.status(404).json({ ok: false, error: 'host offline' });
        const g = await grantsFor(who, host.device_id || hostId);
        if (!g.view) return res.status(403).json({ ok: false, error: `no view grant for ${host.name || hostId} (default-deny)` });
        const wantControl = !!(b.want && b.want.control);
        if (wantControl && !g.control) return res.status(403).json({ ok: false, error: `no control grant for ${host.name || hostId} (view-only)` });
        const sessionId = crypto.randomBytes(9).toString('base64url');
        const clientId = String(b.client_id || who.identity);
        sessions.set(sessionId, { host_id: hostId, client_id: clientId, control: wantControl && g.control, identity: who.identity, device_id: who.device_id || null, since: Date.now() });
        // Ask the host to make an offer for this session (control flag stamped by the broker → agent re-checks it).
        push(hosts, hostId, { type: 'offer_request', session_id: sessionId, control: wantControl && g.control });
        openSession(sessionId, host.device_id || hostId, who, wantControl && g.control ? 'control' : 'view');
        ctx.emit({ surface: 'assistant-native', event_type: 'control', session_id: `rd:sess:${sessionId}`, identity: who.identity, payload: { action: 'session-open', host_id: hostId, control: wantControl && g.control } });
        return res.json({ ok: true, session_id: sessionId, control: wantControl && g.control });
      }
      if (type === 'sdp' || type === 'ice') {
        const s = sessions.get(String(b.session_id || ''));
        if (!s) return res.status(404).json({ ok: false, error: 'unknown session' });
        // Relay to the OTHER peer of this session only. Direction is decided by the sender's declared
        // `role` ('host' | 'viewer') — NOT by trust identity, because a host agent and the owner's phone
        // legitimately share ONE identity ('owner'), which made identity-based direction misroute. role is
        // authoritative; it can't escalate anything (both peers are inside one already-authorized session).
        const role = String(b.role || '');
        let target = null; // 'viewer' | 'host'  (the OTHER peer)
        if (role === 'host') target = 'viewer';
        else if (role === 'viewer') target = 'host';
        else {
          // Fallback for a role-less sender: infer only when identities are unambiguous.
          const hostIdent = hosts.get(s.host_id) && hosts.get(s.host_id).identity;
          const viewerIdent = viewers.get(s.client_id) && viewers.get(s.client_id).identity;
          if (hostIdent && viewerIdent && hostIdent !== viewerIdent) {
            target = who.identity === hostIdent ? 'viewer' : 'host';
          } else {
            return res.status(400).json({ ok: false, error: "sdp/ice requires role: 'host' | 'viewer'" });
          }
        }
        const frame = { type, session_id: b.session_id, sdp: b.sdp, candidate: b.candidate };
        const delivered = target === 'viewer' ? push(viewers, s.client_id, frame) : push(hosts, s.host_id, frame);
        return res.json({ ok: delivered });
      }
      if (type === 'bye') {
        const s = sessions.get(String(b.session_id || ''));
        if (s) {
          push(hosts, s.host_id, { type: 'bye', session_id: b.session_id });
          push(viewers, s.client_id, { type: 'bye', session_id: b.session_id });
          sessions.delete(String(b.session_id));
          closeSession(String(b.session_id), 'closed');
          ctx.emit({ surface: 'assistant-native', event_type: 'control', session_id: `rd:sess:${b.session_id}`, identity: who.identity, payload: { action: 'session-close' } });
        }
        return res.json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: `unknown message type: ${type}` });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- cast-to-device: project a registered host onto a target android device --------------------------
  // "Open host X's live stream on my phone." The broker doesn't hold the phone's SSE (the android
  // connector does), so it calls that connector's internal /out push with a new `open-remote-desktop`
  // kind; the app navigates to its RD viewer for host_id. Trust-gated to FULL TRUST (the control grant):
  // pushing a stream onto someone's device — and optionally handing it input control — is a control-tier
  // action, so a view-only principal cannot cast. device omitted / '*' → every connected device of the
  // caller. control is additionally clamped by the caller's own control grant (defense in depth; the
  // viewer's later `connect` is STILL re-checked against the phone token's grants by the broker).
  app.post('/rd/cast', async (req, res) => {
    const b = req.body || {};
    const who = await auth(b.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid token' });
    // Casting projects a machine's screen onto someone's device, so it is gated on CONTROL of that
    // machine — not on a global trust tier.
    const castHost = hosts.get(String(b.host_id || ''));
    const g = await grantsFor(who, (castHost && castHost.device_id) || String(b.host_id || ''));
    if (!g.control) return res.status(403).json({ ok: false, error: 'cast requires a control grant on that machine' });
    const hostId = String(b.host_id || '');
    if (!hostId) return res.status(400).json({ ok: false, error: 'host_id required' });
    const control = !!b.control && g.control;
    const device = String(b.device || '').trim(); // '' → the android connector broadcasts to all connected devices
    try {
      const r = await fetch(ANDROID_GW + '/out', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'open-remote-desktop', target: device, host_id: hostId, control }),
      });
      const j = await r.json().catch(() => ({}));
      ctx.emit({ surface: 'assistant-native', event_type: 'control', session_id: `rd:cast:${hostId}`, identity: who.identity, payload: { action: 'cast', host_id: hostId, device: device || '*', control, delivered: (j && j.delivered) || 0 } });
      if (!r.ok || j.ok === false) return res.status(502).json({ ok: false, error: (j && j.error) || `android gateway ${r.status}`, delivered: (j && j.delivered) || 0 });
      return res.json({ ok: true, delivered: j.delivered || 0, host_id: hostId, control });
    } catch (e) { return res.status(502).json({ ok: false, error: 'android gateway unreachable: ' + e.message }); }
  });

  // Which android devices can we cast to? Proxy the android gateway's device list (view-gated) so the
  // dashboard can offer a target picker; empty/'*' in /rd/cast still broadcasts to all connected devices.
  app.get('/rd/devices', async (req, res) => {
    const who = await auth(req.query.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid token' });
    const g = await legacyGrants(who.identity); // the target-device picker, not a per-machine decision
    if (!g.view) return res.json({ ok: true, devices: [], can_cast: false });
    try {
      const r = await fetch(ANDROID_GW + '/gw/devices');
      const j = await r.json().catch(() => ({}));
      // Merge chat + background-control links, dedupe by id, keep a friendly name.
      const seen = new Map();
      for (const d of [...(j.devices || []), ...(j.control || [])]) if (d && d.id && !seen.has(d.id)) seen.set(d.id, { id: d.id, name: d.name || d.id });
      res.json({ ok: true, devices: [...seen.values()], can_cast: g.control });
    } catch (e) { res.json({ ok: true, devices: [], can_cast: g.control, error: e.message }); }
  });

  // --- enrollment: a machine claims its own credential ------------------------------------------
  // The ONLY /rd route reachable without a device credential — necessarily, since the caller does
  // not have one yet. Core is the authority: it consumes the single-use code and mints the token.
  // The agent talks only to the broker (core is not publicly reachable), so this proxies.
  // The code carries 192 bits of entropy, so guessing is not the threat; a bad actor hammering this
  // endpoint is, hence the small per-IP throttle.
  const enrollHits = new Map(); // ip → { n, resetAt }
  function enrollThrottled(ip) {
    const t = enrollHits.get(ip);
    if (!t || t.resetAt < Date.now()) { enrollHits.set(ip, { n: 1, resetAt: Date.now() + 60000 }); return false; }
    t.n += 1;
    return t.n > 10;
  }
  app.post('/rd/enroll', async (req, res) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (enrollThrottled(ip)) return res.status(429).json({ ok: false, error: 'too many enrollment attempts; wait a minute' });
    const code = String((req.body || {}).code || '');
    if (!code) return res.status(400).json({ ok: false, error: 'code required' });
    try {
      const r = await ctx.core._post('/v2/devices/redeem', { code });
      ctx.emit({ surface: 'assistant-native', event_type: 'control', session_id: `rd:enroll:${r.device_id}`, identity: r.device_id, payload: { action: 'device-enrolled', device_id: r.device_id, transport: r.transport } });
      ctx.log(`device enrolled: ${r.name || r.device_id} (${r.transport})`);
      return res.json({ ok: true, token: r.token, device_id: r.device_id, name: r.name, transport: r.transport });
    } catch (e) {
      // Invalid and expired are deliberately indistinguishable to the caller.
      ctx.log(`enrollment refused from ${ip}: ${e.message}`);
      return res.status(400).json({ ok: false, error: 'invalid or expired enrollment code' });
    }
  });

  // Revocation must not wait out the auth cache TTL. Core pokes this the moment a device (or one of
  // its transports) is revoked; we drop the cached decision and tear down anything that peer holds.
  app.post('/rd/invalidate', (req, res) => {
    const b = req.body || {};
    const deviceId = String(b.device_id || '');
    const killSid = String(b.session_id || '');
    if (b.token) authCache.delete(String(b.token));
    if (killSid) {
      const sess = sessions.get(killSid);
      if (sess) {
        push(hosts, sess.host_id, { type: 'bye', session_id: killSid, reason: 'killed' });
        push(viewers, sess.client_id, { type: 'bye', session_id: killSid, reason: 'killed' });
        sessions.delete(killSid);
      }
      return res.json({ ok: true, sessions_killed: sess ? 1 : 0 });
    }
    let cleared = 0;
    for (const [tok, v] of authCache.entries()) {
      if (!deviceId || (v.who && v.who.device_id === deviceId)) { authCache.delete(tok); cleared++; }
    }
    // Drop live sessions belonging to that device, both peers told why.
    let killed = 0;
    for (const [sid, sess] of [...sessions.entries()]) {
      const h = hosts.get(sess.host_id);
      if (deviceId && !(h && h.device_id === deviceId) && sess.device_id !== deviceId) continue;
      push(hosts, sess.host_id, { type: 'bye', session_id: sid, reason: 'revoked' });
      push(viewers, sess.client_id, { type: 'bye', session_id: sid, reason: 'revoked' });
      sessions.delete(sid); killed++;
    }
    if (deviceId) { const h = hosts.get(deviceId); if (h) { try { h.res.end(); } catch (_) {} hosts.delete(deviceId); } }
    ctx.emit({ surface: 'assistant-native', event_type: 'control', session_id: `rd:revoke:${deviceId || 'token'}`, identity: 'core', payload: { action: 'invalidate', device_id: deviceId || null, cache_cleared: cleared, sessions_killed: killed } });
    res.json({ ok: true, cache_cleared: cleared, sessions_killed: killed });
  });

  app.get('/rd/health', (_req, res) => res.json({ ok: true, hosts: hosts.size, viewers: viewers.size, sessions: sessions.size }));

  const server = app.listen(PORT, BIND, () => ctx.log(`remote-desktop signaling broker on ${BIND}:${PORT}`));
  return { async stop() { try { server.close(); } catch (_) {} } };
}

module.exports = { meta, start };
