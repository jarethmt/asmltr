'use strict';
/**
 * Agent runtime introspection + control — the "keep the brain current" layer.
 *
 * The model a channel turn runs is gated by the installed Agent SDK (@anthropic-ai/claude-agent-sdk):
 * an old SDK caps you to old models (that's how the core sat on Opus 4.1 for months). So "keep the
 * model up to date" = keep the SDK up to date + use a model ALIAS that tracks the latest of its tier.
 *
 * This module exposes: the model selection (persisted so the GUI can change it without a restart),
 * the SDK version (installed + latest-on-npm), an SDK auto-update flag, and a detached updater.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const REPO = path.join(__dirname, '..');
const CORE_DIR = path.join(REPO, 'core');
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
// Every PM2-managed asmltr service that runs on the SDK. An SDK bump changes on-disk code all three
// import, so all three must restart together; restarting only asmltr-core advances core onto the new
// sha while the manager & collector keep running the old one. scripts/restart-with-rollback.sh cycles
// this same set.
const ASMLTR_SERVICES = ['asmltr-core', 'asmltr-insights-collector', 'asmltr-connector-manager'];

function stateDir() {
  const d = process.env.ASMLTR_STATE_DIR || path.join(os.homedir(), '.asmltr');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
const modelFile = () => path.join(stateDir(), 'model');
const sdkAutoFile = () => path.join(stateDir(), 'sdk-auto-update');
const cliPermFile = () => path.join(stateDir(), 'cli-permission-mode');

// Model selection for the CLAUDE engine (the SDK web runner): the per-engine model from the Engines UI
// wins → the legacy GUI-set model file → ASMLTR_MODEL env → 'opus' (alias tracks the latest Opus).
// runner.js calls this every turn, so a GUI change applies on the NEXT turn with no restart.
function getModel() {
  try { const m = require('./engines').config('claude').model; if (m) return m; } catch (_) {}
  try { const v = fs.readFileSync(modelFile(), 'utf8').trim(); if (v) return v; } catch (_) {}
  return process.env.ASMLTR_MODEL || 'opus';
}
function setModel(m) {
  const v = String(m || '').trim();
  try { if (v) fs.writeFileSync(modelFile(), v); else fs.unlinkSync(modelFile()); } catch (_) {}
  return getModel();
}

function isSdkAutoUpdate() { try { return fs.readFileSync(sdkAutoFile(), 'utf8').trim() === '1'; } catch (_) { return false; } }
function setSdkAutoUpdate(b) { try { fs.writeFileSync(sdkAutoFile(), b ? '1' : '0'); } catch (_) {} return isSdkAutoUpdate(); }

// Permission mode for INTERACTIVE `asmltr claude` (terminal) sessions. Default 'bypassPermissions'
// (full-autonomy — no per-action approval), matching how channel sessions already run. Persisted so
// the GUI/TUI can toggle it; asmltr-engine.js reads it at launch. Channel/SDK sessions are unaffected.
const VALID_PERM = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
function getCliPermissionMode() {
  try { const v = fs.readFileSync(cliPermFile(), 'utf8').trim(); if (VALID_PERM.includes(v)) return v; } catch (_) {}
  const env = process.env.ASMLTR_CLI_PERMISSION_MODE;
  return VALID_PERM.includes(env) ? env : 'bypassPermissions';
}
function setCliPermissionMode(m) {
  const v = VALID_PERM.includes(m) ? m : 'bypassPermissions';
  try { fs.writeFileSync(cliPermFile(), v); } catch (_) {}
  return getCliPermissionMode();
}

function sdkVersion() {
  try { return require(path.join(CORE_DIR, 'node_modules', SDK_PKG, 'package.json')).version; } catch (_) { return null; }
}

let _latest = { v: null, at: 0 };
async function latestSdkVersion({ fetch = true } = {}) {
  if (_latest.v && (!fetch || Date.now() - _latest.at < 3600000)) return _latest.v; // 1h cache
  try {
    const { stdout } = await execFileP('npm', ['view', SDK_PKG, 'version'], { timeout: 15000 });
    const v = stdout.trim();
    if (v) _latest = { v, at: Date.now() };
    return _latest.v;
  } catch (_) { return _latest.v; }
}

/** Update the SDK to latest + restart every asmltr service, detached so it survives the restart. */
function updateSdk() {
  const log = path.join(stateDir(), 'sdk-update.log');
  const script = `echo "[$(date)] updating ${SDK_PKG}"; cd ${CORE_DIR} && npm install ${SDK_PKG}@latest --legacy-peer-deps && pm2 restart ${ASMLTR_SERVICES.join(' ')}; echo "[$(date)] done"`;
  const child = spawn('setsid', ['bash', '-c', `sleep 1; { ${script}; } >> ${log} 2>&1`], { detached: true, stdio: 'ignore' });
  child.unref();
  return { started: true, pid: child.pid || null, log };
}

async function status({ fetch = true } = {}) {
  const installed = sdkVersion();
  const latest = await latestSdkVersion({ fetch });
  return {
    sdk: { package: SDK_PKG, installed, latest, updateAvailable: !!(installed && latest && installed !== latest) },
    model: { configured: getModel() },
    autoUpdate: isSdkAutoUpdate(),
    cliPermissionMode: getCliPermissionMode(),
    cliBypass: getCliPermissionMode() === 'bypassPermissions',
  };
}

module.exports = { getModel, setModel, isSdkAutoUpdate, setSdkAutoUpdate, getCliPermissionMode, setCliPermissionMode, sdkVersion, latestSdkVersion, updateSdk, status, ASMLTR_SERVICES };
