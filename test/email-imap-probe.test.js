'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Guards the #34 fix for the email connector: the IMAP watcher probes liveness with a time-boxed NOOP
// so a silently-dropped IDLE (half-open TCP, no 'close' event) is detected instead of going deaf. The
// probe RESOLVES when the link answers and REJECTS when it's dead or stalls — the caller heartbeats on
// resolve and forces a reconnect on reject. Dead handle (!imap / !usable) schedules connectImap instead
// of returning as a no-op; fetchNew closes on connection-class errors and extra-passes after busy.
const {
  imapNoopProbe, isImapConnectionError, moreUidsWaiting, shouldExtraFetchPass,
  readLastUid, persistLastUid,
} = require('../connectors/types/email/index.js');

test('probe resolves when NOOP answers (link alive)', async () => {
  await imapNoopProbe({ noop: async () => ({}) }, 500); // resolves → no throw
});

test('probe rejects when NOOP errors (link dead)', async () => {
  await assert.rejects(() => imapNoopProbe({ noop: async () => { throw new Error('ECONNRESET'); } }, 500));
});

test('probe rejects on a hung NOOP (half-open — the exact silent-death case)', async () => {
  const started = Date.now();
  await assert.rejects(() => imapNoopProbe({ noop: () => new Promise(() => {}) /* never settles */ }, 200), /noop timeout/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 2000, `should time out near 200ms, took ${elapsed}ms`);
});

test('fetchNew treats connection-class errors as reconnect (close the handle)', () => {
  for (const msg of [
    'Connection not available',
    'Not connected',
    'socket hang up',
    'Connection closed',
    'noop timeout',
  ]) {
    assert.equal(isImapConnectionError(new Error(msg)), true, msg);
  }
  assert.equal(isImapConnectionError(new Error('process failed uid 12: unexpected parse')), false);
});

test('moreUidsWaiting is uidNext ahead of lastUid+1', () => {
  assert.equal(moreUidsWaiting(null, 4), false);
  assert.equal(moreUidsWaiting({ uidNext: 5 }, 4), false); // tip is 4, nothing waiting
  assert.equal(moreUidsWaiting({ uidNext: 6 }, 4), true);  // uid 5 waiting
  assert.equal(moreUidsWaiting({ uidNext: '6' }, 4), true);
});

test('fetchNew extra pass after busy: EXISTS-during-busy is not dropped', () => {
  const base = { stopped: false, usable: true, mailbox: { uidNext: 5 }, lastUid: 4, progressed: false };
  assert.equal(shouldExtraFetchPass({ ...base, pendingExists: true }), true);
  assert.equal(shouldExtraFetchPass({ ...base, pendingExists: false }), false); // no progress, no pending — do not loop on a failed uid
  assert.equal(shouldExtraFetchPass({ ...base, pendingExists: false, progressed: true, mailbox: { uidNext: 6 } }), true);
  assert.equal(shouldExtraFetchPass({ ...base, pendingExists: true, stopped: true }), false);
  assert.equal(shouldExtraFetchPass({ ...base, pendingExists: true, usable: false }), false);
});

test('lastUid persist/read; missing file is null', () => {
  const f = path.join(os.tmpdir(), `email-lastuid-test-${process.pid}.json`);
  const prev = process.env.ASMLTR_EMAIL_LASTUID_FILE;
  process.env.ASMLTR_EMAIL_LASTUID_FILE = f;
  try {
    try { fs.unlinkSync(f); } catch (_) {}
    assert.equal(readLastUid('inst'), null);
    persistLastUid('inst', 42);
    assert.equal(readLastUid('inst'), 42);
    persistLastUid('inst', 43);
    assert.equal(readLastUid('inst'), 43); // handled advance writes the new uid
  } finally {
    if (prev === undefined) delete process.env.ASMLTR_EMAIL_LASTUID_FILE;
    else process.env.ASMLTR_EMAIL_LASTUID_FILE = prev;
    try { fs.unlinkSync(f); } catch (_) {}
  }
});
