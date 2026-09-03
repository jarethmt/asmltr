'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AUTH_REJECT_FILE_MODE, persistAuthRejectLine } = require('../connectors/types/email/auth-reject-persist');

test('auth-reject log is created 0o600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-reject-mode-'));
  const f = path.join(dir, 'new.jsonl');
  persistAuthRejectLine(f, { ts: 't', from: 'a@example.com' });
  assert.equal(fs.statSync(f).mode & 0o777, AUTH_REJECT_FILE_MODE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('existing auth-reject log is chmod 0o600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-reject-mode-'));
  const f = path.join(dir, 'old.jsonl');
  fs.writeFileSync(f, '', { mode: 0o644 });
  persistAuthRejectLine(f, { ts: 't' });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
