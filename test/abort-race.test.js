'use strict';
/**
 * A stop must never be silently dropped.
 *
 * The turn used to become abortable only at `inFlight.set(...)`, which sits AFTER moderation.
 * Moderation is a network call to another model and takes seconds for any sender who isn't
 * bypass_moderation — exactly the window a "stop" tends to land in. A stop arriving there got
 * `404 no in-flight turn for that conversation`, the connector answered "Couldn't stop the current
 * turn", and the turn then ran to completion anyway. Observed live 2026-08-25: message in at
 * 16:02:00, stop at 16:02:05, moderation decision at 16:02:08.
 *
 * The turn is now registered in `dispatch()` before the key lock, so it is abortable from the moment
 * it is accepted.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate every store the core opens BEFORE requiring it: temp HOME (~/.asmltr/...) + temp DBs.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-abort-race-'));
process.env.HOME = TMP;
process.env.ASMLTR_CORE_DB = path.join(TMP, 'core.db');
process.env.ASMLTR_TRUST_DB = path.join(TMP, 'trust.db');

// server.js destructures runTurn at require time, so the engine stub has to be installed first.
const runner = require('../core/src/runner');
let engineRuns = 0;
runner.runTurn = async () => { engineRuns++; return { text: 'engine ran', engineSessionId: 'stub' }; };

const moderation = require('../core/src/moderation');
const { app, dispatch } = require('../core/src/server');

/** Hold moderation open so a turn can be stopped while it sits there, like the real incident. */
function blockModeration() {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const enteredModeration = new Promise((r) => { entered = r; });
  moderation.moderate = async () => {
    entered();
    await gate;
    return { allowed: true, bypassed: false, riskLevel: 0 };
  };
  return { enteredModeration, release: () => release() };
}

function envelope(key, text = 'hello') {
  return {
    channel: 'discord',
    conversation_key: key,
    message_id: String(Date.now()),
    sender: { raw_id: '424242', raw_username: 'tester' },
    content: { text },
    delivery: 'sync',
    public: true,
  };
}

/** The real /v2/abort route, over HTTP, on an ephemeral port. */
async function withServer(fn) {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(base); }
  finally { await new Promise((r) => srv.close(r)); }
}

const postAbort = (base, key) => fetch(`${base}/v2/abort`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ conversation_key: key }),
});

test('a stop DURING moderation is honoured — 200, and the engine never runs', async () => {
  engineRuns = 0;
  const key = 'discord:test:channel:during-moderation';
  const mod = blockModeration();

  const turn = dispatch(envelope(key));      // in flight, will park in moderation
  await mod.enteredModeration;               // we are now in the window that used to 404

  await withServer(async (base) => {
    const res = await postAbort(base, key);
    const body = await res.json();
    assert.equal(res.status, 200, 'stop landing in the moderation window must not 404');
    assert.equal(body.ok, true);
    assert.equal(body.turns, 1);
  });

  mod.release();
  const actions = await turn;
  assert.deepEqual(actions, [], 'an aborted turn produces no actions');
  assert.equal(engineRuns, 0, 'the engine must not run for a turn the human already stopped');
});

test('a stop with nothing in flight still 404s', async () => {
  await withServer(async (base) => {
    const res = await postAbort(base, 'discord:test:channel:idle');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'no in-flight turn for that conversation');
  });
});

test('a stop aborts turns QUEUED behind the running one, not just the running one', async () => {
  engineRuns = 0;
  const key = 'discord:test:channel:queued';
  const mod = blockModeration();

  // Both target one conversation_key, so the second serializes behind the first on the key lock.
  const first = dispatch(envelope(key, 'first'));
  const second = dispatch(envelope(key, 'second'));
  await mod.enteredModeration;

  await withServer(async (base) => {
    const res = await postAbort(base, key);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.turns, 2, 'running + queued are both stopped');
  });

  mod.release();
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, []);
  assert.equal(engineRuns, 0, 'neither the running nor the queued turn reaches the engine');
});
