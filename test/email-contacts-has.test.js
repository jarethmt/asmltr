'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseContactsHasStdout, emailsFromContactsDoc } = require('../connectors/types/email');

test('parseContactsHasStdout known', () => {
  assert.equal(parseContactsHasStdout('{"ok":true,"known":true,"email":"a@example.com"}\n'), true);
});

test('parseContactsHasStdout unknown', () => {
  assert.equal(parseContactsHasStdout('{"ok":true,"known":false}\n'), false);
});

test('parseContactsHasStdout error', () => {
  assert.equal(parseContactsHasStdout('{"ok":false,"error":"boom"}\n'), false);
});

test('emailsFromContactsDoc still parses an export shape', () => {
  const set = emailsFromContactsDoc({ results: [{ emails: ['A@example.com', 'x'] }] });
  assert.equal(set.has('a@example.com'), true);
  assert.equal(set.has('x'), false);
});
