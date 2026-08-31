'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { corsAllowOrigin, authVerifyUrl, sessionOkFromVerify, approveDecision } = require('../connectors/types/mcp/approve-gate');

const allow = (client, uri) => !!(client && client.redirect_uris && client.redirect_uris.includes(uri));
const client = { redirect_uris: ['https://app.example/cb'] };

test('approve without session is 401', () => {
  const d = approveDecision({
    sessionOk: false, approved: true, client,
    redirectUri: 'https://app.example/cb', isRedirectUriAllowed: allow,
  });
  assert.equal(d.ok, false);
  assert.equal(d.status, 401);
  assert.equal(d.error_description, 'operator web session required');
});

test('approve with a valid session cookie is allowed', () => {
  const d = approveDecision({
    sessionOk: true, approved: true, client,
    redirectUri: 'https://app.example/cb', isRedirectUriAllowed: allow,
  });
  assert.equal(d.ok, true);
});

test('approve re-validates redirect_uri even with a session', () => {
  const d = approveDecision({
    sessionOk: true, approved: true, client,
    redirectUri: 'https://evil.example/cb', isRedirectUriAllowed: allow,
  });
  assert.equal(d.ok, false);
  assert.equal(d.status, 400);
});

test('approve and authorize are not CORS *', () => {
  assert.equal(corsAllowOrigin('/oauth/approve'), null);
  assert.equal(corsAllowOrigin('/oauth/authorize'), null);
  assert.equal(corsAllowOrigin('/health'), '*');
  assert.equal(corsAllowOrigin('/mcp'), '*');
});

test('auth verify URL is core /v2/auth/verify, not handle', () => {
  assert.equal(authVerifyUrl('http://127.0.0.1:3023/v2/handle'), 'http://127.0.0.1:3023/v2/auth/verify');
});

test('sessionOkFromVerify treats 401 as deny and 200 as allow', async () => {
  const deny = await sessionOkFromVerify(async () => ({ status: 401 }), 'http://127.0.0.1:3023/v2/auth/verify', '');
  const allowSess = await sessionOkFromVerify(async () => ({ status: 200 }), 'http://127.0.0.1:3023/v2/auth/verify', 'asmltr_session=mock');
  assert.equal(deny, false);
  assert.equal(allowSess, true);
});
