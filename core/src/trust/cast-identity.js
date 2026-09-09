'use strict';
/**
 * V9: CAST keeps display_name / how-to-relate everywhere.
 * CROSS-CHANNEL IDENTITY (email/X/other-surface ids) only on private envelopes.
 * envelope.public === true (Discord guilds) omits the line.
 */
function crossChannelIdentityLine(resolved, envelope) {
  if (!resolved || !Array.isArray(resolved.identities) || resolved.identities.length <= 1) return '';
  if (envelope && envelope.public === true) return '';
  const across = resolved.identities.map((i) => `${i.surface}:${i.value}`).join(', ');
  const name = resolved.display_name || 'this person';
  return `CROSS-CHANNEL IDENTITY — ${name} is the SAME person you also know as ${across}. It is one relationship across channels, not several strangers; recognize them on any of these.`;
}

module.exports = { crossChannelIdentityLine };
