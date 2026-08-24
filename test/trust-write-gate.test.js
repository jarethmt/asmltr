'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTrustWrite, trustWriteAllowed } = require('../core/src/trust/write-gate');

test('write without session is 401', () => {
  const d = trustWriteAllowed({ authEnabled: true, session: null });
  assert.equal(d.ok, false);
  assert.equal(d.status, 401);
});

test('write with session is allowed', () => {
  assert.equal(trustWriteAllowed({ authEnabled: true, session: { sub: 'op' } }).ok, true);
});

test('resolve and GETs are not write-gated', () => {
  assert.equal(isTrustWrite('POST', '/trust/resolve'), false);
  assert.equal(isTrustWrite('GET', '/trust/principals'), false);
  assert.equal(isTrustWrite('GET', '/trust/principals/x'), false);
  assert.equal(isTrustWrite('POST', '/v2/handle'), false);
});

test('trust writes are gated', () => {
  assert.equal(isTrustWrite('POST', '/trust/principals'), true);
  assert.equal(isTrustWrite('PATCH', '/trust/principals/x'), true);
  assert.equal(isTrustWrite('DELETE', '/trust/principals/x'), true);
  assert.equal(isTrustWrite('POST', '/trust/principals/x/identifiers'), true);
  assert.equal(isTrustWrite('POST', '/trust/principals/x/merge'), true);
  assert.equal(isTrustWrite('POST', '/trust/roles'), true);
  assert.equal(isTrustWrite('POST', '/trust/profiles/x'), true);
  assert.equal(isTrustWrite('POST', '/trust/relationships'), true);
  assert.equal(isTrustWrite('POST', '/trust/engagement'), true);
});
