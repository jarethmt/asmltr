'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { crossContextForPrompt, crossContextBlock } = require('../connectors/types/discord/prompt-cross');
const { crossChannelIdentityLine } = require('../core/src/trust/cast-identity');

test('timeline search does not appear in guild system_prompt_extra', () => {
  const hits = [{
    serverName: 'other-guild', channelName: 'other-channel',
    author: 'someone', content: 'secret from another room',
  }];
  assert.deepEqual(crossContextForPrompt(hits), []);
  assert.equal(crossContextBlock(crossContextForPrompt(hits)), '');
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const get = src.slice(src.indexOf('function getRelevantContext'), src.indexOf('function shouldRespondTo'));
  assert.equal(get.includes('searchGlobalTimeline'), false);
  assert.match(src, /system_prompt_extra:\s*buildSystemExtra/);
  assert.match(src, /crossContextBlock\(context\.crossContext\)/);
});

const ids = [
  { surface: 'discord', value: '111' },
  { surface: 'email', value: 'user@example.test' },
  { surface: 'x', value: 'handle' },
];
const resolved = { display_name: 'Nick', identities: ids };

test('CAST public omits email/X ids and the CROSS-CHANNEL IDENTITY line', () => {
  const line = crossChannelIdentityLine(resolved, { public: true, channel: 'discord' });
  assert.equal(line, '');
  assert.equal(line.includes('email:'), false);
  assert.equal(line.includes('x:'), false);
});

test('CAST DM still includes email/X ids', () => {
  const line = crossChannelIdentityLine(resolved, { public: false, channel: 'discord' });
  assert.match(line, /CROSS-CHANNEL IDENTITY/);
  assert.match(line, /email:user@example\.test/);
  assert.match(line, /x:handle/);
});
