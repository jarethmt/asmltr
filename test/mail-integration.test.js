'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Point the registry at a scratch file so these never touch a live install.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-int-'));
process.env.ASMLTR_INTEGRATIONS_FILE = path.join(TMP, 'integrations.json');
fs.writeFileSync(process.env.ASMLTR_INTEGRATIONS_FILE, '{}');

const reg = require('../integrations/registry');
const mail = require('../integrations/types/mail');

test('mail driver declares itself a passive tools capability', () => {
  // The whole point of T4: a mailbox link runs NO process until opened.
  assert.equal(mail.kind, 'tools');
  assert.equal(mail.lifecycle, 'passive');
  assert.equal(typeof mail.open, 'function');
  assert.equal(typeof mail.probe, 'function');
});

test('a mail integration round-trips through the registry with kind/lifecycle', () => {
  const it = reg.create({
    type: 'mail', kind: 'tools', lifecycle: 'passive', name: 'test box',
    config: { imap_host: 'h', smtp_host: 'h', user_ref: 'k_user', password_ref: 'k_pass' },
  });
  const got = reg.get(it.id);
  assert.equal(got.type, 'mail');
  assert.equal(got.kind, 'tools');
  assert.equal(got.lifecycle, 'passive');
  // secrets are stored as REFS, never values
  assert.equal(got.config.user_ref, 'k_user');
  assert.ok(!('user' in got.config), 'resolved secret must not be persisted');
  assert.ok(!('password' in got.config), 'resolved secret must not be persisted');
});

test('openStorage refuses a tools integration, and openTool refuses storage', async () => {
  const tool = reg.create({ type: 'mail', kind: 'tools', lifecycle: 'passive', name: 't', config: {} });
  await assert.rejects(() => reg.openTool(reg.create({
    type: 'webdav', kind: 'storage', lifecycle: 'passive', name: 's', config: {},
  }).id), /is storage — use openStorage/);
  // a tools integration is not openable as storage either
  await assert.rejects(() => reg.openStorage(tool.id));
});

test('open() dispatches on kind', async () => {
  const it = reg.create({ type: 'mail', kind: 'tools', lifecycle: 'passive', name: 't2', config: {} });
  // no host configured, so it must fail in the DRIVER (required-field check), proving dispatch
  // reached the mail driver rather than the storage path.
  await assert.rejects(() => reg.open(it.id), /imap_host required/);
});

test('test() reports a real failure rather than a false pass', async () => {
  const it = reg.create({
    type: 'mail', kind: 'tools', lifecycle: 'passive', name: 'bad',
    config: { imap_host: 'invalid.invalid', smtp_host: 'invalid.invalid', user_ref: 'nope', password_ref: 'nope' },
  });
  const r = await reg.test(it.id);
  assert.equal(r.ok, false, 'an unreachable host must not report ok');
  assert.ok(r.error, 'a failure must carry a reason');
});
