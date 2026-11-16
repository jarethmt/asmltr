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

// rspamd writes `header.d=`, not a bare `d=`. The original regex required a boundary before
// `d`, so our own server's headers never yielded a DKIM domain and alignment only succeeded
// when a `header.from=` happened to be present as well. Real header from this mailbox:
test('DKIM domain is extracted from the header.d= form rspamd emits', () => {
  const r = parseAuthResults(ZENDESK);
  assert.equal(r.dkimD, 'zendesk.com');
  // twilio.zendesk.com is a subdomain of the signing domain, so it aligns (relaxed).
  assert.equal(alignsWithFrom('consumertrustsupport@twilio.zendesk.com', r), true);
});

test('a bare d= still works, and an unrelated From still fails to align', () => {
  const bare = parseAuthResults('mx.example; dkim=pass d=example.com; spf=pass; dmarc=pass');
  assert.equal(bare.dkimD, 'example.com');
  assert.equal(alignsWithFrom('x@example.com', bare), true);
  assert.equal(alignsWithFrom('x@evil.example', bare), false);
});

// header.from must never count as alignment evidence: it restates the From being checked, so
// including it let an attacker who signs with their OWN domain satisfy alignment using the
// victim's name. Latent while dmarc=pass was mandatory; live once dmarc=none is accepted.
test('a self-signed forgery cannot align via header.from', () => {
  const r = parseAuthResults(
    'pidgey.thoughtspacedesigns.com; dkim=pass header.d=evil.example; ' +
    'spf=pass smtp.mailfrom=evil.example; dmarc=none header.from=victim-no-dmarc.com');
  assert.equal(r.dkim, 'pass');
  assert.equal(r.spf, 'pass');
  assert.equal(alignsWithFrom('owner@victim-no-dmarc.com', r), false);
  // It still aligns for the domain it actually proved.
  assert.equal(alignsWithFrom('x@evil.example', r), true);
});
