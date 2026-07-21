'use strict';
/**
 * asmltr-insights — JSONL tailer (plan §B4, day-one fallback).
 *
 * Optionally ingests an external proxy's query/moderation JSONL logs (paths via
 * ASMLTR_QUERY_LOG_DIR / ASMLTR_MOD_LOG_DIR_SRC; disabled when unset) so a dashboard
 * can show history before the core/connectors emit directly to /ingest.
 *
 * By default it seeks to end-of-file on first sight (only new activity) to avoid
 * backfilling history and double-counting; set ASMLTR_TAILER_BACKFILL=1 to read
 * from the start.
 */

const fs = require('fs');
const path = require('path');
const { buildEvent } = require('../../shared/events');

// Optional integration: tail an external proxy's query/moderation JSONL logs.
// Unset (or ASMLTR_ENABLE_TAILER!=1) → the tailer stays idle.
const QUERY_DIR = process.env.ASMLTR_QUERY_LOG_DIR || '';
const MOD_DIR = process.env.ASMLTR_MOD_LOG_DIR_SRC || '';
const BACKFILL = process.env.ASMLTR_TAILER_BACKFILL === '1';

const offsets = new Map(); // path -> byte offset already consumed

function today() { return new Date().toISOString().slice(0, 10); }
function queryLogPath() { return path.join(QUERY_DIR, `queries-${today()}.jsonl`); }
function modLogPath() { return path.join(MOD_DIR, `moderation-${today()}.jsonl`); }

function readNewLines(file) {
  let size;
  try { size = fs.statSync(file).size; } catch (_) { return []; }
  if (!offsets.has(file)) { offsets.set(file, BACKFILL ? 0 : size); }
  const from = offsets.get(file);
  if (size <= from) { offsets.set(file, size); return []; }
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  offsets.set(file, size);
  return buf.toString('utf8').split('\n').filter((l) => l.trim());
}

function ingestLine(db, line, kind) {
  let e;
  try { e = JSON.parse(line); } catch (_) { return 0; }
  const ts = e.timestamp ? Date.parse(e.timestamp) : Date.now();
  const session_id = e.sessionId || null;
  const identity = e.username || e.user || e.userId || null;
  const surface = e.platform || 'core';

  if (kind === 'query') {
    db.ingestEvent(buildEvent({ ts, surface, session_id, identity, event_type: 'inbound',
      source: 'tailer', payload: { text: String(e.message || '').slice(0, 500) } }));
    db.ingestEvent(buildEvent({ ts: ts + 1, surface, session_id, identity, event_type: 'outbound',
      source: 'tailer', payload: { chars: String(e.response || '').length, duration_ms: e.duration || null } }));
    return 2;
  }
  // moderation
  db.ingestEvent(buildEvent({ ts, surface, session_id, identity: e.userName || identity, event_type: 'moderation_decision',
    source: 'tailer', payload: { decision: e.decision, riskLevel: e.riskLevel, monitored: e.monitored } }));
  return 1;
}

function start(db, intervalMs, onIngest) {
  const tick = () => {
    let count = 0;
    try {
      for (const line of readNewLines(queryLogPath())) count += ingestLine(db, line, 'query');
      for (const line of readNewLines(modLogPath())) count += ingestLine(db, line, 'mod');
    } catch (err) { console.error('[tailer] tick failed:', err.message); }
    if (count && onIngest) onIngest(count);
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

module.exports = { start };
