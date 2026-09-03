'use strict';
/**
 * Engine dispatch — maps an engine id to its implementation, loaded LAZILY so the core only pulls in
 * the code (and heavy deps, like the Claude SDK) for engines it actually runs. A Gemini-only or
 * Codex-only install therefore never loads the Claude SDK.
 *
 * Every engine implements the same contract:
 *   runTurn(opts) → { text, segments, engineSessionId, tools, usage, isError }
 *   complete({prompt, model}) → string        (cheap one-shot for the title/status/assessment labelers)
 *   cheapModel : string                       (default model for the labelers)
 *   getLastModel() → string|null
 *
 * Extra opts (images, mediaFiles, denyTools, attachChannel, attachTarget, …) are
 * ignored by engines that do not read them. Vision is per-engine, not in this
 * dispatcher: Claude uses SDK image blocks; Grok uses ACP `--prompt-file`.
 * Gemini/Codex: no vision serialize yet — wire `images`/`mediaFiles` in those
 * adapters when someone adds it (see comments in gemini.js / codex.js).
 */
const registry = require('../../../shared/engines');
const CACHE = {};

function get(id) {
  const key = registry.known(id) ? id : 'claude';
  if (!CACHE[key]) {
    if (key === 'gemini') CACHE[key] = require('./gemini');
    else if (key === 'codex') CACHE[key] = require('./codex');
    else if (key === 'grok') CACHE[key] = require('./grok');
    else CACHE[key] = require('./claude');
  }
  return CACHE[key];
}

/** The engine a turn should run on: explicit override → the configured default. */
function resolve(engineId) { return get(engineId || registry.getDefault()); }

// A resumed session can VANISH under us. Claude Code prunes its transcript files after a retention
// window (~/.claude/projects/<slug>/<uuid>.jsonl), and codex expires threads server-side — but the
// core stores engine_session_id forever under the default idle_policy 'infinite'. Resuming a pruned
// id fails the turn, and since ids are only persisted on SUCCESS the dead id is never cleared, so the
// conversation is wedged permanently. Each engine words it differently:
//   claude → "Claude Code returned an error result: No conversation found with session ID: <uuid>"
//   codex  → "thread not found: <id>"
//   gemini → n/a (it mints its own resume id, so it has no dead-resume failure mode)
// Match narrowly: a false positive silently restarts a live conversation from scratch.
const MISSING_SESSION = /(no conversation found with session id|(?:thread|session|conversation)\s+not\s+found|no such (?:thread|session|conversation))/i;

/** True when `err` means "the session you asked me to resume does not exist" (→ retry fresh). */
function isMissingSessionError(err) {
  if (!err) return false;
  return MISSING_SESSION.test(typeof err === 'string' ? err : String(err.message || ''));
}

module.exports = { get, resolve, isMissingSessionError };
