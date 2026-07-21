'use strict';
/**
 * asmltr — shared event-stream contract.
 *
 * This is the ONE interface between asmltr-core (producer) and asmltr-insights
 * collector (consumer). Both tracks import this module so the wire format can
 * never drift between them. The bots and the Claude Code hook also emit this
 * shape (see insights/collector + the host session-emit hook).
 *
 * Wire shape (one JSON object per event):
 *   { v, ts, surface, session_id, identity, event_type,
 *     tokens_in, tokens_out, cost_usd, payload, source }
 */

const SCHEMA_VERSION = 1;

/** Where the event originated (the user-facing surface / producer class). */
const SURFACES = Object.freeze([
  'discord',
  'telegram',
  'email',       // SMTP/IMAP mailbox (the assistant's own address)
  'voice',       // voice-channel sessions (e.g. Discord voice / meetings)
  'assistant-web',       // browser dashboard acting as a connector
  'assistant-native',    // native/mobile assistant app
  'eve-assistant-web',   // legacy ids (pre-0.8 emitters) — kept valid for historical events
  'eve-assistant-native',
  'mcp',
  'github',
  'openai',      // OpenAI-compatible REST API (external clients / OpenRouter-style)
  'claude-code', // interactive sessions tracked via hooks
  'system',      // the metrics sampler
  'core',        // asmltr-core itself (lifecycle / internal)
]);

/** The kind of thing that happened. */
const EVENT_TYPES = Object.freeze([
  'inbound',             // a message/event arrived from a channel
  'outbound',            // an action was rendered back to a channel
  'thinking',            // a reasoning/thinking step before the answer
  'tool',                // a tool was invoked (with its input)
  'tool_result',         // a tool returned a result (its output)
  'token-usage',         // token accounting for a turn (from SDK result event)
  'identity_resolved',   // resolver mapped sender -> trust/permissions
  'moderation_decision', // moderation allowed/blocked (risk score)
  'session-start',       // a session began
  'session-end',         // a session ended
  'system-sample',       // a CPU/RAM/disk/load sample
  'notification',        // an outbound notification was sent (notify-admin, etc.)
  'control',             // a privileged control action (kill/stop/resume/claim/release)
]);

const SURFACE_SET = new Set(SURFACES);
const EVENT_TYPE_SET = new Set(EVENT_TYPES);

/**
 * Build a normalized event. Fills defaults, validates enums, and clamps the
 * payload so a producer can never accidentally ship a malformed event.
 *
 * @param {object} e
 * @param {string} e.surface       one of SURFACES
 * @param {string} e.event_type    one of EVENT_TYPES
 * @param {string} [e.session_id]  conversation/session id (nullable for system)
 * @param {string} [e.identity]    resolved user/channel key
 * @param {number} [e.ts]          unix ms (defaults to now)
 * @param {number} [e.tokens_in]
 * @param {number} [e.tokens_out]
 * @param {number} [e.cost_usd]    0 for Max-subscription surfaces; >0 only where an API key backs it
 * @param {object} [e.payload]     free-form, JSON-serializable
 * @param {string} [e.source]      which concrete producer posted it (audit)
 * @returns {object} a frozen, validated event ready to POST / append
 */
function buildEvent(e) {
  if (!e || typeof e !== 'object') throw new TypeError('event must be an object');
  if (!SURFACE_SET.has(e.surface)) {
    throw new RangeError(`unknown surface: ${e.surface} (expected one of ${SURFACES.join(', ')})`);
  }
  if (!EVENT_TYPE_SET.has(e.event_type)) {
    throw new RangeError(`unknown event_type: ${e.event_type} (expected one of ${EVENT_TYPES.join(', ')})`);
  }
  return Object.freeze({
    v: SCHEMA_VERSION,
    ts: Number.isFinite(e.ts) ? e.ts : nowMs(),
    surface: e.surface,
    session_id: e.session_id != null ? String(e.session_id) : null,
    identity: e.identity != null ? String(e.identity) : null,
    event_type: e.event_type,
    tokens_in: toInt(e.tokens_in),
    tokens_out: toInt(e.tokens_out),
    cost_usd: Number.isFinite(e.cost_usd) ? e.cost_usd : 0,
    payload: e.payload && typeof e.payload === 'object' ? e.payload : {},
    source: e.source != null ? String(e.source) : null,
  });
}

/** Lightweight validation used by the collector ingest endpoint. Returns {ok, error}. */
function validateEvent(e) {
  try {
    buildEvent(e);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function toInt(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
}

// NOTE: Date.now is used at RUNTIME by the long-lived services (allowed); it is
// only the workflow/script sandbox that forbids it. Producers may pass an
// explicit ts to override.
function nowMs() {
  return Date.now();
}

module.exports = {
  SCHEMA_VERSION,
  SURFACES,
  EVENT_TYPES,
  buildEvent,
  validateEvent,
};
