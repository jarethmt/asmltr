'use strict';
/**
 * Bounce = restart the three host services (core, manager, collector).
 *
 * An inline restart from inside a live turn kills the engine while Discord is
 * still waiting on /v2/stream. The channel lock never clears and the last
 * "-# Working" / "-# Still working" chip sits forever. The only safe bounce
 * from a turn is: queue it, finish the reply, THEN restart.
 *
 * `asmltr bounce` is the front door. A turn-only PATH shim (scripts/bounce-guard)
 * rewrites `systemctl`/`pm2` restarts of the asmltr stack into that same queue.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { ASMLTR_SERVICES } = require('./runtime');

const DEFAULT_DELAY_MS = 20 * 1000;
const RESTART_ACTIONS = new Set([
  'restart', 'stop', 'kill', 'try-restart', 'reload-or-restart', 'reload',
]);
const ASMLTR_SVC_RE = /(?:^|\/)asmltr-(?:core|manager|collector|connector-manager|insights-collector)(?:\.service)?$/i;

const SYSTEMD_CORE = ['asmltr-core.service'];
const SYSTEMD_MANAGER = ['asmltr-manager.service', 'asmltr-connector-manager.service'];
const SYSTEMD_COLLECTOR = ['asmltr-collector.service', 'asmltr-insights-collector.service'];

let pending = null; // { conversationKey, delayMs, queuedAt, from }
let launchImpl = null; // tests inject

function guardDir() {
  return path.join(__dirname, '..', 'scripts', 'bounce-guard');
}

function withGuardPath(env) {
  const out = { ...env };
  const guard = guardDir();
  const cur = String(out.PATH || '');
  const parts = cur.split(path.delimiter).filter(Boolean);
  if (parts[0] !== guard) out.PATH = [guard, ...parts].join(path.delimiter);
  return out;
}

function isInsideTurn(env) {
  const e = env || process.env;
  return e.ASMLTR_INSIDE_TURN === '1' || !!(e.ASMLTR_TURN_KEY && String(e.ASMLTR_TURN_KEY).trim());
}

function looksLikeAsmltrRestart(tool, args) {
  const name = String(tool || '').split(path.sep).pop();
  if (name !== 'systemctl' && name !== 'pm2') return false;
  const a = (args || []).map((x) => String(x));
  if (!a.some((x) => RESTART_ACTIONS.has(x))) return false;
  return a.some((x) => ASMLTR_SVC_RE.test(x));
}

function parseArgs(argv) {
  const rest = argv || [];
  let delayMs = DEFAULT_DELAY_MS;
  let now = false;
  let dryRun = false;
  let fromGuard = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--now') now = true;
    else if (a === '--dry-run' || a === '-n') dryRun = true;
    else if (a === '--from-guard') fromGuard = true;
    else if (a === '--delay' && rest[i + 1] != null) {
      delayMs = Math.max(0, Number(rest[++i]) * 1000);
      if (!Number.isFinite(delayMs)) delayMs = DEFAULT_DELAY_MS;
    } else if (a.startsWith('--delay=')) {
      delayMs = Math.max(0, Number(a.slice(8)) * 1000);
      if (!Number.isFinite(delayMs)) delayMs = DEFAULT_DELAY_MS;
    }
  }
  return { delayMs, now, dryRun, fromGuard };
}

function resetForTest() {
  pending = null;
  launchImpl = null;
}

function setLaunchImpl(fn) { launchImpl = fn; }

function peekPending() { return pending ? { ...pending } : null; }

function queueAfterTurn({ conversationKey, delayMs, from } = {}) {
  const key = conversationKey || null;
  pending = {
    conversationKey: key,
    delayMs: delayMs == null ? DEFAULT_DELAY_MS : Math.max(0, Number(delayMs) || 0),
    queuedAt: Date.now(),
    from: from || 'cli',
  };
  return { ok: true, queued: true, afterTurn: true, ...pending };
}

function onTurnEnded(conversationKey) {
  if (!pending) return null;
  if (pending.conversationKey && conversationKey && pending.conversationKey !== conversationKey) {
    return null;
  }
  const spec = pending;
  pending = null;
  return launchDetached(spec);
}

function resolveRealBin(name, env) {
  const e = env || process.env;
  const guard = guardDir();
  const parts = String(e.PATH || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of parts) {
    if (path.resolve(dir) === path.resolve(guard)) continue;
    const candidate = path.join(dir, name);
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
  }
  const fallbacks = name === 'systemctl'
    ? ['/usr/bin/systemctl', '/bin/systemctl']
    : ['/usr/bin/pm2', path.join(os.homedir(), '.local', 'bin', 'pm2')];
  for (const c of fallbacks) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function systemdUserDir(homedir) {
  return path.join(homedir || os.homedir(), '.config', 'systemd', 'user');
}

function pickUnitFile(dir, candidates) {
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(dir, c))) return c.replace(/\.service$/i, ''); } catch (_) {}
  }
  return candidates[0].replace(/\.service$/i, '');
}

function systemdServiceNames(opts = {}) {
  const dir = systemdUserDir(opts.homedir);
  return [
    pickUnitFile(dir, SYSTEMD_CORE),
    pickUnitFile(dir, SYSTEMD_MANAGER),
    pickUnitFile(dir, SYSTEMD_COLLECTOR),
  ];
}

function detectSupervisor(opts = {}) {
  const env = opts.env || process.env;
  const forced = String(env.ASMLTR_SUPERVISOR || '').trim().toLowerCase();
  if (forced === 'systemd' || forced === 'pm2') return forced;
  const exec = opts.execFileSync || execFileSync;
  const systemctl = opts.systemctlBin || resolveRealBin('systemctl', env) || '/usr/bin/systemctl';
  try {
    exec(systemctl, ['--user', 'is-active', '--quiet', 'asmltr-core.service'], { stdio: 'pipe', timeout: 3000 });
    return 'systemd';
  } catch (_) {}
  return 'pm2';
}

function restartPlan(opts = {}) {
  const supervisor = detectSupervisor(opts);
  if (supervisor === 'systemd') {
    const names = systemdServiceNames(opts);
    return {
      supervisor,
      services: names,
      argv: ['--user', 'restart', ...names.map((n) => n + '.service')],
      bin: 'systemctl',
    };
  }
  return {
    supervisor: 'pm2',
    services: ASMLTR_SERVICES.slice(),
    argv: ['restart', ...ASMLTR_SERVICES],
    bin: 'pm2',
  };
}

function launchDetached(spec = {}) {
  const delayMs = spec.delayMs == null ? DEFAULT_DELAY_MS : Math.max(0, Number(spec.delayMs) || 0);
  if (typeof launchImpl === 'function') {
    return launchImpl({ ...spec, delayMs });
  }
  const plan = restartPlan({ env: spec.env, homedir: spec.homedir });
  const delaySec = Math.max(0, Math.ceil(delayMs / 1000));
  const real = resolveRealBin(plan.bin, spec.env);
  if (!real) throw new Error(`cannot bounce: ${plan.bin} not found`);
  // Detached so this process (often asmltr-core) can finish the turn and die later.
  // Absolute bin — never PATH — so the bounce-guard shim cannot intercept the real restart.
  const quoted = [real, ...plan.argv].map((s) => JSON.stringify(String(s))).join(' ');
  const script = delaySec > 0 ? `sleep ${delaySec}; exec ${quoted}` : `exec ${quoted}`;
  const child = spawn('setsid', ['bash', '-c', script], {
    detached: true,
    stdio: 'ignore',
    env: spec.env || process.env,
  });
  child.unref();
  return {
    ok: true,
    queued: true,
    afterTurn: !!spec.conversationKey,
    delayMs,
    pid: child.pid || null,
    supervisor: plan.supervisor,
    services: plan.services,
  };
}

function describePlan(opts = {}) {
  const plan = restartPlan(opts);
  return {
    supervisor: plan.supervisor,
    services: plan.services,
    command: [plan.bin, ...plan.argv].join(' '),
    delayMs: opts.delayMs == null ? DEFAULT_DELAY_MS : opts.delayMs,
  };
}

async function postCoreBounce({ coreBase, conversationKey, delayMs, fetchImpl }) {
  const base = String(coreBase || process.env.ASMLTR_CORE_BASE || 'http://127.0.0.1:3023').replace(/\/$/, '');
  const fetchFn = fetchImpl || fetch;
  const r = await fetchFn(base + '/v2/bounce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_key: conversationKey || null, delay_ms: delayMs }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `core ${r.status}`);
  return j;
}

async function runCli(argv, opts = {}) {
  const flags = parseArgs(argv);
  const env = opts.env || process.env;
  const inside = isInsideTurn(env);
  const delayMs = flags.delayMs;
  const plan = describePlan({ ...opts, env, delayMs });
  if (flags.dryRun) {
    return { ok: true, dryRun: true, inside, ...plan, message: inside
      ? 'Would queue until this turn ends, then restart. Finish the reply; do not restart inline.'
      : `Would restart in ${Math.ceil(delayMs / 1000)}s: ${plan.command}` };
  }
  const refusedNow = !!(flags.now && (inside || opts.isTTY === false));
  if (inside) {
    const key = env.ASMLTR_TURN_KEY || null;
    const queuedMsg = refusedNow
      ? '--now refused inside a live turn. Queued until this turn ends. Finish your reply; do not run more work that needs the new process.'
      : 'Queued until this turn ends. Finish your reply now. Bounce is LAST — no more tools after this, nothing that needs the restarted process.';
    if (opts.skipCore && !opts.fetchImpl) {
      const q = queueAfterTurn({ conversationKey: key, delayMs, from: flags.fromGuard ? 'guard' : 'cli' });
      return {
        ...q, supervisor: plan.supervisor, services: plan.services,
        refusedNow, fromGuard: flags.fromGuard, message: queuedMsg,
      };
    }
    try {
      const j = await postCoreBounce({
        coreBase: opts.coreBase,
        conversationKey: key,
        delayMs,
        fetchImpl: opts.fetchImpl,
      });
      return {
        ok: true, queued: true, afterTurn: true, delayMs, conversationKey: key,
        supervisor: plan.supervisor, services: plan.services,
        refusedNow, fromGuard: flags.fromGuard, message: queuedMsg, ...j,
      };
    } catch (err) {
      // Core already wedged / route missing: still delay locally so the current reply can post.
      const launched = launchDetached({ delayMs, conversationKey: key, env, homedir: opts.homedir, from: 'cli-fallback' });
      return {
        ...launched, fallback: true, refusedNow, fromGuard: flags.fromGuard,
        message: 'Core did not accept the queue (' + err.message + '). Delayed restart armed locally. Finish your reply now.',
      };
    }
  }
  if (flags.now && opts.isTTY) {
    const launched = launchDetached({ delayMs: 0, env, homedir: opts.homedir, from: 'now' });
    return { ...launched, delayMs: 0, message: 'Restarting now: ' + plan.command };
  }
  const launched = launchDetached({ delayMs, env, homedir: opts.homedir, from: 'cli' });
  return {
    ...launched,
    refusedNow,
    message: `Restart queued in ${Math.ceil(delayMs / 1000)}s: ${plan.command}`,
  };
}

module.exports = {
  DEFAULT_DELAY_MS,
  ASMLTR_SVC_RE,
  guardDir,
  withGuardPath,
  isInsideTurn,
  looksLikeAsmltrRestart,
  parseArgs,
  resetForTest,
  setLaunchImpl,
  peekPending,
  queueAfterTurn,
  onTurnEnded,
  resolveRealBin,
  systemdServiceNames,
  detectSupervisor,
  restartPlan,
  launchDetached,
  describePlan,
  postCoreBounce,
  runCli,
};
