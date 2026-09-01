'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isAutoReply, isAutomatedSender } = require('../connectors/types/email/index.js');

function parsedWith(headers) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
  return { headers: { get(name) { return h[String(name).toLowerCase()]; } } };
}

test('Exchange Automatic reply: subject is OOO', () => {
  assert.equal(isAutoReply(parsedWith({}), 'Automatic reply: OPS-010: Microsoft card declined', ''), true);
});

test('Out of Office subject is OOO', () => {
  assert.equal(isAutoReply(parsedWith({}), 'Out of Office', 'I am away'), true);
  assert.equal(isAutoReply(parsedWith({}), 'OOO: vacation', ''), true);
});

test('RFC 3834 auto-replied is OOO', () => {
  assert.equal(isAutoReply(parsedWith({ 'auto-submitted': 'auto-replied' }), 'Re: OPS-010', ''), true);
});

test('auto-generated is NOT OOO (Microsoft alerts / DSN)', () => {
  assert.equal(
    isAutoReply(
      parsedWith({ 'auto-submitted': 'auto-generated' }),
      'EDGARDC0: Microsoft Entra Connect Sync Service is not running',
      '',
    ),
    false,
  );
});

test('human ticket reply is not OOO', () => {
  assert.equal(
    isAutoReply(parsedWith({}), 'Re: OPS-010: Microsoft card declined', 'We will update the card today.'),
    false,
  );
});

test('X-Autoreply header counts', () => {
  assert.equal(isAutoReply(parsedWith({ 'x-autoreply': 'yes' }), 'Re: hello', ''), true);
});

test('person mailbox is not an automated sender', () => {
  assert.equal(isAutomatedSender('jan@example.test'), false);
  assert.equal(isAutomatedSender('owner@example.com'), false);
});
