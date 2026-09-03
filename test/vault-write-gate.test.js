'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isVaultWrite, vaultWriteAllowed } = require('../core/src/vault/write-gate');

test('unauth vault write is 401 when auth is on', () => {
  const d = vaultWriteAllowed({ authEnabled: true, session: null });
  assert.equal(d.ok, false);
  assert.equal(d.status, 401);
});

test('session may unseal and CRUD secrets', () => {
  assert.equal(vaultWriteAllowed({ authEnabled: true, session: { sub: 'op' } }).ok, true);
});

test('auth off is break-glass', () => {
  const d = vaultWriteAllowed({ authEnabled: false, session: null });
  assert.equal(d.ok, true);
  assert.equal(d.breakGlass, true);
});

test('vault mutating paths are gated; status is not', () => {
  assert.equal(isVaultWrite('POST', '/v2/vault/unseal'), true);
  assert.equal(isVaultWrite('GET', '/v2/vault/secrets'), true);
  assert.equal(isVaultWrite('POST', '/v2/vault/secrets'), true);
  assert.equal(isVaultWrite('DELETE', '/v2/vault/secrets/smtp'), true);
  assert.equal(isVaultWrite('GET', '/v2/vault/status'), false);
  assert.equal(isVaultWrite('POST', '/trust/principals'), false);
});
