'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Isolate the upload area BEFORE requiring the module (baseDir() reads the env at call time).
const TMP = path.join(os.tmpdir(), `asmltr-uploads-test-${process.pid}`);
// Staging is a separate tree from the upload area on purpose (it must not sit inside the Self silo),
// so the test isolates both. Pointing them at the same tmpdir would hide a regression that puts
// partials back under baseDir().
const STAGING = path.join(os.tmpdir(), `asmltr-uploads-test-staging-${process.pid}`);
process.env.ASMLTR_UPLOADS_DIR = TMP;
process.env.ASMLTR_UPLOAD_STAGING_DIR = STAGING;
process.env.ASMLTR_UPLOAD_CHUNK_SIZE = '64';   // tiny chunks so tests exercise real multi-chunk paths
const uploads = require('../shared/uploads');

test.after(() => {
  for (const d of [TMP, STAGING]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Split a buffer the way a client would: file.slice(i*chunk, (i+1)*chunk).
function chunksOf(buf, size) {
  const out = [];
  for (let i = 0; i * size < buf.length; i++) out.push(buf.subarray(i * size, (i + 1) * size));
  return out;
}

test('beginChunked mints an id and reports the chunk size without touching the manifest', () => {
  const before = uploads.list({ limit: 0 }).length;
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'a.bin', mime: 'application/octet-stream', size: 200 });
  assert.match(s.upload_id, /^[a-z0-9]+-[0-9a-f]{6}$/);
  assert.equal(s.chunk_size, 64);
  assert.deepEqual(s.received, []);
  assert.equal(uploads.list({ limit: 0 }).length, before, 'an unfinished upload must not appear in the manifest');
});

test('chunks sent in order assemble into the original bytes and register one manifest record', () => {
  const data = crypto.randomBytes(200);
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'ordered.bin', mime: 'text/plain', size: data.length });
  chunksOf(data, s.chunk_size).forEach((c, i) => uploads.putChunk(s.upload_id, i, c));
  const rec = uploads.finishChunked(s.upload_id);

  assert.equal(rec.size, 200);
  assert.equal(rec.channel, 'assistant-web');
  assert.equal(rec.filename, 'ordered.bin');
  assert.deepEqual(fs.readFileSync(rec.path), data, 'assembled file must be byte-identical');
  assert.ok(uploads.list({ limit: 0 }).some((r) => r.id === rec.id), 'finished upload is in the manifest');
});

test('chunks that arrive out of order still assemble correctly', () => {
  const data = crypto.randomBytes(200);
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'shuffled.bin', size: data.length });
  const cs = chunksOf(data, s.chunk_size);
  [3, 0, 2, 1].forEach((i) => { if (cs[i]) uploads.putChunk(s.upload_id, i, cs[i]); });
  const rec = uploads.finishChunked(s.upload_id);
  assert.deepEqual(fs.readFileSync(rec.path), data);
});

test('chunkStatus reports received indices so a client can resume, and re-sending a chunk is idempotent', () => {
  const data = crypto.randomBytes(200);
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'resume.bin', size: data.length });
  const cs = chunksOf(data, s.chunk_size);
  uploads.putChunk(s.upload_id, 0, cs[0]);
  uploads.putChunk(s.upload_id, 2, cs[2]);
  uploads.putChunk(s.upload_id, 0, cs[0]);                       // duplicate: a retried chunk

  const st = uploads.chunkStatus(s.upload_id);
  assert.deepEqual(st.received, [0, 2], 'received indices are sorted and deduplicated');
  assert.equal(st.size, 200);
  assert.equal(st.chunk_size, 64);

  uploads.putChunk(s.upload_id, 1, cs[1]);
  uploads.putChunk(s.upload_id, 3, cs[3]);
  assert.deepEqual(fs.readFileSync(uploads.finishChunked(s.upload_id).path), data);
});

test('chunkStatus returns null for an unknown upload id', () => {
  assert.equal(uploads.chunkStatus('nope-000000'), null);
});

test('finishChunked refuses to assemble while chunks are missing', () => {
  const data = crypto.randomBytes(200);
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'incomplete.bin', size: data.length });
  uploads.putChunk(s.upload_id, 0, chunksOf(data, s.chunk_size)[0]);
  const before = uploads.list({ limit: 0 }).length;
  assert.throws(() => uploads.finishChunked(s.upload_id), /missing chunk/i);
  assert.equal(uploads.list({ limit: 0 }).length, before, 'a failed finish must not write a manifest record');
});

test('finishChunked rejects a sha256 mismatch and leaves nothing behind', () => {
  const data = crypto.randomBytes(200);
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'corrupt.bin', size: data.length, sha256: sha(Buffer.from('different')) });
  chunksOf(data, s.chunk_size).forEach((c, i) => uploads.putChunk(s.upload_id, i, c));
  const before = uploads.list({ limit: 0 }).length;
  assert.throws(() => uploads.finishChunked(s.upload_id), /checksum/i);
  assert.equal(uploads.list({ limit: 0 }).length, before);
  assert.equal(uploads.chunkStatus(s.upload_id), null, 'a corrupt upload is discarded, not left to retry forever');
});

test('finishChunked accepts a matching sha256', () => {
  const data = crypto.randomBytes(200);
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'verified.bin', size: data.length, sha256: sha(data) });
  chunksOf(data, s.chunk_size).forEach((c, i) => uploads.putChunk(s.upload_id, i, c));
  const rec = uploads.finishChunked(s.upload_id);
  assert.equal(rec.sha256, sha(data));
});

test('putChunk rejects an index that is not a non-negative integer, so no path escapes the staging dir', () => {
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'evil.bin', size: 200 });
  for (const bad of ['../../etc/passwd', '..', -1, 1.5, 'abc', null, undefined, '0x1']) {
    assert.throws(() => uploads.putChunk(s.upload_id, bad, Buffer.from('x')), /index/i, `index ${String(bad)} must be rejected`);
  }
  assert.ok(!fs.existsSync(path.join(TMP, 'etc')), 'nothing was written outside the staging directory');
});

test('putChunk rejects an index past the end of the declared file', () => {
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'oob.bin', size: 200 });   // 4 chunks: 0..3
  assert.throws(() => uploads.putChunk(s.upload_id, 4, Buffer.from('x')), /index/i);
});

test('putChunk rejects an unknown upload id', () => {
  assert.throws(() => uploads.putChunk('nope-000000', 0, Buffer.from('x')), /unknown upload/i);
});

test('an in-flight upload is invisible to list() and recentSummary()', () => {
  const data = crypto.randomBytes(200);
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'inflight-secret.bin', size: data.length });
  uploads.putChunk(s.upload_id, 0, chunksOf(data, s.chunk_size)[0]);
  assert.ok(!uploads.list({ limit: 0 }).some((r) => r.filename === 'inflight-secret.bin'));
  assert.ok(!uploads.recentSummary(50).includes('inflight-secret.bin'), 'a half-written file must never be handed to the agent');
});

test('abortChunked discards the staged chunks', () => {
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'abandoned.bin', size: 200 });
  uploads.putChunk(s.upload_id, 0, Buffer.alloc(64));
  assert.equal(uploads.abortChunked(s.upload_id), true);
  assert.equal(uploads.chunkStatus(s.upload_id), null);
  assert.equal(uploads.abortChunked(s.upload_id), false, 'aborting twice is a no-op, not an error');
});

test('sweepPartials removes stale staging dirs and keeps fresh ones', () => {
  const stale = uploads.beginChunked({ channel: 'assistant-web', filename: 'stale.bin', size: 200 });
  const fresh = uploads.beginChunked({ channel: 'assistant-web', filename: 'fresh.bin', size: 200 });
  // Age the stale one by backdating its staging directory.
  const old = Date.now() - 48 * 3600 * 1000;
  fs.utimesSync(path.join(STAGING, stale.upload_id), old / 1000, old / 1000);

  assert.deepEqual(uploads.sweepPartials(24 * 3600 * 1000), { removed: 1, failed: 0 });
  assert.equal(uploads.chunkStatus(stale.upload_id), null);
  assert.ok(uploads.chunkStatus(fresh.upload_id), 'a fresh upload in progress survives the sweep');
});

test('beginChunked refuses a declared size beyond the configured maximum', () => {
  // Nothing bounded `size`, so two requests and zero bytes could pin the event loop: a 40 TB claim
  // makes 4.77M chunks and finishChunked walks every index looking for what is missing.
  assert.throws(() => uploads.beginChunked({ channel: 'assistant-web', filename: 'lie.bin', size: 40e12 }), /too large|maximum/i);
  assert.throws(() => uploads.beginChunked({ channel: 'assistant-web', filename: 'lie.bin', size: Number.MAX_SAFE_INTEGER }), /too large|maximum/i);
});

test('the missing-chunk error stays short no matter how many chunks are missing', () => {
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'sparse.bin', size: 64 * 5000 });
  uploads.putChunk(s.upload_id, 0, Buffer.alloc(64));
  const err = (() => { try { uploads.finishChunked(s.upload_id); } catch (e) { return e; } })();
  assert.match(err.message, /missing chunk/i);
  assert.ok(err.message.length < 200, `message should summarize, not enumerate 4999 indices (was ${err.message.length} chars)`);
  uploads.abortChunked(s.upload_id);
});

test('a zero-length upload still bounds the chunk index', () => {
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'zero.bin', size: 0 });
  assert.throws(() => uploads.putChunk(s.upload_id, 999999999, Buffer.from('x')), /index/i);
  uploads.abortChunked(s.upload_id);
});

test('failures carry a stable code so callers do not have to match on prose', () => {
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'coded.bin', size: 200 });
  const grab = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  assert.equal(grab(() => uploads.putChunk('abc123-000000', 0, Buffer.from('x'))).code, 'UNKNOWN_UPLOAD');
  assert.equal(grab(() => uploads.putChunk(s.upload_id, 'abc', Buffer.from('x'))).code, 'BAD_INDEX');
  assert.equal(grab(() => uploads.finishChunked(s.upload_id)).code, 'MISSING_CHUNKS');
  uploads.abortChunked(s.upload_id);

  const c = uploads.beginChunked({ channel: 'assistant-web', filename: 'bad.bin', size: 64, sha256: 'deadbeef' });
  uploads.putChunk(c.upload_id, 0, Buffer.alloc(64));
  assert.equal(grab(() => uploads.finishChunked(c.upload_id)).code, 'INTEGRITY');
});

test('an unreadable staging dir is an error, not an upload with zero chunks received', () => {
  // Reporting [] on a readdir failure told the client to re-send chunks that were already on disk.
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'locked.bin', size: 200 });
  const cs = chunksOf(crypto.randomBytes(200), s.chunk_size);
  cs.forEach((c, i) => uploads.putChunk(s.upload_id, i, c));
  const dir = path.join(STAGING, s.upload_id);
  fs.chmodSync(dir, 0o000);
  try {
    assert.throws(() => uploads.chunkStatus(s.upload_id), /staged chunks|permission/i);
  } finally {
    fs.chmodSync(dir, 0o755);
    uploads.abortChunked(s.upload_id);
  }
});

test('a corrupt meta.json is reported as a broken upload, not an unknown one', () => {
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'corruptmeta.bin', size: 200 });
  fs.writeFileSync(path.join(STAGING, s.upload_id, 'meta.json'), '{not json');
  const err = (() => { try { uploads.putChunk(s.upload_id, 0, Buffer.from('x')); } catch (e) { return e; } })();
  assert.equal(err.code, 'BROKEN_UPLOAD', 'a truncated meta.json must not masquerade as "unknown upload"');
  uploads.abortChunked(s.upload_id);
});

test('the assembled file is verified against what actually reached the disk', () => {
  const data = crypto.randomBytes(200);
  const s = uploads.beginChunked({ channel: 'assistant-web', filename: 'ondisk.bin', size: data.length });
  chunksOf(data, s.chunk_size).forEach((c, i) => uploads.putChunk(s.upload_id, i, c));
  const rec = uploads.finishChunked(s.upload_id);
  assert.equal(fs.statSync(rec.path).size, data.length, 'the registered size must match the bytes on disk');
});

test('saveFrom registers a file already on disk without ever holding it as a Buffer', () => {
  const src = path.join(os.tmpdir(), `asmltr-savefrom-${process.pid}.bin`);
  const data = crypto.randomBytes(500);
  fs.writeFileSync(src, data);

  const rec = uploads.saveFrom({ channel: 'telegram', tempPath: src, filename: 'moved.bin', mime: 'application/pdf', kind: 'document' });

  assert.equal(rec.size, 500);
  assert.equal(rec.mime, 'application/pdf');
  assert.deepEqual(fs.readFileSync(rec.path), data);
  assert.ok(!fs.existsSync(src), 'the source is moved, not copied');
  assert.ok(uploads.list({ limit: 0 }).some((r) => r.id === rec.id));
});

test('staging never sits inside the upload area', () => {
  // Regression guard for the reason staging moved: baseDir() resolves to the Self silo, which
  // scripts/backup.js copies wholesale, so a partial staged under it rides into every snapshot taken
  // before the 24h sweep — and shows up in the Silos GUI as a half-written blob. Checked against the
  // DEFAULT staging path, not the one this file overrides, since the default is what installs use.
  const saved = process.env.ASMLTR_UPLOAD_STAGING_DIR;
  delete process.env.ASMLTR_UPLOAD_STAGING_DIR;
  try {
    const base = uploads.baseDir();
    const staging = uploads.stagingDir();
    assert.notEqual(staging, base);
    assert.equal(staging.startsWith(base + path.sep), false, `staging ${staging} must not live under ${base}`);
  } finally {
    process.env.ASMLTR_UPLOAD_STAGING_DIR = saved;
  }
});
