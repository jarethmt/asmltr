'use strict';
/*
 * asmltr mobile assistant — a self-contained voice client for the `android` connector.
 * One token-authed surface: GET /gw/stream (SSE reply/inject push), POST /gw/turn, /gw/transcribe, /gw/tts.
 * Deliberately framework-free so it bundles into Capacitor with no build step.
 */
const CFG_KEY = 'asmltr.mobile.cfg';
const $ = (id) => document.getElementById(id);

function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (_) {}
  const d = window.ASMLTR_DEFAULTS || {};
  c.baseUrl = (c.baseUrl || d.baseUrl || '').replace(/\/+$/, '');
  c.token = c.token || d.token || '';
  c.name = c.name || d.agentName || 'My device';
  c.agentName = d.agentName || 'assistant';
  if (!c.deviceId) c.deviceId = 'dev-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  return c;
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

let cfg = loadCfg();
let es = null, reconnectT = null, listening = false, recorder = null, chunks = [];
let curBubble = null;            // the streaming assistant bubble being filled
const audioQ = []; let playing = false;

// ---------- UI helpers ----------
function setStatus(s, cls) { const el = $('status'); el.textContent = s; el.className = 'pill ' + cls; }
function bubble(role, text) {
  const el = document.createElement('div');
  el.className = 'msg-row ' + role;
  el.innerHTML = '<div class="bubble"></div>';
  el.querySelector('.bubble').textContent = text || '';
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
  return el.querySelector('.bubble');
}
function setTalk(state) {
  listening = state === 'rec';
  $('talk').className = 'talk' + (state === 'rec' ? ' rec' : state === 'busy' ? ' busy' : '');
  $('talkLabel').textContent = state === 'rec' ? 'Listening… tap to send' : state === 'busy' ? 'Thinking…' : 'Tap to talk';
}

// ---------- SSE (server → device) ----------
function connect() {
  if (!cfg.baseUrl) { openSheet('Set your server URL to connect.'); return; }
  if (es) { es.close(); es = null; }
  setStatus('connecting…', 'pill-warn');
  const url = `${cfg.baseUrl}/gw/stream?token=${encodeURIComponent(cfg.token)}&device=${encodeURIComponent(cfg.deviceId)}&name=${encodeURIComponent(cfg.name)}`;
  es = new EventSource(url);
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === 'ready') { setStatus('connected', 'pill-on'); maybeAssistLaunch(); }
    else if (m.type === 'delta') { if (!curBubble) curBubble = bubble('assistant', ''); curBubble.textContent += m.text; $('log').scrollTop = $('log').scrollHeight; }
    else if (m.type === 'done') { const full = curBubble ? curBubble.textContent : ''; curBubble = null; setTalk('idle'); if (full.trim()) speak(full); }
    else if (m.type === 'inject') { const b = bubble('assistant', m.text); if (m.text && m.text.trim()) speak(m.text); }
    else if (m.type === 'error') { bubble('sys', '⚠ ' + m.error); setTalk('idle'); }
  };
  es.onerror = () => {
    setStatus('reconnecting…', 'pill-warn');
    if (es) { es.close(); es = null; }
    clearTimeout(reconnectT); reconnectT = setTimeout(connect, 2500);
  };
}

// ---------- turn (device → server) ----------
async function api(path, body) {
  const r = await fetch(cfg.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cfg.token, device: cfg.deviceId, name: cfg.name, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function sendTurn(text) {
  bubble('user', text);
  setTalk('busy');
  try { await api('/gw/turn', { text }); }        // reply streams back over the SSE
  catch (e) { bubble('sys', '⚠ ' + e.message); setTalk('idle'); }
}

// ---------- record → transcribe ----------
async function startRec() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      setTalk('busy');
      try {
        const b64 = await blobB64(blob);
        const { text } = await api('/gw/transcribe', { audio_base64: b64, mime: recorder.mimeType || 'audio/webm' });
        if (text && text.trim()) await sendTurn(text.trim());
        else { setTalk('idle'); }
      } catch (e) { bubble('sys', '⚠ ' + e.message); setTalk('idle'); }
    };
    recorder.start();
    setTalk('rec');
  } catch (e) { bubble('sys', '⚠ mic: ' + e.message); setTalk('idle'); }
}
function stopRec() { try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {} }
function blobB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); }); }

// ---------- TTS (queued playback) ----------
async function speak(text) {
  try {
    const { b64, mime } = await api('/gw/tts', { text });
    audioQ.push('data:' + (mime || 'audio/mpeg') + ';base64,' + b64);
    drainAudio();
  } catch (_) { /* TTS is best-effort; text is already shown */ }
}
function drainAudio() {
  if (playing || !audioQ.length) return;
  playing = true;
  const a = new Audio(audioQ.shift());
  a.onended = a.onerror = () => { playing = false; drainAudio(); };
  a.play().catch(() => { playing = false; drainAudio(); });
}

// ---------- assist launch (native VoiceInteractionService sets this) ----------
function maybeAssistLaunch() {
  const assisted = location.hash.indexOf('assist') >= 0 || window.__ASMLTR_ASSIST === true;
  if (assisted && !listening) { window.__ASMLTR_ASSIST = false; setTimeout(() => { if (!listening) startRec(); }, 200); }
}
// The native shell can also call this directly after launching via the assist gesture.
window.asmltrStartListening = () => { if (!listening) startRec(); };

// ---------- settings sheet ----------
function openSheet(msg) {
  $('cfgUrl').value = cfg.baseUrl; $('cfgToken').value = cfg.token; $('cfgName').value = cfg.name; $('cfgDevice').value = cfg.deviceId;
  $('cfgMsg').textContent = msg || ''; $('sheet').classList.remove('hidden');
}
function closeSheet() { $('sheet').classList.add('hidden'); }
async function testConn() {
  const base = $('cfgUrl').value.trim().replace(/\/+$/, '');
  $('cfgMsg').textContent = 'testing…';
  try { const r = await fetch(base + '/health'); const j = await r.json(); $('cfgMsg').textContent = j.status === 'ok' ? '✓ reachable (' + (j.type || 'ok') + ')' : 'unexpected response'; }
  catch (e) { $('cfgMsg').textContent = '✗ ' + e.message; }
}

// ---------- wire up ----------
function init() {
  $('agentName').textContent = cfg.agentName || 'assistant';
  $('talk').addEventListener('click', () => { if (listening) stopRec(); else startRec(); });
  $('settingsBtn').addEventListener('click', () => openSheet());
  $('cfgTest').addEventListener('click', testConn);
  $('cfgSave').addEventListener('click', () => {
    cfg.baseUrl = $('cfgUrl').value.trim().replace(/\/+$/, '');
    cfg.token = $('cfgToken').value.trim();
    cfg.name = $('cfgName').value.trim() || 'My device';
    saveCfg(cfg); closeSheet(); connect();
  });
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  connect();
}
document.addEventListener('DOMContentLoaded', init);
