'use strict';
/**
 * Codex engine — headless adapter over the `codex exec --json` CLI (OpenAI).
 *
 * No Claude SDK involved. Spawns the installed `codex` binary, streams its JSONL event log, and
 * normalizes it into the engine contract. Resume is native: codex assigns a `thread_id` we persist
 * as engine_session_id and replay via `codex exec resume <thread_id>`. The API key (if the engine
 * is in api_key mode) is pulled from the TRUST vault and injected as OPENAI_API_KEY — never on disk.
 *
 * Event schema (codex exec --json):
 *   {type:"thread.started", thread_id}            → engineSessionId
 *   {type:"item.completed", item:{item_type|type, text, ...}}
 *        item_type agent_message → assistant text segment · reasoning → thinking · command_execution/
 *        mcp_tool_call → tool
 *   {type:"turn.completed", usage:{input_tokens,output_tokens,...}}
 *   {type:"error", message}                       → isError
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const engines = require('../../../shared/engines');
const { composePrompt } = require('../../../shared/prompt-compose');

const id = 'codex';
const cheapModel = process.env.ASMLTR_CODEX_TITLE_MODEL || 'o4-mini';

function bin() {
  const b = engines.resolveBin('codex');
  if (!b) throw new Error('codex CLI is not installed (Settings → Engines → Install).');
  return b;
}
async function launchEnv() {
  // api_key mode → OPENAI_API_KEY from the vault; subscription mode → nothing (the CLI owns its login).
  let extra = {}; try { extra = await engines.envForLaunch('codex'); } catch (_) {}
  return { ...process.env, ...extra };
}
const itemType = (it) => (it && (it.item_type || it.type)) || '';

// If a custom OpenAI-compatible endpoint is configured, add codex -c flags that define a provider
// pointing at it (wire_api=chat for a generic OpenAI server) + select it. Returns [] when unset.
function baseUrlArgs() {
  const url = engines.baseUrlFor('codex'); if (!url) return [];
  const P = 'asmltr_custom';
  // Modern codex only supports the Responses wire protocol for custom providers (chat was dropped),
  // so the endpoint must speak the OpenAI /responses API (vLLM, LiteLLM, and most gateways do).
  return ['-c', `model_provider=${P}`, '-c', `model_providers.${P}.name=${P}`,
    '-c', `model_providers.${P}.base_url=${url}`, '-c', `model_providers.${P}.wire_api=responses`,
    '-c', `model_providers.${P}.env_key=OPENAI_API_KEY`];
}

async function runTurn({ prompt, systemPrompt, resume = null, cwd, model, abortController, onDelta, onSegment, onTool, onThinking, onEvent }) {
  const mdl = model || engines.modelFor('codex');
  const lastMsgFile = path.join(os.tmpdir(), `asmltr-codex-${process.pid}-${Date.now().toString(36)}.txt`);
  const args = ['exec'];
  if (resume) args.push('resume', resume);
  args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
    '--output-last-message', lastMsgFile);
  if (mdl) args.push('-m', mdl);
  args.push(...baseUrlArgs());
  try { args.push(...require('../../../shared/mcp-registry').codexArgs()); } catch (_) {} // shared MCP registry
  if (cwd) args.push('-C', cwd);
  args.push(composePrompt(systemPrompt, prompt));

  // stdin = /dev/null: the prompt is an arg, so give codex immediate EOF instead of blocking on stdin.
  const child = spawn(bin(), args, { cwd: cwd || undefined, env: await launchEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (abortController) abortController.signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch (_) {} });

  let engineSessionId = resume || null;
  const segments = []; const tools = [];
  let usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  let isError = false; let lastAgentMsg = '';

  let buf = '';
  const handleLine = (line) => {
    const s = line.trim(); if (!s || s[0] !== '{') return; // skip human log lines (timestamps/ERROR)
    let ev; try { ev = JSON.parse(s); } catch (_) { return; }
    if (onEvent) { try { onEvent(ev); } catch (_) {} }
    switch (ev.type) {
      case 'thread.started': if (ev.thread_id) engineSessionId = ev.thread_id; break;
      case 'item.completed': {
        const it = ev.item || {}; const t = itemType(it);
        if (t === 'agent_message' && it.text) { lastAgentMsg = it.text; const seg = String(it.text).trim(); segments.push(seg); if (onSegment) { try { onSegment(seg); } catch (_) {} } }
        else if (t === 'reasoning' && it.text && onThinking) { try { onThinking(String(it.text)); } catch (_) {} }
        else if ((t === 'command_execution' || t === 'mcp_tool_call' || t === 'web_search') && onTool) {
          try { onTool({ name: t, input: it.command || it.query || it.tool || it }); } catch (_) {}
          tools.push({ name: t, input: it.command || it.query || it });
        }
        break;
      }
      case 'turn.completed':
        if (ev.usage) { usage.tokens_in = ev.usage.input_tokens || 0; usage.tokens_out = ev.usage.output_tokens || 0; }
        break;
      case 'error': isError = true; if (onSegment && ev.message) { try { onSegment(`⚠️ codex: ${ev.message}`); } catch (_) {} } break;
      default: break;
    }
  };
  child.stdout.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const code = await new Promise((res) => { child.on('close', res); child.on('error', () => res(1)); });
  if (buf.trim()) handleLine(buf);

  // Authoritative final text: the --output-last-message file (falls back to the last agent_message).
  let finalText = lastAgentMsg;
  try { const f = fs.readFileSync(lastMsgFile, 'utf8').trim(); if (f) finalText = f; } catch (_) {}
  try { fs.unlinkSync(lastMsgFile); } catch (_) {}
  if (code !== 0 && !finalText) { isError = true; finalText = (stderr.trim().split('\n').slice(-1)[0] || `codex exited ${code}`); }

  return { text: (finalText || '').trim(), segments: segments.filter(Boolean), engineSessionId, tools, usage, isError };
}

/** One-shot completion for labelers — a fresh codex turn, return the final text. */
async function complete({ prompt, model, appendSystemPrompt = null }) {
  const r = await runTurn({ prompt, systemPrompt: appendSystemPrompt, model: model || cheapModel });
  return r.text || '';
}

module.exports = { id, cheapModel, runTurn, complete, getLastModel: () => engines.modelFor('codex') };
