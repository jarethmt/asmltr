#!/usr/bin/env node
'use strict';
/**
 * asmltr — session exit guard. `node session-ended.js <session_id> [exit_code]`
 *
 * Why this exists: a launched session is registered 'active' at spawn, and the only thing that used
 * to retire it was Claude Code's SessionEnd hook — which fires on a CLEAN exit. A crash, a SIGKILL,
 * an OOM kill or a host reboot left the row claiming to be active forever (measured 2026-11-17:
 * 156 rows said active, 4 were real).
 *
 * So the launcher wires this into the pane's own shell guard: whatever the engine exits with, the
 * NEXT thing that runs in that pane is this script, which retires the session from inside the pane
 * it belongs to. It is best-effort and must never fail the pane — every path swallows errors.
 *
 * Belt and braces, deliberately:
 *   1. the local tracker file (what the launcher and `asmltr ls` read), and
 *   2. a session-end event to the collector (what the dashboard reads).
 * Either can be unavailable without blocking the other.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
try { require('../../shared/loadenv'); } catch (_) {}

const sid = process.argv[2];
const exitCode = process.argv[3] || '0';
if (!sid) process.exit(0);

const TRACKER = process.env.ASMLTR_CLI_TRACKER_PATH || path.join(os.homedir(), '.asmltr', 'cli-sessions.json');

// 1) tracker: mark ended. Read-modify-write; a concurrent launcher write is the usual loser case,
// and losing this update is survivable because reconcile-on-read will retire the row anyway.
try {
  const t = JSON.parse(fs.readFileSync(TRACKER, 'utf8'));
  const s = (t.sessions || []).find((x) => x.session_id === sid);
  if (s && s.status !== 'ended') {
    s.status = 'ended';
    s.last_activity_unix = Math.floor(Date.now() / 1000);
    s.exit_code = Number(exitCode) || 0;
    fs.writeFileSync(TRACKER, JSON.stringify(t));
  }
} catch (_) { /* no tracker / unparseable → the collector path below still runs */ }

// 2) collector: emit the terminal event.
try {
  const port = process.env.ASMLTR_INSIGHTS_PORT || '3017';
  const url = process.env.ASMLTR_INSIGHTS_URL || `http://127.0.0.1:${port}/ingest`;
  const token = process.env.ASMLTR_INSIGHTS_TOKEN || '';
  const body = JSON.stringify({
    surface: 'claude-code', session_id: sid, identity: process.env.ASMLTR_TRACKER_IDENTITY || process.env.USER || 'root',
    event_type: 'session-end', source: 'asmltr-exit-guard', payload: { exit_code: Number(exitCode) || 0 },
  });
  const req = require(url.startsWith('https:') ? 'https' : 'http').request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    timeout: 3000,
  });
  req.on('error', () => {});     // collector down → tracker write above still stands
  req.on('timeout', () => req.destroy());
  req.end(body);
} catch (_) { /* best effort */ }
