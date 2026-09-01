#!/usr/bin/env node
'use strict';
/**
 * asmltr toolbelt — an MCP stdio server that exposes asmltr's cross-session tools to ANY reasoning
 * engine (Claude/Gemini/Codex). Historically the toolbelt was a bash CLI injected into the Claude
 * system prompt; as an MCP server it becomes real, structured tools every harness can call the same way.
 *
 * Zero dependencies: a minimal newline-delimited JSON-RPC 2.0 stdio loop (the MCP stdio framing).
 * Each tool shells out to `cli/asmltr.js <subcommand>` so the CLI stays the single source of truth.
 */
const { execFile } = require('child_process');
const path = require('path');
const readline = require('readline');

const CLI = path.join(__dirname, '..', 'cli', 'asmltr.js');
const { parseDenyEnv } = require('../shared/media-allow');
const NAME = process.env.ASSISTANT_NAME || 'asmltr';

// Tool definitions → (args) => argv for `node cli/asmltr.js …`. Keep names stable + engine-agnostic.
const TOOLS = [
  { name: 'asmltr_sessions', description: `List ${NAME}'s currently active sessions across all channels — each with what it's doing (live activity) + where. To group by repo and spot collisions use asmltr_map; to check one specific path use asmltr_who.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['ls'] },
  { name: 'asmltr_map', description: `What every currently-active agent is doing and where: each active session's live activity ("what") grouped by the repo/dir it's working in ("where" — mined from ALL recent tool activity incl. shell commands, with a working-dir fallback), flagging any repo with 2+ agents as a possible collision. Use this to report cross-session status ("what's happening in the other sessions") or before starting work in a repo.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['map'] },
  { name: 'asmltr_who', description: 'Which sessions recently touched a specific file or directory — a targeted collision check for one path before you edit it.',
    inputSchema: { type: 'object', required: ['path'],
      properties: { path: { type: 'string', description: 'absolute file or directory path to check' } },
      additionalProperties: false },
    argv: (a) => ['who', a.path] },
  { name: 'asmltr_send', deny: 'send', description: 'Deliver a message OUT through any connector (discord, telegram, email, …) to a target. Discord: a channel name looks up (does not post) until they confirm the id. Host overlay may add on-behalf-of and same-guild fence. Email send is fire-and-forget (queued). On accept, reply on THIS channel immediately and stop. Do not wait on SMTP or another session. Email: --new-thread is a blank new letter (no quote, no In-Reply-To). --no-reply-all only drops extra recipients and still quotes this thread.',
    inputSchema: { type: 'object', required: ['channel', 'target', 'text'],
      properties: {
        channel: { type: 'string', description: 'discord | telegram | email | …' },
        target: { type: 'string', description: 'channel id / chat id / email address' },
        text: { type: 'string' },
        subject: { type: 'string', description: 'email subject (email only)' },
        cc: { type: 'string', description: 'email Cc (comma-separated ok)' },
        new_thread: { type: 'boolean', description: 'email: blank new thread — no quote, no In-Reply-To, no reply-all merge' },
        no_reply_all: { type: 'boolean', description: 'email: do not add other chain recipients; still quotes this thread' },
      },
      additionalProperties: false },
    argv: (a) => ['send', a.channel, a.target, a.text,
      ...(a.subject ? ['--subject', a.subject] : []),
      ...(a.cc ? ['--cc', a.cc] : []),
      ...(a.new_thread ? ['--new-thread'] : []),
      ...(a.no_reply_all ? ['--no-reply-all'] : [])] },
  { name: 'asmltr_post', deny: 'attach', description: 'Post a generated image/video to THIS channel without Bash. Same right as image/video gen — no extra grant. Only generator output or files already in attach-stage. Stages a safe name, posts, deletes after confirm. Missed delivery: retry=true.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'absolute path of the file to post' },
      caption: { type: 'string' },
      retry: { type: 'boolean', description: 're-post a complete staged file that never got a confirm' },
      name: { type: 'string', description: 'staged name for retry; omit to retry all unposted' },
    }, additionalProperties: false },
    argv: (a) => {
      if (a.retry) return ['post', 'retry', ...(a.name ? [a.name] : [])];
      if (!a.file) return ['post'];
      return ['post', '--file', a.file, ...(a.caption ? ['--caption', a.caption] : [])];
    } },
  { name: 'asmltr_announce', deny: 'send', description: `Post a non-coercive announcement other ${NAME} sessions see on their next turn (they decide what to do with it).`,
    inputSchema: { type: 'object', required: ['text'],
      properties: { text: { type: 'string' }, to: { type: 'string', description: 'optional target scope' }, urgent: { type: 'boolean' } },
      additionalProperties: false },
    argv: (a) => ['announce', a.text, ...(a.to ? ['--to', a.to] : []), ...(a.urgent ? ['--urgent'] : [])] },
  { name: 'asmltr_uploads', deny: 'uploads', description: 'List recent files uploaded to the shared upload area across channels (newest first); optional search. Owner/private turns only — not public Discord.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    argv: (a) => ['uploads', ...(a.query ? [a.query] : [])] },
  { name: 'asmltr_silo_overview', description: 'Map the Self silo (zones + counts). Use instead of Bash when shell is off.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['silo', 'overview'], deny: 'silo' },
  { name: 'asmltr_silo_ls', description: 'List a path in the Self silo.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
    argv: (a) => ['silo', 'ls', ...(a.path ? [a.path] : [])], deny: 'silo' },
  { name: 'asmltr_silo_find', description: 'Find files in the Self silo by name or content.',
    inputSchema: { type: 'object', required: ['query'],
      properties: { query: { type: 'string' }, content: { type: 'boolean' }, type: { type: 'string' } }, additionalProperties: false },
    argv: (a) => ['silo', 'find', a.query, ...(a.content ? ['--content'] : []), ...(a.type ? ['--type', a.type] : [])], deny: 'silo' },
  { name: 'asmltr_silo_get', description: 'Read a file from the Self silo.',
    inputSchema: { type: 'object', required: ['path'],
      properties: { path: { type: 'string' } }, additionalProperties: false },
    argv: (a) => ['silo', 'get', a.path], deny: 'silo' },
  { name: 'voice_join', handler: 'voice', description: 'Join the invoker current Discord voice channel and start listening. No channel-name argument. Replaces any prior connection for that guild.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'voice_leave', handler: 'voice', description: 'Leave the voice channel for this Discord turn guild. Safe if already left.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'voice_listen', handler: 'voice', description: 'Start or stop listening in the current guild voice connection. Does not leave the channel.',
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['start', 'stop'] } }, additionalProperties: false } },
  { name: 'voice_speak', handler: 'voice', description: 'Speak short text in the current guild voice connection using the bound TTS engine. Honors barge-in/cancel. Fails if not connected.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'Spoken-style text; keep it short.' } }, additionalProperties: false } },
  { name: 'voice_status', handler: 'voice', description: 'Voice connection status for this Discord turn guild. No secrets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'phone_call', handler: 'voice', description: 'Place a phone call. Not configured.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false } },
  { name: 'phone_sms', handler: 'voice', description: 'Send an SMS. Not configured.',
    inputSchema: { type: 'object', required: ['to', 'text'], properties: { to: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false } },
];
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, ''); // the CLI colorizes; the model wants plain text
function cliEnv(extra) {
  const env = { ...process.env, NO_COLOR: '1', ...(extra || {}) };
  delete env.XAI_API_KEY;
  delete env.XAI_VOICE_API_KEY;
  delete env.xai_voice_api_key;
  return env;
}
function runCli(argv, denyEnv) {
  return new Promise((resolve) => {
    const extra = {};
    if (denyEnv) extra.ASMLTR_DENY_TOOLS = String(denyEnv);
    execFile(process.execPath, [CLI, ...argv], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: cliEnv(extra) }, (err, stdout, stderr) => {
      if (err) resolve({ isError: true, text: stripAnsi(stderr || err.message || '').trim() || `exit ${err.code}` });
      else resolve({ isError: false, text: stripAnsi(stdout || '').trim() || '(no output)' });
    });
  });
}

function denyObj(deny) {
  if (deny && typeof deny === 'object' && ('shell' in deny || deny.all)) return deny;
  return parseDenyEnv(typeof deny === 'string' ? deny : (process.env.ASMLTR_DENY_TOOLS || ''));
}

function listTools(deny) {
  const denied = denyObj(deny);
  if (denied.all) return [];
  return TOOLS.filter((t) => !t.deny || !denied[t.deny]).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

async function invokeTool(name, args, { deny, turn } = {}) {
  const t = BY_NAME[name];
  if (!t) return { ok: false, error: 'unknown tool: ' + name, isError: true };
  const denied = denyObj(deny);
  if (denied.all) return { ok: false, error: 'denied', isError: true };
  if (t.deny && denied[t.deny]) return { ok: false, error: 'denied: ' + t.deny, isError: true };
  try {
    if (t.handler === 'voice') {
      const voiceTools = require('../connectors/types/discord/voice-tools');
      const r = await voiceTools.invoke(t.name, args || {}, turn || voiceTools.turnFromEnv());
      return r;
    }
    const { denyToolsEnv } = require('../shared/media-allow');
    const r = await runCli(t.argv(args || {}), denyToolsEnv(denied));
    return { ok: !r.isError, text: r.text, isError: r.isError };
  } catch (e) {
    return { ok: false, error: e.message, isError: true };
  }
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  if (msg.method === 'notifications/initialized' || msg.id === undefined) return; // notifications: no reply
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: `${NAME}-toolbelt`, version: '1.0.0' } });
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: listTools(process.env.ASMLTR_DENY_TOOLS) });
    case 'tools/call': {
      const name = (msg.params || {}).name;
      const t = BY_NAME[name];
      if (!t) return fail(msg.id, -32602, `unknown tool: ${name}`);
      const r = await invokeTool(name, (msg.params && msg.params.arguments) || {}, { deny: process.env.ASMLTR_DENY_TOOLS, turn: t.handler === 'voice' ? require('../connectors/types/discord/voice-tools').turnFromEnv() : undefined });
      if (r && r.isError && String(r.error || '').startsWith('denied:')) {
        return ok(msg.id, { content: [{ type: 'text', text: r.error }], isError: true });
      }
      const text = r && r.text != null ? r.text : JSON.stringify(r);
      return ok(msg.id, { content: [{ type: 'text', text }], isError: !!(r && (r.isError || r.ok === false)) });
    }
    default:
      return fail(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => { const s = line.trim(); if (!s) return; let msg; try { msg = JSON.parse(s); } catch { return; } Promise.resolve(handle(msg)).catch(() => {}); });
  rl.on('close', () => process.exit(0));
}

module.exports = { TOOLS, BY_NAME, listTools, invokeTool, handle, runCli };
