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

test('email extra ends with letter-only; no Dear/name body cut', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/email/index.js'), 'utf8');
  assert.match(src, /Write the letter only/);
  assert.match(src, /first line of the mailed body is the greeting/);
  const extraAdds = [...src.matchAll(/extra \+=/g)];
  assert.ok(extraAdds.length >= 1);
  const lastAdd = src.lastIndexOf("extra += ' Write the letter only");
  const handle = src.lastIndexOf('ctx.core.handle');
  assert.ok(lastAdd > 0 && lastAdd < handle, 'letter-only instruction is last in extra');
});
