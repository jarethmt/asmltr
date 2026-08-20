'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-lastuid-'));
const file = path.join(dir, 'lastuid.json');
process.env.ASMLTR_EMAIL_LASTUID_FILE = file;

const { lastUidFile, readLastUid, persistLastUid } = require('../connectors/types/email');

test('lastUid persist + read, missing file is null', () => {
  assert.equal(lastUidFile('x'), file);
  assert.equal(readLastUid('x'), null);
  persistLastUid('x', 42);
  assert.equal(readLastUid('x'), 42);
  persistLastUid('x', 7);
  assert.equal(readLastUid('x'), 7);
  fs.rmSync(dir, { recursive: true, force: true });
});
