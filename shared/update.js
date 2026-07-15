'use strict';
/**
 * asmltr self-update awareness + trigger.
 *
 * Detection is read-only (git fetch + compare) and CHANNEL-aware: `edge` compares against origin/main,
 * `stable` against the newest release tag. The actual update is performed by the DETERMINISTIC updater
 * (scripts/update.js) — a scripted, verified pipeline, no LLM. The old agent update session
 * (scripts/run-update-session.js) is kept only as an escape hatch (`mode: 'agent'`) for when the
 * deterministic path can't cope with a truly bespoke install.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const version = require('./version');

const REPO = path.join(__dirname, '..'); // shared/ lives at the repo root
const AUTO_FLAG = process.env.ASMLTR_AUTOUPDATE_FILE || path.join(os.homedir(), '.asmltr', 'auto-update');

const git = async (...args) => (await execFileP('git', ['-C', REPO, ...args], { timeout: 60000 })).stdout.trim();

/** How far behind the channel target are we? Never throws. Includes version + channel + changelog. */
async function getUpdateStatus({ fetch = true, channel } = {}) {
  channel = channel || version.getChannel();
  const managed = version.getManaged();
  try {
    if (fetch) { try { await git('fetch', '--quiet', '--tags', 'origin', 'main'); } catch (_) {} }
    const head = await git('rev-parse', 'HEAD');
    let target = head, targetName = 'HEAD', latestVersion = null;
    if (channel === 'stable') {
      const tag = (await git('tag', '-l', 'v*', '--sort=-version:refname').catch(() => '')).split('\n').filter(Boolean)[0] || null;
      if (tag) { target = await git('rev-parse', tag); targetName = tag; latestVersion = tag.replace(/^v/, ''); }
    } else {
      try { target = await git('rev-parse', 'origin/main'); targetName = 'origin/main'; } catch (_) {}
    }
    let behind = 0, changelog = [];
    if (target !== head) {
      behind = Number(await git('rev-list', '--count', `HEAD..${target}`)) || 0;
      if (behind) changelog = (await git('log', '--oneline', '--no-decorate', '-20', `HEAD..${target}`)).split('\n').filter(Boolean);
    }
    // Managed installs surface how far behind they are (telemetry) but never report `available`: the
    // platform owns updates, so nothing should offer an in-place Update button or auto-trigger.
    return { ok: true, channel, version: version.readVersion(), latest_version: latestVersion, behind, available: behind > 0 && !managed.managed, managed: managed.managed, manager: managed.manager, head: head.slice(0, 7), remote: String(target).slice(0, 7), target: targetName, changelog, checked_at: Date.now() };
  } catch (e) {
    return { ok: false, channel, version: version.readVersion(), behind: 0, available: false, managed: managed.managed, manager: managed.manager, error: e.message, checked_at: Date.now() };
  }
}

/** Auto-update on/off — a file flag (survives restarts, checkable even if a DB is wedged). */
function isAutoUpdate() { try { return fs.existsSync(AUTO_FLAG); } catch { return false; } }
function setAutoUpdate(on) {
  try {
    fs.mkdirSync(path.dirname(AUTO_FLAG), { recursive: true });
    if (on) fs.writeFileSync(AUTO_FLAG, `enabled ${new Date().toISOString()}\n`);
    else if (fs.existsSync(AUTO_FLAG)) fs.unlinkSync(AUTO_FLAG);
    return isAutoUpdate();
  } catch { return isAutoUpdate(); }
}

/**
 * Spawn the DETACHED update process (survives the restart it triggers). Default: the deterministic
 * updater (scripts/update.js). `mode: 'agent'` runs the LLM update session as an escape hatch.
 */
function spawnUpdateSession({ by = 'operator', mode = 'deterministic', channel } = {}) {
  // On a managed install the platform owns the code; neither the deterministic updater nor the agent
  // escape hatch can rewrite it. Refuse instead of spawning a process that dies at the preflight.
  const managed = version.getManaged();
  if (managed.managed) return { managed: true, manager: managed.manager, started_at: Date.now() };
  const script = mode === 'agent' ? 'run-update-session.js' : 'update.js';
  const args = [path.join(__dirname, '..', 'scripts', script)];
  if (mode !== 'agent') { args.push('--by', by); if (channel) args.push('--channel', channel); }
  const child = spawn(process.execPath, args, { cwd: REPO, detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  return { pid: child.pid, started_at: Date.now(), mode };
}

// channel get/set & the managed check live in shared/version; re-exported here so callers have one
// update surface.
const getChannel = version.getChannel;
const setChannel = version.setChannel;
const getManaged = version.getManaged;

module.exports = { getUpdateStatus, isAutoUpdate, setAutoUpdate, spawnUpdateSession, getChannel, setChannel, getManaged, REPO, AUTO_FLAG };
