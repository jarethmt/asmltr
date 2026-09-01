'use strict';
/*
 * asmltr mobile — Remote Desktop VIEWER + CONTROLLER for the custom WebRTC remote-desktop capability
 * (see docs/REMOTE-DESKTOP.md + integrations/types/remote-desktop/index.js — the signaling broker).
 *
 * This is a self-contained surface: discover hosts through the broker, open a session, hold the broker
 * SSE stream, relay SDP/ICE through POST /rd/msg so ICE can hole-punch a DIRECT peer-to-peer media path,
 * render the host's video full-screen, and — when the session carries a control grant — map touch→mouse
 * and an on-screen keyboard→keystrokes over a WebRTC `control` data channel.
 *
 * Wire protocol (broker is the rendezvous, NEVER the media path):
 *   viewer holds  GET  /rd/stream?token=&role=viewer&client_id=   (SSE: ready / sdp / ice / bye)
 *   viewer POSTs  POST /rd/msg { token, type, ... }               (list / connect / sdp / ice / bye)
 *   viewer GETs   GET  /rd/ice-config?token=                      (STUN urls + optional TURN creds)
 *
 * Signaling roles: the broker asks the HOST to make the offer (offer_request). So the VIEWER is the
 * ANSWERER — it waits for the host's SDP offer on the SSE stream, answers, and both trickle ICE.
 *
 * SIGNALING, ICE, THE PEER CONNECTION AND THE CONTROL CHANNEL ARE NOT IMPLEMENTED HERE. They live in
 * shared/rtc/viewer.js (vendored to www/shared/ at build time) and are shared byte-for-byte with the
 * web console — including the pre-negotiated control channel and the generation-token lifecycle that
 * stops an abandoned session resurrecting itself. This file owns the SURFACE: host list, stage, the
 * touch→mouse gesture layer and the soft keyboard.
 */
const RD_CFG_KEY = 'asmltr.rd.cfg';
const MAIN_CFG_KEY = 'asmltr.mobile.cfg';
const $ = (id) => document.getElementById(id);

// ---------- config (device-local, persisted like the assistant's settings) ----------
function loadMainCfg() { try { return JSON.parse(localStorage.getItem(MAIN_CFG_KEY)) || {}; } catch (_) { return {}; } }
function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(RD_CFG_KEY)) || {}; } catch (_) {}
  const main = loadMainCfg();
  const d = window.ASMLTR_DEFAULTS || {};
  // Broker is a SEPARATE service (the remote-desktop connector, default :3028 /rd/*), so it has its own
  // URL. Token defaults to the device token (same keys.json trust identity convention), overridable.
  c.brokerUrl = (c.brokerUrl || d.rdBrokerUrl || '').replace(/\/+$/, '');
  c.token = c.token || main.token || d.token || '';
  if (!c.clientId) c.clientId = 'rdc-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  return c;
}
function saveCfg(c) { try { localStorage.setItem(RD_CFG_KEY, JSON.stringify(c)); } catch (_) {} }
let cfg = loadCfg();

// ---------- broker access + live session ----------
// The viewer module is vendored into www/shared/ at build time from the repo's shared/ tree, so the
// phone and the web console run byte-identical connection logic.
import { createViewer } from './shared/rtc-viewer.js';
window.AsmltrViewerFactory = createViewer;

let viewer = null;        // the shared viewer instance for the live session, else null
let sess = null;          // { id, control, host } — UI/gesture state mirrored from the viewer

// Host discovery still goes through a viewer instance (it owns the broker's auth + wire format).
async function rdMsg(body) {
  if (!cfg.brokerUrl) throw new Error('set the broker URL in settings');
  const probe = createViewer({ brokerUrl: cfg.brokerUrl, token: cfg.token, clientId: cfg.clientId });
  if (body && body.type === 'list') return { hosts: await probe.list() };
  throw new Error('unsupported broker call: ' + (body && body.type));
}

// ---------- host discovery ----------
async function refreshHosts() {
  const listEl = $('rdHosts'); const msg = $('rdListMsg');
  if (!cfg.brokerUrl || !cfg.token) { openSettings('Set the broker URL and token to discover hosts.'); return; }
  if (msg) msg.textContent = 'discovering…';
  try {
    const r = await rdMsg({ type: 'list' });
    const hosts = r.hosts || [];
    listEl.innerHTML = '';
    if (!hosts.length) { if (msg) msg.textContent = 'No hosts online. Start a host agent, then refresh.'; return; }
    if (msg) msg.textContent = hosts.length + ' host' + (hosts.length === 1 ? '' : 's') + ' online';
    for (const h of hosts) listEl.appendChild(hostRow(h));
  } catch (e) { if (msg) msg.textContent = '✗ ' + e.message; }
}
function hostRow(h) {
  const row = document.createElement('div'); row.className = 'rd-host';
  const info = document.createElement('div'); info.className = 'rd-host-info';
  const nm = document.createElement('div'); nm.className = 'rd-host-name'; nm.textContent = h.name || h.host_id;
  const caps = document.createElement('div'); caps.className = 'rd-host-caps';
  const bits = ['video']; if (h.caps && h.caps.audio) bits.push('audio'); if (h.caps && h.caps.control) bits.push('control');
  caps.textContent = bits.join(' · '); info.appendChild(nm); info.appendChild(caps);
  const btns = document.createElement('div'); btns.className = 'rd-host-btns';
  const view = document.createElement('button'); view.className = 'secondary rd-btn'; view.textContent = 'View';
  view.addEventListener('click', () => connectHost(h, false));
  btns.appendChild(view);
  if (h.caps && h.caps.control) {
    const ctl = document.createElement('button'); ctl.className = 'primary rd-btn'; ctl.textContent = 'Control';
    ctl.addEventListener('click', () => connectHost(h, true));
    btns.appendChild(ctl);
  }
  row.appendChild(info); row.appendChild(btns);
  return row;
}

// ---------- session lifecycle (delegated to the shared viewer) ----------
// Signaling, ICE, the peer connection and the pre-negotiated control channel all live in
// shared/rtc/viewer.js — the SAME module the web console runs. They used to be duplicated here, and
// they had already drifted: the web copy listened for `ondatachannel`, which never fires for a
// pre-negotiated channel, so its control silently did nothing. One implementation, one behaviour.
function connectHost(host, wantControl) {
  teardown();
  showStage();
  $('rdStageName').textContent = host.name || host.host_id;
  setControlUI(false);
  setStatus('connecting…', 'warn');

  viewer = window.AsmltrViewerFactory({ brokerUrl: cfg.brokerUrl, token: cfg.token, clientId: cfg.clientId });
  viewer.on('status', (text, level) => setStatus(text, level));
  viewer.on('stream', (stream) => { const v = $('rdVideo'); if (v) { v.srcObject = stream; v.play().catch(() => {}); } });
  viewer.on('control', (on) => { if (sess) sess.control = on; setControlUI(on); });
  viewer.on('session', (s) => { sess = { id: s.id, control: s.control, host }; });
  viewer.on('ended', () => { sess = null; });
  viewer.connect(host.host_id, { control: !!wantControl }).catch(() => {});
}

// ---------- teardown (leak-proof) ----------
function teardown() {
  cancelMoveFlush();
  if (viewer) { try { viewer.disconnect(); } catch (_) {} viewer = null; }
  sess = null;
  const v = $('rdVideo'); if (v) { try { v.srcObject = null; } catch (_) {} }
  setControlUI(false);
  exitMinimize();
  hideKeyboard();
}
function disconnect() { setStatus('disconnected', 'off'); teardown(); showList(); refreshHosts(); }

// ==================== CONTROL LAYER (touch→mouse + soft keyboard) ====================
// Sent as JSON over the `control` data channel. Coordinates are normalized [0,1] fractions of the remote
// screen (absolute-scaled to the displayed video's content rect, letterboxing accounted for) so the host
// maps them to any resolution. Schema the host agent MUST match:
//   mouse: { t:'move'|'down'|'up'|'click'|'scroll', x, y, button, dx, dy }
//           - move/down/up/click carry x,y in [0,1]; button ∈ 'left'|'right'|'middle' (default 'left')
//           - scroll carries dx,dy wheel deltas (pixels; sign = direction), x,y optional
//   key:   { t:'key', code, down }  down=true (press) / false (release)
//           - code is a UI-Events code ('KeyA','Enter','Backspace','Space','Digit1',…) when known,
//             else the literal character; an optional `key` field carries the raw character.
function sendCtl(obj) {
  // The control channel belongs to the shared viewer now; it no-ops without a control grant, and
  // the host re-checks the grant regardless.
  if (viewer) viewer.sendInput(obj);
}
function haptic(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (_) {} }

function setControlUI(on) {
  const ctl = $('rdControl'); const kb = $('rdKbBtn');
  if (ctl) ctl.classList.toggle('active', !!on);          // control overlay only captures when granted
  if (kb) kb.classList.toggle('hidden', !on);
  const badge = $('rdCtlBadge'); if (badge) badge.classList.toggle('hidden', !on);
}

// Map a client point to normalized video-content coords (handles object-fit: contain letterboxing).
function mapXY(clientX, clientY) {
  const v = $('rdVideo'); const r = v.getBoundingClientRect();
  const vw = v.videoWidth || r.width, vh = v.videoHeight || r.height;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
  let x = (clientX - ox) / w, y = (clientY - oy) / h;
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
  return { x, y };
}

// Gesture recognition on the transparent control overlay via pointer events (touch now; mouse/D-pad later
// for a TV). One finger: quick tap = left click, drag = cursor move, long-press = right click. Two fingers:
// drag = scroll wheel, quick tap = right click.
const MOVE_THRESH = 8, TAP_MS = 350, LONGPRESS_MS = 550;
let ptrs = new Map();       // pointerId → { x, y, sx, sy, st }
let moved = false, lpTimer = 0, lpFired = false, twoFinger = false, scrolled = false, lastCentroid = null;
let pendingMove = null, moveRAF = 0;

function centroid() { let x = 0, y = 0, n = 0; for (const p of ptrs.values()) { x += p.x; y += p.y; n++; } return n ? { x: x / n, y: y / n } : null; }
function queueMove(m) {
  pendingMove = m;
  if (!moveRAF) moveRAF = requestAnimationFrame(() => { moveRAF = 0; if (pendingMove) { sendCtl({ t: 'move', x: pendingMove.x, y: pendingMove.y }); pendingMove = null; } });
}
function cancelMoveFlush() { if (moveRAF) { cancelAnimationFrame(moveRAF); moveRAF = 0; } pendingMove = null; ptrs.clear(); clearTimeout(lpTimer); moved = false; lpFired = false; twoFinger = false; scrolled = false; lastCentroid = null; }

function initControlGestures() {
  const el = $('rdControl'); if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    if (!(sess && sess.control)) return;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, st: Date.now() });
    if (ptrs.size === 1) {
      moved = false; lpFired = false; twoFinger = false; scrolled = false;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        if (ptrs.size === 1 && !moved) { lpFired = true; const p = [...ptrs.values()][0]; const m = mapXY(p.x, p.y); sendCtl({ t: 'click', button: 'right', x: m.x, y: m.y }); haptic(14); }
      }, LONGPRESS_MS);
    } else if (ptrs.size === 2) { clearTimeout(lpTimer); twoFinger = true; lastCentroid = centroid(); }
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size >= 2) {
      const c = centroid();
      if (c && lastCentroid) { const dx = c.x - lastCentroid.x, dy = c.y - lastCentroid.y; if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { scrolled = true; sendCtl({ t: 'scroll', dx: Math.round(dx), dy: Math.round(dy) }); } }
      lastCentroid = c;
    } else {
      if (!moved && Math.hypot(p.x - p.sx, p.y - p.sy) > MOVE_THRESH) { moved = true; clearTimeout(lpTimer); }
      if (moved) queueMove(mapXY(p.x, p.y));
    }
    e.preventDefault();
  });
  const onUp = (e) => {
    const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
    clearTimeout(lpTimer);
    if (p) {
      const dt = Date.now() - p.st, dist = Math.hypot(p.x - p.sx, p.y - p.sy);
      if (twoFinger) {
        if (ptrs.size === 0 && dt < TAP_MS && dist < MOVE_THRESH && !scrolled) { const m = mapXY(p.x, p.y); sendCtl({ t: 'click', button: 'right', x: m.x, y: m.y }); haptic(); }
      } else if (!lpFired && !moved && dt < TAP_MS && dist < MOVE_THRESH) {
        const m = mapXY(p.x, p.y); sendCtl({ t: 'click', button: 'left', x: m.x, y: m.y }); haptic();
      }
    }
    if (ptrs.size === 0) { moved = false; lpFired = false; twoFinger = false; scrolled = false; lastCentroid = null; }
    e.preventDefault();
  };
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

// ---------- on-screen keyboard ----------
// A hidden input pulls up the soft keyboard. Hardware/special keys ride keydown/keyup; typed characters
// come through `input` (soft keyboards report KeyCode 229 with an empty code, so we can't rely on
// keydown for letters) and are sent as a press+release pair each.
const SPECIAL_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
function charToCode(ch) {
  if (/[a-z]/i.test(ch)) return 'Key' + ch.toUpperCase();
  if (/[0-9]/.test(ch)) return 'Digit' + ch;
  if (ch === ' ') return 'Space';
  return ch; // punctuation / symbols → the literal character (host uses `key` for the exact glyph)
}
function showKeyboard() { const i = $('rdKbInput'); if (i) { i.classList.remove('hidden'); i.value = ''; try { i.focus(); } catch (_) {} } const b = $('rdKbBtn'); if (b) b.classList.add('on'); }
function hideKeyboard() { const i = $('rdKbInput'); if (i) { try { i.blur(); } catch (_) {} i.classList.add('hidden'); i.value = ''; } const b = $('rdKbBtn'); if (b) b.classList.remove('on'); }
function toggleKeyboard() { const i = $('rdKbInput'); if (i && i.classList.contains('hidden')) showKeyboard(); else hideKeyboard(); }
function initKeyboard() {
  const i = $('rdKbInput'); if (!i) return;
  i.addEventListener('keydown', (e) => {
    if (SPECIAL_KEYS.includes(e.key)) {
      sendCtl({ t: 'key', code: e.code || e.key, key: e.key, down: true });
      sendCtl({ t: 'key', code: e.code || e.key, key: e.key, down: false });
      e.preventDefault();
    }
  });
  i.addEventListener('input', (e) => {
    const data = e.data;
    if (data) { for (const ch of data) { const code = charToCode(ch); sendCtl({ t: 'key', code, key: ch, down: true }); sendCtl({ t: 'key', code, key: ch, down: false }); } }
    i.value = ''; // keep the field empty — we've already emitted the keystrokes
  });
}

// ---------- minimize / picture-in-picture ----------
function toggleMinimize() { const st = $('rdStage'); if (!st) return; if (st.classList.contains('min')) exitMinimize(); else enterMinimize(); }
function enterMinimize() { const st = $('rdStage'); if (st) st.classList.add('min'); }
function exitMinimize() { const st = $('rdStage'); if (st) st.classList.remove('min'); }
async function togglePip() {
  const v = $('rdVideo'); if (!v) return;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (v.requestPictureInPicture) await v.requestPictureInPicture();
  } catch (_) {}
}
function toggleAudio() { const v = $('rdVideo'); if (!v) return; v.muted = !v.muted; const b = $('rdMuteBtn'); if (b) b.classList.toggle('on', v.muted); }

// ---------- settings sheet ----------
function openSettings(msg) {
  $('rdCfgUrl').value = cfg.brokerUrl || '';
  $('rdCfgToken').value = cfg.token || '';
  $('rdCfgClient').value = cfg.clientId || '';
  $('rdCfgMsg').textContent = msg || '';
  $('rdSheet').classList.remove('hidden');
}
function closeSettings() { $('rdSheet').classList.add('hidden'); }
function saveSettings() {
  cfg.brokerUrl = $('rdCfgUrl').value.trim().replace(/\/+$/, '');
  cfg.token = $('rdCfgToken').value.trim();
  saveCfg(cfg);
  closeSettings(); refreshHosts();
}
async function testBroker() {
  const base = $('rdCfgUrl').value.trim().replace(/\/+$/, '');
  $('rdCfgMsg').textContent = 'testing…';
  try { const r = await fetch(base + '/rd/health'); const j = await r.json(); $('rdCfgMsg').textContent = j && j.ok ? ('✓ reachable — ' + (j.hosts || 0) + ' hosts online') : 'unexpected response'; }
  catch (e) { $('rdCfgMsg').textContent = '✗ ' + e.message; }
}

// ---------- cast-to-device auto-open ----------
// Opened via remote-desktop.html?host=<id>&control=<0|1> — a trusted caster pushed an
// open-remote-desktop directive (the dashboard's "Cast to my phone" / the assistant) and app.js
// navigated here. Auto-connect straight to that host instead of waiting for a tap. Falls back to a
// synthetic host entry if the broker's list doesn't (yet) include it, so a just-registered host still opens.
async function maybeAutoOpen() {
  let params; try { params = new URLSearchParams(location.search); } catch (_) { return; }
  const host = params.get('host'); if (!host) return;
  const wantControl = params.get('control') === '1';
  if (!cfg.brokerUrl || !cfg.token) { openSettings('A host was cast to this device — set the broker URL and token to open it.'); return; }
  setStatus('opening cast…', 'warn');
  try {
    const r = await rdMsg({ type: 'list' });
    const found = (r.hosts || []).find((h) => h.host_id === host)
      || { host_id: host, name: host, caps: { video: true, control: wantControl } };
    connectHost(found, wantControl && !!(found.caps && found.caps.control));
  } catch (e) { setStatus('✗ ' + e.message, 'off'); }
}

// ---------- back / leave ----------
function goBack() {
  if (!$('rdStage').classList.contains('hidden')) { disconnect(); return; }  // in a session → drop it, show list
  try { history.length > 1 ? history.back() : (location.href = 'index.html'); } catch (_) { location.href = 'index.html'; }
}

// ---------- wire up ----------
function init() {
  showList();
  setStatus('offline', 'off');
  $('rdRefresh').addEventListener('click', refreshHosts);
  $('rdSettingsBtn').addEventListener('click', () => openSettings());
  $('rdBack').addEventListener('click', goBack);
  $('rdDisconnect').addEventListener('click', disconnect);
  $('rdMinBtn').addEventListener('click', toggleMinimize);
  $('rdPipBtn').addEventListener('click', togglePip);
  $('rdMuteBtn').addEventListener('click', toggleAudio);
  $('rdKbBtn').addEventListener('click', toggleKeyboard);
  $('rdStage').addEventListener('dblclick', () => { if ($('rdStage').classList.contains('min')) exitMinimize(); });
  // tapping a minimized tile restores it (mousedown so it beats the control overlay)
  $('rdStage').addEventListener('click', () => { if ($('rdStage').classList.contains('min')) exitMinimize(); });
  $('rdCfgSave').addEventListener('click', saveSettings);
  $('rdCfgTest').addEventListener('click', testBroker);
  $('rdCfgClose').addEventListener('click', closeSettings);
  $('rdSheet').addEventListener('click', (e) => { if (e.target === $('rdSheet')) closeSettings(); });
  initControlGestures();
  initKeyboard();
  // hardware-back / navigating away must not leak the peer + SSE
  window.addEventListener('pagehide', () => { try { teardown(); } catch (_) {} });
  window.addEventListener('beforeunload', () => { try { teardown(); } catch (_) {} });
  refreshHosts();
  maybeAutoOpen(); // cast-to-device: ?host=<id>&control=<0|1> auto-connects straight to that host
}
document.addEventListener('DOMContentLoaded', init);
