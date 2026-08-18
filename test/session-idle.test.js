'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-idle-'));
process.env.ASMLTR_CORE_DB = path.join(tmp, 't.db');

const sessions = require('../core/src/sessions');

after(() => {
  try { sessions.db.close(); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

test('parseIdlePolicy matches existing idle:<minutes> | infinite', () => {
  assert.equal(sessions.parseIdlePolicy('infinite'), 'infinite');
  assert.equal(sessions.parseIdlePolicy('off'), 'infinite');
  assert.equal(sessions.parseIdlePolicy('idle:15'), 'idle:15');
  assert.equal(sessions.parseIdlePolicy('15m'), 'idle:15');
  assert.equal(sessions.parseIdlePolicy('15'), 'idle:15');
  assert.equal(sessions.parseIdlePolicy('0'), 'infinite');
  assert.equal(sessions.parseIdlePolicy('idle:0'), 'infinite');
  assert.equal(sessions.parseIdlePolicy(''), null);
  assert.equal(sessions.parseIdlePolicy('nope'), null);
});

test('idlePolicyFromEnv defaults to idle:15 and honors ASMLTR_IDLE_MS / POLICY', () => {
  const prevP = process.env.ASMLTR_IDLE_POLICY;
  const prevM = process.env.ASMLTR_IDLE_MS;
  delete process.env.ASMLTR_IDLE_POLICY;
  delete process.env.ASMLTR_IDLE_MS;
  assert.equal(sessions.idlePolicyFromEnv(), 'idle:15');
  process.env.ASMLTR_IDLE_MS = '900000';
  assert.equal(sessions.idlePolicyFromEnv(), 'idle:15');
  process.env.ASMLTR_IDLE_MS = '1800000';
  assert.equal(sessions.idlePolicyFromEnv(), 'idle:30');
  process.env.ASMLTR_IDLE_MS = '0';
  assert.equal(sessions.idlePolicyFromEnv(), 'infinite');
  delete process.env.ASMLTR_IDLE_MS;
  process.env.ASMLTR_IDLE_POLICY = 'idle:45';
  assert.equal(sessions.idlePolicyFromEnv(), 'idle:45');
  process.env.ASMLTR_IDLE_POLICY = 'infinite';
  assert.equal(sessions.idlePolicyFromEnv(), 'infinite');
  if (prevP === undefined) delete process.env.ASMLTR_IDLE_POLICY; else process.env.ASMLTR_IDLE_POLICY = prevP;
  if (prevM === undefined) delete process.env.ASMLTR_IDLE_MS; else process.env.ASMLTR_IDLE_MS = prevM;
});

test('resolveForTurn persists grok resume UUID then clears it after idle', () => {
  const key = 'cli:local:james';
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const r1 = sessions.resolveForTurn(key, 'cli', 'idle:15');
  assert.equal(r1.resume, null);
  assert.equal(r1.expired, false);
  sessions.recordEngineId(key, uuid);
  const r2 = sessions.resolveForTurn(key, 'cli', 'idle:15');
  assert.equal(r2.resume, uuid);
  assert.equal(r2.expired, false);
  sessions.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE conversation_key = ?')
    .run(Date.now() - 16 * 60 * 1000, key);
  const r3 = sessions.resolveForTurn(key, 'cli', 'idle:15');
  assert.equal(r3.resume, null);
  assert.equal(r3.expired, true);
  const row = sessions.get(key);
  assert.equal(row.engine_session_id, null);
  assert.equal(row.last_stable_hash, null);
  sessions.remove(key);
});
