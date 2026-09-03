'use strict';
/**
 * V16: MCP OAuth approve + consent require an existing operator web session
 * (ASMLTR_AUTH). Do not CORS * those paths. Re-check redirect_uri on approve.
 * /mcp and ask_oracle stay cookie-free.
 */

function corsAllowOrigin(pathname) {
  if (pathname === '/oauth/approve' || pathname === '/oauth/authorize') return null;
  return '*';
}

function authVerifyUrl(coreHandleUrl) {
  const raw = coreHandleUrl || 'http://127.0.0.1:3023/v2/handle';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/v2/auth/verify`;
  } catch {
    return 'http://127.0.0.1:3023/v2/auth/verify';
  }
}

async function sessionOkFromVerify(fetchImpl, url, cookie) {
  try {
    const r = await fetchImpl(url, { method: 'GET', headers: { cookie: cookie || '' } });
    return r.status === 200;
  } catch {
    return false;
  }
}

function approveDecision({ sessionOk, approved, client, redirectUri, isRedirectUriAllowed }) {
  if (!sessionOk) {
    return { ok: false, status: 401, error: 'authentication required', error_description: 'operator web session required' };
  }
  if (!approved) {
    return { ok: false, status: 400, error: 'access_denied', error_description: 'User denied authorization' };
  }
  if (typeof isRedirectUriAllowed !== 'function' || !isRedirectUriAllowed(client, redirectUri)) {
    return { ok: false, status: 400, error: 'invalid_request', error_description: 'Invalid redirect_uri' };
  }
  return { ok: true };
}

module.exports = { corsAllowOrigin, authVerifyUrl, sessionOkFromVerify, approveDecision };
