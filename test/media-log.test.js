'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-medialog-'));
process.env.ASMLTR_SILOS_ROOT = tmp;

const log = require('../shared/media-log');

test('ensureDir creates memory/media-out on first run', () => {
  const dir = log.ensureDir();
  assert.ok(fs.existsSync(dir));
  assert.equal(fs.statSync(dir).isDirectory(), true);
  assert.match(dir, /media-out/);
});

test('appendPosted is text-only and recall is this-conversation', () => {
  const key = 'discord:inst:channel:1';
  log.appendPosted({
    conversationKey: key, channel: 'discord', target: '99',
    name: 'corgi.png', caption: 'the dogs', kind: 'png', bytes: 12,
    messageId: 'm1', ts: 1_700_000_000_000,
  });
  const rec = log.recall(key);
  assert.match(rec, /MEDIA YOU POSTED/);
  assert.match(rec, /corgi\.png/);
  assert.match(rec, /the dogs/);
  assert.equal(rec.includes(tmp), false);
  assert.equal(log.recall('discord:other'), '');
});

test('appendPosted does not keep binary or source paths', () => {
  const key = 'discord:inst:channel:2';
  log.appendPosted({
    conversationKey: key, channel: 'discord', target: '1',
    name: 'clip.mp4', caption: 'night', bytes: 99, ts: 1,
  });
  const body = fs.readFileSync(log.convPath(key), 'utf8');
  assert.equal(body.includes('\0'), false);
  assert.equal(/\/home\//.test(body), false);
});
