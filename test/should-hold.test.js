'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldHold } = require('../core/src/drafts');

test('unknown approval policy holds', () => {
  assert.equal(shouldHold('not-a-real-policy', { bypass_moderation: true }), true);
  assert.equal(shouldHold('always_send', {}), false);
  assert.equal(shouldHold('always_draft', {}), true);
  assert.equal(shouldHold('', {}), false);
  assert.equal(shouldHold(null, {}), false);
});
