'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isScheduleApi, scheduleApiAllowed } = require('../core/src/schedules/write-gate');

test('unauth schedule API is 401 when auth is on', () => {
  const d = scheduleApiAllowed({ authEnabled: true, session: null });
  assert.equal(d.ok, false);
  assert.equal(d.status, 401);
});

test('session may list and mutate schedules', () => {
  assert.equal(scheduleApiAllowed({ authEnabled: true, session: { sub: 'op' } }).ok, true);
});

test('auth off is break-glass', () => {
  const d = scheduleApiAllowed({ authEnabled: false, session: null });
  assert.equal(d.ok, true);
  assert.equal(d.breakGlass, true);
});

test('all /v2/schedules verbs are gated; backups schedule is not', () => {
  assert.equal(isScheduleApi('GET', '/v2/schedules'), true);
  assert.equal(isScheduleApi('POST', '/v2/schedules'), true);
  assert.equal(isScheduleApi('GET', '/v2/schedules/sch_abc'), true);
  assert.equal(isScheduleApi('PATCH', '/v2/schedules/sch_abc'), true);
  assert.equal(isScheduleApi('DELETE', '/v2/schedules/sch_abc'), true);
  assert.equal(isScheduleApi('POST', '/v2/schedules/sch_abc/run'), true);
  assert.equal(isScheduleApi('GET', '/v2/backups/schedule'), false);
  assert.equal(isScheduleApi('PUT', '/v2/backups/schedule'), false);
  assert.equal(isScheduleApi('GET', '/v2/vault/secrets'), false);
});
