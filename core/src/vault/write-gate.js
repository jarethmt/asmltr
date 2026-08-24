'use strict';

function isVaultWrite(method, pathname) {
  const p = String(pathname || '');
  if (p === '/v2/vault/unseal' && method === 'POST') return true;
  if ((p === '/v2/vault/secrets' || p === '/v2/vault/secrets/') && (method === 'GET' || method === 'POST')) return true;
  if (p.startsWith('/v2/vault/secrets/') && p !== '/v2/vault/secrets' && (method === 'DELETE' || method === 'GET' || method === 'POST' || method === 'PATCH')) return true;
  return false;
}

function vaultWriteAllowed({ authEnabled, session }) {
  if (!authEnabled) return { ok: true, breakGlass: true };
  if (!session) return { ok: false, status: 401, error: 'authentication required' };
  return { ok: true };
}

function requireVaultWrite(auth) {
  return (req, res, next) => {
    if (!isVaultWrite(req.method, req.path)) return next();
    const session = auth.verifySession(auth.tokenFromReq(req));
    const d = vaultWriteAllowed({ authEnabled: auth.enabled(), session });
    if (!d.ok) return res.status(d.status).json({ error: d.error });
    if (session) req.authUser = session.sub;
    next();
  };
}

module.exports = { isVaultWrite, vaultWriteAllowed, requireVaultWrite };
