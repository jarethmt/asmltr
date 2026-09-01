'use strict';
/**
 * Grok engine — headless adapter over the official Grok Build CLI (`grok`).
 *
 * Mirrors Gemini/Codex (spawn + NDJSON), NOT the Claude Agent SDK.
 * Subscription/CLI auth only: the child inherits the operator's ~/.grok/auth.json
 * and we STRIP XAI_API_KEY so the CLI cannot fall through to metered API billing.
 *
 * Harness turns are headless (`--prompt-file` ACP JSON), never the TUI and never `-p` /
 * `--prompt-json` on argv (CAST + stills would land in `ps`; Linux ARG_MAX is 2MB / spawn E2BIG).
 * `--prompt-file` / ffmpeg downscale are Grok CLI only. Other engines never see those
 * flags: runner passes extra runTurn fields; Claude/Gemini/Codex ignore what they
 * don't destructure. Claude vision stays SDK image blocks on `images`.
 * No spawn watchdog and no CLI turn cap. Operator abort (abortController) only.
 *
 * RESUME UUID (Grok-specific — do not drop):
 *   Sessions are UUIDs (UUIDv7 when the CLI assigns one). `-s/--session-id` CREATES
 *   a new session; it does not resume. `-r/--resume <uuid>` resumes. `-c/--continue`
 *   is cwd-implicit and too loose for asmltr. On a fresh turn we pass `-s <uuid>` so
 *   we have an addressable id even if JSON parse misses `.sessionId`. On resume we
 *   pass `-r <uuid>` only. `--fork-session` / `--restore-code` / `grok sessions` /
 *   `grok export` are preserved as notes, not wired. See /workspace/grok-cli-features.md.
 *
 * historyReplaysSystemPrompt is TRUE: live-verified 2026-08-17 that `-r <uuid>`
 * replays the first-turn system block (probe: "What were you instructed to be?" →
 * "A one-word ping fixture."). ASMLTR_INJECT_ONCE=off remains the kill-switch.
 */
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engines = require('../../../shared/engines');
const { isDiscordVoice } = require('../../../shared/media-allow');
const { composePrompt } = require('../../../shared/prompt-compose');
const gcTemps = require('../../../shared/gc-temps');
const { buildImageGenClassifyPrompt, parseImageGenVerdict, hasStillThisTurn, pictureIntentClassifyText, shouldClassifyPictureIntent } = require('../../../shared/image-gen-ask');

const id = 'grok';
const cheapModel = process.env.ASMLTR_GROK_TITLE_MODEL || 'grok-4.6';

/** Exact From address for owner-from helpers. Empty = unset. Never hardcode a real address. */
function ownerFromEmail() {
  return String(process.env.ASMLTR_OWNER_FROM_EMAIL || '').trim().toLowerCase();
}

function isEmailChannel(channel) {
  return String(channel || '').trim().toLowerCase() === 'email';
}

function isMcpChannel(channel) {
  return String(channel || '').trim().toLowerCase() === 'mcp';
}

function isWebChannel(channel) {
  const c = String(channel || '').trim().toLowerCase();
  return c === 'assistant-web' || c === 'assistant-native'
    || c === 'eve-assistant-web' || c === 'eve-assistant-native';
}

/** Bare addr from `Name <addr@host>` or `addr@host`. Display-name-only → empty. */
function parseEmailAddress(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const angled = s.match(/<\s*([^<>@\s]+@[^<>@\s]+)\s*>/);
  if (angled) return angled[1].toLowerCase();
  const bare = s.match(/^([^<>@\s]+@[^<>@\s]+)$/);
  if (bare) return bare[1].toLowerCase();
  return '';
}

/** From/sender email on the turn. Email connector puts the bare From in sender.raw_id. */
function extractSenderEmail(opts) {
  if (opts == null) return '';
  if (typeof opts === 'string') return parseEmailAddress(opts);
  const bags = [];
  const sender = opts.sender;
  if (sender && typeof sender === 'object') bags.push(sender);
  else if (typeof sender === 'string') bags.push({ raw_id: sender });
  bags.push(opts);
  const keys = ['email', 'from', 'address', 'raw_id', 'raw_username', 'senderEmail'];
  for (const bag of bags) {
    for (const k of keys) {
      if (bag[k] == null) continue;
      const addr = parseEmailAddress(bag[k]);
      if (addr) return addr;
    }
  }
  return '';
}

function isOwnerFromEmail(opts) {
  const owner = ownerFromEmail();
  if (!owner) return false;
  return extractSenderEmail(opts) === owner;
}

// Reasoning effort — always pass `--effort <level>` (CLI alias of --reasoning-effort).
//   Baseline is ASMLTR_GROK_EFFORT (this install: medium). envEffort() if unset still
//   || 'high' so other installs keep the old default. xhigh is NOT the default.
//   medium  normal conversation (Discord baseline)
//   high    lookup/research, Corona (recipe/cigar/cooking), Rolodex/contacts,
//           standard troubleshooting/diagnosis/"why is X slow"/look it up/search.
//           Not a coding session. Web channels are always this after one-shot.
//   xhigh   git or a coding session, or a deep dive (implement, refactor,
//           write/patch code, commit+push, PR, "deep dive"), or a still-gen
//           ask (kind word + gpt-5-nano YES/NO on the moderation key in
//           runTurn, not the sync word picker). Bare "code" is not xhigh.
//           Project git cwd that is not $HOME.
//           Email and MCP are always xhigh (even vs one-shot / +xh).
//   HOME is never a project. Never use process.cwd() (the asmltr clone is a git
//   repo and would xhigh every ask). Use the session/turn cwd if provided.
//   Score opts.effortPrompt when set (current user message only) — NOT
//   drainObserved/catch-up glued onto prompt in server.js.
//   Tight: do not treat bare "fix" as xhigh (other agents' "Proposed Fix", "quick fix").
//   One-shot next-effort wins on Discord/web, not on email/mcp. complete() skips auto-raise.
//   Web (assistant-web, assistant-native, eve-assistant-web, eve-assistant-native)
//   is always high AFTER one-shot/explicit. No +h/+xh, no word picker.
//   Email (`email`) and MCP (`mcp`) force xhigh always (a chatty body
//   with no code words is still xhigh). Discord VOICE (`discord-voice:` /
//   channel_context.voice) is always low — lookup/code words do not raise
//   it. Discord TEXT keeps the three-tier picker
//   (+h/+xh/word/git). Do not inherit last effort. Do not use a generic
//   XHIGH_CHANNELS list. No spawn kill timer. No CLI turn cap. Do not apply
//   Claude maxTurns or ASMLTR_MAX_THINKING_TOKENS here.
//   Operator one-shot: write ~/.asmltr/next-effort (one line). Consumed once at the
//   next grok -p spawn. sessions.next_effort is the same one-shot per key.
//   Whole-word +xh / +h (whitespace-split, start/end/standalone) override to
//   xhigh / high for this turn only when the sender is owner/bypass or their
//   raw Discord id is in ASMLTR_GROK_EFFORT_ELEVATE_IDS. Honored token is
//   stripped from effortPrompt and the grok user prompt. Unknown senders keep
//   the token and stay on the picker. After one-shot / explicit; wins over
//   three-tier and email. Web ignores the token. Do not persist nextEffort
//   from the token. No owner snowflake in git.
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
// xhigh: coding session / git / deep dive / image gen. No bare \bfix\b or \bcode\b.
const XHIGH_PARTS = [
  'implement(?:ing|ation)?',
  'refactor(?:ing)?',
  'debug(?:ging)?',
  'deep\\s*div(?:e|ing)',
  'pull[\\s-]?requests?',
  'prs?',
  'git',
  'coding',
  'codebase',
  'write(?:ing)?\\s+(?:some\\s+|the\\s+|this\\s+|a\\s+|an\\s+)?(?:code|patch|function|module|helper|adapter)',
  'patch(?:ing)?\\s+(?:the\\s+|this\\s+|some\\s+|a\\s+)?(?:code|file|module|function|repo|branch)',
];
const XHIGH_RE = new RegExp('\\b(?:' + XHIGH_PARTS.join('|') + ')\\b', 'i');
// high: find / read / recall. Not a coding session.
const HIGH_PARTS = [
  'look(?:ing)?\\s+(?:it\\s+)?up',
  'look(?:ing)?\\s+into',
  'lookup',
  'research(?:ing)?',
  'corona',
  'recipes?',
  'cigars?',
  'cooking',
  'contacts',
  'troubleshoot(?:ing)?',
  'diagnos(?:e|is|ing)',
  'search(?:ing)?',
];
const HIGH_RE = new RegExp('\\b(?:' + HIGH_PARTS.join('|') + ')\\b', 'i');
const WHY_SLOW_RE = /\bwhy\s+is\b[\s\S]{0,60}?\bslow\b/i;
const LAST_EFFORT_FILE = '/tmp/asmltr-last-effort';

function nextEffortFile() {
  return process.env.ASMLTR_GROK_NEXT_EFFORT_FILE || path.join(os.homedir(), '.asmltr', 'next-effort');
}

function normalizeEffort(v) {
  const s = String(v || '').trim().toLowerCase();
  return VALID_EFFORTS.includes(s) ? s : null;
}

/** Current user message only when opts.effortPrompt is set (skip catch-up glue). */
function scoringPrompt(opts) {
  opts = opts || {};
  if (opts.effortPrompt != null) return String(opts.effortPrompt);
  return String(opts.prompt || '');
}

function elevateIdSet() {
  const raw = process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS || '';
  return new Set(raw.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean));
}

/** Owner / bypass identity, or raw sender id in ASMLTR_GROK_EFFORT_ELEVATE_IDS. */
function canElevateEffort(opts) {
  opts = opts || {};
  if (opts.bypass === true || opts.bypass_moderation === true) return true;
  if (opts.owner === true) return true; // core-set after trust, not a client user_key
  let sid = opts.senderId;
  if (sid == null && opts.sender && typeof opts.sender === 'object') sid = opts.sender.raw_id;
  else if (sid == null) sid = opts.sender;
  sid = String(sid || '').trim();
  if (!sid) return false;
  return elevateIdSet().has(sid);
}

/** Whole-word +xh / +h only. +xh wins if both present. */
function detectElevateToken(text) {
  const toks = String(text || '').split(/\s+/).filter(Boolean);
  if (toks.some((t) => t.toLowerCase() === '+xh')) return '+xh';
  if (toks.some((t) => t.toLowerCase() === '+h')) return '+h';
  return null;
}

function stripElevateToken(text, token) {
  if (!token || text == null) return text;
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text)
    .replace(new RegExp('(^|\\s)' + escaped + '(?=\\s|$)', 'gi'), '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+|\s+$/g, '');
}

function matchToken(re, text) {
  const m = String(text || '').match(re);
  if (!m) return '';
  return String(m[0]).toLowerCase().replace(/\s+/g, ' ').slice(0, 32);
}

/** True if this post contains both whole words commit and push. Bare commit is not xhigh. */
function commitAndPushSamePost(text) {
  const s = String(text || '');
  return /\bcommit\b/i.test(s) && /\bpush\b/i.test(s);
}

function xhighReason(prompt) {
  const s = String(prompt || '');
  const m = matchToken(XHIGH_RE, s);
  if (m) return m;
  if (commitAndPushSamePost(s)) return 'commit-push';
  return '';
}

/** After classifyEffort: picture-request verdict may raise Discord/telegram to xhigh. Web/email/mcp keep their effort. */
function raiseForImageGen(classified, opts = {}) {
  const imageGen = opts.imageGen;
  const channel = opts.channel;
  const out = {
    effort: classified && classified.effort,
    reason: classified && classified.reason,
    imageGen: !!imageGen,
  };
  if (!imageGen) return out;
  if (isWebChannel(channel) || isEmailChannel(channel) || isMcpChannel(channel)) return out;
  if (isDiscordVoice(opts)) return out;
  if (out.effort !== 'xhigh') {
    out.effort = 'xhigh';
    out.reason = 'image-gen';
  }
  return out;
}

function imageGenClassifyOff() {
  const v = String(process.env.ASMLTR_IMAGE_GEN_CLASSIFY || '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'false' || v === 'no';
}

function highReason(prompt) {
  const s = String(prompt || '');
  const m = matchToken(HIGH_RE, s);
  if (m) return m;
  if (WHY_SLOW_RE.test(s)) return 'why-slow';
  return '';
}

function looksLikeCode(prompt) {
  return !!xhighReason(prompt);
}

function looksLikeLookup(prompt) {
  return !!highReason(prompt);
}

function isProjectGitRepo(cwd) {
  if (!cwd || typeof cwd !== 'string') return false;
  let resolved;
  try { resolved = path.resolve(cwd); } catch (_) { return false; }
  let home = '';
  try { home = path.resolve(os.homedir()); } catch (_) {}
  // HOME is not a project even if it has .git.
  if (home && resolved === home) return false;
  try { return fs.existsSync(path.join(resolved, '.git')); } catch (_) { return false; }
}

function envEffort() {
  return normalizeEffort(process.env.ASMLTR_GROK_EFFORT) || 'high';
}

/** Consume ~/.asmltr/next-effort once (deleted even if invalid). */
function consumeNextEffortFile() {
  const p = nextEffortFile();
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    try { fs.unlinkSync(p); } catch (_) {}
    return normalizeEffort(raw.split(/\r?\n/)[0]);
  } catch (_) { return null; }
}

function consumeSessionNextEffort(conversationKey) {
  if (!conversationKey) return null;
  try { return require('../sessions').consumeNextEffort(conversationKey); } catch (_) { return null; }
}

/** File wins over session column. Both are one-shot. */
function takeNextEffort(conversationKey) {
  return consumeNextEffortFile() || consumeSessionNextEffort(conversationKey);
}

/**
 * Classify effort for this argv. Does NOT consume the next-effort file.
 * Priority: nextEffort / opts.effort → auto xhigh/high (current message or project git cwd) → env.
 * complete() skips auto-raise (cheap title/status calls).
 */
function classifyEffort(opts) {
  opts = opts || {};
  if (opts.complete) return { effort: normalizeEffort(opts.effort) || envEffort(), reason: 'complete' };
  // Email and MCP are always xhigh. Do not let one-shot / +xh / the word picker
  // drop a mailbox turn to medium. Server must pass opts.channel or this is a no-op.
  if (isEmailChannel(opts.channel)) return { effort: 'xhigh', reason: 'email' };
  if (isMcpChannel(opts.channel)) return { effort: 'xhigh', reason: 'mcp' };
  // Voice turns stay low even if the utterance has lookup/code words.
  if (isDiscordVoice(opts)) return { effort: 'low', reason: 'discord-voice' };
  const oneshotNext = normalizeEffort(opts.nextEffort);
  if (oneshotNext) return { effort: oneshotNext, reason: 'oneshot' };
  const oneshotExplicit = normalizeEffort(opts.effort);
  if (oneshotExplicit) return { effort: oneshotExplicit, reason: 'explicit' };
  // After one-shot/explicit: web is always high (no token, no word picker).
  if (isWebChannel(opts.channel)) return { effort: 'high', reason: 'web' };
  const token = detectElevateToken(scoringPrompt(opts));
  if (token && canElevateEffort(opts)) {
    return { effort: token === '+xh' ? 'xhigh' : 'high', reason: 'token:' + token, stripToken: token };
  }
  const scored = scoringPrompt(opts);
  const codeTok = xhighReason(scored);
  const git = isProjectGitRepo(opts.cwd);
  if (codeTok || git) return { effort: 'xhigh', reason: codeTok ? 'code:' + codeTok : 'git-cwd' };
  const lookTok = highReason(scored);
  if (lookTok) return { effort: 'high', reason: 'lookup:' + lookTok };
  return { effort: envEffort(), reason: 'baseline' };
}

function chooseEffort(opts) {
  return classifyEffort(opts).effort;
}

/** Spawn-time: consume one-shot then choose. */
function effortForTurn(opts) {
  opts = opts || {};
  const nextEffort = opts.nextEffort !== undefined ? normalizeEffort(opts.nextEffort) : takeNextEffort(opts.conversationKey);
  return chooseEffort(Object.assign({}, opts, { nextEffort }));
}

function recordLastEffort(effort, meta) {
  try {
    const m = meta || {};
    const scored = scoringPrompt(m);
    const line = [
      String(effort),
      'cwd=' + (m.cwd || ''),
      'next=' + (m.nextEffort || ''),
      'code=' + (looksLikeCode(scored) ? '1' : '0'),
      'git=' + (isProjectGitRepo(m.cwd) ? '1' : '0'),
      'reason=' + String(m.reason || ''),
    ].join(' ');
    fs.writeFileSync(LAST_EFFORT_FILE, line + '\n');
  } catch (_) {}
}

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Resume hook: -r for an existing UUID; never -s (create-only) and never bare -c. */
function resumeArgs(resume) {
  if (resume && isUuid(resume)) return ['-r', resume];
  return [];
}

function bin() {
  const b = engines.resolveBin('grok');
  if (!b) throw new Error('grok CLI is not installed (curl https://x.ai/cli/install.sh — not npm). Set ASMLTR_GROK_BIN or put grok on PATH (~/.grok/bin/grok).');
  return b;
}

/** Child env: inherit the process, but never pass XAI_API_KEY (subscription only). */
function launchEnv(base) {
  const env = { ...(base || process.env) };
  delete env.XAI_API_KEY;
  delete env.XAI_VOICE_API_KEY;
  delete env.xai_voice_api_key;
  try { return require('../../../shared/bounce').withGuardPath(env); } catch (_) { return env; }
}

/**
 * Build grok argv for a harness turn or a cheap complete().
 * @param {{ prompt: string, systemPrompt?: string, resume?: string|null, cwd?: string, model?: string, complete?: boolean, sessionId?: string }} opts
 */
const VISION_MAX = 8 * 1024 * 1024;
const VISION_MAX_COUNT = 5;
const VISION_TARGET = 400 * 1024;
// File cap, not argv. Inline `--prompt-json` hits Linux ARG_MAX (2MB) once CAST + a still land in JSON.
const PROMPT_JSON_BUDGET = 8_000_000;

function downscaleForVision(buf, mime) {
  if (!buf || buf.length <= VISION_TARGET) return { buf, mime };
  const ffmpeg = '/usr/bin/ffmpeg';
  if (!fs.existsSync(ffmpeg)) return { buf, mime };
  const id = crypto.randomBytes(4).toString('hex');
  const dir = ensureVisionPromptDir();
  const inp = path.join(dir, 'asmltr-vis-in-' + id);
  const outp = path.join(dir, 'asmltr-vis-out-' + id + '.jpg');
  try {
    fs.writeFileSync(inp, buf, { mode: 0o600 });
    try { fs.chmodSync(inp, 0o600); } catch (_) {}
    execFileSync(ffmpeg, ['-y', '-i', inp, '-vf', "scale='min(1600,iw)':-1", '-q:v', '5', outp], {
      timeout: 20000, stdio: 'ignore',
    });
    try { fs.chmodSync(outp, 0o600); } catch (_) {}
    const out = fs.readFileSync(outp);
    if (out.length >= 12 && out.length < buf.length) return { buf: out, mime: 'image/jpeg' };
  } catch (_) {
  } finally {
    try { fs.unlinkSync(inp); } catch (_) {}
    try { fs.unlinkSync(outp); } catch (_) {}
  }
  return { buf, mime };
}

function collectVisionImages(opts) {
  const inbound = require('../../../shared/inbound-media');
  const out = [];
  const seen = new Set();
  const add = (data, mime, key, name) => {
    if (!data || out.length >= VISION_MAX_COUNT) return;
    let raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'base64');
    if (raw.length < 12 || raw.length > VISION_MAX) return;
    const classified = inbound.classify(raw, mime, name || 'vision.bin');
    if (!classified.kind || classified.kind !== 'image') return;
    const fp = raw.length + ':' + raw.subarray(0, 32).toString('hex') + ':' + raw.subarray(-16).toString('hex');
    if ((key && seen.has('p:' + key)) || seen.has(fp)) return;
    seen.add(fp);
    if (key) seen.add('p:' + key);
    const scaled = downscaleForVision(raw, classified.mime || mime);
    raw = scaled.buf;
    const mimeType = (String(scaled.mime || classified.mime || '').startsWith('image/')
      ? String(scaled.mime || classified.mime).split(';')[0].trim() : '') || 'image/jpeg';
    out.push({ type: 'image', mimeType, data: raw.toString('base64') });
  };
  for (const img of opts.images || []) {
    if (img && img.data) add(img.data, img.media_type, img.path || null, img.name);
  }
  for (const f of opts.mediaFiles || []) {
    if (!f || f.kind !== 'image' || !f.path) continue;
    try {
      const st = fs.statSync(f.path);
      if (!st.isFile() || st.size > VISION_MAX) continue;
      add(fs.readFileSync(f.path), f.mime, f.path, f.name);
    } catch (_) {}
  }
  return out;
}

function acpPromptJson(text, vision) {
  const content = [{ type: 'text', text: String(text || '') }];
  for (const im of vision || []) {
    if (im && im.data && im.mimeType) content.push({ type: 'image', mimeType: im.mimeType, data: im.data });
  }
  return JSON.stringify({ type: 'acp', content });
}

function visionPromptDir() { return gcTemps.visPromptDir(); }
function ensureVisionPromptDir() { return gcTemps.ensureVisPromptDir(); }
/** Crash leftovers in ~/.asmltr/vis-prompt (0700). Own prefix only. */
function gcVisionPromptFiles(maxAgeMs) {
  return gcTemps.gcVisionPromptFiles(maxAgeMs == null ? 60 * 60 * 1000 : maxAgeMs);
}

let _visionPromptGc = false;
function gcVisionPromptFilesOnce() {
  if (_visionPromptGc) return;
  _visionPromptGc = true;
  try { gcVisionPromptFiles(); } catch (_) {}
}

/** 0600 ACP JSON for `--prompt-file`. Caller unlinks. Never log the body (stills). */
function writeVisionPromptFile(json) {
  const dir = ensureVisionPromptDir();
  const p = path.join(dir, 'asmltr-vis-prompt-' + crypto.randomBytes(8).toString('hex') + '.json');
  fs.writeFileSync(p, json, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (_) {}
  return p;
}

function buildArgs(opts) {
  const classified = classifyEffort(opts);
  const userPrompt = classified.stripToken
    ? stripElevateToken(opts.prompt, classified.stripToken)
    : opts.prompt;
  const inbound = require('../../../shared/inbound-media');
  const refs = [];
  for (const f of opts.mediaFiles || []) {
    if (f && f.path && (f.kind === 'image' || f.kind === 'video')) refs.push(f);
  }
  for (const img of opts.images || []) {
    if (img && img.path && refs.every((r) => r.path !== img.path)) {
      refs.push({ kind: 'image', path: img.path, mime: img.media_type, name: img.name });
    } else if (img && img.data && !img.path) {
      try {
        const saved = inbound.saveRef(Buffer.from(img.data, 'base64'), { name: img.name, mime: img.media_type });
        if (saved.ok) refs.push(saved);
      } catch (_) {}
    }
  }
  let vision = collectVisionImages(opts);
  const prompt = composePrompt(opts.systemPrompt, userPrompt + inbound.promptBlock(refs, { vision: vision.length > 0 }));
  const args = ['--no-auto-update'];
  let visionPromptFile = null;
  let json = acpPromptJson(prompt, vision);
  while (json.length > PROMPT_JSON_BUDGET && vision.length > 1) {
    vision = vision.slice(0, -1);
    json = acpPromptJson(prompt, vision);
  }
  if (json.length > PROMPT_JSON_BUDGET) {
    vision = [];
    json = acpPromptJson(prompt, []);
  }
  if (json.length <= PROMPT_JSON_BUDGET) {
    visionPromptFile = writeVisionPromptFile(json);
    args.push('--prompt-file', visionPromptFile);
  } else {
    // Pathological size: text-only still over budget. Last resort — prompt on argv.
    args.push('-p', prompt);
  }
  args.push('--output-format', opts.complete ? 'plain' : 'streaming-json');
  args.push('--always-approve');
  const disallowed = [];
  // Core flag: denyAll (policyFor deny.all) empties tools BEFORE spawn. Voice is not deny-all.
  const denyAll = !!opts.denyAll;
  if (denyAll) {
    // Empty allow-list = tools:[]. grok only keeps listed built-ins.
    args.push('--tools', '');
    args.push('--disable-web-search');
    args.push('--no-subagents');
    args.push('--deny', 'MCPTool');
    disallowed.push(
      'web_search', 'web_fetch', 'run_terminal_cmd', 'bash', 'shell',
      'search_replace', 'read_file', 'grep', 'list_dir', 'todo_write', 'task',
      'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'Agent',
    );
    args.push('--deny', 'Bash');
    args.push('--deny', 'Edit');
    args.push('--deny', 'Write');
    args.push('--deny', 'web_search');
    args.push('--deny', 'web_fetch');
  }
  if (opts.denyShell) {
    disallowed.push('bash', 'shell', 'run_terminal_cmd');
    args.push('--deny', 'Bash');
  }
  if (opts.denyWrite) {
    disallowed.push('search_replace');
    args.push('--deny', 'Edit');
    args.push('--deny', 'Write');
  }
  if (opts.denyVideo) {
    disallowed.push('image_to_video', 'reference_to_video');
    args.push('--deny', 'image_to_video');
    args.push('--deny', 'reference_to_video');
  }
  if (opts.denyImage) {
    disallowed.push('image_gen', 'image_edit');
    args.push('--deny', 'image_gen');
    args.push('--deny', 'image_edit');
  }
  if (disallowed.length) args.push('--disallowed-tools', disallowed.join(','));
  args.push('--effort', classified.effort);
  if (opts.cwd) args.push('--cwd', opts.cwd);
  const mdl = opts.model || (opts.complete ? cheapModel : engines.modelFor('grok'));
  if (mdl) args.push('-m', mdl);
  if (opts.resume && isUuid(opts.resume)) {
    args.push(...resumeArgs(opts.resume));
  } else if (opts.sessionId && isUuid(opts.sessionId)) {
    // Fresh session: pre-assign a UUID so we can resume later even if JSON omits sessionId.
    args.push('-s', opts.sessionId);
  }
  args.visionPromptFile = visionPromptFile;
  return args;
}

function parseLine(line) {
  const s = String(line || '').trim();
  if (!s || s[0] !== '{') return null;
  try { return unwrapSessionUpdate(JSON.parse(s)); } catch (_) { return null; }
}

/** ACP session/update (updates.jsonl / some CLI stdout) → the streaming-json shapes applyEvent already knows. */
function unwrapSessionUpdate(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  const u = ev.params && ev.params.update;
  if (!u || !u.sessionUpdate) return ev;
  const k = u.sessionUpdate;
  const chunk = (u.content && (u.content.text || u.content)) || '';
  if (k === 'agent_thought_chunk') return { type: 'thought', text: String(chunk) };
  if (k === 'agent_message_chunk') return { type: 'text', data: String(chunk) };
  // tool_call already arrives as streaming-json {type:tool_call}; do not double-count ACP tool_call.
  return ev;
}

function sessionIdFrom(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.sessionId, obj.session_id,
    obj.end && (obj.end.sessionId || obj.end.session_id),
    obj.data && (obj.data.sessionId || obj.data.session_id),
  ];
  for (const c of candidates) if (isUuid(c)) return c;
  return null;
}

function joinText(prev, next) {
  if (next == null || next === '') return prev || '';
  if (prev == null || prev === '') return next;
  if (/^\s/.test(next) || /\s$/.test(prev)) return prev + next;
  return prev + next;
}

/** Finished narration/answer block, not a token piece like "The" or " I'll". */
function isCompleteBlock(s) {
  const t = String(s || '').trim();
  if (t.length < 20) return false;
  return t.split(/\s+/).filter(Boolean).length >= 4;
}

function closeTextBlock(state) {
  const cur = String((state && state.text) || '').trim();
  if (!cur) return '';
  if (!Array.isArray(state.segments)) state.segments = [];
  state.segments.push(cur);
  state.text = '';
  return cur;
}

/** Finished thought summary (grok.com-style chips), not a streaming token. */
function closeThinking(state) {
  const cur = String((state && state.thinking) || '');
  if (state) state.thinking = '';
  return cur;
}

function isThoughtType(t) {
  const s = String(t || '').toLowerCase();
  return s === 'thought' || s === 'thinking' || s === 'reasoning'
    || s === 'agent_thought' || s === 'agent_thought_chunk'
    || s === 'thought_summary' || s === 'redacted_thinking';
}

function extractText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const t = obj.type;
  if (isThoughtType(t) || t === 'error') return '';
  // Never trim data/delta/text — official grok CLI puts the leading space on the next token.
  if (typeof obj.delta === 'string') return obj.delta;
  if (typeof obj.text === 'string') return obj.text;
  // grok 1.0.5 streaming-json: {"type":"text","data":"..."}
  if (typeof obj.data === 'string') return obj.data;
  if (obj.data && typeof obj.data.text === 'string') return obj.data.text;
  if (typeof obj.content === 'string') return obj.content;
  if (obj.content && typeof obj.content.text === 'string') return obj.content.text;
  if (obj.message && typeof obj.message.content === 'string') return obj.message.content;
  return '';
}

function extractUsage(obj) {
  const u = (obj && (obj.usage || (obj.end && obj.end.usage) || obj.stats)) || null;
  if (!u || typeof u !== 'object') return null;
  return {
    tokens_in: u.input_tokens || u.prompt_tokens || u.prompt || u.tokens_in || 0,
    tokens_out: u.output_tokens || u.completion_tokens || u.candidates || u.tokens_out || 0,
  };
}

/**
 * Fold one parsed event into turn state. Defensive across CLI versions.
 * @returns {{ kind: string, text?: string, tool?: object, thinking?: string, error?: string }}
 */
function toolNameOf(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const raw = ev.name || ev.title || ev.kind
    || (ev.toolCall && ev.toolCall.name)
    || (ev.tool_call && ev.tool_call.name)
    || (ev.tool && ev.tool.name)
    || ev.toolName
    || '';
  const s = String(raw || '').trim();
  if (!s) return '';
  const typ = String(ev.type || ev.event || '');
  if (s === typ || /^(tool_call|tool_call_update|tool_use|function_call)$/i.test(s)) return '';
  return s;
}

function applyEvent(ev, state) {
  if (!ev || typeof ev !== 'object') return { kind: 'ignore' };
  const sid = sessionIdFrom(ev);
  if (sid) state.engineSessionId = sid;
  const usage = extractUsage(ev);
  if (usage) { state.usage.tokens_in = usage.tokens_in || state.usage.tokens_in; state.usage.tokens_out = usage.tokens_out || state.usage.tokens_out; }

  const t = ev.type || ev.event || '';
  if (isThoughtType(t)) {
    const th = ev.text || ev.thought || ev.content || (typeof ev.data === 'string' ? ev.data : '') || '';
    if (th) { state.thinking = (state.thinking || '') + String(th); return { kind: 'thinking-delta' }; }
    return { kind: 'ignore' };
  }
  if (t === 'tool_call_update') {
    // Progress pings. Do not onTool, do not close thinking.
    return { kind: 'tool_update' };
  }
  if (t === 'tool_call' || t === 'tool_use' || t === 'function_call') {
    const name = toolNameOf(ev);
    const input = ev.input || ev.args || ev.arguments || ev.tool || ev;
    const tool = { name, input };
    // Discord: a tool closes the pending narration block. Later text is a new
    // block — persistAskTurn must store the last block (the answer), not glue.
    const closedThinking = closeThinking(state);
    const closed = closeTextBlock(state);
    state.tools.push(tool);
    return { kind: 'tool', tool, closed, closedThinking };
  }
  if (t === 'error' || ev.error) {
    state.isError = true;
    const msg = (ev.error && (ev.error.message || ev.error)) || ev.message || ev.text || 'grok error';
    return { kind: 'error', error: String(msg), closedThinking: closeThinking(state) };
  }
  if (t === 'end') {
    return { kind: 'end', closedThinking: closeThinking(state) };
  }
  if (t === 'usage' || t === 'plan' || t === 'available_commands') {
    return { kind: t || 'meta' };
  }
  const text = extractText(ev);
  // Keep space-only pieces (" "). Do not treat whitespace as empty and do not
  // invent a space after .!? — if grok omitted it, persist stays honest
  // ("time."+"The" → "time.The"). "time."+" "+"The" → "time. The".
  if (text != null && text !== '') {
    // grok 1.0.5 streaming-json tokens are {type:"text", data:"..."}. Those are
    // incremental — treat as delta so /v2/stream keeps writing until real done.
    const incremental = typeof ev.delta === 'string' || (t === 'text' && typeof ev.data === 'string');
    const prev = state.text || '';
    let joined;
    let closed = '';
    const closedThinking = closeThinking(state);
    if (incremental) {
      joined = prev + text;
    } else if (text.startsWith(prev) && prev) {
      joined = text;
    } else if (isCompleteBlock(prev) && isCompleteBlock(text)) {
      // Status/narration then the real answer: last block wins (Discord split).
      // Not the same as token glue ("time."+"The").
      closed = closeTextBlock(state);
      joined = text;
    } else {
      joined = joinText(prev, text);
    }
    const replaced = !incremental && joined !== prev && !joined.startsWith(prev);
    const emitted = replaced ? joined : joined.slice(prev.length);
    state.text = joined;
    return { kind: incremental ? 'delta' : 'text', text: emitted, closed, closedThinking };
  }
  return { kind: 'ignore' };
}

function newState(sessionId) {
  return {
    text: '',
    segments: [],
    tools: [],
    usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    isError: false,
    engineSessionId: sessionId || null,
    thinking: '',
  };
}

let _mcpSynced = false;

async function runTurn({ prompt, systemPrompt, resume = null, cwd, model, abortController, onDelta, onSegment, onTool, onThinking, onEvent, conversationKey, effortPrompt, channel, senderId, owner, bypass_moderation, user_key, sender, denyTools, attachChannel, attachTarget, attachGuild, attachSender, images, mediaFiles, channel_context, voice }) {
  const voiceTurn = isDiscordVoice({ channel, conversationKey, channel_context, voice });
  if (!_mcpSynced) { _mcpSynced = true; try { require('../../../shared/mcp-registry').syncGrok(bin()); } catch (_) {} }

  const sessionId = (resume && isUuid(resume)) ? resume : crypto.randomUUID();
  // Do not consume ~/.asmltr/next-effort on email/mcp/voice — those channels force their effort.
  const nextEffort = (isEmailChannel(channel) || isMcpChannel(channel) || voiceTurn) ? null : takeNextEffort(conversationKey);
  const effortOpts = { prompt, cwd, nextEffort, effortPrompt, channel, senderId, owner, bypass_moderation, user_key, sender, conversationKey, channel_context, voice };
  const { denyToolsEnv } = require('../../../shared/media-allow');
  const deny = denyTools || {};
  const denyAll = !!deny.all;
  let classified = classifyEffort(effortOpts);
  const scored = scoringPrompt(effortOpts);
  let imageGen = false;
  let classifyUsage = null;
  const skipImageClassify = !!deny.image || denyAll || isEmailChannel(channel) || isMcpChannel(channel) || voiceTurn || imageGenClassifyOff();
  const photoAttached = hasStillThisTurn({ images, mediaFiles, text: scored });
  const classifyText = pictureIntentClassifyText(scored, { photoAttached });
  if (!skipImageClassify && shouldClassifyPictureIntent(scored, { photoAttached })) {
    // Picture-intent: gpt-5-nano on the moderation OpenAI key. Text only — never
    // still bytes, never CHANNEL MEDIA paths. A still this turn → one notice line.
    // Missing key: classifyRaw logs once and skipped. No grok complete() fallback.
    try {
      const moderation = require('../moderation');
      const r = await moderation.classifyRaw(
        'You are ONLY a classifier. Reply YES or NO. No extra text. You are not shown any photo.',
        buildImageGenClassifyPrompt(classifyText)
      );
      if (r && !r.skipped) {
        classifyUsage = r.usage || null;
        imageGen = parseImageGenVerdict(r.text);
      }
    } catch (_) { imageGen = false; }
    classified = raiseForImageGen(classified, { imageGen, channel, conversationKey, channel_context, voice });
  }
  const effort = classified.effort;
  recordLastEffort(effort, Object.assign({}, effortOpts, { reason: classified.reason }));
  try { process.stderr.write('[grok] --effort ' + effort + ' (' + classified.reason + (imageGen ? ' imageGen' : '') + ')\n'); } catch (_) {}
  if (onEvent) { try { onEvent({ type: 'effort', effort, imageGen, classifyUsage }); } catch (_) {} }
  const denyEnv = denyToolsEnv(denyAll ? Object.assign({}, deny, { all: true }) : deny);
  const extra = { ASMLTR_INSIDE_TURN: '1' };
  if (conversationKey) extra.ASMLTR_TURN_KEY = String(conversationKey);
  if (denyEnv) extra.ASMLTR_DENY_TOOLS = denyEnv;
  if (attachChannel) extra.ASMLTR_ATTACH_CHANNEL = String(attachChannel);
  if (attachTarget) extra.ASMLTR_ATTACH_TARGET = String(attachTarget);
  if (attachGuild) extra.ASMLTR_ATTACH_GUILD = String(attachGuild);
  if (attachSender) extra.ASMLTR_ATTACH_SENDER = String(attachSender);
  if (conversationKey) extra.ASMLTR_ATTACH_CONVERSATION_KEY = String(conversationKey);
  if (cwd) extra.ASMLTR_ATTACH_INGEST_CWD = String(cwd);
  const childEnv = launchEnv(Object.assign({}, process.env, extra));
  gcVisionPromptFilesOnce();
  const args = buildArgs({
    prompt, systemPrompt, resume, cwd, model, sessionId, effortPrompt, channel,
    senderId, owner, bypass_moderation, user_key, sender,
    conversationKey, channel_context, voice,
    denyAll,
    denyShell: denyAll || !!deny.shell, denyWrite: denyAll || !!deny.write, denyVideo: denyAll || !!deny.video, denyImage: denyAll || !!deny.image,
    images, mediaFiles,
    // If we raised for a picture request, pin --effort so buildArgs does not re-pick medium.
    nextEffort: classified.reason === 'image-gen' ? undefined : nextEffort,
    effort: classified.reason === 'image-gen' ? effort : undefined,
  });
  const visionFile = args.visionPromptFile || null;
  let stderr = '';
  try {
    const child = spawn(bin(), args, { cwd: cwd || undefined, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });

    const kill = () => { try { child.kill('SIGTERM'); } catch (_) {} };
    if (abortController) abortController.signal.addEventListener('abort', kill);

    const state = newState(sessionId);
    let buf = '';
    const handleLine = (line) => {
      const ev = parseLine(line);
      if (!ev) return;
      if (onEvent) { try { onEvent(ev); } catch (_) {} }
      const r = applyEvent(ev, state);
      // Thought summaries (grok.com chips) close when a tool or answer starts.
      // Emit the whole block once — not each streaming token.
      if (r.closedThinking && onThinking) { try { onThinking(r.closedThinking); } catch (_) {} }
      // A tool (or a restated complete block) closes the live narration. Emit that
      // closed block as a segment so Discord/web can post it as an intermediary
      // step — incremental deltas never fire onSegment on their own.
      if (r.closed && onSegment) { try { onSegment(r.closed); } catch (_) {} }
      if (r.kind === 'tool' && r.tool && onTool) { try { onTool(r.tool); } catch (_) {} }
      else if (r.kind === 'error' && r.error && onSegment) { try { onSegment(`⚠️ grok: ${r.error}`); } catch (_) {} }
      else if (r.kind === 'delta' && r.text != null && r.text !== '' && onDelta) { try { onDelta(r.text); } catch (_) {} }
      else if (r.kind === 'text' && r.text && onSegment) { try { onSegment(r.text); } catch (_) {} }
    };
    child.stdout.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const code = await new Promise((res) => {
      child.on('close', (c, sig) => res(c == null && sig ? sig : c));
      child.on('error', (err) => {
        const msg = (err && err.message) || 'spawn error';
        stderr += (stderr ? '\n' : '') + msg;
        res(1);
      });
    });
    if (buf.trim()) handleLine(buf);
    if (state.thinking && onThinking) {
      try { onThinking(state.thinking); } catch (_) {}
      state.thinking = '';
    }
    if (code !== 0 && !state.text) {
      state.isError = true;
      state.text = (stderr.trim().split('\n').slice(-1)[0] || `grok exited ${code == null ? 'unknown' : code}`);
    }

    const segs = (state.segments || []).slice();
    if (state.text && state.text.trim()) segs.push(state.text.trim());
    const answer = segs.length ? segs[segs.length - 1] : '';
    return {
      text: answer,
      segments: segs,
      engineSessionId: state.engineSessionId || sessionId,
      tools: state.tools,
      usage: state.usage,
      isError: state.isError,
    };
  } finally {
    if (visionFile) try { fs.unlinkSync(visionFile); } catch (_) {}
  }
}

async function complete({ prompt, model, appendSystemPrompt = null, abortController, timeoutMs, effort, denyShell, denyWrite, denyImage, denyVideo }) {
  gcVisionPromptFilesOnce();
  const args = buildArgs({
    prompt, systemPrompt: appendSystemPrompt, model: model || cheapModel, complete: true,
    effort, denyShell, denyWrite, denyImage, denyVideo,
  });
  const promptFile = args.visionPromptFile || null;
  try {
    const child = spawn(bin(), args, { env: launchEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    const kill = () => { try { child.kill('SIGTERM'); } catch (_) {} };
    if (abortController) abortController.signal.addEventListener('abort', kill);
    let timer = null;
    if (timeoutMs > 0) timer = setTimeout(kill, timeoutMs);
    try {
      await new Promise((res) => { child.on('close', res); child.on('error', () => res(1)); });
    } finally {
      if (timer) clearTimeout(timer);
    }
    return out.trim();
  } finally {
    if (promptFile) try { fs.unlinkSync(promptFile); } catch (_) {}
  }
}

// See file header: flip to true after live-verifying `-r` replays the first-turn system block.
const historyReplaysSystemPrompt = true;

module.exports = {
  id, cheapModel, runTurn, complete, historyReplaysSystemPrompt,
  getLastModel: () => engines.modelFor('grok'),
  // testable internals (no spawn)
  isUuid, resumeArgs, buildArgs, launchEnv, parseLine, applyEvent, sessionIdFrom,
  collectVisionImages, acpPromptJson, writeVisionPromptFile, gcVisionPromptFiles, visionPromptDir,
  extractText, extractUsage, joinText, isCompleteBlock, closeThinking, newState, toolNameOf, isThoughtType,
  isEmailChannel, isMcpChannel, isWebChannel,
  ownerFromEmail, parseEmailAddress, extractSenderEmail, isOwnerFromEmail,
  normalizeEffort, looksLikeCode, looksLikeLookup, isProjectGitRepo, scoringPrompt,
  classifyEffort, chooseEffort, effortForTurn, raiseForImageGen, isDiscordVoice,
  canElevateEffort, detectElevateToken, stripElevateToken, elevateIdSet, commitAndPushSamePost,
  takeNextEffort, consumeNextEffortFile, VALID_EFFORTS, LAST_EFFORT_FILE,
};
