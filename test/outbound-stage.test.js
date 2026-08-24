'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-stage-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-outside-'));
process.env.ASMLTR_ATTACH_STAGE = tmp;
const stage = require('../shared/outbound-stage');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('payload'),
]);

function touchSrc(name, body) {
  const p = path.join(tmp, 'src-' + name);
  fs.writeFileSync(p, body || PNG);
  return p;
}

test('sanitizeFilename: lowercase, no spaces, one period', () => {
  assert.equal(stage.sanitizeFilename('My Photo.PNG'), 'my-photo.png');
  assert.equal(stage.sanitizeFilename('a b  c.JPG'), 'a-b-c.jpg');
  assert.equal(stage.sanitizeFilename('foo.bar.baz.png'), 'foo-bar-baz.png');
  assert.equal(stage.sanitizeFilename('OK_File-1.WebP'), 'ok_file-1.webp');
  assert.equal(stage.sanitizeFilename('***'), 'file.bin');
});

test('uniqueName does not overwrite an existing staged file', () => {
  const a = stage.stageFile(touchSrc('a.png'), { name: 'shot.png' });
  const b = stage.stageFile(touchSrc('b.png', Buffer.concat([PNG, Buffer.from('b')])), { name: 'shot.png' });
  assert.equal(a.name, 'shot.png');
  assert.equal(b.name, 'shot-2.png');
  assert.notEqual(a.path, b.path);
  assert.notEqual(fs.readFileSync(a.path).length, fs.readFileSync(b.path).length);
});

test('will not delete until posted; deletes after markPosted', () => {
  const rec = stage.stageFile(touchSrc('keep.png'), { name: 'keep.png' });
  const blocked = stage.removePostedFile(rec.name);
  assert.equal(blocked.ok, false);
  assert.ok(fs.existsSync(rec.path));
  stage.markPosted(rec.name, { messageId: 'm1' });
  const gone = stage.removePostedFile(rec.name);
  assert.equal(gone.ok, true);
  assert.equal(fs.existsSync(rec.path), false);
});

test('listUnposted skips posted rows; retry candidate stays until post', () => {
  const rec = stage.stageFile(touchSrc('wait.png'), { name: 'wait.png' });
  assert.ok(stage.listUnposted().some((r) => r.name === 'wait.png'));
  stage.markPosted('wait.png', { messageId: 'm2' });
  assert.equal(stage.listUnposted().some((r) => r.name === 'wait.png'), false);
  assert.ok(fs.existsSync(rec.path), 'bytes remain until removePostedFile');
});

test('gc creates attach-stage and empty index on first run', () => {
  const d = path.join(os.tmpdir(), 'asmltr-stage-first-' + process.pid);
  const prev = process.env.ASMLTR_ATTACH_STAGE;
  process.env.ASMLTR_ATTACH_STAGE = d;
  try {
    fs.rmSync(d, { recursive: true, force: true });
    assert.equal(fs.existsSync(d), false);
    const r = stage.gc();
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(d));
    const idx = JSON.parse(fs.readFileSync(path.join(d, 'index.json'), 'utf8'));
    assert.deepEqual(idx.items, {});
  } finally {
    process.env.ASMLTR_ATTACH_STAGE = prev;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('gc removes files older than a day and leaves fresh ones', () => {
  const rec = stage.stageFile(touchSrc('old.png'), { name: 'old.png' });
  const idxPath = path.join(tmp, 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  idx.items['old.png'].created_at = Date.now() - (25 * 60 * 60 * 1000);
  fs.writeFileSync(idxPath, JSON.stringify(idx));
  const fresh = stage.stageFile(touchSrc('new.png'), { name: 'new.png' });
  const r = stage.gc(24 * 60 * 60 * 1000);
  assert.ok(r.removed.includes('old.png'));
  assert.equal(fs.existsSync(rec.path), false);
  assert.ok(fs.existsSync(fresh.path));
});

test('refuses to ingest a non-media file from outside the stage dir', () => {
  const secret = path.join(outside, 'notes.md');
  fs.writeFileSync(secret, 'silo dump');
  assert.equal(stage.ingestAllowed(secret), false);
  assert.throws(() => stage.stageFile(secret, { name: 'notes.md' }), /refused/);
});

test('refuses a png that lives in a denied tree (silo-shaped path)', () => {
  const silo = path.join(outside, 'silos', 'self', 'memory');
  fs.mkdirSync(silo, { recursive: true });
  const fake = path.join(silo, 'leak.png');
  fs.writeFileSync(fake, PNG);
  // homedir denylist uses ~/.asmltr/silos — this path is only denied if under that.
  // A random png outside ingest roots must still fail.
  assert.equal(stage.ingestAllowed(fake), false);
});

test('ingests a real png from a generator images/ dir', () => {
  const gen = path.join(outside, 'images');
  fs.mkdirSync(gen, { recursive: true });
  const pic = path.join(gen, '1.png');
  fs.writeFileSync(pic, PNG);
  process.env.ASMLTR_ATTACH_INGEST_CWD = outside;
  assert.equal(stage.ingestAllowed(pic), true);
  const rec = stage.stageFile(pic, { name: 'gen.png' });
  assert.equal(rec.name, 'gen.png');
  assert.ok(stage.assertStagedPath(rec.path));
  delete process.env.ASMLTR_ATTACH_INGEST_CWD;
});

test('outboundFileAllowed is attach-stage / uploads / gen-ref / silo only', () => {
  const rec = stage.stageFile(touchSrc('ok.png'), { name: 'ok.png' });
  assert.equal(stage.outboundFileAllowed(rec.path), true);
  assert.equal(stage.outboundFileAllowed('/etc/passwd'), false);
  assert.equal(stage.outboundFileAllowed(path.join(os.homedir(), '.ssh', 'id_ed25519')), false);
});

test('resolveStagedName rejects path traversal', () => {
  assert.throws(() => stage.resolveStagedName('../shot.png'), /staged name only/);
  assert.throws(() => stage.resolveStagedName(tmp + '/shot.png'), /staged name only/);
});
