'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedLocalSubmission, receivedHopIsLocal } = require('../connectors/types/email/local-submission');

const LOCAL = ['thoughtspacedesigns.com'];
// Shaped on a real message: jareth@thoughtspacedesigns.com -> eve@, which carries NO
// Authentication-Results because rspamd sets skip_authenticated = true.
const genuine = () => ({
  fromAddr: 'jareth@thoughtspacedesigns.com',
  received: [
    'from pidgey.thoughtspacedesigns.com ([172.22.1.253]) by 4c55508000ff with LMTP id kG8',
    'from [127.0.0.1] (localhost [127.0.0.1]) by localhost (Mailerdaemon) with ESMTPSA id 3E6',
  ],
  dkimSignatures: ['v=1; a=rsa-sha256; c=relaxed/relaxed; d=thoughtspacedesigns.com; s=dkim; t=1789575695'],
  hasAllowlistedAR: false,
  localDomains: LOCAL,
});

test('genuine authenticated local submission is accepted', () => {
  assert.equal(isTrustedLocalSubmission(genuine()), true);
});

test('off by default — no local domains configured means never trusted', () => {
  assert.equal(isTrustedLocalSubmission({ ...genuine(), localDomains: [] }), false);
});

test('a single public Received hop disqualifies it', () => {
  const m = genuine();
  m.received.unshift('from evil.example ([203.0.113.9]) by pidgey.thoughtspacedesigns.com with ESMTP');
  assert.equal(isTrustedLocalSubmission(m), false);
});

test('forged local Received lines cannot help — our hop names a public IP', () => {
  // The attacker appends believable local-looking hops, but the header OUR server prepends
  // still carries their real public address, and they cannot remove it.
  assert.equal(isTrustedLocalSubmission({
    ...genuine(),
    received: [
      'from mail.pidgey.thoughtspacedesigns.com ([198.51.100.4]) by pidgey with ESMTP',
      'from [127.0.0.1] (localhost [127.0.0.1]) by localhost with ESMTPSA id fake',
    ],
  }), false);
});

test('DKIM d= must match the From domain', () => {
  assert.equal(isTrustedLocalSubmission({ ...genuine(), dkimSignatures: ['v=1; d=evil.example; s=k'] }), false);
  assert.equal(isTrustedLocalSubmission({ ...genuine(), dkimSignatures: [] }), false);
});

test('From must be one of our own domains', () => {
  assert.equal(isTrustedLocalSubmission({ ...genuine(), fromAddr: 'someone@gmail.com' }), false);
});

test('an allowlisted Authentication-Results means it came from outside — not local', () => {
  assert.equal(isTrustedLocalSubmission({ ...genuine(), hasAllowlistedAR: true }), false);
});

test('an empty Received chain proves nothing', () => {
  assert.equal(isTrustedLocalSubmission({ ...genuine(), received: [] }), false);
});

test('receivedHopIsLocal classifies RFC1918, loopback and public correctly', () => {
  assert.equal(receivedHopIsLocal('from x ([10.0.0.5]) by y'), true);
  assert.equal(receivedHopIsLocal('from x ([172.22.1.253]) by y'), true);
  assert.equal(receivedHopIsLocal('from x ([192.168.1.9]) by y'), true);
  assert.equal(receivedHopIsLocal('from x ([127.0.0.1]) by y'), true);
  assert.equal(receivedHopIsLocal('from x ([8.8.8.8]) by y'), false);
  assert.equal(receivedHopIsLocal('from x ([172.32.0.1]) by y'), false); // just outside RFC1918
  assert.equal(receivedHopIsLocal('by 4c55508000ff with LMTP'), true);   // no address named
});
