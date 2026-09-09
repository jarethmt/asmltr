'use strict';
/**
 * Channel / medium self-awareness — the block that tells the model which CONNECTOR
 * the user is on, as distinct from the engine harness underneath.
 *
 * Runtime name is the configured engine, not a hardcoded "Claude Code". Claude
 * installs still get "Claude Code" (id `claude`). Grok / Gemini / Codex get their
 * own harness names so a Grok box does not claim it is Claude Code, and a PR of
 * this file back onto a Claude Code install does not rename that harness.
 */
const identity = require('../../shared/identity');
const engines = require('../../shared/engines');

const CHANNEL_LABELS = {
  discord: 'Discord', telegram: 'Telegram', github: 'GitHub (issue thread)',
  mcp: 'an MCP client', core: 'a direct API call', cli: 'the local asmltr CLI',
  'assistant-web': 'a web assistant app', 'assistant-native': 'a mobile assistant app',
  'eve-assistant-web': 'a web assistant app', 'eve-assistant-native': 'a mobile assistant app', // legacy ids
};

const RUNTIME_NAMES = {
  claude: 'Claude Code',
  grok: 'Grok',
  gemini: 'Gemini CLI',
  codex: 'Codex',
};

/** Harness name as the user-facing "underlying runtime". Unknown → Claude Code (asmltr default). */
function runtimeName(engineId) {
  const id = String(engineId || '').trim().toLowerCase();
  if (RUNTIME_NAMES[id]) return RUNTIME_NAMES[id];
  if (engines.known(id) && engines.ENGINES[id] && engines.ENGINES[id].label) return engines.ENGINES[id].label;
  return 'Claude Code';
}

function buildChannelAwareness(e, resolved, opts) {
  e = e || {};
  opts = opts || {};
  const NAME = identity.name(); // live (GUI-editable)
  const who = (resolved && resolved.display_name) || (e.sender && e.sender.raw_username) || 'a user';
  const scope = e.context && e.context.scope_name ? ` in "${e.context.scope_name}"` : '';
  const label = CHANNEL_LABELS[e.channel] || e.channel;
  const runtime = runtimeName(opts.engineId);
  // The android assistant is voice-first — replies are read aloud (TTS). Nudge toward speakable prose so
  // markdown/symbols don't get vocalized. (Markdown is also stripped at the TTS layer as a safety net.)
  const spoken = e.channel === 'android'
    ? `\n\nSPOKEN OUTPUT: your replies here are READ ALOUD. Write the way you'd say it — natural, conversational sentences. Do NOT use markdown or decorative characters: no asterisks/bold/italics, headers, backticks or code fences, bullet or numbered lists, tables, or emoji. Say symbols as words ("and" not "&", "percent" not "%"). Prefer a short spoken list ("first… second…") over bullets. Keep it concise; the person is listening, not reading.`
    : '';
  const emailOut = e.channel === 'email'
    ? `\n\nEMAIL OUTPUT: replies here are converted from markdown to HTML at send. Write standard markdown. Do not write HTML tags. Do not use Discord -# or thought chips.`
    : '';
  return `MEDIUM AWARENESS — READ FIRST:
This message reached you through the asmltr "${e.channel}" connector. You are talking with ${who} over ${label}${scope}; from their side they are messaging ${NAME} on ${label}, NOT sitting in a terminal with you.
Your underlying runtime is ${runtime}, but that is an internal implementation detail and is NOT the medium of this conversation. If asked what app/medium/channel/platform you're on, the truthful answer is ${label} (via the asmltr ${e.channel} connector) — do NOT say "${runtime}", "the terminal", "SSH", or describe session-start hooks / git status / system reminders as if the user sent them. Those are your backstage context, not this conversation.${spoken}${emailOut}`;
}

module.exports = { CHANNEL_LABELS, RUNTIME_NAMES, runtimeName, buildChannelAwareness };
