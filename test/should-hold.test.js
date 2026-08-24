'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-hold-'));
process.env.ASMLTR_CORE_DB = path.join(tmp, 't.db');

const { shouldHold } = require('../core/src/drafts');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

test('unknown approval policy holds', () => {
  assert.equal(shouldHold('not-a-real-policy', { bypass_moderation: true }), true);
  assert.equal(shouldHold('always_send', {}), false);
  assert.equal(shouldHold('always_draft', {}), true);
  assert.equal(shouldHold('', {}), false);
  assert.equal(shouldHold(null, {}), false);
});
