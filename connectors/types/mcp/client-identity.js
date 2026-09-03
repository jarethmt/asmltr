'use strict';
/**
 * V16 M1: Approve authorizes that client_id as itself.
 * Do not map to owner, Adjutant, or a shared user:unknown session.
 */

function isUnknownIdentity(id) {
  if (!id) return true;
  const uid = String(id.userId || '').trim();
  return !uid || uid === 'unknown';
}

function canAskOracle(id) {
  return !isUnknownIdentity(id);
}

function lookupClientIdentity(map, clientId) {
  if (!clientId || !map || typeof map.get !== 'function') return null;
  const hit = map.get(clientId);
  if (hit && !isUnknownIdentity(hit)) {
    return { userId: String(hit.userId), username: String(hit.username || hit.userId) };
  }
  return null;
}

/** Existing mapped identity wins (Adjutant untouched). Else userId = client_id. */
function identityForApprove(clientId, existing, clientName) {
  const cid = String(clientId || '').trim();
  if (!cid) return null;
  if (existing && !isUnknownIdentity(existing)) {
    return { userId: String(existing.userId), username: String(existing.username || existing.userId) };
  }
  return { userId: cid, username: String(clientName || cid) };
}

module.exports = { isUnknownIdentity, canAskOracle, lookupClientIdentity, identityForApprove };
