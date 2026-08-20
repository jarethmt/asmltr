'use strict';
/**
 * Grok engine — headless adapter over the official Grok Build CLI (`grok`).
 *
 * Mirrors Gemini/Codex (spawn + NDJSON), NOT the Claude Agent SDK.
 * Subscription/CLI auth only: the child inherits the operator's ~/.grok/auth.json
 * and we STRIP XAI_API_KEY so the CLI cannot fall through to metered API billing.
 *
 * Harness turns are headless (`grok -p`), never the interactive TUI (bare `grok`).
 * Finite --max-turns + a spawn watchdog; no infinite idle.
 *
 * RESUME UUID (Grok-specific — do not drop):
 *   Sessions are UUIDs (UUIDv7 when the CLI assigns one). `-s/--session-id` CREATES
 *   a new session; it does not resume. `-r/--resume <uuid>` resumes. `-c/--continue`
 *   is cwd-implicit and too loose for asmltr. On a fresh turn we pass `-s <uuid>` so
 *   we have an addressable id even if JSON parse misses `.sessionId`. On resume we
 *   pass `-r <uuid>` only. `--fork-session` / `--restore-code` / `grok sessions` /
 *   `grok export` are preserved as notes, not wired. See /workspace/grok-cli-features.md.
 *
 * historyReplaysSystemPrompt is TRUE: osiris live-verified 2026-08-17 that `-r <uuid>`
 * replays the first-turn system block (probe: "What were you instructed to be?" →
 * "A one-word ping fixture."). ASMLTR_INJECT_ONCE=off remains the kill-switch.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engines = require('../../../shared/engines');
const { composePrompt } = require('../../../shared/prompt-compose');

const id = 'grok';
const cheapModel = process.env.ASMLTR_GROK_TITLE_MODEL || 'grok-4.6';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — finite, never infinite
const DEFAULT_MAX_TURNS = 20;
const TIMEOUT_CAP_MS = 4 * 60 * 60 * 1000;
const MAX_TURNS_CAP = 100;

function timeoutMs() {
  const n = Number(process.env.ASMLTR_GROK_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) return Math.min(n, TIMEOUT_CAP_MS);
  return DEFAULT_TIMEOUT_MS;
}
function maxTurns() {
  const n = Number(process.env.ASMLTR_GROK_MAX_TURNS);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), MAX_TURNS_CAP);
  return DEFAULT_MAX_TURNS;
}

const TURNS_FOR_EFFORT = { low: 20, medium: 20, high: 40, xhigh: 60 };
const TIMEOUT_SCALE = { low: 1, medium: 1, high: 1, xhigh: 1.5 }; // unused for watchdog; interactive is absolute 5/10/60

/** medium 20 / high 40 / xhigh 60. Cap 100. Env MAX_TURNS is the complete() baseline, not a flatten. */
function maxTurnsForEffort(effort, opts) {
  const e = normalizeEffort(effort) || 'medium';
  const channel = typeof opts === 'string' ? opts : (opts && opts.channel);
  if (isEmailChannel(channel) && e === 'xhigh') return MAX_TURNS_CAP;
  return Math.min(TURNS_FOR_EFFORT[e] || DEFAULT_MAX_TURNS, MAX_TURNS_CAP);
}

const EMAIL_TIMEOUT_MS = 60 * 60 * 1000; // inbound email xhigh (generic; 100 turns / 60 minutes)
// Discord / assistant-web / assistant-native / mcp (and generic non-email). Absolute, not scale-from-env.
const INTERACTIVE_TIMEOUT_MS = {
  low: 5 * 60 * 1000,
  medium: 5 * 60 * 1000,
  high: 10 * 60 * 1000,
  xhigh: 60 * 60 * 1000,
};

function isEmailChannel(channel) {
  return String(channel || '').trim().toLowerCase() === 'email';
}

/** Watchdog by channel. Interactive 5 / 10 / 60. Email xhigh is 60 minutes.
 *  Second arg is opts `{ channel, sender }` or a channel string. */
function timeoutMsForEffort(effort, opts) {
  const channel = typeof opts === 'string' ? opts : (opts && opts.channel);
  const e = normalizeEffort(effort) || 'medium';
  if (isEmailChannel(channel) && e === 'xhigh') {
    return Math.min(EMAIL_TIMEOUT_MS, TIMEOUT_CAP_MS);
  }
  const ms = INTERACTIVE_TIMEOUT_MS[e] || INTERACTIVE_TIMEOUT_MS.medium;
  return Math.min(ms, TIMEOUT_CAP_MS);
}

// Reasoning effort — three tiers (James / Adjutant, 19 Aug 2026):
//   Always pass `--effort <level>` (CLI alias of --reasoning-effort).
//   Baseline is ASMLTR_GROK_EFFORT (Ivy live: medium). envEffort() if unset still
//   || 'high' so other installs keep the old default. xhigh is NOT the default.
//   medium  normal conversation
//   high    lookup/research, Corona (recipe/cigar/cooking), Rolodex/contacts,
//           standard troubleshooting/diagnosis/"why is X slow"/look it up/search.
//           Not a coding session.
//   xhigh   git or code, or a deep dive (implement, refactor, write/patch code,
//           commit, PR, "deep dive"). Project git cwd that is not $HOME.
//   HOME is never a project. Never use process.cwd() (the asmltr clone is a git
//   repo and would xhigh every ask). Use the session/turn cwd if provided.
//   Score opts.effortPrompt when set (current user message only) — NOT
//   drainObserved/catch-up glued onto prompt in server.js.
//   Tight: do not treat bare "fix" as xhigh (Eve "Proposed Fix", "quick fix").
//   One-shot next-effort still wins. complete() skips auto-raise.
//   Email channel (`email`) forces xhigh AFTER one-shot (a chatty mail body
//   with no code words is still xhigh). Discord and others stay three-tier.
//   Email xhigh timeout is 60 minutes, or 4 hours only when From is
//    (case-insensitive, display-name wrapping ignored;
//   //   5 / 10 / 60 (cap 4h so the owner-from path can use it; interactive
//   stays absolute 5/10/60).
//   Do not inherit last effort. Do not use a generic XHIGH_CHANNELS list.
//   Ivy one-shot: write ~/.asmltr/next-effort (one line). Consumed once at the
//   next grok -p spawn. sessions.next_effort is the same one-shot per key.
//   Whole-word +xh / +h (whitespace-split, start/end/standalone) override to
//   xhigh / high for this turn only when the sender is owner/bypass or their
//   raw Discord id is in ASMLTR_GROK_EFFORT_ELEVATE_IDS. Honored token is
//   stripped from effortPrompt and the grok user prompt. Unknown senders keep
//   the token and stay on the picker. After one-shot / explicit; wins over
//   three-tier and email. Do not persist nextEffort from the token. No
//   owner snowflake in git.
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
// xhigh: code / git / deep dive. No bare \bfix\b.
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
  'commit',
];
const XHIGH_RE = new RegExp('\\b(?:' + XHIGH_PARTS.join('|') + ')\\b', 'i');
const CODE_WORD_RE = /\bcode\b/i;
const CODE_WORD_EXCLUDE_RE = /\b(?:zip|area|dress|door|promo(?:tional)?|country|postal|access|error|status|exit|http)\s+codes?\b|\bcode of conduct\b/i;
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
  'rolodex',
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
  if (opts.owner === true || opts.bypass === true || opts.bypass_moderation === true) return true;
  if (String(opts.user_key || '') === 'owner') return true;
  let sid = opts.senderId;
  if (sid == null && opts.sender && typeof opts.sender === 'object') sid = opts.sender.raw_id;
  else if (sid == null) sid = opts.sender;
  sid = String(sid || '').trim();
  if (sid === 'owner') return true;
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

function xhighReason(prompt) {
  const s = String(prompt || '');
  const m = matchToken(XHIGH_RE, s);
  if (m) return m;
  if (CODE_WORD_RE.test(s) && !CODE_WORD_EXCLUDE_RE.test(s)) return 'code';
  return '';
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
  const oneshotNext = normalizeEffort(opts.nextEffort);
  if (oneshotNext) return { effort: oneshotNext, reason: 'oneshot' };
  const oneshotExplicit = normalizeEffort(opts.effort);
  if (oneshotExplicit) return { effort: oneshotExplicit, reason: 'explicit' };
  if (opts.complete) return { effort: envEffort(), reason: 'complete' };
  const token = detectElevateToken(scoringPrompt(opts));
  if (token && canElevateEffort(opts)) {
    return { effort: token === '+xh' ? 'xhigh' : 'high', reason: 'token:' + token, stripToken: token };
  }
  // After one-shot: inbound email is always xhigh. Discord/others keep the three-tier score.
  if (isEmailChannel(opts.channel)) return { effort: 'xhigh', reason: 'email' };
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
  return env;
}

/**
 * Build grok argv for a harness turn or a cheap complete().
 * @param {{ prompt: string, systemPrompt?: string, resume?: string|null, cwd?: string, model?: string, complete?: boolean, sessionId?: string }} opts
 */
function buildArgs(opts) {
  const classified = classifyEffort(opts);
  const userPrompt = classified.stripToken
    ? stripElevateToken(opts.prompt, classified.stripToken)
    : opts.prompt;
  const prompt = composePrompt(opts.systemPrompt, userPrompt);
  const args = ['--no-auto-update', '-p', prompt];
  args.push('--output-format', opts.complete ? 'plain' : 'streaming-json');
  args.push('--always-approve');
  const turns = opts.complete ? maxTurns() : maxTurnsForEffort(classified.effort, opts);
  args.push('--max-turns', String(turns));
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
  return args;
}

function parseLine(line) {
  const s = String(line || '').trim();
  if (!s || s[0] !== '{') return null;
  try { return JSON.parse(s); } catch (_) { return null; }
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
  if (!cur) return;
  if (!Array.isArray(state.segments)) state.segments = [];
  state.segments.push(cur);
  state.text = '';
}

function extractText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const t = obj.type;
  if (t === 'thought' || t === 'thinking' || t === 'error') return '';
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
function applyEvent(ev, state) {
  if (!ev || typeof ev !== 'object') return { kind: 'ignore' };
  const sid = sessionIdFrom(ev);
  if (sid) state.engineSessionId = sid;
  const usage = extractUsage(ev);
  if (usage) { state.usage.tokens_in = usage.tokens_in || state.usage.tokens_in; state.usage.tokens_out = usage.tokens_out || state.usage.tokens_out; }

  const t = ev.type || ev.event || '';
  if (t === 'thought' || t === 'thinking') {
    const th = ev.text || ev.thought || ev.content || (typeof ev.data === 'string' ? ev.data : '') || '';
    if (th) { state.thinking = (state.thinking || '') + String(th); return { kind: 'thinking', thinking: String(th) }; }
    return { kind: 'ignore' };
  }
  if (t === 'tool_call' || t === 'tool_use' || t === 'function_call' || t === 'tool_call_update') {
    const name = ev.name || (ev.tool && ev.tool.name) || ev.toolName || t;
    const input = ev.input || ev.args || ev.arguments || ev.tool || ev;
    const tool = { name, input };
    // Discord: a tool closes the pending narration block. Later text is a new
    // block — persistAskTurn must store the last block (the answer), not glue.
    if (t !== 'tool_call_update') {
      closeTextBlock(state);
      state.tools.push(tool);
    }
    return { kind: 'tool', tool };
  }
  if (t === 'error' || ev.error) {
    state.isError = true;
    const msg = (ev.error && (ev.error.message || ev.error)) || ev.message || ev.text || 'grok error';
    return { kind: 'error', error: String(msg) };
  }
  if (t === 'usage' || t === 'end' || t === 'plan' || t === 'available_commands') {
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
    if (incremental) {
      joined = prev + text;
    } else if (text.startsWith(prev) && prev) {
      joined = text;
    } else if (isCompleteBlock(prev) && isCompleteBlock(text)) {
      // Status/narration then the real answer: last block wins (Discord split).
      // Not the same as token glue ("time."+"The").
      closeTextBlock(state);
      joined = text;
    } else {
      joined = joinText(prev, text);
    }
    const replaced = !incremental && joined !== prev && !joined.startsWith(prev);
    const emitted = replaced ? joined : joined.slice(prev.length);
    state.text = joined;
    return { kind: incremental ? 'delta' : 'text', text: emitted };
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

async function runTurn({ prompt, systemPrompt, resume = null, cwd, model, abortController, onDelta, onSegment, onTool, onThinking, onEvent, conversationKey, effortPrompt, channel, senderId, owner, bypass_moderation, user_key, sender }) {
  if (!_mcpSynced) { _mcpSynced = true; try { require('../../../shared/mcp-registry').syncGrok(bin()); } catch (_) {} }

  const sessionId = (resume && isUuid(resume)) ? resume : crypto.randomUUID();
  const nextEffort = takeNextEffort(conversationKey);
  const effortOpts = { prompt, cwd, nextEffort, effortPrompt, channel, senderId, owner, bypass_moderation, user_key, sender };
  const classified = classifyEffort(effortOpts);
  const effort = classified.effort;
  recordLastEffort(effort, Object.assign({}, effortOpts, { reason: classified.reason }));
  try { process.stderr.write('[grok] --effort ' + effort + ' (' + classified.reason + ')\n'); } catch (_) {}
  const args = buildArgs({ prompt, systemPrompt, resume, cwd, model, sessionId, nextEffort, effortPrompt, channel, senderId, owner, bypass_moderation, user_key, sender });
  const child = spawn(bin(), args, { cwd: cwd || undefined, env: launchEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  const kill = () => { try { child.kill('SIGTERM'); } catch (_) {} };
  if (abortController) abortController.signal.addEventListener('abort', kill);
  const watchdog = setTimeout(() => { kill(); setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000); }, timeoutMsForEffort(effort, { channel, sender }));
  if (watchdog.unref) watchdog.unref();

  const state = newState(sessionId);
  let buf = '';
  const handleLine = (line) => {
    const ev = parseLine(line);
    if (!ev) return;
    if (onEvent) { try { onEvent(ev); } catch (_) {} }
    const r = applyEvent(ev, state);
    if (r.kind === 'thinking' && r.thinking && onThinking) { try { onThinking(r.thinking); } catch (_) {} }
    else if (r.kind === 'tool' && r.tool && onTool) { try { onTool(r.tool); } catch (_) {} }
    else if (r.kind === 'error' && r.error && onSegment) { try { onSegment(`⚠️ grok: ${r.error}`); } catch (_) {} }
    else if (r.kind === 'delta' && r.text != null && r.text !== '' && onDelta) { try { onDelta(r.text); } catch (_) {} }
    else if (r.kind === 'text' && r.text && onSegment) { try { onSegment(r.text); } catch (_) {} }
  };
  child.stdout.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const code = await new Promise((res) => { child.on('close', res); child.on('error', () => res(1)); });
  clearTimeout(watchdog);
  if (buf.trim()) handleLine(buf);
  if (code !== 0 && !state.text) {
    state.isError = true;
    state.text = (stderr.trim().split('\n').slice(-1)[0] || `grok exited ${code}`);
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
}

async function complete({ prompt, model, appendSystemPrompt = null }) {
  const args = buildArgs({ prompt, systemPrompt: appendSystemPrompt, model: model || cheapModel, complete: true });
  const child = spawn(bin(), args, { env: launchEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const watchdog = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, timeoutMs());
  if (watchdog.unref) watchdog.unref();
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  await new Promise((res) => { child.on('close', res); child.on('error', () => res(1)); });
  clearTimeout(watchdog);
  return out.trim();
}

// See file header: flip to true after osiris confirms `-r` replays the first-turn system block.
const historyReplaysSystemPrompt = true;

module.exports = {
  id, cheapModel, runTurn, complete, historyReplaysSystemPrompt,
  getLastModel: () => engines.modelFor('grok'),
  // testable internals (no spawn)
  isUuid, resumeArgs, buildArgs, launchEnv, parseLine, applyEvent, sessionIdFrom,
  extractText, extractUsage, joinText, isCompleteBlock, newState, timeoutMs, maxTurns,
  timeoutMsForEffort, maxTurnsForEffort, TIMEOUT_CAP_MS, MAX_TURNS_CAP, TURNS_FOR_EFFORT,
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TURNS, EMAIL_TIMEOUT_MS, INTERACTIVE_TIMEOUT_MS, isEmailChannel,
  normalizeEffort, looksLikeCode, looksLikeLookup, isProjectGitRepo, scoringPrompt,
  classifyEffort, chooseEffort, effortForTurn,
  canElevateEffort, detectElevateToken, stripElevateToken, elevateIdSet,
  takeNextEffort, consumeNextEffortFile, VALID_EFFORTS, LAST_EFFORT_FILE,
};
