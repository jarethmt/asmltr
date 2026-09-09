'use strict';
/**
 * V37: /v2/schedules is owner-session only when AUTH is on.
 * Unauthenticated CRUD could create full-trust prompt jobs or steal Discord keys.
 */

function isScheduleApi(method, pathname) {
  const p = String(pathname || '');
  if (p === '/v2/schedules' || p === '/v2/schedules/') return true;
  if (p.startsWith('/v2/schedules/')) return true;
  return false;
}

function scheduleApiAllowed({ authEnabled, session }) {
  if (!authEnabled) return { ok: true, breakGlass: true };
  if (!session) return { ok: false, status: 401, error: 'authentication required' };
  return { ok: true };
}

function requireScheduleApi(auth) {
  return (req, res, next) => {
    if (!isScheduleApi(req.method, req.path)) return next();
    const session = auth.verifySession(auth.tokenFromReq(req));
    const d = scheduleApiAllowed({ authEnabled: auth.enabled(), session });
    if (!d.ok) return res.status(d.status).json({ error: d.error });
    if (session) req.authUser = session.sub;
    next();
  };
}

module.exports = { isScheduleApi, scheduleApiAllowed, requireScheduleApi };
