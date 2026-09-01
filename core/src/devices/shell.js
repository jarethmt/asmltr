'use strict';
/**
 * Device shell sessions — one PTY, many observers (docs/INTEGRATIONS.md, T3).
 *
 * The point of this module is the FAN-OUT. A shell the agent opens is not private to the agent: the
 * same byte stream is broadcast to every subscribed watcher, so an operator can open the web console
 * and see exactly what the agent is doing on a machine, live, without interrupting it. That is the
 * terminal twin of watching a remote-desktop session, and it is the same idea asmltr already applies
 * to conversation sessions — a session you can observe is a session you can trust.
 *
 * Authorization is NOT re-invented here: opening a shell requires the `shell` capability on that
 * (principal, device, transport) triple, resolved by the same default-deny/forbid-wins resolver that
 * governs screen access. Watching requires `view`.
 *
 * A scrollback buffer is kept per session so a watcher joining midway sees context rather than the
 * next keystroke in isolation — bounded, because an unbounded buffer on a chatty build log is a slow
 * memory leak.
 */
const crypto = require('crypto');
const store = require('./store');

const SCROLLBACK_BYTES = Number(process.env.ASMLTR_SHELL_SCROLLBACK || 64 * 1024);
const sessions = new Map(); // id -> { id, deviceId, principalId, shell, subs:Set, buffer:[], bytes, startedAt, closed }

function loadSshIntegration() {
  // Required lazily: an install with no ssh integration configured should not pay for the module.
  return require('../../../integrations/types/ssh');
}

/** Resolve the ssh transport config for a device, or throw a caller-friendly error. */
function sshConfigFor(deviceId) {
  const d = store.devices.get(deviceId);
  if (!d) throw new Error(`unknown device: ${deviceId}`);
  const t = d.transports.find((x) => x.transport === 'ssh');
  if (!t) throw new Error(`${d.name} has no ssh transport configured`);
  if (!t.enabled) throw new Error(`${d.name}'s ssh transport is disabled or revoked`);
  return { device: d, params: t.params || {}, credentialRefs: t.params || {} };
}

function broadcast(sess, chunk) {
  const text = chunk.toString('utf8');
  sess.buffer.push(text);
  sess.bytes += text.length;
  while (sess.bytes > SCROLLBACK_BYTES && sess.buffer.length > 1) sess.bytes -= sess.buffer.shift().length;
  for (const sub of sess.subs) { try { sub(text); } catch (_) {} }
}

/**
 * Open a shell on a device. `principalId` must hold the `shell` capability there.
 * Returns { id, device_id, name } — the caller reads output by subscribing, not from this call.
 */
async function open({ deviceId, principalId, cols, rows, surface = 'core' }) {
  const grants = store.resolveDeviceGrants(principalId, deviceId, 'ssh');
  if (!grants.allow.shell) throw new Error(`no shell grant on ${deviceId} (default-deny)`);

  const { device, params } = sshConfigFor(deviceId);
  const ssh = loadSshIntegration();
  const shell = await ssh.openShell(params, { cols, rows });

  const id = 'sh_' + crypto.randomBytes(8).toString('hex');
  const sess = { id, deviceId, principalId, shell, subs: new Set(), buffer: [], bytes: 0, startedAt: Date.now(), closed: false };
  sessions.set(id, sess);

  // Same audit table as screen sessions, so Fleet lists both and either can be killed the same way.
  store.deviceSessions.open({ id, device_id: deviceId, principal_id: principalId, transport: 'ssh', capability: 'shell', surface });

  shell.stream.on('data', (c) => broadcast(sess, c));
  if (shell.stream.stderr) shell.stream.stderr.on('data', (c) => broadcast(sess, c));
  shell.stream.on('close', () => close(id, 'closed'));

  return { id, device_id: deviceId, name: device.name };
}

/** Subscribe to a session's output. Returns an unsubscribe fn; replays scrollback immediately. */
function subscribe(id, onData) {
  const sess = sessions.get(id);
  if (!sess) return null;
  if (sess.buffer.length) { try { onData(sess.buffer.join('')); } catch (_) {} }
  sess.subs.add(onData);
  return () => sess.subs.delete(onData);
}

/** Write input. Used by the agent's tool AND by a human at the web terminal — same stream. */
function write(id, data) {
  const sess = sessions.get(id);
  if (!sess || sess.closed) return false;
  try { sess.shell.stream.write(data); return true; } catch (_) { return false; }
}

function resize(id, cols, rows) {
  const sess = sessions.get(id);
  if (sess && !sess.closed) sess.shell.resize(cols, rows);
}

function close(id, reason = 'closed') {
  const sess = sessions.get(id);
  if (!sess || sess.closed) return false;
  sess.closed = true;
  try { sess.shell.end(); } catch (_) {}
  for (const sub of sess.subs) { try { sub(null); } catch (_) {} } // null = stream ended
  sess.subs.clear();
  sessions.delete(id);
  store.deviceSessions.close(id, reason);
  return true;
}

const list = () => [...sessions.values()].map((s) => ({
  id: s.id, device_id: s.deviceId, principal_id: s.principalId,
  started_at: s.startedAt, watchers: s.subs.size,
}));

/**
 * Run one command and collect its output — the shape an agent tool wants. Opens a shell, writes the
 * command, and resolves when the prompt goes quiet. Deliberately simple: a quiescence timer rather
 * than prompt-parsing, because prompt detection across shells is a guessing game. The session stays
 * WATCHABLE for its whole life, so a human can see what ran.
 */
async function run({ deviceId, principalId, command, timeoutMs = 60000 }) {
  const grants = store.resolveDeviceGrants(principalId, deviceId, 'ssh');
  if (!grants.allow.shell) throw new Error(`no shell grant on ${deviceId} (default-deny)`);
  const { device, params } = sshConfigFor(deviceId);

  // Recorded like any other session, so a one-shot the agent runs is on the same audit trail as an
  // interactive one — "what did it do on that machine" has a single answer.
  const id = 'sh_' + crypto.randomBytes(8).toString('hex');
  store.deviceSessions.open({ id, device_id: deviceId, principal_id: principalId, transport: 'ssh', capability: 'shell', surface: 'agent-tool' });
  try {
    const r = await loadSshIntegration().execCommand(params, command, { timeoutMs });
    store.deviceSessions.close(id, 'closed');
    return { session_id: id, device_id: deviceId, name: device.name, output: r.stdout, stderr: r.stderr, exit_code: r.exit_code };
  } catch (e) {
    store.deviceSessions.close(id, 'error');
    throw e;
  }
}

module.exports = { open, subscribe, write, resize, close, list, run, sessions };
