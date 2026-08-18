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
const engines = require('../../../shared/engines');
const { composePrompt } = require('../../../shared/prompt-compose');

const id = 'grok';
const cheapModel = process.env.ASMLTR_GROK_TITLE_MODEL || 'grok-4.6';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — finite, never infinite
const DEFAULT_MAX_TURNS = 20;
const TIMEOUT_CAP_MS = 30 * 60 * 1000;
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
  const prompt = composePrompt(opts.systemPrompt, opts.prompt);
  const args = ['--no-auto-update', '-p', prompt];
  args.push('--output-format', opts.complete ? 'plain' : 'streaming-json');
  args.push('--always-approve');
  args.push('--max-turns', String(maxTurns()));
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
  if (/[.!?]["')\]]*$/.test(prev) && /^[A-Za-z0-9“"'(]/.test(next)) return prev + ' ' + next;
  return prev + next;
}

function extractText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const t = obj.type;
  if (t === 'thought' || t === 'thinking' || t === 'error') return '';
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
    if (t !== 'tool_call_update') state.tools.push(tool);
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
  // Keep space-only pieces (" ") — do not treat whitespace as empty. When Grok
  // starts the next sentence without a leading space, joinText inserts one so
  // stored outbound matches live ("time. The", not "time.The").
  if (text != null && text !== '') {
    const joined = joinText(state.text, text);
    const emitted = joined.slice(state.text.length);
    state.text = joined;
    // grok 1.0.5 streaming-json tokens are {type:"text", data:"..."}. Those are
    // incremental — treat as delta so /v2/stream keeps writing until real done.
    const incremental = typeof ev.delta === 'string' || (t === 'text' && typeof ev.data === 'string');
    return { kind: incremental ? 'delta' : 'text', text: emitted };
  }
  return { kind: 'ignore' };
}

function newState(sessionId) {
  return {
    text: '',
    tools: [],
    usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    isError: false,
    engineSessionId: sessionId || null,
    thinking: '',
  };
}

let _mcpSynced = false;

async function runTurn({ prompt, systemPrompt, resume = null, cwd, model, abortController, onDelta, onSegment, onTool, onThinking, onEvent }) {
  if (!_mcpSynced) { _mcpSynced = true; try { require('../../../shared/mcp-registry').syncGrok(bin()); } catch (_) {} }

  const sessionId = (resume && isUuid(resume)) ? resume : crypto.randomUUID();
  const args = buildArgs({ prompt, systemPrompt, resume, cwd, model, sessionId });
  const child = spawn(bin(), args, { cwd: cwd || undefined, env: launchEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  const kill = () => { try { child.kill('SIGTERM'); } catch (_) {} };
  if (abortController) abortController.signal.addEventListener('abort', kill);
  const watchdog = setTimeout(() => { kill(); setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000); }, timeoutMs());
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
    else if (r.kind === 'delta' && r.text && onDelta) { try { onDelta(r.text); } catch (_) {} }
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

  const segs = state.text.trim() ? [state.text.trim()] : [];
  return {
    text: state.text.trim(),
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
  extractText, extractUsage, joinText, newState, timeoutMs, maxTurns,
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TURNS,
};
