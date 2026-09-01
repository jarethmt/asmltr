'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOutPayload, quoteFromThread } = require('../connectors/types/email');

const TC = {
  subject: 'Re: Fwd: Fw: Acme — server battery backup check',
  messageId: '<sidebar@example.com>',
  references: ['<root@example.com>', '<sidebar@example.com>'],
  from: ['owner@example.com'],
  to: ['assistant@example.com', 'customer@example.com'],
  cc: [],
  quoteFromName: 'Owner Example',
  quoteFromAddr: 'owner@example.com',
  quoteDate: '2026-08-31T14:41:00.000Z',
  quoteText: 'same OEM cartridge as the other office\nDo not buy the other model pack.',
};

const BASE = {
  target: 'customer@example.com',
  text: 'Both packs should be replaced.',
  subject: 'Acme — replacement batteries',
  cc: 'owner@example.com',
  tc: TC,
  selfAddr: 'assistant@example.com',
  fromName: 'Assistant Example',
};

test('default reply-all quotes this thread and keeps the chain', () => {
  const p = buildOutPayload(BASE);
  assert.equal(p.quote && p.quote.text.includes('other office'), true);
  assert.equal(p.inReplyTo, '<sidebar@example.com>');
  assert.deepEqual(p.references, TC.references);
  assert.match(p.to, /customer@example.com/);
  assert.match(p.to, /owner@example.com/);
});

test('--no-reply-all drops extra recipients but still quotes', () => {
  const p = buildOutPayload({ ...BASE, reply_all: false });
  assert.equal(p.to, 'customer@example.com');
  assert.equal(p.cc, 'owner@example.com');
  assert.equal(p.quote && p.quote.text.includes('other model'), true);
  assert.equal(p.inReplyTo, '<sidebar@example.com>');
});

test('--new-thread drops quote, In-Reply-To, References, and reply-all merge', () => {
  const p = buildOutPayload({ ...BASE, new_thread: true });
  assert.equal(p.quote, null);
  assert.equal(p.inReplyTo, undefined);
  assert.equal(p.references, undefined);
  assert.equal(p.to, 'customer@example.com');
  assert.equal(p.cc, 'owner@example.com');
  assert.doesNotMatch(String(p.to) + ' ' + String(p.cc || ''), /assistant@example.com/);
  assert.equal(p.subject, 'Acme — replacement batteries');
});

test('--new-thread still works when a stale ref/thread is present', () => {
  const p = buildOutPayload({ ...BASE, new_thread: 'true', inReplyTo: '<force@example.com>' });
  assert.equal(p.quote, null);
  assert.equal(p.inReplyTo, undefined);
  assert.equal(quoteFromThread(TC).text.includes('other office'), true);
});
