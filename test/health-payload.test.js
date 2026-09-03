'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const { healthPayload } = require('../core/src/health-payload');

test('health JSON has no SQL strings', () => {
  const p = healthPayload({ active: 2 });
  const raw = JSON.stringify(p);
  assert.equal(/SELECT|INSERT|UPDATE|DELETE|CREATE|FROM /i.test(raw), false);
  assert.equal('sqlite_keep' in p, false);
  assert.equal(p.status, 'ok');
  assert.equal(p.service, 'asmltr-core');
  assert.equal(p.active, 2);
});

test('server.js does not reference sqlite keep', () => {
  const src = readFileSync(path.join(__dirname, '../core/src/server.js'), 'utf8');
  assert.equal(src.includes('_sqliteKeep'), false);
  assert.equal(src.includes('sqlite-stmt-keep'), false);
  assert.ok(src.includes("require('./health-payload')"));
});
