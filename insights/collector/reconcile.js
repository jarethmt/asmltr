'use strict';
/**
 * asmltr-insights — session reconciler (plan §B3).
 *
 * The host session tracker (ASMLTR_TRACKER_PATH) stays the SOURCE OF TRUTH for
 * Claude Code session liveness (driven by the host hooks).
 * We MIRROR it into the sessions table — never write back — and apply a
 * LIVENESS CORRECTION: if a row says status=active but its pid is dead, we
 * record it as ended. That's what makes the dashboard's instance count honest
 * (the file is known to carry stale-active entries).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Tracker sources to mirror. Each entry becomes a session row. A source sets the
// DEFAULTS for its entries (fields on the entry itself win). Both are optional.
//  - ASMLTR_TRACKER_PATH: the host hook tracker — screen-based, one identity.
//  - ASMLTR_CLI_TRACKER_PATH: `asmltr claude` wrapped sessions — tmux, per-entry identity.
const TRACKER_PATH = process.env.ASMLTR_TRACKER_PATH || '';
const CLI_TRACKER_PATH = process.env.ASMLTR_CLI_TRACKER_PATH || path.join(os.homedir(), '.asmltr', 'cli-sessions.json');
const HOOK_IDENTITY = process.env.ASMLTR_TRACKER_IDENTITY || 'cli';

const SOURCES = [
  { path: TRACKER_PATH, defaults: { surface: 'claude-code', identity: HOOK_IDENTITY, multiplexer: 'screen' } },
  { path: CLI_TRACKER_PATH, defaults: { surface: 'claude-code', identity: HOOK_IDENTITY, multiplexer: 'tmux' } },
];

/** Is this pid alive? signal 0 = existence check. */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; } // EPERM => exists but not ours
}

function toMs(t) { return t ? t * (t < 1e12 ? 1000 : 1) : null; }

/** Mirror one tracker source's sessions into the table. Returns rows upserted. */
function reconcileSource(db, src) {
  if (!src.path) return 0;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(src.path, 'utf8')); }
  catch (_) { return 0; } // absent/unparseable → nothing to mirror
  const list = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  let n = 0;
  for (const s of list) {
    const pid = s.current_pid || s.pid || null;
    let status = s.status || 'active';
    if (status === 'active' && !pidAlive(pid)) status = 'ended'; // LIVENESS CORRECTION
    db.reconcileUpsert({
      sid: String(s.session_id),
      surface: s.surface || src.defaults.surface,
      kind: s.kind || 'ephemeral',
      pid: pid || null,
      identity: s.identity || src.defaults.identity,
      context: s.context || null,
      working_dir: s.working_dir || s.cwd || null,
      task: s.task || null,
      status,
      started_unix: toMs(s.started_unix),
      last_activity_unix: toMs(s.last_activity_unix),
      tool_count: s.tool_count || 0,
      multiplexer: s.multiplexer || src.defaults.multiplexer,
      tmux_target: s.tmux_target || null,
      now: Date.now(),
    });
    n++;
  }
  return n;
}

/** Run one reconcile pass across all tracker sources. Returns rows upserted. */
function reconcileOnce(db) {
  let n = 0;
  for (const src of SOURCES) n += reconcileSource(db, src);
  return n;
}

/** Start periodic reconciliation. Returns a stop() function. */
function start(db, intervalMs, onPass) {
  const tick = () => {
    try {
      const n = reconcileOnce(db);
      if (onPass) onPass(n);
    } catch (err) {
      console.error('[reconcile] pass failed:', err.message);
    }
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

module.exports = { reconcileOnce, start, pidAlive, TRACKER_PATH };
