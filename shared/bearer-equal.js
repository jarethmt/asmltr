'use strict';
/**
 * V26: constant-time Bearer compare. Fail closed if token is unset.
 */
const { timingSafeEqual } = require('crypto');

function bearerEqual(header, token) {
  if (!token) return false;
  const expected = Buffer.from('Bearer ' + String(token), 'utf8');
  const got = Buffer.from(String(header || ''), 'utf8');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

module.exports = { bearerEqual };
