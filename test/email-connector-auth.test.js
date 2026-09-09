'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('email /out and /read require connector token', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/email/index.js'), 'utf8');
  assert.match(src, /app\.post\('\/out',\s*requireConnectorToken/);
  assert.match(src, /app\.post\('\/read',\s*requireConnectorToken/);
});
