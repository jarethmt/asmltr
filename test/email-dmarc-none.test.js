'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAuthResults, alignsWithFrom } = require('../connectors/types/email/auth-align');

// Real header from this mailbox: a legitimate sender whose domain publishes no DMARC record.
const ZENDESK = 'pidgey.thoughtspacedesigns.com; dkim=pass header.d=zendesk.com header.s=zendesk2; dmarc=none; spf=pass smtp.mailfrom=zendesk.com';
const GMAIL_OWNER = 'pidgey.thoughtspacedesigns.com; dkim=pass header.d=gmail.com header.s=20251104; spf=pass smtp.mailfrom="SRS0=ewU0=FD=gmail.com=jarethmt@ik2.com"; dmarc=pass (policy=none) header.from=gmail.com';

test('dmarc=none is parsed, not treated as missing', () => {
  assert.equal(parseAuthResults(ZENDESK).dmarc, 'none');
  assert.equal(parseAuthResults(ZENDESK).dkim, 'pass');
  assert.equal(parseAuthResults(ZENDESK).spf, 'pass');
});

test('a dmarc=none sender still has to align', () => {
  const r = parseAuthResults(ZENDESK);
  assert.equal(alignsWithFrom('support@zendesk.com', r), true);
  // Same headers, unrelated From — alignment is what keeps dmarc=none safe to accept.
  assert.equal(alignsWithFrom('jareth@thoughtspacedesigns.com', r), false);
});

test("the owner's real gmail passes and aligns", () => {
  const r = parseAuthResults(GMAIL_OWNER);
  assert.equal(r.dkim, 'pass');
  assert.equal(r.spf, 'pass');
  assert.equal(r.dmarc, 'pass');
  assert.equal(alignsWithFrom('jarethmt@gmail.com', r), true);
});
