'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bearerEqual } = require('../shared/bearer-equal');

test('matching Bearer is accepted', () => {
  assert.equal(bearerEqual('Bearer test-token-aaaa', 'test-token-aaaa'), true);
});

test('mismatch is rejected', () => {
  assert.equal(bearerEqual('Bearer test-token-aaab', 'test-token-aaaa'), false);
  assert.equal(bearerEqual('Bearer test-token-aaa', 'test-token-aaaa'), false);
});

test('unset token fails closed', () => {
  assert.equal(bearerEqual('Bearer test-token-aaaa', ''), false);
  assert.equal(bearerEqual('Bearer test-token-aaaa', undefined), false);
});

test('missing header fails closed', () => {
  assert.equal(bearerEqual('', 'test-token-aaaa'), false);
  assert.equal(bearerEqual(null, 'test-token-aaaa'), false);
});
