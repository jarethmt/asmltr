'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-kind-'));
process.env.ASMLTR_INTEGRATIONS_FILE = path.join(TMP, 'integrations.json');
fs.writeFileSync(process.env.ASMLTR_INTEGRATIONS_FILE, '{}');
const reg = require('../integrations/registry');
const google = require('../shared/google-oauth');

// The dashboard did not send `kind`, so create() defaulted it to 'storage' and every mail /
// caldav / carddav link made through the GUI failed at open with
// "unknown storage driver 'mail'" — the original bug report, which survived the first fix
// because it was only ever retested against an API-created row that passed kind explicitly.
test('kind is derived from the driver when the caller omits it', () => {
  for (const [type, expected] of [['mail', 'tools'], ['caldav', 'tools'], ['carddav', 'tools']]) {
    const it = reg.create({ type, name: 't-' + type, config: {} });
    assert.equal(it.kind, expected, `${type} must be ${expected}, not storage`);
    assert.equal(it.lifecycle, 'passive');
  }
});

test('storage drivers are unaffected — no regression', () => {
  for (const type of ['webdav', 's3']) {
    const it = reg.create({ type, name: 's-' + type, config: {} });
    assert.equal(it.kind, 'storage');
  }
});

test('the driver wins over a caller that passes the wrong kind', () => {
  const it = reg.create({ type: 'mail', name: 'wrong', config: {}, kind: 'storage' });
  assert.equal(it.kind, 'tools', 'a driver that declares its kind is authoritative');
});

test('type is required', () => {
  assert.throws(() => reg.create({ name: 'x', config: {} }), /type is required/);
});

// `state` is the only thing tying Google's redirect back to the authorization we started.
// It was minted server-side and never put in the URL, so every redirect-mode consent died on
// "unknown or expired authorization" AFTER the operator had already approved.
test('authUrl includes state when given, and omits it when not', () => {
  const withState = google.authUrl({ client_id: 'c', state: 'abc123' });
  assert.match(withState, /[?&]state=abc123(&|$)/);
  const without = google.authUrl({ client_id: 'c' });
  assert.ok(!/[?&]state=/.test(without), 'no empty state parameter');
});

test('authUrl asks for an offline grant with forced consent', () => {
  const u = google.authUrl({ client_id: 'c', state: 's' });
  // without both of these Google omits the refresh token on re-consent
  assert.match(u, /access_type=offline/);
  assert.match(u, /prompt=consent/);
  assert.match(u, /mail\.google\.com/);
});
