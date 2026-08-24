'use strict';
/**
 * MCP registry — ONE place to declare MCP servers, provisioned into whichever reasoning-engine
 * harness runs a turn (docs/REASONING-ENGINES.md). Declare a server once here and Claude (SDK
 * mcpServers), Codex (`-c mcp_servers.*`), Gemini (`gemini mcp add`), and Grok (`grok mcp add`) all get it.
 *
 * A built-in **asmltr-toolbelt** stdio server (mcp/toolbelt-server.js) is always included (unless
 * disabled), so every engine gets asmltr's cross-session tools (sessions/send/announce/uploads) —
 * the same capability that used to be a Claude-only system-prompt bash cheatsheet.
 *
 * Config: `~/.asmltr/mcp.json` = { servers: { name: { command,args,env | url, type, disabled } } }
 * (gitignored per-install; a `.example` twin ships).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
function file() { return process.env.ASMLTR_MCP_FILE || path.join(HOME, '.asmltr', 'mcp.json'); }
function load() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { servers: {} }; } }
function save(d) { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d, null, 2)); }

const TOOLBELT = 'asmltr-toolbelt';
const DEVICE = 'asmltr-device';
// The always-on built-in: asmltr's own tools, exposed as a stdio MCP server.
function builtin() {
  return { command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'toolbelt-server.js')], env: {}, type: 'stdio', builtin: true };
}
// Opt-in built-in: phone-control tools that actuate a connected android device (#77). Only provisioned
// when ASMLTR_DEVICE_TOOLS=on (installs without the android connector shouldn't advertise phone tools).
function builtinDevice() {
  return { command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'device-server.js')],
    env: { ...(process.env.ASMLTR_ANDROID_GW ? { ASMLTR_ANDROID_GW: process.env.ASMLTR_ANDROID_GW } : {}) }, type: 'stdio', builtin: true };
}

/** Merge the built-in toolbelt with user servers; user config may `disabled:true` the built-in. */
function all() {
  const cfg = load(); const servers = { ...(cfg.servers || {}) };
  const tb = servers[TOOLBELT] || {};
  servers[TOOLBELT] = { ...builtin(), ...tb }; // user can only flip `disabled` on the built-in (command/args fixed)
  servers[TOOLBELT].command = builtin().command; servers[TOOLBELT].args = builtin().args; servers[TOOLBELT].builtin = true;
  if (process.env.ASMLTR_DEVICE_TOOLS === 'on') {
    const dv = servers[DEVICE] || {};
    servers[DEVICE] = { ...builtinDevice(), ...dv };
    servers[DEVICE].command = builtinDevice().command; servers[DEVICE].args = builtinDevice().args; servers[DEVICE].builtin = true;
  }
  return servers;
}
function enabled() { const s = all(); return Object.fromEntries(Object.entries(s).filter(([, v]) => !v.disabled)); }

/** GUI/CLI listing — never leak raw env values (show which keys are set). */
function list() {
  return Object.entries(all()).map(([name, v]) => ({
    name, type: v.type || (v.url ? 'http' : 'stdio'), command: v.command || null, args: v.args || [],
    url: v.url || null, envKeys: Object.keys(v.env || {}), disabled: !!v.disabled, builtin: !!v.builtin,
  }));
}
function add(name, def) {
  const n = String(name || '').trim(); if (!/^[A-Za-z0-9._-]+$/.test(n)) throw new Error('invalid server name');
  if (n === TOOLBELT || n === DEVICE) throw new Error('reserved name');
  const d = load(); d.servers = d.servers || {};
  const clean = {};
  if (def.url) { clean.type = 'http'; clean.url = String(def.url); }
  else { clean.type = 'stdio'; clean.command = String(def.command || ''); clean.args = Array.isArray(def.args) ? def.args.map(String) : []; if (!clean.command) throw new Error('command required for a stdio server'); }
  if (def.env && typeof def.env === 'object') clean.env = def.env;
  d.servers[n] = clean; save(d); return list();
}
function remove(name) { if (name === TOOLBELT) return setDisabled(name, true); const d = load(); if (d.servers) delete d.servers[name]; save(d); return list(); }
function setDisabled(name, disabled) { const d = load(); d.servers = d.servers || {}; d.servers[name] = { ...(d.servers[name] || (name === TOOLBELT ? {} : null)), disabled: !!disabled }; save(d); return list(); }

// ── per-harness shape converters ──────────────────────────────────────────────
/** Claude Agent SDK `mcpServers` option: { name: {command,args,env} | {type:'http',url} }. */
function forClaude() {
  const out = {};
  for (const [name, v] of Object.entries(enabled())) {
    out[name] = v.url ? { type: 'http', url: v.url } : { command: v.command, args: v.args || [], env: v.env || {} };
  }
  return out;
}
/** Codex per-launch `-c mcp_servers.NAME.*` flags (TOML values). stdio + http. */
function codexArgs() {
  const args = [];
  const toml = (x) => JSON.stringify(x); // JSON is valid TOML for strings/arrays/inline-tables here
  for (const [name, v] of Object.entries(enabled())) {
    const k = `mcp_servers.${name}`;
    if (v.url) { args.push('-c', `${k}.url=${toml(v.url)}`); }
    else {
      args.push('-c', `${k}.command=${toml(v.command)}`);
      if (v.args && v.args.length) args.push('-c', `${k}.args=${toml(v.args)}`);
    }
    if (v.env && Object.keys(v.env).length) args.push('-c', `${k}.env=${toml(v.env)}`);
  }
  return args;
}
/** Gemini: reconcile the registry into gemini's persistent MCP config via `gemini mcp add` (best-effort). */
function syncGemini(bin) {
  if (!bin) return { ok: false, reason: 'gemini not installed' };
  let existing = '';
  try { existing = execFileSync(bin, ['mcp', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); } catch (_) {}
  const done = [];
  for (const [name, v] of Object.entries(enabled())) {
    if (v.url) continue; // http MCP add differs per gemini version; stdio is the portable path
    if (existing.includes(name)) continue; // already present
    try {
      const envFlags = Object.entries(v.env || {}).flatMap(([k, val]) => ['-e', `${k}=${val}`]);
      execFileSync(bin, ['mcp', 'add', ...envFlags, name, v.command, ...(v.args || [])], { stdio: 'ignore', timeout: 15000 });
      done.push(name);
    } catch (_) {}
  }
  return { ok: true, added: done };
}
/** Grok: reconcile the registry into grok's MCP config via `grok mcp add` (best-effort; mirrors Gemini). */
function syncGrok(bin) {
  if (!bin) return { ok: false, reason: 'grok not installed' };
  const done = [];
  for (const [name, v] of Object.entries(enabled())) {
    if (v.url) continue; // http/SSE add differs per grok version; stdio is the portable path
    try {
      const envFlags = Object.entries(v.env || {}).flatMap(([k, val]) => ['-e', `${k}=${val}`]);
      execFileSync(bin, ['mcp', 'add', ...envFlags, name, '--', v.command, ...(v.args || [])], { stdio: 'ignore', timeout: 15000 });
      done.push(name);
    } catch (_) {}
  }
  return { ok: true, added: done };
}

module.exports = { list, add, remove, setDisabled, all, enabled, forClaude, codexArgs, syncGemini, syncGrok, TOOLBELT, DEVICE };
