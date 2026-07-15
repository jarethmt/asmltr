'use strict';
/**
 * asmltr version + release channel — the single source of truth for "what version am I running".
 *
 * Version is the semver in the repo-root VERSION file (falls back to package.json). The running code
 * is additionally identified by its short git sha (proves a restart landed) and, when HEAD is exactly
 * on a release tag, that tag. The update channel decides what "latest" means: `stable` = the newest
 * release tag, `edge` = origin/main. Channel persists in ~/.asmltr/update-channel (env override wins).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CHANNEL_FILE = process.env.ASMLTR_UPDATE_CHANNEL_FILE || path.join(os.homedir(), '.asmltr', 'update-channel');
const MANAGED_FILE = process.env.ASMLTR_MANAGED_FILE || path.join(os.homedir(), '.asmltr', 'managed');

function git(...args) {
  try { return execFileSync('git', ['-C', REPO, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_) { return ''; }
}

function readVersion() {
  try { const v = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim(); if (v) return v; } catch (_) {}
  try { return require(path.join(REPO, 'package.json')).version || '0.0.0'; } catch (_) { return '0.0.0'; }
}

function gitSha() { return git('rev-parse', '--short', 'HEAD') || 'unknown'; }
// The tag pointing exactly at HEAD, if any (i.e. "am I sitting on a released version").
function gitTag() { return git('describe', '--tags', '--exact-match') || null; }

const VALID_CHANNELS = ['stable', 'edge'];
function getChannel() {
  const env = process.env.ASMLTR_UPDATE_CHANNEL;
  if (env && VALID_CHANNELS.includes(env)) return env;
  try { const c = fs.readFileSync(CHANNEL_FILE, 'utf8').trim(); if (VALID_CHANNELS.includes(c)) return c; } catch (_) {}
  return 'edge'; // default: track origin/main (dev/self-hosted); downstream installs set 'stable'
}
function setChannel(c) {
  if (!VALID_CHANNELS.includes(c)) throw new Error(`invalid channel '${c}' (want stable|edge)`);
  try { fs.mkdirSync(path.dirname(CHANNEL_FILE), { recursive: true }); fs.writeFileSync(CHANNEL_FILE, c + '\n'); } catch (_) {}
  return getChannel();
}

// Is this install's code owned by an external platform (a package, an image, a config-management
// deploy) rather than a git checkout the updater can rewrite in place? Env wins & its value names the
// manager; otherwise a `~/.asmltr/managed` flag file, whose first token names the manager (bare file
// => 'external'). Same file-flag pattern as the channel & auto-update flags.
function getManaged() {
  const env = process.env.ASMLTR_UPDATE_MANAGED;
  if (env && env.trim()) return { managed: true, manager: env.trim() };
  try {
    const c = fs.readFileSync(MANAGED_FILE, 'utf8').trim();
    return { managed: true, manager: c ? c.split(/\s+/)[0] : 'external' };
  } catch (_) { return { managed: false, manager: null }; }
}

// Compact object the /version endpoints and the updater share.
function info() {
  return { version: readVersion(), sha: gitSha(), tag: gitTag(), channel: getChannel() };
}

module.exports = { readVersion, gitSha, gitTag, getChannel, setChannel, getManaged, info, REPO, VALID_CHANNELS };
