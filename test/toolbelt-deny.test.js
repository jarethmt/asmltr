'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'toolbelt-server.js'), 'utf8');

test('toolbelt lists silo wrappers and honor ASMLTR_DENY_TOOLS', () => {
  assert.match(src, /asmltr_silo_overview/);
  assert.match(src, /asmltr_silo_ls/);
  assert.match(src, /asmltr_silo_find/);
  assert.match(src, /asmltr_silo_get/);
  assert.match(src, /asmltr_post/);
  assert.match(src, /asmltr_send/);
  assert.equal(src.includes('asmltr_guild_post'), false);
  assert.match(src, /asmltr_uploads/);
  assert.match(src, /deny: 'uploads'/);
  assert.match(src, /parseDenyEnv/);
  assert.match(src, /denied: /);
});
