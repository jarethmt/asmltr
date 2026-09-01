'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitResponse, isFenceLine } = require('../shared/discord-split');

function fenceBalance(chunk) {
  return chunk.split('\n').filter(isFenceLine).length;
}

test('small fence stays one chunk with backticks', () => {
  const t = 'here\n```\nfoo\n```\nok';
  const c = splitResponse(t, 1900);
  assert.deepEqual(c, [t]);
  assert.match(c[0], /```\nfoo\n```/);
});

test('language tag kept; sudoers one-liner copyable', () => {
  const line = 'adjutant ALL=(root) NOPASSWD: /usr/sbin/nginx -t';
  const t = '```\n' + line + '\n```';
  const c = splitResponse(t, 1900);
  assert.equal(c.length, 1);
  assert.equal(c[0], t);
});

test('long fence reopens so no chunk has an unclosed opener', () => {
  const body = Array.from({ length: 40 }, (_, i) => ('line' + i + 'x').repeat(8)).join('\n');
  const t = '```js\n' + body + '\n```';
  const c = splitResponse(t, 220);
  assert.ok(c.length > 1);
  for (const ch of c) {
    assert.match(ch, /^```js(?:\n|$)/);
    assert.match(ch, /\n```$/);
    assert.equal(fenceBalance(ch) % 2, 0);
    assert.ok(ch.length <= 220);
  }
});

test('plain text still packs under max without inventing fences', () => {
  const t = 'hello\n\nworld';
  const c = splitResponse(t, 1900);
  assert.deepEqual(c, [t]);
  const long = ('para\n\n').repeat(80);
  const c2 = splitResponse(long, 100);
  assert.ok(c2.length > 1);
  for (const ch of c2) {
    assert.ok(ch.length <= 100);
    assert.equal(ch.includes('```'), false);
  }
});

test('unclosed fence is closed on the last chunk', () => {
  const t = '```\nnot closed';
  const c = splitResponse(t, 1900);
  assert.equal(c.length, 1);
  assert.match(c[0], /\n```$/);
});
