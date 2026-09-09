'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeCoreClient } = require('../connectors/sdk');

/**
 * The [[MOOD:x]] frame has to survive THREE hops, and it only ever failed on the middle one:
 *
 *   core parses the sentinel  →  /v2/stream emits an SSE frame  →  the SDK routes it to onMood
 *
 * The parser was unit-tested (mood-sentinel.test.js) and the connector declared an onMood handler, so
 * both ends looked right — but the SDK's frame dispatch had no `mood` branch and the /v2/stream route
 * never passed onMood into the pipeline. The mood was parsed, recorded to telemetry, and silently
 * dropped on the wire. Telemetry showing the right value is NOT evidence that it was delivered.
 *
 * So this test exercises the actual transport: a stub core emits real SSE frames and we assert the
 * connector's handlers fire. A handler that is declared but never plumbed fails here.
 */

/** Spin up a stub core that replays `frames` as SSE on POST /v2/stream. */
function stubCore(frames) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const f of frames) res.write('data: ' + JSON.stringify(f) + '\n\n');
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('a mood frame reaches the connector handler', async () => {
  const { srv, url } = await stubCore([
    { type: 'mood', mood: 'angry' },
    { type: 'delta', text: 'Fine.' },
    { type: 'done', actions: [] },
  ]);
  try {
    const got = { moods: [], text: '' };
    await makeCoreClient(url).handleStream({}, {
      onMood: (m) => got.moods.push(m),
      onDelta: (t) => { got.text += t; },
    });
    assert.deepStrictEqual(got.moods, ['angry'], 'onMood never fired — the frame is not routed');
    assert.strictEqual(got.text, 'Fine.');
  } finally { srv.close(); }
});

test('a connector with no onMood handler is unaffected', async () => {
  const { srv, url } = await stubCore([
    { type: 'mood', mood: 'happy' },
    { type: 'delta', text: 'hi' },
    { type: 'done', actions: [] },
  ]);
  try {
    let text = '';
    await makeCoreClient(url).handleStream({}, { onDelta: (t) => { text += t; } });
    assert.strictEqual(text, 'hi');       // must not throw on an unhandled frame type
  } finally { srv.close(); }
});

test('a malformed mood frame is ignored rather than propagated', async () => {
  const { srv, url } = await stubCore([
    { type: 'mood' },                     // no mood value
    { type: 'delta', text: 'ok' },
    { type: 'done', actions: [] },
  ]);
  try {
    const moods = [];
    await makeCoreClient(url).handleStream({}, { onMood: (m) => moods.push(m) });
    assert.deepStrictEqual(moods, [], 'an empty mood must not reach the face');
  } finally { srv.close(); }
});

test('/v2/stream actually passes onMood into the pipeline', () => {
  // The SDK hop can be perfect while the core never emits the frame at all — that was half the bug.
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'server.js'), 'utf8');
  // Slice to the route's `dispatch(` options object. Naively cutting at the first '});' lands inside
  // `frame({ ... });` on the very first handler, which would fail even on correct code.
  const route = src.slice(src.indexOf("app.post('/v2/stream'"));
  const body = route.slice(0, route.indexOf("frame({ type: 'done'"));
  assert.ok(/onMood:/.test(body), '/v2/stream does not pass onMood — the mood can never leave the core');
  assert.ok(/type: 'mood'/.test(body), '/v2/stream does not emit a mood frame');
});
