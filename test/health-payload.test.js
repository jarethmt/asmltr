'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const { healthPayload } = require('../core/src/health-payload');

test('health JSON has no SQL strings', () => {
  const p = healthPayload({ active: 2, sqliteKeepSize: 4 });
  const raw = JSON.stringify(p);
  assert.equal(/SELECT|INSERT|UPDATE|DELETE|CREATE|FROM /i.test(raw), false);
  assert.equal('sql' in p.sqlite_keep, false);
  assert.deepEqual(p.sqlite_keep, { size: 4 });
  assert.equal(p.status, 'ok');
});

test('server.js does not dump keep.keys() SQL', () => {
  const src = readFileSync(path.join(__dirname, '../core/src/server.js'), 'utf8');
  assert.equal(src.includes('_sqliteKeep.keep.keys()'), false);
  assert.ok(src.includes("require('./health-payload')"));
});
