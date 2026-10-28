'use strict';
/**
 * Live Claude Code sessions on this box, as peers.
 *
 * Claude Code 2.1.x gave sessions names, a status and mailboxes: a session can list its peers and
 * message one by name. asmltr already tracks claude sessions for telemetry through the claude-code
 * connector's hooks, but it does not know a session's peer name, whether it is working or idle, or
 * that it is addressable at all. So `asmltr ls` can miss a `claude --bg` session entirely, and a
 * human reading the dashboard has no idea another agent is mid-task in the next worktree.
 *
 * This reads the supported interface and nothing else. `claude agents --json` prints active sessions
 * as a JSON array and exits. What it deliberately does NOT touch (see issue #166):
 *
 *   - the per-session unix socket under /run/user/<uid>/cc-socks/, its key file, or `peerProtocol`.
 *     That is how SendMessage actually delivers, it is undocumented, and it is versioned with the
 *     CLI. Sending from asmltr has no supported entry point today.
 *   - ~/.claude/daemon/roster.json and the dispatch directory, for the same reason.
 *
 * Everything here degrades to an empty list. A box with no claude binary, a stopped daemon, or a
 * CLI whose output shape moved should cost `asmltr ls` a blank column, never an error.
 */

const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = Number(process.env.ASMLTR_CLAUDE_AGENTS_TIMEOUT_MS) || 5000;
const BIN = () => process.env.ASMLTR_CLAUDE_BIN || 'claude';

/**
 * One row, normalized. The CLI carries two overlapping fields for liveness: `status` (busy / idle,
 * absent on sessions that never reported) and `state` (working / blocked / ...). Keep both raw and
 * derive one boolean, rather than guessing which the caller wanted.
 */
function normalizeAgent(a) {
  if (!a || typeof a !== 'object') return null;
  const id = a.id || a.sessionId;
  if (!id) return null;
  const state = a.state == null ? null : String(a.state);
  const status = a.status == null ? null : String(a.status);
  return {
    id: String(id),
    session_id: a.sessionId ? String(a.sessionId) : null,
    pid: Number.isFinite(a.pid) ? a.pid : null,
    name: a.name ? String(a.name) : null,
    cwd: a.cwd ? String(a.cwd) : null,
    kind: a.kind ? String(a.kind) : null,          // background | interactive
    status,
    state,
    started_unix: Number.isFinite(a.startedAt) ? Math.floor(a.startedAt / 1000) : null,
    // "Is something happening in there right now." `blocked` means waiting on a human, which is the
    // case worth surfacing loudest, so it is not folded into busy.
    working: status === 'busy' || state === 'working',
    blocked: state === 'blocked',
  };
}

/** Parse the CLI's stdout. Tolerates the leading noise a wrapper or a warning line can add. */
function parseAgentsJson(stdout) {
  const text = String(stdout == null ? '' : stdout).trim();
  if (!text) return [];
  let raw;
  try { raw = JSON.parse(text); }
  catch (_) {
    // Fall back to the first well-formed array in the output rather than discarding everything
    // because something printed a banner first.
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try { raw = JSON.parse(text.slice(start, end + 1)); } catch (_) { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeAgent).filter(Boolean);
}

/**
 * List live Claude Code sessions. Never throws and never rejects: the reason it came back empty is
 * reported alongside so a caller can say "no claude CLI" instead of "no sessions".
 *
 * @param {object} [o]
 * @param {boolean} [o.all]    include completed background sessions
 * @param {string}  [o.cwd]    only sessions started under this directory
 * @returns {Promise<{agents: object[], ok: boolean, error: string|null}>}
 */
function listAgents(o = {}) {
  const args = ['agents', '--json'];
  if (o.all) args.push('--all');
  if (o.cwd) args.push('--cwd', o.cwd);
  return new Promise((resolve) => {
    let done = false;
    const finish = (agents, ok, error) => { if (!done) { done = true; resolve({ agents, ok, error: error || null }); } };
    let child;
    try {
      child = execFile(BIN(), args, { timeout: o.timeoutMs || DEFAULT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            const why = err.code === 'ENOENT' ? 'no claude binary on PATH'
              : err.killed ? `claude agents timed out after ${o.timeoutMs || DEFAULT_TIMEOUT_MS}ms`
              : err.message;
            // A non-zero exit still sometimes carries usable JSON (a warning plus the array), so try.
            const salvaged = parseAgentsJson(stdout);
            return finish(salvaged, salvaged.length > 0, salvaged.length ? null : why);
          }
          return finish(parseAgentsJson(stdout), true, null);
        });
    } catch (e) { return finish([], false, e.message); }
    if (child) child.on('error', (e) => finish([], false, e.code === 'ENOENT' ? 'no claude binary on PATH' : e.message));
  });
}

/**
 * Mark which peers asmltr already tracks, by session id. A row asmltr knows about is the same work
 * seen twice; a row it does not is the interesting one, because nothing in the dashboard mentions it.
 */
function tagKnown(agents, asmltrSessions = []) {
  const known = new Set();
  for (const s of asmltrSessions) {
    for (const v of [s.session_id, s.engine_session_id, s.key, s.conversation_key]) if (v) known.add(String(v));
  }
  return agents.map((a) => ({ ...a, tracked_by_asmltr: !!(a.session_id && known.has(a.session_id)) || known.has(a.id) }));
}

module.exports = { listAgents, parseAgentsJson, normalizeAgent, tagKnown, DEFAULT_TIMEOUT_MS };
