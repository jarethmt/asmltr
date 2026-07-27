'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Guards the #34 fix for the github poller: gh() must TIME OUT a stalled request rather than hang
// forever. The original bug: fetch() with no timeout → a connection that accepts but never responds
// hangs the poll await; over days those dead sockets exhaust undici's pool and the poller goes
// silently deaf while the process stays alive. Env base-url + timeout are read at module load, so
// they're set BEFORE requiring the connector (each test file runs in its own process).

test('gh() aborts a stalled request instead of hanging forever', async () => {
  const server = http.createServer(() => { /* accept the socket, NEVER respond → simulate the wedge */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  process.env.ASMLTR_GITHUB_API_BASE = `http://127.0.0.1:${port}`;
  process.env.ASMLTR_GITHUB_FETCH_TIMEOUT_MS = '300'; // short window for the test
  const { gh } = require('../connectors/types/github/index.js');

  const started = Date.now();
  await assert.rejects(() => gh('fake-pat', 'GET', '/user')); // must reject, not hang
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250 && elapsed < 3000, `should abort near the 300ms timeout, took ${elapsed}ms`);

  server.close();
});
