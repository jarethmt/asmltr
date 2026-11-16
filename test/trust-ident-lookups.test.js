'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identifierLookups, normalizeIdentValue } = require('../core/src/trust/ident-lookups');

// The display name is attacker-controlled on these surfaces, so it must never be
// offered as an identifier candidate.
test('email, discord and telegram never match on raw_username', () => {
  for (const surface of ['email', 'discord', 'telegram']) {
    const pairs = identifierLookups(surface, { raw_id: 'real-id', raw_username: 'jareth@thoughtspacedesigns.com' });
    assert.deepEqual(pairs.map(([, v]) => v), ['real-id'],
      `${surface} must offer only raw_id`);
  }
});

test('other surfaces still match on raw_username', () => {
  const pairs = identifierLookups('mcp', { raw_id: 'id1', raw_username: 'jareth' });
  assert.deepEqual(pairs, [['mcp', 'id1'], ['mcp', 'jareth']]);
});

test('email identifiers are lowercased so case cannot dodge or mis-hit', () => {
  assert.equal(normalizeIdentValue('email', '  JARETH@ThoughtSpaceDesigns.com '), 'jareth@thoughtspacedesigns.com');
  assert.equal(normalizeIdentValue('discord', 'CaseKept'), 'CaseKept');
});

test('api_key is still offered, empty values dropped', () => {
  assert.deepEqual(identifierLookups('email', { raw_id: 'a@b.c', api_key: 'k' }), [['email', 'a@b.c'], ['apikey', 'k']]);
  assert.deepEqual(identifierLookups('email', { raw_id: '', raw_username: '', api_key: '' }), []);
});
