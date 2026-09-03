'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-ident-'));
const ident = path.join(tmp, 'identity.md');
fs.writeFileSync(ident, 'Fixture self-description for tests.\n');
process.env.ASMLTR_IDENTITY_FILE = ident;
process.env.ASSISTANT_NAME = 'FixtureBot';

const identity = require('../shared/identity');

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  delete process.env.ASMLTR_IDENTITY_FILE;
  delete process.env.ASSISTANT_NAME;
});

test('identityPreamble inlines fixture identity and forbids filesystem hunt', () => {
  const p = identity.identityPreamble();
  assert.match(p, /Fixture self-description for tests/);
  assert.match(p, /They are loaded/);
  assert.match(p, /Do not Read, cat, glob, or search the repo, Self silo, or home/);
  assert.match(p, /Answer from this block/);
  assert.equal(/osiris|discord|\.gtwy\.net/i.test(p), false);
});
