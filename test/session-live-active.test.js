'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isLiveActive, DEFAULT_IDLE_MS, activityMs, idleMsFromEnv } = require('../insights/collector/liveActive');

test('idleMsFromEnv defaults to 30 min and honors ASMLTR_IDLE_MS', () => {
  assert.equal(DEFAULT_IDLE_MS, 1_800_000);
  assert.equal(idleMsFromEnv({}), 1_800_000);
  assert.equal(idleMsFromEnv({ ASMLTR_IDLE_MS: '1800000' }), 1_800_000);
  assert.equal(idleMsFromEnv({ ASMLTR_IDLE_MS: '900000' }), 900_000);
  assert.equal(idleMsFromEnv({ ASMLTR_IDLE_MS: '0' }), 0);
});

test('isLiveActive excludes no-pid rows past idle and keeps pid-backed rows', () => {
  const now = 1_787_086_565_957;
  const pastIdle = {
    session_id: 'assistant-web:local:owner',
    title: 'Reply With Exactly Ok',
    status: 'active',
    pid: null,
    last_activity_unix: now - DEFAULT_IDLE_MS - 1,
  };
  assert.equal(isLiveActive(pastIdle, now), false);

  const insideIdle = {
    session_id: 'web:db9cd561-5c8c-4cf1-96f9-dae2dce063ac',
    status: 'active',
    pid: null,
    last_activity_unix: now - DEFAULT_IDLE_MS + 60_000,
  };
  assert.equal(isLiveActive(insideIdle, now), true);

  const livePid = {
    session_id: 'claude:tracker',
    status: 'active',
    pid: 4242,
    last_activity_unix: now - DEFAULT_IDLE_MS - 1,
  };
  assert.equal(isLiveActive(livePid, now), true);

  const alreadyEnded = {
    status: 'ended',
    pid: null,
    last_activity_unix: now - DEFAULT_IDLE_MS - 1,
  };
  assert.equal(isLiveActive(alreadyEnded, now), false);

  const secondsTs = {
    status: 'active',
    pid: null,
    last_activity_unix: Math.floor((now - 60_000) / 1000),
  };
  assert.equal(activityMs(secondsTs.last_activity_unix), secondsTs.last_activity_unix * 1000);
  assert.equal(isLiveActive(secondsTs, now), true);
});

test('Reply With Exactly Ok last_activity is not live-active after 30 min', () => {
  const row = {
    session_id: 'assistant-web:local:owner',
    title: 'Reply With Exactly Ok',
    status: 'active',
    pid: null,
    last_activity_unix: 1787074900587, // 13:41:40 ET, hours past 30 min idle
  };
  assert.equal(isLiveActive(row, 1787086565957), false);
});
