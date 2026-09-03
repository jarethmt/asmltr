'use strict';
/**
 * V17: PKCE S256 only. Method `plain` is rejected.
 */
const { createHash } = require('crypto');

const PKCE_METHODS = ['S256'];

function isPkceMethodSupported(method) {
  return method === 'S256';
}

function verifyPKCE(codeVerifier, codeChallenge, codeChallengeMethod = 'S256') {
  if (!codeVerifier || !codeChallenge) return false;
  if (codeChallengeMethod !== 'S256') return false;
  const computed = createHash('sha256').update(String(codeVerifier)).digest('base64url');
  return computed === codeChallenge;
}

module.exports = { PKCE_METHODS, isPkceMethodSupported, verifyPKCE };
