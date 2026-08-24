'use strict';
/**
 * asmltr-core — the normalized inbound/outbound envelope (plan §A1).
 *
 * Adapters translate their native I/O into an InboundEnvelope and render
 * OutboundActions. The core never sees channel-specific formatting.
 */

/** Channel capability descriptor — drives how an adapter renders outbound actions. */
function capabilities(overrides = {}) {
  return Object.assign(
    {
      max_message_chars: 4000,
      supports_markdown: true,
      supports_code_blocks: true,
      supports_attachments_out: false,
      supports_streaming: false,
      supports_typing_indicator: false,
    },
    overrides
  );
}

/**
 * Build/validate an inbound envelope. Throws on missing required fields so a
 * broken adapter fails loudly rather than feeding the core garbage.
 *
 * Required: channel, conversation_key, sender.raw_id, content.text
 */
function inbound(e) {
  if (!e || typeof e !== 'object') throw new TypeError('envelope must be an object');
  if (!e.channel) throw new Error('envelope.channel required');
  if (!e.conversation_key) throw new Error('envelope.conversation_key required');
  if (!e.sender || e.sender.raw_id == null) throw new Error('envelope.sender.raw_id required');
  if (!e.content || typeof e.content.text !== 'string') {
    throw new Error('envelope.content.text required (string)');
  }
  return {
    channel: String(e.channel),
    conversation_key: String(e.conversation_key),
    message_id: e.message_id != null ? String(e.message_id) : null,
    received_at: e.received_at || new Date().toISOString(),
    sender: {
      raw_id: String(e.sender.raw_id),
      raw_username: e.sender.raw_username != null ? String(e.sender.raw_username) : null,
      api_key: e.sender.api_key || null,
    },
    resolved: null, // filled by the resolver (§A4)
    content: {
      text: e.content.text,
      attachments: Array.isArray(e.content.attachments) ? e.content.attachments : [],
      media_files: Array.isArray(e.content.media_files) ? e.content.media_files : [],
    },
    capabilities: capabilities(e.capabilities || {}),
    delivery: e.delivery === 'async' ? 'async' : 'sync',
    channel_context: e.channel_context || {}, // opaque, round-tripped to render()
    // Structured trust-scoping context (read by the trust framework): scope_id
    // e.g. "guild:<id>" lets grants be scoped per-server; scope_name is for display.
    context: e.context && typeof e.context === 'object'
      ? { scope_id: e.context.scope_id != null ? String(e.context.scope_id) : null, scope_name: e.context.scope_name != null ? String(e.context.scope_name) : null }
      : { scope_id: null, scope_name: null },
    // Optional connector-supplied system-prompt addendum (channel-specific context
    // the core appends to buildSystemPrompt — e.g. Discord's server-aware authz +
    // conversation context). NOT moderated; content.text remains the user message.
    system_prompt_extra: e.system_prompt_extra != null ? String(e.system_prompt_extra) : null,
    // Optional connector-supplied spawn/resume cwd (e.g. GitHub points a session at a
    // local clone of the repo so the model reasons about the actual code). Sets the
    // session's working_dir on first turn; ignored once the session exists.
    working_dir: e.working_dir != null ? String(e.working_dir) : null,
    // Surface visibility: true if outbound text is seen by anyone beyond a full-trust
    // recipient (github comment, discord guild channel). Drives the core redaction layer.
    public: !!e.public,
    // Observe-only: ingest this message into the session's awareness WITHOUT running a turn or
    // replying. The core records it and buffers it as context for the next real turn — so a
    // multi-agent channel stays current on messages addressed to OTHER agents (or ambient chatter)
    // while only ever replying when actually addressed. content.text still carries the message.
    observe_only: !!e.observe_only,
    // Optional connector-supplied approval policy → the core's draft/approval gate. Held
    // replies are diverted to the draft store instead of returned. { policy, recipient, subject, attachments }.
    approval: e.approval && typeof e.approval === 'object'
      ? { policy: String(e.approval.policy || 'always_send'), recipient: e.approval.recipient || null, subject: e.approval.subject || null, attachments: Array.isArray(e.approval.attachments) ? e.approval.attachments : [] }
      : null,
  };
}

// --- Outbound action constructors (semantic; adapters render them) -----------
const reply = (text, opts = {}) => ({ type: 'reply', text: String(text), ...opts });
const react = (emoji) => ({ type: 'react', emoji: String(emoji) });
const notify = (text, severity = 'info', target = 'admin') => ({ type: 'notify', text: String(text), severity, target });
const status = (text) => ({ type: 'status', text: String(text) });
const toolEffect = (summary, detail) => ({ type: 'tool_effect', summary: String(summary), detail });
const suppress = () => ({ type: 'suppress' });

module.exports = { capabilities, inbound, reply, react, notify, status, toolEffect, suppress };
