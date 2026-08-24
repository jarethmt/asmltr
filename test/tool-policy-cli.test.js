'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const CLI = path.join(__dirname, '..', 'cli', 'asmltr.js');

function run(args, deny) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ASMLTR_DENY_TOOLS: deny, NO_COLOR: '1' },
    timeout: 15000,
  });
}

test('asmltr send refuses when send denied', () => {
  const r = run(['send', 'discord', 'x', 'hi'], 'send');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: send/);
});

test('asmltr streams refuses when streams denied', () => {
  const r = run(['streams'], 'streams');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: streams/);
});

test('asmltr silo overview refuses when silo denied', () => {
  const r = run(['silo', 'overview'], 'silo');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: silo/);
});

test('asmltr uploads refuses when uploads denied', () => {
  const r = run(['uploads'], 'uploads');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: uploads/);
});

test('asmltr announce refuses when send denied (send-class)', () => {
  const r = run(['announce', 'hi'], 'send');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: send/);
});

test('asmltr post is not send-class — still callable when send denied', () => {
  const r = run(['post'], 'send');
  assert.match(String(r.stderr || r.stdout), /usage: asmltr post|this-channel bind|no this-channel/);
  assert.equal(String(r.stderr || r.stdout).includes('denied: send'), false);
});

test('asmltr post refuses when attach denied (no image/video rights)', () => {
  const r = run(['post', '--file', '/tmp/x.png'], 'attach');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: attach/);
});

test('asmltr silo put refuses when siloWrite denied even if silo allowed', () => {
  const r = run(['silo', 'put', 'x', '/etc/hosts'], 'siloWrite');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: siloWrite/);
});
