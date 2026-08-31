'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identifierLookups, normalizeIdentValue } = require('../core/src/trust/ident-lookups');

test('email identifiers lowercase on read and write', () => {
  assert.equal(normalizeIdentValue('email', 'Owner@Example.COM'), 'owner@example.com');
  assert.deepEqual(
    identifierLookups('email', { raw_id: 'Owner@Example.COM' }),
    [['email', 'owner@example.com']],
  );
  assert.equal(normalizeIdentValue('discord', 'AbC'), 'AbC');
});
