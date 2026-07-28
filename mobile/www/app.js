'use strict';
/*
 * asmltr mobile assistant — voice + keyboard client for the `android` connector.
 * Surface (one device token): GET /gw/stream (SSE: ready|delta|thinking|tool|done|inject|error),
 * POST /gw/turn, /gw/transcribe, /gw/tts; GET /gw/theme (branding). Framework-free → bundles as-is.
 */
const CFG_KEY = 'asmltr.mobile.cfg';
const $ = (id) => document.getElementById(id);
const OVERLAY = /(?:^|[?&#])overlay(?:=1)?(?:$|[&#])/.test(location.search + location.hash);

function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (_) {}
  const d = window.ASMLTR_DEFAULTS || {};
  const nc = window.__ASMLTR_NATIVE_CFG || {}; // injected by the native overlay session (SharedPreferences)
  c.baseUrl = (c.baseUrl || nc.baseUrl || d.baseUrl || '').replace(/\/+$/, '');
  c.token = c.token || nc.token || d.token || '';
  c.name = c.name || nc.name || d.agentName || 'My device';
  c.agentName = c.agentName || nc.agentName || d.agentName || 'assistant';
  if (!c.deviceId) c.deviceId = 'dev-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  return c;
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

let cfg = loadCfg();
let es = null, reconnectT = null, listening = false, recorder = null, chunks = [], stream = null;
let curBubble = null, stepsEl = null;
const audioQ = []; let playing = false;
let drone = null, vadRAF = 0, vadCtx = null;

// ---------- branding (identity signature palette → CSS vars, like the web GUI) ----------
function toRGB(hex) {
  const m = String(hex).match(/#?([0-9a-fA-F]{6})/); if (!m) return null;
  const n = parseInt(m[1], 16); return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
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
function ensureSteps() {
  if (stepsEl) return stepsEl;
  const el = document.createElement('div'); el.className = 'steps'; $('log').appendChild(el);
  stepsEl = el; return el;
}
function addStep(kind, text) {
  const s = ensureSteps(); const d = document.createElement('div');
  d.className = 'step step-' + kind;
  d.textContent = (kind === 'tool' ? '🔧 ' : '💭 ') + text;
  s.appendChild(d); $('log').scrollTop = $('log').scrollHeight;
}
function setTalk(state) {
  listening = state === 'rec';
  const t = $('talk'); if (t) t.className = 'talk' + (state === 'rec' ? ' rec' : state === 'busy' ? ' busy' : '');
  const l = $('talkLabel'); if (l) l.textContent = state === 'rec' ? 'Listening…' : state === 'busy' ? 'Thinking…' : 'Tap to talk';
}

// ---------- SSE ----------
function connect() {
  if (!cfg.baseUrl) { openSheet('Set your server URL to connect.'); return; }
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
    else if (m.type === 'done') { stopDrone(); const full = curBubble ? curBubble.textContent : ''; curBubble = null; stepsEl = null; setTalk('idle'); if (full.trim()) speak(full); }
    else if (m.type === 'inject') { stepsEl = null; bubble('assistant', m.text); if (m.text && m.text.trim()) speak(m.text); }
    else if (m.type === 'error') { stopDrone(); bubble('sys', '⚠ ' + m.error); setTalk('idle'); }
  };
  es.onerror = () => { setStatus('reconnecting…', 'pill-warn'); if (es) { es.close(); es = null; } clearTimeout(reconnectT); reconnectT = setTimeout(connect, 2500); };
}

// ---------- turn ----------
async function api(path, body) {
  const r = await fetch(cfg.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cfg.token, device: cfg.deviceId, name: cfg.name, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function sendTurn(text) {
  bubble('user', text);
  setTalk('busy');
  chime(); startDrone(); ack();               // instant "received" cue + processing hum + spoken ack
  try { await api('/gw/turn', { text }); }     // reply streams over the SSE
  catch (e) { stopDrone(); bubble('sys', '⚠ ' + e.message); setTalk('idle'); }
}

// ---------- audio cues ----------
function chime() { try { new Audio('assets/chime.ogg').play().catch(() => {}); } catch (_) {} }
function startDrone() { try { if (!drone) { drone = new Audio('assets/drone.ogg'); drone.loop = true; drone.volume = 0.5; } drone.currentTime = 0; drone.play().catch(() => {}); } catch (_) {} }
function stopDrone() { try { if (drone) { drone.pause(); } } catch (_) {} }
const ACKS = ['On it.', 'One moment.', 'Let me look.', 'Sure — checking.'];
async function ack() { try { const t = ACKS[Math.floor(Date.now() / 500) % ACKS.length]; const { b64, mime } = await api('/gw/tts', { text: t }); const a = new Audio('data:' + (mime || 'audio/mpeg') + ';base64,' + b64); a.volume = 0.9; a.play().catch(() => {}); } catch (_) {} }

// ---------- record + VAD ----------
async function startRec() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onRecStop;
    recorder.start();
    setTalk('rec');
    startVAD(stream);
  } catch (e) { bubble('sys', '⚠ mic: ' + e.message); setTalk('idle'); }
}
function stopRec() { stopVAD(); try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {} }
async function onRecStop() {
  stopVAD();
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
  setTalk('busy');
  try {
    const b64 = await blobB64(blob);
    const { text } = await api('/gw/transcribe', { audio_base64: b64, mime: (recorder && recorder.mimeType) || 'audio/webm' });
    if (text && text.trim()) await sendTurn(text.trim()); else setTalk('idle');
  } catch (e) { bubble('sys', '⚠ ' + e.message); setTalk('idle'); }
}
// Voice-activity detection: auto-stop ~1.2s after speech ends (so you don't tap to send).
function startVAD(mediaStream) {
  try {
    vadCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = vadCtx.createMediaStreamSource(mediaStream);
    const an = vadCtx.createAnalyser(); an.fftSize = 512; src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let spoke = false, quietSince = 0; const startAt = Date.now();
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      if (rms > 0.045) { spoke = true; quietSince = 0; }
      else if (spoke) { if (!quietSince) quietSince = now; else if (now - quietSince > 1200) { stopRec(); return; } }
      else if (now - startAt > 6000) { stopRec(); return; } // no speech at all → give up after 6s
      vadRAF = requestAnimationFrame(tick);
    };
    vadRAF = requestAnimationFrame(tick);
  } catch (_) { /* VAD is best-effort; tap-to-stop still works */ }
}
function stopVAD() { if (vadRAF) cancelAnimationFrame(vadRAF); vadRAF = 0; try { if (vadCtx) { vadCtx.close(); vadCtx = null; } } catch (_) {} }
function blobB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); }); }

// ---------- TTS playback queue ----------
async function speak(text) { try { const { b64, mime } = await api('/gw/tts', { text }); audioQ.push('data:' + (mime || 'audio/mpeg') + ';base64,' + b64); drainAudio(); } catch (_) {} }
function drainAudio() {
  if (playing || !audioQ.length) return; playing = true;
  const a = new Audio(audioQ.shift()); a.onended = a.onerror = () => { playing = false; drainAudio(); };
  a.play().catch(() => { playing = false; drainAudio(); });
}

// ---------- assist launch (native session) ----------
function maybeAssistLaunch() {
  const assisted = OVERLAY || location.hash.indexOf('assist') >= 0 || window.__ASMLTR_ASSIST === true;
  if (assisted && !listening) { window.__ASMLTR_ASSIST = false; setTimeout(() => { if (!listening) startRec(); }, 200); }
}
window.asmltrStartListening = () => { if (!listening) startRec(); };

// ---------- settings ----------
function openSheet(msg) { $('cfgUrl').value = cfg.baseUrl; $('cfgToken').value = cfg.token; $('cfgName').value = cfg.name; $('cfgDevice').value = cfg.deviceId; $('cfgMsg').textContent = msg || ''; $('sheet').classList.remove('hidden'); }
function closeSheet() { $('sheet').classList.add('hidden'); }
async function testConn() {
  const base = $('cfgUrl').value.trim().replace(/\/+$/, ''); $('cfgMsg').textContent = 'testing…';
  try { const r = await fetch(base + '/health'); const j = await r.json(); $('cfgMsg').textContent = j.status === 'ok' ? '✓ reachable (' + (j.type || 'ok') + ')' : 'unexpected response'; }
  catch (e) { $('cfgMsg').textContent = '✗ ' + e.message; }
}

// ---------- wire up ----------
function init() {
  if (OVERLAY) document.body.classList.add('overlay');
  $('agentName').textContent = cfg.agentName || 'assistant';
  $('talk').addEventListener('click', () => { if (listening) stopRec(); else startRec(); });
  $('settingsBtn').addEventListener('click', () => openSheet());
  $('cfgTest').addEventListener('click', testConn);
  $('cfgSave').addEventListener('click', () => {
    cfg.baseUrl = $('cfgUrl').value.trim().replace(/\/+$/, ''); cfg.token = $('cfgToken').value.trim();
    cfg.name = $('cfgName').value.trim() || 'My device'; saveCfg(cfg);
    // mirror into native storage so the system overlay session can read it (different WebView origin)
    try { if (window.AsmltrNative && window.AsmltrNative.saveConfig) window.AsmltrNative.saveConfig(cfg.baseUrl, cfg.token, cfg.name); } catch (_) {}
    closeSheet(); applyTheme(); connect();
  });
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  // keyboard input
  const send = () => { const v = $('kbd').value.trim(); if (!v) return; $('kbd').value = ''; sendTurn(v); };
  $('kbdSend').addEventListener('click', send);
  $('kbd').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  applyTheme();
  connect();
}
document.addEventListener('DOMContentLoaded', init);
