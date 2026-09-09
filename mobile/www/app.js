'use strict';
/*
 * asmltr mobile assistant — voice + keyboard client for the `android` connector.
 * Streaming TTS (speaks as sentences arrive), clickable tool results, mute, and (overlay mode) a
 * draggable/minimizable/closeable glass card with continuous listening + a Stop that aborts turn + readout.
 */
const CFG_KEY = 'asmltr.mobile.cfg';
const $ = (id) => document.getElementById(id);
const OVERLAY = /(?:^|[?&#])overlay(?:=1)?(?:$|[&#])/.test(location.search + location.hash);
// native=1 → we're inside the persistent OverlayService window; min/expand drive the native window
// (so it survives swipe-home) and device tools are available via the AsmltrDevice bridge.
const NATIVE = /(?:^|[?&#])native(?:=1)?(?:$|[&#])/.test(location.search + location.hash);
function nativeOverlay() { return NATIVE && window.AsmltrOverlay ? window.AsmltrOverlay : null; }

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13 3a3.5 3.5 0 0 0-2-3.15v6.3A3.5 3.5 0 0 0 16 12zm-2-7.3v2.06a5.5 5.5 0 0 1 0 10.48v2.06A7.5 7.5 0 0 0 14 4.7z"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm18.3-1.3l-1.4-1.4L17 9.17 14.83 7 13.4 8.4 15.6 10.6 13.4 12.8l1.4 1.4L17 12l2.9 2.9 1.4-1.4L18.4 10.6z"/></svg>',
};

function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (_) {}
  const d = window.ASMLTR_DEFAULTS || {};
  const nc = window.__ASMLTR_NATIVE_CFG || {};
  c.baseUrl = (c.baseUrl || nc.baseUrl || d.baseUrl || '').replace(/\/+$/, '');
  c.token = c.token || nc.token || d.token || '';
  c.name = c.name || nc.name || d.agentName || 'My device';
  c.agentName = c.agentName || nc.agentName || d.agentName || 'assistant';
  // In the native app, adopt the native device id so the web chat stream + the persistent control link
  // share one identity (same conversation_key).
  if (nc.deviceId) c.deviceId = nc.deviceId;
  if (!c.deviceId) c.deviceId = 'dev-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  return c;
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

let cfg = loadCfg();
let muted = false; try { muted = localStorage.getItem('asmltr.muted') === '1'; } catch (_) {}
let es = null, reconnectT = null;
let state = 'idle';              // 'idle' | 'rec' | 'busy'   (busy covers thinking + reading aloud)
let recorder = null, chunks = [], stream = null, heardSpeech = false;
let curBubble = null, stepsEl = null, lastTool = null, convKey = '', hydrated = false;
let drone = null, curAudio = null, vadRAF = 0, vadCtx = null;
// VAD tuning — global STT settings from the web GUI/TUI (fetched via /gw/theme); forgiving defaults.
let vadCfg = { endpoint_ms: 1600, start_ms: 8000, sensitivity: 50 };

// ---------- voiceOrb: the reactive orb-face (ambient glow + expressive eyes) ----------
// Drives the talk control's visual. State: idle | listening | thinking | speaking. Amplitude comes from
// the live mic (while listening) and the decoded TTS envelope (while speaking) — both via setAmp;
// idle/thinking synthesize a gentle breathe. Self-contained; no dependencies.
const voiceOrb = (() => {
  // Thin adapter over the shared AsmltrEyes engine (eyes.js) — the same face the read-aloud toast and
  // the held-notification badge mount, so the assistant can't drift into looking like a different
  // character depending on which surface you meet it on. The public API (start/setState/setAmp) is
  // unchanged, so every existing call site keeps working.
  let face = null;
  function palette() {
    try {
      const cs = getComputedStyle(document.documentElement);
      const a = cs.getPropertyValue('--accent').trim(), b = cs.getPropertyValue('--accent2').trim();
      if (a && b) return [a.replace(/\s+/g, ','), b.replace(/\s+/g, ',')];
    } catch (_) {}
    return ['139,92,246', '236,72,153'];
  }
  function start() {
    if (face) return;
    const cv = document.getElementById('orbcv');
    if (!cv || !window.AsmltrEyes) return;
    face = AsmltrEyes.mount(cv, { palette: palette() });
    // Pick up live palette changes from Settings without remounting.
    setInterval(() => { try { face.setPalette(palette()); } catch (_) {} }, 4000);
  }
  function setState(s) { try { if (face) face.setState(s); } catch (_) {} }
  function setAmp(v) { try { if (face) face.setAmp(v); } catch (_) {} }
  function setMood(m) { try { if (face) face.setMood(m); } catch (_) {} }
  return { start, setState, setAmp, setMood };
})();
let wakeCfg = { enabled: false, phrase: '' }; // wake word (mirrors core voice config; editable in-app)
// Hands-free "stop listening" phrases — say one and the turn is dropped (not sent) + the mic turns off.
let stopPhrases = ["that's all", "i'm done", 'thank you', 'stop listening', 'never mind', 'goodbye'];
function normPhrase(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function isStopPhrase(text) {
  const t = normPhrase(text); if (!t) return false; const words = t.split(' ').length;
  return stopPhrases.some((p) => { p = normPhrase(p); return p && (t === p || (words <= 4 && t.includes(p))); });
}
let continuous = OVERLAY, suppressRestart = false, cancelledRec = false;
// streaming TTS pipeline (synthesize each sentence as it arrives, play in order)
let ttsBuf = '', ttsSeq = 0, ttsNextPlay = 0, ttsPlaying = false, replyTextDone = false; const ttsClips = {};

// ---------- branding ----------
function toRGB(hex) { const m = String(hex).match(/#?([0-9a-fA-F]{6})/); if (!m) return null; const n = parseInt(m[1], 16); return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`; }
async function applyTheme() {
  try {
    const r = await fetch(cfg.baseUrl + '/gw/theme'); const j = await r.json();
    if (j.agentName) { cfg.agentName = j.agentName; $('agentName').textContent = j.agentName; }
    const hexes = String(j.palette || '').match(/#[0-9a-fA-F]{6}/g) || [];
    const a = hexes[0] && toRGB(hexes[0]), b = (hexes[1] && toRGB(hexes[1])) || a;
    if (a) { document.documentElement.style.setProperty('--accent', a); document.documentElement.style.setProperty('--accent2', b); }
    if (j.vad) vadCfg = { endpoint_ms: +j.vad.endpoint_ms || vadCfg.endpoint_ms, start_ms: +j.vad.start_ms || vadCfg.start_ms, sensitivity: (j.vad.sensitivity != null ? +j.vad.sensitivity : vadCfg.sensitivity) };
    if (j.wake) wakeCfg = { enabled: !!j.wake.enabled, phrase: j.wake.phrase || wakeCfg.phrase };
    if (typeof j.stop_phrases === 'string' && j.stop_phrases.trim()) stopPhrases = j.stop_phrases.split(',').map((s) => s.trim()).filter(Boolean);
  } catch (_) {}
}

// ---------- UI ----------
function setStatus(s, cls) { const el = $('status'); if (el) { el.textContent = s; el.className = 'pill ' + cls; } }
function bubble(role, text) {
  const el = document.createElement('div'); el.className = 'msg-row ' + role;
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text || '';
  el.appendChild(b); $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight; return b;
}
// Full-viewport image viewer: tap an inline image → fills the app window over the chat, with a close
// button, tap-the-backdrop-to-dismiss, Escape, and hardware-back (a pushed history entry the back gesture
// pops) — so it never traps you with no way back to the chat.
let _lightboxClose = null;
function closeLightbox() { if (_lightboxClose) { const fn = _lightboxClose; _lightboxClose = null; fn(); } }
function openLightbox(src, cap) {
  closeLightbox();
  const lb = document.createElement('div'); lb.className = 'lightbox';
  const img = document.createElement('img'); img.className = 'lightbox-img'; img.src = src; img.alt = cap || 'image';
  const close = document.createElement('button'); close.className = 'lightbox-close'; close.setAttribute('aria-label', 'Close'); close.textContent = '✕';
  const onKey = (e) => { if (e.key === 'Escape') closeLightbox(); };
  const onPop = () => { _lightboxClose = null; lb.remove(); document.removeEventListener('keydown', onKey); };
  _lightboxClose = () => { lb.remove(); document.removeEventListener('keydown', onKey); window.removeEventListener('popstate', onPop); try { if (history.state && history.state.lightbox) history.back(); } catch (_) {} };
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });   // tap backdrop
  close.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });
  document.addEventListener('keydown', onKey);
  try { history.pushState({ lightbox: 1 }, ''); window.addEventListener('popstate', onPop, { once: true }); } catch (_) {} // hardware-back closes the viewer, not the overlay
  if (cap) { const c = document.createElement('div'); c.className = 'lightbox-cap'; c.textContent = cap; lb.appendChild(c); }
  lb.appendChild(img); lb.appendChild(close); document.body.appendChild(lb);
}
// Inline attachment bubble (a `media` frame or a `media` history item): {url, mime, name, caption}.
// Image mimes render inline (tap to open full); anything else is a tappable file chip. The url is a
// gateway path (/gw/file?…) — prefix baseUrl, and ensure a device token rides along (history omits it).
function mediaBubble(role, m) {
  const el = document.createElement('div'); el.className = 'msg-row ' + (role || 'assistant');
  const b = document.createElement('div'); b.className = 'bubble media';
  let src = m && m.url ? String(m.url) : '';
  if (src && !/^https?:/i.test(src)) src = cfg.baseUrl + src;
  if (src && cfg.token && !/[?&]token=/.test(src)) src += (src.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(cfg.token);
  if (String(m.mime || '').startsWith('image/')) {
    const img = document.createElement('img'); img.className = 'media-img'; img.loading = 'lazy';
    img.alt = m.caption || m.name || 'image'; img.src = src;
    img.addEventListener('click', () => { if (src) openLightbox(src, m.caption || m.name || ''); });
    b.appendChild(img);
  } else {
    const a = document.createElement('a'); a.className = 'media-file'; a.href = src; a.target = '_blank';
    a.rel = 'noopener'; a.textContent = '📎 ' + (m.name || 'file');
    b.appendChild(a);
  }
  if (m.caption) { const c = document.createElement('div'); c.className = 'media-cap'; c.textContent = m.caption; b.appendChild(c); }
  el.appendChild(b); $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight; return b;
}
function fmt(v) { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch (_) { return String(v); } }
// Each thinking/tool row is appended to the log IN ORDER, and closes the current text bubble (curBubble=null)
// so streamed reply text threads chronologically around the tools instead of stacking into one bubble.
function addThinking(text) {
  curBubble = null;
  const d = document.createElement('div'); d.className = 'step step-think'; d.textContent = '… ' + text;
  $('log').appendChild(d); $('log').scrollTop = $('log').scrollHeight;
}
// A short, single-line preview of a tool's input for the collapsed chip (the command/query/path/etc).
function toolPreview(input) {
  if (input == null) return '';
  let s = typeof input === 'string' ? input
    : (input.command || input.query || input.file_path || input.path || input.pattern || input.prompt || input.description || input.url || input.cmd || fmt(input));
  return String(s).replace(/\s+/g, ' ').trim();
}
function addTool(name, input) {
  curBubble = null;
  const wrap = document.createElement('div'); wrap.className = 'step step-tool tool-chip';
  const head = document.createElement('div'); head.className = 'tool-head';
  const caret = document.createElement('span'); caret.className = 'tool-caret'; caret.textContent = '▸';
  const nm = document.createElement('span'); nm.className = 'tool-name'; nm.textContent = '⚙ ' + name;
  const pv = document.createElement('span'); pv.className = 'tool-preview'; pv.textContent = toolPreview(input);
  head.appendChild(caret); head.appendChild(nm); head.appendChild(pv);
  const detail = document.createElement('pre'); detail.className = 'tool-detail hidden';
  if (input != null) detail.textContent = 'input:\n' + fmt(input);
  head.addEventListener('click', () => { detail.classList.toggle('hidden'); caret.textContent = detail.classList.contains('hidden') ? '▸' : '▾'; });
  wrap.appendChild(head); wrap.appendChild(detail); $('log').appendChild(wrap);
  lastTool = { wrap, detail }; $('log').scrollTop = $('log').scrollHeight;
}
function addToolResult(output, isErr) {
  if (!lastTool) return;
  lastTool.detail.textContent += (lastTool.detail.textContent ? '\n\n' : '') + 'output:\n' + (output || '');
  if (isErr) lastTool.wrap.classList.add('tool-err');
  lastTool = null;
}
// Sub-agent panel: a live "sub-agents for this turn" section. A `subagent` frame (Claude only —
// Codex/Gemini never emit them, so this panel simply never appears there = the capability gate) opens
// the panel on the first running agent and updates each agent's row in place (running ● → stopped ✓).
// View-only: sub-agents die with the turn and the SDK exposes no per-sub-agent kill.
let subPanel = null, subRows = {};
function resetSubPanel() { subPanel = null; subRows = {}; }
function addSubagent(s) {
  if (!s || !s.id) return;
  curBubble = null;
  if (!subPanel) {
    subPanel = document.createElement('div'); subPanel.className = 'subpanel';
    const h = document.createElement('div'); h.className = 'subpanel-head'; h.textContent = '🤖 sub-agents';
    subPanel.appendChild(h); $('log').appendChild(subPanel); subRows = {};
  }
  let row = subRows[s.id];
  if (!row) {
    row = document.createElement('div'); row.className = 'subrow';
    const dot = document.createElement('span'); dot.className = 'subdot';
    const nm = document.createElement('span'); nm.className = 'subname';
    const sm = document.createElement('span'); sm.className = 'subsum';
    row.appendChild(dot); row.appendChild(nm); row.appendChild(sm);
    subPanel.appendChild(row); subRows[s.id] = row;
    row._dot = dot; row._nm = nm; row._sm = sm;
  }
  const stopped = s.status === 'stopped';
  row.classList.toggle('done', stopped);
  row._dot.textContent = stopped ? '✓' : '●';
  row._nm.textContent = s.name || 'sub-agent';
  if (s.summary) row._sm.textContent = s.summary;
  $('log').scrollTop = $('log').scrollHeight;
}
function setState(s) {
  state = s;
  const t = $('talk'), l = $('talkLabel');
  if (!t) return;
  t.className = 'talk' + (s === 'rec' ? ' rec' : s === 'busy' ? ' busy' : '');
  if (l) l.textContent = s === 'rec' ? 'Listening…' : s === 'busy' ? 'Stop' : 'Tap to talk';
  // Drive the orb-face: rec → listening; busy → speaking while TTS is playing, else thinking.
  try { voiceOrb.setState(s === 'rec' ? 'listening' : s === 'busy' ? (ttsPlaying ? 'speaking' : 'thinking') : 'idle'); } catch (_) {}
  // Hold the CPU awake while listening/working so it runs with the screen off; release when idle.
  const n = nativeOverlay(); if (n && n.setAwake) { try { n.setAwake(s === 'rec' || s === 'busy'); } catch (_) {} }
}
function setMuted(on) { muted = on; try { localStorage.setItem('asmltr.muted', on ? '1' : '0'); } catch (_) {} const b = $('mute'); if (b) { b.innerHTML = on ? ICON.muted : ICON.vol; b.classList.toggle('on', on); } if (on) stopAudio(); }

// ---------- SSE ----------
function connect() {
  if (!cfg.baseUrl || !cfg.token) { openSheet('Paste your device token to connect.'); return; }
  if (es) { es.close(); es = null; }
  setStatus('connecting…', 'pill-warn');
  const url = `${cfg.baseUrl}/gw/stream?token=${encodeURIComponent(cfg.token)}&device=${encodeURIComponent(cfg.deviceId)}&name=${encodeURIComponent(cfg.name)}`;
  es = new EventSource(url);
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === 'ready') { setStatus('connected', 'pill-on'); if (m.conversation_key) { convKey = m.conversation_key; if (ownTab) ownTab.key = convKey; } if (!activeTarget && !hydrated && $('log').children.length === 0) hydrateOwn(convKey); maybeAssistLaunch(); return; }
    if (m.type === 'device_rpc') { runDeviceRPC(m); return; }   // #77: act on this phone (device-level, tab-agnostic)
    if (m.type === 'open-remote-desktop') { openRemoteDesktop(m); return; } // cast-to-device: open a live host stream here (tab-agnostic)
    // Multi-tab demultiplex: frames carry `key` (their conversation). A frame for a BACKGROUND tab is
    // buffered (keeps accumulating, never speaks) and replayed when that tab is activated; a frame for
    // the ACTIVE tab (or a keyless push like inject/speak) renders live and drives TTS.
    const tab = frameTab(m);
    if (tab && tab !== activeTab) {
      tab.pending.push(m); if (tab.pending.length > 2000) tab.pending.splice(0, tab.pending.length - 2000); // guard runaway buffers
      if ((m.type === 'delta' || m.type === 'done') && !tab.dirty) { tab.dirty = true; updateTabStrip(); } // flag activity once
      return;
    }
    renderFrame(m, true);
  };
  es.onerror = () => { setStatus('reconnecting…', 'pill-warn'); if (es) { es.close(); es = null; } clearTimeout(reconnectT); reconnectT = setTimeout(connect, 2500); };
}
function minimized() { return document.body.classList.contains('minimized'); }
function afterReply() { if (continuous && !suppressRestart && !minimized() && state === 'idle') setTimeout(() => { if (continuous && !suppressRestart && !minimized() && state === 'idle') startRec(); }, 350); }

// Render ONE stream frame into the (already-active) log. `live` = this is the active tab's real-time
// turn → drive TTS + drone + mic restart; false = a catch-up replay of buffered background frames
// (paint the DOM only, never speak). All render helpers target $('log') = the active tab's node.
function renderFrame(m, live) {
  switch (m.type) {
    case 'thinking': addThinking(m.text); break;
    // Expression, sent by the core as data (it strips the [[MOOD:x]] sentinel from the reply text so it
    // is never displayed or spoken). Arrives at the start of a reply, so the face changes as the answer
    // begins. Unknown names are ignored by the engine, so a new mood server-side can't break an old app.
    case 'mood': try { voiceOrb.setMood(m.mood); } catch (_) {} break;
    case 'tool': addTool(m.name, m.input); break;
    case 'tool_result': addToolResult(m.output, m.is_error); break;
    case 'subagent': addSubagent(m); break;                     // live sub-agent panel (Claude only)
    case 'delta':
      if (live) stopDrone();
      if (!curBubble) curBubble = bubble('assistant', ''); curBubble.textContent += m.text;
      if (live) feedTTS(m.text); $('log').scrollTop = $('log').scrollHeight; break;
    case 'done':
      curBubble = null; stepsEl = null; if (live) { stopDrone(); flushTTS(); } break;
    case 'inject':
      stepsEl = null; bubble('assistant', m.text);
      if (live && m.text && m.text.trim() && !muted) { resetTTS(); feedTTS(m.text); flushTTS(); } break;
    case 'speak':                                               // asmltr notify (Part A): read aloud, not a turn
      stepsEl = null; bubble('sys', '🔔 ' + (m.title ? (m.title + ' — ' + m.text) : m.text));
      if (live && m.text && m.text.trim() && !muted) { resetTTS(); feedTTS(m.title ? (m.title + '. ' + m.text) : m.text); flushTTS(); } break;
    case 'media': stepsEl = null; curBubble = null; mediaBubble('assistant', m); break; // inline image/file
    case 'error':
      if (live) stopDrone(); bubble('sys', '⚠ ' + m.error); if (live) { resetTTS(); setState('idle'); } break;
    default: break;
  }
}

// ---------- streaming TTS ----------
function feedTTS(text) {
  if (muted) return;
  ttsBuf += text;
  const idx = Math.max(ttsBuf.lastIndexOf('.'), ttsBuf.lastIndexOf('!'), ttsBuf.lastIndexOf('?'), ttsBuf.lastIndexOf('\n'), ttsBuf.lastIndexOf('…'));
  if (idx >= 0) { const chunk = ttsBuf.slice(0, idx + 1).trim(); ttsBuf = ttsBuf.slice(idx + 1); if (chunk) synthSentence(chunk); }
}
function flushTTS() {
  if (muted) { replyTextDone = true; finishReadout(); return; }
  const rest = ttsBuf.trim(); ttsBuf = ''; replyTextDone = true;
  if (rest) synthSentence(rest); else drainTTS();
}
async function synthSentence(text) {
  const seq = ttsSeq++;
  try { const { b64, mime } = await api('/gw/tts', { text }); ttsClips[seq] = suppressRestart ? null : 'data:' + (mime || 'audio/mpeg') + ';base64,' + b64; }
  catch (_) { ttsClips[seq] = null; }
  drainTTS();
}
// Reactive speaking: decode the clip's bytes into a cheap RMS envelope and feed the orb's amplitude by
// playback time. This only DECODES the audio for analysis — it never routes the <audio> element through
// WebAudio (createMediaElementSource reroutes playback into a suspended graph and mutes it on WebView),
// so playback is untouched. Falls back to the orb's synth envelope if decode fails.
let _orbActx = null;
async function speakAmp(a, src) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    if (!_orbActx) _orbActx = new AC();
    const bytes = await (await fetch(src)).arrayBuffer();
    const audio = await _orbActx.decodeAudioData(bytes);
    const ch = audio.getChannelData(0), W = Math.max(1, Math.floor(audio.sampleRate * 0.04)); // 40ms windows
    const env = []; let peak = 0.001;
    for (let i = 0; i < ch.length; i += W) { let s = 0, n = 0; for (let j = i; j < i + W && j < ch.length; j++) { s += ch[j] * ch[j]; n++; } const r = Math.sqrt(s / Math.max(1, n)); env.push(r); if (r > peak) peak = r; }
    const step = () => {
      if (curAudio !== a || a.paused || a.ended) return;
      try { voiceOrb.setAmp(Math.min(1, (env[Math.floor(a.currentTime / 0.04)] || 0) / peak)); } catch (_) {}
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } catch (_) { /* decode failed → orb uses its synth speaking envelope */ }
}
function drainTTS() {
  if (ttsPlaying) return;
  if (ttsNextPlay in ttsClips) {
    const src = ttsClips[ttsNextPlay]; delete ttsClips[ttsNextPlay]; ttsNextPlay++;
    if (!src) return drainTTS();
    ttsPlaying = true; const a = new Audio(src); curAudio = a;
    try { voiceOrb.setState('speaking'); speakAmp(a, src); } catch (_) {}   // orb ripples with the actual spoken audio
    a.onended = a.onerror = () => { ttsPlaying = false; if (curAudio === a) curAudio = null; drainTTS(); };
    a.play().catch(() => { ttsPlaying = false; drainTTS(); });
    return;
  }
  if (replyTextDone && ttsNextPlay >= ttsSeq) finishReadout();  // all sentences synthesized + played
}
function finishReadout() { resetTTS(); setState('idle'); afterReply(); }
function resetTTS() { ttsBuf = ''; ttsSeq = 0; ttsNextPlay = 0; ttsPlaying = false; replyTextDone = false; for (const k in ttsClips) delete ttsClips[k]; }

// ---------- turn ----------
async function api(path, body) {
  const r = await fetch(cfg.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cfg.token, device: cfg.deviceId, name: cfg.name, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function apiGet(path, params) {
  const q = new URLSearchParams({ token: cfg.token, device: cfg.deviceId, ...(params || {}) }).toString();
  const r = await fetch(cfg.baseUrl + path + '?' + q);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function sendTurn(text) {
  // An expression belongs to the reply that set it and lasts until you say something new. Resetting it
  // when the READOUT ends looked equivalent but wasn't: with the speaker muted, flushTTS() calls
  // finishReadout() immediately, so the mood was set and wiped in the same instant and never showed.
  try { voiceOrb.setMood('neutral'); } catch (_) {}
  if (state === 'busy') return;
  suppressRestart = false; resetTTS(); lastTool = null; resetSubPanel();
  bubble('user', text); setState('busy');
  if (!muted) { chime(); startDrone(); }
  // If a session is selected in the switcher, direct the turn at it (else this device's own session).
  const extra = activeTarget ? { target_key: activeTarget.key, target_surface: activeTarget.surface } : {};
  try { await api('/gw/turn', { text, ...extra }); }
  catch (e) { stopDrone(); bubble('sys', '⚠ ' + e.message); setState('idle'); }
}

// ---------- STOP ----------
function stopEverything() {
  suppressRestart = true; stopDrone(); stopAudio(); resetTTS(); stopRealtimeSTT(); clearLiveCaption();
  try { api('/gw/abort', {}).catch(() => {}); } catch (_) {}
  curBubble = null; stepsEl = null; lastTool = null; setState('idle');
  // Distinct "turn killed" feedback: a low descending double-tone (NOT the listen/stop mic cues), a
  // visible system bubble, and the orb back to idle (already via setState) — so a hands-free / screen-off
  // user recognises the kill by ear, and the chat shows the turn was dropped.
  killCue(); bubble('sys', '⏹ turn stopped');
}

// ---------- audio ----------
function stopAudio() { try { if (curAudio) { curAudio.pause(); curAudio = null; } } catch (_) {} }
function chime() { try { const a = new Audio('assets/chime.ogg'); a.volume = 0.8; a.play().catch(() => {}); } catch (_) {} }
// Listening cue — plays when the mic opens so hands-free users (earbud trigger, screen off) hear that
// it's listening. Always plays (it's trigger feedback, not TTS), independent of the mute toggle.
// Two mirror-image cues so hands-free users tell them apart by direction:
//   listen (mic on)  = ASCENDING  boop→beep (low→high)
//   stop  (mic off)  = DESCENDING beep→boop (high→low)
function beepPair(f1, f2) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = new AC();
    // Wake-from-closed has no user gesture, so the context starts suspended → silent. Resume it (the
    // overlay WebView allows gesture-less playback). Schedule the tones after a beat so resume lands.
    try { if (ctx.state === 'suspended' && ctx.resume) ctx.resume(); } catch (_) {}
    const t0 = ctx.currentTime;
    // Bluetooth (A2DP) needs ~0.3s to spin up an idle audio route, or the first tone gets clipped. Hold a
    // near-silent primer open for the lead, then start the audible tones after the route is warm.
    const LEAD = 0.32;
    const po = ctx.createOscillator(), pg = ctx.createGain(); po.type = 'sine'; po.frequency.value = 200;
    pg.gain.setValueAtTime(0.0002, t0); po.connect(pg).connect(ctx.destination); po.start(t0); po.stop(t0 + LEAD + 0.02);
    [[f1, LEAD], [f2, LEAD + 0.14]].forEach(([f, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.3, t0 + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.13);
      o.connect(g).connect(ctx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.14);
    });
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, (LEAD + 0.5) * 1000);
  } catch (_) {}
}
// Prefer the NATIVE cue: WebAudio plays as MEDIA, which is silent while the SCO/call route is up for
// headset capture — so these tones disappeared the moment we started using the earbud mic. Chime
// follows whichever route is live (SCO → voice-communication, otherwise A2DP/media). WebAudio stays as
// the fallback for the PWA/browser, where there's no native bridge.
function nativeCue(kind) {
  try {
    if (window.AsmltrNative && window.AsmltrNative.cue) { window.AsmltrNative.cue(kind); return true; }
  } catch (_) {}
  return false;
}
function listenCue() { if (!nativeCue('listen')) beepPair(440, 660); } // ascending — "now listening"
function stopCue() { if (!nativeCue('stop')) beepPair(660, 440); }     // descending — "stopped, mic off"
function killCue() { if (!nativeCue('kill')) beepPair(330, 220); }     // low "thunk" — turn KILLED
function startDrone() { try { if (!drone) { drone = new Audio('assets/drone.ogg'); drone.loop = true; drone.volume = 0.45; } drone.currentTime = 0; drone.play().catch(() => {}); } catch (_) {} }
function stopDrone() { try { if (drone) drone.pause(); } catch (_) {} }

// ---------- record + VAD ----------
// Pick the phone's built-in mic (never a Bluetooth input) so capturing a turn doesn't bring up the
// earbuds' SCO/call link — which would mute the A2DP output the reply is spoken on. Returns null if we
// can't tell them apart (labels need prior mic permission, which we have once a turn has run).
// Talk through the HEADSET mic when one is connected — you're wearing the earbuds, so that's the mic
// that should hear you; holding the phone up to talk defeats the point of a hands-free assistant.
//
// This CANNOT be done from JS. Chromium on Android does not enumerate per-device microphones — it
// exposes essentially one "default" audioinput — so no getUserMedia deviceId can select the earbud
// mic. (An earlier revision tried exactly that, matching device labels; enumerateDevices never listed
// the headset, so it silently fell back to the phone mic.) The route has to be nominated at the
// AudioManager level, which is what AsmltrNative.useHeadsetMic() does.
//
// Cost: this brings the SCO (call) link up, pulling the buds off A2DP onto the narrowband call
// profile. Handled elsewhere — OverlayService holds audio focus for the session so other players
// pause rather than being dragged onto the call channel, cues follow the live route, and
// releaseCommunicationRoute() hands A2DP back as soon as capture ends.
async function routeToHeadsetMic() {
  const N = window.AsmltrNative;
  if (!N || !N.useHeadsetMic) return false;
  try { if (!N.useHeadsetMic()) return false; } catch (_) { return false; }
  // setCommunicationDevice() returns before the SCO link is actually up; opening capture too early
  // lands on the phone mic. Wait for the route to go live (typically a few hundred ms).
  for (let i = 0; i < 20; i++) {
    try { if (N.headsetMicActive && N.headsetMicActive()) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 75));
  }
  return false;
}
async function startRec(skipCue) {
  if (state !== 'idle') return;
  // Wake-from-closed (wake word / headset button) plays the listen cue NATIVELY (OverlayService → Chime)
  // because the WebView beep is inaudible before the BT route is warm; skip the web cue then to avoid a
  // double. All other starts (manual tap, continuous restart) use the web cue — audible, overlay's open.
  const skip = skipCue || window.__ASMLTR_SKIP_CUE;
  window.__ASMLTR_SKIP_CUE = false;
  try {
    // Unprocessed capture: echoCancellation/noiseSuppression push Chromium down its WebRTC
    // *communication* path, which adds its own routing decisions on top of ours. We only record while
    // TTS isn't playing, so AEC buys us nothing anyway.
    // Capture from the HEADSET mic when one is connected (see routeToHeadsetMic) — the mic next to
    // your mouth. It brings the SCO/call link up; OverlayService holds audio focus for the session so
    // other players pause rather than getting dragged onto the narrowband call channel.
    // echoCancellation MUST be on to reach the earbud mic. It puts Chromium on its WebRTC capture
    // path, which opens the stream as AUDIO_SOURCE_VOICE_COMMUNICATION — the only source that follows
    // the communication device onto SCO. With it off, capture opens as AUDIO_SOURCE_MIC and binds to
    // the phone's built-in mic no matter what route we nominate (confirmed in audio_flinger: output
    // moved to BLUETOOTH_SCO_HEADSET while "Input device: AUDIO_DEVICE_NONE, Audio source: DEFAULT").
    // It also stops our own TTS bleeding back into the mic, which matters more now the speaker and mic
    // are the same earbuds.
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    // Nominate the earbud mic BEFORE opening the stream — the route has to be live first, otherwise
    // capture binds to the phone mic. No headset connected → falls through and uses the phone mic.
    const onHeadset = await routeToHeadsetMic();
    stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    if (NATIVE) console.log('[asmltr] capture route:', onHeadset ? 'bluetooth headset (SCO)' : 'phone mic');
    // Cue AFTER the stream is live, not before. Opening the headset mic brings SCO up and tears the
    // A2DP route down mid-tone, so a cue fired first was getting clipped to nothing. Playing it here
    // means the route has settled and the tone rides whichever one is now active — and "listening" is
    // truthful, because the mic really is open.
    if (!skip) listenCue();
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = []; heardSpeech = false;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onRecStop; recorder.start(); setState('rec'); startVAD(stream);
    if (sttRealtimeOn()) startRealtimeSTT(stream); // live captions while speaking (batch stays the fallback)
  } catch (e) { bubble('sys', '⚠ mic: ' + e.message); setState('idle'); }
}
function stopRec() { stopVAD(); try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {} }
// Abandon the turn we're recording: stop the mic and DROP the audio instead of transcribing it.
// onRecStop honours the flag (it still has to run — it owns the teardown).
function cancelRec() { cancelledRec = true; stopRec(); }
async function onRecStop() {
  stopVAD();
  // Capture the streaming transcript (if any) BEFORE tearing the session down, then close it + drop the caption.
  const rtUsed = rtActive, rtText = realtimeFinalText(); stopRealtimeSTT(); clearLiveCaption();
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  // Stopping the tracks isn't enough: Android holds the SCO route for ~20s after the mic closes, and
  // the reply would play into that dead call channel. Hand the route back to A2DP now.
  try { if (window.AsmltrNative && window.AsmltrNative.releaseCommunicationRoute) window.AsmltrNative.releaseCommunicationRoute(); } catch (_) {}
  // Cancelled by a second assist press: the mic is torn down above, now drop the audio without
  // transcribing it. Same ending as a spoken stop-phrase, so it reads identically to the user.
  if (cancelledRec) {
    cancelledRec = false; suppressRestart = true; stopDrone(); setState('idle'); stopCue();
    bubble('sys', '✓ stopped listening');
    return;
  }
  if (!heardSpeech) { setState('idle'); return; }   // tapped off without speaking → nothing
  const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
  if (!rtText && blob.size < 1200) { setState('idle'); return; }
  setState('busy');
  try {
    // Prefer the live streaming transcript; fall back to batch /gw/transcribe when realtime was off/failed.
    let text;
    if (rtUsed && rtText) text = rtText;
    else { const b64 = await blobB64(blob); text = (await api('/gw/transcribe', { audio_base64: b64, mime: (recorder && recorder.mimeType) || 'audio/webm' })).text; }
    if (text && isStopPhrase(text)) { // hands-free stop — drop the turn, don't send to the LLM, end listening
      suppressRestart = true; stopDrone(); setState('idle'); stopCue(); bubble('sys', '✓ stopped listening');
    } else if (text && text.trim()) { setState('idle'); await sendTurn(text.trim()); } else setState('idle');
  } catch (e) { bubble('sys', '⚠ ' + e.message); setState('idle'); }
}
// End-of-speech detection. Design bias: WAIT TOO LONG rather than cut early. Key fixes over the old
// loop (which froze the noise floor after the 350ms prime and then clipped people mid-sentence):
//   • the floor keeps SLOWLY adapting during silence (tracks drifting room tone, never ratchets up on
//     the speaker's own voice), so the threshold doesn't go stale.
//   • a min-utterance guard: we can't endpoint within the first ~1s of detected speech (a slow starter
//     or a mid-thought pause won't drop the turn).
//   • the hangover honours the user's relaxed endpoint_ms from /gw/theme, floored + padded so it's
//     never trigger-happy, and requires SUSTAINED sub-threshold silence (any speech frame resets it).
function startVAD(mediaStream) {
  try {
    vadCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = vadCtx.createMediaStreamSource(mediaStream);
    const an = vadCtx.createAnalyser(); an.fftSize = 1024; src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const t0 = Date.now(); let floor = 0.01, floorN = 0, quietSince = 0, speechStart = 0;
    // sensitivity 0..100 → threshold scale 1.5 (needs louder) .. 0.5 (more sensitive); 50 = neutral.
    const f = 1.5 - (Math.max(0, Math.min(100, vadCfg.sensitivity)) / 100);
    // Honour the user's relaxed endpoint_ms, but never endpoint faster than a floor (people pause), and
    // add a hangover so it leans toward "waits too long" over "cuts early".
    const endpointMs = Math.max(900, vadCfg.endpoint_ms || 1600) + 400;
    const startMs = vadCfg.start_ms || 8000;
    const MIN_UTTER_MS = 1000; // can't endpoint in the first ~1s of detected speech (min-utterance guard)
    const rms = () => { an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; } return Math.sqrt(s / buf.length); };
    const thresh = () => f * Math.max(0.03, floor * 2.2 + 0.012);
    const tick = () => {
      const level = rms(); const now = Date.now(); const dt = now - t0;
      try { if (state === 'rec') voiceOrb.setAmp(Math.min(1, level * 6)); } catch (_) {} // orb ripples with your voice
      // prime the floor from the opening (pre-speech) window
      if (dt < 350) { floor = (floor * floorN + level) / (floorN + 1); floorN++; vadRAF = requestAnimationFrame(tick); return; }
      const speaking = level > thresh();
      if (speaking) {
        heardSpeech = true; if (!speechStart) speechStart = now; quietSince = 0;
      } else {
        // slowly track ambient drift during genuine near-silence only (never while a voice is active),
        // so the threshold stays honest without creeping up on the speaker.
        if (level < floor * 1.5) floor += (level - floor) * 0.02;
        if (heardSpeech) {
          // min-utterance guard: hold off endpointing until the utterance has run ~1s.
          if (speechStart && now - speechStart < MIN_UTTER_MS) { vadRAF = requestAnimationFrame(tick); return; }
          // require SUSTAINED silence: a single speech frame above resets quietSince, so a flicker
          // (a between-words dip) can't trip the endpoint — only continuous silence for the hangover.
          if (!quietSince) quietSince = now;
          else if (now - quietSince > endpointMs) { stopRec(); return; }
        } else if (dt > startMs) { stopRec(); return; } // never spoke → give up after start window
      }
      vadRAF = requestAnimationFrame(tick);
    };
    vadRAF = requestAnimationFrame(tick);
  } catch (_) {}
}
function stopVAD() { if (vadRAF) cancelAnimationFrame(vadRAF); vadRAF = 0; try { if (vadCtx) { vadCtx.close(); vadCtx = null; } } catch (_) {} }
function blobB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); }); }

// ---------- live (streaming) STT ----------
// OPTIONAL streaming transcription: reuse the live mic track and open a WebRTC session DIRECTLY to
// OpenAI realtime transcription using an ephemeral secret minted by the connector (/gw/realtime-token —
// the real key stays on the host). Partial deltas paint a live caption bubble while you speak; the final
// transcript is used on endpoint. Batch /gw/transcribe stays the fallback (off, no token, or any error).
// Gated by the device-local "Live transcription" setting. NOTE: the exact OpenAI realtime WebRTC URL +
// event names can shift; on ANY failure we degrade silently to batch, so the feature is safe-by-default.
let rtPC = null, rtDC = null, rtActive = false, rtFinal = '', rtPartial = '', rtCapEl = null, rtGen = 0;
function sttRealtimeOn() { try { return localStorage.getItem('asmltr.sttmode') === 'realtime'; } catch (_) { return false; } }
function setSttRealtime(on) { try { localStorage.setItem('asmltr.sttmode', on ? 'realtime' : 'batch'); } catch (_) {} }
function realtimeFinalText() { return (rtFinal + ' ' + rtPartial).replace(/\s+/g, ' ').trim(); }
function liveCaption(text) {
  if (!rtCapEl) { rtCapEl = bubble('user', ''); if (rtCapEl.parentElement) rtCapEl.parentElement.classList.add('live'); }
  rtCapEl.textContent = text || '…'; $('log').scrollTop = $('log').scrollHeight;
}
function clearLiveCaption() { try { if (rtCapEl && rtCapEl.parentElement) rtCapEl.parentElement.remove(); } catch (_) {} rtCapEl = null; }
async function startRealtimeSTT(micStream) {
  // Setup is async (token mint + SDP round-trip). A short utterance can end BEFORE it finishes, so guard
  // with a generation token: stopRealtimeSTT() bumps rtGen, and any awaited step here that finds its gen
  // stale closes its own half-built peer and bails — otherwise the connection would open AFTER we stopped
  // (transcribing with the mic off = token burn) and the next listen would stack a 2nd stream (the doubling).
  stopRealtimeSTT();                 // tear down any prior/in-flight session first
  const gen = ++rtGen;
  rtActive = false; rtFinal = ''; rtPartial = '';
  try {
    if (!window.RTCPeerConnection || !micStream) return;
    const tok = await api('/gw/realtime-token', {});
    if (gen !== rtGen || !tok || !tok.value) return; // superseded/stopped during token mint
    const pc = new RTCPeerConnection(); rtPC = pc;
    for (const tr of micStream.getAudioTracks()) pc.addTrack(tr, micStream);
    const dc = pc.createDataChannel('oai-events'); rtDC = dc;
    // The transcription session (model, turn detection, etc.) is baked into the ephemeral secret when the
    // connector mints it via /v1/realtime/client_secrets — the client sends NO session.update; it just
    // receives transcription events on this data channel.
    dc.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      const type = String(m.type || '');
      if (/input_audio_transcription\.delta/.test(type) && m.delta != null) {
        rtPartial += m.delta; liveCaption(realtimeFinalText());
      } else if (/input_audio_transcription\.completed/.test(type)) {
        const seg = (m.transcript != null ? m.transcript : rtPartial) || '';
        rtFinal = (rtFinal + ' ' + seg).replace(/\s+/g, ' ').trim(); rtPartial = ''; liveCaption(rtFinal);
      } else if (type === 'error' && sttRealtimeOn()) {
        // Surface OpenAI's own error so a schema/model mismatch is diagnosable instead of silently falling back.
        const em = (m.error && (m.error.message || m.error.code)) || JSON.stringify(m).slice(0, 200);
        bubble('sys', '⚠ live STT: ' + em);
      }
    };
    if (gen !== rtGen) { try { pc.close(); } catch (_) {} return; } // stopped while wiring the peer
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    if (gen !== rtGen) { try { pc.close(); } catch (_) {} return; } // stopped during offer
    // GA WebRTC SDP exchange endpoint. The old beta `/v1/realtime?intent=transcription` was retired
    // ("the realtime beta API is no longer supported"); the session type/model ride in the ephemeral secret.
    const r = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok.value, 'Content-Type': 'application/sdp' }, body: offer.sdp,
    });
    if (gen !== rtGen) { try { pc.close(); } catch (_) {} return; } // stopped during the SDP round-trip
    if (!r.ok) throw new Error('realtime sdp ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 160));
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
    if (gen !== rtGen) { try { pc.close(); } catch (_) {} return; } // stopped before it went live
    rtActive = true;
  } catch (e) {
    // Surface the reason when the user explicitly enabled live STT (else stay quiet); batch still covers the turn.
    if (gen === rtGen && sttRealtimeOn()) { try { bubble('sys', '⚠ live STT unavailable: ' + (e && e.message ? e.message : e)); } catch (_) {} }
    if (gen === rtGen) stopRealtimeSTT();
  }
}
// Idempotent + race-proof: bumping rtGen invalidates any in-flight startRealtimeSTT so it can't publish a
// live connection after we've stopped. Called on every listen-end path (onRecStop / stopEverything).
function stopRealtimeSTT() {
  rtGen++;
  rtActive = false;
  try { if (rtDC) rtDC.close(); } catch (_) {}
  try { if (rtPC) rtPC.close(); } catch (_) {}
  rtDC = null; rtPC = null;
}

// ---------- #77 device control ----------
// The assistant emits a device_rpc frame; we run it against this phone via the native AsmltrDevice
// bridge and post the outcome back so the connector can resolve the tool with a real result.
async function runDeviceRPC(m) {
  const id = m.id, tool = m.tool, args = m.args || {};
  let result;
  try {
    if (window.AsmltrDevice && window.AsmltrDevice.dispatch) {
      const raw = window.AsmltrDevice.dispatch(tool, JSON.stringify(args));
      result = JSON.parse(raw || '{"ok":false,"error":"no result"}');
    } else {
      result = { ok: false, error: 'device tools only available in the native app' };
    }
  } catch (e) { result = { ok: false, error: String(e && e.message || e) }; }
  addTool('device:' + tool, args); addToolResult(JSON.stringify(result), !result.ok);
  try { await api('/gw/rpc-result', { id, result }); } catch (_) {}
}

// ---------- cast-to-device: open a live remote-desktop stream on this phone ----------
// A trusted caster (the dashboard's "Cast to my phone" / the assistant) pushed an open-remote-desktop
// frame over this device's SSE. Navigate to the RD viewer with the host (and control flag) as query
// params; remote-desktop.js auto-connects to it. Tab-agnostic, like device_rpc — this is the primitive
// by which a live host stream is projected onto a device (sibling of the inline `media` screenshot).
function openRemoteDesktop(m) {
  if (!m || !m.host_id) return;
  const q = new URLSearchParams({ host: String(m.host_id) });
  if (m.control) q.set('control', '1');
  try { location.href = 'remote-desktop.html?' + q.toString(); } catch (_) {}
}

// ---------- assist launch + native overlay controls ----------
// Auto-listen-on-open (default OFF): a plain overlay open must NOT grab the mic. An ASSIST-GESTURE
// launch (opened via the digital-assistant gesture / wake) always auto-listens — that's the "opened a
// certain way" intent. The toggle only affects a plain open. Persisted device-local (localStorage +
// best-effort NativeConfig), read from the native cfg blob when present.
const AUTOLISTEN_KEY = 'asmltr.autolisten';
function autoListenOnOpen() {
  try { const nc = window.__ASMLTR_NATIVE_CFG || {}; if (typeof nc.autoListen === 'boolean') return nc.autoListen; } catch (_) {}
  try { return localStorage.getItem(AUTOLISTEN_KEY) === '1'; } catch (_) { return false; }
}
function setAutoListen(on) {
  try { localStorage.setItem(AUTOLISTEN_KEY, on ? '1' : '0'); } catch (_) {}
  try { if (window.AsmltrNative && window.AsmltrNative.setAutoListen) window.AsmltrNative.setAutoListen(!!on); } catch (_) {}
}
function maybeAssistLaunch() {
  const assistGesture = location.hash.indexOf('assist') >= 0 || window.__ASMLTR_ASSIST === true;
  const auto = assistGesture || (OVERLAY && autoListenOnOpen());
  if (auto && state === 'idle') { window.__ASMLTR_ASSIST = false; setTimeout(() => { if (state === 'idle') startRec(); }, 250); }
}
window.asmltrStartListening = (skipCue) => { if (state === 'idle') startRec(skipCue); };
// The assist gesture is a TOGGLE, not just a start. Pressing it again should do the obvious thing:
//   idle → start listening
//   rec  → abandon the turn (mic off, audio dropped, nothing sent)
//   busy → abort: interrupts TTS mid-sentence and cancels the in-flight turn server-side
// stopEverything() already owns the abort path (stops audio, resets the TTS queue, calls /gw/abort),
// so barge-in is just routing the second press into it.
window.asmltrAssist = (skipCue) => {
  if (state === 'rec') { cancelRec(); return; }
  if (state === 'busy') { stopEverything(); return; }
  startRec(skipCue);
};
// Called by OverlayService when the card should collapse/expand; also usable from the min button.
window.asmltrMinimize = () => { document.body.classList.add('minimized'); if (state === 'rec') stopRec(); const n = nativeOverlay(); if (n && n.setMinimized) try { n.setMinimized(true); } catch (_) {} };
window.asmltrExpand = () => { document.body.classList.remove('minimized'); const n = nativeOverlay(); if (n && n.setMinimized) try { n.setMinimized(false); } catch (_) {} reportPanelHeight(); };
// Tell the native panel window how tall to be so it hugs the card (open sheet → grow to fit the sheet).
function reportPanelHeight() {
  const ov = nativeOverlay(); if (!ov || !ov.setPanelHeight || document.body.classList.contains('minimized')) return;
  const dpr = window.devicePixelRatio || 1;
  const sheetOpen = ($('sheet') && !$('sheet').classList.contains('hidden')) || ($('sessions') && !$('sessions').classList.contains('hidden'));
  const scrH = (window.screen && window.screen.height) || window.innerHeight || 640;
  const h = sheetOpen ? Math.round(scrH * 0.85) : Math.ceil($('card').getBoundingClientRect().height);
  if (h > 0) { try { ov.setPanelHeight(Math.round(h * dpr)); } catch (_) {} }
}

// ---------- overlay chrome ----------
function initOverlayChrome() {
  const card = $('card'), handle = $('grip'); if (!card || !handle) return;
  const dpr = window.devicePixelRatio || 1;
  let sx = 0, sy = 0, ox = 0, oy = 0, lx = 0, ly = 0, dragging = false; const pos = { x: 0, y: 0 };
  // Native drag uses SCREEN coords (screenX/Y) — window-relative clientX shifts as the window moves under
  // the finger, which caused the jitter/feedback loop.
  const down = (e) => { if (e.target.closest('button')) return; dragging = true; const p = e.touches ? e.touches[0] : e; sx = p.clientX; sy = p.clientY; lx = p.screenX; ly = p.screenY; ox = pos.x; oy = pos.y; };
  const move = (e) => {
    if (!dragging) return; const p = e.touches ? e.touches[0] : e; const nat = nativeOverlay();
    if (nat && nat.dragBy) {
      const dx = p.screenX - lx, dy = p.screenY - ly; lx = p.screenX; ly = p.screenY;
      if (dx || dy) { try { nat.dragBy(Math.round(dx * dpr), Math.round(dy * dpr)); } catch (_) {} }
    } else { pos.x = ox + (p.clientX - sx); pos.y = oy + (p.clientY - sy); card.style.transform = `translate(calc(-50% + ${pos.x}px), ${pos.y}px)`; }
    e.preventDefault();
  };
  const up = () => { dragging = false; };
  handle.addEventListener('mousedown', down); handle.addEventListener('touchstart', down, { passive: true });
  window.addEventListener('mousemove', move); window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
  $('min').addEventListener('click', () => { window.asmltrMinimize(); });
  $('minbubble').addEventListener('click', () => { window.asmltrExpand(); if (continuous && state === 'idle') startRec(); });
  // Native panel: cap the log by screen height (px — not window, to avoid circular sizing) and keep the
  // native window height synced to the card via a ResizeObserver.
  if (nativeOverlay()) {
    const logEl = $('log'); if (logEl) logEl.style.maxHeight = Math.round(((window.screen && window.screen.height) || 640) * 0.42) + 'px';
    try { const ro = new ResizeObserver(() => reportPanelHeight()); ro.observe(card); } catch (_) {}
    setTimeout(reportPanelHeight, 150);
  }
  $('close').addEventListener('click', () => { stopEverything(); try { if (window.AsmltrOverlay && window.AsmltrOverlay.close) window.AsmltrOverlay.close(); } catch (_) {} });
}

// ---------- settings ----------
function openSheet(msg) { $('cfgUrl').value = cfg.baseUrl; $('cfgToken').value = cfg.token; $('cfgName').value = cfg.name; $('cfgDevice').value = cfg.deviceId; $('cfgMsg').textContent = msg || ''; if ($('cfgSession')) $('cfgSession').value = (activeTarget && activeTarget.key) || convKey || '(not connected yet)'; if ($('sessMsg')) $('sessMsg').textContent = ''; if ($('cfgAutoListen')) $('cfgAutoListen').checked = autoListenOnOpen(); if ($('cfgSttRt')) $('cfgSttRt').checked = sttRealtimeOn(); if ($('cfgWake')) $('cfgWake').checked = !!wakeCfg.enabled; if ($('cfgWakePhrase')) $('cfgWakePhrase').value = wakeCfg.phrase || ''; if ($('voiceMsg')) $('voiceMsg').textContent = ''; try { loadNotifSettings(); } catch (_) {} $('sheet').classList.remove('hidden'); reportPanelHeight(); }
async function saveVoice() {
  const m = $('voiceMsg'); if (m) m.textContent = 'saving…';
  const enabled = $('cfgWake').checked, phrase = $('cfgWakePhrase').value.trim();
  try {
    const r = await api('/gw/voice-config', { stt: { wake_enabled: enabled, ...(phrase ? { wake_phrase: phrase } : {}) } });
    wakeCfg = { enabled, phrase: (r.stt && r.stt.wake_phrase) || phrase || wakeCfg.phrase };
    try { if (window.AsmltrNative && window.AsmltrNative.refreshWake) window.AsmltrNative.refreshWake(); } catch (_) {}
    if (m) m.textContent = enabled ? '✓ wake word on — say "' + wakeCfg.phrase + '"' : '✓ saved (wake word off)';
  } catch (e) { if (m) m.textContent = '✗ ' + e.message; }
}
// ── notification reader (Part B) settings — backed by the native bridge (SharedPreferences) ──────
const NC = () => (window.AsmltrNative || null);
function loadNotifSettings() {
  const n = NC(); if (!n || !n.getNotifyConfig) { const w = $('cfgNotifDevices'); if (w) w.innerHTML = '<p class="msg">Notification reading needs the native app.</p>'; return; }
  let c = {}; try { c = JSON.parse(n.getNotifyConfig() || '{}'); } catch (_) {}
  if ($('cfgNotif')) $('cfgNotif').checked = !!c.enabled;
  if ($('cfgNotifHp')) $('cfgNotifHp').checked = c.headphones_only !== false;
  if ($('cfgNotifThreshold')) $('cfgNotifThreshold').value = c.threshold != null ? c.threshold : 40;
  if ($('cfgNotifDenied')) $('cfgNotifDenied').value = c.apps_denied || '';
  if ($('cfgNotifHold')) $('cfgNotifHold').checked = c.hold_when_busy !== false;
  if ($('cfgNotifDnd')) $('cfgNotifDnd').checked = c.respect_dnd !== false;
  if ($('cfgNotifNav')) $('cfgNotifNav').checked = c.hold_for_nav !== false;
  if ($('cfgNotifAccessMsg')) $('cfgNotifAccessMsg').textContent = c.access_granted ? '✓ access granted' : '⚠ not granted — tap to grant';
  showGateStatus(c.held || 0);
  // BT/wired device picker: which routes may trigger readout (empty selection = any headphones)
  const wrap = $('cfgNotifDevices'); if (!wrap) return;
  let devs = []; try { devs = JSON.parse((n.listAudioDevices && n.listAudioDevices()) || '[]'); } catch (_) {}
  const chosen = new Set((c.bt_devices || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (!devs.length) { wrap.innerHTML = '<p class="msg">No headphones connected right now. Connect a device to pick it; leave blank to allow any.</p>'; return; }
  wrap.innerHTML = '<p class="msg" style="margin:6px 0 4px">Trigger on these devices (none checked = any headphones):</p>'
    + devs.map((d) => `<label class="check"><input type="checkbox" class="notif-dev" value="${d.address}" ${chosen.has(d.address) ? 'checked' : ''}/> ${d.name} <span style="color:var(--muted)">(${d.type})</span></label>`).join('');
}
async function saveNotifSettings() {
  const n = NC(); const m = $('cfgNotifMsg');
  if (!n || !n.saveNotifyConfig) { if (m) m.textContent = 'needs the native app'; return; }
  const enabled = $('cfgNotif').checked;
  const hp = $('cfgNotifHp').checked;
  const threshold = Math.max(0, Math.min(100, parseInt($('cfgNotifThreshold').value, 10) || 40));
  const denied = ($('cfgNotifDenied').value || '').trim();
  const bt = [...document.querySelectorAll('.notif-dev:checked')].map((e) => e.value).join(',');
  try {
    const hold = $('cfgNotifHold') ? $('cfgNotifHold').checked : true;
    const dnd = $('cfgNotifDnd') ? $('cfgNotifDnd').checked : true;
    const nav = $('cfgNotifNav') ? $('cfgNotifNav').checked : true;
    n.saveNotifyConfig(enabled, hp, threshold, denied, bt, hold, dnd, nav);
    // enabling requires the one-off system Notification-access consent
    if (enabled && n.isNotificationAccessGranted && !n.isNotificationAccessGranted()) { if (m) m.textContent = 'grant notification access to finish →'; if (n.openNotificationAccessSettings) n.openNotificationAccessSettings(); return; }
    if (m) m.textContent = '✓ saved';
  } catch (e) { if (m) m.textContent = '✗ ' + e.message; }
}
// Show why the reader would (or wouldn't) speak right now, plus anything already held. Makes the
// interruption gate legible — otherwise "it went quiet" is indistinguishable from "it broke".
function showGateStatus(held) {
  const el = $('cfgNotifGate'); if (!el) return;
  const n = NC(); let g = {};
  try { g = JSON.parse((n && n.speakGateStatus && n.speakGateStatus()) || '{}'); } catch (_) {}
  const h = held != null ? held : (g.held || 0);
  const now = g.state === 'ok' ? 'free to speak' : (g.reason || 'busy');
  el.textContent = `Right now: ${now}${h ? ` · ${h} held` : ''}`;
}
function closeSheet() { $('sheet').classList.add('hidden'); reportPanelHeight(); }
// Start a fresh conversation: stop anything running, ask the connector to forget the core session, wipe the log.
async function newSession() {
  const m = $('sessMsg'); if (m) m.textContent = 'clearing…';
  stopEverything();
  try { const r = await api('/gw/forget', {}); if (m) m.textContent = r && r.existed ? '✓ context cleared — fresh session' : '✓ fresh session'; }
  catch (e) { if (m) m.textContent = '✗ ' + e.message; return; }
  if (ownTab && activeTab !== ownTab) switchTab(ownTab); // "new session" always clears the OWN device session
  $('log').innerHTML = ''; curBubble = null; resetSubPanel(); stepsEl = null; lastTool = null; resetTTS(); hydrated = true; // fresh session — nothing to rehydrate
  bubble('sys', 'New session started.');
}

// ---------- multi-session tabs (hold several live sessions at once) ----------
// The device holds ONE gateway SSE; the connector tags every frame with its conversation `key`, so we
// demultiplex that single stream into per-session TABS. Each tab owns its own <main class="log"> DOM
// node (detached when backgrounded, remounted on switch) + its own working state (curBubble/lastTool/
// sub-agent panel/hydrated). The ACTIVE tab renders live and drives TTS; background tabs buffer their
// frames (`pending`) and keep accumulating, replaying silently when activated — so nothing is lost on
// switch and only the active tab ever speaks. Tab 0 is this device's own session.
let tabs = [], activeTab = null, ownTab = null, tabSeq = 0;
let activeTarget = null; // mirrors the active tab: {key,surface,title} for an attached session, null for own
function makeTab(o) {
  const logEl = document.createElement('main'); logEl.className = 'log'; logEl.setAttribute('aria-live', 'polite');
  return { id: 't' + (++tabSeq), own: !!o.own, key: o.key || '', surface: o.surface || '', title: o.title || '',
    logEl, curBubble: null, lastTool: null, stepsEl: null, subPanel: null, subRows: {}, hydrated: false,
    pending: [], dirty: false, needsHistory: false };
}
function initTabs() {
  // Adopt the static #log as the own tab's node so existing markup/sizing carries over.
  ownTab = makeTab({ own: true, title: 'Me' }); ownTab.logEl = document.getElementById('log');
  tabs = [ownTab]; activeTab = ownTab; activeTarget = null;
}
// Persist / restore the working globals that belong to whichever tab is currently mounted.
function saveTabState(t) { if (!t) return; t.curBubble = curBubble; t.lastTool = lastTool; t.stepsEl = stepsEl; t.subPanel = subPanel; t.subRows = subRows; t.hydrated = hydrated; }
function restoreTabState(t) { curBubble = t.curBubble; lastTool = t.lastTool; stepsEl = t.stepsEl; subPanel = t.subPanel; subRows = t.subRows; hydrated = t.hydrated; }
// Which tab does a frame belong to? Match on its `key`; keyless pushes (inject/speak/media from /out)
// land on the active tab. A key with no open tab also falls back to the active tab (render live).
function frameTab(m) { if (m && m.key) { const t = tabs.find((x) => x.key === m.key); if (t) return t; } return activeTab; }
function switchTab(tab) {
  if (!tab || tab === activeTab) { if (tab) { tab.dirty = false; updateTabStrip(); } return; }
  // leaving the current tab: stop its mic/readout (TTS follows the active tab only) and stash its state
  if (state === 'rec') stopRec();
  suppressRestart = true; stopDrone(); stopAudio(); resetTTS();
  saveTabState(activeTab);
  const oldEl = activeTab.logEl;
  tab.logEl.id = 'log'; if (nativeOverlay() && oldEl.style.maxHeight) tab.logEl.style.maxHeight = oldEl.style.maxHeight;
  oldEl.removeAttribute('id'); oldEl.replaceWith(tab.logEl); // swap the mounted node
  activeTab = tab; restoreTabState(tab);
  activeTarget = tab.own ? null : { key: tab.key, surface: tab.surface, title: tab.title };
  suppressRestart = false; setState('idle');
  // catch-up: replay everything that streamed in while this tab was backgrounded (no TTS)
  const pend = tab.pending; tab.pending = []; tab.dirty = false;
  for (const fr of pend) renderFrame(fr, false);
  updateTabStrip(); updateTargetBar();
  $('log').scrollTop = $('log').scrollHeight; reportPanelHeight();
}
function closeTab(tab) {
  if (!tab || tab.own) return;                 // the own session tab is permanent
  const wasActive = tab === activeTab;
  const i = tabs.indexOf(tab); if (i >= 0) tabs.splice(i, 1);
  if (wasActive) switchTab(tabs[Math.max(0, i - 1)] || ownTab);
  else updateTabStrip();
}
function updateTabStrip() {
  const strip = $('tabstrip'); if (!strip) return;
  strip.classList.toggle('hidden', tabs.length <= 1);
  strip.innerHTML = '';
  for (const t of tabs) {
    const b = document.createElement('button'); b.className = 'tab' + (t === activeTab ? ' active' : '') + (t.dirty && t !== activeTab ? ' dirty' : '');
    b.setAttribute('role', 'tab');
    const label = t.own ? 'Me' : (t.title || t.key);
    const nm = document.createElement('span'); nm.className = 'tab-name'; nm.textContent = label; b.appendChild(nm);
    b.addEventListener('click', () => switchTab(t));
    if (!t.own) { const x = document.createElement('span'); x.className = 'tab-x'; x.textContent = '✕'; x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t); }); b.appendChild(x); }
    strip.appendChild(b);
  }
  reportPanelHeight();
}
function updateTargetBar() {
  const bar = $('targetBar'); if (!bar) return;
  if (activeTarget) { bar.classList.remove('hidden'); $('targetLabel').textContent = '▸ [' + activeTarget.surface + '] ' + (activeTarget.title || activeTarget.key); }
  else bar.classList.add('hidden');
  reportPanelHeight();
}
function fmtAgo(sec) { if (!sec) return ''; const s = Math.max(0, Date.now() / 1000 - sec); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; }
async function openSessions() {
  $('sessions').classList.remove('hidden'); reportPanelHeight();
  const msg = $('sessMsg2'); if (msg) msg.textContent = 'loading…';
  try { const r = await apiGet('/gw/sessions', {}); renderSessions(r.sessions || []); if (msg) msg.textContent = (r.sessions || []).length + ' active sessions'; }
  catch (e) { if (msg) msg.textContent = '✗ ' + e.message; }
}
function renderSessions(list) {
  const el = $('sessList'); if (!el) return; el.innerHTML = '';
  for (const s of list) {
    const row = document.createElement('div'); row.className = 'sessrow' + (tabs.some((t) => t.key === s.key) ? ' active' : '');
    const head = document.createElement('div'); head.className = 'st';
    const badge = document.createElement('span'); badge.className = 'sess-badge'; badge.textContent = s.surface;
    const title = document.createElement('span'); title.className = 'sess-title'; title.textContent = s.title || s.key;
    head.appendChild(badge); head.appendChild(title);
    const sub = document.createElement('div'); sub.className = 'sess-sub';
    sub.textContent = [fmtAgo(s.updated), s.tools ? s.tools + ' tools' : '', s.status].filter(Boolean).join(' · ') || s.key;
    row.appendChild(head); row.appendChild(sub);
    row.addEventListener('click', () => selectSession(s));
    el.appendChild(row);
  }
}
function renderHistoryItems(items) {
  for (const it of (items || [])) {
    if (it.kind === 'user') bubble('user', it.text);
    else if (it.kind === 'assistant') bubble('assistant', it.text);
    else if (it.kind === 'thinking') addThinking(it.text);
    else if (it.kind === 'tool') addTool(it.name, it.input);
    else if (it.kind === 'tool_result') addToolResult(it.output, it.is_error);
    else if (it.kind === 'subagent') addSubagent(it);
    else if (it.kind === 'media') mediaBubble('assistant', it);
  }
  curBubble = null; // a live delta must start a fresh bubble, not append onto a historical one
  $('log').scrollTop = $('log').scrollHeight;
}
// Selecting a session OPENS it as a tab (or focuses its existing tab) — sessions stay live side-by-side
// instead of swapping the single view. First open lazily loads its history into the new tab.
async function selectSession(s) {
  $('sessions').classList.add('hidden');
  const existing = tabs.find((t) => t.key === s.key);
  if (existing) { switchTab(existing); reportPanelHeight(); return; }
  const tab = makeTab({ key: s.key, surface: s.surface, title: s.title || s.key });
  tabs.push(tab); switchTab(tab); tab.hydrated = true; hydrated = true; // this tab owns its own history
  bubble('sys', 'Loaded [' + s.surface + '] ' + (s.title || s.key) + ' — your next message goes here.');
  try { const r = await apiGet('/gw/history', { key: s.key, limit: '80' }); if (activeTab === tab) renderHistoryItems(r.items); }
  catch (e) { if (activeTab === tab) bubble('sys', '⚠ history: ' + e.message); }
  reportPanelHeight();
}
// Rehydrate THIS device's own conversation on (re)open — the core session persists even though the WebView
// was destroyed on close, so show the history bubbles instead of a blank window. Lazy: recent window + a
// tap-to-load-earlier chip.
async function hydrateOwn(key, limit) {
  if (!key) return; hydrated = true; limit = limit || 60;
  try {
    const r = await apiGet('/gw/history', { key, limit: String(limit) });
    const items = r.items || [];
    $('log').innerHTML = ''; curBubble = null; resetSubPanel(); lastTool = null;
    if (items.length >= limit) { const e = document.createElement('div'); e.className = 'sys-earlier'; e.textContent = '↑ load earlier messages'; e.addEventListener('click', () => hydrateOwn(key, limit + 200)); $('log').appendChild(e); }
    renderHistoryItems(items);
  } catch (_) {}
  reportPanelHeight();
}
// The targetBar "close tab" button closes the current attached tab (returns to whatever's behind it).
function leaveTarget() { if (activeTab && !activeTab.own) closeTab(activeTab); }
async function testConn() { const base = $('cfgUrl').value.trim().replace(/\/+$/, ''); $('cfgMsg').textContent = 'testing…'; try { const r = await fetch(base + '/health'); const j = await r.json(); $('cfgMsg').textContent = j.status === 'ok' ? '✓ reachable' : 'unexpected'; } catch (e) { $('cfgMsg').textContent = '✗ ' + e.message; } }

// ---------- wire up ----------
function init() {
  initTabs(); // the own-device session tab (tab 0) must exist before any frame/hydrate lands
  if (OVERLAY) { document.documentElement.style.background = 'transparent'; document.body.classList.add('overlay'); if (NATIVE) document.body.classList.add('native'); initOverlayChrome(); }
  $('agentName').textContent = cfg.agentName || 'assistant';
  try { voiceOrb.start(); } catch (_) {}   // the reactive orb-face replaces the old mic icon
  setMuted(muted);
  $('mute').addEventListener('click', () => setMuted(!muted));
  $('talk').addEventListener('click', () => { if (state === 'rec') stopRec(); else if (state === 'busy') stopEverything(); else startRec(); });
  $('settingsBtn').addEventListener('click', () => openSheet());
  if ($('sessionsBtn')) $('sessionsBtn').addEventListener('click', openSessions);
  if ($('sessRefresh')) $('sessRefresh').addEventListener('click', openSessions);
  if ($('targetLeave')) $('targetLeave').addEventListener('click', leaveTarget);
  if ($('sessions')) $('sessions').addEventListener('click', (e) => { if (e.target === $('sessions')) { $('sessions').classList.add('hidden'); reportPanelHeight(); } });
  if ($('cfgAutoListen')) $('cfgAutoListen').addEventListener('change', (e) => setAutoListen(e.target.checked)); // device-local, persists immediately
  if ($('cfgSttRt')) $('cfgSttRt').addEventListener('change', (e) => setSttRealtime(e.target.checked)); // device-local streaming-STT toggle
  if ($('cfgVoiceSave')) $('cfgVoiceSave').addEventListener('click', saveVoice);
  if ($('cfgNotifSave')) $('cfgNotifSave').addEventListener('click', saveNotifSettings);
  if ($('cfgNotifAccess')) $('cfgNotifAccess').addEventListener('click', () => { const n = NC(); if (n && n.openNotificationAccessSettings) n.openNotificationAccessSettings(); });
  if ($('cfgNotifTest')) $('cfgNotifTest').addEventListener('click', () => {
    const n = NC(); const m = $('cfgNotifMsg');
    if (!n || !n.testHeldBadge) { if (m) m.textContent = 'needs the native app'; return; }
    n.testHeldBadge();
    if (m) m.textContent = '✓ badge raised — find the eyes in the corner';
    setTimeout(() => showGateStatus(), 300);
  });
  if ($('cfgNewSession')) $('cfgNewSession').addEventListener('click', newSession);
  if ($('cfgRemoteDesktop')) $('cfgRemoteDesktop').addEventListener('click', () => { location.href = 'remote-desktop.html'; });
  $('cfgTest').addEventListener('click', testConn);
  $('cfgSave').addEventListener('click', () => {
    cfg.baseUrl = $('cfgUrl').value.trim().replace(/\/+$/, ''); cfg.token = $('cfgToken').value.trim(); cfg.name = $('cfgName').value.trim() || 'My device'; saveCfg(cfg);
    try { if (window.AsmltrNative && window.AsmltrNative.saveConfig) window.AsmltrNative.saveConfig(cfg.baseUrl, cfg.token, cfg.name); } catch (_) {}
    closeSheet(); applyTheme(); connect();
  });
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  const send = () => { const v = $('kbd').value.trim(); if (!v || state === 'busy') return; $('kbd').value = ''; sendTurn(v); };
  $('kbdSend').addEventListener('click', send);
  $('kbd').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  applyTheme(); connect();
}
document.addEventListener('DOMContentLoaded', init);
