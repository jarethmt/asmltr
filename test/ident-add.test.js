'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identAddDecision } = require('../core/src/trust/ident-add');

test('add-steal fails when the id belongs to someone else', () => {
  const d = identAddDecision({ existingPrincipalId: 'alice', targetPrincipalId: 'bob' });
  assert.equal(d.ok, false);
  assert.equal(d.status, 409);
});

test('same-principal add is ok', () => {
  const d = identAddDecision({ existingPrincipalId: 'alice', targetPrincipalId: 'alice' });
  assert.equal(d.ok, true);
  assert.equal(d.same, true);
});

test('new identifier is ok', () => {
  const d = identAddDecision({ existingPrincipalId: null, targetPrincipalId: 'alice' });
  assert.equal(d.ok, true);
  assert.equal(d.same, false);
});
