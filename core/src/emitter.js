'use strict';
/**
 * asmltr-core — telemetry emitter (plan §A5).
 *
 * Emits the shared event contract (shared/events.js) to two sinks:
 *   (a) durable append-only JSONL at data/events-YYYY-MM-DD.jsonl
 *   (b) fire-and-forget POST to the insights collector /ingest
 * A down/slow collector must never stall a turn — (b) is best-effort with a
 * short timeout and swallowed errors.
 */

const fs = require('fs');
const path = require('path');
const { buildEvent } = require('../../shared/events');

const DATA_DIR = process.env.ASMLTR_CORE_DATA || path.join(__dirname, '..', 'data');
const COLLECTOR_URL = process.env.ASMLTR_COLLECTOR_URL || 'http://127.0.0.1:3017/ingest';
const COLLECTOR_TOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';

fs.mkdirSync(DATA_DIR, { recursive: true });

function logFileFor(ts) {
  const d = new Date(ts);
  const day = d.toISOString().slice(0, 10);
  return path.join(DATA_DIR, `events-${day}.jsonl`);
}

/**
 * Emit one event. Builds + validates via the shared contract, appends to JSONL,
 * and best-effort POSTs to the collector. Returns the built event (frozen).
 */
function emit(partial) {
  let evt;
  try {
    evt = buildEvent(partial);
  } catch (err) {
    // A malformed event is a producer bug — log locally, don't throw into a turn.
    console.error('[emitter] dropping malformed event:', err.message);
    // ...but NEVER drop it silently into a logfile nobody reads. A rejected event used to vanish
    // entirely, which is how the android surface reported 0 tokens for weeks while burning ~456M:
    // the only trace was a console line buried in PM2 logs. Re-emit a degraded marker on the
    // always-valid `core` surface so the hole is visible IN THE DASHBOARD, where someone looks.
    emitDropMarker(partial, err);
    return null;
  }

  // (a) durable JSONL (best-effort; never throw)
  try {
    fs.appendFileSync(logFileFor(evt.ts), JSON.stringify(evt) + '\n');
  } catch (err) {
    console.error('[emitter] JSONL append failed:', err.message);
  }

  // (b) fire-and-forget to collector
  postToCollector(evt);

  return evt;
}

// Report a rejected event as a `control` event on the `core` surface. Guarded against recursion:
// this builds a known-good event, but if it somehow still fails we give up rather than loop.
let _inDropMarker = false;
function emitDropMarker(partial, err) {
  if (_inDropMarker) return;
  _inDropMarker = true;
  try {
    const evt = buildEvent({
      surface: 'core',
      event_type: 'control',
      session_id: partial && partial.session_id != null ? partial.session_id : null,
      source: 'emitter',
      payload: {
        action: 'event-dropped',
        reason: err && err.message ? String(err.message).slice(0, 300) : 'unknown',
        rejected_surface: partial && partial.surface != null ? String(partial.surface) : null,
        rejected_event_type: partial && partial.event_type != null ? String(partial.event_type) : null,
      },
    });
    try { fs.appendFileSync(logFileFor(evt.ts), JSON.stringify(evt) + '\n'); } catch (_) {}
    postToCollector(evt);
  } catch (_) {
    // give up — a drop marker must never itself break a turn
  } finally {
    _inDropMarker = false;
  }
}

function postToCollector(evt) {
  // Native fetch (Node 18+ undici) — note feedback_cloudflare_node_fetch: avoid
  // npm node-fetch on edison; here it's a localhost call so it's moot, but native
  // fetch is the standard regardless.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  const headers = { 'Content-Type': 'application/json' };
  if (COLLECTOR_TOKEN) headers['Authorization'] = `Bearer ${COLLECTOR_TOKEN}`;
  fetch(COLLECTOR_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(evt),
    signal: ctrl.signal,
  })
    .catch(() => {}) // collector down → silently rely on JSONL + tailer
    .finally(() => clearTimeout(t));
}

module.exports = { emit, COLLECTOR_URL };
