'use strict';
/**
 * Auth — the session-gate foundation for asmltr's identity plane (roadmap P1; docs/AUTH.md).
 *
 * Phase A only: local accounts (scrypt password, constant-time verify) + stateless HMAC-signed session
 * tokens + login rate-limiting. Everything here is ADDITIVE and OFF unless `ASMLTR_AUTH=on` — the gate
 * (`requireAuth`) is a no-op while disabled, so wiring it in can never lock out a live install. TOTP /
 * passkey / OIDC / forward-auth / OIDC-provider / vault-linkage are later phases that build on this.
 *
 * Sessions are stateless: `base64url(payload).base64url(HMAC-SHA256(payload, secret))`, payload =
 * `{sub, iat, exp, v}`. `v` is the account store's token version — bumping it revokes all sessions. The
 * signing secret is `ASMLTR_AUTH_SECRET`, else a generated `~/.asmltr/auth/secret` (persisted 0600) so
 * sessions survive restarts without editing `.env`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH_DIR = process.env.ASMLTR_AUTH_DIR || path.join(os.homedir(), '.asmltr', 'auth');
const ACCOUNTS = path.join(AUTH_DIR, 'accounts.json');
const SECRET_FILE = path.join(AUTH_DIR, 'secret');
const COOKIE = process.env.ASMLTR_AUTH_COOKIE || 'asmltr_session';
const SESSION_TTL = Number(process.env.ASMLTR_AUTH_TTL || 12 * 3600); // seconds
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function enabled() { return /^(1|on|true|yes)$/i.test(process.env.ASMLTR_AUTH || ''); }
function ensureDir() { fs.mkdirSync(AUTH_DIR, { recursive: true }); }

// ── signing secret (env → persisted file → generate) ──────────────────────────
let _secret = null;
function secret() {
  if (_secret) return _secret;
  if (process.env.ASMLTR_AUTH_SECRET) return (_secret = Buffer.from(process.env.ASMLTR_AUTH_SECRET, 'utf8'));
  try { return (_secret = fs.readFileSync(SECRET_FILE)); } catch (_) { /* generate below */ }
  ensureDir();
  const s = crypto.randomBytes(48);
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return (_secret = s);
}

// ── account store ─────────────────────────────────────────────────────────────
function load() { try { return JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); } catch (_) { return { users: {}, token_version: 1 }; } }
function save(d) { ensureDir(); fs.writeFileSync(ACCOUNTS, JSON.stringify(d, null, 2), { mode: 0o600 }); }

function hasAccount() { const d = load(); return Object.keys(d.users || {}).length > 0; }
function listUsers() { return Object.keys(load().users || {}); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, SCRYPT.keylen, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex'), algo: 'scrypt', params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen } };
}

function createAccount(username, password) {
  if (!username || !password) throw new Error('username + password required');
  if (String(password).length < 8) throw new Error('password must be at least 8 characters');
  const d = load();
  if (d.users[username]) throw new Error('account already exists: ' + username);
  d.users[username] = { ...hashPassword(password), created_at: Date.now() };
  if (!d.token_version) d.token_version = 1;
  save(d);
  return { username };
}

function setPassword(username, password) {
  const d = load();
  if (!d.users[username]) throw new Error('no such account: ' + username);
  d.users[username] = { ...d.users[username], ...hashPassword(password), updated_at: Date.now() };
  save(d);
  return { username };
}

/** Constant-time password verify. Always does a scrypt to blunt user-enumeration timing. */
function verifyPassword(username, password) {
  const d = load();
  const u = d.users[username];
  const salt = Buffer.from((u && u.salt) || '00'.repeat(16), 'hex');
  const params = (u && u.params) || SCRYPT;
  const want = Buffer.from((u && u.hash) || '', 'hex');
  const got = crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt, (u && u.params && u.params.keylen) || SCRYPT.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem });
  return !!u && want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ── TOTP (RFC 6238) + recovery codes ───────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8); for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const h = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
/** Generate a TOTP secret + the otpauth:// URL for a QR code. */
function generateTotp(username) {
  const secret = b32encode(crypto.randomBytes(20));
  const issuer = encodeURIComponent(process.env.ASSISTANT_NAME || 'asmltr');
  const label = encodeURIComponent(`${process.env.ASSISTANT_NAME || 'asmltr'}:${username}`);
  return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&period=30&digits=6&algorithm=SHA1` };
}
/** Verify a 6-digit TOTP code against a base32 secret (±1 step tolerance). */
function verifyTotpCode(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code || '').trim())) return false;
  const buf = b32decode(secret); const step = Math.floor(Date.now() / 1000 / 30);
  const want = String(code).trim();
  for (let d = -1; d <= 1; d++) { const c = hotp(buf, step + d); if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(want))) return true; }
  return false;
}
const totpEnabled = (username) => { const u = load().users[username]; return !!(u && u.totp && u.totp.enabled); };

/** Begin TOTP enrollment: stash a PENDING secret (not enabled until a code is confirmed). */
function totpBeginEnroll(username) {
  const d = load(); const u = d.users[username]; if (!u) throw new Error('no such account');
  const t = generateTotp(username);
  u.totp = { ...(u.totp || {}), pending_secret: t.secret, enabled: !!(u.totp && u.totp.enabled) };
  save(d); return t;
}
/** Confirm enrollment with a code → enable TOTP + return fresh recovery codes. */
function totpConfirmEnroll(username, code) {
  const d = load(); const u = d.users[username]; if (!u || !u.totp || !u.totp.pending_secret) throw new Error('no pending enrollment');
  if (!verifyTotpCode(u.totp.pending_secret, code)) throw new Error('code did not verify');
  u.totp = { secret: u.totp.pending_secret, enabled: true, enrolled_at: Date.now() };
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
  u.recovery = codes.map((c) => crypto.createHash('sha256').update(c).digest('hex'));
  save(d); return { codes };
}
function totpDisable(username) { const d = load(); const u = d.users[username]; if (u) { delete u.totp; delete u.recovery; save(d); } return true; }
/** Verify + CONSUME a one-time recovery code. */
function verifyRecoveryCode(username, code) {
  const d = load(); const u = d.users[username]; if (!u || !u.recovery) return false;
  const h = crypto.createHash('sha256').update(String(code || '').trim()).digest('hex');
  const i = u.recovery.indexOf(h); if (i < 0) return false;
  u.recovery.splice(i, 1); save(d); return true;
}

// ── WebAuthn passkey storage (crypto lives in core/src/passkey.js; this is just the account store) ──
function accountExists(username) { return !!load().users[username]; }
function listPasskeys(username) { const u = load().users[username]; return (u && u.webauthn && u.webauthn.credentials) || []; }
function passkeysEnabled(username) { return listPasskeys(username).length > 0; }
function addPasskey(username, cred) { // cred: { id, publicKey, counter, transports, name, added_at }
  const d = load(); const u = d.users[username]; if (!u) throw new Error('no such account');
  u.webauthn = u.webauthn || { credentials: [] };
  if (u.webauthn.credentials.some((c) => c.id === cred.id)) throw new Error('passkey already registered');
  u.webauthn.credentials.push(cred); save(d); return cred;
}
function updatePasskeyCounter(username, credId, counter) {
  const d = load(); const u = d.users[username]; if (!u || !u.webauthn) return;
  const c = u.webauthn.credentials.find((x) => x.id === credId); if (c) { c.counter = counter; c.last_used = Date.now(); save(d); }
}
function removePasskey(username, credId) {
  const d = load(); const u = d.users[username]; if (!u || !u.webauthn) return false;
  const before = u.webauthn.credentials.length;
  u.webauthn.credentials = u.webauthn.credentials.filter((c) => c.id !== credId);
  save(d); return u.webauthn.credentials.length < before;
}
// ── external identity links (OIDC client: log in via GitHub/Google mapped to a local account) ──
function linkExternal(username, provider, subject, email) {
  const d = load(); const u = d.users[username]; if (!u) throw new Error('no such account');
  u.external = (u.external || []).filter((e) => e.provider !== provider); // one link per provider
  u.external.push({ provider, subject: String(subject), email: email || null, linked_at: Date.now() });
  save(d); return true;
}
function unlinkExternal(username, provider) {
  const d = load(); const u = d.users[username]; if (!u || !u.external) return false;
  const before = u.external.length; u.external = u.external.filter((e) => e.provider !== provider);
  save(d); return u.external.length < before;
}
function listExternal(username) { const u = load().users[username]; return ((u && u.external) || []).map((e) => ({ provider: e.provider, email: e.email })); }
/** Find the account linked to an external (provider, subject) — for external login → session. */
function findByExternal(provider, subject) {
  const d = load();
  for (const [username, u] of Object.entries(d.users)) {
    if (u.external && u.external.some((e) => e.provider === provider && e.subject === String(subject))) return username;
  }
  return null;
}

/** Which account owns a credential id — for usernameless (discoverable) passkey login. */
function findPasskeyOwner(credId) {
  const d = load();
  for (const [username, u] of Object.entries(d.users)) {
    if (u.webauthn && u.webauthn.credentials && u.webauthn.credentials.some((c) => c.id === credId)) return username;
  }
  return null;
}

// ── sessions (stateless, HMAC-signed) ──────────────────────────────────────────
const b64u = (b) => Buffer.from(b).toString('base64url');
function sign(payloadB64) { return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url'); }

function issueSession(username, ttl = SESSION_TTL, amr = ['pwd']) {
  const now = Math.floor(Date.now() / 1000);
  // amr = the factors this session actually presented ('pwd', 'totp', 'recovery', 'passkey').
  // Forward-auth rules with a two_factor policy read it; a token minted before amr existed is
  // treated as single-factor on verify, so old cookies degrade safely instead of over-granting.
  const list = Array.isArray(amr) && amr.length ? amr.map(String) : ['pwd'];
  const payload = b64u(JSON.stringify({ sub: username, iat: now, exp: now + ttl, amr: list, v: load().token_version || 1 }));
  return payload + '.' + sign(payload);
}

/** Verify a token → { sub } or null. Constant-time signature check; honors expiry + token version. */
function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expect = sign(payloadB64);
  const a = Buffer.from(sig || '', 'utf8'); const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch (_) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!p.exp || p.exp < now) return null;
  if ((p.v || 1) !== (load().token_version || 1)) return null; // global revoke
  return { sub: p.sub, amr: Array.isArray(p.amr) && p.amr.length ? p.amr : ['pwd'] };
}

/** Revoke every session (bump token version). */
function revokeAllSessions() { const d = load(); d.token_version = (d.token_version || 1) + 1; save(d); return d.token_version; }

// ── login rate-limiting (in-memory, per key) ───────────────────────────────────
const attempts = new Map(); // key -> { fails, until }
const MAX_FAILS = Number(process.env.ASMLTR_AUTH_MAX_FAILS || 8);
const LOCK_MS = Number(process.env.ASMLTR_AUTH_LOCK_MS || 15 * 60 * 1000);
function isLockedOut(key) { const a = attempts.get(key); return !!(a && a.until && a.until > Date.now()); }
function recordFail(key) { const a = attempts.get(key) || { fails: 0, until: 0 }; a.fails++; if (a.fails >= MAX_FAILS) { a.until = Date.now() + LOCK_MS; a.fails = 0; } attempts.set(key, a); }
function recordSuccess(key) { attempts.delete(key); }

// ── cookie helpers ──────────────────────────────────────────────────────────
// ASMLTR_AUTH_COOKIE_DOMAIN (e.g. `.example.com`) scopes the session cookie to a PARENT domain so a
// single login covers every subdomain — the basis for forward-auth gating other services (phase E).
const cookieDomain = () => (process.env.ASMLTR_AUTH_COOKIE_DOMAIN ? `; Domain=${process.env.ASMLTR_AUTH_COOKIE_DOMAIN}` : '');
function sessionCookie(token, { secure = true } = {}) {
  const attrs = [`${COOKIE}=${token}`, 'HttpOnly', 'Path=/', `Max-Age=${SESSION_TTL}`, 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ') + cookieDomain();
}
function clearCookie() { return `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax` + cookieDomain(); }
function tokenFromReq(req) {
  const auth = req.headers['authorization'];
  if (auth && /^Bearer /i.test(auth)) return auth.replace(/^Bearer /i, '').trim();
  const cookie = req.headers['cookie'] || '';
  const m = cookie.split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE);
  return m ? decodeURIComponent(m.slice(1).join('=')) : null;
}

/** Express middleware. No-op while disabled; otherwise requires a valid session or 401. */
function requireAuth(req, res, next) {
  if (!enabled()) return next();
  const s = verifySession(tokenFromReq(req));
  if (!s) return res.status(401).json({ error: 'authentication required' });
  req.authUser = s.sub;
  next();
}

/** Does this account require a second factor at login? */
function totpEnabledFor(username) { return totpEnabled(username); }
/** Check a login's second factor: a valid TOTP OR a one-time recovery code. */
function verifySecondFactor(username, code) {
  const u = load().users[username];
  if (!u || !u.totp || !u.totp.enabled) return true; // no 2FA on this account
  if (verifyTotpCode(u.totp.secret, code)) return true;
  return verifyRecoveryCode(username, code);
}

// ── group membership (for forward-auth `group:` rules) ─────────────────────────
// Groups are optional metadata on an account; they exist so access rules ported from an external
// directory can keep expressing "this team" instead of enumerating users. No group = [].
function groupsFor(username) {
  const u = load().users[username];
  return u && Array.isArray(u.groups) ? u.groups.map(String) : [];
}
function setGroups(username, groups) {
  const d = load();
  if (!d.users[username]) throw new Error('no such account: ' + username);
  d.users[username].groups = Array.isArray(groups) ? groups.map(String) : [];
  save(d);
  return { username, groups: d.users[username].groups };
}

module.exports = {
  enabled, hasAccount, listUsers, createAccount, setPassword, verifyPassword,
  issueSession, verifySession, revokeAllSessions,
  isLockedOut, recordFail, recordSuccess,
  sessionCookie, clearCookie, tokenFromReq, requireAuth,
  groupsFor, setGroups,
  totpEnabledFor, verifySecondFactor, totpBeginEnroll, totpConfirmEnroll, totpDisable,
  accountExists, listPasskeys, passkeysEnabled, addPasskey, updatePasskeyCounter, removePasskey, findPasskeyOwner,
  linkExternal, unlinkExternal, listExternal, findByExternal,
  COOKIE, SESSION_TTL,
};
