'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isAutomatedSender, matchOpsAllowThrough, domainMatches, persistLogOnlyAlert, collectOriginalAddrs } = require('../connectors/types/email/index.js');

const ENTRA = [{
  id: 'entra-sync-stopped',
  from_domains: ['example.com'],
  all_keywords: ['Synchronization', 'Entra ID'],
  noreply_ok: true,
  reply_to_sender: false,
}];

test('noreply sender is automated', () => {
  assert.equal(isAutomatedSender('alerts-noreply@example.com'), true);
  assert.equal(isAutomatedSender('microsoft-noreply@microsoft.com'), true);
  assert.equal(isAutomatedSender('alerts@example.com'), true);
  assert.equal(isAutomatedSender('person@example.com'), false);
  assert.equal(isAutomatedSender('alice@microsoft.com'), false);
});

test('domain match is @domain or a subdomain, not a suffix of the local part', () => {
  assert.equal(domainMatches('alerts-noreply@example.com', 'example.com'), true);
  assert.equal(domainMatches('alerts@notify.example.com', 'example.com'), true);
  assert.equal(domainMatches('evil@notexample.com', 'example.com'), false);
});

test('Entra sync matcher hits the sample Microsoft alert', () => {
  const hit = matchOpsAllowThrough(
    'alerts-noreply@example.com',
    'contoso.onmicrosoft.com: Synchronization has stopped for at least 24 hours. – You have an important alert from Microsoft Entra ID',
    'Synchronization to Microsoft Entra ID appears to have been stopped',
    ENTRA,
  );
  assert.ok(hit);
  assert.equal(hit.id, 'entra-sync-stopped');
});

test('Entra matcher does not fire without both keywords', () => {
  assert.equal(matchOpsAllowThrough(
    'alerts-noreply@example.com',
    'Something else from Microsoft Entra ID',
    'no sync word here',
    ENTRA,
  ), null);
});

test('Entra matcher does not fire from a non-matching sender', () => {
  assert.equal(matchOpsAllowThrough(
    'person@other.com',
    'Synchronization has stopped — Microsoft Entra ID',
    'Synchronization to Microsoft Entra ID stopped',
    ENTRA,
  ), null);
});

const ROBOT = [{
  id: 'log-robot',
  from_addrs: ['robot@example.com', 'backup@example.net'],
  all_keywords: [],
  log_only: true,
  reply_to_sender: false,
}];

test('from_addrs matcher hits listed senders', () => {
  const a = matchOpsAllowThrough('robot@example.com', 'NAS backup', 'ok', ROBOT);
  const b = matchOpsAllowThrough('backup@example.net', 'job done', 'ok', ROBOT);
  assert.equal(a && a.id, 'log-robot');
  assert.equal(b && b.id, 'log-robot');
  assert.equal(a.log_only, true);
});

test('from_addrs matcher hits forwarded mail via extra original From', () => {
  const hit = matchOpsAllowThrough(
    'owner@example.com',
    'Fwd: NAS backup',
    'ok',
    ROBOT,
    ['robot@example.com'],
  );
  assert.equal(hit && hit.id, 'log-robot');
});

test('from_addrs matcher does not hit unrelated senders', () => {
  assert.equal(matchOpsAllowThrough('random@example.com', 'NAS backup', 'ok', ROBOT), null);
});

test('collectOriginalAddrs reads From: in a forwarded body', () => {
  const addrs = collectOriginalAddrs(
    { from: { value: [{ address: 'owner@example.com' }] } },
    'owner@example.com',
    'From: robot@example.com\n\nbody',
  );
  assert.ok(addrs.includes('owner@example.com'));
  assert.ok(addrs.includes('robot@example.com'));
});

test('log_only persist writes jsonl and a message file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-robot-'));
  const prev = process.env.ASMLTR_OPS_LOGONLY_DIR;
  process.env.ASMLTR_OPS_LOGONLY_DIR = dir;
  try {
    const out = persistLogOnlyAlert({ id: 'log-robot' }, {
      ts: '2026-08-21T12:00:00Z',
      from: 'robot@example.com',
      original_from: 'robot@example.com',
      subject: 'NAS backup finished',
      message_id: '<test@example.com>',
      body: 'backup finished.',
    });
    assert.ok(out.id);
    const jsonl = fs.readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8');
    assert.match(jsonl, /NAS backup finished/);
    const counts = JSON.parse(fs.readFileSync(path.join(dir, 'counts.json'), 'utf8'));
    assert.equal(counts.total, 1);
  } finally {
    if (prev === undefined) delete process.env.ASMLTR_OPS_LOGONLY_DIR;
    else process.env.ASMLTR_OPS_LOGONLY_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
