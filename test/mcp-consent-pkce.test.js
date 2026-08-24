'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { createHash } = require('crypto');
const path = require('path');
const { escapeHtml } = require('../connectors/types/mcp/consent-escape');
const { PKCE_METHODS, isPkceMethodSupported, verifyPKCE } = require('../connectors/types/mcp/pkce');

test('escapeHtml does not leave a script tag raw', () => {
  const name = '<script>alert(1)</script>';
  const out = escapeHtml(name);
  assert.equal(out.includes('<script>'), false);
  assert.equal(out.includes('</script>'), false);
  assert.ok(out.includes('&lt;script&gt;'));
  assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('consent.html escapes clientName and error.message', () => {
  const html = readFileSync(path.join(__dirname, '../connectors/types/mcp/consent.html'), 'utf8');
  assert.equal(html.includes('${clientName}'), false);
  assert.equal(html.includes('${error.message}'), false);
  assert.ok(html.includes('${escapeHtml(clientName)}'));
  assert.ok(html.includes('${escapeHtml(error.message)}'));
  assert.ok(html.includes('function escapeHtml'));
});

test('plain PKCE is rejected', () => {
  assert.equal(isPkceMethodSupported('plain'), false);
  assert.equal(verifyPKCE('same', 'same', 'plain'), false);
  assert.deepEqual(PKCE_METHODS, ['S256']);
});

test('S256 PKCE still works', () => {
  const verifier = 'verifier-value-ok';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(isPkceMethodSupported('S256'), true);
  assert.equal(verifyPKCE(verifier, challenge, 'S256'), true);
  assert.equal(verifyPKCE('wrong', challenge, 'S256'), false);
});
