'use strict';
/**
 * A resumed engine session can VANISH under the core.
 *
 * Claude Code prunes its transcript files (~/.claude/projects/<slug>/<uuid>.jsonl) after a retention
 * window, but the core stores `engine_session_id` forever under the default `idle_policy = 'infinite'`.
 * A conversation left idle past that window therefore resumes an id the engine no longer knows, and
 * the SDK fails the turn with "No conversation found with session ID: <uuid>". Because ids are only
 * persisted on SUCCESS, the dead id is never cleared — so every later message to that conversation
 * fails identically and the conversation is wedged for good.
 *
 * These tests pin the two pieces of the recovery: RECOGNIZING that failure, and CLEARING the dead id
 * so the next turn starts a fresh session.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Node 24 + better-sqlite3: load stmt-keep BEFORE sessions opens a Database
// (same hook server.js loads first). Without it, Statement dtor at test exit ABRTs.
require('../core/src/sqlite-stmt-keep');

// Point the session store at a throwaway DB before it is required (it opens on import).
const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-sessions-')), 'core.db');
process.env.ASMLTR_CORE_DB = TMP_DB;

const engines = require('../core/src/engines');
const sessions = require('../core/src/sessions');

// Close the sqlite handle deterministically when the file's tests finish (good hygiene). NOTE: the
// actual CI crash — `Assertion failed: (env) != nullptr` in RemoveEnvironmentCleanupHook when
// better-sqlite3's native Statement finalizers run on process exit — is a Node 24.19.0 teardown
// REGRESSION (24.18.0 is fine), so closing the db doesn't prevent it; CI pins Node to 24.18.0 in
// .github/workflows/test.yml. This close stays as correct cleanup regardless.
after(() => { try { sessions.db.close(); } catch (_) {} });

// ── recognizing a vanished session ────────────────────────────────────────────
test('the exact claude SDK phrasing is recognized as a vanished session', () => {
  const err = new Error('Claude Code returned an error result: No conversation found with session ID: e981c9b8-53ab-4c7d-9f73-a63b8ba4535e');
  assert.equal(engines.isMissingSessionError(err), true);
});

test('codex + gemini resume phrasings are recognized too', () => {
  for (const msg of ['thread not found: 019a2b3c', 'error: session not found', 'No such session: abc']) {
    assert.equal(engines.isMissingSessionError(new Error(msg)), true, msg);
  }
});

test('a bare string (not an Error) is accepted', () => {
  assert.equal(engines.isMissingSessionError('No conversation found with session ID: x'), true);
});

test('unrelated turn failures are NOT treated as a vanished session', () => {
  // Every one of these has been seen in this install's error log. Retrying them as a FRESH session
  // would silently discard the conversation's history for a fault that has nothing to do with resume.
  const other = [
    "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
    "You've hit your session limit · resets 5:50pm (America/New_York)",
    'API Error: 529 Overloaded. This is a server-side issue, usually temporary',
    'Failed to spawn Claude Code process: spawn node EACCES',
    'request entity too large',
  ];
  for (const msg of other) {
    assert.equal(engines.isMissingSessionError(new Error(msg)), false, msg);
  }
  assert.equal(engines.isMissingSessionError(null), false);
  assert.equal(engines.isMissingSessionError(undefined), false);
});

// ── clearing the dead id ──────────────────────────────────────────────────────
test('clearEngineId drops the dead id so the next turn resumes nothing', () => {
  const key = 'discord:inst:dm:1';
  sessions.ensure(key, 'discord', 'infinite', '/home/someone');
  sessions.recordEngineId(key, 'dead-0000-0000');
  sessions.recordStable(key, 'stablehash', 'codex');
  assert.equal(sessions.resolveForTurn(key, 'discord').resume, 'dead-0000-0000');

  assert.equal(sessions.clearEngineId(key), true);

  assert.equal(sessions.resolveForTurn(key, 'discord').resume, null, 'next turn must start fresh');
  assert.equal(sessions.get(key).engine_session_id, null);
});

test('clearEngineId also drops the inject-once marker (a fresh session never got the stable block)', () => {
  const key = 'discord:inst:dm:2';
  sessions.ensure(key, 'discord');
  sessions.recordEngineId(key, 'dead-1111');
  sessions.recordStable(key, 'stablehash', 'codex');

  sessions.clearEngineId(key);

  const row = sessions.get(key);
  assert.equal(row.last_stable_hash, null, 'stale marker would skip re-sending the stable block on codex');
  assert.equal(row.last_stable_engine, null);
});

test('clearEngineId preserves the rest of the row (it is not a session delete)', () => {
  const key = 'telegram:inst:user:scoutg001';
  sessions.ensure(key, 'telegram', 'infinite', '/home/someone/work');
  sessions.recordEngineId(key, 'dead-2222');
  sessions.touch(key);
  sessions.setOutboundRoute(key, 'inst', '12345');

  sessions.clearEngineId(key);

  const row = sessions.get(key);
  assert.equal(row.working_dir, '/home/someone/work', 'a fresh session must respawn in the same cwd');
  assert.equal(row.channel, 'telegram');
  assert.equal(row.turn_count, 1);
  assert.equal(row.outbound_target, '12345');
});

test('clearEngineId on an unknown key is a no-op, not a throw', () => {
  assert.equal(sessions.clearEngineId('nope:does-not-exist'), false);
});
