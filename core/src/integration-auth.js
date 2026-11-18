'use strict';
/**
 * Per-integration authorization.
 *
 * Authorization belongs ON the integration it authorizes, not on a page-level panel. Integrations
 * are not all Google — they are storage targets, DAV collections, transports, tool links — so a
 * single global consent pane would only ever fit one of them and would get messier with every
 * provider added. Each integration therefore reports its own auth state and runs its own flow.
 *
 * `provider` is a property of the integration's config, so a driver type can serve several
 * providers: a `mail` integration is Gmail-with-OAuth or IMAP-with-a-password depending on
 * `auth`, and `caldav` is SOGo or Google the same way.
 *
 * Google OAuth client credentials resolve from the VAULT first, then fall back to a credentials
 * file. The vault path is what makes the public-HTTPS redirect reachable: an operator can supply a
 * **Web** client without touching the filesystem, and a Web client plus a configured
 * ASMLTR_AUTH_ORIGIN is the only combination Google will redirect to over https.
 */
const fs = require('fs');
const crypto = require('crypto');
const google = require('../../shared/google-oauth');
const secrets = require('../../shared/secrets');
const vault = require('../../shared/vault');
const integrations = require('../../integrations/registry');

const CALLBACK_PATH = '/v2/integrations/google/callback';
const LOOPBACK = 'http://localhost:8080/';
const CLIENT_FILE = () => process.env.GOOGLE_OAUTH_CLIENT
  || '/root/.claude/skills/reminder-management/config/oauth-credentials.json';

const K_ID = 'google_oauth_client_id';
const K_SECRET = 'google_oauth_client_secret';
const K_TYPE = 'google_oauth_client_type';   // 'web' | 'installed'

const pending = new Map();                    // state -> { integration_id, account, mode, created }
const TTL_MS = 15 * 60 * 1000;
function sweep() { const n = Date.now(); for (const [k, v] of pending) if (n - v.created > TTL_MS) pending.delete(k); }
function origin() { return (process.env.ASMLTR_AUTH_ORIGIN || '').replace(/\/+$/, ''); }

/** Vault first (operator-supplied, can be a Web client), then the file. */
async function readClient() {
  const id = await secrets.get(K_ID).catch(() => null);
  const sec = await secrets.get(K_SECRET).catch(() => null);
  if (id && sec) {
    const t = (await secrets.get(K_TYPE).catch(() => null)) || 'installed';
    return { source: 'vault', type: t === 'web' ? 'web' : 'installed', client_id: id, client_secret: sec, redirect_uris: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CLIENT_FILE(), 'utf8'));
    const c = raw.web || raw.installed;
    if (!c || !c.client_id || !c.client_secret) return { source: null, type: null };
    return { source: 'file', type: raw.web ? 'web' : 'installed', client_id: c.client_id, client_secret: c.client_secret, redirect_uris: c.redirect_uris || [] };
  } catch (_) { return { source: null, type: null }; }
}

/** Store/replace the OAuth client from the GUI so the redirect path becomes reachable. */
async function saveClient({ client_id, client_secret, client_type = 'web' }) {
  if (!client_id || !client_secret) throw new Error('client_id and client_secret are required');
  if (!['web', 'installed'].includes(client_type)) throw new Error("client_type must be 'web' or 'installed'");
  await vault.storeSecret(K_ID, { value: String(client_id).trim() });
  await vault.storeSecret(K_SECRET, { value: String(client_secret).trim() });
  await vault.storeSecret(K_TYPE, { value: client_type });
  secrets.clearCache();
  return { saved: true, client_type };
}

/** The email address inside a config value or an integration name, lowercased. */
function emailOf(v) {
  const m = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.exec(String(v || ''));
  return m ? m[0].toLowerCase() : null;
}

function needsOAuth(it) { return !!it && (it.config || {}).auth === 'oauth2'; }

/** Has this integration actually got a usable refresh token? */
async function authorized(it) {
  const ref = (it.config || {}).refresh_token_ref;
  if (!ref) return false;
  const v = await secrets.get(ref).catch(() => null);
  return !!v;
}

/**
 * Remaining life of the grant, straight from Google. A consent screen in "Testing" issues refresh
 * tokens that expire in 7 DAYS, and that cannot be extended by refreshing — the exchange returns a
 * new access token only. Surfacing the countdown is the difference between a scheduled two-minute
 * re-authorize and discovering months later that nothing has worked, which is how the Tasks grant
 * died. Returns null when it cannot be determined; never throws, since this is only decoration.
 */
async function grantLife(it) {
  try {
    const cfg = it.config || {};
    if (!cfg.refresh_token_ref) return null;
    const [refresh_token, client_id, client_secret] = await Promise.all([
      secrets.get(cfg.refresh_token_ref), secrets.get(K_ID), secrets.get(K_SECRET),
    ]);
    if (!refresh_token || !client_id || !client_secret) return null;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) return { alive: false, error: j.error || `HTTP ${res.status}` };
    const secs = Number(j.refresh_token_expires_in);
    return { alive: true, days_left: Number.isFinite(secs) ? Number((secs / 86400).toFixed(2)) : null };
  } catch (_) { return null; }
}

/**
 * Per-integration auth state. `mode` is a fact about the Google client, surfaced BEFORE the
 * operator starts anything so a wizard never dead-ends.
 */
async function state(id) {
  const it = integrations.get(id);
  if (!it) { const e = new Error('integration not found'); e.status = 404; throw e; }
  if (!needsOAuth(it)) {
    return { integration_id: id, type: it.type, required: false, authorized: true, provider: 'password',
             note: 'This integration authenticates with a stored credential; no authorization flow is needed.' };
  }
  const c = await readClient();
  const org = origin();
  const isAuthed = await authorized(it);
  const life = isAuthed ? await grantLife(it) : null;
  const base = { integration_id: id, type: it.type, required: true, authorized: isAuthed, provider: 'google', scopes: google.scopeList(),
    ...(life ? { grant: life } : {}) };

  if (!c.type) {
    return { ...base, mode: 'needs_client', ready: false,
      reason: 'No Google OAuth client is configured.',
      callback_url: org ? org + CALLBACK_PATH : null,
      how_to_fix: [
        'In Google Cloud Console → APIs & Services → Credentials, create an OAuth client.',
        org ? `Choose "Web application" and add this Authorised redirect URI: ${org}${CALLBACK_PATH}`
            : 'Choose "Web application" if this asmltr has a public URL, otherwise "Desktop app".',
        'Paste the client ID and secret into this card — they are stored in the vault, not on disk.',
      ] };
  }
  if (c.type === 'web' && org) {
    const cb = org + CALLBACK_PATH;
    const registered = !c.redirect_uris.length || c.redirect_uris.some((u) => u.replace(/\/+$/, '') === cb.replace(/\/+$/, ''));
    return { ...base, mode: 'redirect', ready: true, client_type: c.type, client_source: c.source, callback_url: cb,
      ...(registered ? {} : { warning: `Add ${cb} to the client's Authorised redirect URIs, or Google answers redirect_uri_mismatch at the end of consent.` }) };
  }
  if (c.type === 'web' && !org) {
    return { ...base, mode: 'paste', ready: true, client_type: c.type, client_source: c.source, callback_url: LOOPBACK,
      reason: 'A Web client is configured but this asmltr has no public URL (ASMLTR_AUTH_ORIGIN), so there is nowhere for Google to redirect back to.',
      how_to_fix: [`Set ASMLTR_AUTH_ORIGIN and register ${CALLBACK_PATH} on the client to turn this into a one-click redirect.`] };
  }
  return { ...base, mode: 'paste', ready: true, client_type: c.type, client_source: c.source, callback_url: LOOPBACK,
    reason: 'The configured Google client is a Desktop ("installed") client, and Google only permits loopback redirect URIs for that client type — so a public https callback cannot be used with it.',
    how_to_fix: [`For one-click consent, create a "Web application" client and paste it into this card; the callback would then be ${org ? org + CALLBACK_PATH : '<set ASMLTR_AUTH_ORIGIN first>'}.`] };
}

async function start(id) {
  const st = await state(id);
  if (!st.required) throw new Error('this integration does not use OAuth');
  if (!st.ready) { const e = new Error(st.reason); e.status = 409; e.detail = st; throw e; }
  const it = integrations.get(id);
  const account = (it.config || {}).email_address
    || (await secrets.get((it.config || {}).user_ref).catch(() => null))
    || (await secrets.get((it.config || {}).username_ref).catch(() => null));
  const c = await readClient();
  const s = crypto.randomBytes(16).toString('hex');
  sweep();
  pending.set(s, { integration_id: id, account, mode: st.mode, created: Date.now() });
  return { state: s, mode: st.mode, account, callback_url: st.callback_url,
    auth_url: google.authUrl({ client_id: c.client_id, redirect_uri: st.mode === 'redirect' ? st.callback_url : LOOPBACK, login_hint: account || undefined, state: s }),
    ...(st.mode === 'paste' ? { instructions: 'Approve in the browser. The page it lands on WILL FAIL TO LOAD — that is expected. Copy the whole address-bar URL and paste it back here.' } : {}) };
}

function codeFrom(input) {
  const v = String(input || '').trim();
  if (!v) throw new Error('code is required');
  const m = /[?&]code=([^&\s]+)/.exec(v);
  return m ? decodeURIComponent(m[1]) : v;
}

/**
 * Finish consent for ONE integration. Sibling integrations on the same account are updated too —
 * one Google grant covers mail, calendar and contacts, so authorizing any of them authorizes all,
 * and pretending otherwise would make the operator consent three times for one grant.
 */
async function complete({ state: s, code, integration_id }) {
  sweep();
  const p = s ? pending.get(s) : null;
  const id = (p && p.integration_id) || integration_id;
  if (!id) throw new Error('unknown or expired authorization — start it again from the card');
  const it = integrations.get(id);
  if (!it) throw new Error('integration not found');
  const c = await readClient();
  if (!c.type) throw new Error('no Google OAuth client configured');
  const mode = (p && p.mode) || (await state(id)).mode;
  const redirect_uri = mode === 'redirect' ? origin() + CALLBACK_PATH : LOOPBACK;

  const { refresh_token, scope } = await google.exchangeCode({
    client_id: c.client_id, client_secret: c.client_secret, code: codeFrom(code), redirect_uri,
  });
  if (s) pending.delete(s);

  const account = (p && p.account) || (it.config || {}).email_address || it.name;
  const slug = 'google_' + String(account).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const refKey = slug + '_refresh_token';
  await vault.storeSecret(refKey, { value: refresh_token });
  await vault.storeSecret(K_ID, { value: c.client_id });
  await vault.storeSecret(K_SECRET, { value: c.client_secret });
  secrets.clearCache();

  const patch = { auth: 'oauth2', refresh_token_ref: refKey, oauth_client_id_ref: K_ID, oauth_client_secret_ref: K_SECRET };
  const touched = [];
  const want = emailOf(account);
  for (const sib of integrations.list()) {
    const cfg = sib.config || {};
    if (cfg.auth !== 'oauth2') continue;
    // EXACT address match. Substring matching here would cross-wire credentials: authorizing
    // a@gmail.com also matches aa@gmail.com, which would silently stamp the wrong account's
    // integrations with this refresh token. An address is an identity, so compare it as one.
    if (emailOf(cfg.email_address || sib.name) !== want) continue;
    integrations.update(sib.id, { config: { ...cfg, ...patch } });
    touched.push({ id: sib.id, type: sib.type, name: sib.name });
  }
  return { account, granted_scopes: String(scope || '').split(' ').filter(Boolean), authorized: touched };
}

module.exports = { state, start, complete, saveClient, readClient, needsOAuth, emailOf, CALLBACK_PATH };
