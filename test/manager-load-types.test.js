'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('manager skips hook-only types/ dirs (no index.js) instead of logging failed to load', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/manager/server.js'), 'utf8');
  assert.match(src, /index\.js/);
  assert.match(src, /Hook-only dirs/);
  assert.match(src, /skip silent/);
  const dir = path.join(__dirname, '../connectors/types/claude-code');
  assert.equal(fs.existsSync(path.join(dir, 'index.js')), false);
  assert.equal(fs.existsSync(path.join(dir, 'hook.py')), true);
});
