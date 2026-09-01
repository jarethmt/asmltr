'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bounce = require('../shared/bounce');

test.afterEach(() => bounce.resetForTest());

test('looksLikeAsmltrRestart catches systemctl/pm2 of the asmltr stack', () => {
  assert.equal(bounce.looksLikeAsmltrRestart('systemctl', ['--user', 'restart', 'asmltr-core']), true);
  assert.equal(bounce.looksLikeAsmltrRestart('systemctl', ['--user', 'restart', 'asmltr-core.service']), true);
  assert.equal(bounce.looksLikeAsmltrRestart('systemctl', ['--user', 'restart', 'asmltr-core', 'asmltr-manager', 'asmltr-collector']), true);
  assert.equal(bounce.looksLikeAsmltrRestart('pm2', ['restart', 'asmltr-core', 'asmltr-insights-collector', 'asmltr-connector-manager']), true);
  assert.equal(bounce.looksLikeAsmltrRestart('systemctl', ['--user', 'stop', 'asmltr-manager.service']), true);
});

test('looksLikeAsmltrRestart ignores status, daemon-reload, and other units', () => {
  assert.equal(bounce.looksLikeAsmltrRestart('systemctl', ['--user', 'status', 'asmltr-core']), false);
  assert.equal(bounce.looksLikeAsmltrRestart('systemctl', ['--user', 'daemon-reload']), false);
  assert.equal(bounce.looksLikeAsmltrRestart('systemctl', ['--user', 'restart', 'corona.service']), false);
  assert.equal(bounce.looksLikeAsmltrRestart('pm2', ['ls']), false);
  assert.equal(bounce.looksLikeAsmltrRestart('systemctl', ['--user', 'start', 'asmltr-core']), false);
});

test('isInsideTurn reads ASMLTR_INSIDE_TURN / ASMLTR_TURN_KEY', () => {
  assert.equal(bounce.isInsideTurn({}), false);
  assert.equal(bounce.isInsideTurn({ ASMLTR_INSIDE_TURN: '1' }), true);
  assert.equal(bounce.isInsideTurn({ ASMLTR_TURN_KEY: 'discord:x:dm:1' }), true);
});

test('queueAfterTurn only fires onTurnEnded for that conversation', () => {
  const launched = [];
  bounce.setLaunchImpl((spec) => { launched.push(spec); return { ok: true, queued: true, delayMs: spec.delayMs }; });
  bounce.queueAfterTurn({ conversationKey: 'discord:dm:1', delayMs: 5000 });
  assert.equal(bounce.onTurnEnded('email:other'), null);
  assert.equal(launched.length, 0);
  const r = bounce.onTurnEnded('discord:dm:1');
  assert.equal(r.ok, true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].delayMs, 5000);
  assert.equal(bounce.peekPending(), null);
});

test('onTurnEnded with no key on the queue fires on the next turn end', () => {
  const launched = [];
  bounce.setLaunchImpl((spec) => { launched.push(spec); return { ok: true }; });
  bounce.queueAfterTurn({ delayMs: 1000 });
  bounce.onTurnEnded('any-key');
  assert.equal(launched.length, 1);
});

test('parseArgs: --now, --delay, --from-guard, --dry-run', () => {
  assert.deepEqual(bounce.parseArgs(['--now', '--delay', '8', '--from-guard']), {
    delayMs: 8000, now: true, dryRun: false, fromGuard: true,
  });
  assert.equal(bounce.parseArgs(['--delay=3']).delayMs, 3000);
  assert.equal(bounce.parseArgs(['-n']).dryRun, true);
});

test('runCli dry-run inside a turn does not launch', async () => {
  bounce.setLaunchImpl(() => { throw new Error('must not launch on dry-run'); });
  const r = await bounce.runCli(['--dry-run'], {
    env: { ASMLTR_INSIDE_TURN: '1', ASMLTR_SUPERVISOR: 'pm2', PATH: '/bin' },
    isTTY: false,
  });
  assert.equal(r.dryRun, true);
  assert.equal(r.inside, true);
  assert.ok(/turn ends/.test(r.message));
});

test('runCli --now inside a turn queues after the turn instead', async () => {
  const launched = [];
  bounce.setLaunchImpl((spec) => { launched.push(spec); return { ok: true, queued: true }; });
  const r = await bounce.runCli(['--now'], {
    env: { ASMLTR_INSIDE_TURN: '1', ASMLTR_TURN_KEY: 'discord:dm:1', ASMLTR_SUPERVISOR: 'pm2', PATH: '/bin' },
    isTTY: true,
    skipCore: true,
  });
  assert.equal(r.afterTurn, true);
  assert.equal(r.refusedNow, true);
  assert.equal(launched.length, 0);
  assert.equal(bounce.peekPending().conversationKey, 'discord:dm:1');
});

test('runCli inside a turn POSTs /v2/bounce and does not launch', async () => {
  const launched = [];
  bounce.setLaunchImpl((spec) => { launched.push(spec); return { ok: true }; });
  const posts = [];
  const r = await bounce.runCli([], {
    env: { ASMLTR_INSIDE_TURN: '1', ASMLTR_TURN_KEY: 'discord:dm:1', ASMLTR_SUPERVISOR: 'pm2', PATH: '/bin' },
    isTTY: false,
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true, queued: true }) };
    },
  });
  assert.equal(posts.length, 1);
  assert.ok(String(posts[0].url).endsWith('/v2/bounce'));
  assert.equal(posts[0].body.conversation_key, 'discord:dm:1');
  assert.equal(r.afterTurn, true);
  assert.equal(launched.length, 0);
  assert.match(r.message, /LAST/);
});

test('systemd unit pick prefers files that exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-bounce-'));
  const user = path.join(dir, '.config', 'systemd', 'user');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'asmltr-core.service'), '');
  fs.writeFileSync(path.join(user, 'asmltr-manager.service'), '');
  fs.writeFileSync(path.join(user, 'asmltr-collector.service'), '');
  const names = bounce.systemdServiceNames({ homedir: dir });
  assert.deepEqual(names, ['asmltr-core', 'asmltr-manager', 'asmltr-collector']);
});

test('pm2 restart plan names all three services', () => {
  const plan = bounce.restartPlan({ env: { ASMLTR_SUPERVISOR: 'pm2' } });
  assert.equal(plan.supervisor, 'pm2');
  for (const svc of ['asmltr-core', 'asmltr-insights-collector', 'asmltr-connector-manager']) {
    assert.ok(plan.services.includes(svc), svc);
    assert.ok(plan.argv.includes(svc), svc);
  }
});

test('withGuardPath prepends bounce-guard once', () => {
  const guard = bounce.guardDir();
  const a = bounce.withGuardPath({ PATH: '/bin' });
  assert.equal(a.PATH.startsWith(guard + path.delimiter), true);
  const b = bounce.withGuardPath(a);
  assert.equal(b.PATH.split(path.delimiter).filter((p) => p === guard).length, 1);
});

test('cli help lists asmltr bounce', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cli', 'asmltr.js'), 'utf8');
  assert.match(src, /asmltr bounce/);
  assert.match(src, /case 'bounce'/);
});

test('bounce-guard wrappers exist and intercept.js rewrites to asmltr bounce', () => {
  const dir = bounce.guardDir();
  assert.equal(fs.existsSync(path.join(dir, 'systemctl')), true);
  assert.equal(fs.existsSync(path.join(dir, 'pm2')), true);
  const src = fs.readFileSync(path.join(dir, 'intercept.js'), 'utf8');
  assert.match(src, /asmltr\.js/);
  assert.match(src, /--from-guard/);
  assert.match(src, /looksLikeAsmltrRestart/);
});
