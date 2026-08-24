'use strict';

function isTrustWrite(method, pathname) {
  if (!pathname || !pathname.startsWith('/trust/')) return false;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (method === 'POST' && (pathname === '/trust/resolve' || pathname === '/trust/resolve/')) return false;
  return method === 'POST' || method === 'PATCH' || method === 'DELETE';
}

function trustWriteAllowed({ authEnabled, session }) {
  if (!authEnabled) return { ok: true, breakGlass: true };
  if (!session) return { ok: false, status: 401, error: 'authentication required' };
  return { ok: true };
}

function requireTrustWrite(auth) {
  return (req, res, next) => {
    if (!isTrustWrite(req.method, req.path)) return next();
    const session = auth.verifySession(auth.tokenFromReq(req));
    const d = trustWriteAllowed({ authEnabled: auth.enabled(), session });
    if (!d.ok) return res.status(d.status).json({ error: d.error });
    if (session) req.authUser = session.sub;
    next();
  };
}

module.exports = { isTrustWrite, trustWriteAllowed, requireTrustWrite };
