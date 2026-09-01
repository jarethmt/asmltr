'use strict';
/**
 * asmltr integration: ssh — reach a registered machine's SHELL (docs/INTEGRATIONS.md).
 *
 *   kind      transport   — it yields access to a MACHINE, bound to a device row
 *   lifecycle passive     — no process runs until something opens a session
 *
 * Optional by definition: asmltr works fine without it, and which machines an operator can shell
 * into is entirely a property of their setup. That is what makes this an integration rather than
 * core, even though the *device registry* it binds to is core.
 *
 * USE-BUT-NEVER-SEE is the hard rule here. A private key is the single most dangerous secret in the
 * system: it is fetched from the TRUST vault at connect time, held only in the ssh2 client's memory
 * for the life of the connection, and NEVER returned to a caller, logged, or placed anywhere the
 * model's context can reach. Config stores `credential_ref` — a vault key NAME — and nothing else.
 * This is precisely why the shell transport was sequenced after per-device revocation existed.
 */
const { Client } = require('ssh2');
const secrets = require('../../../shared/secrets');

const meta = {
  type: 'ssh',
  displayName: 'SSH (shell transport)',
  role: 'service',
  kind: 'transport',
  lifecycle: 'passive',
  optional: true,
  configSchema: {
    type: 'object',
    properties: {
      host: { type: 'string', title: 'Hostname or IP' },
      port: { type: 'integer', title: 'Port', default: 22 },
      username: { type: 'string', title: 'Username' },
      // Exactly one of these. Both are vault KEY NAMES; the values never live in this config.
      private_key_ref: { type: 'string', title: 'Private key — vault key name', default: '' },
      password_ref: { type: 'string', title: 'Password — vault key name', default: '' },
      passphrase_ref: { type: 'string', title: 'Key passphrase — vault key name', default: '' },
      keepalive_ms: { type: 'integer', title: 'Keepalive interval (ms)', default: 20000 },
    },
    required: ['host', 'username'],
  },
};

/** Resolve a `*_ref` to its value. Returns null when unset — never throws on an absent optional. */
async function ref(name) { return name ? await secrets.get(name) : null; }

/**
 * Open an interactive shell with a PTY.
 * Resolves to { stream, end() } — `stream` is a duplex: write input, read output.
 * The caller never receives the credential, only the live channel.
 */
function openShell(config, { cols = 120, rows = 30, term = 'xterm-256color' } = {}) {
  return new Promise((resolve, reject) => {
    // `settled`/`fail` live in the PROMISE scope, not the async body — the .catch below is outside
    // that body and needs to reach them.
    let settled = false;
    let conn = null;
    const fail = (e) => { if (!settled) { settled = true; try { if (conn) conn.end(); } catch (_) {} reject(e); } };

    (async () => {
      const [privateKey, password, passphrase] = await Promise.all([
        ref(config.private_key_ref), ref(config.password_ref), ref(config.passphrase_ref),
      ]);
      if (!privateKey && !password) {
        throw new Error('ssh integration has no usable credential (set private_key_ref or password_ref to a vault key)');
      }

      conn = new Client();

      conn.on('ready', () => {
        conn.shell({ term, cols, rows }, (err, stream) => {
          if (err) return fail(err);
          settled = true;
          resolve({
            stream,
            resize: (c, r) => { try { stream.setWindow(r, c, 0, 0); } catch (_) {} },
            end: () => { try { stream.end(); } catch (_) {} try { conn.end(); } catch (_) {} },
          });
        });
      });
      conn.on('error', (e) => fail(new Error(`ssh ${config.host}: ${e.message}`)));
      conn.on('close', () => { if (!settled) fail(new Error(`ssh ${config.host}: connection closed before the shell opened`)); });

      conn.connect({
        host: config.host,
        port: Number(config.port) || 22,
        username: config.username,
        privateKey: privateKey || undefined,
        passphrase: passphrase || undefined,
        password: privateKey ? undefined : (password || undefined),
        keepaliveInterval: Number(config.keepalive_ms) || 20000,
        readyTimeout: 20000,
      });
    })().catch(fail);
  });
}

/**
 * Run ONE command over an exec channel — no PTY.
 *
 * A PTY is right for an interactive, watchable session and wrong for capturing one command's output:
 * the remote line editor echoes, redraws and wraps, so the "output" arrives mixed with cursor
 * control and the prompt's own repainting. Windows PowerShell's PSReadLine makes that especially
 * visible. An exec channel gives clean stdout/stderr and a real exit code.
 */
function execCommand(config, command, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let conn = null;
    const fail = (e) => { if (!settled) { settled = true; try { if (conn) conn.end(); } catch (_) {} reject(e); } };
    const timer = setTimeout(() => fail(new Error(`ssh exec timed out after ${timeoutMs}ms`)), timeoutMs);

    (async () => {
      const [privateKey, password, passphrase] = await Promise.all([
        ref(config.private_key_ref), ref(config.password_ref), ref(config.passphrase_ref),
      ]);
      if (!privateKey && !password) throw new Error('ssh integration has no usable credential');

      conn = new Client();
      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) return fail(err);
          let stdout = '', stderr = '', code = null;
          stream.on('data', (d) => { stdout += d.toString('utf8'); });
          stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
          stream.on('exit', (c) => { code = c; });
          stream.on('close', () => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            try { conn.end(); } catch (_) {}
            resolve({ stdout, stderr, exit_code: code });
          });
        });
      });
      conn.on('error', (e) => fail(new Error(`ssh ${config.host}: ${e.message}`)));
      conn.connect({
        host: config.host, port: Number(config.port) || 22, username: config.username,
        privateKey: privateKey || undefined, passphrase: passphrase || undefined,
        password: privateKey ? undefined : (password || undefined), readyTimeout: 20000,
      });
    })().catch(fail);
  });
}

/** Connectivity probe for the Integrations page — proves credentials resolve and the host answers. */
async function test(config) {
  try {
    const s = await openShell(config, { cols: 80, rows: 24 });
    s.end();
    return { ok: true, detail: `connected to ${config.username}@${config.host}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { meta, openShell, execCommand, test };
