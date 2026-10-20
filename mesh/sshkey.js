'use strict';
/**
 * mesh/sshkey.js — the asmltr host's "main" SSH identity, used to reach enrolled devices.
 *
 * Portal provisioning installs this identity's PUBLIC key into a target's authorized_keys so the
 * asmltr host can SSH into the device afterwards (over the mesh). Before any of that can work the
 * identity has to exist — so this module detects it and, only on explicit request, creates one.
 *
 * It never returns or logs private key material. `publicKey` (safe to share) is the thing callers
 * — the CLI, the web GUI's "register device" flow, the Portal — actually need.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Where we look for an existing identity, most-preferred first. */
function candidatePaths(env = process.env) {
  const home = os.homedir();
  const out = [];
  if (env.ASMLTR_MESH_SSH_KEY) out.push(env.ASMLTR_MESH_SSH_KEY);
  for (const n of ['id_ed25519', 'id_ecdsa', 'id_rsa']) out.push(path.join(home, '.ssh', n));
  out.push(path.join(home, '.asmltr', 'ssh', 'id_ed25519'));
  return out;
}

/** Where we'd create one if asked and none exists. */
function defaultCreatePath(env = process.env) {
  return env.ASMLTR_MESH_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519');
}

function readPublic(keyPath) {
  const pub = keyPath + '.pub';
  if (fs.existsSync(pub)) return fs.readFileSync(pub, 'utf8').trim();
  try { return execFileSync('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8' }).trim(); } catch (_) { return null; }
}
function fingerprint(keyPath) {
  try { return execFileSync('ssh-keygen', ['-lf', keyPath + '.pub'], { encoding: 'utf8' }).trim().split(' ').slice(0, 2).join(' '); }
  catch (_) { return null; }
}

/** Detect the main identity. Returns { exists, path, publicKey, fingerprint } — no private material. */
function detect(env = process.env) {
  for (const p of candidatePaths(env)) {
    try { if (fs.existsSync(p)) return { exists: true, path: p, publicKey: readPublic(p), fingerprint: fingerprint(p) }; }
    catch (_) { /* unreadable candidate — keep looking */ }
  }
  return { exists: false, suggestedPath: defaultCreatePath(env) };
}

/** Create an ed25519 identity (no passphrase, so unattended provisioning can use it). */
function create({ keyPath, comment, env = process.env } = {}) {
  const kp = keyPath || defaultCreatePath(env);
  if (fs.existsSync(kp)) return { created: false, ...detect(env) };
  fs.mkdirSync(path.dirname(kp), { recursive: true });
  try { fs.chmodSync(path.dirname(kp), 0o700); } catch (_) {}
  const cmt = comment || `asmltr-mesh@${os.hostname()}`;
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', cmt, '-f', kp], { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.chmodSync(kp, 0o600);
  return { created: true, path: kp, publicKey: readPublic(kp), fingerprint: fingerprint(kp) };
}

/** Detect; create only if asked. The "offer to create" lives in the caller (CLI/GUI) when !exists. */
function ensure({ create: doCreate = false, comment } = {}) {
  const d = detect();
  if (d.exists || !doCreate) return { ...d, created: false };
  return create({ comment });
}

/** The public key to install on a target's authorized_keys, or null if no identity yet. */
function publicKey() { return detect().publicKey; }

module.exports = { detect, create, ensure, publicKey, candidatePaths, defaultCreatePath };
