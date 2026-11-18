'use strict';
/**
 * Google OAuth2 for integrations — refresh-token grant only.
 *
 * Access tokens last an hour, so NOTHING stores one. An integration stores the long-lived
 * **refresh token** as a vault ref and mints a fresh access token at open time. That keeps the
 * `*_ref` rule intact (a vault key name, never a value) and means a token expiring mid-session
 * is a non-event.
 *
 * One Google grant covers mail, calendar, contacts and tasks together, which is why the same
 * credential serves a `mail` integration and future `caldav`/`carddav` ones — and why revoking
 * it revokes all of them. Scopes are listed here so the consent screen and the drivers cannot
 * drift apart.
 */
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** The grant we ask for. CalDAV/CardDAV are standard protocols — no Google-specific API needed. */
const SCOPES = {
  mail:     'https://mail.google.com/',
  calendar: 'https://www.googleapis.com/auth/calendar',
  contacts: 'https://www.googleapis.com/auth/carddav',
  tasks:    'https://www.googleapis.com/auth/tasks',
};

function scopeList(which = Object.keys(SCOPES)) {
  return which.map((k) => SCOPES[k] || k).join(' ');
}

/** Consent URL for the installed-app flow. `redirect_uri` must match the client registration. */
function authUrl({ client_id, redirect_uri = 'http://127.0.0.1:8765', scopes, login_hint } = {}) {
  if (!client_id) throw new Error('google-oauth: client_id required');
  const p = new URLSearchParams({
    client_id, redirect_uri, response_type: 'code',
    scope: scopes || scopeList(),
    access_type: 'offline',     // we need a refresh token
    prompt: 'consent',          // force it, or Google omits refresh_token on re-consent
    include_granted_scopes: 'true',
  });
  if (login_hint) p.set('login_hint', login_hint);
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

async function post(body) {
  const r = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`google-oauth: ${r.status} ${j.error || ''} ${j.error_description || ''}`.trim());
  return j;
}

/** One-time: authorization code → refresh token. */
async function exchangeCode({ client_id, client_secret, code, redirect_uri = 'http://127.0.0.1:8765' }) {
  const j = await post({ client_id, client_secret, code, redirect_uri, grant_type: 'authorization_code' });
  if (!j.refresh_token) {
    throw new Error('google-oauth: no refresh_token returned — re-run consent with prompt=consent and access_type=offline');
  }
  return { refresh_token: j.refresh_token, access_token: j.access_token, scope: j.scope, expires_in: j.expires_in };
}

/** Every open: refresh token → a fresh access token. */
async function accessToken({ client_id, client_secret, refresh_token }) {
  if (!refresh_token) throw new Error('google-oauth: refresh_token required');
  const j = await post({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' });
  return { access_token: j.access_token, expires_in: j.expires_in, scope: j.scope };
}

module.exports = { SCOPES, scopeList, authUrl, exchangeCode, accessToken, TOKEN_URI };
