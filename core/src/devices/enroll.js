'use strict';
/**
 * Device credential issuance (docs/DEVICE-REGISTRY.md, P0).
 *
 * Replaces the remote-desktop broker's hand-edited `keys.json`. A machine no longer receives a
 * secret a human pasted into a file — it CLAIMS one:
 *
 *   1. an operator creates the device row and mints a one-time enrollment code (short-lived, stored
 *      hashed) — the code is not a credential and grants nothing on its own
 *   2. the machine redeems the code exactly once and receives its long-lived device credential
 *   3. the VALUE goes to the TRUST vault under `device:<device_id>:<transport>`; the registry keeps
 *      only a SHA-256 so it can verify but never reproduce it
 *
 * That third step is the point of the whole exercise: revocation becomes one row update plus one
 * vault delete, instead of editing a JSON file on disk and restarting a connector.
 *
 * DEGRADED-BUT-LOUD: asmltr treats the vault as a hard dependency. If it is sealed or unreachable we
 * refuse to issue rather than silently falling back to a credential stored somewhere weaker.
 */
const crypto = require('crypto');
const vault = require('../../../shared/vault');
const { devices, transports, grants, deviceSessions, enrollments } = require('./store');

const credentialRef = (deviceId, transport) => `device:${deviceId}:${transport}`;

async function assertVaultUsable() {
  const h = await vault.health();
  if (!h.ok) throw new Error(`vault unavailable (${h.error || 'unreachable'}) — refusing to issue a device credential`);
  if (h.sealed) throw new Error('vault is sealed — unseal it before issuing device credentials');
}

/**
 * Issue (or rotate) a credential for one transport of one device.
 * Returns the token ONCE — it is never retrievable from the registry again, only from the vault.
 */
async function issue(deviceId, transport, { purpose = 'device enrollment' } = {}) {
  const d = devices.get(deviceId);
  if (!d) throw new Error(`unknown device: ${deviceId}`);
  if (!d.transports.some((t) => t.transport === transport)) transports.upsert(deviceId, { transport });
  await assertVaultUsable();

  const token = crypto.randomBytes(32).toString('base64url');
  const ref = credentialRef(deviceId, transport);
  await vault.storeSecret(ref, { token, device_id: deviceId, transport, issued_at: Date.now(), purpose });
  transports.bindCredential(deviceId, transport, token, ref);
  return { token, credential_ref: ref, device_id: deviceId, transport };
}

/** Mint a one-time enrollment code an operator hands to the machine. */
function mintCode(deviceId, transport, ttlMs) {
  return enrollments.create(deviceId, transport, ttlMs);
}

/**
 * Redeem an enrollment code → a device credential. Called by the machine itself, so it is the one
 * path here that is reachable without an operator session; the code is single-use and expiring,
 * and an invalid code must be indistinguishable from an expired one to the caller.
 */
async function redeem(code) {
  const claim = enrollments.consume(code);
  if (!claim) throw new Error('invalid or expired enrollment code');
  const issued = await issue(claim.device_id, claim.transport, { purpose: 'enrollment code redemption' });
  const d = devices.get(claim.device_id);
  return { ...issued, name: d.name, kind: d.kind };
}

/**
 * Revoke a device (or one of its transports): drop the hash so every presented token fails closed,
 * then remove the value from the vault. Order matters — the registry is the authority the hot path
 * consults, so it must fail closed even if the vault delete errors.
 */
async function revoke(deviceId, transport = null) {
  const affected = transports.revoke(deviceId, transport);
  // Revoking a whole device pulls its grants and closes its open sessions too; revoking a single
  // transport only cuts that wire, leaving the device and anyone's access to its other transports.
  let grantsRevoked = 0, sessionsClosed = 0;
  if (!transport) {
    grantsRevoked = grants.revokeForDevice(deviceId);
    for (const s of deviceSessions.openForDevice(deviceId)) { deviceSessions.close(s.id, 'revoked'); sessionsClosed++; }
  }
  const list = transport ? [transport] : (devices.get(deviceId)?.transports || []).map((t) => t.transport);
  const vaultErrors = [];
  for (const t of list) {
    try { await vault.deleteSecret(credentialRef(deviceId, transport || t)); }
    catch (e) { vaultErrors.push(`${t}: ${e.message}`); }
  }
  return { ok: true, transports_revoked: affected, grants_revoked: grantsRevoked, sessions_closed: sessionsClosed, vault_errors: vaultErrors };
}

module.exports = { issue, mintCode, redeem, revoke, credentialRef };
