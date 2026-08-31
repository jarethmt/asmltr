'use strict';
/**
 * V36: GitHub is a public surface. Issue comments are the final answer only —
 * never thinking, tool names, or tool I/O (same rule as email).
 */
const { redactSecrets } = require('../../../shared/redact');
const { quietReplyFromResult } = require('../../../shared/step-public');

function workingPlaceholder(name) {
  return `🧠 **${name || 'Assistant'} is on it…**`;
}

const GH_MAX = 64000; // under GitHub's 65535-char comment limit

function finalIssueComment(actions) {
  const reply = (actions || []).find((a) => a && a.type === 'reply') || {};
  const raw = quietReplyFromResult(reply) || '_(no response generated)_';
  let { text } = redactSecrets(raw);
  text = String(text || '').trim() || '_(no response generated)_';
  if (text.length > GH_MAX) text = text.slice(0, GH_MAX - 20) + '\n…(truncated)';
  return text;
}

/** Always one body. Never continuation comments packing a tool trace. */
function issueCommentBodies(actions) {
  return [finalIssueComment(actions)];
}

function looksLikeEngineTrace(body) {
  const s = String(body || '');
  return /🧠 Thinking/.test(s)
    || /🔍 Trace/.test(s)
    || /🔧 \*\*/.test(s)
    || /<summary>📥 output<\/summary>/.test(s);
}

module.exports = {
  workingPlaceholder, finalIssueComment, issueCommentBodies, looksLikeEngineTrace,
};
