'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { canAbortTurn, starterIdFromSlot } = require('../connectors/types/discord/abort-allow');

test('public: anyone can abort a processing turn (humans always win)', () => {
  assert.equal(canAbortTurn({ isOwner: true, authorId: 'owner', starterId: 'friend' }), true);
  assert.equal(canAbortTurn({ isOwner: false, authorId: '111', starterId: '111' }), true);
  assert.equal(canAbortTurn({ isOwner: false, authorId: '333', starterId: '111' }), true);
  assert.equal(canAbortTurn({ isOwner: false, authorId: 'steerer', starterId: '111' }), true);
  assert.equal(canAbortTurn({ isOwner: false, authorId: '111', starterId: null }), true);
});

test('starterIdFromSlot still reads the processing slot', () => {
  assert.equal(starterIdFromSlot(true), null);
  assert.equal(starterIdFromSlot({ starterId: '111' }), '111');
});

test('discord stop is not in OWNER_ONLY_CMDS; processing stores starterId; no overlay require', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /abortAllow\.canAbortTurn/);
  assert.match(src, /starterId:/);
  assert.match(src, /humans always win/);
  const abortSrc = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/abort-allow.js'), 'utf8');
  assert.equal(abortSrc.includes('load-host-overlay'), false);
  assert.equal(abortSrc.includes('wrapAbortAllow'), false);
  const block = src.match(/const OWNER_ONLY_CMDS = new Set\((\[[\s\S]*?\])\)/);
  assert.ok(block);
  assert.equal(/['"]stop['"]/.test(block[1]), false);
});

test('send voice stream inject register abortTarget; stop passes identities; not owner-only', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /function abortTarget\(/);
  const sendSlice = src.slice(src.indexOf("app.post('/out'"), src.indexOf("app.post('/out'") + 3500);
  assert.match(sendSlice, /abortTarget\(/);
  assert.match(src, /attach-stage/);
  const voiceSlice = src.slice(src.indexOf('voiceBusy.add(guildId)'), src.indexOf('voiceBusy.add(guildId)') + 400);
  assert.match(voiceSlice, /abortTarget\(/);
  assert.match(src, /abortTarget\(cid, message\.author\.id, 'stream'\)/);
  assert.match(src, /abortTarget\(cid, message\.author\.id, 'inject'\)/);
  assert.match(src, /speakerId: String\(message\.author\.id\)/);
  assert.match(src, /starterId: starterId/);
  const block = src.match(/const OWNER_ONLY_CMDS = new Set\((\[[\s\S]*?\])\)/);
  assert.ok(block);
  assert.equal(/['"]stop['"]/.test(block[1]), false);
});
