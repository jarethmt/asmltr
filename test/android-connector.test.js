'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { start, serveDisposition, isLoopback } = require('../connectors/types/android/index.js');

// End-to-end over a real ephemeral HTTP server: a device holds the SSE stream, POSTs a turn, and the
// mocked core streams deltas back down the SSE; then a manager /out push arrives as an `inject` frame.
const PORT = 31987;
const BASE = `http://127.0.0.1:${PORT}`;

function mockCtx() {
  return {
    instanceId: 'test',
    config: { http_port: PORT, bind_host: '127.0.0.1', require_token: false },
    core: { handleStream: async (_env, h) => { h.onDelta('Hello '); h.onDelta('world'); } },
    emit() {}, log() {}, heartbeat() {},
  };
}

// Collect SSE `data:` JSON frames until `predicate(frames)` is true or it times out.
function collectSSE(pathQ, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const req = http.get(BASE + pathQ, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^data: (.+)$/m.exec(line);
          if (m) { try { frames.push(JSON.parse(m[1])); } catch (_) {} }
          if (predicate(frames)) { req.destroy(); resolve(frames); return; }
        }
      });
    });
    req.on('error', (e) => { if (!/socket hang up|aborted/i.test(e.message)) reject(e); });
    setTimeout(() => { req.destroy(); resolve(frames); }, timeoutMs);
  });
}

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

test('android connector: SSE ready → turn streams deltas → /out injects', async () => {
  const inst = await start(mockCtx());
  try {
    // 1) device opens the stream; a turn POST makes the core stream two deltas + done.
    const streamed = collectSSE('/gw/stream?device=d1&name=Pixel',
      (f) => f.some((x) => x.type === 'done'));
    await new Promise((r) => setTimeout(r, 120)); // let the SSE register before the turn
    const turn = await post('/gw/turn', { device: 'd1', text: 'hi' });
    assert.equal(turn.json.ok, true);
    assert.equal(turn.json.conversation_key, 'android:test:device:d1');

    const frames = await streamed;
    assert.equal(frames[0].type, 'ready', 'first frame is ready');
    assert.equal(frames[0].conversation_key, 'android:test:device:d1');
    const deltas = frames.filter((f) => f.type === 'delta').map((f) => f.text).join('');
    assert.equal(deltas, 'Hello world', 'core deltas streamed over the SSE');
    assert.ok(frames.some((f) => f.type === 'done'), 'done frame sent');

    // 2) manager /out push → an inject frame on a freshly-opened stream for the same device.
    const injected = collectSSE('/gw/stream?device=d2',
      (f) => f.some((x) => x.type === 'inject'));
    await new Promise((r) => setTimeout(r, 120));
    const out = await post('/out', { target: 'd2', text: 'steered!' });
    assert.equal(out.json.ok, true);
    const inj = (await injected).find((f) => f.type === 'inject');
    assert.equal(inj.text, 'steered!', 'inject text pushed to the device');

    // 3) /out to an unconnected device reports ok:false (not a crash).
    const miss = await post('/out', { target: 'ghost', text: 'x' });
    assert.equal(miss.json.ok, false);
  } finally {
    await inst.stop();
  }
});

// /gw/file serves media inline only for types the webview can't execute. HTML, SVG, and XML documents
// run script, so they must come back as attachments; raster images, audio, video, PDF, and plain text
// render inline. Regression guard for the stored-XSS finding (security review 2026-08).
test('serveDisposition: renderable media inline, script-capable types as attachment', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
                   'audio/mpeg', 'audio/wav', 'video/mp4', 'application/pdf', 'text/plain',
                   'text/plain; charset=utf-8']) {
    assert.equal(serveDisposition(t), 'inline', `${t} should render inline`);
  }
  for (const t of ['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml',
                   'application/xml', 'text/xml', 'application/octet-stream', 'application/javascript',
                   '', null, undefined]) {
    assert.equal(serveDisposition(t), 'attachment', `${t} should download as an attachment`);
  }
});

// /out trusts loopback (the connector-manager) and treats every routable peer as untrusted.
test('isLoopback: only 127.0.0.1 / ::1 count as loopback', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopback({ socket: { remoteAddress: a } }), true, `${a} is loopback`);
  }
  for (const a of ['192.168.1.10', '10.0.0.5', '::ffff:192.168.1.10', '', undefined]) {
    assert.equal(isLoopback({ socket: { remoteAddress: a } }), false, `${a} is not loopback`);
  }
  assert.equal(isLoopback({}), false, 'a request with no socket is not loopback');
});
