'use strict';
/*
 * asmltr mobile assistant — voice + keyboard client for the `android` connector.
 * Overlay mode (?overlay=1): a floating glass card — draggable, minimizable, continuous-listening.
 * Surface (one device token): GET /gw/stream (SSE), POST /gw/turn, /gw/transcribe, /gw/tts; GET /gw/theme.
 */
const CFG_KEY = 'asmltr.mobile.cfg';
const $ = (id) => document.getElementById(id);
const OVERLAY = /(?:^|[?&#])overlay(?:=1)?(?:$|[&#])/.test(location.search + location.hash);

function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (_) {}
  const d = window.ASMLTR_DEFAULTS || {};
  const nc = window.__ASMLTR_NATIVE_CFG || {};
  c.baseUrl = (c.baseUrl || nc.baseUrl || d.baseUrl || '').replace(/\/+$/, '');
  c.token = c.token || nc.token || d.token || '';
  c.name = c.name || nc.name || d.agentName || 'My device';
  c.agentName = c.agentName || nc.agentName || d.agentName || 'assistant';
  if (!c.deviceId) c.deviceId = 'dev-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  return c;
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

let cfg = loadCfg();
let es = null, reconnectT = null, listening = false, busy = false, recorder = null, chunks = [], stream = null;
let curBubble = null, stepsEl = null;
let drone = null, vadRAF = 0, vadCtx = null;
let continuous = OVERLAY; // overlay is a hands-free conversation by default

// ---------- branding ----------
function toRGB(hex) { const m = String(hex).match(/#?([0-9a-fA-F]{6})/); if (!m) return null; const n = parseInt(m[1], 16); return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`; }
async function applyTheme() {
  try {
    const r = await fetch(cfg.baseUrl + '/gw/theme'); const j = await r.json();
    if (j.agentName) { cfg.agentName = j.agentName; $('agentName').textContent = j.agentName; }
    const hexes = String(j.palette || '').match(/#[0-9a-fA-F]{6}/g) || [];
    const a = hexes[0] && toRGB(hexes[0]), b = (hexes[1] && toRGB(hexes[1])) || a;
    if (a) { document.documentElement.style.setProperty('--accent', a); document.documentElement.style.setProperty('--accent2', b); }
  } catch (_) {}
}

// ---------- UI ----------
function setStatus(s, cls) { const el = $('status'); if (el) { el.textContent = s; el.className = 'pill ' + cls; } }
function bubble(role, text) {
  const el = document.createElement('div'); el.className = 'msg-row ' + role;
  el.innerHTML = '<div class="bubble"></div>'; el.querySelector('.bubble').textContent = text || '';
  $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight; return el.querySelector('.bubble');
}
function ensureSteps() { if (stepsEl) return stepsEl; const el = document.createElement('div'); el.className = 'steps'; $('log').appendChild(el); stepsEl = el; return el; }
function addStep(kind, text) {
  const s = ensureSteps(); const d = document.createElement('div'); d.className = 'step step-' + kind;
  d.textContent = (kind === 'tool' ? '🔧 ' : '💭 ') + text; s.appendChild(d); $('log').scrollTop = $('log').scrollHeight;
}
function setTalk(state) {
  listening = state === 'rec'; busy = state === 'busy';
  const t = $('talk'); if (t) t.className = 'talk' + (state === 'rec' ? ' rec' : state === 'busy' ? ' busy' : '');
  const l = $('talkLabel'); if (l) l.textContent = state === 'rec' ? 'Listening…' : state === 'busy' ? 'Thinking…' : (continuous ? 'Tap to talk · hands-free on' : 'Tap to talk');
}

// ---------- SSE ----------
function connect() {
  if (!cfg.baseUrl || !cfg.token) { openSheet('Paste your device token to connect.'); return; }
  if (es) { es.close(); es = null; }
  setStatus('connecting…', 'pill-warn');
  const url = `${cfg.baseUrl}/gw/stream?token=${encodeURIComponent(cfg.token)}&device=${encodeURIComponent(cfg.deviceId)}&name=${encodeURIComponent(cfg.name)}`;
  es = new EventSource(url);
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === 'ready') { setStatus('connected', 'pill-on'); maybeAssistLaunch(); }
    else if (m.type === 'thinking') addStep('think', m.text);
    else if (m.type === 'tool') addStep('tool', m.name);
    else if (m.type === 'delta') { stopDrone(); if (!curBubble) curBubble = bubble('assistant', ''); curBubble.textContent += m.text; $('log').scrollTop = $('log').scrollHeight; }
    else if (m.type === 'done') { stopDrone(); const full = curBubble ? curBubble.textContent : ''; curBubble = null; stepsEl = null; setTalk('idle'); if (full.trim()) speak(full).then(afterReply); else afterReply(); }
    else if (m.type === 'inject') { stepsEl = null; bubble('assistant', m.text); if (m.text && m.text.trim()) speak(m.text); }
    else if (m.type === 'error') { stopDrone(); bubble('sys', '⚠ ' + m.error); setTalk('idle'); }
  };
  es.onerror = () => { setStatus('reconnecting…', 'pill-warn'); if (es) { es.close(); es = null; } clearTimeout(reconnectT); reconnectT = setTimeout(connect, 2500); };
}
// After a reply finishes being read aloud: in hands-free mode, re-open the mic for a back-and-forth.
function afterReply() { if (continuous && !listening && !busy) setTimeout(() => { if (continuous && !listening && !busy) startRec(); }, 350); }

// ---------- turn ----------
async function api(path, body) {
  const r = await fetch(cfg.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cfg.token, device: cfg.deviceId, name: cfg.name, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function sendTurn(text) {
  bubble('user', text); setTalk('busy');
  chime(); startDrone(); ack();
  try { await api('/gw/turn', { text }); }
  catch (e) { stopDrone(); bubble('sys', '⚠ ' + e.message); setTalk('idle'); }
}

// ---------- audio ----------
function playClip(src, vol) { return new Promise((res) => { try { const a = new Audio(src); a.volume = vol == null ? 1 : vol; a.onended = a.onerror = () => res(); a.play().catch(() => res()); } catch (_) { res(); } }); }
function chime() { playClip('assets/chime.ogg', 0.8); }
function startDrone() { try { if (!drone) { drone = new Audio('assets/drone.ogg'); drone.loop = true; drone.volume = 0.45; } drone.currentTime = 0; drone.play().catch(() => {}); } catch (_) {} }
function stopDrone() { try { if (drone) drone.pause(); } catch (_) {} }
const ACKS = ['On it.', 'One moment.', 'Let me look.', 'Sure — checking.'];
async function ack() { try { const t = ACKS[Math.floor(Date.now() / 500) % ACKS.length]; const { b64, mime } = await api('/gw/tts', { text: t }); await playClip('data:' + (mime || 'audio/mpeg') + ';base64,' + b64, 0.9); } catch (_) {} }
async function speak(text) { try { const { b64, mime } = await api('/gw/tts', { text }); await playClip('data:' + (mime || 'audio/mpeg') + ';base64,' + b64); } catch (_) {} }

// ---------- record + VAD ----------
async function startRec() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = []; recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onRecStop; recorder.start(); setTalk('rec'); startVAD(stream);
  } catch (e) { bubble('sys', '⚠ mic: ' + e.message); setTalk('idle'); }
}
function stopRec() { stopVAD(); try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {} }
async function onRecStop() {
  stopVAD(); try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
  if (blob.size < 1200) { setTalk('idle'); return; } // nothing captured
  setTalk('busy');
  try {
    const b64 = await blobB64(blob);
    const { text } = await api('/gw/transcribe', { audio_base64: b64, mime: (recorder && recorder.mimeType) || 'audio/webm' });
    if (text && text.trim()) await sendTurn(text.trim()); else setTalk('idle');
  } catch (e) { bubble('sys', '⚠ ' + e.message); setTalk('idle'); }
}
// Calibrated VAD: measure the noise floor for ~350ms, then require speech above (floor + margin); once
// speech is detected, auto-stop after ~900ms of silence. Bails after 8s if nothing is ever said.
function startVAD(mediaStream) {
  try {
    vadCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = vadCtx.createMediaStreamSource(mediaStream);
    const an = vadCtx.createAnalyser(); an.fftSize = 1024; src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const t0 = Date.now(); let floor = 0.01, floorSamples = 0, spoke = false, quietSince = 0;
    const rms = () => { an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; } return Math.sqrt(s / buf.length); };
    const tick = () => {
      const level = rms(); const now = Date.now(); const dt = now - t0;
      if (dt < 350) { floor = (floor * floorSamples + level) / (floorSamples + 1); floorSamples++; vadRAF = requestAnimationFrame(tick); return; }
      const speaking = level > Math.max(0.03, floor * 2.2 + 0.012);
      if (speaking) { spoke = true; quietSince = 0; }
      else if (spoke) { if (!quietSince) quietSince = now; else if (now - quietSince > 900) { stopRec(); return; } }
      else if (dt > 8000) { stopRec(); return; }
      vadRAF = requestAnimationFrame(tick);
    };
    vadRAF = requestAnimationFrame(tick);
  } catch (_) {}
}
function stopVAD() { if (vadRAF) cancelAnimationFrame(vadRAF); vadRAF = 0; try { if (vadCtx) { vadCtx.close(); vadCtx = null; } } catch (_) {} }
function blobB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); }); }

// ---------- assist launch + native hooks ----------
function maybeAssistLaunch() {
  const assisted = OVERLAY || location.hash.indexOf('assist') >= 0 || window.__ASMLTR_ASSIST === true;
  if (assisted && !listening) { window.__ASMLTR_ASSIST = false; setTimeout(() => { if (!listening) startRec(); }, 250); }
}
window.asmltrStartListening = () => { if (!listening) startRec(); };

// ---------- overlay chrome: drag + minimize ----------
function initOverlayChrome() {
  const card = $('card'), handle = $('grip'); if (!card || !handle) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  const pos = { x: 0, y: 0 };
  const down = (e) => { dragging = true; const p = e.touches ? e.touches[0] : e; sx = p.clientX; sy = p.clientY; ox = pos.x; oy = pos.y; };
  const move = (e) => { if (!dragging) return; const p = e.touches ? e.touches[0] : e; pos.x = ox + (p.clientX - sx); pos.y = oy + (p.clientY - sy); card.style.transform = `translate(calc(-50% + ${pos.x}px), ${pos.y}px)`; e.preventDefault(); };
  const up = () => { dragging = false; };
  handle.addEventListener('mousedown', down); handle.addEventListener('touchstart', down, { passive: true });
  window.addEventListener('mousemove', move); window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
  $('min').addEventListener('click', () => { document.body.classList.add('minimized'); if (listening) stopRec(); });
  $('bubble').addEventListener('click', () => { document.body.classList.remove('minimized'); if (continuous && !listening && !busy) startRec(); });
}

// ---------- settings ----------
function openSheet(msg) { $('cfgUrl').value = cfg.baseUrl; $('cfgToken').value = cfg.token; $('cfgName').value = cfg.name; $('cfgDevice').value = cfg.deviceId; $('cfgMsg').textContent = msg || ''; $('sheet').classList.remove('hidden'); }
function closeSheet() { $('sheet').classList.add('hidden'); }
async function testConn() {
  const base = $('cfgUrl').value.trim().replace(/\/+$/, ''); $('cfgMsg').textContent = 'testing…';
  try { const r = await fetch(base + '/health'); const j = await r.json(); $('cfgMsg').textContent = j.status === 'ok' ? '✓ reachable' : 'unexpected response'; }
  catch (e) { $('cfgMsg').textContent = '✗ ' + e.message; }
}

// ---------- wire up ----------
function init() {
  if (OVERLAY) { document.body.classList.add('overlay'); initOverlayChrome(); }
  $('agentName').textContent = cfg.agentName || 'assistant';
  $('talk').addEventListener('click', () => { if (listening) stopRec(); else startRec(); });
  $('settingsBtn').addEventListener('click', () => openSheet());
  $('cfgTest').addEventListener('click', testConn);
  $('cfgSave').addEventListener('click', () => {
    cfg.baseUrl = $('cfgUrl').value.trim().replace(/\/+$/, ''); cfg.token = $('cfgToken').value.trim(); cfg.name = $('cfgName').value.trim() || 'My device';
    saveCfg(cfg);
    try { if (window.AsmltrNative && window.AsmltrNative.saveConfig) window.AsmltrNative.saveConfig(cfg.baseUrl, cfg.token, cfg.name); } catch (_) {}
    closeSheet(); applyTheme(); connect();
  });
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  const send = () => { const v = $('kbd').value.trim(); if (!v) return; $('kbd').value = ''; sendTurn(v); };
  $('kbdSend').addEventListener('click', send);
  $('kbd').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  applyTheme(); connect();
}
document.addEventListener('DOMContentLoaded', init);
