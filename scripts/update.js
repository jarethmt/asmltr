#!/usr/bin/env node
'use strict';
/**
 * asmltr DETERMINISTIC updater — the LLM-free replacement for the agent update session.
 *
 * Runs the whole update as a scripted, verified pipeline:
 *   preflight → lock → snapshot rollback point → fetch → resolve channel target → (dry-run stops here)
 *   → git checkout/reset → setup-steps → env reconcile → npm install (root workspace)
 *   → dashboard rebuild (Docker) → restart-with-rollback.sh (pm2 restart + health/sha verify + auto-rollback)
 *   → announce.
 *
 * Spawned DETACHED (its own process, not asmltr-core) so it SURVIVES the restart it triggers and can
 * verify + roll back. Emits milestones to the collector under a `self-update:<ts>` session so it shows
 * on the dashboard, exactly like the old agent session — just deterministic.
 *
 * Channels: `stable` = newest release tag `vX.Y.Z`; `edge` = origin/main. Chosen via --channel, else
 * the persisted channel (shared/version.getChannel()). --ref pins an explicit tag/sha.
 *
 * Usage: node scripts/update.js [--channel stable|edge] [--ref <tag|sha>] [--dry-run] [--force]
 *                               [--no-dashboard] [--by <who>] [--json]
 * Exit: 0 ok · 1 preflight/usage · 2 rolled back · 3 manual intervention · 4 already up to date · 5 busy
 */
require('../shared/loadenv');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const version = require('../shared/version');

const REPO = path.join(__dirname, '..');
const HOME = os.homedir();
const STATE = path.join(HOME, '.asmltr');
const LOCK = path.join(STATE, 'update.lock');
const LOG = process.env.ASMLTR_UPDATE_LOG || path.join(STATE, 'update.log');
const KEY = 'self-update:' + Date.now();
const COLLECTOR = process.env.ASMLTR_COLLECTOR_BASE || process.env.ASMLTR_COLLECTOR_URL || 'http://127.0.0.1:3017';
const ITOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';

// ---- args ----
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = flag('dry-run');
const FORCE = flag('force');
const NO_DASH = flag('no-dashboard');
const JSON_OUT = flag('json');
const BY = opt('by', 'operator');
const CHANNEL = opt('channel', version.getChannel());
const REF = opt('ref', null);

// ---- io ----
function log(m) { const line = `[${new Date().toISOString()}] ${m}`; try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n'); } catch (_) {} if (!JSON_OUT) console.error(line); }
let _emit = () => {};
try {
  const { buildEvent } = require('../shared/events');
  _emit = (partial) => {
    try {
      const evt = buildEvent({ surface: 'core', source: 'core', session_id: KEY, identity: 'self-update', ...partial });
      const h = { 'Content-Type': 'application/json' }; if (ITOKEN) h.Authorization = 'Bearer ' + ITOKEN;
      fetch(COLLECTOR + '/ingest', { method: 'POST', headers: h, body: JSON.stringify(evt) }).catch(() => {});
    } catch (_) {}
  };
} catch (_) {}
const phase = (msg) => { log('▸ ' + msg); _emit({ event_type: 'control', payload: { action: 'update-phase', text: msg } }); };

// ---- shell ----
function git(...args) { const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; }
function gitOut(...args) { return git(...args).out; }
function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { cwd: o.cwd || REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: o.timeout || 15 * 60 * 1000, env: { ...process.env, ASMLTR_REPO: REPO } });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) { try { fs.appendFileSync(LOG, out + '\n'); } catch (_) {} }
  return { code: r.status == null ? 1 : r.status, out };
}

// Install workspace deps as deterministically as the install allows. `npm ci` needs a committed
// package-lock.json that matches the manifests; when it's present we get an exact-match clean
// install. If there's no lockfile (a bespoke checkout) or the lock has drifted, fall back to a
// plain `npm install`, which also refreshes the lock. Returns { code, mode } so the caller can log
// which path ran and roll back on failure.
function installDeps() {
  if (fs.existsSync(path.join(REPO, 'package-lock.json'))) {
    const ci = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: REPO, timeout: 20 * 60 * 1000 });
    if (ci.code === 0) return { code: 0, mode: 'npm ci' };
    log('npm ci failed (no lockfile match / partial tree); falling back to npm install');
  }
  const ni = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: REPO, timeout: 20 * 60 * 1000 });
  return { code: ni.code, mode: 'npm install' };
}

// ---- lock ----
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }
function acquireLock() {
  try { fs.mkdirSync(STATE, { recursive: true }); } catch (_) {}
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (cur && cur.pid && alive(cur.pid)) return false; // another update genuinely running
  } catch (_) {}
  try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now(), by: BY })); } catch (_) {}
  return true;
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch (_) {} }

function done(code, summary) {
  releaseLock();
  const result = { ok: code === 0, code, ...summary };
  _emit({ event_type: code === 0 ? 'outbound' : 'control', payload: code === 0 ? { text: `update complete → ${summary.to || ''} (v${version.readVersion()})` } : { action: 'update-result', ...result } });
  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  process.exit(code);
}

// ---- main ----
(function main() {
  if (!version.VALID_CHANNELS.includes(CHANNEL)) { log(`invalid channel '${CHANNEL}'`); if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: 'invalid channel' })); process.exit(1); }

  // preflight
  if (!fs.existsSync(path.join(REPO, '.git'))) { log('not a git checkout — cannot update'); process.exit(1); }
  if (git('rev-parse', 'HEAD').code !== 0) { log('git not usable'); process.exit(1); }

  if (!DRY && !acquireLock()) { log('another update is already running — abort'); if (JSON_OUT) console.log(JSON.stringify({ ok: false, code: 5, error: 'busy' })); process.exit(5); }
  process.on('exit', releaseLock);

  const fromSha = gitOut('rev-parse', '--short', 'HEAD');
  const rollbackSha = gitOut('rev-parse', 'HEAD');
  log(`update start — channel=${CHANNEL} from=${fromSha} v${version.readVersion()} by=${BY}${DRY ? ' (dry-run)' : ''}`);
  if (!DRY) _emit({ event_type: 'control', payload: { action: 'self-update-started', pid: process.pid, channel: CHANNEL } });

  // fetch
  phase('fetch origin + tags');
  git('fetch', '--quiet', '--tags', '--force', 'origin', 'main');

  // resolve target
  let target, targetLabel;
  if (REF) { target = REF; targetLabel = REF; }
  else if (CHANNEL === 'stable') {
    const tag = gitOut('tag', '-l', 'v*', '--sort=-version:refname').split('\n').filter(Boolean)[0];
    if (!tag) { log('stable channel: no release tags found (cut a release first). Falling back to nothing.'); return done(4, { message: 'no release tags on stable channel' }); }
    target = tag; targetLabel = tag;
  } else { target = 'origin/main'; targetLabel = 'origin/main'; }

  const targetSha = gitOut('rev-parse', target);
  if (!targetSha) { log(`cannot resolve target '${target}'`); return done(1, { error: 'bad target' }); }
  const behind = Number(gitOut('rev-list', '--count', `HEAD..${targetSha}`)) || 0;
  const changelog = behind ? gitOut('log', '--oneline', '--no-decorate', '-30', `HEAD..${targetSha}`).split('\n').filter(Boolean) : [];

  if (targetSha === rollbackSha && !FORCE) { log(`already up to date (${fromSha} on ${targetLabel})`); return done(4, { message: 'up to date', from: fromSha, to: fromSha }); }

  const toShort = targetSha.slice(0, 7);
  log(`target ${targetLabel} = ${toShort} · ${behind} commit(s) ahead`);
  if (changelog.length) log('changelog:\n  ' + changelog.join('\n  '));

  if (DRY) {
    const plan = { ok: true, dryRun: true, channel: CHANNEL, from: fromSha, to: toShort, target: targetLabel, behind, changelog,
      steps: ['git checkout ' + targetLabel, 'run setup.d steps', 'reconcile .env', 'install deps (npm ci if lockfile, else npm install)', NO_DASH ? 'skip dashboard' : 'docker compose up -d --build (dashboard)', 'restart-with-rollback.sh (pm2 restart + verify + auto-rollback)'] };
    log('DRY RUN — no changes made.');
    if (JSON_OUT) console.log(JSON.stringify(plan, null, 2));
    releaseLock();
    process.exit(0);
  }

  // checkout
  phase(`checkout ${targetLabel} (${toShort})`);
  const co = CHANNEL === 'edge' && !REF
    ? git('reset', '--hard', 'origin/main')
    : git('-c', 'advice.detachedHead=false', 'checkout', '--force', targetSha);
  if (co.code !== 0) { log('checkout failed: ' + co.err); return done(1, { error: 'checkout failed' }); }

  // self-healing setup steps + env reconcile
  phase('run setup steps');
  try { const { runSetupSteps } = require('./run-setup-steps'); const r = runSetupSteps({ log }); log(`setup: ${r.applied.length} applied, ${r.alreadyDone.length} done, ${r.skipped.length} skipped, ${r.failed.length} failed`); } catch (e) { log('setup-steps error (non-fatal): ' + e.message); }
  phase('reconcile .env');
  run(process.execPath, [path.join(REPO, 'scripts', 'reconcile-env.js')]);

  // deps (root workspace). Failure here → roll the code back BEFORE touching services.
  phase('install deps (root workspace)');
  const inst = installDeps();
  if (inst.code !== 0) {
    log(`dep install FAILED (${inst.mode}); rolling back code (services untouched, still on old build)`);
    git('reset', '--hard', rollbackSha);
    installDeps();
    return done(2, { error: 'dep install failed; rolled back', from: fromSha, to: fromSha });
  }
  log(`deps installed via ${inst.mode}`);

  // dashboard (Docker) — separate lifecycle; best-effort, does not gate the core update
  if (!NO_DASH) {
    const compose = ['insights/docker-compose.eve.yml', 'insights/docker-compose.yml'].map((f) => path.join(REPO, f)).find((f) => fs.existsSync(f));
    const hasDocker = run('docker', ['--version']).code === 0;
    if (compose && hasDocker) {
      phase('rebuild dashboard (docker compose)');
      const d = run('docker', ['compose', '-f', compose, 'up', '-d', '--build'], { timeout: 15 * 60 * 1000 });
      if (d.code !== 0) log('dashboard rebuild failed (non-fatal — core update continues)');
    } else { log('dashboard: no compose file or docker not present — skip'); }
  }

  // restart + verify + auto-rollback (handles pm2 + health/sha check; rolls back on failure)
  phase('restart + verify (auto-rollback on failure)');
  const restart = run('bash', [path.join(REPO, 'scripts', 'restart-with-rollback.sh'), rollbackSha], { timeout: 10 * 60 * 1000 });
  // restart-with-rollback.sh exit: 0 ok · 2 rolled back healthy · 3 manual intervention
  const nowSha = gitOut('rev-parse', '--short', 'HEAD');
  if (restart.code === 0) { log(`✅ update complete → ${nowSha} (v${version.readVersion()})`); return done(0, { from: fromSha, to: nowSha, behind }); }
  if (restart.code === 2) { log(`rolled back to ${nowSha} — new build failed health/verify`); return done(2, { error: 'verify failed; rolled back', from: fromSha, to: nowSha }); }
  log(`❌ update + rollback both unhealthy — manual intervention required (see ${LOG})`);
  return done(3, { error: 'manual intervention required', from: fromSha, to: nowSha });
})();
