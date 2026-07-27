'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Guards the #34 fix for the email connector: the IMAP watcher probes liveness with a time-boxed NOOP
// so a silently-dropped IDLE (half-open TCP, no 'close' event) is detected instead of going deaf. The
// probe RESOLVES when the link answers and REJECTS when it's dead or stalls — the caller heartbeats on
// resolve and forces a reconnect on reject.
const { imapNoopProbe } = require('../connectors/types/email/index.js');

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
