'use strict';
/**
 * V8: recording the global timeline is fine. Feeding other-guild / DM /
 * other-channel hits into a room prompt is not.
 */
function crossContextForPrompt() {
  return [];
}

function crossContextBlock(items) {
  if (!items || !items.length) return '';
  return `\n\nCROSS-CONTEXT (other servers/channels, reference only):\n${items.map((m) => `- [${m.serverName}/#${m.channelName}] ${m.author}: ${String(m.content).substring(0, 100)}...`).join('\n')}`;
}

module.exports = { crossContextForPrompt, crossContextBlock };
