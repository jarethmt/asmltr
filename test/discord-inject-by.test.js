'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { injectBy } = require('../connectors/types/discord/inject-by');

test('owner/bypass uses operator; anyone else uses discord:<author.id>', () => {
  assert.equal(injectBy(true, '111'), 'operator');
  assert.equal(injectBy(false, '222'), 'discord:222');
  assert.equal(injectBy(false, 333), 'discord:333');
});

test('Discord mid-turn inject picks by via injectBy, not a hardcoded operator', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /injectBy/);
  assert.equal(src.includes("inject(convKeyFor(message), guidance, { by: 'operator'"), false);
});
