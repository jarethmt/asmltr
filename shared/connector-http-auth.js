'use strict';
/**
 * V27: connector /out /send require a Bearer token. Loopback is not enough.
 * Manager deliver/read/proxy must send the same ASMLTR_MANAGER_TOKEN.
 */
const { bearerEqual } = require('./bearer-equal');

function connectorToken() {
  return process.env.ASMLTR_MANAGER_TOKEN || '';
}

function connectorAuthHeaders(token, extra) {
  const t = token == null ? connectorToken() : String(token);
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  if (t) headers.Authorization = 'Bearer ' + t;
  return headers;
}

function requireConnectorToken(req, res, next) {
  if (bearerEqual(req.get && req.get('authorization'), connectorToken())) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

module.exports = { connectorToken, connectorAuthHeaders, requireConnectorToken };
