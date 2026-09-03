'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isUnknownIdentity, canAskOracle, lookupClientIdentity, identityForApprove,
} = require('../connectors/types/mcp/client-identity');

test('unknown cannot ask_oracle', () => {
  assert.equal(canAskOracle(null), false);
  assert.equal(canAskOracle({ userId: 'unknown', username: 'unknown' }), false);
  assert.equal(canAskOracle({ userId: '', username: 'x' }), false);
  assert.equal(canAskOracle({ userId: 'mcp-client-abc', username: 'Other' }), true);
});

test('approve maps client_id to itself, not owner or unknown', () => {
  const id = identityForApprove('mcp-client-new', null, 'Cursor');
  assert.deepEqual(id, { userId: 'mcp-client-new', username: 'Cursor' });
  assert.equal(id.userId === 'owner', false);
  assert.equal(isUnknownIdentity(id), false);
});

test('approve leaves an existing mapped identity untouched', () => {
  const existing = { userId: 'adjutant-mapped', username: 'Adjutant' };
  const id = identityForApprove('already-mapped-client', existing, 'ShouldNotWin');
  assert.deepEqual(id, existing);
});

test('lookup does not invent user:unknown', () => {
  const map = new Map([
    ['known', { userId: 'known', username: 'Known' }],
    ['blank', { userId: 'unknown', username: 'unknown' }],
  ]);
  assert.deepEqual(lookupClientIdentity(map, 'known'), { userId: 'known', username: 'Known' });
  assert.equal(lookupClientIdentity(map, 'blank'), null);
  assert.equal(lookupClientIdentity(map, 'missing'), null);
});
