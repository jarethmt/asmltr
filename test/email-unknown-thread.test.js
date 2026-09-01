'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  headerHasThread,
  selfIsRecipient,
  senderOnPriorThread,
  shouldOwnerForwardUnknown,
  emailsFromContactsDoc,
  persistThreads,
  readThreads,
} = require('../connectors/types/email');

const assistant = 'assistant@example.com';
const angela = 'angela@example.com';

function parsed({ from, to, cc, inReplyTo, references }) {
  const field = (addrs) => ({ value: (addrs || []).map((address) => ({ address })) });
  return {
    from: field(from),
    to: field(to),
    cc: field(cc),
    inReplyTo: inReplyTo || null,
    references: references || [],
  };
}

test('headerHasThread is true for In-Reply-To or References', () => {
  assert.equal(headerHasThread(parsed({})), false);
  assert.equal(headerHasThread(parsed({ inReplyTo: '<mid>' })), true);
  assert.equal(headerHasThread(parsed({ references: ['<mid>'] })), true);
  assert.equal(headerHasThread(parsed({ references: '  <mid>  ' })), true);
});

test('selfIsRecipient is To or Cc', () => {
  assert.equal(selfIsRecipient(parsed({ to: [assistant] }), assistant), true);
  assert.equal(selfIsRecipient(parsed({ to: ['owner@example.com'], cc: [assistant] }), assistant), true);
  assert.equal(selfIsRecipient(parsed({ to: ['owner@example.com'] }), assistant), false);
});

test('senderOnPriorThread matches from/to/cc of the stored thread', () => {
  const prior = { from: [angela], to: [assistant, 'owner@example.com'], cc: [] };
  assert.equal(senderOnPriorThread(prior, angela), true);
  assert.equal(senderOnPriorThread(prior, assistant), true);
  assert.equal(senderOnPriorThread(prior, 'stranger@example.com'), false);
  assert.equal(senderOnPriorThread(null, angela), false);
});

test('cold unknown still owner-forwards', () => {
  const p = parsed({ from: ['stranger@example.com'], to: [assistant] });
  assert.equal(shouldOwnerForwardUnknown({
    known: false, parsed: p, selfAddr: assistant, fromAddr: 'stranger@example.com',
  }), true);
});

test('Access-card known does not owner-forward', () => {
  const p = parsed({ from: [angela], to: [assistant] });
  assert.equal(shouldOwnerForwardUnknown({
    known: true, parsed: p, selfAddr: assistant, fromAddr: angela,
  }), false);
});

test('Rolodex/contacts hit does not owner-forward', () => {
  const p = parsed({ from: [angela], to: [assistant] });
  assert.equal(shouldOwnerForwardUnknown({
    known: false, contactsKnown: true, parsed: p, selfAddr: assistant, fromAddr: angela,
  }), false);
});

test('reply on a chain we are on does not owner-forward (Casey case)', () => {
  const p = parsed({
    from: [angela],
    to: [assistant, 'owner@example.com'],
    inReplyTo: '<assistant-earlier-mid>',
  });
  assert.equal(shouldOwnerForwardUnknown({
    known: false, parsed: p, selfAddr: assistant, fromAddr: angela,
  }), false);
});

test('prior thread participant does not owner-forward even without In-Reply-To', () => {
  const p = parsed({ from: [angela], to: [assistant] });
  assert.equal(shouldOwnerForwardUnknown({
    known: false, parsed: p, selfAddr: assistant, fromAddr: angela,
    priorThread: { from: ['owner@example.com'], to: [assistant, angela], cc: [] },
  }), false);
});

test('emailsFromContactsDoc collects otherContacts too', () => {
  const set = emailsFromContactsDoc({
    results: [
      { emails: ['angela.other@example.com'] },
      { emails: ['angela@example.com'], source: 'other' },
    ],
  });
  assert.equal(set.has('angela@example.com'), true);
  assert.equal(set.has('angela.other@example.com'), true);
});

test('persistThreads round-trips participants', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-threads-'));
  const prev = process.env.ASMLTR_EMAIL_THREADS_FILE;
  process.env.ASMLTR_EMAIL_THREADS_FILE = path.join(dir, 'threads.json');
  try {
    const map = new Map([['email:x:thread:abc', { from: [angela], to: [assistant], cc: [] }]]);
    persistThreads('x', map);
    const loaded = readThreads('x');
    assert.deepEqual(loaded.get('email:x:thread:abc').from, [angela]);
  } finally {
    if (prev == null) delete process.env.ASMLTR_EMAIL_THREADS_FILE;
    else process.env.ASMLTR_EMAIL_THREADS_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
