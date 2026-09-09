'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('displayStatus uses existing idle word after last_activity + idle when no pid', async () => {
  const { displayStatus, DEFAULT_IDLE_MS } = await import('../insights/dashboard/src/lib/format.js');
  assert.equal(DEFAULT_IDLE_MS, 1_800_000);
  const now = 1_787_086_565_957;
  const pastIdle = {
    session_id: 'assistant-web:local:owner',
    status: 'active',
    pid: null,
    last_activity_unix: now - DEFAULT_IDLE_MS - 1,
  };
  assert.equal(displayStatus(pastIdle, now), 'idle');

  const insideIdle = {
    session_id: 'web:db9cd561-5c8c-4cf1-96f9-dae2dce063ac',
    status: 'active',
    pid: null,
    last_activity_unix: now - DEFAULT_IDLE_MS + 60_000,
  };
  assert.equal(displayStatus(insideIdle, now), 'active');

  const livePid = {
    session_id: 'claude:tracker',
    status: 'active',
    pid: 4242,
    last_activity_unix: now - DEFAULT_IDLE_MS - 1,
  };
  assert.equal(displayStatus(livePid, now), 'active');

  const alreadyEnded = {
    status: 'ended',
    pid: null,
    last_activity_unix: now - DEFAULT_IDLE_MS - 1,
  };
  assert.equal(displayStatus(alreadyEnded, now), 'ended');
});

test('displayStatus marks Reply With Exactly Ok idle from its last_activity_unix', async () => {
  const { displayStatus } = await import('../insights/dashboard/src/lib/format.js');
  const row = {
    session_id: 'assistant-web:local:owner',
    title: 'Reply With Exactly Ok',
    status: 'active',
    pid: null,
    last_activity_unix: 1787074900587, // 13:41:40 ET, hours past 30 min idle
  };
  assert.equal(displayStatus(row, 1787086565957), 'idle');
});
