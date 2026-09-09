'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('manager skips hook-only types/ dirs (no index.js) instead of logging failed to load', () => {
  const src = fs.readFileSync(path.join(__dirname, '../shared/plugin-dirs.js'), 'utf8');
  assert.match(src, /loadAllMeta/);
  assert.match(src, /index\.js/);
  assert.match(src, /Hook-only dirs/);
  const mgr = fs.readFileSync(path.join(__dirname, '../connectors/manager/server.js'), 'utf8');
  assert.match(mgr, /plugin-dirs/);
  assert.match(mgr, /loadAllMeta/);
  const dir = path.join(__dirname, '../connectors/types/claude-code');
  assert.equal(fs.existsSync(path.join(dir, 'index.js')), false);
  assert.equal(fs.existsSync(path.join(dir, 'hook.py')), true);
});
