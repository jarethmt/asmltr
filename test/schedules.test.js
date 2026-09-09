'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolate the store to a temp file BEFORE requiring the module (it reads the env at call time).
const TMP = path.join(os.tmpdir(), `asmltr-sched-test-${process.pid}.json`);
process.env.ASMLTR_SCHEDULES_FILE = TMP;
const sch = require('../shared/schedules');

test.after(() => { try { fs.unlinkSync(TMP); } catch (_) {} });

test('friendly schedule specs compile to standard cron', () => {
  assert.equal(sch.toCron({ time: '08:00', weekdays: [1, 2, 3, 4, 5] }), '0 8 * * 1,2,3,4,5');
  assert.equal(sch.toCron({ time: '08:00' }), '0 8 * * *');                 // no weekdays = every day
  assert.equal(sch.toCron({ time: '9:05', days: ['mon', 'wed'] }), '5 9 * * 1,3');
  assert.equal(sch.toCron({ every_minutes: 15 }), '*/15 * * * *');
  assert.equal(sch.toCron({ cron: ' 0 6 * * 0 ' }), '0 6 * * 0');           // raw passthrough, trimmed
});

test('validateCron rejects malformed cron', () => {
  assert.throws(() => sch.validateCron('0 8 * *'), /5 fields/);
  assert.throws(() => sch.validateCron('99 8 * * *'), /out of range/);
  assert.throws(() => sch.validateCron('0 25 * * *'), /out of range/);
});

test('matches respects fields and the POSIX DOM/DOW OR rule', () => {
  const thu0800 = new Date(2026, 6, 30, 8, 0, 0);   // Thu Jul 30 2026 08:00 local
  const sat0800 = new Date(2026, 7, 1, 8, 0, 0);    // Sat Aug 1 2026 08:00
  assert.equal(sch.matches('0 8 * * 1-5', thu0800), true);
  assert.equal(sch.matches('0 8 * * 1-5', sat0800), false);
  // both DOM and DOW restricted → match if EITHER holds (Aug 1 is the 1st, so it matches "1st OR Monday")
  assert.equal(sch.matches('0 8 1 * 1', sat0800), true);
});

test('nextRun finds the next fire strictly after the given time', () => {
  const from = new Date(2026, 6, 30, 7, 0, 0).getTime(); // Thu 07:00
  const next = new Date(sch.nextRun('0 8 * * 1-5', from));
  assert.equal(next.getHours(), 8); assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), 30); // same Thursday at 08:00
  // a minute-of-day that already passed today rolls to tomorrow
  const from2 = new Date(2026, 6, 30, 9, 0, 0).getTime();
  assert.ok(sch.nextRun('0 8 * * *', from2) > from2);
});

test('CRUD + dueJobs + markRan lifecycle', () => {
  const j = sch.create({ name: 'nightly', type: 'shell', schedule: { every_minutes: 5 }, command: 'echo hi' });
  assert.match(j.id, /^sch_/);
  assert.equal(j.cron, '*/5 * * * *');
  assert.equal(j.enabled, true);
  assert.ok(typeof j.next_run === 'number');

  // list + get
  assert.equal(sch.list().length, 1);
  assert.equal(sch.get(j.id).name, 'nightly');

  // update recomputes next_run; disabling clears it
  const paused = sch.update(j.id, { enabled: false });
  assert.equal(paused.enabled, false);
  assert.equal(paused.next_run, null);

  // a disabled job is never due; enable + force-due then confirm dueJobs surfaces it
  assert.equal(sch.dueJobs(Date.now() + 1e9).length, 0);
  sch.update(j.id, { enabled: true });
  const due = sch.dueJobs(Date.now() + 1e9); // far future → definitely past next_run
  assert.equal(due.length, 1);

  // markRan records status/output and rolls next_run forward
  const ran = sch.markRan(j.id, { status: 'ok', output: 'hi\n', ranAtMs: Date.now() });
  assert.equal(ran.last_status, 'ok');
  assert.match(ran.last_output, /hi/);
  assert.ok(ran.next_run > Date.now());

  assert.equal(sch.remove(j.id), true);
  assert.equal(sch.list().length, 0);
});

test('validateComplete rejects incomplete jobs', () => {
  assert.throws(() => sch.create({ type: 'prompt', schedule: { time: '08:00' } }), /name required/);
  assert.throws(() => sch.create({ name: 'x', type: 'prompt', schedule: { time: '08:00' } }), /need a prompt/);
  assert.throws(() => sch.create({ name: 'y', type: 'shell', schedule: { time: '08:00' } }), /command or script_path/);
});

test('V37: prompt session cannot steal Discord/email keys', () => {
  assert.equal(sch.normalizePromptSession(null), 'new');
  assert.equal(sch.normalizePromptSession('new'), 'new');
  assert.equal(sch.normalizePromptSession('schedule:sch_abc'), 'schedule:sch_abc');
  assert.throws(() => sch.normalizePromptSession('discord:guild:1:channel:2'), /cannot target/);
  assert.throws(() => sch.normalizePromptSession('email:x:thread:abc'), /cannot target/);
  assert.throws(() => sch.normalizePromptSession('github:i:repo:a/b:issue:1'), /cannot target/);
  assert.throws(() => sch.create({
    name: 'steal', type: 'prompt', schedule: { time: '08:00' }, prompt: 'hi',
    session: 'discord:dm:1',
  }), /cannot target/);
});

test('V37: runtime key falls back to schedule:<id> if a stolen key is already stored', () => {
  assert.equal(sch.promptConversationKey({ id: 'sch_1', session: 'new' }), 'schedule:sch_1');
  assert.equal(sch.promptConversationKey({ id: 'sch_1', session: 'schedule:sch_1' }), 'schedule:sch_1');
  assert.equal(sch.promptConversationKey({ id: 'sch_1', session: 'discord:x' }), 'schedule:sch_1');
});
