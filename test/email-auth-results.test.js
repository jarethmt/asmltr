'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseAuthResults, authDisposition, formatAuthSummary, authRejected,
  persistAuthReject, loadAuthRejectLog, filterAuthRejectsSince, formatAuthJournal,
} = require('../connectors/types/email/index.js');

const rejectLog = path.join(os.tmpdir(), 'asmltr-email-auth-reject-test.jsonl');
process.env.ASMLTR_EMAIL_AUTH_REJECT_LOG = rejectLog;

after(() => {
  delete process.env.ASMLTR_OWNER_FROM_EMAIL;
  delete process.env.ASMLTR_EMAIL_AUTH_REJECT_LOG;
  try { fs.unlinkSync(rejectLog); } catch (_) {}
});

function parsedWith(header, fromAddr) {
  return {
    from: fromAddr ? { value: [{ address: fromAddr }] } : { value: [{ address: 'owner@example.com' }] },
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'authentication-results') return header;
        return undefined;
      },
    },
  };
}

const GMAIL_PASS = 'mx.google.com; dkim=pass header.i=@example.com header.s=google header.b=abcd; ' +
  'spf=pass (google.com: domain of owner@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=owner@example.com; ' +
  'dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com';

const GMAIL_FAIL = 'mx.google.com; dkim=fail header.i=@example.com; spf=fail smtp.mailfrom=owner@example.com; dmarc=fail header.from=example.com';

test('parseAuthResults reads dkim/spf/dmarc first token', () => {
  const r = parseAuthResults(GMAIL_PASS);
  assert.equal(r.dkim, 'pass');
  assert.equal(r.spf, 'pass');
  assert.equal(r.dmarc, 'pass');
});

test('parseAuthResults empty header is all null', () => {
  assert.equal(parseAuthResults('').dkim, null);
  assert.equal(parseAuthResults('').spf, null);
  assert.equal(parseAuthResults('').dmarc, null);
  assert.equal(parseAuthResults(null).dkim, null);
});

test('authDisposition pass only when DKIM and SPF and DMARC are pass', () => {
  const a = authDisposition(parsedWith(GMAIL_PASS), { authservIds: ['mx.google.com'] });
  assert.equal(a.present, true);
  assert.equal(a.passed, true);
  assert.equal(a.failed, false);
  assert.equal(authRejected(a), false);
});

test('authDisposition fail when any of the three is fail', () => {
  const a = authDisposition(parsedWith(GMAIL_FAIL), { authservIds: ['mx.google.com'] });
  assert.equal(a.present, true);
  assert.equal(a.passed, false);
  assert.equal(a.failed, true);
  assert.equal(authRejected(a), true);
});

test('authDisposition missing header is a fail', () => {
  const a = authDisposition({ headers: { get() { return undefined; } } }, { authservIds: ['mx.google.com'] });
  assert.equal(a.present, false);
  assert.equal(a.failed, true);
  assert.equal(a.passed, false);
  assert.equal(authRejected(a), true);
  assert.match(a.reason, /missing AR/);
});

test('dmarc pass does not excuse a dkim or spf miss', () => {
  const a = authDisposition(parsedWith('mx.example; spf=fail; dkim=fail; dmarc=pass'), { authservIds: ['mx.example'] });
  assert.equal(a.passed, false);
  assert.equal(a.failed, true);
  assert.match(a.reason, /DKIM=fail/);
  assert.match(a.reason, /SPF=fail/);
});

test('spf pass and dkim pass without dmarc is a fail', () => {
  const a = authDisposition(parsedWith('mx.example; dkim=pass; spf=pass'), { authservIds: ['mx.example'] });
  assert.equal(a.failed, true);
  assert.match(a.reason, /DMARC=missing/);
});

test('softfail SPF is not a pass', () => {
  const a = authDisposition(parsedWith('mx.example; dkim=pass; spf=softfail; dmarc=pass'), { authservIds: ['mx.example'] });
  assert.equal(a.failed, true);
  assert.match(a.reason, /SPF=softfail/);
});

test('authRejected is everyone, not owner-only', () => {
  const fail = authDisposition(parsedWith(GMAIL_FAIL), { authservIds: ['mx.google.com'] });
  const pass = authDisposition(parsedWith(GMAIL_PASS), { authservIds: ['mx.google.com'] });
  assert.equal(authRejected(fail), true);
  assert.equal(authRejected(pass), false);
  assert.equal(authRejected(null), true);
});

test('formatAuthSummary', () => {
  assert.match(formatAuthSummary(authDisposition(parsedWith(GMAIL_PASS), { authservIds: ['mx.google.com'] })), /DKIM=pass SPF=pass DMARC=pass — PASS/);
  assert.match(formatAuthSummary(authDisposition({ headers: { get() {} } }, { authservIds: ['mx.google.com'] })), /none \(treated as fail\)/);
});

test('formatAuthJournal is sender and subject only; empty when none', () => {
  assert.equal(formatAuthJournal([]), '');
  assert.equal(formatAuthJournal(null), '');
  const body = formatAuthJournal([
    { ts: '2026-08-20T12:00:00.000Z', from: 'spoof@example.com', subject: 'Hello', reason: 'DKIM=fail' },
    { ts: '2026-08-20T13:00:00.000Z', from: 'other@example.com', subject: 'Hi' },
  ]);
  assert.match(body, /spoof@example.com — Hello/);
  assert.match(body, /other@example.com — Hi/);
  assert.equal(body.includes('DKIM=fail'), false);
  assert.equal(body.includes('reason'), false);
});

test('filterAuthRejectsSince keeps the last window only', () => {
  const entries = [
    { ts: '2026-08-19T10:00:00.000Z', from: 'old@example.com', subject: 'old' },
    { ts: '2026-08-20T10:00:00.000Z', from: 'new@example.com', subject: 'new' },
  ];
  const since = Date.parse('2026-08-20T00:00:00.000Z');
  const kept = filterAuthRejectsSince(entries, since);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].from, 'new@example.com');
});

test('persist and load auth reject log', () => {
  persistAuthReject({ ts: '2026-08-20T11:00:00.000Z', from: 'a@example.com', subject: 'x', reason: 'no header' });
  const loaded = loadAuthRejectLog(rejectLog);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].from, 'a@example.com');
  assert.equal(loaded[0].subject, 'x');
});

const { alignsWithFrom } = require('../connectors/types/email/auth-align');

test('Auth-Results pass fails closed when 5322 From does not align', () => {
  const a = authDisposition(parsedWith(GMAIL_PASS, 'attacker@evil.test'), { authservIds: ['mx.google.com'] });
  assert.equal(a.passed, false);
  assert.equal(a.failed, true);
  assert.equal(authRejected(a), true);
  assert.match(a.reason, /align/i);
});

test('alignsWithFrom binds From to dkim d= / spf mailfrom', () => {
  const r = parseAuthResults(GMAIL_PASS);
  assert.equal(alignsWithFrom('owner@example.com', r), true);
  assert.equal(alignsWithFrom('attacker@evil.test', r), false);
});

const {
  parseAuthservId, loadAuthservAllowlist, listAuthenticationResults,
} = require('../connectors/types/email/index.js');

test('Gmail-shaped AR + config mx.google.com accepts', () => {
  const a = authDisposition(parsedWith(GMAIL_PASS), { authservIds: ['mx.google.com'] });
  assert.equal(a.passed, true);
  assert.equal(a.failed, false);
});

test('same AR but allowlist unset fails with unset', () => {
  const a = authDisposition(parsedWith(GMAIL_PASS), { authservIds: [] });
  assert.equal(a.failed, true);
  assert.match(a.reason, /unset/);
});

test('AR from other authserv fails mismatch', () => {
  const a = authDisposition(parsedWith(GMAIL_PASS), { authservIds: ['mx.microsoft.com'] });
  assert.equal(a.failed, true);
  assert.match(a.reason, /mismatch/);
});

test('missing AR, only ARC with pass, fails ARC-only', () => {
  const parsed = {
    from: { value: [{ address: 'owner@example.com' }] },
    headers: {
      get(name) {
        const k = String(name).toLowerCase();
        if (k === 'arc-authentication-results') {
          return 'i=1; mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=owner@example.com; dmarc=pass header.from=example.com';
        }
        return undefined;
      },
    },
  };
  const a = authDisposition(parsed, { authservIds: ['mx.google.com'] });
  assert.equal(a.failed, true);
  assert.match(a.reason, /ARC-only/);
});

test('concatenated extra AR: only matching authserv counts', () => {
  const parsed = {
    from: { value: [{ address: 'owner@example.com' }] },
    headerLines: [
      { key: 'authentication-results', line: 'Authentication-Results: mx.other.com; dkim=fail; spf=fail; dmarc=fail' },
      { key: 'authentication-results', line: 'Authentication-Results: ' + GMAIL_PASS },
    ],
    headers: { get() { return undefined; } },
  };
  const a = authDisposition(parsed, { authservIds: ['mx.google.com'] });
  assert.equal(a.passed, true);
  assert.equal(parseAuthservId(a.raw), 'mx.google.com');
});

test('parseAuthservId is first token before semicolon', () => {
  assert.equal(parseAuthservId(GMAIL_PASS), 'mx.google.com');
  assert.equal(parseAuthservId('Authentication-Results: mx.microsoft.com; dkim=pass'), 'mx.microsoft.com');
});

test('loadAuthservAllowlist empty/missing file is empty', () => {
  assert.deepEqual(loadAuthservAllowlist('/tmp/asmltr-no-such-authserv.json'), []);
});

test('loadAuthservAllowlist reads authserv_ids from temp file', () => {
  const f = path.join(os.tmpdir(), 'asmltr-authserv-allow.json');
  fs.writeFileSync(f, JSON.stringify({ authserv_ids: ['mx.google.com'] }));
  assert.deepEqual(loadAuthservAllowlist(f), ['mx.google.com']);
  fs.unlinkSync(f);
});
