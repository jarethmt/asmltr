'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../shared/redact');

test('redacts GH_TOKEN, ghs_, xai, JWT, Bearer, discord-bot shapes', () => {
  const src = [
    'GH_TOKEN=ghs_abcdefghijklmnopqrstuv',
    'xai-abcdefghijklmnopqrstuvwx',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturexxab',
    'Authorization: Bearer abcdefghijklmnopqr',
    'MzI1NDc2ODkwMTIzNDU2Nzg.Gh7xYz.abcdefghijklmnopqrstuvwxyz012345',
  ].join('\n');
  const { text, count } = redactSecrets(src);
  assert.ok(count >= 5, 'count=' + count + ' text=' + text);
  assert.equal(/ghs_[a-z]{10,}/.test(text), false);
  assert.equal(/xai-[a-z]{10,}/.test(text), false);
  assert.equal(/Bearer [A-Za-z]{10,}/.test(text), false);
  assert.equal(/eyJ[A-Za-z0-9]+\./.test(text), false);
  assert.equal(/MzI1NDc2ODkw/.test(text), false);
});
