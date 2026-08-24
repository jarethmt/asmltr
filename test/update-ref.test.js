'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { updateResetArgv, resolveEdgeTarget, fetchOriginArgv } = require('../shared/update-ref');

test('discord/updater git argv pins current branch, never hardcoded main', () => {
  assert.deepEqual(updateResetArgv('ivy'), ['reset', '--hard', 'origin/ivy']);
  assert.deepEqual(fetchOriginArgv('ivy'), ['fetch', '--quiet', '--tags', '--force', 'origin', 'ivy']);
  assert.notDeepEqual(updateResetArgv('ivy'), ['reset', '--hard', 'origin/main']);
});

test('edge target is origin/<branch>, not blindly origin/main', () => {
  assert.deepEqual(resolveEdgeTarget({ branch: 'ivy' }), { target: 'origin/ivy', label: 'origin/ivy' });
  assert.notEqual(resolveEdgeTarget({ branch: 'ivy' }).target, 'origin/main');
  assert.deepEqual(resolveEdgeTarget({ ref: 'abc123', branch: 'ivy' }), { target: 'abc123', label: 'abc123' });
});

test('HEAD and junk branches refuse reset', () => {
  assert.throws(() => updateResetArgv('HEAD'));
  assert.throws(() => updateResetArgv('../main'));
  assert.throws(() => updateResetArgv(''));
});
