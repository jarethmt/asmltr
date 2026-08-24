'use strict';
/**
 * Gemini engine — headless adapter over the `gemini` CLI (Google).
 *
 * No Claude SDK involved. Spawns the installed `gemini` binary in non-interactive mode
 * (`-p <prompt> -o stream-json`), parses its JSON line stream defensively, and normalizes to the
 * engine contract. The API key (api_key mode) is pulled from the TRUST vault → GEMINI_API_KEY.
 *
 * Vision is NOT serialized here. Core already forwards `images` / `mediaFiles` on runTurn
 * (same envelope as Grok/Claude). A Gemini-or-Codex implementer should wire those fields
 * into this CLI's own image payload in runTurn — do not copy Grok `--prompt-file` or the
 * Claude SDK image blocks into this adapter. See docs/REASONING-ENGINES.md "Vision today".
 *
 * Notes / current limits:
 *  - Headless runs require workspace trust — we pass `--skip-trust` + GEMINI_CLI_TRUST_WORKSPACE=1.
 *  - Google deprecated the free "Code Assist for individuals" OAuth tier, so the practical auth path
 *    is an API key (Settings → Engines → Gemini → API key). Subscription mode still works if the
 *    `gemini` CLI itself is logged into an eligible account.
 *  - The CLI's resume is project+index based (not addressable by an opaque id), so this adapter is
 *    STATELESS per turn for now (no cross-turn history replay). We still return a session id so the
 *    dashboard can track the card. `--session-file` persistence is the planned continuity path.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const engines = require('../../../shared/engines');
const { composePrompt } = require('../../../shared/prompt-compose');

const id = 'gemini';
const cheapModel = process.env.ASMLTR_GEMINI_TITLE_MODEL || 'gemini-2.5-flash';

function bin() {
  const b = engines.resolveBin('gemini');
  if (!b) throw new Error('gemini CLI is not installed (Settings → Engines → Install).');
  return b;
}
async function launchEnv() {
  let extra = {}; try { extra = await engines.envForLaunch('gemini'); } catch (_) {}
  return { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true', ...extra };
}

// Pull assistant text out of whatever shape a gemini stream-json line takes (schema varies by version).
function extractText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.delta === 'string') return obj.delta;
  if (typeof obj.text === 'string' && obj.type !== 'thinking') return obj.text;
  if (typeof obj.content === 'string') return obj.content;
  if (typeof obj.response === 'string') return obj.response;
  if (obj.message && typeof obj.message.content === 'string') return obj.message.content;
  if (obj.message && Array.isArray(obj.message.content)) return obj.message.content.map((c) => (c && c.text) || '').join('');
  // Raw Gemini API candidate shape
  if (Array.isArray(obj.candidates)) return obj.candidates.map((c) => ((c.content && c.content.parts) || []).map((p) => p.text || '').join('')).join('');
  return '';
}

let _mcpSynced = false;
/**
 * VISION (not wired): core already passes `images` (base64 stills) and `mediaFiles`
 * (gen-ref paths) on runTurn — same envelope Grok/Claude get. If you are adding
 * Gemini vision, serialize those fields HERE into this CLI's image payload.
 * Do not copy Grok `--prompt-file` / `--prompt-json` or Claude SDK image blocks
 * into this adapter. See docs/REASONING-ENGINES.md "Vision today".
 */
async function runTurn({ prompt, systemPrompt, resume = null, cwd, model, abortController, onDelta, onSegment, onTool, onThinking, onEvent /* images, mediaFiles: not serialized yet */ }) {
  const mdl = model || engines.modelFor('gemini');
  // MCP: gemini persists servers in its own config → reconcile the shared registry once per process.
  if (!_mcpSynced) { _mcpSynced = true; try { require('../../../shared/mcp-registry').syncGemini(bin()); } catch (_) {} }
  const sessionId = resume || crypto.randomUUID();
  const args = ['-p', composePrompt(systemPrompt, prompt), '-o', 'stream-json', '-y', '--skip-trust', '--session-id', sessionId];
  if (mdl) args.push('-m', mdl);

  // stdin = /dev/null: prompt is passed via -p, so don't let gemini block reading stdin.
  const child = spawn(bin(), args, { cwd: cwd || undefined, env: await launchEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (abortController) abortController.signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch (_) {} });

  const segments = []; const tools = [];
  let usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  let isError = false; let text = '';

  let buf = '';
  const handleLine = (line) => {
    const s = line.trim(); if (!s || s[0] !== '{') return;
    let ev; try { ev = JSON.parse(s); } catch (_) { return; }
    if (onEvent) { try { onEvent(ev); } catch (_) {} }
    if (ev.type === 'thinking' && ev.text && onThinking) { try { onThinking(String(ev.text)); } catch (_) {} return; }
    if (ev.type === 'tool_use' || ev.type === 'tool_call' || ev.type === 'function_call') {
      const name = ev.name || (ev.tool && ev.tool.name) || 'tool';
      tools.push({ name, input: ev.input || ev.args || ev }); if (onTool) { try { onTool({ name, input: ev.input || ev.args || ev }); } catch (_) {} }
      return;
    }
    if (ev.usage || ev.stats) { const u = ev.usage || ev.stats.tokens || {}; usage.tokens_in = u.input_tokens || u.prompt || usage.tokens_in; usage.tokens_out = u.output_tokens || u.candidates || usage.tokens_out; }
    if (ev.error || ev.type === 'error') { isError = true; const msg = (ev.error && (ev.error.message || ev.error)) || ev.message; if (msg && onSegment) { try { onSegment(`⚠️ gemini: ${msg}`); } catch (_) {} } return; }
    const t = extractText(ev);
    if (t) {
      text += t;
      if (ev.delta && onDelta) { try { onDelta(t); } catch (_) {} }
      else if (onSegment) { try { onSegment(t.trim()); } catch (_) {} }
    }
  };
  child.stdout.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const code = await new Promise((res) => { child.on('close', res); child.on('error', () => res(1)); });
  if (buf.trim()) handleLine(buf);
  if (code !== 0 && !text) { isError = true; text = (stderr.trim().split('\n').slice(-1)[0] || `gemini exited ${code}`); }

  const segs = segments.length ? segments : (text.trim() ? [text.trim()] : []);
  return { text: text.trim(), segments: segs.filter(Boolean), engineSessionId: sessionId, tools, usage, isError };
}

/** One-shot completion for labelers — plain-text output, no session. */
async function complete({ prompt, model, appendSystemPrompt = null }) {
  const args = ['-p', composePrompt(appendSystemPrompt, prompt), '-o', 'text', '-y', '--skip-trust'];
  const mdl = model || cheapModel; if (mdl) args.push('-m', mdl);
  const child = spawn(bin(), args, { env: await launchEnv() });
  let out = ''; child.stdout.on('data', (d) => { out += d.toString(); });
  await new Promise((res) => { child.on('close', res); child.on('error', () => res(1)); });
  return out.trim();
}

module.exports = { id, cheapModel, runTurn, complete, getLastModel: () => engines.modelFor('gemini') };
