'use strict';
/**
 * Claude engine — the SDK-backed reasoning engine (the original web/channel runner).
 *
 * Wraps the LOCAL Agent SDK (`@anthropic-ai/claude-agent-sdk` query() API) on the Max
 * subscription (NEVER an API key). The SDK is required LAZILY (inside q()), so importing this
 * module — or booting the core — does NOT load the SDK. A Gemini-only / Codex-only install can
 * therefore run with the Claude SDK absent: this module is only touched when a Claude turn runs.
 *
 * Implements the engine contract: runTurn(opts) → { text, segments, engineSessionId, tools, usage,
 * isError } and complete({prompt,model,...}) → string. Behaviour is identical to the pre-refactor
 * runner.js (moved here verbatim).
 */
let _query = null;
function q() {
  if (!_query) _query = require('@anthropic-ai/claude-agent-sdk').query; // lazy: only when a Claude turn runs
  return _query;
}

const id = 'claude';
const cheapModel = process.env.ASMLTR_TITLE_MODEL || 'haiku';
let _lastModel = null; // the concrete model id the alias resolved to (surfaced to the GUI)

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve the NATIVE `claude` binary so the SDK spawns it DIRECTLY by absolute path.
// The SDK's default is `node <bundled cli.js>`, but under PM2 the child env can drop PATH →
// "Failed to spawn Claude Code process: spawn node ENOENT". Pointing at the self-contained
// native binary sidesteps `node` resolution entirely (isNativeBinary → spawn(binary)).
// Resolved PER TURN, not at module load: the CLI auto-updater repoints the ~/.local/bin/claude
// symlink and eventually prunes old versions/<n> binaries — a realpath frozen at startup
// dangles after enough updates and every turn then fails until the core is restarted.
// ASMLTR_CLAUDE_BIN (the engine's binEnv, see shared/engines.js) overrides the search;
// set it to a nonexistent path to force the SDK's bundled runtime.
function resolveClaudeBin() {
  const cands = [process.env.ASMLTR_CLAUDE_BIN, path.join(os.homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude'].filter(Boolean);
  for (const c of cands) { try { return fs.realpathSync(c); } catch (_) { /* try next */ } }
  return null;
}

async function runTurn({ prompt, systemPrompt, resume = null, cwd, abortController, onEvent, onDelta, onSegment, onTool, onThinking, images = [] }) {
  const query = q();
  const options = {
    stream: true,
    permissionMode: 'bypassPermissions',
    includePartialMessages: true,
  };
  const _model = require('../../../shared/runtime').getModel();
  if (_model) options.model = _model;
  const claudeBin = resolveClaudeBin();
  if (claudeBin) options.pathToClaudeCodeExecutable = claudeBin; // PM2-safe: spawn the native binary, not `node cli.js`
  const thinkTokens = Number(process.env.ASMLTR_MAX_THINKING_TOKENS ?? 4000);
  if (thinkTokens > 0) options.maxThinkingTokens = thinkTokens;
  if (cwd) options.cwd = cwd;
  if (systemPrompt) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: systemPrompt };
  if (abortController) options.abortController = abortController;
  if (resume) options.resume = resume;
  // MCP: provision the shared asmltr registry (incl. the built-in toolbelt) as SDK mcpServers.
  try { const m = require('../../../shared/mcp-registry').forClaude(); if (Object.keys(m).length) options.mcpServers = m; } catch (_) {}

  let queryPrompt = prompt;
  if (images && images.length) {
    const content = [{ type: 'text', text: prompt || '(no text)' }];
    for (const img of images) {
      if (img && img.data && img.media_type) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
      }
    }
    if (content.length > 1) {
      queryPrompt = (async function* () {
        yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
      })();
    }
  }

  const response = await query({ prompt: queryPrompt, options });

  let text = '';
  const segments = [];
  let engineSessionId = resume || null;
  const tools = [];
  let usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  let isError = false;

  for await (const event of response) {
    if (abortController && abortController.signal.aborted) break;
    if (onEvent) { try { onEvent(event); } catch (_) {} }
    if (onDelta && event.type === 'stream_event' && event.event && event.event.type === 'content_block_delta'
        && event.event.delta && event.event.delta.type === 'text_delta' && event.event.delta.text) {
      try { onDelta(event.event.delta.text); } catch (_) {}
    }

    switch (event.type) {
      case 'system':
        if (event.session_id) engineSessionId = event.session_id;
        if (event.model) _lastModel = event.model;
        break;
      case 'assistant':
        for (const c of event.message?.content || []) {
          if (c.type === 'text' && c.text) {
            const seg = c.text.trim();
            segments.push(seg); text += (text && !text.endsWith('\n') ? '\n\n' : '') + c.text;
            if (onSegment) { try { onSegment(seg); } catch (_) {} }
          } else if (c.type === 'tool_use') {
            tools.push({ id: c.id, name: c.name, input: c.input });
            if (onTool) { try { onTool({ name: c.name, input: c.input }); } catch (_) {} }
          } else if (c.type === 'thinking' && c.thinking && onThinking) {
            try { onThinking(c.thinking); } catch (_) {}
          }
        }
        break;
      case 'result':
        if (event.session_id) engineSessionId = event.session_id;
        isError = !!event.is_error;
        if (event.usage) {
          usage.tokens_in = event.usage.input_tokens || event.usage.inputTokens || 0;
          usage.tokens_out = event.usage.output_tokens || event.usage.outputTokens || 0;
        }
        usage.cost_usd = event.total_cost_usd || event.cost_usd || 0;
        if (typeof event.result === 'string' && !text) text = event.result;
        break;
      case 'error':
        isError = true;
        break;
      default:
        break;
    }
  }

  return { text: text.trim(), segments: segments.filter(Boolean), engineSessionId, tools, usage, isError };
}

/**
 * One-shot completion for the auxiliary labelers (title/status/self-assessment). No tools, no
 * resume, cheap model. Returns the raw assistant text (caller post-processes).
 */
async function complete({ prompt, model, appendSystemPrompt = null, maxTurns = 1 }) {
  const query = q();
  const options = { stream: true, permissionMode: 'bypassPermissions', model, maxTurns };
  const claudeBin = resolveClaudeBin();
  if (claudeBin) options.pathToClaudeCodeExecutable = claudeBin;
  if (appendSystemPrompt) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: appendSystemPrompt };
  let out = '';
  const response = await query({ prompt, options });
  for await (const ev of response) {
    if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text') out += c.text;
    else if (ev.type === 'result' && ev.result && !out) out += ev.result;
  }
  return out;
}

module.exports = { id, cheapModel, runTurn, complete, getLastModel: () => _lastModel };
