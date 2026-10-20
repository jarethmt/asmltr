// asmltr Portal — module signer + built-in library (control plane for the BLE Portal).
//
// A Portal runs a step-DSL module ONLY if it carries a valid Ed25519 signature from the key the
// Portal is paired to (docs/PORTAL-PROTOCOL.md — the BadUSB line). This module owns that signing
// key (a dedicated Ed25519 keypair in the TRUST vault, NOT the mesh SSH identity) and produces the
// signed wire envelope the firmware verifies with libsodium's crypto_sign_verify_detached.
//
// The signature covers the EXACT payload bytes shipped (Buffer.from(JSON.stringify(module))), so
// there is no canonical-JSON hazard — the firmware verifies the bytes it received, verbatim.
const crypto = require('crypto');

const VAULT_KEY = 'portal_module_signing_key'; // PKCS#8 (DER, base64) Ed25519 private key
const MAGIC = Buffer.from('AMD1', 'ascii');
const ENVELOPE_VERSION = 0x01;

let _priv = null; // cached KeyObject (private)

// --- key lifecycle ----------------------------------------------------------
// Lazily mint the signing key and persist it in the vault; cache the private KeyObject in memory.
// `vault` is injected (shared/vault) so this module stays unit-testable without the daemon.
async function ensureKey(vault) {
  if (_priv) return _priv;
  let b64 = null;
  // The vault stores credential_data as an object; getSecret returns that object. Tolerate a bare
  // string too (defensive) for any hand-seeded value.
  try { const s = await vault.getSecret(VAULT_KEY, 'portal module signing'); b64 = typeof s === 'string' ? s : (s && (s.sk_pkcs8_b64 || s.value)); } catch (_) { b64 = null; }
  if (b64) {
    _priv = crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
    return _priv;
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  await vault.storeSecret(VAULT_KEY, { sk_pkcs8_b64: der.toString('base64') }, { minTrust: 'SACRED' });
  _priv = privateKey;
  return _priv;
}

// Raw 32-byte Ed25519 public key from a private KeyObject (via the JWK x coordinate).
function rawPublicKey(privKey) {
  const pub = crypto.createPublicKey(privKey);
  const jwk = pub.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url'); // 32 bytes
}

function fingerprint(rawPub) { return rawPub.subarray(0, 4).toString('hex'); }

// --- signing ----------------------------------------------------------------
// Produce the signed envelope: MAGIC(4) | VER(1) | sig(64) | payload(JSON bytes).
function buildEnvelope(privKey, moduleObj) {
  const payload = Buffer.from(JSON.stringify(moduleObj), 'utf8');
  const sig = crypto.sign(null, payload, privKey); // Ed25519 → 64-byte detached sig
  const envelope = Buffer.concat([MAGIC, Buffer.from([ENVELOPE_VERSION]), sig, payload]);
  return { payload, sig, envelope };
}

async function signModule(vault, moduleObj) {
  if (!moduleObj || typeof moduleObj !== 'object' || !Array.isArray(moduleObj.steps)) {
    throw new Error('module must be an object with a steps[] array');
  }
  const priv = await ensureKey(vault);
  const { sig, envelope } = buildEnvelope(priv, moduleObj);
  return {
    module_id: moduleObj.id || null,
    envelope_b64: envelope.toString('base64'),
    sig_b64: sig.toString('base64'),
    pubkey_b64: rawPublicKey(priv).toString('base64'),
    size: envelope.length,
  };
}

async function publicKey(vault) {
  const priv = await ensureKey(vault);
  const raw = rawPublicKey(priv);
  return { pubkey_b64: raw.toString('base64'), pubkey_fp: fingerprint(raw) };
}

// --- built-in library -------------------------------------------------------
// Small, safe modules that exercise the on-device actuators (screen / LED / status). Provisioning
// modules that drive a host via USB-HID arrive with R4 (see PORTAL-PROTOCOL.md `type`).
const LIBRARY = [
  {
    id: 'self-test', name: 'Self-test', v: 1,
    description: 'Proves the whole signed path works: the dongle verifies the signature, then paints its screen, cycles the LED through its colors, and reports each step back here.',
    steps: [
      { op: 'screen', icon: 'bolt', title: 'Self-test', body: 'Running a signed module on your Portal', color: 'violet' },
      { op: 'status', text: 'Signature verified on the dongle — running.' },
      { op: 'screen', icon: 'dot', title: 'Violet', body: 'Setting the status LED', color: 'violet' },
      { op: 'led', color: 'violet' }, { op: 'wait', ms: 700 },
      { op: 'screen', icon: 'dot', title: 'Magenta', body: 'Setting the status LED', color: 'magenta' },
      { op: 'led', color: 'magenta' }, { op: 'wait', ms: 700 },
      { op: 'screen', icon: 'dot', title: 'Cyan', body: 'Setting the status LED', color: 'cyan' },
      { op: 'led', color: 'cyan' }, { op: 'wait', ms: 700 },
      { op: 'progress', label: 'Finishing self-test', pct: 100 }, { op: 'wait', ms: 500 },
      { op: 'screen', icon: 'check', title: 'All good', body: 'Screen, LED and signed-run all work', color: 'green' },
      { op: 'led', color: 'green' },
      { op: 'status', text: 'Self-test passed — screen, LED and signed execution all OK.' },
    ],
  },
  {
    id: 'type-test', name: 'Type test', v: 1,
    description: 'Types a line of text into whatever window is focused on the plugged-in host — the first proof the Portal can drive the machine. Focus a text field (e.g. Notepad) before running.',
    steps: [
      { op: 'screen', icon: 'bolt', title: 'Type test', body: 'Focus a text box on the host — this types into it', color: 'violet' },
      { op: 'status', text: 'Make sure a text field is focused on the host...' },
      { op: 'wait', ms: 1200 },
      { op: 'type', text: 'hello from the asmltr Portal\n' },
      { op: 'screen', icon: 'check', title: 'Typed', body: 'If the text appeared on the host, USB-HID works', color: 'green' },
      { op: 'led', color: 'green' },
      { op: 'status', text: 'Type test done — check the host screen.' },
    ],
  },
  {
    id: 'identify', name: 'Identify', v: 1,
    description: 'Makes THIS dongle announce itself — names itself on-screen and flashes its LED hard so you can spot which physical Portal you are talking to.',
    steps: [
      { op: 'screen', icon: 'portal', title: 'Identify', body: 'Watch the LED — this is your Portal', color: 'violet' },
      { op: 'status', text: 'Identifying — the dongle you are connected to is flashing now.' },
      { op: 'led', color: 'white' }, { op: 'wait', ms: 180 }, { op: 'led', color: 'violet' }, { op: 'wait', ms: 180 },
      { op: 'led', color: 'white' }, { op: 'wait', ms: 180 }, { op: 'led', color: 'violet' }, { op: 'wait', ms: 180 },
      { op: 'led', color: 'white' }, { op: 'wait', ms: 180 }, { op: 'led', color: 'cyan' }, { op: 'wait', ms: 180 },
      { op: 'screen', icon: 'check', title: 'That one', body: 'The dongle that just flashed is this Portal', color: 'green' },
      { op: 'led', color: 'green' },
      { op: 'status', text: 'Identify complete.' },
    ],
  },
];

function library() { return LIBRARY.map((m) => ({ id: m.id, name: m.name, v: m.v, description: m.description, steps: m.steps.length })); }
function getModule(id) { return LIBRARY.find((m) => m.id === id) || null; }

module.exports = { ensureKey, signModule, publicKey, library, getModule, buildEnvelope, rawPublicKey, fingerprint, VAULT_KEY, MAGIC, ENVELOPE_VERSION };
