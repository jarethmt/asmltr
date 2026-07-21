'use strict';
/**
 * Auto-provision a `<agent-name>` command alias for `asmltr claude`.
 *
 * When an install sets its ASSISTANT_NAME, we can drop a tiny executable shim named after the agent
 * (e.g. `aria`) onto PATH so the operator launches a monitored session by just typing the assistant's
 * name — the muscle-memory entrypoint, now backed by asmltr. Part of the identity/Likeness plane:
 * the name you configure becomes the name you invoke.
 *
 * Safety: NEVER shadow an existing command that isn't our own shim. Conflicts refuse unless forced.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const identity = require('./identity');

const MARKER = '# asmltr-alias'; // identifies a shim we wrote, so re-provisioning is safe/idempotent

function which(name) {
  try { return execFileSync('sh', ['-c', `command -v ${name} 2>/dev/null`], { encoding: 'utf8' }).trim() || null; }
  catch (_) { return null; }
}
function isOurs(file) { try { return fs.readFileSync(file, 'utf8').includes(MARKER); } catch (_) { return false; } }
const pathDirs = () => (process.env.PATH || '').split(path.delimiter).filter(Boolean);

/** First writable bin dir, preferring the caller's choice → ~/.local/bin → /usr/local/bin. */
function writableBinDir(prefer) {
  for (const d of [prefer, path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin'].filter(Boolean)) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (_) {}
  }
  return null;
}

/**
 * @param {object} [o]
 * @param {string} [o.name]   override the alias (default: identity.aliasName())
 * @param {string} [o.dir]    preferred bin dir
 * @param {boolean} [o.force] provision even if the name already resolves to a foreign command
 * @param {string} [o.target] what the shim runs (default: `asmltr claude`)
 */
function provisionAlias({ name, dir, force = false, target } = {}) {
  const alias = String(name || identity.aliasName() || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!alias) return { ok: false, error: 'no valid alias name (set ASSISTANT_NAME)' };
  // The `<agent-name>` command points at the DEFAULT reasoning engine (asmltr claude|gemini|codex).
  if (!target) { try { target = 'asmltr ' + require('./engines').getDefault(); } catch (_) { target = 'asmltr claude'; } }

  const binDir = writableBinDir(dir);
  if (!binDir) return { ok: false, error: 'no writable bin dir on PATH (tried ~/.local/bin, /usr/local/bin)' };
  const shimPath = path.join(binDir, alias);

  // Conflict check — the operator's explicit ask: never clobber an existing command.
  const existing = which(alias);
  if (existing && path.resolve(existing) !== path.resolve(shimPath) && !isOurs(existing) && !force) {
    return { ok: false, conflict: existing,
      error: `'${alias}' already exists at ${existing} — refusing to shadow it. Pick a different ASSISTANT_NAME, or re-run with force to override.` };
  }

  const shim = `#!/bin/sh\n${MARKER}: '${alias}' → ${target} (auto-provisioned from ASSISTANT_NAME; safe to delete)\nexec ${target} "$@"\n`;
  try { fs.writeFileSync(shimPath, shim, { mode: 0o755 }); }
  catch (e) { return { ok: false, error: `could not write ${shimPath}: ${e.message}` }; }

  const onPath = pathDirs().some((d) => path.resolve(d) === path.resolve(binDir));
  return { ok: true, alias, path: shimPath, target, onPath, replacedOwn: !!(existing && isOurs(existing)),
    warning: onPath ? null : `${binDir} is not on your PATH — add it so '${alias}' is found.` };
}

/** Remove our alias shim if present (and it's ours). */
function removeAlias(name) {
  const alias = String(name || identity.aliasName() || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const p = which(alias);
  if (p && isOurs(p)) { try { fs.unlinkSync(p); return { ok: true, removed: p }; } catch (e) { return { ok: false, error: e.message }; } }
  return { ok: false, error: p ? `'${alias}' at ${p} is not an asmltr shim — left alone` : `no '${alias}' on PATH` };
}

module.exports = { provisionAlias, removeAlias, which, isOurs, MARKER };
