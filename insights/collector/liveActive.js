'use strict';
/**
 * Live-active = stored status=active AND not a no-pid row past idle.
 * Idle is a nap cutoff for the Live list (?active=1), not a process kill.
 * ASMLTR_IDLE_MS / DEFAULT_IDLE_MS 1800000 (30 min). Not grok session idle.
 * Pid-backed rows stay live until reconcile ends them (pid dead).
 */

const DEFAULT_IDLE_MS = 1_800_000;

function idleMsFromEnv(env = process.env) {
  const n = Number(env.ASMLTR_IDLE_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_MS;
}

/** Collector timestamps are unix ms; tolerate accidental seconds. */
function activityMs(unix) {
  if (!unix) return 0;
  return unix < 1e12 ? unix * 1000 : unix;
}

/**
 * True when this row belongs on Live / GET ?active=1.
 * No pid + last_activity older than idle → not live (web rows pile up otherwise).
 */
function isLiveActive(session, now = Date.now(), idleMs = idleMsFromEnv()) {
  if (!session || session.status !== 'active') return false;
  if (session.pid) return true;
  const last = activityMs(session.last_activity_unix);
  if (!last) return true;
  if (idleMs > 0 && now - last > idleMs) return false;
  return true;
}

module.exports = { DEFAULT_IDLE_MS, idleMsFromEnv, activityMs, isLiveActive };
