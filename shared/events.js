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
  'schedule',    // scheduled prompt jobs (the scheduler runs a managed turn per cron)
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
 * CHANNEL (connector type) → SURFACE (telemetry bucket).
 *
 * These are two DIFFERENT things and conflating them is what made the phone invisible for weeks.
 * A `channel` is the connector's routing identity: it names the thing you address in
 * `asmltr send <channel> <target>`, it selects channel-specific prompt behaviour, and it is passed
 * to moderation as the platform. A `surface` is the user-facing CLASS a turn happened on — the
 * bucket the Usage/Insights views roll up by. Most connectors are their own surface, so the two
 * names coincide and no entry is needed here; entries exist only where they legitimately differ.
 *
 * Why it matters: `connectors/sdk` defaults every connector's emit surface to its TYPE, so a
 * connector whose type isn't a valid surface had every event silently rejected by buildEvent().
 * Mapping here (rather than renaming the channel) keeps `asmltr send android <device> --file …`
 * and the android-specific voice prompt working — those genuinely need the channel name.
 *
 * Fine-grained attribution is NOT lost by mapping: the concrete producer is already recorded
 * separately in `source` (`connector:<instanceId>`), so a Pi kiosk stays distinguishable from a
 * phone even though both roll up as `assistant-native`.
 */
const CHANNEL_SURFACE = Object.freeze({
  android: 'assistant-native',        // the native mobile app IS the native assistant (its own
                                      // in-connector emits already hardcoded this; unify with them)
  device: 'assistant-native',         // generic device gateway — same class (the android base)
  'remote-desktop': 'core',           // "conversation-less: infra signaling, not a chat channel"
  notify: 'core',                     // the notify ladder (/v2/notify) — core-internal outbound, and
                                      // synthetic (session_id/identity are both literally 'notify').
                                      // Promote to its own surface if it ever needs its own rollup.
});

/**
 * Resolve a producer's channel/type to its canonical telemetry surface.
 * Identity for anything already a valid surface (and for unknowns, which buildEvent then rejects).
 */
function surfaceFor(channel) {
  return CHANNEL_SURFACE[channel] || channel;
}

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
  // Normalize channel→surface FIRST: every producer (core's record(), connectors' ctx.emit, the
  // collector's ingest + tailer) funnels through here, so this one line is the whole fix.
  const surface = surfaceFor(e.surface);
  if (!SURFACE_SET.has(surface)) {
    throw new RangeError(`unknown surface: ${e.surface} (expected one of ${SURFACES.join(', ')})`);
  }
  if (!EVENT_TYPE_SET.has(e.event_type)) {
    throw new RangeError(`unknown event_type: ${e.event_type} (expected one of ${EVENT_TYPES.join(', ')})`);
  }
  return Object.freeze({
    v: SCHEMA_VERSION,
    ts: Number.isFinite(e.ts) ? e.ts : nowMs(),
    surface,
    session_id: e.session_id != null ? String(e.session_id) : null,
    identity: e.identity != null ? String(e.identity) : null,
    event_type: e.event_type,
    tokens_in: toInt(e.tokens_in),
    tokens_out: toInt(e.tokens_out),
    cost_usd: Number.isFinite(e.cost_usd) ? e.cost_usd : 0,          // equivalent value at API rates (all surfaces)
    billed_cost_usd: Number.isFinite(e.billed_cost_usd) ? e.billed_cost_usd : 0, // portion actually billed (API-key surfaces only)
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
  CHANNEL_SURFACE,
  surfaceFor,
  buildEvent,
  validateEvent,
};
