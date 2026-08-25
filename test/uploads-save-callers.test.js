'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// This branch refactored save() internals (place() + register() are now shared with saveFrom() and
// finishChunked()) while promising its CONTRACT was untouched. The callers live in connectors and the
// core, none of which this branch edits, so nothing else in the suite would catch a field quietly
// dropped from the record. Each case below is the exact argument shape of a real call site.
const TMP = path.join(os.tmpdir(), `asmltr-savecallers-test-${process.pid}`);
process.env.ASMLTR_UPLOADS_DIR = TMP;
const uploads = require('../shared/uploads');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const CALLERS = [
  {
    where: 'connectors/types/telegram/index.js',
    args: {
      channel: 'telegram', instance: 'tg1', buffer: Buffer.from('telegram bytes'),
      filename: 'photo.jpg', mime: 'image/jpeg', kind: 'image', caption: 'a caption',
      sender: 'gianni', senderId: 12345,
      conversationKey: 'telegram:tg1:user:12345',
    },
  },
  {
    where: 'connectors/types/discord/index.js',
    args: {
      channel: 'discord', instance: 'dc1', buffer: Buffer.from('discord bytes'),
      filename: 'clip.mp4', mime: 'video/mp4', kind: 'file', caption: 'msg content',
      sender: 'scoutg001', senderId: '99887766',
      conversationKey: 'discord:dc1:channel:1',
    },
  },
  {
    where: 'connectors/types/email/index.js',
    args: {
      channel: 'email', instance: 'em1', buffer: Buffer.from('email attachment'),
      filename: 'invoice.pdf', mime: 'application/pdf', kind: 'document', caption: 'Subject line',
      sender: 'someone@example.com',
      conversationKey: 'email:em1:read',
    },
  },
  {
    where: 'core/src/server.js POST /v2/upload',
    args: {
      channel: 'assistant-web', buffer: Buffer.from('one-shot body'),
      filename: 'note.txt', mime: 'text/plain', kind: 'document',
      sender: 'dashboard', senderId: 'dashboard', conversationKey: null,
    },
  },
];

for (const c of CALLERS) {
  test(`save() still honors the call shape in ${c.where}`, () => {
    const rec = uploads.save(c.args);
    const a = c.args;

    assert.equal(rec.channel, a.channel);
    assert.equal(rec.instance, a.instance || null);
    assert.equal(rec.filename, a.filename);
    assert.equal(rec.mime, a.mime);
    assert.equal(rec.kind, a.kind);
    assert.equal(rec.caption, a.caption || null);
    assert.equal(rec.sender, a.sender || null);
    assert.equal(rec.sender_id, a.senderId != null ? String(a.senderId) : null, 'senderId is stringified, numeric or not');
    assert.equal(rec.conversation_key, a.conversationKey || null);
    assert.equal(rec.size, a.buffer.length);
    assert.ok(rec.id && rec.ts && rec.iso, 'identity fields the callers log');

    // The bytes are on disk where the record says, and the caller's log line can be built from it.
    assert.equal(fs.readFileSync(rec.path, 'utf8'), a.buffer.toString());
    assert.ok(rec.path.startsWith(uploads.baseDir() + path.sep), 'a file lands in the upload area');
    assert.match(uploads.humanSize(rec.size), /\d/);

    // And it is findable afterwards, which is the reason connectors call save() at all.
    assert.ok(uploads.get(rec.id), 'the record reached the manifest');
  });
}

test('save() still rejects what it always rejected', () => {
  assert.throws(() => uploads.save({ buffer: Buffer.from('x') }), /channel required/);
  assert.throws(() => uploads.save({ channel: 'telegram' }), /buffer required/);
  assert.throws(() => uploads.save({ channel: 'telegram', buffer: 'not a buffer' }), /buffer required/);
});
