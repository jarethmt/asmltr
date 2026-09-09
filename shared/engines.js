'use strict';
/**
 * Reasoning engines — the registry of pluggable agentic backends (harnesses) asmltr can run
 * (roadmap: docs/REASONING-ENGINES.md). Each engine wraps a CLI harness (Claude Code, Gemini CLI,
 * Codex CLI). This module owns:
 *   • the static registry of KNOWN engines (id, label, how to resolve the binary),
 *   • binary resolution + installed-detection (so the GUI/CLI can show what's actually available),
 *   • the persisted config: which engine is the DEFAULT + per-engine settings (`~/.asmltr/engines.json`).
 *
 * Capabilities + the live tool inventory are DERIVED at runtime from each harness's handshake (see the
 * engine adapters in core/src/engines/) — this file only carries the static, install-level facts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const expand = (p) => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

// Static registry — the harnesses asmltr knows how to launch. `binPaths` are fallbacks beyond $PATH.
// `pkg` is the npm package used to install/update the harness from the GUI.
const ENGINES = {
  claude: { id: 'claude', label: 'Claude', bin: 'claude', binEnv: 'ASMLTR_CLAUDE_BIN', pkg: '@anthropic-ai/claude-code',
    binPaths: ['/usr/local/bin/claude', '/usr/bin/claude', '~/.claude/local/claude', '~/.local/bin/claude'],
    defaultModel: 'opus', models: [{ id: 'opus', label: 'Opus (latest)' }, { id: 'sonnet', label: 'Sonnet (latest)' }, { id: 'haiku', label: 'Haiku (latest)' }],
    auth: { modes: ['subscription'], apiKeyEnv: null, loginCmd: 'claude', note: 'Uses your Claude subscription via the local CLI login. API-key billing is intentionally unsupported here — it would bypass your subscription and switch to metered, sandboxed billing.' } },
  gemini: { id: 'gemini', label: 'Gemini', bin: 'gemini', binEnv: 'ASMLTR_GEMINI_BIN', pkg: '@google/gemini-cli',
    binPaths: ['/usr/local/bin/gemini', '/usr/bin/gemini', '~/.local/bin/gemini'],
    defaultModel: 'gemini-2.5-pro', models: [{ id: 'gemini-2.5-pro', label: '2.5 Pro' }, { id: 'gemini-2.5-flash', label: '2.5 Flash' }, { id: 'gemini-2.0-flash', label: '2.0 Flash' }],
    auth: { modes: ['subscription', 'api_key'], apiKeyEnv: 'GEMINI_API_KEY', loginCmd: 'gemini', note: 'Subscription = Google login handled by the gemini CLI. API key = a Google AI Studio key (billed by Google).' } },
  codex: { id: 'codex', label: 'Codex', bin: 'codex', binEnv: 'ASMLTR_CODEX_BIN', pkg: '@openai/codex',
    binPaths: ['/usr/local/bin/codex', '/usr/bin/codex', '~/.local/bin/codex'],
    defaultModel: 'gpt-5-codex', models: [{ id: 'gpt-5-codex', label: 'gpt-5-codex' }, { id: 'o3', label: 'o3' }, { id: 'o4-mini', label: 'o4-mini' }, { id: 'gpt-4.1', label: 'gpt-4.1' }],
    auth: { modes: ['subscription', 'api_key'], apiKeyEnv: 'OPENAI_API_KEY', loginCmd: 'codex login', note: 'Subscription = ChatGPT login via `codex login`. API key = an OpenAI API key (metered billing).' },
    // Codex is the OpenAI-compatible vehicle: point it at any custom endpoint (self-hosted vLLM/Ollama/
    // LM Studio, a gateway, or another provider) via a base URL. The model list is then the server's.
    supportsBaseUrl: true, baseUrlHint: 'e.g. http://localhost:8000/v1 (OpenAI Responses-API compatible: vLLM, LiteLLM, a gateway)' },
  grok: { id: 'grok', label: 'Grok', bin: 'grok', binEnv: 'ASMLTR_GROK_BIN', pkg: null,
    binPaths: ['/usr/local/bin/grok', '/usr/bin/grok', '~/.grok/bin/grok', '~/.local/bin/grok'],
    defaultModel: 'grok-4.6', models: [{ id: 'grok-4.6', label: 'Grok 4.6' }, { id: 'grok-4.5', label: 'Grok 4.5' }],
    installHint: 'curl https://x.ai/cli/install.sh',
    auth: { modes: ['subscription'], apiKeyEnv: null, loginCmd: 'grok login --device-auth', note: 'Uses your xAI / SuperGrok / X Premium+ subscription via the local Grok CLI login (`~/.grok/auth.json`). API-key billing (XAI_API_KEY) is intentionally unsupported here — it would bypass the subscription and switch to metered billing.' } },
};

const isExecFile = (p) => { try { const st = fs.statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } };

/** Resolve an engine's real executable: $<binEnv> → $PATH → known install locations. null if absent. */
function resolveBin(id) {
  const e = ENGINES[id];
  if (!e) return null;
  const envBin = process.env[e.binEnv];
  if (envBin) return isExecFile(envBin) ? envBin : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExecFile(path.join(dir, e.bin))) return path.join(dir, e.bin);
  }
  for (const c of e.binPaths.map(expand)) if (isExecFile(c)) return c;
  return null;
}
function installed(id) { return !!resolveBin(id); }
function version(id) { const bin = resolveBin(id); if (!bin) return null; try { return execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch { return null; } }
const semver = (s) => { const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; };
function cleanVersion(id) { const v = semver(version(id)); return v ? v.join('.') : null; } // installed semver
/** Latest published version of an engine's npm package (network call). null on failure. */
function latestVersion(id) {
  const e = ENGINES[id]; if (!e || !e.pkg) return null;
  try { const v = execFileSync('npm', ['view', e.pkg, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim(); return semver(v) ? v : null; } catch { return null; }
}
function updateAvailable(installedV, latestV) {
  const a = semver(installedV), b = semver(latestV); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (b[i] > a[i]) return true; if (b[i] < a[i]) return false; } return false;
}

// ── persisted config (default engine + per-engine settings) ────────────────────
function file() { return process.env.ASMLTR_ENGINES_FILE || path.join(HOME, '.asmltr', 'engines.json'); }
function load() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { default: 'claude', engines: {} }; } }
function save(d) { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d, null, 2)); }

function known(id) { return !!ENGINES[id]; }
function getDefault() { const d = load().default; return known(d) ? d : 'claude'; }
function setDefault(id) { if (!known(id)) throw new Error('unknown engine: ' + id); const d = load(); d.default = id; save(d); return id; }
function config(id) { return (load().engines || {})[id] || {}; }
function setConfig(id, patch) { if (!known(id)) throw new Error('unknown engine: ' + id); const d = load(); d.engines = d.engines || {}; d.engines[id] = { ...(d.engines[id] || {}), ...patch }; save(d); return d.engines[id]; }

/** One row per known engine — the static facts the GUI/CLI need (capabilities are derived elsewhere). */
function list() {
  const def = getDefault();
  return Object.values(ENGINES).map((e) => ({
    id: e.id, label: e.label,
    installed: installed(e.id), version: version(e.id),
    isDefault: e.id === def,
    enabled: config(e.id).enabled !== false, // enabled unless explicitly disabled
    models: e.models || [], model: config(e.id).model || e.defaultModel || null,
    auth: authInfo(e.id),                    // connection descriptor + selection (never the key value)
    autoUpdate: isAutoUpdate(e.id),
    pkg: e.pkg || null, installHint: e.installHint || null, // null pkg → GUI hides npm Install (curl-only harnesses)
    supportsBaseUrl: !!e.supportsBaseUrl, baseUrl: config(e.id).base_url || '', baseUrlHint: e.baseUrlHint || '',
    config: config(e.id),
  }));
}

/** The effective model for an engine: configured → engine default → null. */
function modelFor(id) { const e = ENGINES[id]; if (!e) return null; return config(id).model || e.defaultModel || null; }

// Custom (self-hosted / alternate-provider) OpenAI-compatible endpoint for a base_url-capable engine.
function baseUrlFor(id) { const e = ENGINES[id]; return (e && e.supportsBaseUrl) ? (config(id).base_url || '') : ''; }
function setBaseUrl(id, url) {
  const e = ENGINES[id]; if (!e) throw new Error('unknown engine: ' + id);
  if (!e.supportsBaseUrl) throw new Error(`engine ${id} does not support a custom endpoint`);
  const v = String(url || '').trim();
  if (v && !/^https?:\/\//i.test(v)) throw new Error('base URL must start with http:// or https://');
  setConfig(id, { base_url: v });
  return baseUrlFor(id);
}

// ── auto-update (per engine; a scheduler in the core calls autoUpdateAll on a cadence) ─────────
function isAutoUpdate(id) { return !!config(id).autoUpdate; }
function setAutoUpdate(id, on) { if (!known(id)) throw new Error('unknown engine: ' + id); setConfig(id, { autoUpdate: !!on }); return isAutoUpdate(id); }
/** Install/update an engine's npm package to @latest (blocking). Fixed package per engine — no injection. */
function installLatest(id) {
  const e = ENGINES[id]; if (!e || !e.pkg) return { ok: false, error: 'unknown engine' };
  try { execFileSync('npm', ['install', '-g', `${e.pkg}@latest`], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 180000 }); return { ok: true, version: cleanVersion(id) }; }
  catch (err) { return { ok: false, error: String((err && (err.stderr || err.message)) || err).slice(-400) }; }
}
/** Update every installed engine that has auto-update on AND a newer version available. Returns a summary. */
function autoUpdateAll() {
  const done = [];
  for (const id of Object.keys(ENGINES)) {
    if (!installed(id) || !isAutoUpdate(id)) continue;
    const cur = cleanVersion(id); const latest = latestVersion(id);
    if (updateAvailable(cur, latest)) { const r = installLatest(id); done.push({ id, from: cur, to: r.version || latest, ok: r.ok, error: r.error }); }
  }
  return done;
}

// ── connection / auth (subscription OAuth vs API-key billing; keys live in the TRUST vault) ─────
const AUTH_SECRET = (id) => `engine_${id}_api_key`;
/** Auth descriptor + current selection for an engine. Never includes the key value. */
function authInfo(id) {
  const e = ENGINES[id]; if (!e) return null;
  const a = e.auth || { modes: ['subscription'], apiKeyEnv: null };
  const c = config(id);
  const mode = a.modes.includes(c.authMode) ? c.authMode : a.modes[0];
  return { modes: a.modes, apiKeyEnv: a.apiKeyEnv || null, loginCmd: a.loginCmd || null, note: a.note || '', mode, hasApiKey: !!c.apiKeyStored };
}
function setAuthMode(id, mode) {
  const a = authInfo(id); if (!a) throw new Error('unknown engine: ' + id);
  if (!a.modes.includes(mode)) throw new Error(`engine ${id} does not support auth mode "${mode}"`);
  setConfig(id, { authMode: mode });
  return authInfo(id);
}
/** Store an engine's API key in the vault (SACRED) + switch it to api_key mode. Never written to disk. */
async function setApiKey(id, value) {
  const a = authInfo(id); if (!a) throw new Error('unknown engine: ' + id);
  if (!a.apiKeyEnv) throw new Error(`engine ${id} does not support API-key auth`);
  const v = String(value || '').trim(); if (!v) throw new Error('empty API key');
  await require('./vault').storeSecret(AUTH_SECRET(id), { value: v }, { minTrust: 'SACRED' });
  setConfig(id, { apiKeyStored: true, authMode: 'api_key' });
  return authInfo(id);
}
async function clearApiKey(id) {
  const a = authInfo(id); if (!a) throw new Error('unknown engine: ' + id);
  try { await require('./vault').deleteSecret(AUTH_SECRET(id)); } catch (_) {}
  const patch = { apiKeyStored: false };
  if (config(id).authMode === 'api_key') patch.authMode = 'subscription';
  setConfig(id, patch);
  return authInfo(id);
}
/** Resolve the stored API key value from the vault (null if none / unreadable). */
async function apiKeyValue(id) {
  if (!config(id).apiKeyStored) return null;
  try { const s = await require('./vault').getSecret(AUTH_SECRET(id), 'engine launch'); return (s && s.value) || null; } catch (_) { return null; }
}
/** Env vars to inject when launching an engine in api_key mode ({} for subscription or if unset). */
async function envForLaunch(id) {
  const a = authInfo(id); if (!a || a.mode !== 'api_key' || !a.apiKeyEnv) return {};
  const v = await apiKeyValue(id); return v ? { [a.apiKeyEnv]: v } : {};
}

module.exports = { ENGINES, resolveBin, installed, version, cleanVersion, latestVersion, updateAvailable, known, getDefault, setDefault, config, setConfig, modelFor, baseUrlFor, setBaseUrl, authInfo, setAuthMode, setApiKey, clearApiKey, apiKeyValue, envForLaunch, isAutoUpdate, setAutoUpdate, installLatest, autoUpdateAll, list };
