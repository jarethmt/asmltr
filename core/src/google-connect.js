'use strict';
/**
 * Google account connect flow, driven from the dashboard.
 *
 * One consent yields mail + calendar + contacts + tasks, so completing it creates THREE
 * integrations at once (mail, caldav, carddav) sharing a single refresh token. Revoking the grant
 * revokes all of them, which is the honest representation of what Google actually gives you.
 *
 * There are three possible modes, and which one applies is a fact about the operator's Google
 * client — not something to paper over:
 *
 *   redirect   A **Web** OAuth client plus a configured public origin (ASMLTR_AUTH_ORIGIN). The
 *              browser returns straight to us and the flow completes without the operator copying
 *              anything. This is the good path.
 *   paste      An **installed/Desktop** client. Google REFUSES non-loopback redirect URIs for this
 *              client type, so a public https callback is impossible no matter what origin is
 *              configured. The consent link still works; it lands on a dead loopback page and the
 *              operator pastes the code back. Fully usable, one extra step.
 *   disabled   No usable client at all. OAuth is offered but cannot run, and the UI says exactly
 *              what to create rather than failing at the end of a wizard.
 */
const fs = require('fs');
const crypto = require('crypto');
const google = require('../../shared/google-oauth');
const vault = require('../../shared/vault');
const integrations = require('../../integrations/registry');

const CALLBACK_PATH = '/v2/integrations/google/callback';
const LOOPBACK = 'http://localhost:8080/';
const CLIENT_FILE = () => process.env.GOOGLE_OAUTH_CLIENT
  || '/root/.claude/skills/reminder-management/config/oauth-credentials.json';

const pending = new Map();                       // state -> { account, created }
const TTL_MS = 15 * 60 * 1000;
function sweep() { const now = Date.now(); for (const [k, v] of pending) if (now - v.created > TTL_MS) pending.delete(k); }

function origin() { return (process.env.ASMLTR_AUTH_ORIGIN || '').replace(/\/+$/, ''); }

function readClient() {
  try {
    const raw = JSON.parse(fs.readFileSync(CLIENT_FILE(), 'utf8'));
    const type = raw.web ? 'web' : (raw.installed ? 'installed' : null);
    const c = raw.web || raw.installed;
    if (!c || !c.client_id || !c.client_secret) return { type: null };
    return { type, client_id: c.client_id, client_secret: c.client_secret, redirect_uris: c.redirect_uris || [] };
  } catch (_) { return { type: null }; }
}

/** What the UI needs to render the right thing before asking for anything. */
function status() {
  const c = readClient();
  const org = origin();
  const scopes = google.scopeList();
  if (!c.type) {
    return {
      mode: 'disabled', ready: false, scopes,
      reason: 'No Google OAuth client is configured.',
      how_to_fix: [
        'In Google Cloud Console → APIs & Services → Credentials, create an OAuth client.',
        org ? `Choose "Web application" and add this Authorised redirect URI: ${org}${CALLBACK_PATH}`
            : 'Choose "Web application" if asmltr has a public URL, otherwise "Desktop app".',
        'Download the JSON and point GOOGLE_OAUTH_CLIENT at it (or place it at the default path).',
      ],
    };
  }
  if (c.type === 'web') {
    if (!org) {
      return {
        mode: 'paste', ready: true, scopes, client_type: c.type, callback_url: LOOPBACK,
        reason: 'A Web client is configured but ASMLTR_AUTH_ORIGIN is not set, so there is no public URL to return to.',
        how_to_fix: [`Set ASMLTR_AUTH_ORIGIN to asmltr's public URL and add ${CALLBACK_PATH} to the client's Authorised redirect URIs — then this becomes a one-click redirect.`],
      };
    }
    const cb = org + CALLBACK_PATH;
    const registered = (c.redirect_uris || []).some((u) => u.replace(/\/+$/, '') === cb.replace(/\/+$/, ''));
    return {
      mode: 'redirect', ready: true, scopes, client_type: c.type, callback_url: cb,
      redirect_uri_registered: registered,
      ...(registered ? {} : { warning: `Add ${cb} to the client's Authorised redirect URIs in Google Cloud Console, or Google will reject the consent with redirect_uri_mismatch.` }),
    };
  }
  // installed / Desktop
  return {
    mode: 'paste', ready: true, scopes, client_type: c.type, callback_url: LOOPBACK,
    reason: 'The configured Google client is a Desktop ("installed") client. Google only permits loopback redirect URIs for that client type, so a public https callback cannot be used — the configured origin is ignored by Google here, not by us.',
    how_to_fix: [`To get a one-click redirect instead, create a "Web application" client and add ${origin() || '<asmltr public URL>'}${CALLBACK_PATH} to its Authorised redirect URIs.`],
  };
}

/** Begin consent. Returns the URL to open plus the state to hand back. */
function start({ account } = {}) {
  if (!account) throw new Error('account (email address) is required');
  const s = status();
  if (!s.ready) { const e = new Error(s.reason); e.status = 409; e.detail = s; throw e; }
  const c = readClient();
  const state = crypto.randomBytes(16).toString('hex');
  sweep();
  pending.set(state, { account, created: Date.now(), mode: s.mode });
  return {
    mode: s.mode, state, account, callback_url: s.callback_url,
    auth_url: google.authUrl({
      client_id: c.client_id,
      redirect_uri: s.mode === 'redirect' ? s.callback_url : LOOPBACK,
      login_hint: account,
    }),
    ...(s.mode === 'paste' ? { instructions: 'Approve in the browser. The page it lands on will FAIL TO LOAD — that is expected. Copy the whole address-bar URL (or just the code=… value) and paste it back here.' } : {}),
  };
}

function codeFrom(input) {
  const v = String(input || '').trim();
  if (!v) throw new Error('code is required');
  const m = /[?&]code=([^&\s]+)/.exec(v);
  return m ? decodeURIComponent(m[1]) : v;
}

/**
 * Finish consent: exchange the code, store the refresh token in the vault, and create the mail +
 * caldav + carddav integrations that share it.
 */
async function complete({ state, code, account: accountArg }) {
  sweep();
  const p = state ? pending.get(state) : null;
  const account = (p && p.account) || accountArg;
  if (!account) throw new Error('unknown or expired state, and no account supplied');
  const c = readClient();
  if (!c.type) throw new Error('no Google OAuth client configured');
  const mode = (p && p.mode) || status().mode;
  const redirect_uri = mode === 'redirect' ? origin() + CALLBACK_PATH : LOOPBACK;

  const { refresh_token, scope } = await google.exchangeCode({
    client_id: c.client_id, client_secret: c.client_secret, code: codeFrom(code), redirect_uri,
  });
  if (state) pending.delete(state);

  const slug = 'google_' + account.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const refKey = slug + '_refresh_token';
  const addrKey = slug + '_address';
  const idKey = 'google_oauth_client_id';
  const secKey = 'google_oauth_client_secret';
  for (const [k, v] of [[refKey, refresh_token], [addrKey, account], [idKey, c.client_id], [secKey, c.client_secret]]) {
    await vault.storeSecret(k, { value: v });
  }

  const common = { auth: 'oauth2', refresh_token_ref: refKey, oauth_client_id_ref: idKey, oauth_client_secret_ref: secKey };
  const made = [];
  made.push(integrations.create({
    type: 'mail', kind: 'tools', lifecycle: 'passive', name: account + ' mail',
    config: { ...common, imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 587, email_address: account, user_ref: addrKey },
  }));
  made.push(integrations.create({
    type: 'caldav', kind: 'tools', lifecycle: 'passive', name: account + ' calendar',
    config: { ...common, base_url: `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(account)}/`, username_ref: addrKey },
  }));
  made.push(integrations.create({
    type: 'carddav', kind: 'tools', lifecycle: 'passive', name: account + ' contacts',
    config: { ...common, base_url: `https://www.googleapis.com/carddav/v1/principals/${encodeURIComponent(account)}/lists/default/`, username_ref: addrKey },
  }));
  return { account, granted_scopes: String(scope || '').split(' ').filter(Boolean), integrations: made.map((m) => ({ id: m.id, type: m.type, name: m.name })) };
}

module.exports = { status, start, complete, CALLBACK_PATH };
