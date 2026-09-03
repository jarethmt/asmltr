'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('voice handleStream does not fall back raw_id to display name', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.equal(/raw_id: meta\.userId \? String\(meta\.userId\) : name/.test(src), false);
  assert.match(src, /missing Discord userId/);
  assert.match(src, /raw_id: speakerId/);
});
