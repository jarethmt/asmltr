'use strict';
/**
 * V18: Android device-token auth + fail-closed target_key.
 * /gw/rpc and /out must present a device token when require_token is on.
 * A token may only target its own conversation_key (or another key owned
 * by the same identity). Foreign target_key is 403.
 */

function extractDeviceToken(req) {
  const b = (req && req.body) || {};
  const q = (req && req.query) || {};
  if (b.token) return String(b.token);
  if (q.token) return String(q.token);
  const headers = (req && req.headers) || {};
  let h = '';
  if (req && typeof req.get === 'function') h = req.get('authorization') || '';
  else h = headers.authorization || headers.Authorization || '';
  if (typeof h === 'string' && /^Bearer /i.test(h)) return h.slice(7);
  return '';
}

function deviceAuthAllowed({ requireToken, token, lookup }) {
  const find = typeof lookup === 'function' ? lookup : () => null;
  if (!requireToken) {
    const e = token ? find(token) : null;
    return { ok: true, identity: (e && e.identity) || 'android-anon', username: (e && e.username) || 'android' };
  }
  if (!token) return { ok: false, status: 401, error: 'invalid device token' };
  const e = find(token);
  if (!e) return { ok: false, status: 401, error: 'invalid device token' };
  return { ok: true, identity: e.identity, username: e.username || e.identity };
}

function resolveTurnKey({ targetKey, ownConvKey, identityOwnKeys }) {
  const tk = String(targetKey || '').trim();
  if (!tk) return { ok: true, conversationKey: ownConvKey };
  if (tk === ownConvKey) return { ok: true, conversationKey: tk };
  if (identityOwnKeys && typeof identityOwnKeys.has === 'function' && identityOwnKeys.has(tk)) {
    return { ok: true, conversationKey: tk };
  }
  return { ok: false, status: 403, error: 'target_key not owned by this device' };
}

module.exports = { extractDeviceToken, deviceAuthAllowed, resolveTurnKey };
