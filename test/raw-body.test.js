'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
// Resolve express from core/, where the module under test resolves it (deps are installed per
// package, not at the repo root).
const express = require(require.resolve('express', { paths: [path.join(__dirname, '..', 'core', 'src')] }));
const { rawBody, fileFrom, rawLimit } = require('../core/src/raw-body');

// The app is wired exactly like core/src/server.js: one global JSON parser with the 10mb limit, then
// rawBody() per route. Testing the parts in isolation would not catch the interaction that matters,
// which is whether a route can accept both shapes with express.json already installed app-wide.
function appWithBothShapes() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.post('/thing', rawBody(), (req, res) => {
    const { buffer, meta, shape } = fileFrom(req, 'data_base64');
    res.json({
      shape,
      bytes: buffer ? buffer.length : null,
      name: meta.name || null,
      first: buffer && buffer.length ? buffer[0] : null,
    });
  });
  return app;
}

async function serve(app, fn) {
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); }
  finally { srv.close(); }
}

test('a raw body larger than the JSON limit is accepted, which is the whole point', async () => {
  const body = Buffer.alloc(12 * 1024 * 1024, 9);   // 12 MiB, over express.json's 10mb
  const out = await serve(appWithBothShapes(), async (base) => {
    const res = await fetch(`${base}/thing?name=big.bin`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
    });
    assert.equal(res.status, 200);
    return res.json();
  });
  assert.equal(out.shape, 'raw');
  assert.equal(out.bytes, 12 * 1024 * 1024);
  assert.equal(out.name, 'big.bin', 'metadata comes from the query string on a raw request');
  assert.equal(out.first, 9, 'the bytes are the file, not a re-encoding of it');
});

test('the JSON shape still works, so no existing client breaks', async () => {
  const file = Buffer.from([1, 2, 3, 4]);
  const out = await serve(appWithBothShapes(), async (base) => {
    const res = await fetch(`${base}/thing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'small.bin', data_base64: file.toString('base64') }),
    });
    assert.equal(res.status, 200);
    return res.json();
  });
  assert.equal(out.shape, 'json');
  assert.equal(out.bytes, 4);
  assert.equal(out.name, 'small.bin', 'metadata is the JSON body on a JSON request');
  assert.equal(out.first, 1);
});

test('a JSON body with no file at all is not an error here', async () => {
  // A silo write can send `content` as text instead of a file. fileFrom reports no buffer and lets
  // the route decide, rather than turning a legitimate text write into a 400.
  const out = await serve(appWithBothShapes(), async (base) => {
    const res = await fetch(`${base}/thing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'notes.txt', content: 'hello' }),
    });
    return res.json();
  });
  assert.equal(out.shape, 'json');
  assert.equal(out.bytes, null);
});

test('a raw body over the limit is JSON naming the limit, not an HTML stack trace', async () => {
  // #91 was hard to diagnose because the failure never named a size anywhere the client could see.
  const saved = process.env.ASMLTR_RAW_BODY_LIMIT;
  process.env.ASMLTR_RAW_BODY_LIMIT = '1mb';
  try {
    const out = await serve(appWithBothShapes(), async (base) => {
      const res = await fetch(`${base}/thing`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(2 * 1024 * 1024, 1),
      });
      assert.equal(res.status, 413);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      return res.json();
    });
    assert.match(out.error, /1mb/, `the limit must appear in the message: ${out.error}`);
    assert.match(out.error, /ASMLTR_RAW_BODY_LIMIT/, 'and the knob that raises it');
    assert.match(out.error, /proxy/i, 'and the fact that a proxy can impose a lower one');
  } finally {
    if (saved === undefined) delete process.env.ASMLTR_RAW_BODY_LIMIT; else process.env.ASMLTR_RAW_BODY_LIMIT = saved;
  }
});

test('the raw limit is read at call time so the env var is not baked in at require', () => {
  const saved = process.env.ASMLTR_RAW_BODY_LIMIT;
  try {
    delete process.env.ASMLTR_RAW_BODY_LIMIT;
    assert.equal(rawLimit(), '1024mb', 'default matches /v2/recordings and /v2/backups/import');
    process.env.ASMLTR_RAW_BODY_LIMIT = '64mb';
    assert.equal(rawLimit(), '64mb');
  } finally {
    if (saved === undefined) delete process.env.ASMLTR_RAW_BODY_LIMIT; else process.env.ASMLTR_RAW_BODY_LIMIT = saved;
  }
});

test('a charset on the JSON content type still counts as JSON', () => {
  // Browsers send `application/json;charset=utf-8`. Treating that as raw would hand the route a
  // Buffer of JSON text and lose every field in it.
  const jsonReq = { headers: { 'content-type': 'application/json;charset=utf-8' }, body: { data_base64: Buffer.from('ab').toString('base64') } };
  assert.equal(fileFrom(jsonReq, 'data_base64').shape, 'json');
  const rawReq = { headers: { 'content-type': 'image/png' }, body: Buffer.from([7, 7]), query: { name: 'x.png' } };
  assert.equal(fileFrom(rawReq, 'data_base64').shape, 'raw');
});
