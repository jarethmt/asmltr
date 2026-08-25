'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Resolve express from core/, the same place the module under test resolves it, so the host app and
// the mounted routes share one express instance (the repo installs deps per package, not at the root).
const express = require(require.resolve('express', { paths: [path.join(__dirname, '..', 'core', 'src')] }));

// Isolate the upload area BEFORE anything reads it.
const TMP = path.join(os.tmpdir(), `asmltr-uploadroutes-test-${process.pid}`);
const STAGING = path.join(os.tmpdir(), `asmltr-uploadroutes-test-staging-${process.pid}`);
process.env.ASMLTR_UPLOADS_DIR = TMP;
process.env.ASMLTR_UPLOAD_STAGING_DIR = STAGING;
process.env.ASMLTR_UPLOAD_CHUNK_SIZE = '1024';        // 1 KiB chunks so a small fixture is multi-chunk
const { mountUploadRoutes } = require('../core/src/upload-routes');

const app = express();
app.use(express.json({ limit: '10mb' }));             // mirrors core/src/server.js
mountUploadRoutes(app);

let base;
const srv = app.listen(0, '127.0.0.1');
test.before(() => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)))
  .then(() => { base = `http://127.0.0.1:${srv.address().port}`; }));
test.after(() => {
  srv.close();
  for (const d of [TMP, STAGING]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (p, body, method = 'POST') => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});
const putChunk = (id, i, buf) => fetch(`${base}/v2/upload/${id}/${i}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
});
function chunksOf(buf, size) {
  const out = [];
  for (let i = 0; i * size < buf.length; i++) out.push(buf.subarray(i * size, (i + 1) * size));
  return out;
}

test('init returns an upload id and the server-chosen chunk size', async () => {
  const res = await json('/v2/upload/init', { filename: 'a.bin', mime: 'text/plain', size: 4096 });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.ok, true);
  assert.ok(b.upload_id);
  assert.equal(b.chunk_size, 1024);
  assert.equal(b.chunks, 4);
  assert.deepEqual(b.received, []);
});

test('init rejects a request with no size', async () => {
  const res = await json('/v2/upload/init', { filename: 'a.bin' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /size/i);
});

test('a file uploaded as raw chunks lands on disk byte-identical', async () => {
  const data = crypto.randomBytes(4096);
  const init = await (await json('/v2/upload/init', { filename: 'round-trip.bin', mime: 'image/png', size: data.length })).json();

  for (const [i, c] of chunksOf(data, init.chunk_size).entries()) {
    const r = await putChunk(init.upload_id, i, c);
    assert.equal(r.status, 200, `chunk ${i} accepted`);
  }
  const fin = await (await json(`/v2/upload/${init.upload_id}/finish`, {})).json();

  assert.equal(fin.ok, true);
  assert.equal(fin.file.bytes, 4096);
  assert.equal(fin.file.kind, 'image');                       // derived from the mime, as the legacy route does
  assert.equal(fin.file.sha256, sha(data));
  assert.deepEqual(fs.readFileSync(fin.file.path), data, 'raw chunks, no base64 round trip');
});

test('GET reports received chunks so an interrupted upload can resume', async () => {
  const data = crypto.randomBytes(4096);
  const init = await (await json('/v2/upload/init', { filename: 'resume.bin', size: data.length })).json();
  const cs = chunksOf(data, init.chunk_size);
  await putChunk(init.upload_id, 0, cs[0]);
  await putChunk(init.upload_id, 2, cs[2]);

  const st = await (await fetch(`${base}/v2/upload/${init.upload_id}`)).json();
  assert.deepEqual(st.received, [0, 2]);
  assert.equal(st.chunks, 4);

  // Send only what's missing, exactly as a resuming client would.
  for (const i of [0, 1, 2, 3].filter((i) => !st.received.includes(i))) await putChunk(init.upload_id, i, cs[i]);
  const fin = await (await json(`/v2/upload/${init.upload_id}/finish`, {})).json();
  assert.deepEqual(fs.readFileSync(fin.file.path), data);
});

test('GET on an unknown upload is 404', async () => {
  assert.equal((await fetch(`${base}/v2/upload/abc123-000000`)).status, 404);
});

test('a chunk index that is not a plain integer is refused', async () => {
  const init = await (await json('/v2/upload/init', { filename: 'evil.bin', size: 4096 })).json();
  // Percent-encoded traversal is the case that matters: express decodes it to ../../etc/passwd and it
  // reaches the handler as a route param, unlike a literal '..' which the URL layer collapses first.
  for (const bad of ['-1', '1.5', 'abc', '0x1', '%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    const r = await putChunk(init.upload_id, bad, Buffer.from('x'));
    assert.equal(r.status, 400, `index ${bad} refused`);
  }
  const collapsed = await putChunk(init.upload_id, '..', Buffer.from('x'));
  assert.equal(collapsed.status, 404, 'a literal .. is normalized away before routing, so it hits no chunk route');
  assert.ok(!fs.existsSync(path.join(TMP, 'etc')), 'nothing was written outside the upload area');
});

test('a chunk for an unknown upload is 404', async () => {
  assert.equal((await putChunk('abc123-000000', 0, Buffer.from('x'))).status, 404);
});

test('finishing with chunks still missing is 409 and names them', async () => {
  const data = crypto.randomBytes(4096);
  const init = await (await json('/v2/upload/init', { filename: 'partial.bin', size: data.length })).json();
  await putChunk(init.upload_id, 0, chunksOf(data, init.chunk_size)[0]);

  const res = await json(`/v2/upload/${init.upload_id}/finish`, {});
  assert.equal(res.status, 409, 'the client should send the rest, not start over');
  assert.match((await res.json()).error, /missing chunk/i);
});

test('finishing with a checksum mismatch is 422 and discards the upload', async () => {
  const data = crypto.randomBytes(4096);
  const init = await (await json('/v2/upload/init', {
    filename: 'corrupt.bin', size: data.length, sha256: sha(Buffer.from('other')),
  })).json();
  for (const [i, c] of chunksOf(data, init.chunk_size).entries()) await putChunk(init.upload_id, i, c);

  const res = await json(`/v2/upload/${init.upload_id}/finish`, {});
  assert.equal(res.status, 422, 'the bytes are wrong; retrying the same chunks cannot help');
  assert.equal((await fetch(`${base}/v2/upload/${init.upload_id}`)).status, 404, 'discarded');
});

test('DELETE abandons an upload in progress', async () => {
  const init = await (await json('/v2/upload/init', { filename: 'abandon.bin', size: 4096 })).json();
  await putChunk(init.upload_id, 0, Buffer.alloc(1024));
  assert.equal((await fetch(`${base}/v2/upload/${init.upload_id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/v2/upload/${init.upload_id}`)).status, 404);
});

test('a chunk whose X-Chunk-Sha256 does not match its bytes is rejected', async () => {
  const data = crypto.randomBytes(4096);
  const init = await (await json('/v2/upload/init', { filename: 'tampered.bin', size: data.length })).json();
  const chunk = chunksOf(data, init.chunk_size)[0];
  const res = await fetch(`${base}/v2/upload/${init.upload_id}/0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha(Buffer.from('not these bytes')) },
    body: chunk,
  });
  assert.equal(res.status, 422, 'a corrupt chunk is caught on arrival, not at assembly');
  const st = await (await fetch(`${base}/v2/upload/${init.upload_id}`)).json();
  assert.deepEqual(st.received, [], 'the bad chunk was not staged');
});

test('a matching X-Chunk-Sha256 is accepted', async () => {
  const data = crypto.randomBytes(4096);
  const init = await (await json('/v2/upload/init', { filename: 'verified-chunks.bin', size: data.length })).json();
  for (const [i, c] of chunksOf(data, init.chunk_size).entries()) {
    const res = await fetch(`${base}/v2/upload/${init.upload_id}/${i}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha(c) },
      body: c,
    });
    assert.equal(res.status, 200);
  }
  const fin = await (await json(`/v2/upload/${init.upload_id}/finish`, {})).json();
  assert.deepEqual(fs.readFileSync(fin.file.path), data);
});

test('init refuses an absurd declared size instead of planning a billion chunks', async () => {
  const res = await json('/v2/upload/init', { filename: 'lie.bin', size: Number.MAX_SAFE_INTEGER });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /too large|maximum/i);
});

test('a chunk over the server limit returns JSON naming the cause, not an HTML stack trace', async () => {
  // Own app so the raw limit can be set at mount time without disturbing the shared one.
  const prev = process.env.ASMLTR_UPLOAD_MAX_CHUNK;
  process.env.ASMLTR_UPLOAD_MAX_CHUNK = '1kb';
  const tiny = express();
  tiny.use(express.json());
  require('../core/src/upload-routes').mountUploadRoutes(tiny);
  const srv2 = tiny.listen(0, '127.0.0.1');
  await new Promise((r) => (srv2.listening ? r() : srv2.once('listening', r)));
  const b2 = `http://127.0.0.1:${srv2.address().port}`;
  try {
    const init = await (await fetch(b2 + '/v2/upload/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'big.bin', size: 100000 }),
    })).json();
    const res = await fetch(`${b2}/v2/upload/${init.upload_id}/0`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(64 * 1024),
    });
    assert.equal(res.status, 413);
    assert.match(res.headers.get('content-type') || '', /json/, 'must not fall through to express HTML');
    assert.match((await res.json()).error, /client_max_body_size|ASMLTR_UPLOAD_MAX_CHUNK|too large/i);
  } finally {
    srv2.close();
    if (prev === undefined) delete process.env.ASMLTR_UPLOAD_MAX_CHUNK; else process.env.ASMLTR_UPLOAD_MAX_CHUNK = prev;
  }
});

test('the chunk error handler does not claim the legacy one-shot route', async () => {
  // Mounted by method+path, not by prefix: a prefix mount also caught express.json's error for
  // POST /v2/upload, whose limit has nothing to do with ASMLTR_UPLOAD_MAX_CHUNK, and told the
  // operator to raise the wrong setting.
  const host = express();
  host.use(express.json({ limit: '1kb' }));
  host.post('/v2/upload', (req, res) => res.json({ ok: true, legacy: true }));
  require('../core/src/upload-routes').mountUploadRoutes(host);
  const srv3 = host.listen(0, '127.0.0.1');
  await new Promise((r) => (srv3.listening ? r() : srv3.once('listening', r)));
  try {
    const res = await fetch(`http://127.0.0.1:${srv3.address().port}/v2/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data_base64: 'A'.repeat(4096) }),
    });
    assert.equal(res.status, 413);
    const text = await res.text();
    assert.ok(!/ASMLTR_UPLOAD_MAX_CHUNK/.test(text), `must not blame the chunk limit: ${text.slice(0, 120)}`);
  } finally { srv3.close(); }
});

test('a server-side fault is a 500 that does not leak host paths', async () => {
  const init = await (await json('/v2/upload/init', { filename: 'broken.bin', size: 4096 })).json();
  fs.writeFileSync(path.join(STAGING, init.upload_id, 'meta.json'), '{truncated');
  const res = await putChunk(init.upload_id, 0, Buffer.from('x'));
  assert.equal(res.status, 500, 'a corrupt upload is our fault, not an unknown upload');
  const body = await res.json();
  assert.ok(!/\/home\/|\/root\/|uploads-partial|\/tmp\//.test(body.error), `error must not carry host paths: ${body.error}`);
});

test('a chunk larger than the JSON body limit is accepted, which is the whole point', async () => {
  // 12 MiB of raw bytes: over express.json's 10mb cap, so this could never have been a JSON body.
  const big = 12 * 1024 * 1024;
  const data = crypto.randomBytes(big);
  const prev = process.env.ASMLTR_UPLOAD_CHUNK_SIZE;
  process.env.ASMLTR_UPLOAD_CHUNK_SIZE = String(big);
  try {
    const init = await (await json('/v2/upload/init', { filename: 'big.bin', size: big })).json();
    assert.equal(init.chunks, 1);
    assert.equal((await putChunk(init.upload_id, 0, data)).status, 200);
    const fin = await (await json(`/v2/upload/${init.upload_id}/finish`, {})).json();
    assert.equal(fin.file.bytes, big);
    assert.equal(fin.file.sha256, sha(data));
  } finally { process.env.ASMLTR_UPLOAD_CHUNK_SIZE = prev; }
});
